"""Live flight status alerts (delays, gate changes, cancellations) from AeroDataBox.

Covers Southwest flights and trips on other airlines. A flight is looked up
on a schedule that gets tighter as departure nears, so the free plan lasts:
  * once about 24 hours out
  * every 3 hours from 12 hours out
  * every 30 minutes from 3 hours out until it departs (or 1 hour after the
    scheduled time, whichever comes first)

Alerts go out when the departure time moves by DELAY_ALERT_MINUTES or more
since the last alert, the gate or terminal changes, or the flight is
cancelled or diverted.

Settings (environment):
    AERODATABOX_API_KEY         RapidAPI key subscribed to AeroDataBox
                                (free "Basic" plan on rapidapi.com)
    FLIGHT_STATUS_DELAY_MINUTES alert threshold for time changes (default 15)
    FLIGHT_STATUS_MONTHLY_LIMIT lookups per month (default 550)
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import requests

from .log import get_logger

logger = get_logger(__name__)

HOST = "aerodatabox.p.rapidapi.com"
BAD_STATUSES = {"Canceled", "CanceledUncertain", "Diverted"}
DONE_STATUSES = {"Departed", "EnRoute", "Approaching", "Arrived", "Canceled", "Diverted"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def api_key() -> str:
    return os.environ.get("AERODATABOX_API_KEY", "").strip()


def configured() -> bool:
    return bool(api_key())


def delay_threshold() -> int:
    try:
        return int(os.environ.get("FLIGHT_STATUS_DELAY_MINUTES", "15"))
    except ValueError:
        return 15


def monthly_limit() -> int:
    try:
        return int(os.environ.get("FLIGHT_STATUS_MONTHLY_LIMIT", "550"))
    except ValueError:
        return 550


def _usage_key() -> str:
    return f"aerodatabox_lookups:{_utcnow().strftime('%Y-%m')}"


def lookups_used(conn) -> int:  # noqa: ANN001
    row = conn.execute("SELECT value FROM system_state WHERE key = ?", (_usage_key(),)).fetchone()
    try:
        return int(row[0]) if row else 0
    except (TypeError, ValueError):
        return 0


def _count_lookup(conn) -> None:  # noqa: ANN001
    conn.execute(
        "INSERT INTO system_state (key, value, updated_at) VALUES (?, '1', datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1, "
        "updated_at = excluded.updated_at",
        (_usage_key(),),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Parsing (pure, unit-tested)
# ---------------------------------------------------------------------------


def parse_time(value: Any) -> datetime | None:
    """AeroDataBox times look like {"utc": "2026-12-04 14:15Z", "local": "..."}."""
    if isinstance(value, dict):
        value = value.get("utc")
    if not value or not isinstance(value, str):
        return None
    text = value.strip().replace("Z", "+00:00").replace(" ", "T", 1)
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def pick_flight(
    results: list[dict], departure_airport: str, scheduled_utc: datetime | None
) -> dict | None:
    """The result leg leaving our airport (a flight number can fly several legs a day)."""
    legs = [r for r in results or [] if isinstance(r, dict)]
    ours = [
        r
        for r in legs
        if ((r.get("departure") or {}).get("airport") or {}).get("iata", "").upper()
        == departure_airport.upper()
    ]
    if not ours:
        return None
    if scheduled_utc is None or len(ours) == 1:
        return ours[0]

    def distance(r: dict) -> float:
        t = parse_time((r.get("departure") or {}).get("scheduledTime"))
        return abs((t - scheduled_utc).total_seconds()) if t else float("inf")

    return min(ours, key=distance)


def summarize(flight: dict) -> dict:
    """The parts we track: status, best departure/arrival estimate, gate, terminal."""
    dep = flight.get("departure") or {}
    arr = flight.get("arrival") or {}

    def best(move: dict) -> datetime | None:
        for key in ("runwayTime", "revisedTime", "predictedTime", "scheduledTime"):
            t = parse_time(move.get(key))
            if t:
                return t
        return None

    def iso(t: datetime | None) -> str | None:
        return t.isoformat() if t else None

    return {
        "status": flight.get("status") or "Unknown",
        "scheduled_departure": iso(parse_time(dep.get("scheduledTime"))),
        "departure": iso(best(dep)),
        "arrival": iso(best(arr)),
        "gate": str(dep.get("gate") or ""),
        "terminal": str(dep.get("terminal") or ""),
        "arrival_gate": str(arr.get("gate") or ""),
        "baggage": str(arr.get("baggageBelt") or ""),
    }


def _minutes(a: str | None, b: str | None) -> int | None:
    if not a or not b:
        return None
    return round((datetime.fromisoformat(a) - datetime.fromisoformat(b)).total_seconds() / 60)


def changes(previous: dict | None, current: dict, threshold: int) -> list[str]:
    """What's worth an alert between the last alerted state and now."""
    out: list[str] = []
    prev = previous or {}
    status = current["status"]
    if status in BAD_STATUSES and prev.get("status") != status:
        out.append("CANCELLED" if status.startswith("Cancel") else "DIVERTED")
    base = prev.get("departure") or current.get("scheduled_departure")
    moved = _minutes(current.get("departure"), base)
    if moved is not None and abs(moved) >= threshold and status not in BAD_STATUSES:
        late = _minutes(current.get("departure"), current.get("scheduled_departure")) or 0
        if late > 0:
            out.append(f"now departs {late} min late")
        elif late < 0:
            out.append(f"now departs {-late} min early")
        else:
            out.append("now departs on time")
    if current.get("gate") and prev.get("gate") and current["gate"] != prev["gate"]:
        out.append(f"gate changed {prev['gate']} → {current['gate']}")
    elif current.get("gate") and not prev.get("gate"):
        out.append(f"gate {current['gate']}")
    if current.get("terminal") and prev.get("terminal") and current["terminal"] != prev["terminal"]:
        out.append(f"terminal changed {prev['terminal']} → {current['terminal']}")
    return out


