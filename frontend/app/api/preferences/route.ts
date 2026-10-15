import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// Seat and fare-check preferences. The shared set has id 'default'; an
// account's own set has id 'account:<account id>' (worker/db.py
// get_seat_preferences uses the account's set when it exists).
//   GET  ?account_id=X  -> the account's set, or the shared one with custom: false
//   POST { account_id?, ...fields }  -> save the shared set or the account's own
//   DELETE ?account_id=X -> the account goes back to the shared set

const FARE_MODES = ["same_flight", "same_day_nonstop", "same_day"];

function rowId(accountId: string | null): string {
  return accountId ? `account:${accountId}` : "default";
}

function validAccount(db: ReturnType<typeof getDb>, accountId: string | null): boolean {
  return !accountId || Boolean(db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(accountId));
}

function letters(v: unknown, fallback: string): string {
  const list = (typeof v === "string" ? v : "").toUpperCase().split(",").map((x) => x.trim()).filter((x) => /^[A-K]$/.test(x));
  return list.length ? Array.from(new Set(list)).join(",") : fallback;
}

function rows(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const cleaned = v.replace(/[^0-9,\- ]/g, "").replace(/\s+/g, "").slice(0, 80);
  return cleaned;
}

export function GET(req: NextRequest) {
  const db = getDb();
  const accountId = req.nextUrl.searchParams.get("account_id");
  if (!validAccount(db, accountId)) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  if (!db.prepare("SELECT 1 FROM seat_preferences WHERE id = 'default'").get()) {
    db.prepare("INSERT INTO seat_preferences (id) VALUES ('default')").run();
  }
  const own = accountId ? db.prepare("SELECT * FROM seat_preferences WHERE id = ?").get(rowId(accountId)) : null;
  const shared = db.prepare("SELECT * FROM seat_preferences WHERE id = 'default'").get();
  return NextResponse.json({ ...(own ?? (shared as object)), custom: Boolean(own) });
}

export async function POST(req: NextRequest) {
  const db = getDb();
  const body = await req.json().catch(() => ({}));
  const accountId = typeof body.account_id === "string" && body.account_id ? body.account_id : null;
  if (!validAccount(db, accountId)) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  const id = rowId(accountId);
  const values = [
    letters(body.preferred_letters, "A,F"),
    rows(body.preferred_rows, "1,2,3,4,5,6"),
    letters(body.fallback_letters, "A,C,D,F"),
    FARE_MODES.includes(body.fare_check_mode) ? body.fare_check_mode : "same_day_nonstop",
    body.pick_at_checkin ? 1 : 0,
    rows(body.avoid_rows, ""),
    Math.max(0, Math.min(30, Math.floor(Number(body.min_row_gain) || 0))),
  ];
  db.prepare(
    `INSERT INTO seat_preferences (id, preferred_letters, preferred_rows, fallback_letters, fare_check_mode,
       pick_at_checkin, avoid_rows, min_row_gain, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET preferred_letters = excluded.preferred_letters,
       preferred_rows = excluded.preferred_rows, fallback_letters = excluded.fallback_letters,
       fare_check_mode = excluded.fare_check_mode, pick_at_checkin = excluded.pick_at_checkin,
       avoid_rows = excluded.avoid_rows, min_row_gain = excluded.min_row_gain, updated_at = excluded.updated_at`
  ).run(id, ...values);
  const prefs = db.prepare("SELECT * FROM seat_preferences WHERE id = ?").get(id) as object;
  return NextResponse.json({ ...prefs, custom: Boolean(accountId) });
}

export function DELETE(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("account_id");
  if (!accountId) return NextResponse.json({ error: "The shared preferences can't be removed" }, { status: 400 });
  getDb().prepare("DELETE FROM seat_preferences WHERE id = ?").run(rowId(accountId));
  return NextResponse.json({ ok: true });
}
