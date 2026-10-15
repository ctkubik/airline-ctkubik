"""Prices on any airline from Google Flights, through SerpApi.

Used for two things:
  * Fare watches marked "google" (and old Amadeus watches, since Amadeus shut
    its free API down): the cheapest fare over the watch's date window.
  * Booked trips on other airlines: today's price for the same flights, so
    you hear about a drop below what you paid.

Settings (environment):
    SERPAPI_API_KEY          from serpapi.com (free plan: 250 searches a month)
    SERPAPI_MONTHLY_LIMIT    searches this app may use per month (default 240)
    TRIP_PRICE_CHECK_HOURS   how often a booked trip is re-priced (default 48)
    TRIP_PRICE_DROP_ALERT    alert when the price is this many dollars under
                             what you paid (default 20)

Every search counts against the monthly limit, which is tracked in the
system_state table so a busy month can't run up a bill.
"""

from __future__ import annotations

import os
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

import requests

from .log import get_logger

logger = get_logger(__name__)

SEARCH_URL = "https://serpapi.com/search.json"
MAX_SEARCHES_PER_WATCH = 2  # per check; a watch is checked once a day

# SerpApi "stops" values: 1 = nonstop only
NONSTOP = 1
TYPE_ROUND_TRIP, TYPE_ONE_WAY = 1, 2


class BudgetExceeded(Exception):  # noqa: N818 - reads better at call sites
    """This month's search allowance is used up."""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def api_key() -> str:
    return os.environ.get("SERPAPI_API_KEY", "").strip()


def configured() -> bool:
    return bool(api_key())


def monthly_limit() -> int:
    try:
        return int(os.environ.get("SERPAPI_MONTHLY_LIMIT", "240"))
    except ValueError:
        return 240


def _usage_key(now: datetime | None = None) -> str:
    return f"serpapi_searches:{(now or _utcnow()).strftime('%Y-%m')}"


def searches_used(conn) -> int:  # noqa: ANN001
    row = conn.execute("SELECT value FROM system_state WHERE key = ?", (_usage_key(),)).fetchone()
    try:
        return int(row[0]) if row else 0
    except (TypeError, ValueError):
        return 0


def searches_left(conn) -> int:  # noqa: ANN001
    return max(0, monthly_limit() - searches_used(conn))


def _count_search(conn) -> None:  # noqa: ANN001
    conn.execute(
        "INSERT INTO system_state (key, value, updated_at) VALUES (?, '1', datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1, "
        "updated_at = excluded.updated_at",
        (_usage_key(),),
    )
    conn.commit()


def search(conn, params: dict, session: Any = requests) -> dict:  # noqa: ANN001
    """One Google Flights search. Raises BudgetExceeded or requests errors."""
    if searches_left(conn) <= 0:
        raise BudgetExceeded(f"Monthly Google Flights limit of {monthly_limit()} searches reached")
    query = {
        "engine": "google_flights",
        "currency": "USD",
        "hl": "en",
        "gl": "us",
        **{k: v for k, v in params.items() if v not in (None, "")},
        "api_key": api_key(),
    }
    _count_search(conn)
    resp = session.get(SEARCH_URL, params=query, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f"Google Flights search failed ({resp.status_code}): {resp.text[:200]}")
    data = resp.json()
    if data.get("error"):
        # "Google hasn't returned any results" is a normal empty answer
        if "any results" in str(data["error"]).lower():
            return {}
        raise RuntimeError(f"Google Flights: {data['error']}")
    return data


# ---------------------------------------------------------------------------
# Reading results (pure, unit-tested)
# ---------------------------------------------------------------------------


def options(data: dict) -> list[dict]:
    return list(data.get("best_flights") or []) + list(data.get("other_flights") or [])


def _norm_flight(number: str) -> str:
    """'DL 1543' / 'DL1543' -> 'DL1543'."""
    return re.sub(r"\s+", "", str(number or "")).upper()


def option_flights(option: dict) -> list[str]:
    return [_norm_flight(f.get("flight_number")) for f in option.get("flights") or []]


def option_airline(option: dict) -> str:
    names = []
    for f in option.get("flights") or []:
        name = f.get("airline") or ""
        if name and name not in names:
            names.append(name)
    return " + ".join(names)


def cheapest(data: dict) -> dict | None:
    priced = [o for o in options(data) if isinstance(o.get("price"), (int, float))]
    return min(priced, key=lambda o: o["price"]) if priced else None


