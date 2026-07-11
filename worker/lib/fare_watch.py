"""Multi-airline fare watching via the Amadeus Self-Service APIs.

A fare watch is a named search ("Mom's visit") for a route + date window.
Each check finds the cheapest fare in the window across all airlines Amadeus
covers (most carriers; Southwest does not distribute fares through Amadeus —
Southwest flights are tracked natively by the rest of this app).

Requires AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET (free at
https://developers.amadeus.com). AMADEUS_ENV=production switches off the
default test environment once you have production keys.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta
from typing import Any

import requests

from .log import get_logger

logger = get_logger(__name__)

JSON_T = dict[str, Any]

AIRLINE_NAMES = {
    "AA": "American", "AC": "Air Canada", "AF": "Air France", "AM": "Aeromexico",
    "AS": "Alaska", "B6": "JetBlue", "BA": "British Airways", "DL": "Delta",
    "EK": "Emirates", "F9": "Frontier", "G4": "Allegiant", "HA": "Hawaiian",
    "IB": "Iberia", "KL": "KLM", "LH": "Lufthansa", "MX": "Breeze", "NK": "Spirit",
    "QF": "Qantas", "SY": "Sun Country", "UA": "United", "VS": "Virgin Atlantic",
    "WN": "Southwest", "WS": "WestJet", "Y4": "Volaris",
}


def airline_name(code: str) -> str:
    return AIRLINE_NAMES.get(code, code)


class AmadeusClient:
    """Minimal Amadeus Self-Service API client (OAuth2 client credentials)."""

    def __init__(self) -> None:
        self.client_id = os.environ.get("AMADEUS_CLIENT_ID", "")
        self.client_secret = os.environ.get("AMADEUS_CLIENT_SECRET", "")
        env = os.environ.get("AMADEUS_ENV", "test").lower()
        self.base_url = (
            "https://api.amadeus.com" if env == "production" else "https://test.api.amadeus.com"
        )
        self._token: str | None = None
        self._token_expires_at: float = 0

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    def _get_token(self) -> str:
        if self._token and time.time() < self._token_expires_at - 60:
            return self._token
        resp = requests.post(
            f"{self.base_url}/v1/security/oauth2/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        self._token = data["access_token"]
        self._token_expires_at = time.time() + int(data.get("expires_in", 1799))
        return self._token

    def get(self, path: str, params: JSON_T) -> JSON_T:
        resp = requests.get(
            f"{self.base_url}{path}",
            params=params,
            headers={"Authorization": f"Bearer {self._get_token()}"},
            timeout=60,
        )
        if resp.status_code >= 400:
            raise FareWatchApiError(resp.status_code, resp.text[:500])
        return resp.json()


class FareWatchApiError(Exception):
    def __init__(self, status_code: int, body: str) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(f"Amadeus API error {status_code}: {body}")


def _date_range(start: str, end: str, cap: int) -> list[str]:
    """List of ISO dates from start to end inclusive, capped at `cap` entries."""
    d0 = datetime.strptime(start, "%Y-%m-%d").date()
    d1 = datetime.strptime(end, "%Y-%m-%d").date()
    days = min((d1 - d0).days, cap - 1)
    return [(d0 + timedelta(days=i)).isoformat() for i in range(max(days, 0) + 1)]


def _cheapest_from_offers(offers_response: JSON_T) -> JSON_T | None:
    """Pick the cheapest offer out of a Flight Offers Search response."""
    offers = offers_response.get("data") or []
    best = None
    for offer in offers:
        try:
            price = float(offer["price"]["grandTotal"])
        except (KeyError, TypeError, ValueError):
            continue
        if best is None or price < best["price"]:
            carriers = offer.get("validatingAirlineCodes") or []
            segments = []
            for itin in offer.get("itineraries", []):
                for seg in itin.get("segments", []):
                    segments.append(
                        f"{seg.get('carrierCode', '')}{seg.get('number', '')} "
                        f"{seg.get('departure', {}).get('iataCode', '')}->"
                        f"{seg.get('arrival', {}).get('iataCode', '')}"
                    )
            itineraries = offer.get("itineraries", [])
            depart_at = ""
            return_at = None
            if itineraries:
                first_segs = itineraries[0].get("segments", [])
                if first_segs:
                    depart_at = first_segs[0].get("departure", {}).get("at", "")[:10]
                if len(itineraries) > 1:
                    ret_segs = itineraries[1].get("segments", [])
                    if ret_segs:
                        return_at = ret_segs[0].get("departure", {}).get("at", "")[:10]
            best = {
                "price": price,
                "currency": offer.get("price", {}).get("currency", "USD"),
                "airline": airline_name(carriers[0]) if carriers else "",
                "departure_date": depart_at,
                "return_date": return_at,
                "details": {"segments": segments, "carriers": carriers},
            }
    return best


def find_cheapest_fare(client: AmadeusClient, watch: JSON_T) -> JSON_T | None:
    """Find the cheapest fare for a watch's route and date window.

    Strategy: try the Flight Cheapest Date Search API first (one call covers a
    whole date range), then fall back to per-date Flight Offers Search calls
    (capped to protect the free-tier quota) for routes the date-search API
    doesn't support.
    """
    origin = watch["origin"].upper()
    destination = watch["destination"].upper()
    is_round_trip = bool(watch.get("return_date_start"))

    # --- Attempt 1: Flight Cheapest Date Search over the whole window ---
    try:
        params: JSON_T = {
            "origin": origin,
            "destination": destination,
            "departureDate": f"{watch['depart_date_start']},{watch['depart_date_end']}",
            "oneWay": "false" if is_round_trip else "true",
        }
        if watch.get("nonstop_only"):
            params["nonStop"] = "true"
        if is_round_trip:
            d_start = datetime.strptime(watch["depart_date_start"], "%Y-%m-%d").date()
            d_end = datetime.strptime(watch["depart_date_end"], "%Y-%m-%d").date()
            r_start = datetime.strptime(watch["return_date_start"], "%Y-%m-%d").date()
            r_end = datetime.strptime(watch["return_date_end"], "%Y-%m-%d").date()
            min_stay = max((r_start - d_end).days, 1)
            max_stay = min(max((r_end - d_start).days, min_stay), 45)
            params["duration"] = f"{min_stay},{max_stay}"

        response = client.get("/v1/shopping/flight-dates", params)
        candidates = response.get("data") or []
        best_pair = None
        for item in candidates:
            try:
                price = float(item["price"]["total"])
            except (KeyError, TypeError, ValueError):
                continue
            if best_pair is None or price < best_pair["price"]:
                best_pair = {
                    "price": price,
                    "departure_date": item.get("departureDate", ""),
                    "return_date": item.get("returnDate"),
                }
        if best_pair:
            # One offers call on the best date pair to get airline + accurate price
            offer_params: JSON_T = {
                "originLocationCode": origin,
                "destinationLocationCode": destination,
                "departureDate": best_pair["departure_date"],
                "adults": int(watch.get("adults") or 1),
                "currencyCode": "USD",
                "max": 10,
            }
            if best_pair.get("return_date"):
                offer_params["returnDate"] = best_pair["return_date"]
            if watch.get("nonstop_only"):
                offer_params["nonStop"] = "true"
            offers = client.get("/v2/shopping/flight-offers", offer_params)
            best = _cheapest_from_offers(offers)
            if best:
                return best
            # Date-search price without offer detail is still useful
            return {
                "price": best_pair["price"],
                "currency": "USD",
                "airline": "",
                "departure_date": best_pair["departure_date"],
                "return_date": best_pair.get("return_date"),
                "details": {"source": "flight-dates"},
            }
    except FareWatchApiError as err:
        # 404/400 usually means the route isn't supported by the date-search
        # cache — fall back to direct offer searches.
        logger.info(
            "flight-dates unavailable for %s-%s (%s), falling back to flight-offers",
            origin, destination, err.status_code,
        )

    # --- Attempt 2: per-date Flight Offers Search (quota-capped) ---
    depart_dates = _date_range(watch["depart_date_start"], watch["depart_date_end"], cap=7)
    return_dates = (
        _date_range(watch["return_date_start"], watch["return_date_end"], cap=3)
        if is_round_trip
        else [None]
    )
    best = None
    for dep_date in depart_dates:
        for ret_date in return_dates:
            offer_params = {
                "originLocationCode": origin,
                "destinationLocationCode": destination,
                "departureDate": dep_date,
                "adults": int(watch.get("adults") or 1),
                "currencyCode": "USD",
                "max": 10,
            }
            if ret_date:
                offer_params["returnDate"] = ret_date
            if watch.get("nonstop_only"):
                offer_params["nonStop"] = "true"
            try:
                offers = client.get("/v2/shopping/flight-offers", offer_params)
            except FareWatchApiError as err:
                logger.warning(
                    "flight-offers failed for %s-%s %s: %s",
                    origin, destination, dep_date, err.status_code,
                )
                continue
            candidate = _cheapest_from_offers(offers)
            if candidate and (best is None or candidate["price"] < best["price"]):
                best = candidate
            time.sleep(0.3)  # stay under the test-tier rate limit
    return best


def check_fare_watches(conn, notify_fn=None, interval_hours: float | None = None) -> None:
    """Check all active fare watches whose interval has elapsed.

    notify_fn(title, message) is called on price drops.
    """
    client = AmadeusClient()
    if not client.configured:
        return  # feature not configured; stay silent

    if interval_hours is None:
        interval_hours = float(os.environ.get("FARE_WATCH_INTERVAL_HOURS", "6"))
    cutoff = (datetime.utcnow() - timedelta(hours=interval_hours)).isoformat()
    today = datetime.utcnow().date().isoformat()

    rows = conn.execute(
        "SELECT * FROM fare_watches WHERE is_active = 1 "
        "AND (last_checked_at IS NULL OR last_checked_at < ?) "
        "AND depart_date_end >= ?",
        (cutoff, today),
    ).fetchall()

    for row in rows:
        watch = dict(row)
        now = datetime.utcnow().isoformat()
        try:
            best = find_cheapest_fare(client, watch)
        except Exception as err:  # noqa: BLE001 - record any failure on the watch
            logger.error("Fare watch '%s' failed: %s", watch["name"], err)
            conn.execute(
                "UPDATE fare_watches SET last_checked_at = ?, last_error = ? WHERE id = ?",
                (now, str(err)[:500], watch["id"]),
            )
            conn.commit()
            continue

        if best is None:
            conn.execute(
                "UPDATE fare_watches SET last_checked_at = ?, last_error = ? WHERE id = ?",
                (now, "No fares found for this route/date window", watch["id"]),
            )
            conn.commit()
            continue

        previous_best = watch.get("best_price")
        price_changed = previous_best is None or abs(best["price"] - previous_best) >= 0.01

        conn.execute(
            "UPDATE fare_watches SET last_checked_at = ?, last_error = NULL, "
            "best_price = ?, best_price_currency = ?, best_departure_date = ?, "
            "best_return_date = ?, best_airline = ?, updated_at = ? WHERE id = ?",
            (
                now, best["price"], best["currency"], best["departure_date"],
                best.get("return_date"), best.get("airline", ""), now, watch["id"],
            ),
        )
        if price_changed:
            conn.execute(
                "INSERT INTO fare_watch_history "
                "(watch_id, price, currency, departure_date, return_date, airline, details_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    watch["id"], best["price"], best["currency"], best["departure_date"],
                    best.get("return_date"), best.get("airline", ""),
                    json.dumps(best.get("details") or {})[:2000],
                ),
            )
        conn.commit()

        dropped = previous_best is not None and best["price"] < previous_best - 0.01
        under_max = watch.get("max_price") and best["price"] <= watch["max_price"]
        if notify_fn and (dropped or (previous_best is None and under_max)):
            when = best["departure_date"]
            if best.get("return_date"):
                when += f" – {best['return_date']}"
            title = f"Fare drop: {watch['name']}"
            message = (
                f"{watch['origin']}->{watch['destination']} {when}: "
                f"${best['price']:.2f}"
                + (f" on {best['airline']}" if best.get("airline") else "")
                + (f" (was ${previous_best:.2f})" if previous_best is not None else "")
            )
            try:
                notify_fn(title, message)
            except Exception as err:  # noqa: BLE001
                logger.error("Fare watch notification failed: %s", err)

        logger.info(
            "Fare watch '%s': best $%.2f %s on %s",
            watch["name"], best["price"], best["currency"], best.get("airline") or "unknown",
        )
