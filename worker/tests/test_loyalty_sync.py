from __future__ import annotations

import json
import os
import shutil
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import db
import fake_airline_site as site
import pytest
from selenium import webdriver
from selenium.webdriver.chrome.service import Service

from lib import loyalty_sync as ls

DELTA = ls.PROGRAMS["delta"]


class FakeClient:
    def __init__(self, answer, enabled: bool = True) -> None:  # noqa: ANN001
        self.answer = answer
        self.enabled = enabled

    def chat_json(self, *_args, **_kwargs):  # noqa: ANN201
        return self.answer


OFF = FakeClient(None, enabled=False)


def test_program_files_match() -> None:
    root = Path(__file__).resolve().parents[2]
    worker = json.loads((root / "worker/lib/loyalty_programs.json").read_text())
    frontend = json.loads((root / "frontend/lib/loyalty-programs.json").read_text())
    assert worker == frontend


@pytest.mark.parametrize(
    ("text", "password", "code", "expected"),
    [
        ("Please verify you are human", False, False, "blocked"),
        ("The password you entered is incorrect.", True, False, "bad_login"),
        ("We sent a 6-digit code to c***@example.com", False, False, "needs_code"),
        ("Enter code", False, True, "needs_code"),
        ("Sign in\nPassword", True, False, "login_form"),
        ("Welcome back, Chad. 12,000 miles", False, False, "signed_in"),
        # A long account page that mentions two-step settings is not a code prompt
        ("Two-step verification: on\n" + "x" * 5000, False, False, "signed_in"),
    ],
)
def test_classify_page(text: str, password: bool, code: bool, expected: str) -> None:
    assert ls.classify_page(text, password, code) == expected


def test_heuristic_balance_skips_marketing() -> None:
    text = (
        "Earn 60,000 bonus miles with our card\nSkyMiles balance\n123,456 miles\nTrip: 1,234 miles"
    )
    assert ls.heuristic_balance(text, DELTA) == 123456
    assert ls.heuristic_balance("Available miles: 9,876", DELTA) == 9876
    assert ls.heuristic_balance("Get 50,000 miles when you spend $3,000", DELTA) is None


def test_heuristic_status_needs_status_context() -> None:
    assert ls.heuristic_status("Reach Gold Medallion status faster", DELTA) == ""
    assert ls.heuristic_status("Status: Gold Medallion Member", DELTA) == "Gold Medallion"
    assert (
        ls.heuristic_status("Medallion Status\nPlatinum Medallion", DELTA) == "Platinum Medallion"
    )


def test_llm_answer_must_be_on_page() -> None:
    page = "SkyMiles balance 123,456 miles\nGold Medallion"
    good = FakeClient(
        {"balance": 123456, "status": "Gold Medallion", "status_detail": "MQDs $4,200"}
    )
    assert ls.llm_account_summary(page, DELTA, good) == {
        "balance": 123456, "status": "Gold Medallion", "status_detail": "MQDs $4,200"
    }  # fmt: skip
    invented = FakeClient({"balance": 999999, "status": "Diamond Medallion"})
    assert ls.llm_account_summary(page, DELTA, invented) is None


def test_read_account_falls_back_to_patterns() -> None:
    found = ls.read_account(
        "Status: Gold Medallion Member\nSkyMiles balance 5,000 miles", DELTA, OFF
    )
    assert found == {"balance": 5000, "status": "Gold Medallion", "method": "pattern"}


def _add_account(conn, **fields: object) -> str:  # noqa: ANN001
    row = {"id": "acct1", "program": "delta", "owner_name": "Chad", "sync_enabled": 1}
    row.update(fields)
    cols = ", ".join(row)
    conn.execute(
        f"INSERT INTO loyalty_accounts ({cols}) VALUES ({', '.join('?' * len(row))})",
        list(row.values()),
    )
    conn.commit()
    return row["id"]


def test_due_accounts_respects_interval_failures_and_bad_login(db_conn) -> None:  # noqa: ANN001
    now = datetime(2026, 10, 15, 12, tzinfo=timezone.utc).replace(tzinfo=None)
    _add_account(db_conn, id="new")
    _add_account(db_conn, id="recent", last_synced_at=(now - timedelta(hours=10)).isoformat())
    _add_account(db_conn, id="stale", last_synced_at=(now - timedelta(days=5)).isoformat())
    _add_account(db_conn, id="failing", sync_failures=2)
    _add_account(db_conn, id="rejected", last_sync_status="bad_login")
    _add_account(db_conn, id="off", sync_enabled=0)
    _add_account(
        db_conn, id="asked", sync_enabled=0, sync_requested="manual_signin", sync_failures=5
    )
    ids = [a["id"] for a in ls.due_accounts(db_conn, now)]
    assert ids == ["asked", "new", "stale"]


def test_save_result_records_history_only_on_change(db_conn) -> None:  # noqa: ANN001
    _add_account(db_conn, sync_failures=1, sync_requested="auto")
    account = dict(db_conn.execute("SELECT * FROM loyalty_accounts").fetchone())
    ls.save_result(db_conn, account, {"balance": 1000, "status": "Gold Medallion"})
    account = dict(db_conn.execute("SELECT * FROM loyalty_accounts").fetchone())
    assert (account["balance"], account["status_tier"], account["sync_failures"]) == (
        1000,
        "Gold Medallion",
        0,
    )
    assert account["sync_requested"] is None
    assert account["last_sync_status"] == "ok"
    ls.save_result(db_conn, account, {"balance": 1000, "status": "Gold Medallion"})
    assert db_conn.execute("SELECT COUNT(*) FROM loyalty_history").fetchone()[0] == 1