def matching_price(data: dict, flight_numbers: list[str]) -> dict | None:
    """The option made of exactly these flights (in order), if Google lists it."""
    wanted = [_norm_flight(n) for n in flight_numbers if n]
    if not wanted:
        return None
    for o in options(data):
        if option_flights(o) == wanted and isinstance(o.get("price"), (int, float)):
            return o
    return None


def spread_dates(start: str, end: str, limit: int) -> list[str]:
    d0 = max(date.fromisoformat(start), _utcnow().date())
    d1 = date.fromisoformat(end)
    if d1 < d0:
        return []
    span = (d1 - d0).days
    if span + 1 <= limit:
        return [(d0 + timedelta(days=i)).isoformat() for i in range(span + 1)]
    step = span / (limit - 1)
    return sorted({(d0 + timedelta(days=round(i * step))).isoformat() for i in range(limit)})


def watch_searches(watch: dict, limit: int = MAX_SEARCHES_PER_WATCH) -> list[dict]:
    """The searches for a fare watch: departure dates spread over its window,
    each paired with a return date the same distance into the return window."""
    departs = spread_dates(watch["depart_date_start"], watch["depart_date_end"], limit)
    out = []
    for day in departs:
        params: dict[str, Any] = {
            "departure_id": watch["origin"].upper(),
            "arrival_id": watch["destination"].upper(),
            "outbound_date": day,
            "adults": int(watch.get("adults") or 1),
            "stops": NONSTOP if watch.get("nonstop_only") else None,
            "type": TYPE_ONE_WAY,
        }
        if watch.get("return_date_start"):
            offset = (date.fromisoformat(day) - date.fromisoformat(watch["depart_date_start"])).days
            back = date.fromisoformat(watch["return_date_start"]) + timedelta(days=max(0, offset))
            end = date.fromisoformat(watch.get("return_date_end") or watch["return_date_start"])
            back = min(back, end)
            if back.isoformat() < day:
                continue
            params["return_date"] = back.isoformat()
            params["type"] = TYPE_ROUND_TRIP
        out.append(params)
    return out


def find_watch_fare(conn, watch: dict, session: Any = requests) -> dict | None:  # noqa: ANN001
    """Cheapest fare for a watch, shaped for fare_watch.record_watch_result."""
    best = None
    for params in watch_searches(watch):
        data = search(conn, params, session)
        top = cheapest(data)
        if top and (best is None or top["price"] < best[0]["price"]):
            best = (top, params)
    if not best:
        return None
    top, params = best
    return {
        "price": float(top["price"]),
        "currency": "USD",
        "airline": option_airline(top),
        "departure_date": params["outbound_date"],
        "return_date": params.get("return_date"),
        "details": {
            "source": "google-flights",
            "flights": [f.get("flight_number") for f in top.get("flights") or []],
            "price_level": (top.get("price_insights") or {}).get("price_level"),
        },
    }


# ---------------------------------------------------------------------------
# Booked trips on other airlines
# ---------------------------------------------------------------------------


def trip_search(trip: dict, segments: list[dict]) -> tuple[dict, list[str]] | None:
    """Search params that price this trip's outbound flights, and those flights.

    A round trip (last flight lands where the first left) is priced as a
    round trip, since that's how it was sold; the outbound flights are matched.
    """
    if not segments:
        return None
    first, last = segments[0], segments[-1]
    origin = first["departure_airport"]
    # Outbound = flights until the trip turns around (reaches the far end)
    turn = len(segments)
    for i, s in enumerate(segments[1:], start=1):
        if (
            s["departure_airport"] == segments[i - 1]["destination_airport"]
            and _gap_hours(segments[i - 1], s) > 12
        ):
            turn = i
            break
    outbound = segments[:turn]
    back = segments[turn:]
    adults = max(1, len([t for t in (trip.get("traveler") or "").split(",") if t.strip()]))
    params: dict[str, Any] = {
        "departure_id": origin,
        "arrival_id": outbound[-1]["destination_airport"],
        "outbound_date": outbound[0]["departure_local"][:10],
        "adults": adults,
        "type": TYPE_ONE_WAY,
    }
    code = (first.get("airline_code") or "").upper()
    if re.fullmatch(r"[A-Z0-9]{2}", code):
        params["include_airlines"] = code
    if back and last["destination_airport"] == origin:
        params["type"] = TYPE_ROUND_TRIP
        params["return_date"] = back[0]["departure_local"][:10]
    flights = [f"{s.get('airline_code') or ''}{s.get('flight_number') or ''}" for s in outbound]
    return params, [f for f in flights if re.search(r"\d", f)]


