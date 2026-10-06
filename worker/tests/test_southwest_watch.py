from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from urllib.parse import parse_qs, urlparse

from lib import southwest_watch as sw

PAGE = """Select departing flight: PHX to DEN
Save up to $50 with promo code
WN 1234  6:05AM - 8:55AM  Nonstop
Business Select $289  Anytime $249  Wanna Get Away Plus $169  Wanna Get Away $129
WN 2210  2:15PM - 5:00PM  1 stop
Wanna Get Away $109
Bag fees: first 2 bags $0, change fee $0
Earn 1,200 points
"""


def test_heuristic_skips_fees_and_promos() -> None:
    assert sw.heuristic_cheapest(PAGE) == 109.0
    assert sw.heuristic_cheapest("Sold out\nUnavailable") is None


class FakeLLM:
    def __init__(self, answer: Any) -> None:
        self.answer = answer
        self.enabled = True

    def chat_json(self, *_: Any, **__: Any) -> Any:
        return self.answer


def test_llm_answer_must_appear_on_page() -> None:
    good = sw.llm_cheapest(PAGE, FakeLLM({"price": 109, "flight": "WN 2210", "departs": "2:15PM"}))
    assert good == {"price": 109.0, "flight": "WN 2210", "departs": "2:15PM"}
    assert sw.llm_cheapest(PAGE, FakeLLM({"price": 99})) is None  # not on the page
    assert sw.llm_cheapest(PAGE, FakeLLM({"price": "n/a"})) is None


def test_search_url_is_one_way_usd() -> None:
    q = parse_qs(urlparse(sw.search_url("phx", "den", "2026-11-20", 2)).query)
    assert q["originationAirportCode"] == ["PHX"]
    assert q["destinationAirportCode"] == ["DEN"]
    assert q["departureDate"] == ["2026-11-20"]
    assert q["tripType"] == ["oneway"]
    assert q["fareType"] == ["USD"]
    assert q["adultPassengersCount"] == ["2"]


def test_spread_dates_caps_page_loads_and_skips_past() -> None:
    start = date.today() + timedelta(days=10)
    days = sw.spread_dates(start.isoformat(), (start + timedelta(days=20)).isoformat())
    assert len(days) == sw.MAX_DATES_PER_DIRECTION
    assert days[0] == start.isoformat()
    assert days[-1] == (start + timedelta(days=20)).isoformat()
    past = date.today() - timedelta(days=5)
    assert sw.spread_dates(past.isoformat(), (past + timedelta(days=2)).isoformat()) == []


def test_round_trip_adds_cheapest_each_way_times_travelers() -> None:
    start = date.today() + timedelta(days=30)
    d = [(start + timedelta(days=i)).isoformat() for i in range(10)]
    fares = {
        ("PHX", "DEN", d[0]): 150, ("PHX", "DEN", d[1]): 120,
        ("DEN", "PHX", d[7]): 90, ("DEN", "PHX", d[8]): 140,
    }  # fmt: skip
    seen = []

    def search(origin: str, destination: str, day: str) -> dict | None:
        seen.append((origin, destination, day))
        price = fares.get((origin, destination, day))
        return {"price": float(price), "flight": "WN 1", "method": "pattern"} if price else None

    watch = {
        "origin": "PHX", "destination": "DEN", "adults": 2,
        "depart_date_start": d[0], "depart_date_end": d[1],
        "return_date_start": d[7], "return_date_end": d[8],
    }  # fmt: skip
    best = sw.find_southwest_fare(search, watch)
    assert best["price"] == (120 + 90) * 2
    assert best["departure_date"] == d[1]
    assert best["return_date"] == d[7]
    assert best["airline"] == "Southwest"
    assert len(seen) == 4


def test_no_return_fare_means_no_result() -> None:
    start = (date.today() + timedelta(days=30)).isoformat()
    watch = {
        "origin": "PHX", "destination": "DEN",
        "depart_date_start": start, "depart_date_end": start,
        "return_date_start": start, "return_date_end": start,
    }  # fmt: skip

    def search(origin: str, *_: Any) -> dict | None:
        return {"price": 100.0} if origin == "PHX" else None

    assert sw.find_southwest_fare(search, watch) is None
