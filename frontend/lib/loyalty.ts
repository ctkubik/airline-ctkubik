// Airline loyalty accounts (miles and status). The worker signs in and reads
// them (worker/lib/loyalty_sync.py); the password column never leaves the
// server, like Southwest account passwords.
import type Database from "better-sqlite3";

export const LOYALTY_COLUMNS =
  "id, program, program_name, owner_name, member_number, username, login_url, account_url, " +
  "sync_enabled, balance, balance_unit, status_tier, status_detail, status_expires, points_expire, " +
  "last_synced_at, last_sync_status, last_sync_message, sync_failures, sync_requested, " +
  "code_requested_at, created_at, updated_at, (password != '') AS has_password";

export function listLoyalty(db: Database.Database) {
  const accounts = db
    .prepare(`SELECT ${LOYALTY_COLUMNS} FROM loyalty_accounts ORDER BY owner_name, program`)
    .all() as Record<string, unknown>[];
  const history = db.prepare(
    `SELECT balance, status_tier, source, recorded_at FROM loyalty_history
     WHERE loyalty_account_id = ? ORDER BY recorded_at DESC LIMIT 30`
  );
  return accounts.map((a) => ({ ...a, history: history.all(a.id as string).reverse() }));
}

export function recordBalance(
  db: Database.Database,
  id: string,
  balance: number | null,
  status: string,
  source: "manual" | "email"
) {
  db.prepare(
    "INSERT INTO loyalty_history (loyalty_account_id, balance, status_tier, source) VALUES (?, ?, ?, ?)"
  ).run(id, balance, status, source);
}

export function cleanUrl(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return "";
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}

export function cleanBalance(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isInteger(n) && n >= 0 ? n : null;
}
