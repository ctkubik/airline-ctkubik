# ruff: noqa: ARG002, ARG005, ANN002, ANN003, E501, DTZ003 - fakes and fixed SQL
from __future__ import annotations

import importlib.util
import threading
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from lib import web_checkin as wc
from lib.utils import RequestError


def load_worker():  # noqa: ANN201
    spec = importlib.util.spec_from_file_location(
        "worker_main", Path(__file__).parents[1] / "worker.py"
    )
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    return worker


class Session:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._driver = object()
        self.headers: dict = {}
        self.restored = 0

    def make_request(self, *a, **k) -> dict:
        raise RequestError("Forbidden (403)")

    def _load_mobile_site(self, timeout: int = 0) -> None:
        self.restored += 1


@pytest.fixture
def worker(db_conn, monkeypatch):  # noqa: ANN001, ANN201
    w = load_worker()
    monkeypatch.setattr(w, "browser_session", Session())
    db_conn.execute(
        "INSERT INTO reservations (id, confirmation_number, first_name, last_name) VALUES ('r', 'ABC123', 'Pat', 'K')"
    )
    db_conn.commit()
    return w


def test_website_finds_flights_when_phone_app_fails(worker, db_conn, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(
        wc,
        "web_lookup_flights",
        lambda *a, **k: {
            "ok": True,
            "message": "Read 1 flight(s) from southwest.com",
            "flights": [
                {
                    "flight_number": "1234",
                    "departure_airport": "PHX",
                    "destination_airport": "MDW",
                    "departure_local": "2099-11-20T08:00",
                }
            ],
        },
    )
    worker.process_manual_reservations(db_conn)
    flight = db_conn.execute(
        "SELECT flight_number, departure_airport, departure_time FROM flights"
    ).fetchone()
    assert tuple(flight) == ("1234", "PHX", "2099-11-20T15:00:00+00:00")  # Phoenix is UTC-7
    res = db_conn.execute(
        "SELECT lookup_status, lookup_message, lookup_failures FROM reservations"
    ).fetchone()
    assert res[0] == "ok"
    assert "southwest.com" in res[1]
    assert res[2] == 0
    assert worker.browser_session.restored == 1


def test_both_fail_backs_off_and_says_why(worker, db_conn, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(
        wc,
        "web_lookup_flights",
        lambda *a, **k: {
            "ok": False,
            "flights": [],
            "message": "southwest.com couldn't find the reservation with that name",
        },
    )
    worker.process_manual_reservations(db_conn)
    res = dict(db_conn.execute("SELECT * FROM reservations").fetchone())
    assert res["lookup_status"] == "error"
    assert "403" in res["lookup_message"]
    assert "couldn't find" in res["lookup_message"]
    assert "add the flights by hand" in res["lookup_message"]
    wait = datetime.fromisoformat(res["next_lookup_at"]) - datetime.utcnow()
    assert timedelta(minutes=14) < wait <= timedelta(minutes=15)
    # Not due yet: nothing runs
    calls: list[int] = []
    monkeypatch.setattr(
        wc,
        "web_lookup_flights",
        lambda *a, **k: calls.append(1) or {"ok": False, "flights": [], "message": ""},
    )
    worker.process_manual_reservations(db_conn)
    assert calls == []
    # Second failure waits longer
    db_conn.execute("UPDATE reservations SET next_lookup_at = NULL")
    db_conn.commit()
    worker.process_manual_reservations(db_conn)
    res = dict(db_conn.execute("SELECT * FROM reservations").fetchone())
    assert res["lookup_failures"] == 2
    assert datetime.fromisoformat(res["next_lookup_at"]) - datetime.utcnow() > timedelta(minutes=29)


class LLM:
    enabled = True

    def __init__(self, answer: dict) -> None:
        self.answer = answer

    def chat_json(self, *a, **k) -> dict:
        return self.answer


def test_read_flights_only_keeps_what_the_page_shows() -> None:
    page = "Flight # 1234\nPHX 8:00 AM -> MDW 1:05 PM\nWed, Nov 20"
    answer = {
        "flights": [
            {"flight_number": "1234", "from": "PHX", "to": "MDW", "departs": "2099-11-20T08:00"},
            {"flight_number": "999", "from": "MDW", "to": "BOS", "departs": "2099-11-20T14:00"},
            {"flight_number": "12a", "from": "PHX", "to": "MDW", "departs": "tomorrow"},
        ]
    }
    assert wc.read_flights(page, LLM(answer)) == [
        {
            "flight_number": "1234",
            "departure_airport": "PHX",
            "destination_airport": "MDW",
            "departure_local": "2099-11-20T08:00",
        }
    ]
