"""Main worker process that polls the database for active accounts/reservations
and manages check-in scheduling."""

import json
import logging
import os
import sys
import signal
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

# Add worker directory to path so lib imports work
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import (
    get_connection,
    get_active_accounts,
    get_active_reservations,
    get_pending_flights,
    upsert_flight,
    upsert_reservation,
    deactivate_stale_reservations,
    update_flight_status,
    update_flight_reservation_info,
    add_log,
    add_fare_check,
    get_last_fare_check,
    get_flights_for_fare_check,
    get_flights_for_seat_upgrade,
    get_seat_preferences,
    update_flight_seat,
    log_diagnostic,
    get_notification_configs,
    cleanup_old_data,
    backup_database,
    get_stale_capture_dirs,
    recover_stuck_checkins,
)
from lib.config import CAPTURES_DIR, phone_app_enabled
from lib.app_settings import apply_to_environ as apply_app_settings
from lib.credentials import CredentialKeyError, encrypt_stored_passwords
from lib.log import get_logger
from lib.utils import (
    CheckFaresOption,
    DriverTimeoutError,
    FlightChangeError,
    LoginError,
    RequestError,
    get_current_time,
)
from lib import llm_browser
from lib.browser_session import BrowserSession
from lib.checkin_handler import CheckInHandler

logger = get_logger(__name__)

VIEW_RESERVATION_URL = "mobile-air-booking/v1/mobile-air-booking/page/view-reservation/"
POLL_INTERVAL = 60  # seconds
RETRIEVAL_INTERVAL_DEFAULT = 24 * 3600  # 24 hours in seconds
CLEANUP_INTERVAL = 24 * 3600  # Run data cleanup once per day

# Shared state
browser_session: BrowserSession | None = None
active_handlers: dict[str, CheckInHandler] = {}
last_account_check: dict[str, float] = {}
last_reservation_check: dict[str, float] = {}
last_cleanup_time: float = 0
shutdown_event = threading.Event()


def get_db():
    """Create a new DB connection (for use in threads)."""
    return get_connection()


def normalize_flight_number(number: str) -> str:
    """Normalize a flight number for comparison across Southwest's formats.

    The DB stores the first leg's raw number (e.g. "WN1234" or "1234") while
    the change/shopping pages use the multi-leg format with 'WN' stripped and
    legs joined by a slash wrapped in zero-width spaces (e.g. "123​/​456").
    Comparing raw values silently never matches for connecting flights.
    """
    number = (number or "").replace("\u200b", "").replace("WN", "").lstrip("# ")
    return number.split("/")[0].strip()


def process_reservation(
    conn: sqlite3.Connection,
    reservation: dict,
) -> list[dict]:
    """Retrieve flights for a reservation from Southwest and sync to database.

    Uses southwest.com unless the phone-app service is turned on.
    """
    if not phone_app_enabled():
        return _reservation_from_website(conn, reservation)
    confirmation_number = reservation["confirmation_number"]
    first_name = reservation["first_name"]
    last_name = reservation["last_name"]
    reservation_id = reservation["id"]

    info = {
        "firstName": first_name,
        "lastName": last_name,
        "recordLocator": confirmation_number,
    }
    site = VIEW_RESERVATION_URL + confirmation_number

    try:
        response = browser_session.make_request("POST", site, {}, info, max_attempts=3)
    except RequestError as err:
        err_str = str(err)
        logger.error("Failed to retrieve reservation %s: %s", confirmation_number, err_str)
        resp_body = getattr(err, "response_body", "") or ""
        header_keys = list(browser_session.headers.keys()) if browser_session else []
        log_diagnostic(
            conn,
            category="auth_failure" if "403" in err_str or "Forbidden" in err_str else "api_error",
            endpoint=f"POST {VIEW_RESERVATION_URL}{confirmation_number}",
            expected_behavior="200 OK with viewReservationViewPage",
            actual_behavior=f"{err_str} | Headers: {header_keys}",
            headers_snapshot=json.dumps(header_keys),
            response_snapshot=resp_body[:500],
        )
        add_log(conn, f"Failed to retrieve reservation {confirmation_number}: {err}", "error")
        process_reservation.last_error = err_str
        return []
    except Exception as err:
        # Anything else (browser down, no session) is a failed lookup too
        process_reservation.last_error = str(err).splitlines()[0][:200] if str(err) else type(err).__name__
        add_log(conn, f"Failed to retrieve reservation {confirmation_number}: {process_reservation.last_error}", "error")
        return []
    process_reservation.last_error = ""

    reservation_info = response.get("viewReservationViewPage", {})
    bounds = reservation_info.get("bounds", [])
    flights_data = []

    from lib.flight import Flight

    for bound in bounds:
        flight_number = bound.get("flights", [{}])[0].get("number", "") if bound.get("flights") else ""
        departure_date = bound.get("departureDate", "")
        departure_time_str = bound.get("departureTime", "")
        is_international = bound.get("isInternational", False)

        if departure_date and departure_time_str:
            flight_obj = None
            flight_obj_err = None
            try:
                flight_obj = Flight(bound, reservation_info, confirmation_number)
            except Exception as err:
                flight_obj_err = err

            # Extract airports - try multiple approaches
            dep_raw = bound.get("departureAirport", {})
            arr_raw = bound.get("arrivalAirport", {})

            # Primary: get "code" field (3-letter airport code)
            departure_airport = dep_raw.get("code", "")
            destination_airport = arr_raw.get("code", "")

            # Fallback: get "name" field only if it looks like a code (3-4 chars)
            if not departure_airport:
                name = dep_raw.get("name", "")
                departure_airport = name if len(name) <= 4 else ""
            if not destination_airport:
                name = arr_raw.get("name", "")
                destination_airport = name if len(name) <= 4 else ""

            # Last resort: try Flight class (which uses "name" fields)
            if flight_obj and (not departure_airport or not destination_airport):
                if not departure_airport:
                    val = flight_obj.departure_airport
                    departure_airport = val if len(val) <= 4 else ""
                if not destination_airport:
                    val = flight_obj.destination_airport
                    destination_airport = val if len(val) <= 4 else ""

            # Log what we extracted for diagnostic purposes
            add_log(
                conn,
                f"Flight {flight_number} airports: {departure_airport} -> {destination_airport} "
                f"(raw dep={json.dumps(dep_raw)}, raw arr={json.dumps(arr_raw)})",
                "info",
            )

            # Convert departure time to UTC. Southwest reports airport-local
            # times; scheduling a check-in requires the real UTC offset. If the
            # timezone can't be resolved, storing local time as UTC would fire
            # the check-in hours early and burn the one chance to check in — so
            # skip the flight and surface the error instead.
            if flight_obj is None:
                msg = (
                    f"Skipping flight {flight_number} ({departure_airport} -> "
                    f"{destination_airport}): could not determine departure timezone: {flight_obj_err}"
                )
                logger.error(msg)
                add_log(conn, msg, "error")
                log_diagnostic(
                    conn,
                    category="flight_parse_failure",
                    endpoint=f"reservation {confirmation_number}",
                    expected_behavior="Flight() resolves airport timezone",
                    actual_behavior=str(flight_obj_err),
                    response_snapshot=json.dumps(bound)[:500],
                )
                continue
            departure_utc = flight_obj.departure_time.isoformat()

            flight_id = upsert_flight(
                conn,
                reservation_id,
                flight_number,
                departure_airport,
                destination_airport,
                departure_utc,
                is_international,
            )
            # Store reservation_info for fare checking
            try:
                info_json = json.dumps(reservation_info)
                update_flight_reservation_info(conn, flight_id, info_json)
            except Exception as e:
                logger.error("Failed to store reservation_info for %s: %s", flight_id, e)
                add_log(conn, f"Failed to store reservation info for fare checking: {e}", "warning")
            flights_data.append(
                {
                    "id": flight_id,
                    "confirmation_number": confirmation_number,
                    "first_name": first_name,
                    "last_name": last_name,
                    "departure_time": departure_utc,
                    "departure_airport": departure_airport,
                    "destination_airport": destination_airport,
                    "flight_number": flight_number,
                }
            )

    add_log(
        conn,
        f"Retrieved {len(flights_data)} flights for reservation {confirmation_number}",
        "info",
    )
    return flights_data


def schedule_pending_flights(conn: sqlite3.Connection) -> None:
    """Schedule check-ins for any pending flights."""
    global headers

    pending = get_pending_flights(conn)
    for flight_row in pending:
        flight_id = flight_row["id"]

        if flight_id in active_handlers:
            continue

        departure_time_str = flight_row["departure_time"]
        try:
            departure_time = datetime.fromisoformat(departure_time_str)
            if departure_time.tzinfo is None:
                departure_time = departure_time.replace(tzinfo=timezone.utc)
        except ValueError:
            logger.error("Invalid departure time for flight %s: %s", flight_id, departure_time_str)
            continue

        # A-List members can check in 48 hours out. A stored value wins: it's
        # 24 after Southwest refused an early attempt for this flight.
        hours = flight_row.get("checkin_hours") or (48 if flight_row.get("is_alist") else 24)
        if flight_row.get("checkin_hours") != hours:
            conn.execute("UPDATE flights SET checkin_hours = ? WHERE id = ?", (hours, flight_id))
            conn.commit()
        checkin_time = departure_time - timedelta(hours=hours)
        if checkin_time < get_current_time():
            # Check-in time has passed, check if it's still within window
            if departure_time > get_current_time():
                # Flight hasn't departed, try to check in now
                pass
            else:
                update_flight_status(conn, flight_id, "failed", "Departure time has passed")
                continue

        handler = CheckInHandler(
            browser_session=browser_session,
            flight_db_id=flight_id,
            confirmation_number=flight_row["confirmation_number"],
            first_name=flight_row["first_name"],
            last_name=flight_row["last_name"],
            departure_time=departure_time,
            departure_airport=flight_row["departure_airport"],
            destination_airport=flight_row["destination_airport"],
            is_same_day=False,
            db_conn_factory=get_db,
            checkin_hours=hours,
        )
        # Register before scheduling so a failure can't leave a running thread
        # unregistered (which would spawn a duplicate handler on the next poll).
        active_handlers[flight_id] = handler
        try:
            handler.schedule_check_in()
        except Exception as e:
            active_handlers.pop(flight_id, None)
            logger.error("Failed to schedule check-in for flight %s: %s", flight_id, e)
            continue

        logger.info(
            "Scheduled check-in for flight %s (%s -> %s) at %s",
            flight_id,
            flight_row["departure_airport"],
            flight_row["destination_airport"],
            checkin_time.isoformat(),
        )


