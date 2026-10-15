import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listTrips, saveSegments, validateTrip, type TripInput } from "@/lib/trips";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(listTrips(getDb()));
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as TripInput;
  const { error, trip, segments } = validateTrip(body);
  if (error || !trip || !segments) return NextResponse.json({ error }, { status: 400 });
  const db = getDb();
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO trips (id, airline, confirmation_number, traveler, price_paid, currency, points_used,
         booked_on, cabin, notes, loyalty_account_id, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, trip.airline, trip.confirmation_number, trip.traveler, trip.price_paid, trip.currency,
      trip.points_used, trip.booked_on, trip.cabin, trip.notes, trip.loyalty_account_id, trip.status, trip.source
    );
    saveSegments(db, id, segments);
  })();
  return NextResponse.json(listTrips(db).find((t) => t.id === id), { status: 201 });
}
