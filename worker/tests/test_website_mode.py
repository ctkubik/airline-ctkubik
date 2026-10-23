# ruff: noqa: ARG002, ARG005, ANN002, ANN003, E501 - fakes and fixed SQL
"""The default mode: southwest.com does everything, the phone-app service is off."""

from __future__ import annotations

import importlib.util
import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import db
import pytest
import safety_net

from lib import capture as capture_mod
from lib import checkin_handler as ch
from lib import web_checkin as wc
from lib.browser_session import BrowserSession
from lib.config import phone_app_enabled
from lib.utils import RequestError


def load_worker():  # noqa: ANN201
    spec = importlib.util.spec_from_file_location("worker_main", Path(__file__).parents[1] / "worker.py")
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    return worker


class Session:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._driver = object()
        self.headers: dict = {}
        self.restores = 0

    def restore(self, timeout: int = 0) -> None:
        self.restores += 1

    def ensure_alive(self) -> None:
        pass

    def make_request(self, *a, **k) -> dict:
        raise AssertionError("the phone-app service must not be used")


class FakeCapture:
    def __init__(self, *a) -> None:
        pass

    def start_capture(self) -> None:
        pass

    def finish_capture(self, success: bool) -> None:
        pass


def test_off_by_default_and_switchable(monkeypatch) -> None:  # noqa: ANN001
    assert phone_app_enabled() is False
    for value in ("true", "1", "on"):
        monkeypatch.setenv("SOUTHWEST_PHONE_APP", value)
        assert phone_app_enabled() is True
    monkeypatch.setenv("SOUTHWEST_PHONE_APP", "false")
    assert phone_app_enabled() is False


def test_browser_session_refuses_phone_app_requests_and_skips_restore() -> None:
    session = BrowserSession()
    with pytest.raises(RequestError, match="turned off"):
        session.make_request("POST", "x", {}, {})
    session.restore()  # nothing to do on the website; must not touch a browser
    assert session.mode_description() == "southwest.com website"


@pytest.fixture
def handler(db_conn, monkeypatch):  # noqa: ANN001, ANN201
    db_conn.execute(
        "INSERT INTO reservations (id, confirmation_number, first_name, last_name) VALUES ('r', 'ABC123', 'Pat', 'K')"
    )
    db_conn.execute("INSERT INTO flights (id, reservation_id, departure_time) VALUES ('f', 'r', '2099-01-03T12:00:00')")
    db_conn.commit()
    monkeypatch.setattr(capture_mod, "CheckInCapture", FakeCapture)
    monkeypatch.setattr(ch, "make_request", Session().make_request)
    monkeypatch.setattr(ch, "WEBSITE_RETRY_SECONDS", 0)
    h = ch.CheckInHandler(
        Session(), "f", "ABC123", "Pat", "K",
        datetime(2099, 1, 3, 12, tzinfo=timezone.utc), "PHX", "DEN", False, db.get_connection,
    )
    h.sent = []
    monkeypatch.setattr(h, "_send_notification", lambda ok, err="": h.sent.append((ok, err)))
    return h


def test_check_in_goes_to_the_website_and_retries_when_early(handler, db_conn, monkeypatch) -> None:  # noqa: ANN001
    answers = iter([
        {"ok": False, "status": "too_early", "message": "too early", "page": ""},
        {"ok": True, "status": "checked_in", "message": "Checked in on southwest.com", "page": ""},
    ])
    monkeypatch.setattr(wc, "web_check_in", lambda *a, **k: next(answers))
    assert handler._check_in(final=True) is True
    status, result = db_conn.execute("SELECT checkin_status, checkin_result FROM flights").fetchone()
    assert status == "success"
    assert "website" in result
    assert handler.sent == [(True, "")]
    assert handler.browser_session.restores == 2  # no-op on the website, called after each try


def test_check_in_failure_says_what_the_website_said(handler, db_conn, monkeypatch) -> None:  # noqa: ANN001
    calls: list[int] = []

    def refuse(*a, **k) -> dict:
        calls.append(1)
        return {"ok": False, "status": "not_found", "message": "southwest.com couldn't find the reservation", "page": ""}

    monkeypatch.setattr(wc, "web_check_in", refuse)
    assert handler._check_in(final=True) is True
    assert calls == [1]  # not found isn't retried
    status, result = db_conn.execute("SELECT checkin_status, checkin_result FROM flights").fetchone()
    assert status == "failed"
    assert "couldn't find" in result
    assert handler.sent == [(False, "southwest.com couldn't find the reservation")]