def process_accounts(conn: sqlite3.Connection) -> None:
    """Process all active accounts - log in via browser and retrieve reservations."""
    accounts = get_active_accounts(conn)
    for account in accounts:
        account_id = account["id"]
        retrieval_interval = account.get("retrieval_interval", 24) * 3600

        last_check = last_account_check.get(account_id, 0)
        if time.time() - last_check < retrieval_interval:
            continue

        logger.info("Processing account: %s", account["username"])
        add_log(conn, f"Processing account: {account['username']}", "info")

        try:
            from lib.credentials import decrypt

            sw_reservations, first_name, last_name = browser_session.login_and_get_reservations(
                account["username"], decrypt(account["password"])
            )
        except CredentialKeyError as e:
            # Not a wrong password: don't count it toward deactivating the account
            logger.error("Can't read the password for %s: %s", account["username"], e)
            add_log(conn, f"Can't log in to {account['username']}: {e}", "error")
            continue
        except DriverTimeoutError:
            logger.warning("Timeout logging into account %s", account["username"])
            add_log(conn, f"Timeout logging into account {account['username']}", "warning")
            continue
        except LoginError as e:
            logger.error("Login failed for account %s: %s (status: %s)", account["username"], e, e.status_code)
            add_log(conn, f"Login failed for {account['username']}: {e} (status: {e.status_code})", "error")

            # Only deactivate for confirmed invalid credentials (Southwest code 400518024)
            # All other errors (429, 500, 502, 503, 401, 403, etc.) are treated as transient
            is_bad_credentials = "Invalid credentials" in str(e)
            if is_bad_credentials:
                # Increment failure counter, deactivate after 3 consecutive failures
                failure_count = (account.get("login_failure_count") or 0) + 1
                conn.execute(
                    "UPDATE accounts SET login_failure_count = ? WHERE id = ?",
                    (failure_count, account_id),
                )
                conn.commit()
                if failure_count >= 3:
                    conn.execute("UPDATE accounts SET is_active = 0 WHERE id = ?", (account_id,))
                    conn.commit()
                    add_log(conn, f"Deactivated account {account['username']} after {failure_count} consecutive credential failures", "warning")
                else:
                    add_log(conn, f"Login failure #{failure_count} for {account['username']} (will deactivate after 3)", "warning")
            else:
                add_log(conn, f"Transient login error for {account['username']} (status {e.status_code}), will retry next cycle", "warning")
            continue
        except Exception as e:
            logger.error("Failed to process account %s: %s", account["username"], e)
            add_log(conn, f"Failed to process account {account['username']}: {e} (transient, will retry)", "error")
            continue

        # Reset failure counter on successful login
        conn.execute("UPDATE accounts SET login_failure_count = 0 WHERE id = ?", (account_id,))
        conn.commit()

        logger.info("Retrieved %d reservations for account %s", len(sw_reservations), account["username"])
        add_log(conn, f"Retrieved {len(sw_reservations)} reservations for {account['username']}", "info")

        active_conf_numbers = []
        for sw_res in sw_reservations:
            conf_number = sw_res.get("record_locator", sw_res.get("recordLocator", ""))
            if not conf_number:
                continue
            active_conf_numbers.append(conf_number)
            upsert_reservation(conn, account_id, conf_number, first_name or account["username"], last_name or "")

        deactivate_stale_reservations(conn, account_id, active_conf_numbers)

        # Fetch flight details for each reservation via browser session
        reservations = conn.execute(
            "SELECT * FROM reservations WHERE account_id = ? AND is_active = 1",
            (account_id,),
        ).fetchall()

        for res_row in reservations:
            process_reservation(conn, dict(res_row))

        last_account_check[account_id] = time.time()


LOOKUP_RETRY_MINUTES = (15, 30, 60, 120)  # after 1, 2, 3, 4+ failures in a row


def _local_to_utc(local: str, airport: str) -> str | None:
    """'2026-11-20T08:00' at 'PHX' -> UTC ISO string, or None for an unknown airport."""
    import zoneinfo
    from pathlib import Path

    try:
        zones = json.loads((Path(__file__).parent / "utils" / "airport_timezones.json").read_text())
        tz = zoneinfo.ZoneInfo(zones[airport.upper()])
        return datetime.fromisoformat(local).replace(tzinfo=tz).astimezone(timezone.utc).isoformat()
    except Exception:
        return None


def _set_lookup(conn: sqlite3.Connection, res_id: str, status: str, message: str, failures: int, retry_minutes: float) -> None:
    now = datetime.utcnow()
    conn.execute(
        "UPDATE reservations SET lookup_status = ?, lookup_message = ?, lookup_checked_at = ?, "
        "next_lookup_at = ?, lookup_failures = ? WHERE id = ?",
        (status, message[:1200], now.isoformat(), (now + timedelta(minutes=retry_minutes)).isoformat(), failures, res_id),
    )
    conn.commit()


def _web_lookup(conn: sqlite3.Connection, res: dict) -> tuple[int, str]:
    """Look a reservation up on southwest.com and save its flights. Returns (count, message)."""
    from lib.web_checkin import web_lookup_flights

    if not browser_session or not browser_session._driver:
        return 0, "the browser isn't running"
    with browser_session._lock:
        try:
            result = web_lookup_flights(
                browser_session._driver, res["confirmation_number"], res["first_name"], res["last_name"],
                capture_dir=os.path.join(CAPTURES_DIR, "reservations", res["id"]),
            )
        finally:
            try:
                browser_session.restore(timeout=90)
            except Exception as e:
                logger.warning("Couldn't restore the mobile site after the website lookup: %s", e)
    saved = 0
    for f in result["flights"]:
        utc = _local_to_utc(f["departure_local"], f["departure_airport"])
        if not utc:
            add_log(conn, f"Skipped flight {f['flight_number']}: unknown time zone for {f['departure_airport']}", "warning")
            continue
        # A flight found earlier (by the phone-app service) may spell its
        # number differently; same departure means same flight
        same = conn.execute(
            "SELECT flight_number FROM flights WHERE reservation_id = ? AND departure_time = ?",
            (res["id"], utc),
        ).fetchone()
        number = same["flight_number"] if same else f["flight_number"]
        upsert_flight(conn, res["id"], number, f["departure_airport"], f["destination_airport"], utc, False)
        saved += 1
    return saved, result["message"]


def _reservation_from_website(conn: sqlite3.Connection, reservation: dict) -> list[dict]:
    """process_reservation through southwest.com. Returns the flights saved."""
    try:
        saved, message = _web_lookup(conn, reservation)
    except Exception as e:
        saved, message = 0, f"website lookup failed: {str(e).splitlines()[0][:200] if str(e) else type(e).__name__}"
    process_reservation.last_error = "" if saved else message
    level = "info" if saved else "error"
    add_log(conn, f"Reservation {reservation['confirmation_number']}: {message}", level)
    if not saved:
        return []
    rows = conn.execute(
        "SELECT id, flight_number, departure_time, departure_airport, destination_airport "
        "FROM flights WHERE reservation_id = ? AND departure_time > ?",
        (reservation["id"], datetime.now(timezone.utc).isoformat()),
    ).fetchall()
    return [
        {
            **dict(r),
            "confirmation_number": reservation["confirmation_number"],
            "first_name": reservation["first_name"],
            "last_name": reservation["last_name"],
        }
        for r in rows
    ]


def process_manual_reservations(conn: sqlite3.Connection) -> None:
    """Find the flights on reservations added by hand (not from an account login).

    Southwest's phone-app service first; if that fails, the reservation page
    on southwest.com. A failed lookup is retried after 15 minutes, then less
    often (up to every 2 hours); a good one is refreshed daily. The result
    shows on the Reservations page, where "Try again" clears next_lookup_at.
    """
    now = datetime.utcnow().isoformat()
    reservations = conn.execute(
        "SELECT * FROM reservations WHERE account_id IS NULL AND is_active = 1 "
        "AND (next_lookup_at IS NULL OR next_lookup_at <= ?)",
        (now,),
    ).fetchall()

    for res_row in reservations:
        res = dict(res_row)
        logger.info("Processing reservation: %s", res["confirmation_number"])
        failures = int(res.get("lookup_failures") or 0)
        flights = process_reservation(conn, res)
        if flights:
            where = "with Southwest" if phone_app_enabled() else "on southwest.com"
            _set_lookup(conn, res["id"], "ok", f"Found {len(flights)} flight(s) {where}", 0, 24 * 60)
            continue
        first_error = (getattr(process_reservation, "last_error", "") or "Southwest returned no flights")
        if phone_app_enabled():
            # The phone-app service failed; southwest.com is the backup
            try:
                saved, message = _web_lookup(conn, res)
            except Exception as e:
                saved, message = 0, f"website lookup failed: {e}"
            if saved:
                _set_lookup(conn, res["id"], "ok", f"Found {saved} flight(s) on southwest.com", 0, 24 * 60)
                add_log(conn, f"Reservation {res['confirmation_number']}: {message}", "info")
                continue
            reason = f"phone-app service: {first_error[:150]}; website: {message}"
        else:
            reason = first_error
        failures += 1
        retry = LOOKUP_RETRY_MINUTES[min(failures, len(LOOKUP_RETRY_MINUTES)) - 1]
        has_flights = conn.execute("SELECT 1 FROM flights WHERE reservation_id = ? LIMIT 1", (res["id"],)).fetchone()
        _set_lookup(
            conn, res["id"], "ok" if has_flights else "error",
            f"Couldn't look up the flights ({reason}). "
            f"Trying again in {retry} minutes" + ("" if has_flights else ", or add the flights by hand."),
            failures, retry,
        )


