"""Safety net for the one failure this app can't recover from: a missed check-in.

Three layers, all run from the worker's main loop except the watchdog:

1. Readiness checks. Starting CHECKIN_READINESS_HOURS (default 3) before each
   check-in and every 30 minutes after that, confirm the check-in thread is
   queued, the Chrome session is up, and Southwest still returns the
   reservation. Problems alert the traveler (after two failures in a row, or
   right away when check-in is under 45 minutes out) and an all-clear follows
   when it recovers.
2. Missed check-in. If check-in time passed 15 minutes ago and the flight
   still isn't checked in, alert right away so it can be done by hand.
3. Heartbeats. The worker records that it's alive (every minute, from a
   background thread) and that its main loop is making progress. watchdog.py,
   a separate process, alerts when either goes stale, and HEALTHCHECK_PING_URL
   (e.g. a free healthchecks.io check) covers the whole machine being down.
"""

from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Callable

from lib.log import get_logger

logger = get_logger(__name__)

VIEW_RESERVATION_URL = "mobile-air-booking/v1/mobile-air-booking/page/view-reservation/"
RECHECK_MINUTES = 30
URGENT_MINUTES = 45
MISSED_GRACE_MINUTES = 15
HEARTBEAT_SECONDS = 60
PING_EVERY_SECONDS = 300

NotifyFn = Callable[..., object]


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace(" ", "T"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _fmt_local(dt: datetime) -> str:
    """Check-in time in the Mac's local time zone, e.g. 'Tue 7:05 AM'."""
    return dt.astimezone().strftime("%a %-I:%M %p")


def readiness_hours() -> float:
    try:
        return max(float(os.environ.get("CHECKIN_READINESS_HOURS", "3")), 0.5)
    except ValueError:
        return 3.0


# ── State (heartbeats) ───────────────────────────────────────────────────


def set_state(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, value),
    )
    conn.commit()


def get_state(conn, key: str) -> tuple[str | None, datetime | None]:
    row = conn.execute(
        "SELECT value, updated_at FROM system_state WHERE key = ?", (key,)
    ).fetchone()
    if not row:
        return None, None
    return row["value"], _parse_utc(row["updated_at"])


def start_heartbeat(conn_factory: Callable, stop_event: threading.Event) -> threading.Thread:
    """Record 'worker_alive' every minute and ping HEALTHCHECK_PING_URL every 5."""
    ping_url = os.environ.get("HEALTHCHECK_PING_URL", "").strip()

    def beat() -> None:
        last_ping = 0.0
        while not stop_event.is_set():
            try:
                conn = conn_factory()
                try:
                    set_state(conn, "worker_alive", str(os.getpid()))
                finally:
                    conn.close()
            except Exception as err:  # noqa: BLE001 - a missed beat must not kill the thread
                logger.warning("Heartbeat write failed: %s", err)
            if ping_url and time.monotonic() - last_ping >= PING_EVERY_SECONDS:
                last_ping = time.monotonic()
                try:
                    import requests

                    requests.get(ping_url, timeout=10)
                except Exception as err:  # noqa: BLE001
                    logger.warning("Healthcheck ping failed: %s", err)
            stop_event.wait(HEARTBEAT_SECONDS)

    thread = threading.Thread(target=beat, name="heartbeat", daemon=True)
    thread.start()
    return thread


# ── Readiness checks ─────────────────────────────────────────────────────


def _flights_in_window(conn, now: datetime) -> list[dict]:
    """Pending/scheduled flights whose check-in opens within the readiness window."""
    window_end = now + timedelta(hours=readiness_hours())
    rows = conn.execute(
        "SELECT f.*, r.confirmation_number, r.first_name, r.last_name "
        "FROM flights f JOIN reservations r ON r.id = f.reservation_id "
        "WHERE f.checkin_status IN ('pending', 'scheduled') AND r.is_active = 1"
    ).fetchall()
    due = []
    for row in rows:
        flight = dict(row)
        departure = _parse_utc(flight["departure_time"])
        if departure is None:
            continue
        checkin_at = departure - timedelta(days=1)
        if not (now <= checkin_at <= window_end):
            continue
        last = _parse_utc(flight.get("readiness_checked_at"))
        if last and now - last < timedelta(minutes=RECHECK_MINUTES):
            continue
        flight["_checkin_at"] = checkin_at
        due.append(flight)
    return due


def check_flight_readiness(flight: dict, browser_session, handler) -> list[str]:
    """Return a list of plain-English problems (empty means ready)."""
    problems = []
    if handler is None or not handler.is_alive():
        problems.append("the check-in isn't queued yet (the app will try to queue it again)")

    driver = getattr(browser_session, "_driver", None) if browser_session else None
    if browser_session is None or driver is None or not getattr(browser_session, "headers", None):
        problems.append("the Chrome session that talks to Southwest isn't running")
        return problems

    info = {
        "firstName": flight["first_name"],
        "lastName": flight["last_name"],
        "recordLocator": flight["confirmation_number"],
    }
    try:
        response = browser_session.make_request(
            "POST", VIEW_RESERVATION_URL + flight["confirmation_number"], {}, info, max_attempts=2
        )
        bounds = (response or {}).get("viewReservationViewPage", {}).get("bounds") or []
        if not bounds:
            problems.append(
                "Southwest returned the reservation with no flights on it (changed or cancelled?)"
            )
    except Exception as err:  # noqa: BLE001 - any failure here is exactly what we report
        problems.append(f"Southwest didn't return the reservation ({str(err)[:150]})")
    return problems


