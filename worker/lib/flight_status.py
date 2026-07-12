"""Day-of-travel flight status checks.

Two providers, selected automatically:
  1. AeroDataBox (primary when AERODATABOX_API_KEY is set) — real-time status
     with delays, gate/terminal, and cancellations; strong Southwest coverage.
  2. Amadeus flight-schedule (fallback, reuses the fare-watch keys) — schedule
     changes / apparent cancellations only.

Both are browser-free and best-effort. When a flight can't be resolved the
status is recorded as 'unknown' rather than alarming the user.
"""

from __future__ import annotations

import os
import re
import time
from datetime import datetime, timedelta, timezone

import requests

from .fare_watch import AmadeusClient, FareWatchApiError
from .log import get_logger

logger = get_logger(__name__)

SIGNIFICANT_SHIFT_MIN = 15


def parse_carrier_flight(flight_number: str) -> tuple[str | None, str | None]:
    """Split a stored flight number into (carrier, number). Defaults to WN."""
    fn = (flight_number or "").replace(" ", "").upper()
    m = re.match(r"([A-Z]{0,3})0*(\d+)", fn)
    if not m:
        return None, None
    carrier = m.group(1) or "WN"
    return carrier, m.group(2)


def _parse_time(value: str | None) -> datetime | None:
    """Parse the varied ISO-ish timestamps both providers return."""
    if not value:
        return None
    v = value.strip().replace(" ", "T")
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ── AeroDataBox (RapidAPI) ───────────────────────────────────────────────

class AeroDataBoxClient:
    def __init__(self) -> None:
        self.key = os.environ.get("AERODATABOX_API_KEY", "")
        self.host = os.environ.get("AERODATABOX_HOST", "aerodatabox.p.rapidapi.com")

    @property
    def configured(self) -> bool:
        return bool(self.key)

    def get_flight(self, ident: str, date: str) -> list[dict]:
        url = f"https://{self.host}/flights/number/{ident}/{date}"
        resp = requests.get(
            url,
            params={"withAircraftImage": "false", "withLocation": "false"},
            headers={"x-rapidapi-key": self.key, "x-rapidapi-host": self.host},
            timeout=30,
        )
        if resp.status_code == 204:
            return []
        if resp.status_code >= 400:
            raise FareWatchApiError(resp.status_code, resp.text[:300])
        data = resp.json()
        if isinstance(data, dict):
            # Some responses wrap the list or return an error object.
            return data.get("flights") or []
        return data or []


def _aerodatabox_status(client: AeroDataBoxClient, carrier: str, number: str, dep_date: str, flight: dict) -> tuple[str, str]:
    data = client.get_flight(f"{carrier}{number}", dep_date)
    if not data:
        return "unavailable", "Not found in live flight data (possibly cancelled or changed)"

    dep_ap = flight.get("departure_airport")
    leg = next(
        (f for f in data if (f.get("departure") or {}).get("airport", {}).get("iata") == dep_ap),
        data[0],
    )
    st = (leg.get("status") or "").lower()
    dep = leg.get("departure") or {}
    gate = dep.get("gate")
    terminal = dep.get("terminal")
    loc_bits = []
    if terminal:
        loc_bits.append(f"Terminal {terminal}")
    if gate:
        loc_bits.append(f"Gate {gate}")
    loc = (" · " + ", ".join(loc_bits)) if loc_bits else ""

    if "cancel" in st:
        return "cancelled", "Flight cancelled" + loc
    if "divert" in st:
        return "delayed", "Diverted" + loc

    sched = _parse_time((dep.get("scheduledTime") or {}).get("utc"))
    revised = _parse_time(
        (dep.get("revisedTime") or {}).get("utc") or (dep.get("runwayTime") or {}).get("utc")
    )
    delay_min = 0
    if sched and revised:
        delay_min = (revised.timestamp() - sched.timestamp()) / 60.0

    if "delay" in st or delay_min >= SIGNIFICANT_SHIFT_MIN:
        when = ""
        if revised:
            local = (dep.get("revisedTime") or {}).get("local") or revised.isoformat()
            when = f", now {str(local)[:16]}"
        mins = f" ~{int(delay_min)} min" if delay_min >= 1 else ""
        return "delayed", f"Delayed{mins}{when}{loc}"

    return "scheduled", ("On time" + loc)