last_fare_check: float = 0
FARE_CHECK_INTERVAL = 4 * 3600  # Check fares every 4 hours


def check_fares(conn: sqlite3.Connection) -> None:
    """Check for fare drops on upcoming flights using the browser session."""
    global last_fare_check

    if time.time() - last_fare_check < FARE_CHECK_INTERVAL:
        return

    if not browser_session:
        return

    if not phone_app_enabled():
        # Fare-drop checks on booked flights read Southwest's change-flight
        # prices, which only the phone-app service offers
        if last_fare_check == 0:
            add_log(conn, "Fare-drop checks on booked flights are off: they need the phone-app service "
                    "(API Connections page). Southwest fare watches still work.", "info")
        last_fare_check = time.time()
        return

    flights = get_flights_for_fare_check(conn)
    if not flights:
        last_fare_check = time.time()
        return

    logger.info("Checking fares for %d flights", len(flights))
    add_log(conn, f"Checking fares for {len(flights)} flights", "info")

    from lib.flight import Flight

    for flight_row in flights:
        try:
            # Re-fetch reservation to get fresh passenger-search-token
            # (stored tokens expire due to inactivity)
            res_info = {
                "firstName": flight_row["first_name"],
                "lastName": flight_row["last_name"],
                "recordLocator": flight_row["confirmation_number"],
            }
            res_site = VIEW_RESERVATION_URL + flight_row["confirmation_number"]
            try:
                fresh_response = browser_session.make_request("POST", res_site, {}, res_info, max_attempts=3)
                reservation_info = fresh_response.get("viewReservationViewPage", {})
                # Update stored reservation_info with fresh data
                update_flight_reservation_info(conn, flight_row["id"], json.dumps(reservation_info))
            except RequestError as e:
                add_log(conn, f"Fare check: failed to refresh reservation {flight_row['confirmation_number']}: {e}", "warning", flight_row["id"])
                continue

            bounds = reservation_info.get("bounds", [])
            if not bounds:
                add_log(conn, f"No bounds in reservation_info for {flight_row['confirmation_number']}", "warning", flight_row["id"])
                continue

            # Check for change link
            links = reservation_info.get("_links", {})
            change_link = links.get("change")
            if not change_link:
                add_log(conn, f"No change link for {flight_row['confirmation_number']} - fare check not available", "info", flight_row["id"])
                continue

            # Step 1: Get the change flight page
            change_site = "mobile-air-booking/" + change_link["href"]
            try:
                change_response = browser_session.make_request(
                    "GET", change_site, {}, change_link.get("query"), max_attempts=3
                )
            except RequestError as e:
                add_log(
                    conn,
                    f"Fare check failed (change page) for {flight_row['confirmation_number']}: {e}",
                    "warning",
                    flight_row["id"],
                )
                # Log diagnostic with the full change_link for debugging
                log_diagnostic(
                    conn,
                    category="fare_check_failure",
                    endpoint=f"GET {change_site}",
                    expected_behavior="200 OK with changeFlightPage",
                    actual_behavior=str(e),
                    headers_snapshot=json.dumps(list(browser_session.headers.keys())),
                    response_snapshot=json.dumps({
                        "change_link": change_link,
                        "error_response_body": getattr(e, "response_body", ""),
                    })[:1000],
                )
                continue

            change_flight_page = change_response.get("changeFlightPage", {})
            if not change_flight_page:
                add_log(conn, f"No changeFlightPage in response for {flight_row['confirmation_number']}", "warning", flight_row["id"])
                continue

            # Build search query
            bound_references = change_flight_page.get("_links", {}).get("changeShopping", {})
            shopping_body = bound_references.get("body", [])
            bound_selections = change_flight_page.get("boundSelections", [])

            query = {}
            bound_keys = ["outbound", "inbound"]
            target_bound_page = None
            for idx, bound_sel in enumerate(bound_selections):
                if idx < len(bound_keys) and idx < len(shopping_body):
                    is_match = normalize_flight_number(bound_sel.get("flight")) == normalize_flight_number(flight_row["flight_number"])
                    query[bound_keys[idx]] = {
                        "boundReference": shopping_body[idx].get("boundReference", ""),
                        "date": bound_sel.get("originalDate", ""),
                        "destination-airport": bound_sel.get("toAirportCode", ""),
                        "origin-airport": bound_sel.get("fromAirportCode", ""),
                        "isChangeBound": is_match,
                    }
                    if is_match:
                        target_bound_page = f"{bound_keys[idx]}Page"

            if not target_bound_page:
                add_log(conn, f"Flight number {flight_row['flight_number']} didn't match any bound", "warning", flight_row["id"])
                continue

            # Step 2: Get matching flights
            shopping_href = bound_references.get("href", "")
            if not shopping_href:
                continue
            shopping_site = "mobile-air-booking/" + shopping_href

            time.sleep(2)  # Be polite
            try:
                shopping_response = browser_session.make_request(
                    "POST", shopping_site, {}, query, max_attempts=3
                )
            except RequestError as e:
                add_log(conn, f"Fare check failed (shopping) for {flight_row['confirmation_number']}: {e}", "warning", flight_row["id"])
                continue

            # Extract fare type from reservation bounds
            fare_type_bounds = reservation_info.get("bounds", [])
            bound_idx = 0 if target_bound_page == "outboundPage" else 1
            if bound_idx < len(fare_type_bounds):
                fare_details = fare_type_bounds[bound_idx].get("fareProductDetails", {})
                fare_type = fare_details.get("fareProductId", "")
            else:
                continue

            cards = shopping_response.get("changeShoppingPage", {}).get("flights", {}).get(target_bound_page, {}).get("cards", [])

            # Read fare check mode preference
            prefs = get_seat_preferences(conn, flight_row.get("pref_account_id"))
            fare_mode = (prefs or {}).get("fare_check_mode", "same_day_nonstop")

            # Find lowest fare based on mode
            lowest_fare = None
            best_alt_flight = None
            best_alt_nonstop = False
            best_alt_stops = None
            best_alt_depart_time = None
            my_flight_fare_val = None

            for card in cards:
                card_flight_num = card.get("flightNumbers", "")
                card_nonstop = card.get("stopDescription", "") == "Nonstop"
                card_stops = card.get("stopDescription", "")
                card_depart_time = card.get("departureTime", "")
                is_my_flight = normalize_flight_number(card_flight_num) == normalize_flight_number(flight_row["flight_number"])

                # Apply filter based on mode
                if fare_mode == "same_flight" and not is_my_flight:
                    continue
                elif fare_mode == "same_day_nonstop" and not card_nonstop:
                    continue
                # "same_day" mode: check all cards

                for fare in (card.get("fares") or []):
                    if fare.get("_meta", {}).get("fareProductId") == fare_type:
                        if "priceDifference" in fare:
                            price_diff = fare["priceDifference"]
                            sign = price_diff.get("sign", "")
                            amount = int(sign + price_diff["amount"].replace(",", ""))
                            currency = price_diff.get("currencyCode", "USD")

                            # Track my flight's fare separately
                            if is_my_flight:
                                my_flight_fare_val = amount

                            # Track overall lowest
                            if not lowest_fare or amount < lowest_fare["amount"]:
                                lowest_fare = {"amount": amount, "currencyCode": currency}
                                if not is_my_flight:
                                    best_alt_flight = card_flight_num
                                    best_alt_nonstop = card_nonstop
                                    best_alt_stops = card_stops
                                    best_alt_depart_time = card_depart_time
                                else:
                                    best_alt_flight = None
                                    best_alt_nonstop = False
                                    best_alt_stops = None
                                    best_alt_depart_time = None

            if not lowest_fare:
                lowest_fare = {"amount": 0, "currencyCode": "USD"}

            # Only keep alternative if it's actually cheaper than booked flight
            if best_alt_flight and my_flight_fare_val is not None:
                if lowest_fare["amount"] >= my_flight_fare_val:
                    best_alt_flight = None
                    best_alt_nonstop = False
                    best_alt_stops = None
                    best_alt_depart_time = None

            add_fare_check(
                conn, flight_row["id"], lowest_fare["amount"],
                lowest_fare.get("currencyCode", "USD"),
                best_flight_number=best_alt_flight,
                best_flight_nonstop=best_alt_nonstop,
                best_flight_stops=best_alt_stops,
                best_flight_depart_time=best_alt_depart_time,
                my_flight_fare=my_flight_fare_val,
            )
            price_str = f"{lowest_fare['amount']:+,} {lowest_fare['currencyCode']}"

            # Get previous fare check for deduplication
            prev_rows = conn.execute(
                "SELECT price_change FROM fare_history WHERE flight_id = ? ORDER BY checked_at DESC LIMIT 2",
                (flight_row["id"],),
            ).fetchall()
            prev_amount = prev_rows[1]["price_change"] if len(prev_rows) > 1 else None

            route = f"{flight_row['departure_airport']} -> {flight_row.get('destination_airport', '?')}"

            if best_alt_flight:
                stops_label = f" ({best_alt_stops})" if best_alt_stops else ""
                time_label = f" departs {best_alt_depart_time}" if best_alt_depart_time else ""
                my_fare_label = f" (your flight: {my_flight_fare_val:+,})" if my_flight_fare_val is not None else ""
                add_log(
                    conn,
                    f"Better flight for {flight_row['confirmation_number']} ({route}): "
                    f"WN {best_alt_flight}{stops_label}{time_label} at {price_str}{my_fare_label}",
                    "info",
                    flight_row["id"],
                )

            if lowest_fare["amount"] < -1:

                # Only send notification if fare dropped FURTHER than last check
                if prev_amount is None or lowest_fare["amount"] < prev_amount:
                    alt_info = ""
                    if best_alt_flight:
                        stops_tag = f" ({best_alt_stops})" if best_alt_stops else ""
                        time_tag = f" departs {best_alt_depart_time}" if best_alt_depart_time else ""
                        alt_info = f" - Better option: WN {best_alt_flight}{stops_tag}{time_tag}"
                    add_log(conn, f"NEW fare drop for {flight_row['confirmation_number']}: {price_str}{alt_info} (was {prev_amount})", "info", flight_row["id"])
                    try:
                        from notifications import notify_fare_drop
                        notify_msg = f"{price_str}{alt_info}"
                        notify_fare_drop(flight_row["confirmation_number"], route, notify_msg, flight_id=flight_row["id"])
                    except Exception:
                        pass
                else:
                    add_log(conn, f"Fare unchanged since last check ({price_str}), skipping notification", "info", flight_row["id"])
            else:
                add_log(conn, f"Fare check for {flight_row['confirmation_number']}: {price_str}", "info", flight_row["id"])

        except Exception as e:
            logger.error("Error processing fare check for flight %s: %s", flight_row["id"], e)
            add_log(conn, f"Fare check error for {flight_row['confirmation_number']}: {e}", "error", flight_row["id"])

    last_fare_check = time.time()


