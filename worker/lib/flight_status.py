"""Day-of-travel flight status checks via the Amadeus flight-schedule API.

Best-effort and browser-free. Reuses the same free Amadeus keys as fare
watches. For each upcoming flight (within ~36h of departure) it looks up the
airline's published schedule and detects schedule changes / apparent
cancellations, notifying the flight's owner on a material change.

Coverage note: Amadeus schedule data is strong for most carriers but can be
spotty for Southwest specifically; when a flight can't be resolved the status
is recorded as 'unknown' rather than alarming the user.
"""

from __future__ import annotations

import os
import re
import time
from datetime import datetime, timedelta, timezone

from .fare_watch import AmadeusClient, FareWatchApiError
from .log import get_logger

logger = get_logger(__name__)

# How far a schedule shift must be (minutes) before we treat it as a change.
SIGNIFICANT_SHIFT_MIN = 15


def parse_carrier_flight(flight_number: str) -> tuple[str | None, str | None]:
    """Split a stored flight number into (carrier, number). Defaults to WN."""
    fn = (flight_number or "").replace(" ", "").upper()
    m = re.match(r"([A-Z]{0,3})0*(\d+)", fn)
    if not m:
        return None, None
    carrier = m.group(1) or "WN"
    return carrier, m.group(2)


def _scheduled_departure(resp: dict, departure_airport: str) -> str | None:
    """Pull the scheduled departure timestamp from an Amadeus schedule response."""
    data = resp.get("data") or []
    for flight in data:
        points = flight.get("flightPoints") or []
        # Prefer the point matching our departure airport; else the first with a departure.
        candidates = [p for p in points if p.get("iataCode") == departure_airport] or points
        for p in candidates:
            dep = p.get("departure") or {}
            timings = dep.get("timings") or []
            for t in timings:
                val = t.get("value")
                if val:
                    return val  # ISO 8601 with offset, e.g. 2026-07-17T08:05:00-05:00
    return None


def _classify(resp: dict, flight: dict) -> tuple[str, str]:
    """Return (status, human detail) for a flight given the schedule response."""
    data = resp.get("data") or []
    if not data:
        # The airline schedule no longer lists this flight for the date.
        return "unavailable", "Not found in the airline schedule (possibly cancelled or changed)"

    sched = _scheduled_departure(resp, flight.get("departure_airport", ""))
    if not sched:
        return "scheduled", "On schedule"

    try:
        sched_dt = datetime.fromisoformat(sched)
    except ValueError:
        return "scheduled", "On schedule"

    stored = flight.get("departure_time", "")
    try:
        stored_dt = datetime.fromisoformat(stored if not stored.endswith("Z") else stored[:-1] + "+00:00")
    except ValueError:
        return "scheduled", "On schedule"
    if stored_dt.tzinfo is None:
        stored_dt = stored_dt.replace(tzinfo=timezone.utc)

    delta_min = abs(sched_dt.timestamp() - stored_dt.timestamp()) / 60.0
    if delta_min >= SIGNIFICANT_SHIFT_MIN:
        local = sched_dt.strftime("%b %d %I:%M %p")
        return "schedule_changed", f"Departure now {local} (shifted ~{int(delta_min)} min)"
    return "scheduled", "On schedule"


def _update(conn, flight_id: str, status: str, detail: str) -> None:
    conn.execute(
        "UPDATE flights SET flight_status = ?, flight_status_detail = ?, "
        "flight_status_checked_at = ? WHERE id = ?",
        (status, detail, datetime.utcnow().isoformat(), flight_id),
    )
    conn.commit()


def check_flight_statuses(conn, notify_fn=None) -> None:
    """Check status for flights within the travel window; notify on changes."""
    client = AmadeusClient()
    if not client.configured:
        return  # feature shares Amadeus keys with fare watches; stay silent if unset

    interval_min = float(os.environ.get("FLIGHT_STATUS_INTERVAL_MINUTES", "60"))
    now = datetime.utcnow()
    horizon = (now + timedelta(hours=36)).isoformat()
    cutoff = (now - timedelta(minutes=interval_min)).isoformat()

    rows = conn.execute(
        "SELECT f.*, r.owner_user_id AS owner_user_id, r.confirmation_number AS confirmation_number "
        "FROM flights f JOIN reservations r ON r.id = f.reservation_id "
        "WHERE f.departure_time > ? AND f.departure_time <= ? "
        "AND (f.flight_status_checked_at IS NULL OR f.flight_status_checked_at < ?) "
        "ORDER BY f.departure_time ASC",
        (now.isoformat(), horizon, cutoff),
    ).fetchall()

    for row in rows:
        flight = dict(row)
        carrier, number = parse_carrier_flight(flight.get("flight_number"))
        if not number:
            continue
        dep_date = str(flight.get("departure_time", ""))[:10]
        if not dep_date:
            continue
        try:
            resp = client.get(
                "/v2/schedule/flights",
                {
                    "carrierCode": carrier,
                    "flightNumber": number,
                    "scheduledDepartureDate": dep_date,
                },
            )
        except FareWatchApiError as err:
            # 400/404 usually means "not covered" — record softly, don't alarm.
            _update(conn, flight["id"], "unknown", f"Status unavailable ({err.status_code})")
            time.sleep(0.3)
            continue
        except Exception as err:  # noqa: BLE001
            logger.warning("Flight status check failed for %s%s: %s", carrier, number, err)
            continue

        status, detail = _classify(resp, flight)
        _update(conn, flight["id"], status, detail)

        # Notify the owner once per distinct actionable state.
        actionable = status in ("schedule_changed", "unavailable")
        already = flight.get("flight_status_notified")
        if notify_fn and actionable and already != status:
            route = f"{flight.get('departure_airport')}->{flight.get('destination_airport')}"
            title = (
                "Flight schedule changed"
                if status == "schedule_changed"
                else "Flight status alert"
            )
            message = f"{route} ({flight.get('confirmation_number')}): {detail}"
            try:
                notify_fn(title, message, flight.get("owner_user_id"))
                conn.execute(
                    "UPDATE flights SET flight_status_notified = ? WHERE id = ?",
                    (status, flight["id"]),
                )
                conn.commit()
            except Exception as err:  # noqa: BLE001
                logger.error("Flight status notification failed: %s", err)

        time.sleep(0.3)  # stay under the free-tier rate limit
