import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// DATA_DIR is /app/data in Docker and the repo's ./data folder on a native
// macOS install (set by macos/run.sh). Resolved when the database is first
// opened, not at import: `next build` imports every route, and creating
// /app/data there fails on macOS, where / is read-only.
function dbPath(): string {
  const dataDir = process.env.DATA_DIR || path.resolve("/app", "data");
  return process.env.DB_PATH || path.join(dataDir, "checkin.db");
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    const file = dbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    _db = new Database(file);
    _db.pragma("journal_mode = WAL");
    // The Python worker writes to the same file; without a generous busy
    // timeout, its long transactions surface here as SQLITE_BUSY 500s.
    _db.pragma("busy_timeout = 15000");
    _db.pragma("foreign_keys = ON");
    initTables(_db);
    migrate(_db);
  }
  return _db;
}

// Keep this schema in sync with worker/db.py (_init_tables + _migrate).
// Both processes may touch a fresh database first, so each must be able to
// create the complete, current schema on its own.
function initTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      retrieval_interval INTEGER DEFAULT 24,
      is_alist INTEGER DEFAULT 0,
      auto_upgrade_seats INTEGER DEFAULT 0,
      display_name TEXT DEFAULT '',
      login_failure_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      confirmation_number TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS flights (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      flight_number TEXT,
      departure_airport TEXT,
      destination_airport TEXT,
      departure_time TEXT NOT NULL,
      is_international INTEGER DEFAULT 0,
      checkin_status TEXT DEFAULT 'pending',
      checkin_result TEXT,
      checkin_attempted_at TEXT,
      reservation_info_json TEXT,
      assigned_seat TEXT,
      original_price INTEGER,
      original_currency TEXT DEFAULT 'USD',
      last_seat_upgrade_attempt TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notification_configs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      service_url TEXT NOT NULL,
      notification_level INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS worker_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flight_id TEXT REFERENCES flights(id) ON DELETE SET NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fare_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flight_id TEXT NOT NULL,
      price_change INTEGER NOT NULL,
      currency_code TEXT NOT NULL DEFAULT 'USD',
      best_flight_number TEXT,
      best_flight_nonstop INTEGER DEFAULT 0,
      best_flight_stops TEXT,
      best_flight_depart_time TEXT,
      my_flight_fare INTEGER,
      checked_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS seat_preferences (
      id TEXT PRIMARY KEY DEFAULT 'default',
      preferred_letters TEXT DEFAULT 'A,F',
      preferred_rows TEXT DEFAULT '1,2,3,4,5,6',
      fallback_letters TEXT DEFAULT 'A,C,D,F',
      fare_check_mode TEXT DEFAULT 'same_day_nonstop',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS checkin_captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flight_id TEXT NOT NULL,
      capture_dir TEXT NOT NULL,
      manifest_json TEXT,
      file_count INTEGER DEFAULT 0,
      total_size_bytes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      is_active INTEGER DEFAULT 1,
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

    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT,
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

    -- Trips on any airline (no check-in), for spending and the calendar
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      airline TEXT NOT NULL,
      confirmation_number TEXT DEFAULT '',
      traveler TEXT DEFAULT '',
      price_paid REAL,
      currency TEXT DEFAULT 'USD',
      points_used INTEGER,
      booked_on TEXT,
      cabin TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      loyalty_account_id TEXT,
      status TEXT DEFAULT 'booked',
      source TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS trip_segments (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      position INTEGER DEFAULT 0,
      airline_code TEXT DEFAULT '',
      flight_number TEXT DEFAULT '',
      departure_airport TEXT DEFAULT '',
      destination_airport TEXT DEFAULT '',
      departure_local TEXT,
      departure_time TEXT,
      arrival_local TEXT,
      seat TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS loyalty_accounts (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      program TEXT NOT NULL,
      program_name TEXT DEFAULT '',
      owner_name TEXT DEFAULT '',
      member_number TEXT DEFAULT '',
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      login_url TEXT DEFAULT '',
      account_url TEXT DEFAULT '',
      sync_enabled INTEGER DEFAULT 0,
      balance INTEGER,
      balance_unit TEXT DEFAULT 'miles',
      status_tier TEXT DEFAULT '',
      status_detail TEXT DEFAULT '',
      status_expires TEXT,
      points_expire TEXT,
      last_synced_at TEXT,
      last_sync_status TEXT,
      last_sync_message TEXT,
      sync_failures INTEGER DEFAULT 0,
      sync_requested TEXT,
      code_requested_at TEXT,
      pending_code TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS trip_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id TEXT NOT NULL,
      price REAL NOT NULL,
      exact INTEGER DEFAULT 0,
      checked_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS loyalty_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loyalty_account_id TEXT NOT NULL,
      balance INTEGER,
      status_tier TEXT,
      source TEXT DEFAULT 'sync',
      recorded_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// Column migrations for databases created by older versions (mirrors
// worker/db.py _migrate). CREATE TABLE IF NOT EXISTS does not add columns
// to existing tables.
function migrate(db: Database.Database) {
  const addColumnIfMissing = (table: string, column: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };

  addColumnIfMissing("flights", "reservation_info_json", "reservation_info_json TEXT");
  addColumnIfMissing("flights", "assigned_seat", "assigned_seat TEXT");
  addColumnIfMissing("flights", "original_price", "original_price INTEGER");
  addColumnIfMissing("flights", "original_currency", "original_currency TEXT DEFAULT 'USD'");
  addColumnIfMissing("flights", "last_seat_upgrade_attempt", "last_seat_upgrade_attempt TEXT");

  addColumnIfMissing("accounts", "is_alist", "is_alist INTEGER DEFAULT 0");
  addColumnIfMissing("accounts", "auto_upgrade_seats", "auto_upgrade_seats INTEGER DEFAULT 0");
  addColumnIfMissing("accounts", "display_name", "display_name TEXT DEFAULT ''");
  addColumnIfMissing("accounts", "login_failure_count", "login_failure_count INTEGER DEFAULT 0");

  addColumnIfMissing("fare_history", "best_flight_number", "best_flight_number TEXT");
  addColumnIfMissing("fare_history", "best_flight_nonstop", "best_flight_nonstop INTEGER DEFAULT 0");
  addColumnIfMissing("fare_history", "best_flight_stops", "best_flight_stops TEXT");
  addColumnIfMissing("fare_history", "best_flight_depart_time", "best_flight_depart_time TEXT");
  addColumnIfMissing("fare_history", "my_flight_fare", "my_flight_fare INTEGER");

  addColumnIfMissing("seat_preferences", "fare_check_mode", "fare_check_mode TEXT DEFAULT 'same_day_nonstop'");

  addColumnIfMissing("diagnostics", "ai_explanation", "ai_explanation TEXT");

  addColumnIfMissing("flights", "readiness_status", "readiness_status TEXT");
  addColumnIfMissing("flights", "readiness_detail", "readiness_detail TEXT");
  addColumnIfMissing("flights", "readiness_checked_at", "readiness_checked_at TEXT");
  addColumnIfMissing("flights", "readiness_failures", "readiness_failures INTEGER DEFAULT 0");
  addColumnIfMissing("flights", "readiness_alerted", "readiness_alerted INTEGER DEFAULT 0");
  addColumnIfMissing("flights", "missed_alerted", "missed_alerted INTEGER DEFAULT 0");
  addColumnIfMissing("flights", "rebooked_savings", "rebooked_savings REAL");
  addColumnIfMissing("flights", "rebooked_at", "rebooked_at TEXT");

  addColumnIfMissing("notification_configs", "label", "label TEXT DEFAULT ''");
  addColumnIfMissing("notification_configs", "account_ids", "account_ids TEXT");
  addColumnIfMissing("notification_configs", "last_status", "last_status TEXT");
  addColumnIfMissing("notification_configs", "last_error", "last_error TEXT");
  addColumnIfMissing("notification_configs", "last_sent_at", "last_sent_at TEXT");
  addColumnIfMissing("reservations", "owner_account_id", "owner_account_id TEXT");
  addColumnIfMissing("fare_watches", "provider", "provider TEXT DEFAULT 'amadeus'");
  addColumnIfMissing("flights", "checkin_hours", "checkin_hours INTEGER");
  addColumnIfMissing("reservations", "lookup_status", "lookup_status TEXT");
  addColumnIfMissing("reservations", "lookup_message", "lookup_message TEXT");
  addColumnIfMissing("reservations", "lookup_checked_at", "lookup_checked_at TEXT");
  addColumnIfMissing("reservations", "next_lookup_at", "next_lookup_at TEXT");
  addColumnIfMissing("reservations", "lookup_failures", "lookup_failures INTEGER DEFAULT 0");
  addColumnIfMissing("seat_preferences", "pick_at_checkin", "pick_at_checkin INTEGER DEFAULT 0");
  addColumnIfMissing("seat_preferences", "avoid_rows", "avoid_rows TEXT DEFAULT ''");
  addColumnIfMissing("seat_preferences", "min_row_gain", "min_row_gain INTEGER DEFAULT 0");
  addColumnIfMissing("trips", "price_checked_at", "price_checked_at TEXT");
  addColumnIfMissing("trips", "current_price", "current_price REAL");
  addColumnIfMissing("trips", "current_price_exact", "current_price_exact INTEGER DEFAULT 0");
  addColumnIfMissing("trips", "price_note", "price_note TEXT");
  addColumnIfMissing("trips", "price_alerted_at_price", "price_alerted_at_price REAL");
}