SEAT_UPGRADE_COOLDOWN = 3 * 3600  # 3 hours between successful attempts per flight

# Fields on Southwest's manage-reservation lookup form, described for the LLM
LOOKUP_FORM_FIELDS = {
    "confirmation_number": "the reservation confirmation number (6-character record locator)",
    "first_name": "the passenger's first name",
    "last_name": "the passenger's last name",
}


def _llm_click(conn: sqlite3.Connection, driver, flight_id: str, goal: str) -> bool:
    """Fallback when hard-coded selectors miss: let the local LLM pick the element."""
    selector = llm_browser.find_element(driver, goal)
    if not selector:
        return False
    try:
        driver.click(selector)
    except Exception as e:
        add_log(conn, f"Local LLM picked an element for '{goal}' but clicking it failed: {e}", "warning", flight_id)
        return False
    add_log(conn, f"Selectors missed '{goal}'; local LLM found and clicked it", "info", flight_id)
    return True


def _restore_mobile_origin(conn: sqlite3.Connection, flight_id: str) -> None:
    """Ensure the shared browser is back on mobile.southwest.com.

    Seat upgrades navigate to the desktop site. All API calls run as fetch()
    inside the current page, so leaving the browser on www.southwest.com makes
    every subsequent mobile API request fail cross-origin with status 0.
    """
    if not browser_session:
        return
    try:
        with browser_session._lock:
            driver = browser_session._driver
            if not driver:
                return
            try:
                current = driver.current_url or ""
            except Exception:
                current = ""
            if "mobile.southwest.com" in current:
                return
            # Back to a mobile.southwest.com page with a fresh API session
            try:
                browser_session.restore(timeout=90)
            except Exception as restore_err:
                logger.warning("Couldn't restore the mobile site: %s", restore_err)
        add_log(conn, "Browser restored to mobile.southwest.com after seat upgrade", "info", flight_id)
    except Exception as e:
        logger.error("Failed to restore browser to mobile origin: %s", e)
        try:
            add_log(conn, f"Failed to restore browser to mobile site after seat upgrade: {e}", "error", flight_id)
        except Exception:
            pass


