from __future__ import annotations

import json
from typing import Any

import notifications
import pytest


class FakeApprise:
    sent: list[tuple[str, str]] = []

    def __init__(self) -> None:
        self.url = ""

    def add(self, url: str) -> bool:
        self.url = url
        return True

    def notify(self, title: str, **_: Any) -> bool:
        FakeApprise.sent.append((self.url, title))
        return True


@pytest.fixture
def services(db_conn, monkeypatch) -> list:  # noqa: ANN001
    import db

    monkeypatch.setattr(notifications, "get_connection", db.get_connection)
    monkeypatch.setattr(notifications.apprise, "Apprise", FakeApprise)
    FakeApprise.sent = []
    db_conn.executescript(
        """
        INSERT INTO accounts (id, username, password) VALUES ('mom', 'm', 'x'), ('dad', 'd', 'x');
        INSERT INTO reservations (id, account_id, confirmation_number, first_name, last_name)
            VALUES ('r-mom', 'mom', 'MOM111', 'Mom', 'K');
        INSERT INTO reservations (id, account_id, owner_account_id, confirmation_number, first_name, last_name)
            VALUES ('r-manual', NULL, 'dad', 'DAD222', 'Dad', 'K');
        INSERT INTO reservations (id, confirmation_number, first_name, last_name)
            VALUES ('r-unassigned', 'ANY333', 'Guest', 'K');
        INSERT INTO flights (id, reservation_id, departure_time) VALUES
            ('f-mom', 'r-mom', '2030-01-01T00:00:00+00:00'),
            ('f-dad', 'r-manual', '2030-01-01T00:00:00+00:00'),
            ('f-any', 'r-unassigned', '2030-01-01T00:00:00+00:00');
        """
    )
    rows = [
        ("everyone", 1, None),
        ("mom-phone", 1, json.dumps(["mom"])),
        ("dad-problems", 3, json.dumps(["dad"])),
    ]
    for url, level, scope in rows:
        db_conn.execute(
            "INSERT INTO notification_configs (id, service_url, notification_level, account_ids) "
            "VALUES (?, ?, ?, ?)",
            (url, url, level, scope),
        )
    db_conn.commit()
    return rows


def recipients() -> set[str]:
    return {url for url, _ in FakeApprise.sent}


@pytest.mark.usefixtures("services")
def test_trip_alert_goes_to_its_traveler_and_everyone_services() -> None:
    notifications.send_notification("t", "m", "important", flight_id="f-mom")
    assert recipients() == {"everyone", "mom-phone"}


@pytest.mark.usefixtures("services")
def test_manual_reservation_uses_its_assigned_owner() -> None:
    notifications.send_notification("t", "m", "critical", flight_id="f-dad")
    assert recipients() == {"everyone", "dad-problems"}


@pytest.mark.usefixtures("services")
def test_levels_filter_routine_messages() -> None:
    notifications.send_notification("t", "m", "info", flight_id="f-dad")
    assert recipients() == {"everyone"}  # dad-problems only wants problems


@pytest.mark.usefixtures("services")
def test_unassigned_trip_and_system_alerts_reach_everyone() -> None:
    notifications.send_notification("t", "m", "critical", flight_id="f-any")
    assert recipients() == {"everyone", "mom-phone", "dad-problems"}
    FakeApprise.sent = []
    notifications.send_notification("t", "m", "critical")
    assert recipients() == {"everyone", "mom-phone", "dad-problems"}


@pytest.mark.usefixtures("services")
def test_confirmation_number_routing_and_test_message() -> None:
    notifications.send_notification("t", "m", "important", confirmation_number="MOM111")
    assert recipients() == {"everyone", "mom-phone"}
    FakeApprise.sent = []
    results = notifications.notify_test()
    assert [r["ok"] for r in results] == [True, True, True]
    assert recipients() == {"everyone", "mom-phone", "dad-problems"}


def test_legacy_level_four_means_problems_only() -> None:
    assert not notifications.wants({"notification_level": 4}, "important", None, False)
    assert notifications.wants({"notification_level": 4}, "critical", None, False)


class FailingTelegram(FakeApprise):
    def notify(self, title: str, **_: Any) -> bool:
        import logging

        logging.getLogger("apprise").warning(
            "Failed to send Telegram notification: Bad Request: chat not found error=400."
        )
        return False


def test_failure_reason_is_saved_and_logged(db_conn, monkeypatch) -> None:  # noqa: ANN001
    import db

    monkeypatch.setattr(notifications, "get_connection", db.get_connection)
    monkeypatch.setattr(notifications.apprise, "Apprise", FailingTelegram)
    db_conn.execute(
        "INSERT INTO notification_configs (id, service_url, label) VALUES ('tg', 'tgram://1:abc/42', 'My phone')"
    )
    db_conn.commit()
    results = notifications.notify_test()
    assert results[0]["ok"] is False
    assert "can't find that chat" in results[0]["error"]
    row = db_conn.execute("SELECT last_status, last_error, last_sent_at FROM notification_configs").fetchone()
    assert row["last_status"] == "failed"
    assert "chat not found" in row["last_error"]
    assert row["last_sent_at"]
    notifications.send_notification("t", "m", "critical")
    log = db_conn.execute("SELECT message FROM worker_logs ORDER BY id DESC LIMIT 1").fetchone()
    assert "My phone" in log["message"] and "chat not found" in log["message"]


def test_unreadable_url_is_reported(db_conn, monkeypatch) -> None:  # noqa: ANN001
    import db

    monkeypatch.setattr(notifications, "get_connection", db.get_connection)
    db_conn.execute("INSERT INTO notification_configs (id, service_url) VALUES ('bad', 'nonsense://')")
    db_conn.commit()
    results = notifications.notify_test("bad")
    assert results == [
        {"label": "nonsense service", "ok": False, "error": results[0]["error"]}
    ]
    assert "can't read this service URL" in results[0]["error"]


@pytest.mark.usefixtures("services")
def test_test_message_can_target_one_service() -> None:
    results = notifications.notify_test("mom-phone")
    assert len(results) == 1 and recipients() == {"mom-phone"}


def test_explain_failure_plain_language() -> None:
    log = "2026 - WARNING - Failed to send Telegram notification: Unauthorized error=401."
    assert "bot token" in notifications.explain_failure("tgram://x/1", log)
    assert "online" in notifications.explain_failure(
        "discord://a/b", "x - WARNING - A connection error occurred sending Discord notification."
    )
    assert notifications.explain_failure("tgram://x/1", "") .startswith("The service didn't accept")
