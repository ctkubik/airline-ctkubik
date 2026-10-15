# ruff: noqa: DTZ001, DTZ003, E501 - fixed test times; long sample data lines
from __future__ import annotations

import json
from datetime import datetime, timedelta

from lib import flight_status as fs


def leg(
    dep: str = "PHX", status: str = "Expected", revised: str | None = None, gate: str = ""
) -> dict:
    d = {
        "airport": {"iata": dep},
        "scheduledTime": {"utc": "2099-12-04 14:15Z", "local": "2099-12-04 07:15-07:00"},
    }
    if revised:
        d["revisedTime"] = {"utc": revised}
    if gate:
        d["gate"] = gate
    return {
        "number": "DL 1543", "status": status, "departure": d,
        "arrival": {"airport": {"iata": "ATL"}, "scheduledTime": {"utc": "2099-12-04 18:52Z"}},
    }  # fmt: skip


def test_parse_and_pick() -> None:
    assert fs.parse_time({"utc": "2099-12-04 14:15Z"}) == datetime(2099, 12, 4, 14, 15)
    assert fs.parse_time(None) is None
    other = leg(dep="ATL")
    assert (
        fs.pick_flight([other, leg()], "PHX", datetime(2099, 12, 4, 14, 15))["departure"][
            "airport"
        ]["iata"]
        == "PHX"
    )
    assert fs.pick_flight([other], "PHX", None) is None


def test_changes() -> None:
    base = fs.summarize(leg(gate="B5"))
    assert fs.changes(None, base, 15) == ["gate B5"]
    late = fs.summarize(leg(revised="2099-12-04 15:05Z", gate="B9"))
    found = fs.changes(base, late, 15)
    assert found == ["now departs 50 min late", "gate changed B5 → B9"]
    small = fs.summarize(leg(revised="2099-12-04 14:25Z", gate="B5"))
    assert fs.changes(base, small, 15) == []
    assert fs.changes(base, fs.summarize(leg(status="Canceled", gate="B5")), 15) == ["CANCELLED"]


def test_next_check_schedule() -> None:
    dep = datetime(2099, 12, 4, 14, 0)
    assert fs.next_check(dep, dep - timedelta(days=3)) == dep - timedelta(hours=24)
    assert fs.next_check(dep, dep - timedelta(hours=8)) == dep - timedelta(hours=5)
    assert fs.next_check(dep, dep - timedelta(hours=2)) == dep - timedelta(hours=1, minutes=30)
    assert fs.next_check(dep, dep, "Departed") is None
    assert fs.next_check(dep, dep + timedelta(hours=2)) is None


class Session:
    def __init__(self, payloads: list) -> None:
        self.payloads = payloads
        self.urls: list[str] = []

    def get(self, url: str, headers: dict, params: dict, timeout: int):  # noqa: ANN201, ARG002
        self.urls.append(url)
        data = self.payloads.pop(0)

        class R:
            status_code = 200
            text = json.dumps(data)

            def json(self) -> list:
                return data

        return R()


def test_check_statuses_alerts_once_per_change(db_conn, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("AERODATABOX_API_KEY", "k")
    dep = datetime.utcnow() + timedelta(hours=2)
    db_conn.execute(
        "INSERT INTO reservations (id, confirmation_number, first_name, last_name) VALUES ('r', 'ABC123', 'Pat', 'T')"
    )
    db_conn.execute(
        "INSERT INTO flights (id, reservation_id, flight_number, departure_airport, destination_airport, departure_time) "
        "VALUES ('f', 'r', '1234', 'PHX', 'DEN', ?)",
        (dep.isoformat(),),
    )
    db_conn.commit()
    sched = {"utc": dep.strftime("%Y-%m-%d %H:%MZ")}
    later = {"utc": (dep + timedelta(minutes=40)).strftime("%Y-%m-%d %H:%MZ")}
    on_time = {
        "status": "Expected",
        "departure": {"airport": {"iata": "PHX"}, "scheduledTime": sched, "gate": "C3"},
        "arrival": {},
    }
    delayed = {
        "status": "Delayed",
        "departure": {
            "airport": {"iata": "PHX"},
            "scheduledTime": sched,
            "revisedTime": later,
            "gate": "C3",
        },
        "arrival": {},
    }
    session = Session([[on_time], [delayed], [delayed]])
    alerts: list[tuple] = []

    def notify(*a: object, **kw: object) -> None:
        alerts.append((a, kw))

    now = datetime.utcnow()
    assert fs.check_statuses(db_conn, notify, session, now) == 1
    assert alerts == []  # first look: baseline only
    assert "/flights/number/WN1234/" in session.urls[0]
    fs.check_statuses(db_conn, notify, session, now + timedelta(minutes=31))
    assert len(alerts) == 1
    assert "40 min late" in alerts[0][0][1]
    assert alerts[0][1] == {"flight_id": "f"}
    fs.check_statuses(db_conn, notify, session, now + timedelta(minutes=62))
    assert len(alerts) == 1
    assert fs.lookups_used(db_conn) == 3