def attempt_seat_upgrades(conn: sqlite3.Connection, force_flight_id: str | None = None) -> None:
    """For A-List accounts, attempt seat upgrade from 48h to 2h before departure.
    If force_flight_id is provided, only check that specific flight (bypasses cooldown).
    CRITICAL: Will NOT run if any check-in is imminent (within 2 hours)."""
    if not browser_session:
        return

    # CRITICAL SAFETY CHECK: Do not interfere with upcoming check-ins
    # Seat upgrades hold the browser lock for minutes, which blocks check-in threads
    now_utc = datetime.utcnow()
    for handler_id, handler in active_handlers.items():
        try:
            checkin_time = handler.checkin_time
            seconds_until_checkin = (checkin_time - now_utc.replace(tzinfo=handler.departure_time.tzinfo) if handler.departure_time.tzinfo else checkin_time - now_utc).total_seconds()
            if 0 < seconds_until_checkin < 7200:  # Within 2 hours
                add_log(conn, f"Seat upgrades PAUSED: check-in for {handler.confirmation_number} in {int(seconds_until_checkin / 60)} minutes. Check-in takes priority.", "info")
                return
        except Exception:
            pass

    if force_flight_id:
        # Manual check for a specific flight - bypass normal query
        rows = conn.execute(
            "SELECT f.*, r.confirmation_number, r.first_name, r.last_name, "
            "COALESCE(r.account_id, r.owner_account_id) AS pref_account_id "
            "FROM flights f JOIN reservations r ON r.id = f.reservation_id "
            "WHERE f.id = ?",
            (force_flight_id,),
        ).fetchall()
        flights = [dict(r) for r in rows]
        add_log(conn, f"Manual seat check triggered for flight {force_flight_id}", "info")
    else:
        flights = get_flights_for_seat_upgrade(conn)

    if not flights:
        return

    # Ensure browser is alive
    try:
        browser_session.ensure_alive()
    except Exception as e:
        add_log(conn, f"Browser session not available for seat upgrades: {e}", "error")
        return

    from lib.seat_choice import SeatPrefs, choose as choose_seat, current_seat_from_text, seat_costs_money, tier as seat_tier

    for flight_row in flights:
        # Each traveler's account can have its own seat preferences
        seat_prefs = SeatPrefs.from_row(get_seat_preferences(conn, flight_row.get("pref_account_id")))
        flight_id = flight_row["id"]
        conf_num = flight_row["confirmation_number"]
        first_name = flight_row["first_name"]
        last_name = flight_row["last_name"]
        route = f"{flight_row['departure_airport']}->{flight_row.get('destination_airport', '?')}"
        current_seat = flight_row.get("assigned_seat", "")

        # Cooldown between automatic attempts (skipped for manual checks)
        if not force_flight_id:
            last_attempt = flight_row.get("last_seat_upgrade_attempt")
            if last_attempt:
                try:
                    last_dt = datetime.fromisoformat(last_attempt)
                    elapsed = (datetime.utcnow() - last_dt).total_seconds()
                    if elapsed < SEAT_UPGRADE_COOLDOWN:
                        logger.debug("Seat upgrade for %s: cooldown (%d min remaining)", conf_num, int((SEAT_UPGRADE_COOLDOWN - elapsed) / 60))
                        continue
                except Exception:
                    pass

        # Record the attempt BEFORE doing anything: failed attempts must also
        # respect the cooldown, otherwise a flight whose upgrade keeps failing
        # is retried on every poll and monopolizes the shared browser for hours.
        conn.execute(
            "UPDATE flights SET last_seat_upgrade_attempt = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), flight_id),
        )
        conn.commit()

        add_log(conn, f"Attempting seat upgrade for {conf_num} ({route}). Current seat: {current_seat or 'none'}", "info", flight_id)

        # Initialize audit system
        from lib.seat_audit import SeatUpgradeAudit
        audit = SeatUpgradeAudit(flight_id, browser_session, get_db)
        audit.start()

        try:
            import os
            cap_dir = os.path.join(CAPTURES_DIR, flight_id)
            os.makedirs(cap_dir, exist_ok=True)

            # Step 1: Navigate to manage reservation lookup (no login required)
            audit.begin_step("navigate_manage_reservation")
            add_log(conn, f"Navigating to manage reservation lookup for {conf_num}", "info", flight_id)

            with browser_session._lock:
                driver = browser_session._driver
                if not driver:
                    add_log(conn, f"No browser driver available for seat upgrade", "error", flight_id)
                    continue

                driver.get("https://www.southwest.com/air/manage-reservation/index.html")
                time.sleep(5)

                # Find and fill the confirmation number field
                conf_input_sel = None
                for sel in [
                    'input[id="confirmationNumber"]',
                    'input[name="confirmationNumber"]',
                    'input[id*="onfirmation"]',
                    'input[name*="onfirmation"]',
                    'input[placeholder*="onfirmation"]',
                    'input[aria-label*="onfirmation"]',
                ]:
                    try:
                        driver.wait_for_element_visible(sel, timeout=5)
                        conf_input_sel = sel
                        break
                    except Exception:
                        continue

                if not conf_input_sel:
                    # Fallback: find inputs by scanning the page
                    conf_input_sel = driver.execute_script("""
                        var inputs = document.querySelectorAll('input[type="text"], input:not([type])');
                        for (var input of inputs) {
                            var label = (input.getAttribute('aria-label') || '') +
                                        (input.getAttribute('placeholder') || '') +
                                        (input.getAttribute('name') || '') +
                                        (input.getAttribute('id') || '');
                            if (label.toLowerCase().includes('confirm')) {
                                return '#' + input.id || '[name="' + input.name + '"]';
                            }
                        }
                        // Return info about what inputs exist for diagnostics
                        var info = [];
                        inputs.forEach(function(inp) {
                            info.push(inp.id || inp.name || inp.placeholder || inp.type || 'unknown');
                        });
                        return null;
                    """)

                llm_fields = None
                if not conf_input_sel:
                    llm_fields = llm_browser.find_form_fields(driver, LOOKUP_FORM_FIELDS)
                    if llm_fields and llm_fields.get("confirmation_number"):
                        conf_input_sel = llm_fields["confirmation_number"]
                        add_log(conn, "Selectors missed the confirmation field; local LLM found it", "info", flight_id)

                if not conf_input_sel:
                    driver.save_screenshot(f"{cap_dir}/00_no_form.png")
                    audit.save_dom("manage_reservation_form_dom.html")
                    add_log(conn, f"Could not find confirmation number input on manage reservation page", "error", flight_id)
                    audit.end_step(success=False, data={"error": "form not found"})
                    audit.finish(status="failed", error_message="Manage reservation form not found")
                    continue

                add_log(conn, f"Found form field: {conf_input_sel}", "info", flight_id)
                audit.end_step(success=True, data={"form_field": conf_input_sel})

                # Step 2: Fill form and submit
                audit.begin_step("fill_and_submit_form")

                # Find first name and last name fields
                first_name_sel = None
                last_name_sel = None
                for sel_pair in [
                    ('input[id="passengerFirstName"]', 'input[id="passengerLastName"]'),
                    ('input[name="passengerFirstName"]', 'input[name="passengerLastName"]'),
                    ('input[id*="irstName"]', 'input[id*="astName"]'),
                    ('input[name*="irstName"]', 'input[name*="astName"]'),
                    ('input[placeholder*="irst name"]', 'input[placeholder*="ast name"]'),
                    ('input[aria-label*="irst name"]', 'input[aria-label*="ast name"]'),
                ]:
                    try:
                        driver.find_element(sel_pair[0])
                        driver.find_element(sel_pair[1])
                        first_name_sel = sel_pair[0]
                        last_name_sel = sel_pair[1]
                        break
                    except Exception:
                        continue

                if not first_name_sel or not last_name_sel:
                    llm_fields = llm_fields or llm_browser.find_form_fields(driver, LOOKUP_FORM_FIELDS)
                    if llm_fields and llm_fields.get("first_name") and llm_fields.get("last_name"):
                        first_name_sel = llm_fields["first_name"]
                        last_name_sel = llm_fields["last_name"]
                        add_log(conn, "Selectors missed the name fields; local LLM found them", "info", flight_id)

                if not first_name_sel or not last_name_sel:
                    driver.save_screenshot(f"{cap_dir}/00_no_name_fields.png")
                    audit.save_dom("manage_reservation_names_dom.html")
                    add_log(conn, f"Could not find first/last name fields", "error", flight_id)
                    audit.end_step(success=False, data={"error": "name fields not found"})
                    audit.finish(status="failed", error_message="Name fields not found on manage reservation form")
                    continue

                # Clear and type into form fields
                driver.type(conf_input_sel, conf_num)
                time.sleep(0.5)
                driver.type(first_name_sel, first_name)
                time.sleep(0.5)
                driver.type(last_name_sel, last_name)
                time.sleep(0.5)

                driver.save_screenshot(f"{cap_dir}/01_form_filled.png")

                # Click submit button
                submit_clicked = False
                for submit_sel in [
                    'button[type="submit"]',
                    'button[id*="etrieve"]',
                    'button[id*="ubmit"]',
                ]:
                    try:
                        if driver.is_element_visible(submit_sel):
                            driver.click(submit_sel)
                            submit_clicked = True
                            break
                    except Exception:
                        continue

                if not submit_clicked:
                    # Fallback: find button by text content
                    submit_clicked = driver.execute_script("""
                        var buttons = document.querySelectorAll('button, input[type="submit"]');
                        for (var btn of buttons) {
                            var text = btn.textContent.trim().toLowerCase();
                            if (text.includes('retrieve') || text.includes('look up') ||
                                text.includes('submit') || text.includes('search')) {
                                btn.click();
                                return true;
                            }
                        }
                        return false;
                    """)

                if not submit_clicked:
                    submit_clicked = _llm_click(
                        conn, driver, flight_id,
                        "the button that submits this form to look up the reservation",
                    )

                if not submit_clicked:
                    driver.save_screenshot(f"{cap_dir}/01_no_submit.png")
                    audit.save_dom("manage_reservation_submit_dom.html")
                    add_log(conn, f"Could not find submit button", "error", flight_id)
                    audit.end_step(success=False, data={"error": "submit button not found"})
                    audit.finish(status="failed", error_message="Submit button not found")
                    continue

                add_log(conn, f"Form submitted for {conf_num} ({first_name} {last_name})", "info", flight_id)

                # Wait for the reservation details page to load
                details_loaded = False
                for wait_i in range(25):  # Up to 25 seconds
                    time.sleep(1)
                    page_text = driver.execute_script("return document.body ? document.body.textContent : ''")
                    current_url = driver.current_url
                    # Check for trip detail page indicators
                    if any(indicator in page_text for indicator in [
                        "Modify seats", "Manage my trip", "Seat Assignments",
                        "Flight details", "Change seats", conf_num,
                    ]):
                        details_loaded = True
                        add_log(conn, f"Reservation details loaded after {wait_i + 1}s. URL: {current_url}", "info", flight_id)
                        break
                    # Check for errors
                    if "unable to retrieve" in page_text.lower() or "not found" in page_text.lower():
                        add_log(conn, f"Reservation lookup error: {page_text[:300]}", "error", flight_id)
                        break

                driver.save_screenshot(f"{cap_dir}/02_reservation_details.png")
                audit.end_step(success=details_loaded, data={
                    "url": driver.current_url,
                    "wait_seconds": wait_i + 1 if details_loaded else 25,
                })

                if not details_loaded:
                    page_text = driver.execute_script("return document.body ? document.body.textContent.substring(0, 500) : ''")
                    add_log(conn, f"Reservation details not loaded after 25s. Page text: {page_text[:300]}", "warning", flight_id)
                    audit.save_dom("reservation_details_failed_dom.html")
                    audit.finish(status="failed", error_message="Reservation details page did not load")
                    continue

                # Extract current seat assignment from this page
                seat_info = driver.execute_script("""
                    var text = document.body.textContent || '';
                    var seatMatch = text.match(/Seat\\s+(\\d{1,2}[A-F]),?\\s*(\\w+)?/i);
                    return seatMatch ? seatMatch[0] : 'not found';
                """)
                add_log(conn, f"Current seat on details page: {seat_info}", "info", flight_id)

                # Click "Modify seats" link
                audit.begin_step("click_modify_seats")
                modify_result = driver.execute_script("""
                    var links = document.querySelectorAll('a');
                    for (var link of links) {
                        var text = link.textContent.trim();
                        if (text === 'Modify seats' || text === 'Modify Seats') {
                            link.click();
                            return 'clicked Modify seats';
                        }
                    }
                    // Try buttons too
                    var btns = document.querySelectorAll('button');
                    for (var btn of btns) {
                        var text = btn.textContent.trim();
                        if (text === 'Modify seats' || text === 'Modify Seats') {
                            btn.click();
                            return 'clicked Modify seats (button)';
                        }
                    }
                    // Diagnostics
                    var allLinks = [];
                    document.querySelectorAll('a').forEach(function(a) {
                        var t = a.textContent.trim().substring(0, 30);
                        if (t) allLinks.push(t);
                    });
                    return 'Modify seats not found. Links: ' + allLinks.join(' | ');
                """)

                add_log(conn, f"Modify seats click: {str(modify_result)[:200]}", "info", flight_id)

                if not modify_result or not str(modify_result).startswith("clicked"):
                    if _llm_click(
                        conn, driver, flight_id,
                        "the link or button that opens seat selection to change the seats on this trip",
                    ):
                        modify_result = "clicked (found by local LLM)"

                if not modify_result or not str(modify_result).startswith("clicked"):
                    driver.save_screenshot(f"{cap_dir}/03_no_modify_seats.png")
                    add_log(conn, f"Could not find Modify seats link on manage trip page", "warning", flight_id)
                    audit.end_step(success=False, data={"result": str(modify_result)[:200]})
                    audit.save_dom("modify_seats_failed_dom.html")
                    audit.finish(status="failed", error_message="Modify seats link not found")
                    continue
                audit.end_step(success=True, data={"result": str(modify_result)[:100]})

                # Wait for seat map page to load
                audit.begin_step("wait_seat_map")
                time.sleep(8)
                driver.save_screenshot(f"{cap_dir}/03_seat_map.png")
                add_log(conn, f"Seat map page loaded. URL: {driver.current_url}", "info", flight_id)
                audit.end_step(success=True)
                audit.save_dom("seat_map_dom.html")

                # Step 5: Look for seat map
                audit.begin_step("extract_seats")

                seat_loaded = False
                seat_selectors = [
                    "[data-seat-number]",
                    "[class*='seat'][class*='available']",
                    "button[class*='seat']",
                    "[class*='SeatMap']",
                    "[class*='seatMap']",
                    "[class*='seat-map']",
                    "[class*='seatmap']",
                    "table[class*='seat']",
                    "[role='grid']",
                ]
                for sel in seat_selectors:
                    try:
                        driver.wait_for_element_visible(sel, timeout=5)
                        seat_loaded = True
                        add_log(conn, f"Seat map loaded (selector: {sel})", "info", flight_id)
                        break
                    except Exception:
                        continue

                if not seat_loaded:
                    time.sleep(10)
                    add_log(conn, f"Seat map selectors not found, waited 10s. URL: {driver.current_url}", "warning", flight_id)

                # Step 5: Capture the seat map
                driver.save_screenshot(f"{cap_dir}/04_seat_map.png")
                dom = driver.execute_script("return document.documentElement.outerHTML")
                with open(f"{cap_dir}/seat_map_dom.html", "w") as f:
                    f.write(dom)
                add_log(conn, f"Seat map captured. URL: {driver.current_url}", "info", flight_id)

                # Record in captures table
                manifest = json.dumps({
                    "flight_id": flight_id, "type": "seat_upgrade",
                    "files": [
                        {"name": "01_trips_tab.png", "type": "screenshot"},
                        {"name": "02_manage_trip.png", "type": "screenshot"},
                        {"name": "03_seat_map.png", "type": "screenshot"},
                        {"name": "seat_map_dom.html", "type": "dom"},
                    ],
                })
                conn.execute(
                    "INSERT INTO checkin_captures (flight_id, capture_dir, manifest_json, file_count, total_size_bytes) VALUES (?, ?, ?, ?, ?)",
                    (flight_id, cap_dir, manifest, 4, 0),
                )
                conn.commit()

                # Step 6: Extract seats from DOM
                seats_js = driver.execute_script("""
                    var seats = [];
                    // Strategy 1: data-seat-number attributes
                    document.querySelectorAll('[data-seat-number]').forEach(function(el) {
                        seats.push({seat: el.getAttribute('data-seat-number'), className: el.className, disabled: el.disabled || el.getAttribute('aria-disabled') === 'true', text: el.textContent.trim().substring(0, 40), aria: (el.getAttribute('aria-label') || '').substring(0, 80), tag: el.tagName});
                    });
                    // Strategy 2: buttons/divs with seat classes containing seat IDs
                    if (seats.length === 0) {
                        document.querySelectorAll('button[class*="seat"], div[class*="seat"], td[class*="seat"]').forEach(function(el) {
                            var text = el.textContent.trim();
                            if (text.match(/^\\d{1,2}[A-F]$/)) {
                                seats.push({seat: text, className: el.className, disabled: el.disabled || el.getAttribute('aria-disabled') === 'true', text: text, aria: (el.getAttribute('aria-label') || '').substring(0, 80), tag: el.tagName});
                            }
                        });
                    }
                    // Strategy 3: aria-label with seat info
                    if (seats.length === 0) {
                        document.querySelectorAll('[aria-label*="Seat"], [aria-label*="seat"], [aria-label*="Row"]').forEach(function(el) {
                            var label = el.getAttribute('aria-label') || '';
                            var match = label.match(/(\\d{1,2}[A-F])/);
                            if (match) {
                                seats.push({seat: match[1], className: el.className, disabled: el.disabled || el.getAttribute('aria-disabled') === 'true', text: label.substring(0, 80), tag: el.tagName});
                            }
                        });
                    }
                    var meta = {url: window.location.href, title: document.title, seatCount: seats.length, allButtons: document.querySelectorAll('button').length};
                    return JSON.stringify({seats: seats, meta: meta});
                """)

                try:
                    seats_data = json.loads(seats_js)
                except (json.JSONDecodeError, TypeError):
                    seats_data = {"seats": [], "meta": {}}

                all_seats = seats_data.get("seats", [])
                page_meta = seats_data.get("meta", {})
                if not all_seats:
                    llm_seats = llm_browser.extract_seats(driver)
                    if llm_seats:
                        all_seats = llm_seats
                        seats_data["seats"] = llm_seats
                        add_log(conn, f"Selectors found no seats; local LLM read {len(llm_seats)} available seats", "info", flight_id)
                add_log(conn, f"Page: {page_meta.get('title', '?')} | Found {len(all_seats)} seat elements | URL: {page_meta.get('url', '?')}", "info", flight_id)

                with open(f"{cap_dir}/seat_data.json", "w") as f:
                    json.dump(seats_data, f, indent=2)

                if not all_seats:
                    page_text = driver.execute_script("return document.body ? document.body.textContent.substring(0, 500) : ''")
                    add_log(conn, f"No seat elements found on page. Body preview: {page_text[:200]}", "warning", flight_id)
                    log_diagnostic(conn, "seat_map_empty", driver.current_url,
                                   "Seat elements", f"0 found. Buttons: {page_meta.get('allButtons')}",
                                   response_snapshot=page_text[:500])
                else:
                    # Step 7: Take a seat only when it's free and beats the current
                    # one under the Settings preferences (lib/seat_choice.py)
                    if not current_seat:
                        page_text = driver.execute_script("return document.body ? document.body.innerText : ''") or ""
                        current_seat = current_seat_from_text(page_text) or ""
                    choice, why = choose_seat(all_seats, current_seat or None, seat_prefs)
                    add_log(conn, f"Seat check for {conf_num} (current {current_seat or 'unknown'}): {why}", "info", flight_id)
                    available_seats = [{**choice, "score": seat_tier(choice["seat"], seat_prefs)}] if choice else []
                    audit.end_step(success=True, data={
                        "total_found": len(all_seats),
                        "current_seat": current_seat,
                        "decision": why,
                    })

                    if available_seats:
                        best = available_seats[0]
                        add_log(conn, f"Best seat: {best['seat']} (score {best['score']}), clicking...", "info", flight_id)
                        audit.begin_step("click_seat")

                        clicked = False
                        click_selectors = [f"[data-seat-number='{best['seat']}']", f"button:contains('{best['seat']}')", f"[aria-label*='{best['seat']}']"]
                        if best.get("selector"):
                            click_selectors.insert(0, best["selector"])
                        for click_sel in click_selectors:
                            try:
                                driver.click(click_sel)
                                clicked = True
                                add_log(conn, f"Clicked seat {best['seat']}", "info", flight_id)
                                break
                            except Exception:
                                continue

                        paid = False
                        if clicked:
                            time.sleep(2)
                            driver.save_screenshot(f"{cap_dir}/05_after_click.png")
                            # Never buy a seat: if finishing would charge money, stop here
                            paid = seat_costs_money(driver)
                        if paid:
                            add_log(conn, f"Seat {best['seat']} would cost money; keeping {current_seat or 'the current seat'}", "warning", flight_id)
                            audit.end_step(success=False, data={"seat": best["seat"], "clicked": True, "paid": True})
                        elif clicked:
                            confirm_clicked = False
                            for confirm_sel in ["button:contains('Continue')", "button:contains('Confirm')", "button:contains('Save')", "button:contains('Done')", "button[type='submit']"]:
                                try:
                                    if driver.is_element_visible(confirm_sel):
                                        driver.click(confirm_sel)
                                        confirm_clicked = True
                                        add_log(conn, f"Clicked confirm: {confirm_sel}", "info", flight_id)
                                        break
                                except Exception:
                                    continue
                            if not confirm_clicked:
                                confirm_clicked = _llm_click(
                                    conn, driver, flight_id,
                                    "the button that confirms, saves, or continues with the selected seat",
                                )
                            if confirm_clicked:
                                time.sleep(3)
                                driver.save_screenshot(f"{cap_dir}/06_after_confirm.png")

                            # Selectors can't tell whether Southwest accepted the
                            # change; when the local LLM is on, read the page and
                            # only record the seat if it says the change went through.
                            verdict = llm_browser.verify_outcome(
                                driver,
                                f"Did the seat change to seat {best['seat']} go through and get saved on the reservation?",
                            )
                            if verdict is not None:
                                add_log(conn, f"LLM check of seat change: {verdict['answer']} - {verdict['summary']}", "info", flight_id)

                            if verdict is not None and verdict["answer"] is False:
                                add_log(conn, f"Seat {best['seat']} was NOT confirmed by Southwest for {conf_num}", "warning", flight_id)
                                audit.end_step(success=False, data={"seat": best["seat"], "clicked": True, "confirmed": False, "llm_summary": verdict["summary"]})
                            else:
                                confirmed = verdict is not None and verdict["answer"] is True
                                update_flight_seat(conn, flight_id, best["seat"])
                                add_log(conn, f"Seat {best['seat']} selected for {conf_num}!" + ("" if confirmed else " (unconfirmed)"), "info", flight_id)
                                audit.end_step(success=True, data={"seat": best["seat"], "score": best["score"], "clicked": True, "confirmed": confirmed})
                                try:
                                    from notifications import send_notification
                                    if confirmed:
                                        send_notification(f"Better seat: {conf_num}", f"Moved to seat {best['seat']}" + (f" from {current_seat}" if current_seat else "") + f" on {route}", "important", flight_id=flight_id)
                                    else:
                                        send_notification(f"Better seat: {conf_num}", f"Picked seat {best['seat']}" + (f" over {current_seat}" if current_seat else "") + f" on {route} (not confirmed, check the Southwest app)", "important", flight_id=flight_id)
                                except Exception:
                                    pass
                        else:
                            add_log(conn, f"Could not click seat {best['seat']}", "warning", flight_id)
                            audit.end_step(success=False, data={"seat": best["seat"], "clicked": False})

                # Finalize audit before cleanup
                audit.finish(status="success" if any(s.get("name") == "click_seat" and s.get("success") for s in audit.steps) else "partial")

                # Step 8: Navigate back to mobile site
                # Back to a mobile.southwest.com page with a fresh API session
                try:
                    browser_session.restore(timeout=90)
                except Exception as restore_err:
                    logger.warning("Couldn't restore the mobile site: %s", restore_err)

        except Exception as e:
            logger.error("Seat upgrade error for %s: %s", conf_num, e)
            add_log(conn, f"Seat upgrade error: {e}", "error", flight_id)
            audit.finish(status="failed", error_message=str(e))
            try:
                browser_session._driver.save_screenshot(os.path.join(CAPTURES_DIR, flight_id, "error.png"))
            except Exception:
                pass
        finally:
            # Every exit path (including the failure `continue`s above) must
            # put the browser back on mobile.southwest.com. All API calls run
            # as fetch() inside the page, so a browser left on the desktop
            # site makes every subsequent request fail cross-origin with
            # status 0 — including time-critical check-ins.
            _restore_mobile_origin(conn, flight_id)