def _gap_hours(a: dict, b: dict) -> float:
    try:
        end = datetime.fromisoformat((a.get("arrival_local") or a["departure_local"])[:16])
        start = datetime.fromisoformat(b["departure_local"][:16])
        return (start - end).total_seconds() / 3600
    except (KeyError, ValueError):
        return 0.0


def check_trip_prices(
    conn,  # noqa: ANN001 - sqlite connection
    notify: Callable[..., Any],
    session: Any = requests,
    now: datetime | None = None,
) -> int:
    """Re-price booked other-airline trips that are due. Returns searches made."""
    if not configured():
        return 0
    now = now or _utcnow()
    hours = float(os.environ.get("TRIP_PRICE_CHECK_HOURS", "48"))
    threshold = float(os.environ.get("TRIP_PRICE_DROP_ALERT", "20"))
    cutoff = (now - timedelta(hours=hours)).isoformat()
    trips = conn.execute(
        "SELECT t.* FROM trips t WHERE t.status = 'booked' AND t.price_paid > 0 "
        "AND COALESCE(t.points_used, 0) = 0 "
        "AND (t.price_checked_at IS NULL OR t.price_checked_at < ?) "
        "AND (SELECT MIN(departure_time) FROM trip_segments s WHERE s.trip_id = t.id) > ? "
        "ORDER BY t.price_checked_at IS NOT NULL, t.price_checked_at LIMIT 3",
        (cutoff, (now + timedelta(hours=6)).isoformat()),
    ).fetchall()
    made = 0
    for row in trips:
        trip = dict(row)
        segments = [
            dict(s)
            for s in conn.execute(
                "SELECT * FROM trip_segments WHERE trip_id = ? ORDER BY position", (trip["id"],)
            ).fetchall()
        ]
        plan = trip_search(trip, segments)
        stamp = now.isoformat()
        if not plan:
            conn.execute("UPDATE trips SET price_checked_at = ? WHERE id = ?", (stamp, trip["id"]))
            conn.commit()
            continue
        params, flights = plan
        try:
            data = search(conn, params, session)
            made += 1
        except BudgetExceeded as err:
            logger.info("Trip price checks paused: %s", err)
            break
        except Exception as err:  # noqa: BLE001
            logger.warning("Trip price check for %s failed: %s", trip["confirmation_number"], err)
            conn.execute(
                "UPDATE trips SET price_checked_at = ?, price_note = ? WHERE id = ?",
                (stamp, f"Price check failed: {err}"[:200], trip["id"]),
            )
            conn.commit()
            continue
        exact = matching_price(data, flights)
        option = exact or cheapest(data)
        if not option:
            conn.execute(
                "UPDATE trips SET price_checked_at = ?, price_note = ? WHERE id = ?",
                (stamp, "Google Flights didn't list this route", trip["id"]),
            )
            conn.commit()
            continue
        price = float(option["price"])
        note = "same flights" if exact else f"cheapest on {option_airline(option) or 'this route'}"
        previous = trip.get("current_price")
        conn.execute(
            "UPDATE trips SET price_checked_at = ?, current_price = ?, current_price_exact = ?, "
            "price_note = ? WHERE id = ?",
            (stamp, price, 1 if exact else 0, note, trip["id"]),
        )
        conn.execute(
            "INSERT INTO trip_price_history (trip_id, price, exact) VALUES (?, ?, ?)",
            (trip["id"], price, 1 if exact else 0),
        )
        conn.commit()
        paid = float(trip["price_paid"])
        # Alert once per new low: under what was paid by the threshold, and
        # lower than the last price we told them about
        alerted = trip.get("price_alerted_at_price")
        if exact and price <= paid - threshold and (alerted is None or price < float(alerted) - 1):
            notify(
                f"Price drop: {trip['airline']} {trip['confirmation_number']}".strip(),
                f"{params['departure_id']}->{params['arrival_id']} "
                f"on {params['outbound_date']} is now "
                f"${price:,.0f} on Google Flights for the same flights; you paid ${paid:,.0f}. "
                f"Many fares (not basic economy) can be changed to the same flights for a credit "
                f"of the difference. Check {trip['airline']}'s website.",
                "important",
            )
            conn.execute(
                "UPDATE trips SET price_alerted_at_price = ? WHERE id = ?", (price, trip["id"])
            )
            conn.commit()
        logger.info(
            "Trip %s %s: $%.0f now (%s), paid $%.0f, was %s",
            trip["airline"],
            trip["confirmation_number"],
            price,
            note,
            paid,
            previous,
        )
    return made
