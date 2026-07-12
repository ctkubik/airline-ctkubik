"""SQLite database client for the check-in worker."""

import json
import os
import sqlite3
import threading
from datetime import datetime, timedelta

DB_PATH = os.environ.get("DB_PATH", os.path.join("/app", "data", "checkin.db"))

_schema_lock = threading.Lock()
_schema_initialized = False


def get_connection() -> sqlite3.Connection:
    global _schema_initialized
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.execute("PRAGMA foreign_keys=ON")
    with _schema_lock:
        if not _schema_initialized:
            _init_tables(conn)
            _migrate(conn)
            _schema_initialized = True
    return conn


def _init_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            password TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            retrieval_interval INTEGER DEFAULT 24,
            owner_user_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS worker_status (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            last_poll_at TEXT,
            browser_ok INTEGER DEFAULT 0,
            note TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS reservations (
            id TEXT PRIMARY KEY,
            account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
            confirmation_number TEXT NOT NULL,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            owner_user_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS flights (
            id TEXT PRIMARY KEY,
            reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
            flight_number TEXT,
            departure_airport TEXT,
            destination_airport TEXT,
            departure_time TEXT NOT NULL,
            is_international INTEGER DEFAULT 0,
            checkin_status TEXT DEFAULT 'pending',
            checkin_result TEXT,
            checkin_attempted_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS fare_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
            price_change INTEGER NOT NULL,
            currency_code TEXT NOT NULL DEFAULT 'USD',
            checked_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS seat_preferences (
            id TEXT PRIMARY KEY DEFAULT 'default',
            preferred_letters TEXT DEFAULT 'A,F',
            preferred_rows TEXT DEFAULT '1,2,3,4,5,6',
            fallback_letters TEXT DEFAULT 'A,C,D,F',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS notification_configs (
            id TEXT PRIMARY KEY,
            service_url TEXT NOT NULL,
            notification_level INTEGER DEFAULT 1,
            is_active INTEGER DEFAULT 1,
            user_id TEXT,
            label TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS worker_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            flight_id TEXT REFERENCES flights(id) ON DELETE SET NULL,
            level TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS diagnostics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            endpoint TEXT,
            expected_behavior TEXT,
            actual_behavior TEXT,
            headers_snapshot TEXT,
            response_snapshot TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS checkin_captures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
            capture_dir TEXT NOT NULL,
            manifest_json TEXT,
            file_count INTEGER DEFAULT 0,
            total_size_bytes INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS seat_upgrade_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            flight_id TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            status TEXT DEFAULT 'in_progress',
            steps_json TEXT,
            browser_console_json TEXT,
            capture_dir TEXT,
            error_message TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name TEXT DEFAULT '',
            role TEXT NOT NULL DEFAULT 'member',
            is_active INTEGER DEFAULT 1,
            calendar_token TEXT,
            totp_secret TEXT,
            totp_enabled INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            owner_user_id TEXT,
            doc_type TEXT NOT NULL DEFAULT 'other',
            label TEXT DEFAULT '',
            holder_name TEXT DEFAULT '',
            airline TEXT,
            number_enc TEXT DEFAULT '',
            expiration_date TEXT,
            notes TEXT DEFAULT '',
            notified_30d INTEGER DEFAULT 0,
            notified_7d INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS fare_watches (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            name TEXT NOT NULL,
            origin TEXT NOT NULL,
            destination TEXT NOT NULL,
            depart_date_start TEXT NOT NULL,
            depart_date_end TEXT NOT NULL,
            return_date_start TEXT,
            return_date_end TEXT,
            adults INTEGER DEFAULT 1,
            nonstop_only INTEGER DEFAULT 0,
            max_price REAL,
            is_active INTEGER DEFAULT 1,
            created_by TEXT DEFAULT '',
            last_checked_at TEXT,
            last_error TEXT,
            best_price REAL,
            best_price_currency TEXT DEFAULT 'USD',
            best_departure_date TEXT,
            best_return_date TEXT,
            best_airline TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS fare_watch_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id TEXT NOT NULL,
            price REAL NOT NULL,
            currency TEXT DEFAULT 'USD',
            departure_date TEXT,
            return_date TEXT,
            airline TEXT,
            details_json TEXT,
            checked_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS travel_credits (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            owner_user_id TEXT,
            owner_name TEXT DEFAULT '',
            confirmation_number TEXT NOT NULL,
            amount REAL NOT NULL,
            currency TEXT DEFAULT 'USD',
            expiration_date TEXT,
            notes TEXT DEFAULT '',
            is_used INTEGER DEFAULT 0,
            source TEXT DEFAULT 'manual',
            external_id TEXT,
            notified_30d INTEGER DEFAULT 0,
            notified_7d INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS trips (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            owner_user_id TEXT,
            name TEXT NOT NULL,
            destination TEXT DEFAULT '',
            start_date TEXT,
            end_date TEXT,
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        """
    )


def _migrate(conn: sqlite3.Connection) -> None:
    """Run schema migrations that can't be handled by CREATE TABLE IF NOT EXISTS."""
    # Flights table migrations
    flight_cols = [row[1] for row in conn.execute("PRAGMA table_info(flights)").fetchall()]
    if "reservation_info_json" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN reservation_info_json TEXT")
    if "assigned_seat" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN assigned_seat TEXT")
    if "original_price" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN original_price INTEGER")
    if "original_currency" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN original_currency TEXT DEFAULT 'USD'")
    if "last_seat_upgrade_attempt" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN last_seat_upgrade_attempt TEXT")
    if "flight_status" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN flight_status TEXT")
    if "flight_status_detail" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN flight_status_detail TEXT")
    if "flight_status_checked_at" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN flight_status_checked_at TEXT")
    if "flight_status_notified" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN flight_status_notified TEXT")
    if "airline" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN airline TEXT")
    if "auto_checkin" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN auto_checkin INTEGER DEFAULT 1")
    if "checkin_reminder_sent" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN checkin_reminder_sent INTEGER DEFAULT 0")
    if "trip_id" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN trip_id TEXT")
    if "aircraft" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN aircraft TEXT")
    if "arrival_status" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN arrival_status TEXT")
    if "arrival_notified" not in flight_cols:
        conn.execute("ALTER TABLE flights ADD COLUMN arrival_notified TEXT")

    res_cols2 = [row[1] for row in conn.execute("PRAGMA table_info(reservations)").fetchall()]
    if "is_southwest" not in res_cols2:
        conn.execute("ALTER TABLE reservations ADD COLUMN is_southwest INTEGER DEFAULT 1")

    # Accounts table migrations
    account_cols = [row[1] for row in conn.execute("PRAGMA table_info(accounts)").fetchall()]
    if "is_alist" not in account_cols:
        conn.execute("ALTER TABLE accounts ADD COLUMN is_alist INTEGER DEFAULT 0")
    if "auto_upgrade_seats" not in account_cols:
        conn.execute("ALTER TABLE accounts ADD COLUMN auto_upgrade_seats INTEGER DEFAULT 0")
    if "display_name" not in account_cols:
        conn.execute("ALTER TABLE accounts ADD COLUMN display_name TEXT DEFAULT ''")
    if "login_failure_count" not in account_cols:
        conn.execute("ALTER TABLE accounts ADD COLUMN login_failure_count INTEGER DEFAULT 0")

    # fare_history table migrations
    fh_cols = [row[1] for row in conn.execute("PRAGMA table_info(fare_history)").fetchall()]
    if fh_cols:
        if "best_flight_number" not in fh_cols:
            conn.execute("ALTER TABLE fare_history ADD COLUMN best_flight_number TEXT")
        if "best_flight_nonstop" not in fh_cols:
            conn.execute("ALTER TABLE fare_history ADD COLUMN best_flight_nonstop INTEGER DEFAULT 0")
        if "best_flight_stops" not in fh_cols:
            conn.execute("ALTER TABLE fare_history ADD COLUMN best_flight_stops TEXT")
        if "best_flight_depart_time" not in fh_cols:
            conn.execute("ALTER TABLE fare_history ADD COLUMN best_flight_depart_time TEXT")
        if "my_flight_fare" not in fh_cols:
            conn.execute("ALTER TABLE fare_history ADD COLUMN my_flight_fare INTEGER")

    # seat_preferences migration for fare_check_mode
    sp_cols = [row[1] for row in conn.execute("PRAGMA table_info(seat_preferences)").fetchall()]
    if sp_cols and "fare_check_mode" not in sp_cols:
        conn.execute("ALTER TABLE seat_preferences ADD COLUMN fare_check_mode TEXT DEFAULT 'same_day_nonstop'")

    # Ownership + credit-source migrations
    if "owner_user_id" not in account_cols:
        conn.execute("ALTER TABLE accounts ADD COLUMN owner_user_id TEXT")

    res_cols = [row[1] for row in conn.execute("PRAGMA table_info(reservations)").fetchall()]
    if "owner_user_id" not in res_cols:
        conn.execute("ALTER TABLE reservations ADD COLUMN owner_user_id TEXT")

    tc_cols = [row[1] for row in conn.execute("PRAGMA table_info(travel_credits)").fetchall()]
    if tc_cols:
        if "owner_user_id" not in tc_cols:
            conn.execute("ALTER TABLE travel_credits ADD COLUMN owner_user_id TEXT")
        if "source" not in tc_cols:
            conn.execute("ALTER TABLE travel_credits ADD COLUMN source TEXT DEFAULT 'manual'")
        if "external_id" not in tc_cols:
            conn.execute("ALTER TABLE travel_credits ADD COLUMN external_id TEXT")

    if "last_login_success" not in account_cols:
        conn.execute("ALTER TABLE accounts ADD COLUMN last_login_success TEXT")
    if "last_login_error" not in account_cols:
        conn.execute("ALTER TABLE accounts ADD COLUMN last_login_error TEXT")

    user_cols = [row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()]
    if user_cols:
        if "calendar_token" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN calendar_token TEXT")
        if "totp_secret" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN totp_secret TEXT")
        if "totp_enabled" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0")

    doc_cols = [row[1] for row in conn.execute("PRAGMA table_info(documents)").fetchall()]
    if doc_cols and "airline" not in doc_cols:
        conn.execute("ALTER TABLE documents ADD COLUMN airline TEXT")

    nc_cols = [row[1] for row in conn.execute("PRAGMA table_info(notification_configs)").fetchall()]
    if nc_cols:
        if "user_id" not in nc_cols:
            conn.execute("ALTER TABLE notification_configs ADD COLUMN user_id TEXT")
        if "label" not in nc_cols:
            conn.execute("ALTER TABLE notification_configs ADD COLUMN label TEXT DEFAULT ''")

    conn.commit()


def get_active_accounts(conn: sqlite3.Connection) -> list[dict]:
    from lib.secrets import decrypt_secret

    rows = conn.execute("SELECT * FROM accounts WHERE is_active = 1").fetchall()
    accounts = []
    for r in rows:
        account = dict(r)
        account["password"] = decrypt_secret(account["password"])
        accounts.append(account)
    return accounts


def encrypt_legacy_passwords(conn: sqlite3.Connection) -> int:
    """One-time migration: encrypt any plaintext Southwest passwords at rest."""
    from lib.secrets import encrypt_secret, is_encrypted, _get_key

    if _get_key() is None:
        return 0  # no AUTH_SECRET (dev) — leave as-is
    rows = conn.execute("SELECT id, password FROM accounts").fetchall()
    migrated = 0
    for row in rows:
        if not is_encrypted(row["password"]):
            conn.execute(
                "UPDATE accounts SET password = ? WHERE id = ?",
                (encrypt_secret(row["password"]), row["id"]),
            )
            migrated += 1
    if migrated:
        conn.commit()
    return migrated


def get_expiring_documents(conn: sqlite3.Connection, within_days: int, flag_column: str) -> list[dict]:
    """Documents expiring within N days that haven't been alerted on this window."""
    rows = conn.execute(
        f"SELECT d.*, u.display_name AS owner_display_name FROM documents d "
        f"LEFT JOIN users u ON u.id = d.owner_user_id "
        f"WHERE d.{flag_column} = 0 AND d.expiration_date IS NOT NULL "
        f"AND date(d.expiration_date) >= date('now') "
        f"AND date(d.expiration_date) <= date('now', ?)",
        (f"+{int(within_days)} days",),
    ).fetchall()
    return [dict(r) for r in rows]


def get_expiring_credits(conn: sqlite3.Connection, within_days: int, flag_column: str) -> list[dict]:
    """Active, unused credits expiring within N days that haven't been notified yet."""
    rows = conn.execute(
        f"SELECT tc.*, a.display_name AS account_display_name FROM travel_credits tc "
        f"LEFT JOIN accounts a ON a.id = tc.account_id "
        f"WHERE tc.is_used = 0 AND tc.{flag_column} = 0 "
        f"AND tc.expiration_date IS NOT NULL "
        f"AND date(tc.expiration_date) >= date('now') "
        f"AND date(tc.expiration_date) <= date('now', ?)",
        (f"+{int(within_days)} days",),
    ).fetchall()
    return [dict(r) for r in rows]


def get_active_reservations(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT * FROM reservations WHERE is_active = 1").fetchall()
    return [dict(r) for r in rows]


def get_pending_flights(conn: sqlite3.Connection) -> list[dict]:
    now = datetime.utcnow().isoformat()
    rows = conn.execute(
        "SELECT f.*, r.confirmation_number, r.first_name, r.last_name "
        "FROM flights f JOIN reservations r ON r.id = f.reservation_id "
        "WHERE f.checkin_status IN ('pending', 'scheduled') "
        "AND f.departure_time > ? "
        "AND (f.auto_checkin = 1 OR f.auto_checkin IS NULL) "
        "ORDER BY f.departure_time ASC",
        (now,),
    ).fetchall()
    return [dict(r) for r in rows]


def recover_stuck_checkins(conn: sqlite3.Connection) -> int:
    """Reset future flights stuck in 'checking_in' back to 'pending'.

    If the worker restarts (crash, deploy, container restart) while a check-in
    thread is mid-flight, the row stays 'checking_in' forever and is never
    rescheduled because get_pending_flights only selects pending/scheduled.
    Called once at worker startup, when no handler threads can exist yet.
    """
    now = datetime.utcnow().isoformat()
    cursor = conn.execute(
        "UPDATE flights SET checkin_status = 'pending' "
        "WHERE checkin_status = 'checking_in' AND departure_time > ?",
        (now,),
    )
    conn.commit()
    return cursor.rowcount


def upsert_flight(
    conn: sqlite3.Connection,
    reservation_id: str,
    flight_number: str,
    departure_airport: str,
    destination_airport: str,
    departure_time: str,
    is_international: bool,
    original_price: int | None = None,
    original_currency: str = "USD",
) -> str:
    """Insert a flight or return existing flight id if it already exists."""
    existing = conn.execute(
        "SELECT id FROM flights WHERE reservation_id = ? AND flight_number = ? AND departure_time = ?",
        (reservation_id, flight_number, departure_time),
    ).fetchone()
    if existing:
        # Always update airports unconditionally - new extraction is authoritative
        conn.execute(
            "UPDATE flights SET departure_airport = ?, destination_airport = ? WHERE id = ?",
            (departure_airport, destination_airport, existing["id"]),
        )
        conn.commit()
        return existing["id"]

    import uuid

    flight_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO flights (id, reservation_id, flight_number, departure_airport, "
        "destination_airport, departure_time, is_international, original_price, original_currency) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            flight_id,
            reservation_id,
            flight_number,
            departure_airport,
            destination_airport,
            departure_time,
            1 if is_international else 0,
            original_price,
            original_currency,
        ),
    )
    conn.commit()
    return flight_id


def update_flight_status(
    conn: sqlite3.Connection,
    flight_id: str,
    status: str,
    result: str | None = None,
) -> None:
    if result:
        conn.execute(
            "UPDATE flights SET checkin_status = ?, checkin_result = ?, "
            "checkin_attempted_at = datetime('now') WHERE id = ?",
            (status, result, flight_id),
        )
    else:
        conn.execute(
            "UPDATE flights SET checkin_status = ? WHERE id = ?",
            (status, flight_id),
        )
    conn.commit()


def add_log(
    conn: sqlite3.Connection,
    message: str,
    level: str = "info",
    flight_id: str | None = None,
) -> None:
    conn.execute(
        "INSERT INTO worker_logs (flight_id, level, message) VALUES (?, ?, ?)",
        (flight_id, level, message),
    )
    conn.commit()


def upsert_reservation(
    conn: sqlite3.Connection,
    account_id: str,
    confirmation_number: str,
    first_name: str,
    last_name: str,
) -> str:
    """Insert or update a reservation tied to an account. Returns the reservation id."""
    existing = conn.execute(
        "SELECT id FROM reservations WHERE account_id = ? AND confirmation_number = ?",
        (account_id, confirmation_number),
    ).fetchone()

    if existing:
        conn.execute(
            "UPDATE reservations SET first_name = ?, last_name = ?, is_active = 1, "
            "updated_at = datetime('now') WHERE id = ?",
            (first_name, last_name, existing["id"]),
        )
        conn.commit()
        return existing["id"]

    import uuid
    res_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO reservations (id, account_id, confirmation_number, first_name, last_name) "
        "VALUES (?, ?, ?, ?, ?)",
        (res_id, account_id, confirmation_number, first_name, last_name),
    )
    conn.commit()
    return res_id


def deactivate_stale_reservations(
    conn: sqlite3.Connection,
    account_id: str,
    active_confirmation_numbers: list[str],
) -> None:
    """Mark reservations as inactive if they're no longer returned by the API."""
    if not active_confirmation_numbers:
        return
    placeholders = ",".join("?" for _ in active_confirmation_numbers)
    conn.execute(
        f"UPDATE reservations SET is_active = 0, updated_at = datetime('now') "
        f"WHERE account_id = ? AND confirmation_number NOT IN ({placeholders})",
        [account_id] + active_confirmation_numbers,
    )
    conn.commit()


def log_diagnostic(
    conn: sqlite3.Connection,
    category: str,
    endpoint: str = "",
    expected_behavior: str = "",
    actual_behavior: str = "",
    headers_snapshot: str = "",
    response_snapshot: str = "",
) -> None:
    """Log a structured diagnostic entry for API/behavior changes."""
    conn.execute(
        "INSERT INTO diagnostics (category, endpoint, expected_behavior, actual_behavior, "
        "headers_snapshot, response_snapshot) VALUES (?, ?, ?, ?, ?, ?)",
        (category, endpoint, expected_behavior, actual_behavior,
         headers_snapshot, response_snapshot[:1000]),
    )
    conn.commit()
    # Also write to worker_logs for visibility in the activity feed
    add_log(
        conn,
        f"[DIAGNOSTIC:{category}] {endpoint} - Expected: {expected_behavior}, Got: {actual_behavior}",
        "warning",
    )


def add_fare_check(
    conn: sqlite3.Connection,
    flight_id: str,
    price_change: int,
    currency_code: str = "USD",
    best_flight_number: str | None = None,
    best_flight_nonstop: bool = False,
    best_flight_stops: str | None = None,
    best_flight_depart_time: str | None = None,
    my_flight_fare: int | None = None,
) -> None:
    conn.execute(
        "INSERT INTO fare_history (flight_id, price_change, currency_code, best_flight_number, "
        "best_flight_nonstop, best_flight_stops, best_flight_depart_time, my_flight_fare) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (flight_id, price_change, currency_code, best_flight_number,
         1 if best_flight_nonstop else 0, best_flight_stops, best_flight_depart_time, my_flight_fare),
    )
    conn.commit()


def get_last_fare_check(conn: sqlite3.Connection, flight_id: str) -> dict | None:
    """Get the most recent fare check result for a flight."""
    row = conn.execute(
        "SELECT price_change, currency_code, checked_at FROM fare_history "
        "WHERE flight_id = ? ORDER BY checked_at DESC LIMIT 1",
        (flight_id,),
    ).fetchone()
    return dict(row) if row else None


def update_flight_reservation_info(
    conn: sqlite3.Connection,
    flight_id: str,
    reservation_info_json: str,
) -> None:
    conn.execute(
        "UPDATE flights SET reservation_info_json = ? WHERE id = ?",
        (reservation_info_json, flight_id),
    )
    conn.commit()


def get_flights_for_fare_check(conn: sqlite3.Connection) -> list[dict]:
    """Get flights that have reservation_info and are still upcoming."""
    now = datetime.utcnow().isoformat()
    rows = conn.execute(
        "SELECT f.*, r.confirmation_number, r.first_name, r.last_name "
        "FROM flights f JOIN reservations r ON r.id = f.reservation_id "
        "WHERE f.reservation_info_json IS NOT NULL "
        "AND f.reservation_info_json != '' "
        "AND f.departure_time > ? "
        "AND f.checkin_status IN ('pending', 'scheduled') "
        "ORDER BY f.departure_time ASC",
        (now,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_seat_preferences(conn: sqlite3.Connection) -> dict | None:
    row = conn.execute("SELECT * FROM seat_preferences WHERE id = 'default'").fetchone()
    return dict(row) if row else None


def update_flight_seat(conn: sqlite3.Connection, flight_id: str, seat: str) -> None:
    conn.execute("UPDATE flights SET assigned_seat = ? WHERE id = ?", (seat, flight_id))
    conn.commit()


def get_flights_for_seat_upgrade(conn: sqlite3.Connection) -> list[dict]:
    """Get flights departing in 2-48 hours linked to A-List accounts with auto_upgrade enabled.
    A-List members can upgrade seats from 48 hours before departure until 2 hours before."""
    hours_2 = (datetime.utcnow() + timedelta(hours=2)).isoformat()
    hours_48 = (datetime.utcnow() + timedelta(hours=48)).isoformat()
    rows = conn.execute(
        "SELECT f.*, r.confirmation_number, r.first_name, r.last_name, a.is_alist, a.auto_upgrade_seats "
        "FROM flights f "
        "JOIN reservations r ON r.id = f.reservation_id "
        "LEFT JOIN accounts a ON a.id = r.account_id "
        "WHERE f.departure_time BETWEEN ? AND ? "
        "AND a.is_alist = 1 AND a.auto_upgrade_seats = 1 "
        "ORDER BY f.departure_time ASC",
        (hours_2, hours_48),
    ).fetchall()
    return [dict(r) for r in rows]


def set_reservation_owners_for_account(conn: sqlite3.Connection, account_id: str) -> None:
    """Propagate an account's owner to its reservations (for member scoping)."""
    conn.execute(
        "UPDATE reservations SET owner_user_id = "
        "(SELECT owner_user_id FROM accounts WHERE id = ?) WHERE account_id = ?",
        (account_id, account_id),
    )
    conn.commit()


def sync_travel_funds(conn: sqlite3.Connection, account_id: str, funds: list[dict]) -> int:
    """Upsert auto-synced travel funds for an account. Returns count upserted.

    Synced credits are keyed by (account_id, external_id) and marked
    source='southwest'. Manual credits are never touched. The owner is
    inherited from the account so the right family member sees them.
    """
    row = conn.execute("SELECT owner_user_id FROM accounts WHERE id = ?", (account_id,)).fetchone()
    owner_user_id = row["owner_user_id"] if row else None

    upserted = 0
    for fund in funds:
        external_id = fund.get("external_id")
        if not external_id:
            continue
        amount = fund.get("amount")
        if amount is None:
            continue
        existing = conn.execute(
            "SELECT id FROM travel_credits WHERE account_id = ? AND external_id = ? AND source = 'southwest'",
            (account_id, external_id),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE travel_credits SET amount = ?, currency = ?, expiration_date = ?, "
                "owner_user_id = ?, confirmation_number = ?, updated_at = datetime('now') "
                "WHERE id = ?",
                (
                    amount, fund.get("currency", "USD"), fund.get("expiration_date"),
                    owner_user_id, fund.get("confirmation_number", external_id[:8].upper()),
                    existing["id"],
                ),
            )
        else:
            conn.execute(
                "INSERT INTO travel_credits "
                "(account_id, owner_user_id, confirmation_number, amount, currency, "
                " expiration_date, source, external_id) "
                "VALUES (?, ?, ?, ?, ?, ?, 'southwest', ?)",
                (
                    account_id, owner_user_id,
                    fund.get("confirmation_number", external_id[:8].upper()),
                    amount, fund.get("currency", "USD"), fund.get("expiration_date"),
                    external_id,
                ),
            )
        upserted += 1
    conn.commit()
    return upserted


def get_notification_configs(conn: sqlite3.Connection, user_id: str | None = None) -> list[dict]:
    """Active notification services.

    With no user_id: every active service (used for broadcast/test messages).
    With a user_id: that user's own services plus any global (user_id IS NULL)
    services, so shared/household services still fire while each member can
    also route alerts to their own phone.
    """
    if user_id is None:
        rows = conn.execute("SELECT * FROM notification_configs WHERE is_active = 1").fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM notification_configs WHERE is_active = 1 "
            "AND (user_id = ? OR user_id IS NULL OR user_id = '')",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def update_worker_heartbeat(conn: sqlite3.Connection, browser_ok: bool, note: str = "") -> None:
    """Record that the worker loop is alive (for stale-worker detection)."""
    now = datetime.utcnow().isoformat()
    conn.execute(
        "INSERT INTO worker_status (id, last_poll_at, browser_ok, note, updated_at) "
        "VALUES (1, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET last_poll_at = excluded.last_poll_at, "
        "browser_ok = excluded.browser_ok, note = excluded.note, updated_at = excluded.updated_at",
        (now, 1 if browser_ok else 0, note, now),
    )
    conn.commit()


def mark_account_login_success(conn: sqlite3.Connection, account_id: str) -> None:
    conn.execute(
        "UPDATE accounts SET last_login_success = ?, last_login_error = NULL, "
        "login_failure_count = 0 WHERE id = ?",
        (datetime.utcnow().isoformat(), account_id),
    )
    conn.commit()


def mark_account_login_error(conn: sqlite3.Connection, account_id: str, error: str) -> None:
    conn.execute(
        "UPDATE accounts SET last_login_error = ? WHERE id = ?",
        (str(error)[:300], account_id),
    )
    conn.commit()


def get_flight_owner(conn: sqlite3.Connection, flight_id: str) -> str | None:
    row = conn.execute(
        "SELECT r.owner_user_id AS owner FROM flights f "
        "JOIN reservations r ON r.id = f.reservation_id WHERE f.id = ?",
        (flight_id,),
    ).fetchone()
    return row["owner"] if row else None


def get_user_id_by_username(conn: sqlite3.Connection, username: str) -> str | None:
    if not username:
        return None
    row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    return row["id"] if row else None


# ── Data Retention / Cleanup ────────────────────────────────────────────

def cleanup_old_data(conn: sqlite3.Connection) -> dict[str, int]:
    """Delete old records from log/audit tables. Returns counts of deleted rows."""
    counts = {}

    cursor = conn.execute(
        "DELETE FROM worker_logs WHERE created_at < datetime('now', '-30 days')"
    )
    counts["worker_logs"] = cursor.rowcount

    cursor = conn.execute(
        "DELETE FROM diagnostics WHERE created_at < datetime('now', '-30 days')"
    )
    counts["diagnostics"] = cursor.rowcount

    cursor = conn.execute(
        "DELETE FROM fare_history WHERE checked_at < datetime('now', '-90 days')"
    )
    counts["fare_history"] = cursor.rowcount

    # Captures and audits are large (JSON blobs, screenshot references) — 5 days
    cursor = conn.execute(
        "DELETE FROM seat_upgrade_audit WHERE created_at < datetime('now', '-5 days')"
    )
    counts["seat_upgrade_audit"] = cursor.rowcount

    cursor = conn.execute(
        "DELETE FROM checkin_captures WHERE created_at < datetime('now', '-5 days')"
    )
    counts["checkin_captures"] = cursor.rowcount

    conn.commit()

    # VACUUM to reclaim disk space (deleted rows don't shrink the file otherwise).
    # VACUUM takes an exclusive lock on the whole database, which can block a
    # time-critical check-in write — only run it when no check-in could be near.
    total = sum(counts.values())
    if total > 0:
        now = datetime.utcnow().isoformat()
        soon = (datetime.utcnow() + timedelta(hours=30)).isoformat()
        upcoming = conn.execute(
            "SELECT COUNT(*) FROM flights "
            "WHERE checkin_status IN ('pending', 'scheduled', 'checking_in') "
            "AND departure_time BETWEEN ? AND ?",
            (now, soon),
        ).fetchone()[0]
        if upcoming == 0:
            try:
                conn.execute("VACUUM")
            except Exception:
                pass  # VACUUM can fail if another connection holds a lock

    return counts


def backup_database(conn: sqlite3.Connection, keep: int = 7) -> str | None:
    """Write a consistent snapshot of the DB via VACUUM INTO, keep last `keep`.

    VACUUM INTO is safe on a live WAL database (it takes a read snapshot), so
    this can run alongside the frontend and check-in threads. Returns the
    backup path, or None on failure.
    """
    backup_dir = os.path.join(os.path.dirname(DB_PATH), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(backup_dir, f"checkin-{stamp}.db")
    try:
        conn.execute("VACUUM INTO ?", (dest,))
    except Exception:
        return None

    # Retention: keep the newest `keep` backups.
    try:
        backups = sorted(
            (os.path.join(backup_dir, f) for f in os.listdir(backup_dir) if f.endswith(".db")),
            key=os.path.getmtime,
            reverse=True,
        )
        for old in backups[keep:]:
            try:
                os.remove(old)
            except OSError:
                pass
    except OSError:
        pass
    return dest


def get_stale_capture_dirs(conn: sqlite3.Connection) -> list[str]:
    """Get capture directories for captures/audits older than 5 days."""
    rows = conn.execute(
        """SELECT DISTINCT cc.capture_dir FROM checkin_captures cc
           WHERE cc.created_at < datetime('now', '-5 days')
           AND cc.capture_dir IS NOT NULL
           UNION
           SELECT DISTINCT sua.capture_dir FROM seat_upgrade_audit sua
           WHERE sua.created_at < datetime('now', '-5 days')
           AND sua.capture_dir IS NOT NULL"""
    ).fetchall()
    return [r["capture_dir"] for r in rows if r["capture_dir"]]
