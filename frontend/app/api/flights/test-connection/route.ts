import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// "Test check-in connection" on the Flights page. POST asks the worker to
// run it (worker.py process_connection_tests, within about a minute); GET
// returns the latest result for a flight.
export async function POST(req: NextRequest) {
  const { flight_id } = (await req.json().catch(() => ({}))) as { flight_id?: string };
  const db = getDb();
  if (!flight_id || !db.prepare("SELECT 1 FROM flights WHERE id = ?").get(flight_id)) {
    return NextResponse.json({ error: "Flight not found" }, { status: 404 });
  }
  const set = db.prepare(
    "INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );
  set.run("connection_test_request", JSON.stringify({ flight_id, requested_at: new Date().toISOString() }));
  set.run(`connection_test:${flight_id}`, JSON.stringify({ done: false, queued: true, steps: [] }));
  return NextResponse.json({ ok: true });
}

export function GET(req: NextRequest) {
  const flightId = req.nextUrl.searchParams.get("flight_id") || "";
  const row = getDb().prepare("SELECT value, updated_at FROM system_state WHERE key = ?").get(`connection_test:${flightId}`) as
    | { value: string; updated_at: string }
    | undefined;
  if (!row) return NextResponse.json(null);
  try {
    return NextResponse.json({ ...JSON.parse(row.value), updated_at: row.updated_at });
  } catch {
    return NextResponse.json(null);
  }
}