def check_named_fare_watches(conn: sqlite3.Connection) -> None:
    """Run due multi-airline fare watches (Amadeus-based, browser-free)."""
    try:
        from lib.fare_watch import check_fare_watches
        from notifications import send_notification

        check_fare_watches(conn, notify_fn=send_notification)
    except Exception as e:
        logger.error("Fare watch check failed: %s", e)
        add_log(conn, f"Fare watch check failed: {e}", "error")


SOUTHWEST_WATCHES_PER_CYCLE = 2


def _checkin_within(hours: float) -> str | None:
    """Confirmation number of a check-in starting within `hours`, if any."""
    now_utc = datetime.now(timezone.utc)
    for handler in list(active_handlers.values()):
        try:
            departure = handler.departure_time
            if departure.tzinfo is None:
                departure = departure.replace(tzinfo=timezone.utc)
            seconds = (departure - timedelta(hours=handler.checkin_hours) - now_utc).total_seconds()
            if 0 < seconds < hours * 3600:
                return handler.confirmation_number
        except Exception:
            continue
    return None


def check_southwest_watches(conn: sqlite3.Connection) -> None:
    """Southwest fare watches (experimental): read fares from Southwest's search page.

    Uses the shared Chrome session, so it never runs within 2 hours of a
    check-in, and it puts the browser back on the mobile site before
    releasing it (check-ins call Southwest's API from that page).
    """
    if not browser_session:
        return
    import os
    from lib import southwest_watch as sw
    from lib.fare_watch import record_watch_result
    from notifications import send_notification

    interval = float(os.environ.get("SOUTHWEST_WATCH_INTERVAL_HOURS", "6"))
    cutoff = (datetime.utcnow() - timedelta(hours=interval)).isoformat()
    today = datetime.utcnow().date().isoformat()
    rows = conn.execute(
        "SELECT * FROM fare_watches WHERE is_active = 1 AND provider = 'southwest' "
        "AND (last_checked_at IS NULL OR last_checked_at < ?) AND depart_date_end >= ? "
        "ORDER BY last_checked_at IS NOT NULL, last_checked_at LIMIT ?",
        (cutoff, today, SOUTHWEST_WATCHES_PER_CYCLE),
    ).fetchall()
    if not rows:
        return
    soon = _checkin_within(2)
    if soon:
        logger.info("Southwest fare watches paused: check-in for %s within 2 hours", soon)
        return

    for row in rows:
        watch = dict(row)
        try:
            with browser_session._lock:
                driver = browser_session._driver
                if not driver:
                    return
                try:
                    def search(origin: str, destination: str, day: str) -> dict | None:
                        driver.get(sw.search_url(origin, destination, day))
                        time.sleep(sw.PAGE_SETTLE_SECONDS)
                        text = driver.execute_script("return document.body ? document.body.innerText : ''") or ""
                        sw.save_debug(watch["id"], day, f"{origin}-{destination}", text, driver.save_screenshot)
                        return sw.read_page_fare(text)

                    best = sw.find_southwest_fare(search, watch)
                finally:
                    # Back to the mobile site before anyone else gets the browser
                    # Back to a mobile.southwest.com page with a fresh API session
                    try:
                        browser_session.restore(timeout=90)
                    except Exception as restore_err:
                        logger.warning("Couldn't restore the mobile site: %s", restore_err)
            record_watch_result(conn, watch, best, send_notification)
            add_log(
                conn,
                f"Southwest fare watch '{watch['name']}': "
                + (f"${best['price']:.2f}" if best else "no fares found"),
                "info",
            )
        except Exception as e:
            logger.error("Southwest fare watch '%s' failed: %s", watch["name"], e)
            conn.execute(
                "UPDATE fare_watches SET last_checked_at = ?, last_error = ? WHERE id = ?",
                (datetime.utcnow().isoformat(), f"Southwest search failed: {e}"[:500], watch["id"]),
            )
            conn.commit()


