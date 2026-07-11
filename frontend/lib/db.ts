import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || path.resolve("/app", "data", "checkin.db");

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
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
}
