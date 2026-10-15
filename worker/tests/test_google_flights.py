# ruff: noqa: DTZ001, E501 - fixed test times; long sample data lines
from __future__ import annotations

import json
from datetime import datetime

from lib import google_flights as gf

RESULT = {
    "best_flights": [
        {
            "price": 540,
            "flights": [
                {
                    "airline": "Delta",
                    "flight_number": "DL 1543",
                    "departure_airport": {"id": "PHX"},
                },
            ],
        }
    ],
    "other_flights": [
        {"price": 498, "flights": [{"airline": "American", "flight_number": "AA 100"}]},
        {"price": None, "flights": []},
    ],
}


class FakeResponse:
    def __init__(self, data: dict, status: int = 200) -> None:
        self.status_code = status
        self._data = data
        self.text = json.dumps(data)

    def json(self) -> dict:
        return self._data


class FakeSession:
    def __init__(self, data: dict) -> None:
        self.data = data
        self.calls: list[dict] = []

    def get(self, _url: str, params: dict, timeout: int) -> FakeResponse:  # noqa: ARG002
        self.calls.append(params)
        return FakeResponse(self.data)


def test_reading_results() -> None:
    assert gf.cheapest(RESULT)["price"] == 498
    assert gf.matching_price(RESULT, ["DL1543"])["price"] == 540
    assert gf.matching_price(RESULT, ["DL 999"]) is None
    assert gf.option_airline(RESULT["best_flights"][0]) == "Delta"


def test_watch_searches_pair_return_dates() -> None:
    watch = {
        "origin": "phx", "destination": "ord", "adults": 2, "nonstop_only": 1,
        "depart_date_start": "2099-11-20", "depart_date_end": "2099-11-24",
        "return_date_start": "2099-11-30", "return_date_end": "2099-12-01",
    }  # fmt: skip
    searches = gf.watch_searches(watch)
    assert [(s["outbound_date"], s["return_date"]) for s in searches] == [
        ("2099-11-20", "2099-11-30"),
        ("2099-11-24", "2099-12-01"),
    ]
    assert searches[0]["stops"] == gf.NONSTOP
    assert searches[0]["type"] == gf.TYPE_ROUND_TRIP


def _seg(i: int, dep: str, dest: str, local: str, number: str) -> dict:
    return {
        "position": i, "airline_code": "DL", "flight_number": number, "departure_airport": dep,
        "destination_airport": dest, "departure_local": local, "arrival_local": local,
    }  # fmt: skip


def test_trip_search_round_trip_matches_outbound() -> None:
    segs = [
        _seg(0, "PHX", "ATL", "2099-12-04T07:15", "1543"),
        _seg(1, "ATL", "PHX", "2099-12-08T18:40", "860"),
    ]
    params, flights = gf.trip_search({"traveler": "Pat, Chad"}, segs)
    assert params["type"] == gf.TYPE_ROUND_TRIP
    assert params["return_date"] == "2099-12-08"
    assert params["adults"] == 2
    assert params["include_airlines"] == "DL"
    assert flights == ["DL1543"]


def test_budget_and_trip_price_alert(db_conn, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("SERPAPI_API_KEY", "k")
    monkeypatch.setenv("SERPAPI_MONTHLY_LIMIT", "2")
    db_conn.execute(
        "INSERT INTO trips (id, airline, confirmation_number, traveler, price_paid) "
        "VALUES ('t1', 'Delta', 'GZ4K7P', 'Pat', 612.40)"
    )
    db_conn.execute(
        "INSERT INTO trip_segments (trip_id, position, airline_code, flight_number, departure_airport, "
        "destination_airport, departure_local, departure_time) "
        "VALUES ('t1', 0, 'DL', '1543', 'PHX', 'ATL', '2099-12-04T07:15', '2099-12-04T14:15:00.000Z')"
    )
    db_conn.commit()
    alerts: list[tuple] = []
    session = FakeSession(RESULT)
    now = datetime(2099, 11, 1)
    assert gf.check_trip_prices(db_conn, lambda *a: alerts.append(a), session, now) == 1
    trip = dict(db_conn.execute("SELECT * FROM trips").fetchone())
    assert (trip["current_price"], trip["current_price_exact"]) == (540, 1)
    assert len(alerts) == 1
    assert "you paid $612" in alerts[0][1]
    # Same price again: no repeat alert. Then the monthly limit stops searches.
    db_conn.execute("UPDATE trips SET price_checked_at = NULL")
    db_conn.commit()
    gf.check_trip_prices(db_conn, lambda *a: alerts.append(a), session, now)
    assert len(alerts) == 1
    assert gf.searches_left(db_conn) == 0
    db_conn.execute("UPDATE trips SET price_checked_at = NULL")
    db_conn.commit()
    assert gf.check_trip_prices(db_conn, lambda *a: alerts.append(a), session, now) == 0
    assert len(session.calls) == 2
    assert session.calls[0]["engine"] == "google_flights"