def test_early_alist_attempt_refused_leaves_it_for_24_hours(handler, db_conn, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(
        wc, "web_check_in", lambda *a, **k: {"ok": False, "status": "too_early", "message": "too early", "page": ""}
    )
    assert handler._check_in(final=False) is False
    assert db_conn.execute("SELECT checkin_status FROM flights").fetchone()[0] == "checking_in"
    assert handler.sent == []


def test_reservations_are_read_from_southwest_com(db_conn, monkeypatch) -> None:  # noqa: ANN001
    worker = load_worker()
    monkeypatch.setattr(worker, "browser_session", Session())
    db_conn.execute(
        "INSERT INTO reservations (id, confirmation_number, first_name, last_name) VALUES ('r', 'ABC123', 'Pat', 'K')"
    )
    # Found earlier by the phone-app service, number written differently
    db_conn.execute(
        "INSERT INTO flights (id, reservation_id, flight_number, departure_time) "
        "VALUES ('old', 'r', 'WN1234', '2099-11-20T15:00:00+00:00')"
    )
    db_conn.commit()
    lookups: list[str] = []

    def lookup(driver, conf, first, last, **k) -> dict:
        lookups.append(conf)
        return {
            "ok": True,
            "message": "Read 2 flight(s) from southwest.com",
            "flights": [
                {"flight_number": "1234", "departure_airport": "PHX", "destination_airport": "MDW", "departure_local": "2099-11-20T08:00"},
                {"flight_number": "88", "departure_airport": "MDW", "destination_airport": "PHX", "departure_local": "2099-11-24T17:35"},
            ],
        }

    monkeypatch.setattr(wc, "web_lookup_flights", lookup)
    worker.process_manual_reservations(db_conn)
    assert lookups == ["ABC123"]  # one website lookup, no phone-app attempt
    rows = db_conn.execute("SELECT id, flight_number, departure_airport FROM flights ORDER BY departure_time").fetchall()
    assert [tuple(r)[1:] for r in rows] == [("WN1234", "PHX"), ("88", "MDW")]
    assert rows[0]["id"] == "old"  # the same flight, not a duplicate
    res = db_conn.execute("SELECT lookup_status, lookup_message FROM reservations").fetchone()
    assert res[0] == "ok"
    assert "southwest.com" in res[1]


def test_failed_lookup_message_has_no_phone_app_part(db_conn, monkeypatch) -> None:  # noqa: ANN001
    worker = load_worker()
    monkeypatch.setattr(worker, "browser_session", Session())
    db_conn.execute(
        "INSERT INTO reservations (id, confirmation_number, first_name, last_name) VALUES ('r', 'ABC123', 'Pat', 'K')"
    )
    db_conn.commit()
    monkeypatch.setattr(
        wc, "web_lookup_flights",
        lambda *a, **k: {"ok": False, "flights": [], "message": "southwest.com said: reservation not found"},
    )
    worker.process_manual_reservations(db_conn)
    msg = db_conn.execute("SELECT lookup_message FROM reservations").fetchone()[0]
    assert "phone-app" not in msg
    assert "reservation not found" in msg
    assert "add the flights by hand" in msg


def test_fare_checks_skip_without_the_phone_app(db_conn, monkeypatch) -> None:  # noqa: ANN001
    worker = load_worker()
    monkeypatch.setattr(worker, "browser_session", Session())
    monkeypatch.setattr(worker, "get_flights_for_fare_check", lambda c: pytest.fail("shouldn't look for flights"))
    worker.check_fares(db_conn)
    msg = db_conn.execute("SELECT message FROM worker_logs ORDER BY id DESC LIMIT 1").fetchone()[0]
    assert "need the phone-app service" in msg


def test_readiness_needs_only_the_browser(db_conn) -> None:  # noqa: ANN001
    class Alive:
        def is_alive(self) -> bool:
            return True

    flight = {"first_name": "P", "last_name": "K", "confirmation_number": "ABC123"}
    assert safety_net.check_flight_readiness(flight, Session(), Alive()) == []
    broken = Session()
    broken._driver = None
    problems = safety_net.check_flight_readiness(flight, broken, Alive())
    assert "southwest.com" in problems[0]


def test_connection_test_checks_the_website_only(db_conn, monkeypatch) -> None:  # noqa: ANN001
    worker = load_worker()
    session = Session()
    session._driver = type("D", (), {"execute_script": lambda self, s: "Check-in is available 24 hours before"})()
    monkeypatch.setattr(worker, "browser_session", session)
    monkeypatch.setattr(worker, "_checkin_within", lambda _h: None)
    monkeypatch.setattr(worker.time, "sleep", lambda _s: None)
    monkeypatch.setattr(wc, "web_check_in", lambda *a, **k: {"ok": True, "status": "form_ready", "message": "form filled", "page": ""})
    monkeypatch.setattr(wc, "click_checkin", lambda *a, **k: True)
    depart = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat()
    db_conn.execute(
        "INSERT INTO reservations (id, confirmation_number, first_name, last_name) VALUES ('r', 'ABC123', 'Pat', 'K')"
    )
    db_conn.execute("INSERT INTO flights (id, reservation_id, departure_time) VALUES ('f', 'r', ?)", (depart,))
    db_conn.execute("INSERT INTO system_state (key, value) VALUES ('connection_test_request', '{\"flight_id\": \"f\"}')")
    db_conn.commit()
    worker.process_connection_tests(db_conn)
    result = json.loads(db_conn.execute("SELECT value FROM system_state WHERE key = 'connection_test:f'").fetchone()[0])
    assert result["ok"], result
    assert [s["name"] for s in result["steps"]] == ["Browser", "Website check-in (southwest.com)"]
