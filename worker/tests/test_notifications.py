from __future__ import annotations

import json
from typing import Any

import notifications
import pytest


class FakeApprise:
    sent: list[tuple[str, str]] = []

    def __init__(self) -> None:
        self.url = ""

    def add(self, url: str) -> None:
        self.url = url

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
    assert notifications.notify_test() is True
    assert recipients() == {"everyone", "mom-phone", "dad-problems"}


def test_legacy_level_four_means_problems_only() -> None:
    assert not notifications.wants({"notification_level": 4}, "important", None, False)
    assert notifications.wants({"notification_level": 4}, "critical", None, False)
