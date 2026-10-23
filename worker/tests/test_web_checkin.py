# ruff: noqa: SLF001, ARG001, ARG002, ARG005, ANN002, ANN003, PT018, PLC0415, E501 - fakes and a worker.py import inside the test
from __future__ import annotations

import threading
from datetime import datetime, timezone

import db
import pytest

from lib import checkin_handler as ch
from lib import web_checkin as wc


class Off:
    enabled = False


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("You're checked in!\nBoarding group 2", "checked_in"),
        ("Boarding Position: B 14", "checked_in"),
        ("Please check in at the airport with a Southwest agent", "airport"),
        ("Check-in is available 24 hours before your flight", "too_early"),
        ("We can't find a reservation with that information", "not_found"),
        ("Sorry! We're having trouble accessing this content", "blocked"),
        ("Review your trip\nCheck in to get your boarding pass", "unknown"),
    ],
)
def test_classify_page(text: str, expected: str) -> None:
    assert wc.classify_page(text) == expected


class FakeSite:
    """southwest.com check-in: form -> review page (Check in button) -> checked in."""

    def __init__(self, final_text: str = "You're checked in!\nBoarding group 2") -> None:
        self.state = "blank"
        self.typed: dict[str, str] = {}
        self.final_text = final_text

    def get(self, url: str) -> None:
        self.state = "form"

    def is_element_visible(self, sel: str) -> bool:
        return self.state == "form" and sel in (
            'input[id="confirmationNumber"]',
            'input[id="passengerFirstName"]',
            'input[id="passengerLastName"]',
        )

    def type(self, sel: str, value: str) -> None:
        self.typed[sel] = value

    def click(self, sel: str) -> None:
        self.state = {"form": "review", "review": "done"}.get(self.state, self.state)

    def save_screenshot(self, path: str) -> None:
        pass

    def execute_script(self, script: str, *args: str) -> str | None:
        if "innerText" in script and not args:
            return {
                "form": "Check in for your flight",
                "review": "Review\\nCheck in to get your boarding pass",
                "done": self.final_text,
            }.get(self.state, "")
        # button finder: a Check in button exists on the form and review pages
        return '[data-webci-x="1"]' if self.state in ("form", "review") else None


