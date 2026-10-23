# ruff: noqa: SLF001, DTZ003 - driving the handler directly with fixed times
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import db

from lib import checkin_handler as ch


def make_handler(db_conn, hours: int) -> ch.CheckInHandler:  # noqa: ANN001
    db_conn.execute(
        "INSERT INTO reservations (id, confirmation_number, first_name, last_name) VALUES ('r', 'ABC123', 'Pat', 'K')"
    )
    db_conn.execute(
        "INSERT INTO flights (id, reservation_id, departure_time, checkin_hours) VALUES ('f', 'r', '2099-01-03T12:00:00', ?)",
        (hours,),
    )
    db_conn.commit()
    return ch.CheckInHandler(
        None,
        "f",
        "ABC123",
        "Pat",
        "K",
        datetime(2099, 1, 3, 12, tzinfo=timezone.utc),
        "PHX",
        "DEN",
        False,
        db.get_connection,
        checkin_hours=hours,
    )


def test_alist_falls_back_to_24_hours(db_conn, monkeypatch) -> None:  # noqa: ANN001
    handler = make_handler(db_conn, 48)
    waited: list[datetime] = []
    calls: list[bool] = []
    monkeypatch.setattr(handler, "_wait_for_check_in", waited.append)
    monkeypatch.setattr(handler, "_check_in", lambda final=True: calls.append(final) or final)
    handler._set_check_in()
    assert waited == [
        datetime(2099, 1, 1, 12, tzinfo=timezone.utc),
        datetime(2099, 1, 2, 12, tzinfo=timezone.utc),
    ]
    assert calls == [False, True]  # the 48-hour try may be refused; the 24-hour one is final
    row = db_conn.execute(
        "SELECT checkin_hours, checkin_status FROM flights WHERE id = 'f'"
    ).fetchone()
    assert (row[0], row[1]) == (24, "scheduled")


def test_alist_early_success_stops_there(db_conn, monkeypatch) -> None:  # noqa: ANN001
    handler = make_handler(db_conn, 48)
    calls: list[bool] = []
    monkeypatch.setattr(handler, "_wait_for_check_in", lambda _t: None)
    monkeypatch.setattr(handler, "_check_in", lambda final=True: calls.append(final) or True)
    handler._set_check_in()
    assert calls == [False]
    assert handler.checkin_time == datetime(2099, 1, 1, 12, tzinfo=timezone.utc)


def test_standard_account_checks_in_once(db_conn, monkeypatch) -> None:  # noqa: ANN001
    handler = make_handler(db_conn, 24)
    calls: list[bool] = []
    monkeypatch.setattr(handler, "_wait_for_check_in", lambda _t: None)
    monkeypatch.setattr(handler, "_check_in", lambda final=True: calls.append(final) or True)
    handler._set_check_in()
    assert calls == [True]


def test_pending_flights_know_alist(db_conn) -> None:  # noqa: ANN001
    dep = (datetime.utcnow() + timedelta(days=5)).isoformat()
    db_conn.execute(
        "INSERT INTO accounts (id, username, password, is_alist) VALUES ('a', 'u', 'p', 1)"
    )
    db_conn.execute(
        "INSERT INTO reservations (id, account_id, confirmation_number, first_name, last_name) VALUES ('r1', 'a', 'AAA111', 'C', 'K')"
    )
    db_conn.execute(
        "INSERT INTO reservations (id, confirmation_number, first_name, last_name) VALUES ('r2', 'BBB222', 'P', 'K')"
    )
    db_conn.execute(
        "INSERT INTO flights (id, reservation_id, departure_time) VALUES ('f1', 'r1', ?), ('f2', 'r2', ?)",
        (dep, dep),
    )
    db_conn.commit()
    flags = {f["id"]: f["is_alist"] for f in db.get_pending_flights(db_conn)}
    assert flags == {"f1": 1, "f2": 0}
