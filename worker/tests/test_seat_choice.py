# ruff: noqa: DTZ003, E501 - test times; long SQL lines
from __future__ import annotations

from datetime import datetime, timedelta

import db
from lib.seat_choice import (
    SeatPrefs,
    choose,
    current_seat_from_text,
    is_better,
    is_free,
    page_asks_for_payment,
    tier,
)

PREFS = SeatPrefs.from_row(
    {
        "preferred_letters": "A,F",
        "preferred_rows": "1-6",
        "fallback_letters": "A,C,D,F",
        "avoid_rows": "30",
    }
)


def seat(s: str, **extra: object) -> dict:
    return {"seat": s, "className": "seat available", "disabled": False, "text": s, **extra}


def test_tiers() -> None:
    assert PREFS.preferred_rows == [1, 2, 3, 4, 5, 6]
    assert [tier(s, PREFS) for s in ("3A", "14F", "4C", "20D", "12B", "30A", "?")] == [
        4,
        3,
        2,
        1,
        0,
        -1,
        None,
    ]


def test_only_strictly_better_seats() -> None:
    assert is_better("3A", "14F", PREFS)  # window in a preferred row beats any window
    assert is_better("14F", "12B", PREFS)  # window beats a middle seat
    assert not is_better("14A", "12F", PREFS)  # same tier: not worth the change
    assert is_better("12B", "30A", PREFS)
    assert not is_better("3C", "3A", PREFS)  # aisle up front is worse than window up front


def test_row_gain_option() -> None:
    prefs = SeatPrefs.from_row(
        {"preferred_letters": "A,F", "preferred_rows": "1-6", "min_row_gain": "5"}
    )
    assert is_better("10A", "18F", prefs)
    assert not is_better("15A", "18F", prefs)


def test_unknown_current_seat_takes_only_top_choices() -> None:
    assert is_better("2F", None, PREFS)
    assert not is_better("14F", None, PREFS)


def test_paid_seats_are_never_chosen() -> None:
    assert not is_free(seat("1A", aria="Seat 1A, Extra Legroom"))
    assert not is_free(seat("2A", text="2A $39"))
    assert not is_free(seat("3A", price=1))
    assert is_free(seat("4A", aria="Seat 4A, available"))
    best, why = choose([seat("1A", text="1A $49"), seat("5F"), seat("2A")], "20C", PREFS)
    assert best["seat"] == "2A"
    assert "1 paid seats skipped" in why


def test_choose_skips_taken_and_keeps_current_when_nothing_better() -> None:
    available = [seat("3A", className="seat occupied"), seat("14F"), seat("20B", disabled=True)]
    best, why = choose(available, "12A", PREFS)
    assert best is None
    assert "none better than 12A" in why


def test_page_reading() -> None:
    assert current_seat_from_text("Passenger CHAD K\nSeat: 14C\nBoarding group B") == "14C"
    assert current_seat_from_text("No seat yet") is None
    assert page_asks_for_payment("Seat 1A\nTotal due today: $49.00\nCard number")
    assert not page_asks_for_payment("Seat 3A selected. Total due: $0.00")


def test_checked_in_flights_queue_for_seat_picking(db_conn) -> None:  # noqa: ANN001
    dep = (datetime.utcnow() + timedelta(hours=20)).isoformat()
    db_conn.execute(
        "INSERT INTO reservations (id, confirmation_number, first_name, last_name) "
        "VALUES ('r', 'ABC123', 'Pat', 'T')"
    )
    db_conn.execute(
        "INSERT INTO flights (id, reservation_id, departure_time, checkin_status, last_seat_upgrade_attempt) "
        "VALUES ('f', 'r', ?, 'pending', '2000-01-01')",
        (dep,),
    )
    db_conn.execute("INSERT INTO seat_preferences (id, pick_at_checkin) VALUES ('default', 0)")
    db_conn.commit()
    assert db.get_flights_for_seat_upgrade(db_conn) == []
    db.update_flight_status(db_conn, "f", "success", "{}")
    assert db.get_flights_for_seat_upgrade(db_conn) == []  # setting off
    db_conn.execute("UPDATE seat_preferences SET pick_at_checkin = 1")
    db_conn.commit()
    [flight] = db.get_flights_for_seat_upgrade(db_conn)
    assert flight["last_seat_upgrade_attempt"] is None  # check-in cleared the cooldown


def test_account_preferences_override_shared(db_conn) -> None:  # noqa: ANN001
    dep = (datetime.utcnow() + timedelta(hours=20)).isoformat()
    db_conn.execute(
        "INSERT INTO accounts (id, username, password) VALUES ('a1', 'chad', 'x'), ('a2', 'pat', 'x')"
    )
    db_conn.executescript(
        "INSERT INTO reservations (id, account_id, confirmation_number, first_name, last_name) "
        "VALUES ('r1', 'a1', 'AAA111', 'Chad', 'K'), ('r2', 'a2', 'BBB222', 'Pat', 'K');"
    )
    for fid, rid in (("f1", "r1"), ("f2", "r2")):
        db_conn.execute(
            "INSERT INTO flights (id, reservation_id, departure_time, checkin_status) VALUES (?, ?, ?, 'success')",
            (fid, rid, dep),
        )
    db_conn.execute(
        "INSERT INTO seat_preferences (id, preferred_letters, fare_check_mode, pick_at_checkin) "
        "VALUES ('default', 'A,F', 'same_day_nonstop', 0), ('account:a2', 'C,D', 'same_flight', 1)"
    )
    db_conn.commit()
    assert db.get_seat_preferences(db_conn, "a1")["preferred_letters"] == "A,F"
    own = db.get_seat_preferences(db_conn, "a2")
    assert (own["preferred_letters"], own["fare_check_mode"]) == ("C,D", "same_flight")
    # Only Pat's account turned seat picking on
    assert [f["id"] for f in db.get_flights_for_seat_upgrade(db_conn)] == ["f2"]
    assert db.get_flights_for_seat_upgrade(db_conn)[0]["pref_account_id"] == "a2"