def next_check(departure: datetime, now: datetime, status: str = "") -> datetime | None:
    """When to look this flight up next (None = stop)."""
    if status in DONE_STATUSES:
        return None
    until = (departure - now).total_seconds() / 3600
    if until < -1:
        return None
    if until <= 3:
        return now + timedelta(minutes=30)
    if until <= 12:
        return now + timedelta(hours=3)
    if until <= 26:
        return now + timedelta(hours=max(1.0, until - 12))
    return departure - timedelta(hours=24)


# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------


def lookup(conn, flight_number: str, local_date: str, session: Any = requests) -> list[dict]:  # noqa: ANN001
    if lookups_used(conn) >= monthly_limit():
        raise RuntimeError(f"Monthly flight status limit of {monthly_limit()} lookups reached")
    _count_lookup(conn)
    resp = session.get(
        f"https://{HOST}/flights/number/{flight_number.replace(' ', '')}/{local_date}",
        headers={"X-RapidAPI-Key": api_key(), "X-RapidAPI-Host": HOST},
        params={"withAircraftImage": "false", "withLocation": "false"},
        timeout=30,
    )
    if resp.status_code == 204:
        return []
    if resp.status_code != 200:
        raise RuntimeError(f"AeroDataBox {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    return data if isinstance(data, list) else []


def tracked_flights(conn) -> list[dict]:  # noqa: ANN001
    """Southwest flights and other-airline segments departing from 1 hour ago to 30 days out."""
    now = _utcnow()
    lo = (now - timedelta(hours=1)).isoformat()
    hi = (now + timedelta(days=30)).isoformat()
    rows = conn.execute(
        "SELECT 'flight' AS kind, f.id, 'WN' AS airline_code, f.flight_number, "
        "f.departure_airport, "
        "f.destination_airport, f.departure_time, r.confirmation_number, "
        "r.first_name || ' ' || r.last_name AS traveler, f.id AS flight_id "
        "FROM flights f JOIN reservations r ON r.id = f.reservation_id "
        "WHERE r.is_active = 1 AND f.departure_time BETWEEN ? AND ? "
        "UNION ALL "
        "SELECT 'segment', s.id, s.airline_code, s.flight_number, s.departure_airport, "
        "s.destination_airport, s.departure_time, t.confirmation_number, t.traveler, NULL "
        "FROM trip_segments s JOIN trips t ON t.id = s.trip_id "
        "WHERE t.status = 'booked' AND s.departure_time BETWEEN ? AND ?",
        (lo, hi, lo, hi),
    ).fetchall()
    return [dict(r) for r in rows if r["flight_number"]]


def _airport_local_date(airport: str, departure_iso: str) -> str:
    import zoneinfo  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    dep = datetime.fromisoformat(departure_iso.replace("Z", "+00:00"))
    if dep.tzinfo is None:
        dep = dep.replace(tzinfo=timezone.utc)
    try:
        zones = json.loads(
            (Path(__file__).resolve().parents[1] / "utils" / "airport_timezones.json").read_text()
        )
        return dep.astimezone(zoneinfo.ZoneInfo(zones[airport.upper()])).date().isoformat()
    except Exception:  # noqa: BLE001 - unknown airport: UTC date is usually right
        return dep.date().isoformat()


def check_statuses(
    conn,  # noqa: ANN001 - sqlite connection
    notify: Callable[..., Any],
    session: Any = requests,
    now: datetime | None = None,
) -> int:
    """Look up flights that are due. Returns the number of lookups."""
    if not configured():
        return 0
    now = now or _utcnow()
    threshold = delay_threshold()
    done = 0
    for flight in tracked_flights(conn):
        key = f"flight_status:{flight['kind']}:{flight['id']}"
        row = conn.execute("SELECT value FROM system_state WHERE key = ?", (key,)).fetchone()
        state = json.loads(row[0]) if row and row[0] else {}
        departure = datetime.fromisoformat(flight["departure_time"].replace("Z", "+00:00"))
        if departure.tzinfo:
            departure = departure.astimezone(timezone.utc).replace(tzinfo=None)
        due = state.get("next_check")
        if state.get("stopped") or (due and datetime.fromisoformat(due) > now):
            continue
        if not due and departure - now > timedelta(hours=26):
            # First look about a day out
            state["next_check"] = (departure - timedelta(hours=24)).isoformat()
            _save(conn, key, state)
            continue

        number = f"{flight['airline_code'] or ''}{flight['flight_number']}".replace(" ", "")
        try:
            results = lookup(
                conn,
                number,
                _airport_local_date(flight["departure_airport"], flight["departure_time"]),
                session,
            )
            done += 1
        except Exception as err:  # noqa: BLE001
            logger.warning("Flight status for %s failed: %s", number, err)
            if "limit" in str(err):
                break
            state["next_check"] = (now + timedelta(hours=1)).isoformat()
            _save(conn, key, state)
            continue

        match = pick_flight(results, flight["departure_airport"], departure)
        if not match:
            state["next_check"] = (now + timedelta(hours=3)).isoformat()
            state["note"] = "not found"
            _save(conn, key, state)
            continue
        current = summarize(match)
        found = changes(state.get("alerted"), current, threshold)
        if found and state.get("alerted") is None and found == [f"gate {current['gate']}"]:
            found = []  # first gate assignment alone isn't news far from departure
        if found:
            urgent = current["status"] in BAD_STATUSES
            notify(
                f"{number} {flight['departure_airport']}->{flight['destination_airport']}: "
                + ("CANCELLED" if current["status"].startswith("Cancel") else "update"),
                "; ".join(found).capitalize()
                + (
                    f". Confirmation {flight['confirmation_number']}"
                    if flight.get("confirmation_number")
                    else ""
                )
                + (
                    f" ({flight['traveler'].strip()})"
                    if (flight.get("traveler") or "").strip()
                    else ""
                ),
                "critical" if urgent else "important",
                **({"flight_id": flight["flight_id"]} if flight.get("flight_id") else {}),
            )
            state["alerted"] = current
        elif state.get("alerted") is None:
            state["alerted"] = current  # baseline for future comparisons
        state["last"] = current
        state["checked_at"] = now.isoformat()
        best_dep = (
            datetime.fromisoformat(current["departure"]) if current.get("departure") else departure
        )
        nxt = next_check(best_dep, now, current["status"])
        if nxt is None:
            state["stopped"] = True
        else:
            state["next_check"] = nxt.isoformat()
        _save(conn, key, state)
    return done


def _save(conn, key: str, state: dict) -> None:  # noqa: ANN001
    conn.execute(
        "INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, json.dumps(state)),
    )
    conn.commit()


def status_for(conn, kind: str, row_id: str) -> dict | None:  # noqa: ANN001
    row = conn.execute(
        "SELECT value FROM system_state WHERE key = ?", (f"flight_status:{kind}:{row_id}",)
    ).fetchone()
    if not row or not row[0]:
        return None
    return json.loads(row[0]).get("last")
