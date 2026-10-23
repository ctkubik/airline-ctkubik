import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "@/lib/db";
import { airportTimezone, localToUtcIso } from "@/lib/airlines";

// POST { flight_number, departure_airport, destination_airport, departure_local }
// Adds a Southwest flight to a reservation by hand, so its check-in is
// scheduled even when the app can't look the reservation up. A later
// successful lookup matches it (same flight number and departure time).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM reservations WHERE id = ?").get(params.id)) {
    return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
  }
  const flight = String(b.flight_number ?? "").replace(/^WN\s*/i, "").trim();
  const dep = String(b.departure_airport ?? "").trim().toUpperCase();
  const arr = String(b.destination_airport ?? "").trim().toUpperCase();
  const local = String(b.departure_local ?? "").trim().replace(" ", "T").slice(0, 16);
  if (!/^\d{1,4}$/.test(flight)) return NextResponse.json({ error: "Flight number is 1 to 4 digits, like 1234" }, { status: 400 });
  if (!/^[A-Z]{3}$/.test(dep) || !/^[A-Z]{3}$/.test(arr)) {
    return NextResponse.json({ error: "Airports are 3-letter codes, like PHX" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) {
    return NextResponse.json({ error: "Enter the departure date and time" }, { status: 400 });
  }
  if (!airportTimezone(dep)) {
    return NextResponse.json({ error: `The app doesn't know ${dep}'s time zone, so it can't time the check-in` }, { status: 400 });
  }
  const utc = localToUtcIso(local, dep);
  if (!utc || Date.parse(utc) < Date.now()) {
    return NextResponse.json({ error: "That departure time has already passed" }, { status: 400 });
  }
  // Same format the worker stores (Python isoformat with +00:00)
  const departure = utc.replace(/\.\d{3}Z$/, "+00:00");
  const existing = db
    .prepare("SELECT id FROM flights WHERE reservation_id = ? AND flight_number = ? AND departure_time = ?")
    .get(params.id, flight, departure);
  if (existing) return NextResponse.json({ error: "That flight is already on this reservation" }, { status: 409 });
  db.prepare(
    "INSERT INTO flights (id, reservation_id, flight_number, departure_airport, destination_airport, departure_time) " +
      "VALUES (?, ?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), params.id, flight, dep, arr, departure);
  db.prepare(
    "UPDATE reservations SET lookup_status = 'ok', " +
      "lookup_message = 'Flight added by hand; the check-in is scheduled' WHERE id = ?"
  ).run(params.id);
  return NextResponse.json({ ok: true, departure_time: departure }, { status: 201 });
}
