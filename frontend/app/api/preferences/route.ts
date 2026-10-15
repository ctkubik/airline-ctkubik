import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

function ensureTable(db: ReturnType<typeof getDb>) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seat_preferences (
      id TEXT PRIMARY KEY DEFAULT 'default',
      preferred_letters TEXT DEFAULT 'A,F',
      preferred_rows TEXT DEFAULT '1,2,3,4,5,6',
      fallback_letters TEXT DEFAULT 'A,C,D,F',
      fare_check_mode TEXT DEFAULT 'same_day_nonstop',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Migration: add fare_check_mode if missing
  const cols = db.prepare("PRAGMA table_info(seat_preferences)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "fare_check_mode")) {
    db.exec("ALTER TABLE seat_preferences ADD COLUMN fare_check_mode TEXT DEFAULT 'same_day_nonstop'");
  }
}

export function GET() {
  const db = getDb();
  ensureTable(db);
  let prefs = db.prepare("SELECT * FROM seat_preferences WHERE id = 'default'").get();
  if (!prefs) {
    db.prepare("INSERT INTO seat_preferences (id) VALUES ('default')").run();
    prefs = db.prepare("SELECT * FROM seat_preferences WHERE id = 'default'").get();
  }
  return NextResponse.json(prefs);
}

export async function POST(req: NextRequest) {
  const db = getDb();
  ensureTable(db);
  const body = await req.json();
  const { preferred_letters, preferred_rows, fallback_letters, fare_check_mode } = body;

  const existing = db.prepare("SELECT id FROM seat_preferences WHERE id = 'default'").get();
  if (existing) {
    db.prepare(
      "UPDATE seat_preferences SET preferred_letters = ?, preferred_rows = ?, fallback_letters = ?, fare_check_mode = ?, updated_at = datetime('now') WHERE id = 'default'"
    ).run(preferred_letters, preferred_rows, fallback_letters, fare_check_mode || "same_day_nonstop");
  } else {
    db.prepare(
      "INSERT INTO seat_preferences (id, preferred_letters, preferred_rows, fallback_letters, fare_check_mode) VALUES ('default', ?, ?, ?, ?)"
    ).run(preferred_letters, preferred_rows, fallback_letters, fare_check_mode || "same_day_nonstop");
  }

  // Seat picking at check-in (worker/lib/seat_choice.py)
  const avoid = typeof body.avoid_rows === "string" ? body.avoid_rows.replace(/[^0-9,\- ]/g, "").slice(0, 60) : "";
  const gain = Math.max(0, Math.min(30, Math.floor(Number(body.min_row_gain) || 0)));
  db.prepare(
    "UPDATE seat_preferences SET pick_at_checkin = ?, avoid_rows = ?, min_row_gain = ? WHERE id = 'default'"
  ).run(body.pick_at_checkin ? 1 : 0, avoid, gain);

  const prefs = db.prepare("SELECT * FROM seat_preferences WHERE id = 'default'").get();
  return NextResponse.json(prefs);
}