# ── Amadeus schedule (fallback) ──────────────────────────────────────────

def _scheduled_departure(resp: dict, departure_airport: str) -> str | None:
    data = resp.get("data") or []
    for flight in data:
        points = flight.get("flightPoints") or []
        candidates = [p for p in points if p.get("iataCode") == departure_airport] or points
        for p in candidates:
            timings = (p.get("departure") or {}).get("timings") or []
            for t in timings:
                if t.get("value"):
                    return t["value"]
    return None


def _amadeus_status(resp: dict, flight: dict) -> tuple[str, str]:
    data = resp.get("data") or []
    if not data:
        return "unavailable", "Not found in the airline schedule (possibly cancelled or changed)"
    sched = _parse_time(_scheduled_departure(resp, flight.get("departure_airport", "")))
    if not sched:
        return "scheduled", "On schedule"
    stored = _parse_time(flight.get("departure_time"))
    if not stored:
        return "scheduled", "On schedule"
    delta_min = abs(sched.timestamp() - stored.timestamp()) / 60.0
    if delta_min >= SIGNIFICANT_SHIFT_MIN:
        local = sched.strftime("%b %d %I:%M %p")
        return "schedule_changed", f"Departure now {local} (shifted ~{int(delta_min)} min)"
    return "scheduled", "On schedule"


# ── Shared driver ────────────────────────────────────────────────────────

def _update(conn, flight_id: str, status: str, detail: str) -> None:
    conn.execute(
        "UPDATE flights SET flight_status = ?, flight_status_detail = ?, "
        "flight_status_checked_at = ? WHERE id = ?",
        (status, detail, datetime.utcnow().isoformat(), flight_id),
    )
    conn.commit()


# States worth a push notification (once each).
ACTIONABLE = ("delayed", "cancelled", "schedule_changed", "unavailable")


def check_flight_statuses(conn, notify_fn=None) -> None:
    """Check status for flights within the travel window; notify on changes."""
    adb = AeroDataBoxClient()
    amadeus = AmadeusClient()
    if adb.configured:
        provider = "aerodatabox"
    elif amadeus.configured:
        provider = "amadeus"
    else:
        return  # no status provider configured

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
        # Southwest flights store the carrier implicitly; a set airline wins.
        if flight.get("airline"):
            c2, _ = parse_carrier_flight(flight["airline"])
            carrier = (flight["airline"][:3].upper() if len(flight["airline"]) <= 3 else carrier) or carrier
        dep_date = str(flight.get("departure_time", ""))[:10]
        if not dep_date:
            continue

        try:
            if provider == "aerodatabox":
                status, detail = _aerodatabox_status(adb, carrier, number, dep_date, flight)
            else:
                resp = amadeus.get(
                    "/v2/schedule/flights",
                    {"carrierCode": carrier, "flightNumber": number, "scheduledDepartureDate": dep_date},
                )
                status, detail = _amadeus_status(resp, flight)
        except FareWatchApiError as err:
            _update(conn, flight["id"], "unknown", f"Status unavailable ({err.status_code})")
            time.sleep(0.3)
            continue
        except Exception as err:  # noqa: BLE001
            logger.warning("Flight status check failed for %s%s: %s", carrier, number, err)
            continue

        _update(conn, flight["id"], status, detail)

        if notify_fn and status in ACTIONABLE and flight.get("flight_status_notified") != status:
            route = f"{flight.get('departure_airport')}->{flight.get('destination_airport')}"
            titles = {
                "delayed": "Flight delayed",
                "cancelled": "Flight cancelled",
                "schedule_changed": "Flight schedule changed",
                "unavailable": "Flight status alert",
            }
            title = titles.get(status, "Flight status alert")
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

        time.sleep(0.3)  # stay under free-tier rate limits