def run_flight_status(conn: sqlite3.Connection) -> None:
    """Delay, gate and cancellation alerts (lib/flight_status.py). Needs AERODATABOX_API_KEY."""
    from lib import flight_status
    from notifications import send_notification

    if flight_status.configured():
        made = flight_status.check_statuses(conn, send_notification)
        if made:
            logger.info("Flight status: %d lookup(s)", made)


def run_trip_prices(conn: sqlite3.Connection) -> None:
    """Re-price booked other-airline trips (lib/google_flights.py). Needs SERPAPI_API_KEY."""
    from lib import google_flights
    from notifications import send_notification

    if google_flights.configured():
        google_flights.check_trip_prices(conn, send_notification)


loyalty_runner = None


def run_loyalty_syncs(conn: sqlite3.Connection) -> None:
    """Start any due airline account syncs (lib/loyalty_sync.py).

    They open their own Chrome window, so they wait while a check-in is
    under an hour away to keep the Mac's attention on the check-in.
    """
    global loyalty_runner
    from lib.loyalty_sync import LoyaltySyncRunner
    from notifications import send_notification

    if loyalty_runner is None:
        loyalty_runner = LoyaltySyncRunner(get_db, send_notification, shutdown_event)
    soon = _checkin_within(1)
    loyalty_runner.poll(conn, f"check-in for {soon} within an hour" if soon else None)


def process_connection_tests(conn: sqlite3.Connection) -> None:
    """Dashboard "Test check-in connection": prove both check-in paths work now.

    1. The phone-app path: a live session and Southwest returning the
       reservation (the same lookup the check-in starts with).
    2. The website backup: southwest.com's check-in page loads and the form
       fills in. It's only submitted while check-in isn't open yet (Southwest
       then just says it's too early), so the test never checks anyone in.
    The result goes to system_state for the dashboard to show.
    """
    import safety_net
    from lib.web_checkin import classify_page, web_check_in

    row = conn.execute("SELECT value FROM system_state WHERE key = 'connection_test_request'").fetchone()
    if not row or not row["value"]:
        return
    conn.execute("DELETE FROM system_state WHERE key = 'connection_test_request'")
    conn.commit()
    try:
        flight_id = json.loads(row["value"]).get("flight_id")
    except (TypeError, ValueError):
        return
    flight = conn.execute(
        "SELECT f.*, r.confirmation_number, r.first_name, r.last_name "
        "FROM flights f JOIN reservations r ON r.id = f.reservation_id WHERE f.id = ?",
        (flight_id,),
    ).fetchone()
    if not flight:
        return
    flight = dict(flight)
    steps: list[dict] = []

    def save(done: bool) -> None:
        safety_net.set_state(conn, f"connection_test:{flight_id}", json.dumps({
            "done": done,
            "ok": done and all(s["ok"] for s in steps),
            "steps": steps,
            "checked_at": datetime.utcnow().isoformat() + "Z",
        }))

    soon = _checkin_within(0.5)
    if soon:
        steps.append({"name": "Browser", "ok": False, "detail": f"Busy: a check-in for {soon} is under 30 minutes away. Try after it."})
        save(True)
        return
    save(False)

    # 1. Phone-app path (only when it's turned on)
    if not phone_app_enabled():
        try:
            browser_session.ensure_alive()
            steps.append({"name": "Browser", "ok": True, "detail": "Chrome is running on southwest.com"})
        except Exception as e:
            steps.append({"name": "Browser", "ok": False, "detail": f"Couldn't start: {str(e).splitlines()[0][:200]}"})
        save(False)
    try:
        if not phone_app_enabled():
            raise _SkipPhoneApp
        browser_session.ensure_alive()
        ok = bool(browser_session.headers)
        steps.append({"name": "Southwest session", "ok": ok,
                      "detail": f"Connected ({len(browser_session.headers)} security headers)" if ok
                      else "The browser is up but Southwest didn't hand over a session"})
    except _SkipPhoneApp:
        pass
    except Exception as e:
        steps.append({"name": "Southwest session", "ok": False, "detail": f"Couldn't start: {str(e).splitlines()[0][:200]}"})
    save(False)
    if phone_app_enabled() and steps[-1]["ok"]:
        problems = safety_net.check_flight_readiness(flight, browser_session, handler=None)
        problems = [p for p in problems if "isn't queued" not in p]
        steps.append({"name": "Check-in service (phone-app path)", "ok": not problems,
                      "detail": "Southwest returned the reservation; check-in will go through this path"
                      if not problems else "; ".join(problems)})
        save(False)

    # 2. The website (the check-in path, or the backup with the phone-app service)
    web_step = "Website backup (southwest.com)" if phone_app_enabled() else "Website check-in (southwest.com)"
    departure = datetime.fromisoformat(flight["departure_time"].replace("Z", "+00:00"))
    if departure.tzinfo is None:
        departure = departure.replace(tzinfo=timezone.utc)
    opens = departure - timedelta(hours=int(flight.get("checkin_hours") or 24))
    submit = opens - datetime.now(timezone.utc) > timedelta(minutes=10)
    try:
        with browser_session._lock:
            result = web_check_in(
                browser_session._driver, flight["confirmation_number"], flight["first_name"],
                flight["last_name"], capture_dir=os.path.join(CAPTURES_DIR, flight_id, "connection_test"),
                submit=False,
            )
            if result["ok"] and submit:
                # Look the reservation up; before check-in opens Southwest only says "too early"
                from lib.web_checkin import click_checkin
                click_checkin(browser_session._driver, "the button that looks up the reservation to check in")
                time.sleep(8)
                text = browser_session._driver.execute_script("return document.body ? document.body.innerText : ''") or ""
                status = classify_page(text)
                if status == "not_found":
                    result = {"ok": False, "message": "southwest.com couldn't find the reservation with that name"}
                elif status == "blocked":
                    result = {"ok": False, "message": "Southwest blocked the website check-in page"}
                else:
                    result = {"ok": True, "message": "southwest.com found the reservation (check-in isn't open yet, so nothing was submitted)"}
            try:
                browser_session.restore(timeout=90)
            except Exception as e:
                logger.warning("Couldn't restore the mobile site after the connection test: %s", e)
        steps.append({"name": web_step, "ok": bool(result["ok"]), "detail": result["message"]})
    except Exception as e:
        steps.append({"name": web_step, "ok": False, "detail": f"Couldn't run: {str(e).splitlines()[0][:200]}"})
    save(True)
    add_log(conn, f"Connection test for {flight['confirmation_number']}: " + "; ".join(
        f"{s['name']}: {'OK' if s['ok'] else 'problem'}" for s in steps), "info", flight_id)


class _SkipPhoneApp(Exception):
    """The phone-app service is off: the connection test skips that step."""


def process_manual_seat_checks(conn: sqlite3.Connection) -> None:
    """Check for manual seat check requests and execute them."""
    # '_' is a single-character wildcard in LIKE — escape it so this matches
    # only the literal __CHECK_SEATS_ marker, not arbitrary log messages.
    rows = conn.execute(
        "SELECT id, message FROM worker_logs WHERE message LIKE '\\_\\_CHECK\\_SEATS\\_%' ESCAPE '\\' "
        "ORDER BY created_at DESC LIMIT 5"
    ).fetchall()
    for row in rows:
        conn.execute("DELETE FROM worker_logs WHERE id = ?", (row["id"],))
        conn.commit()
        # Extract flight_id from marker: __CHECK_SEATS_{flight_id}__
        marker = row["message"]
        flight_id = marker.replace("__CHECK_SEATS_", "").replace("__", "")
        if flight_id:
            add_log(conn, f"Manual seat check requested for flight {flight_id}", "info")
            attempt_seat_upgrades(conn, force_flight_id=flight_id)


