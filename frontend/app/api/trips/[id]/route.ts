import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listTrips, saveSegments, validateTrip, type TripInput } from "@/lib/trips";

// Replace a trip's details and flights (the edit form sends the whole trip)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as TripInput;
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM trips WHERE id = ?").get(params.id)) {
    return NextResponse.json({ error: "Trip not found" }, { status: 404 });
  }
  const { error, trip, segments } = validateTrip(body);
  if (error || !trip || !segments) return NextResponse.json({ error }, { status: 400 });
  db.transaction(() => {
    db.prepare(
      `UPDATE trips SET airline = ?, confirmation_number = ?, traveler = ?, price_paid = ?, currency = ?,
         points_used = ?, booked_on = ?, cabin = ?, notes = ?, loyalty_account_id = ?, status = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      trip.airline, trip.confirmation_number, trip.traveler, trip.price_paid, trip.currency, trip.points_used,
      trip.booked_on, trip.cabin, trip.notes, trip.loyalty_account_id, trip.status, params.id
    );
    saveSegments(db, params.id, segments);
  })();
  return NextResponse.json(listTrips(db).find((t) => t.id === params.id));
}

export function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  getDb().prepare("DELETE FROM trips WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