def run_readiness_checks(
    conn,
    browser_session,
    active_handlers: dict,
    notify: NotifyFn,
    add_log: Callable,
    now: datetime | None = None,
) -> int:
    """Check every flight whose check-in is coming up. Returns how many were checked."""
    now = now or _utcnow()
    flights = _flights_in_window(conn, now)
    for flight in flights:
        flight_id = flight["id"]
        problems = check_flight_readiness(flight, browser_session, active_handlers.get(flight_id))
        failures = (flight.get("readiness_failures") or 0) + 1 if problems else 0
        status = "problem" if problems else "ready"
        detail = (
            "; ".join(problems)
            if problems
            else "Check-in is queued and Southwest has the reservation."
        )
        conn.execute(
            "UPDATE flights SET readiness_status = ?, readiness_detail = ?, "
            "readiness_checked_at = ?, readiness_failures = ? WHERE id = ?",
            (status, detail, now.strftime("%Y-%m-%d %H:%M:%S"), failures, flight_id),
        )
        conn.commit()

        route = f"{flight['departure_airport']} -> {flight['destination_airport']}"
        conf = flight["confirmation_number"]
        checkin_at = flight["_checkin_at"]
        minutes_left = (checkin_at - now).total_seconds() / 60
        add_log(
            conn,
            f"Check-in readiness for {conf} {route}: {status}. {detail}",
            "warning" if problems else "info",
            flight_id,
        )

        if (
            problems
            and not flight.get("readiness_alerted")
            and (failures >= 2 or minutes_left <= URGENT_MINUTES)
        ):
            notify(
                f"Check-in at risk: {conf}",
                f"Check-in for {flight['first_name']} {flight['last_name']} ({route}) opens "
                f"{_fmt_local(checkin_at)}, and the app found a problem: {detail}.\n"
                "It keeps retrying. If this isn't cleared before then, check in by hand "
                "in the Southwest app or at southwest.com.",
                "critical",
                flight_id=flight_id,
            )
            conn.execute("UPDATE flights SET readiness_alerted = 1 WHERE id = ?", (flight_id,))
            conn.commit()
        elif not problems and flight.get("readiness_alerted"):
            notify(
                f"Check-in back on track: {conf}",
                f"The problem with {conf} ({route}) cleared. Check-in is queued for {_fmt_local(checkin_at)}.",
                "critical",
                flight_id=flight_id,
            )
            conn.execute("UPDATE flights SET readiness_alerted = 0 WHERE id = ?", (flight_id,))
            conn.commit()
    return len(flights)


# ── Missed check-ins ─────────────────────────────────────────────────────


def check_missed_checkins(
    conn, notify: NotifyFn, add_log: Callable, now: datetime | None = None
) -> int:
    """Alert once for each flight whose check-in time passed without a check-in."""
    now = now or _utcnow()
    rows = conn.execute(
        "SELECT f.*, r.confirmation_number, r.first_name, r.last_name "
        "FROM flights f JOIN reservations r ON r.id = f.reservation_id "
        "WHERE f.checkin_status IN ('pending', 'scheduled', 'checking_in') "
        "AND COALESCE(f.missed_alerted, 0) = 0"
    ).fetchall()
    alerted = 0
    for row in rows:
        flight = dict(row)
        departure = _parse_utc(flight["departure_time"])
        if departure is None or departure <= now:
            continue
        checkin_at = departure - timedelta(days=1)
        # A flight added after check-in opened is checked in right away;
        # count the grace period from when the app learned about it.
        known_since = _parse_utc(flight.get("created_at")) or checkin_at
        if now < max(checkin_at, known_since) + timedelta(minutes=MISSED_GRACE_MINUTES):
            continue
        conf = flight["confirmation_number"]
        route = f"{flight['departure_airport']} -> {flight['destination_airport']}"
        state = (
            "is still in progress"
            if flight["checkin_status"] == "checking_in"
            else "hasn't happened"
        )
        notify(
            f"Check in now: {conf}",
            f"Check-in for {flight['first_name']} {flight['last_name']} ({route}) opened "
            f"{_fmt_local(checkin_at)} but {state}. Check in by hand now in the Southwest app "
            "or at southwest.com to keep your boarding position.",
            "critical",
            flight_id=flight["id"],
        )
        conn.execute("UPDATE flights SET missed_alerted = 1 WHERE id = ?", (flight["id"],))
        conn.commit()
        add_log(conn, f"Missed check-in alert sent for {conf} ({state})", "error", flight["id"])
        alerted += 1
    return alerted
