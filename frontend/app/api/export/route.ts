import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAccessContext, ownerScope } from "@/lib/access";

export const dynamic = "force-dynamic";

/*
  JSON export of the caller's travel data (admins get everyone's). Sensitive
  fields are excluded: Southwest passwords, document numbers, notification
  service URLs, and calendar tokens are never included.
*/
export function GET() {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();

  const acct = ownerScope(ctx, "owner_user_id");
  const accounts = db
    .prepare(
      `SELECT id, username, display_name, is_active, is_alist, last_login_success
       FROM accounts WHERE ${acct.clause}`
    )
    .all(...acct.params);

  const res = ownerScope(ctx, "r.owner_user_id");
  const reservations = db
    .prepare(
      `SELECT r.id, r.confirmation_number, r.first_name, r.last_name, r.is_active
       FROM reservations r WHERE ${res.clause}`
    )
    .all(...res.params);

  const fl = ownerScope(ctx, "r.owner_user_id");
  const flights = db
    .prepare(
      `SELECT r.confirmation_number, f.flight_number, f.departure_airport, f.destination_airport,
              f.departure_time, f.checkin_status, f.assigned_seat, f.original_price
       FROM flights f JOIN reservations r ON r.id = f.reservation_id WHERE ${fl.clause}`
    )
    .all(...fl.params);

  const cr = ownerScope(ctx, "owner_user_id");
  const credits = db
    .prepare(
      `SELECT confirmation_number, amount, currency, expiration_date, source, is_used
       FROM travel_credits WHERE ${cr.clause}`
    )
    .all(...cr.params);

  const doc = ownerScope(ctx, "owner_user_id");
  const documents = db
    .prepare(
      `SELECT doc_type, label, holder_name, expiration_date FROM documents WHERE ${doc.clause}`
    )
    .all(...doc.params);

  const fw = ownerScope(ctx, "created_by");
  // fare_watches is scoped by created_by (username), not user id.
  const watches = ctx.isAdmin
    ? db.prepare("SELECT name, origin, destination, depart_date_start, depart_date_end, best_price FROM fare_watches").all()
    : db
        .prepare(
          "SELECT name, origin, destination, depart_date_start, depart_date_end, best_price FROM fare_watches WHERE created_by = ?"
        )
        .all(ctx.user.username);
  void fw;

  const payload = {
    exported_at: new Date().toISOString(),
    scope: ctx.isAdmin ? "all-users" : ctx.user.username,
    accounts,
    reservations,
    flights,
    credits,
    documents,
    fare_watches: watches,
  };

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="sw-checkin-export-${date}.json"`,
    },
  });
}