def process_test_notifications(conn: sqlite3.Connection) -> None:
    """Send test messages the dashboard asked for and log each service's result.

    '__TEST_NOTIFICATION__' tests every service; '__TEST_NOTIFICATION__:<id>'
    tests one.
    """
    rows = conn.execute(
        "SELECT id, message FROM worker_logs WHERE message LIKE '__TEST_NOTIFICATION__%' "
        "ORDER BY created_at DESC LIMIT 5"
    ).fetchall()
    if not rows:
        return
    targets: set[str | None] = set()
    for row in rows:
        conn.execute("DELETE FROM worker_logs WHERE id = ?", (row["id"],))
        _, _, config_id = row["message"].partition(":")
        targets.add(config_id or None)
    conn.commit()
    if None in targets:
        targets = {None}
    from notifications import notify_test

    for config_id in targets:
        try:
            results = notify_test(config_id)
        except Exception as e:
            add_log(conn, f"Test notification failed: {e}", "error")
            continue
        if not results:
            add_log(conn, "Test notification: no active notification services", "warning")
        for r in results:
            if r["ok"]:
                add_log(conn, f"Test notification delivered to {r['label']}", "info")
            else:
                add_log(conn, f"Test notification to {r['label']} failed: {r['error']}", "error")


def run_daily_cleanup(conn: sqlite3.Connection) -> None:
    """Run daily data retention cleanup to prevent unbounded storage growth."""
    global last_cleanup_time

    if time.time() - last_cleanup_time < CLEANUP_INTERVAL:
        return

    logger.info("Running daily data cleanup")
    add_log(conn, "Running daily data cleanup", "info")

    # Nightly database backup (data/backups, last 14 days)
    try:
        path = backup_database(conn)
        if path:
            add_log(conn, f"Database backed up to {path}", "info")
    except Exception as e:
        logger.error("Database backup failed: %s", e)
        add_log(conn, f"Database backup failed: {e}", "error")

    counts = cleanup_old_data(conn)
    total = sum(counts.values())
    if total > 0:
        add_log(conn, f"Cleaned up {total} old records: {dict(counts)}", "info")
        logger.info("Data cleanup removed %d records: %s", total, counts)

    # File system cleanup - delete old capture directories linked to DB records
    import shutil
    stale_dirs = get_stale_capture_dirs(conn)
    removed_dirs = 0
    for capture_dir in stale_dirs:
        try:
            if os.path.isdir(capture_dir):
                shutil.rmtree(capture_dir)
                removed_dirs += 1
        except Exception as e:
            logger.warning("Failed to remove capture dir %s: %s", capture_dir, e)

    # Filesystem sweep: delete ANY capture files older than 5 days
    # This catches files from repeated seat upgrade attempts on active flights
    # that aren't yet linked to "old" DB records
    captures_base = CAPTURES_DIR
    cutoff = time.time() - (5 * 24 * 3600)
    removed_files = 0
    removed_empty = 0
    if os.path.isdir(captures_base):
        for dirpath, dirnames, filenames in os.walk(captures_base, topdown=False):
            for fname in filenames:
                fpath = os.path.join(dirpath, fname)
                try:
                    if os.path.getmtime(fpath) < cutoff:
                        os.remove(fpath)
                        removed_files += 1
                except Exception:
                    pass
            # Remove empty directories after deleting files
            try:
                if dirpath != captures_base and not os.listdir(dirpath):
                    os.rmdir(dirpath)
                    removed_empty += 1
            except Exception:
                pass

    cleanup_msg = []
    if removed_dirs:
        cleanup_msg.append(f"{removed_dirs} stale capture dirs")
    if removed_files:
        cleanup_msg.append(f"{removed_files} files older than 5 days")
    if removed_empty:
        cleanup_msg.append(f"{removed_empty} empty dirs")
    if cleanup_msg:
        msg = f"File cleanup: {', '.join(cleanup_msg)}"
        add_log(conn, msg, "info")
        logger.info(msg)

    last_cleanup_time = time.time()


def run_safety_net(conn: sqlite3.Connection) -> None:
    import safety_net
    from notifications import send_notification

    for step in (
        lambda: safety_net.run_readiness_checks(conn, browser_session, active_handlers, send_notification, add_log),
        lambda: safety_net.check_missed_checkins(conn, send_notification, add_log),
    ):
        try:
            step()
        except Exception as e:
            logger.exception("Safety net check failed: %s", e)
            add_log(conn, f"Safety net check failed: {e}", "error")


def cleanup_handlers() -> None:
    """Remove handlers for flights that are no longer pending."""
    conn = get_db()
    try:
        for flight_id in list(active_handlers.keys()):
            row = conn.execute(
                "SELECT checkin_status FROM flights WHERE id = ?", (flight_id,)
            ).fetchone()
            if not row or row["checkin_status"] in ("success", "failed"):
                handler = active_handlers.pop(flight_id, None)
                if handler:
                    handler.stop_check_in()
            elif row["checkin_status"] in ("pending", "scheduled") and not active_handlers[flight_id].is_alive():
                # The handler's thread died without recording a result. Drop it
                # so schedule_pending_flights schedules the check-in again;
                # otherwise this flight would silently never be checked in.
                active_handlers.pop(flight_id, None)
                logger.warning("Check-in thread for flight %s stopped unexpectedly; rescheduling", flight_id)
                add_log(conn, "Check-in thread stopped unexpectedly; rescheduling", "warning", flight_id)
    finally:
        conn.close()


def main_loop() -> None:
    """Main worker loop - polls database and manages check-ins."""
    global browser_session

    logger.info("Worker started")
    conn = get_db()
    add_log(conn, "Worker started", "info")

    # Recover flights stuck in 'checking_in' from a previous crash/restart —
    # they would otherwise never be rescheduled.
    recovered = recover_stuck_checkins(conn)
    if recovered:
        add_log(conn, f"Recovered {recovered} flight(s) stuck in checking_in after restart", "warning")

    # Heartbeat thread: lets watchdog.py (a separate process) notice if this
    # worker dies, and pings HEALTHCHECK_PING_URL if one is configured.
    import safety_net
    safety_net.start_heartbeat(get_db, shutdown_event)

    # Start persistent browser session
    browser_session = BrowserSession()
    try:
        browser_session.start()
        add_log(conn, f"Browser session started ({browser_session.mode_description()})", "info")
    except Exception as e:
        logger.error("Failed to start browser session: %s", e)
        add_log(conn, f"Failed to start browser session: {e}", "error")
    finally:
        conn.close()

    while not shutdown_event.is_set():
        conn = None
        try:
            conn = get_db()
            safety_net.set_state(conn, "worker_loop", "ok")

            # Each step runs on its own: one failing (a Southwest login
            # hiccup, a fare-check error) must not skip the others, above all
            # scheduling check-ins and the safety net.
            for name, step in (
                # API keys and LM Studio settings saved on the dashboard
                ("saved settings", lambda: apply_app_settings(conn)),
                ("password encryption", lambda: encrypt_stored_passwords(conn)),
                ("browser session", browser_session.ensure_alive),
                ("accounts", lambda: process_accounts(conn)),
                ("manual reservations", lambda: process_manual_reservations(conn)),
                # Drop dead check-in threads before scheduling so they're re-queued
                ("handler cleanup", cleanup_handlers),
                ("check-in scheduling", lambda: schedule_pending_flights(conn)),
                # Confirm upcoming check-ins will work; alert on missed ones
                ("safety net", lambda: run_safety_net(conn)),
                ("fare checks", lambda: check_fares(conn)),
                ("fare watches", lambda: check_named_fare_watches(conn)),
                ("Southwest fare watches", lambda: check_southwest_watches(conn)),
                # Flight status (AeroDataBox) and other-airline trip prices (Google Flights)
                ("flight status", lambda: run_flight_status(conn)),
                ("trip prices", lambda: run_trip_prices(conn)),
                # Miles and status from airline websites, in a background thread
                ("airline account syncs", lambda: run_loyalty_syncs(conn)),
                # Seat upgrades for A-List accounts (48h before departure)
                ("seat upgrades", lambda: attempt_seat_upgrades(conn)),
                ("manual seat checks", lambda: process_manual_seat_checks(conn)),
                ("connection tests", lambda: process_connection_tests(conn)),
                ("test notifications", lambda: process_test_notifications(conn)),
                ("daily cleanup", lambda: run_daily_cleanup(conn)),
            ):
                if shutdown_event.is_set():
                    break
                try:
                    step()
                except Exception as e:
                    logger.exception("Error in %s: %s", name, e)
                    try:
                        add_log(conn, f"Worker error in {name}: {e}", "error")
                    except Exception:
                        pass
        except Exception as e:
            logger.exception("Error in main loop: %s", e)
            try:
                err_conn = get_db()
                add_log(err_conn, f"Worker error: {e}", "error")
                err_conn.close()
            except Exception:
                pass
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

        # Wait for next poll
        shutdown_event.wait(timeout=POLL_INTERVAL)

    # Shutdown
    logger.info("Worker shutting down...")
    for handler in active_handlers.values():
        handler.stop_check_in()
    if browser_session:
        browser_session.stop()


def signal_handler(signum, frame):
    logger.info("Received signal %d, shutting down...", signum)
    shutdown_event.set()


if __name__ == "__main__":
    # Route all module loggers (lib.*, __main__) to stderr so INFO-level
    # diagnostics actually reach supervisord/docker logs. Without this only
    # WARNING+ is visible, which makes missed check-ins impossible to debug.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s:%(lineno)d] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    main_loop()