# --- End to end, in a real Chrome, against a fake airline website ----------
#
# Set SYNC_E2E_CHROME (browser binary) and SYNC_E2E_DRIVER (matching
# chromedriver) to run it.

CHROME = os.environ.get("SYNC_E2E_CHROME")
DRIVER = os.environ.get("SYNC_E2E_DRIVER")


def _chrome_factory(profile_dir: str):  # noqa: ANN202
    options = webdriver.ChromeOptions()
    options.binary_location = CHROME
    # One renderer process: container Chromium builds crash on navigation otherwise
    for arg in (
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--renderer-process-limit=1",
        f"--user-data-dir={profile_dir}",
    ):
        options.add_argument(arg)
    return webdriver.Chrome(
        options=options, service=Service(DRIVER, log_output=os.environ.get("SYNC_E2E_LOG"))
    )


@pytest.mark.skipif(not (CHROME and DRIVER), reason="needs SYNC_E2E_CHROME and SYNC_E2E_DRIVER")
def test_sync_against_fake_airline(db_conn, tmp_path, monkeypatch) -> None:  # noqa: ANN001
    server, base = site.start()
    monkeypatch.setattr(ls, "SETTLE_SECONDS", 1)
    monkeypatch.setattr(ls, "CAPTURE_ROOT", str(tmp_path / "captures"))
    monkeypatch.setattr(ls, "PROFILES_DIR", str(tmp_path / "profiles"))
    monkeypatch.setattr(ls, "LLMClient", lambda: OFF)
    monkeypatch.setattr("lib.llm_browser.LLMClient", lambda: OFF)

    def connect():  # noqa: ANN202
        return db.get_connection()

    _add_account(db_conn, username=site.USERNAME, password=site.PASSWORD, login_url=base + "/")
    alerts: list[str] = []

    def notify(title: str, message: str, severity: str) -> None:  # noqa: ARG001
        alerts.append(title)

        def type_code() -> None:  # the person enters the code on the Miles page
            time.sleep(1)
            c = connect()
            c.execute(
                "UPDATE loyalty_accounts SET pending_code = ? WHERE id = 'acct1'", (site.CODE,)
            )
            c.commit()
            c.close()

        threading.Thread(target=type_code, daemon=True).start()

    def sync() -> str:
        # Container Chromium builds sometimes crash mid-page; that's reported
        # as BROWSER_GONE and is the only failure retried here.
        for _ in range(4):
            account = dict(db_conn.execute("SELECT * FROM loyalty_accounts").fetchone())
            status = ls.sync_account(
                connect, account, notify, threading.Event(), _chrome_factory, decrypt=lambda v: v
            )
            message = db_conn.execute("SELECT last_sync_message FROM loyalty_accounts").fetchone()[
                0
            ]
            if message != ls.BROWSER_GONE:
                return status
            db_conn.execute("UPDATE loyalty_accounts SET sync_failures = 0")
            db_conn.commit()
        raise AssertionError("Chrome kept crashing")

    try:
        status = sync()
        row = dict(db_conn.execute("SELECT * FROM loyalty_accounts").fetchone())
        assert status == "ok", row["last_sync_message"]
        assert (row["balance"], row["status_tier"]) == (123456, "Gold Medallion")
        assert alerts[-1] == "Delta SkyMiles (Chad): verification code needed"
        alerts.clear()

        # Second sync: the saved cookie skips sign-in and the code
        db_conn.execute("UPDATE loyalty_accounts SET balance = 1 WHERE id = 'acct1'")
        db_conn.commit()
        assert sync() == "ok"
        assert alerts == []

        # A wrong password stops automatic syncs
        shutil.rmtree(tmp_path / "profiles")
        db_conn.execute("UPDATE loyalty_accounts SET password = 'nope' WHERE id = 'acct1'")
        db_conn.commit()
        assert sync() == "bad_login"
        assert (
            ls.due_accounts(
                db_conn, datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=30)
            )
            == []
        )
        assert any((tmp_path / "captures" / "acct1").iterdir())
    finally:
        server.shutdown()


def test_runner_clears_stale_syncs_and_pauses_near_checkins(db_conn, monkeypatch) -> None:  # noqa: ANN001
    _add_account(db_conn, id="stale", last_sync_status="running")
    _add_account(db_conn, id="asked", sync_requested="sync", last_sync_status="queued")
    ran: list[str] = []
    monkeypatch.setattr(ls, "sync_account", lambda _cf, account, *_a: ran.append(account["id"]))
    runner = ls.LoyaltySyncRunner(db.get_connection, lambda *_a: None, threading.Event())

    runner.poll(db_conn, pause_reason="check-in for ABC123 within an hour")
    assert ran == []
    assert not runner.busy()
    stale = db_conn.execute("SELECT last_sync_status FROM loyalty_accounts WHERE id = 'stale'")
    assert stale.fetchone()[0] == "error"

    runner.poll(db_conn)
    deadline = time.time() + 5
    while runner.busy() and time.time() < deadline:
        time.sleep(0.05)
    assert ran == ["asked", "stale"]