def test_two_click_website_check_in(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(wc, "SETTLE_SECONDS", 0)
    site = FakeSite()
    result = wc.web_check_in(site, "ABC123", "Pat", "K", llm=Off())
    assert result["ok"] and result["status"] == "checked_in"
    assert site.state == "done"  # the review page's Check in was pressed
    assert site.typed['input[id="confirmationNumber"]'] == "ABC123"


def test_too_early_and_dry_run(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(wc, "SETTLE_SECONDS", 0)
    early = wc.web_check_in(
        FakeSite("Check-in is available 24 hours before your flight"),
        "ABC123",
        "Pat",
        "K",
        llm=Off(),
    )
    assert (early["ok"], early["status"]) == (False, "too_early")
    site = FakeSite()
    dry = wc.web_check_in(site, "ABC123", "Pat", "K", submit=False, llm=Off())
    assert dry["status"] == "form_ready"
    assert site.state == "form"  # nothing was submitted


class FakeSession:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._driver = object()
        self.headers = {}
        self.restored = False

    def _load_mobile_site(self, timeout: int = 0) -> None:
        self.restored = True


class Capture:
    def finish_capture(self, success: bool) -> None:
        pass


def test_handler_falls_back_to_website(db_conn, monkeypatch) -> None:  # noqa: ANN001
    db_conn.execute(
        "INSERT INTO reservations (id, confirmation_number, first_name, last_name) VALUES ('r', 'ABC123', 'Pat', 'K')"
    )
    db_conn.execute(
        "INSERT INTO flights (id, reservation_id, departure_time) VALUES ('f', 'r', '2099-01-03T12:00:00')"
    )
    db_conn.commit()
    session = FakeSession()
    handler = ch.CheckInHandler(
        session,
        "f",
        "ABC123",
        "Pat",
        "K",
        datetime(2099, 1, 3, 12, tzinfo=timezone.utc),
        "PHX",
        "DEN",
        False,
        db.get_connection,
    )
    sent: list[bool] = []
    monkeypatch.setattr(handler, "_send_notification", lambda ok, err="": sent.append(ok))
    monkeypatch.setattr(
        wc,
        "web_check_in",
        lambda *a, **k: {
            "ok": True,
            "status": "checked_in",
            "message": "Checked in on southwest.com",
            "page": "",
        },
    )
    assert handler._web_fallback(Capture()) is True
    row = db_conn.execute(
        "SELECT checkin_status, checkin_result FROM flights WHERE id = 'f'"
    ).fetchone()
    assert row[0] == "success" and "website" in row[1]
    assert sent == [True]
    assert session.restored
    # The website can't either: not settled, so the caller decides
    monkeypatch.setattr(
        wc,
        "web_check_in",
        lambda *a, **k: {"ok": False, "status": "too_early", "message": "", "page": ""},
    )
    assert handler._web_fallback(Capture()) is False


class ReadySession(FakeSession):
    def __init__(self) -> None:
        super().__init__()
        self.headers = {"X-API-Key": "k"}

    def ensure_alive(self) -> None:
        pass


def test_connection_test_reports_both_paths(db_conn, monkeypatch) -> None:  # noqa: ANN001
    import importlib.util
    import json
    from pathlib import Path

    import safety_net

    # worker.py itself (the folder is also a package named "worker")
    spec = importlib.util.spec_from_file_location(
        "worker_main", Path(__file__).parents[1] / "worker.py"
    )
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)

    db_conn.execute(
        "INSERT INTO reservations (id, confirmation_number, first_name, last_name) VALUES ('r', 'ABC123', 'Pat', 'K')"
    )
    db_conn.execute(
        "INSERT INTO flights (id, reservation_id, departure_time) VALUES ('f', 'r', '2099-01-03T12:00:00')"
    )
    db_conn.execute(
        "INSERT INTO system_state (key, value) VALUES ('connection_test_request', '{\"flight_id\": \"f\"}')"
    )
    db_conn.commit()
    monkeypatch.setattr(worker, "browser_session", ReadySession())
    monkeypatch.setattr(worker, "_checkin_within", lambda _h: None)
    monkeypatch.setattr(safety_net, "check_flight_readiness", lambda *a, **k: [])
    submitted: list[bool] = []

    def fake_web(*a, submit: bool = True, **k) -> dict:
        submitted.append(submit)
        return {"ok": True, "status": "form_ready", "message": "form filled", "page": ""}

    monkeypatch.setattr(wc, "web_check_in", fake_web)
    monkeypatch.setattr(wc, "click_checkin", lambda *a, **k: True)
    monkeypatch.setattr(worker.time, "sleep", lambda _s: None)
    worker.browser_session._driver = type(
        "D", (), {"execute_script": lambda self, s: "Check-in is available 24 hours before"}
    )()
    worker.process_connection_tests(db_conn)

    result = json.loads(
        db_conn.execute(
            "SELECT value FROM system_state WHERE key = 'connection_test:f'"
        ).fetchone()[0]
    )
    assert result["done"], result
    assert result["ok"], result
    assert [s["name"] for s in result["steps"]] == [
        "Southwest session",
        "Check-in service (phone-app path)",
        "Website backup (southwest.com)",
    ]
    assert "found the reservation" in result["steps"][2]["detail"]
    assert submitted == [
        False
    ]  # the form is filled with submit=False; only the lookup button is pressed
    assert (
        db_conn.execute(
            "SELECT 1 FROM system_state WHERE key = 'connection_test_request'"
        ).fetchone()
        is None
    )
