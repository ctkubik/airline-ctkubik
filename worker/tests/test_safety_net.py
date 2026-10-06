from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
import safety_net
import watchdog

NOW = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)


class Recorder:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    def __call__(self, title: str, message: str, severity: str = "important", **kw: Any) -> None:
        self.sent.append({"title": title, "message": message, "severity": severity, **kw})


def noop_log(*_: Any, **__: Any) -> None:
    pass


def add_flight(
    conn,
    *,
    checkin_in: timedelta,
    status: str = "scheduled",
    created_ago: timedelta = timedelta(days=3),
) -> str:  # noqa: ANN001, E501
    conn.execute(
        "INSERT OR IGNORE INTO reservations (id, confirmation_number, first_name, last_name) "
        "VALUES ('r1', 'ABC123', 'Pat', 'Traveler')"
    )
    flight_id = f"f{len(conn.execute('SELECT id FROM flights').fetchall()) + 1}"
    departure = NOW + checkin_in + timedelta(days=1)
    conn.execute(
        "INSERT INTO flights (id, reservation_id, flight_number, departure_airport, destination_airport, "
        "departure_time, checkin_status, created_at) VALUES (?, 'r1', '1234', 'PHX', 'DEN', ?, ?, ?)",
        (
            flight_id,
            departure.isoformat(),
            status,
            (NOW - created_ago).strftime("%Y-%m-%d %H:%M:%S"),
        ),
    )
    conn.commit()
    return flight_id


class Handler:
    def __init__(self, alive: bool = True) -> None:
        self.alive = alive

    def is_alive(self) -> bool:
        return self.alive


class Browser:
    def __init__(self, response: Any = None, error: Exception | None = None) -> None:
        self._driver = object()
        self.headers = {"x-api-key": "k"}
        self.response = (
            response if response is not None else {"viewReservationViewPage": {"bounds": [{}]}}
        )
        self.error = error
        self.calls = 0

    def make_request(self, *_: Any, **__: Any) -> Any:
        self.calls += 1
        if self.error:
            raise self.error
        return self.response


def row(conn, flight_id: str) -> dict:  # noqa: ANN001
    return dict(conn.execute("SELECT * FROM flights WHERE id = ?", (flight_id,)).fetchone())


def test_ready_flight_is_recorded_without_alert(db_conn) -> None:  # noqa: ANN001
    fid = add_flight(db_conn, checkin_in=timedelta(hours=2))
    notify = Recorder()
    checked = safety_net.run_readiness_checks(
        db_conn, Browser(), {fid: Handler()}, notify, noop_log, NOW
    )
    assert checked == 1
    assert row(db_conn, fid)["readiness_status"] == "ready"
    assert notify.sent == []


def test_flights_outside_window_are_skipped(db_conn) -> None:  # noqa: ANN001
    add_flight(db_conn, checkin_in=timedelta(hours=5))
    browser = Browser()
    assert safety_net.run_readiness_checks(db_conn, browser, {}, Recorder(), noop_log, NOW) == 0
    assert browser.calls == 0


def test_problem_alerts_after_two_failures_then_clears(db_conn) -> None:  # noqa: ANN001
    fid = add_flight(db_conn, checkin_in=timedelta(hours=2))
    notify = Recorder()
    broken = Browser(error=RuntimeError("403 Forbidden"))

    safety_net.run_readiness_checks(db_conn, broken, {fid: Handler()}, notify, noop_log, NOW)
    assert row(db_conn, fid)["readiness_status"] == "problem"
    assert notify.sent == []  # one failure two hours out: wait and retry

    later = NOW + timedelta(minutes=31)
    safety_net.run_readiness_checks(db_conn, broken, {fid: Handler()}, notify, noop_log, later)
    assert len(notify.sent) == 1
    alert = notify.sent[0]
    assert alert["severity"] == "critical" and alert["flight_id"] == fid
    assert "403 Forbidden" in alert["message"]

    # No repeat while still broken
    safety_net.run_readiness_checks(
        db_conn, broken, {fid: Handler()}, notify, noop_log, later + timedelta(minutes=31)
    )
    assert len(notify.sent) == 1

    # Recovery sends an all-clear
    safety_net.run_readiness_checks(
        db_conn, Browser(), {fid: Handler()}, notify, noop_log, later + timedelta(minutes=62)
    )
    assert len(notify.sent) == 2
    assert "back on track" in notify.sent[1]["title"]


def test_problem_close_to_checkin_alerts_immediately(db_conn) -> None:  # noqa: ANN001
    fid = add_flight(db_conn, checkin_in=timedelta(minutes=30))
    notify = Recorder()
    safety_net.run_readiness_checks(
        db_conn, Browser(), {fid: Handler(alive=False)}, notify, noop_log, NOW
    )
    assert len(notify.sent) == 1
    assert "isn't queued" in notify.sent[0]["message"]


@pytest.mark.parametrize(
    ("browser", "expected"),
    [
        (None, "Chrome session"),
        (Browser(response={"viewReservationViewPage": {"bounds": []}}), "no flights on it"),
    ],
)
def test_problem_descriptions(browser: Any, expected: str) -> None:
    flight = {"first_name": "A", "last_name": "B", "confirmation_number": "ABC123"}
    problems = safety_net.check_flight_readiness(flight, browser, Handler())
    assert any(expected in p for p in problems)


def test_missed_checkin_alerts_once(db_conn) -> None:  # noqa: ANN001
    fid = add_flight(db_conn, checkin_in=-timedelta(minutes=20))
    notify = Recorder()
    assert safety_net.check_missed_checkins(db_conn, notify, noop_log, NOW) == 1
    assert notify.sent[0]["title"] == "Check in now: ABC123"
    assert safety_net.check_missed_checkins(db_conn, notify, noop_log, NOW) == 0
    assert row(db_conn, fid)["missed_alerted"] == 1


def test_missed_checkin_grace_and_late_added_flights(db_conn) -> None:  # noqa: ANN001
    add_flight(db_conn, checkin_in=-timedelta(minutes=5))  # still within grace
    # Added 2 minutes ago, check-in opened 3 hours ago: being checked in now
    add_flight(db_conn, checkin_in=-timedelta(hours=3), created_ago=timedelta(minutes=2))
    add_flight(db_conn, checkin_in=-timedelta(hours=3), status="success")
    notify = Recorder()
    assert safety_net.check_missed_checkins(db_conn, notify, noop_log, NOW) == 0


def test_watchdog_alerts_when_heartbeat_stale_and_recovers(db_conn, monkeypatch) -> None:  # noqa: ANN001
    import db

    monkeypatch.setattr(watchdog, "get_connection", db.get_connection)
    notify = Recorder()
    db_conn.execute(
        "INSERT INTO system_state (key, value, updated_at) VALUES ('worker_alive', '1', datetime('now', '-20 minutes'))"
    )
    db_conn.commit()
    assert "stopped running" in watchdog.check_once(notify)
    assert len(notify.sent) == 1 and notify.sent[0]["severity"] == "critical"
    watchdog.check_once(notify)
    assert len(notify.sent) == 1  # no repeat

    safety_net.set_state(db_conn, "worker_alive", "1")
    safety_net.set_state(db_conn, "worker_loop", "ok")
    assert watchdog.check_once(notify) is None
    assert "running again" in notify.sent[1]["title"]


def test_watchdog_startup_grace(db_conn, monkeypatch) -> None:  # noqa: ANN001
    import db

    monkeypatch.setattr(watchdog, "get_connection", db.get_connection)
    notify = Recorder()
    assert watchdog.check_once(notify) is None  # first look: never started yet, give it time
    assert notify.sent == []
