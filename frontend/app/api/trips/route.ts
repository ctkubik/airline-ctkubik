import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "@/lib/db";
import { getAccessContext, ownerScope } from "@/lib/access";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/*
  Trips group a multi-airline journey (e.g. Southwest out + Delta back) into one
  timeline with a shared total cost. A trip owns nothing structurally — flights
  point at it via flights.trip_id — so assigning/unassigning a leg is just an
  UPDATE on the flight, and deleting a trip leaves its flights intact.
*/

export function GET() {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  const scope = ownerScope(ctx, "t.owner_user_id");

  const trips = db
    .prepare(
      `SELECT t.*, u.username AS owner_username, u.display_name AS owner_display_name
       FROM trips t LEFT JOIN users u ON u.id = t.owner_user_id
       WHERE ${scope.clause}
       ORDER BY CASE WHEN t.start_date IS NULL THEN 1 ELSE 0 END, t.start_date ASC, t.created_at DESC`
    )
    .all(...scope.params) as Record<string, unknown>[];

  // Attach the legs of each trip. A member only ever sees their own trips, and
  // flights inherit the trip owner, so no extra per-flight scoping is needed.
  const legStmt = db.prepare(
    `SELECT f.id, f.flight_number, f.airline, f.departure_airport, f.destination_airport,
            f.departure_time, f.checkin_status, f.auto_checkin, f.flight_status,
            f.flight_status_detail, f.original_price, f.original_currency,
            r.confirmation_number, r.first_name, r.last_name
     FROM flights f JOIN reservations r ON r.id = f.reservation_id
     WHERE f.trip_id = ?
     ORDER BY f.departure_time ASC`
  );

  const result = trips.map((t) => {
    const legs = legStmt.all(t.id) as Record<string, unknown>[];
    const total = legs.reduce(
      (sum, l) => sum + (typeof l.original_price === "number" ? l.original_price : 0),
      0
    );
    const currency = (legs.find((l) => l.original_currency)?.original_currency as string) || "USD";
    return { ...t, legs, total_cost: total, total_currency: currency };
  });

  return NextResponse.json({ trips: result, isAdmin: ctx.isAdmin });
}

export async function POST(req: NextRequest) {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();

  const name = String(body.name || "").trim();
  const destination = String(body.destination || "").trim();
  const startDate = String(body.start_date || "").trim();
  const endDate = String(body.end_date || "").trim();
  const notes = String(body.notes || "").trim();

  if (!name) {
    return NextResponse.json({ error: "Give the trip a name" }, { status: 400 });
  }
  if (startDate && !ISO_DATE.test(startDate)) {
    return NextResponse.json({ error: "Start date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (endDate && !ISO_DATE.test(endDate)) {
    return NextResponse.json({ error: "End date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (startDate && endDate && endDate < startDate) {
    return NextResponse.json({ error: "End date can't be before the start date" }, { status: 400 });
  }

  const owner = ctx.isAdmin && body.owner_user_id ? body.owner_user_id : ctx.userId;
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO trips (id, owner_user_id, name, destination, start_date, end_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, owner, name, destination, startDate || null, endDate || null, notes);

  const row = db.prepare("SELECT * FROM trips WHERE id = ?").get(id);
  return NextResponse.json(row, { status: 201 });
}
