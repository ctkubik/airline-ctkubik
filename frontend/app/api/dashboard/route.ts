import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAccessContext, ownerScope } from "@/lib/access";

export const dynamic = "force-dynamic";

export function GET() {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  const now = new Date().toISOString();

  const acctScope = ownerScope(ctx, "owner_user_id");
  const resScope = ownerScope(ctx, "owner_user_id");
  // Flight stats scope through the reservation's owner.
  const flScope = ownerScope(ctx, "r.owner_user_id");

  const activeAccounts = (db
    .prepare(`SELECT COUNT(*) as count FROM accounts WHERE is_active = 1 AND ${acctScope.clause}`)
    .get(...acctScope.params) as { count: number }).count;
  const totalReservations = (db
    .prepare(`SELECT COUNT(*) as count FROM reservations WHERE is_active = 1 AND ${resScope.clause}`)
    .get(...resScope.params) as { count: number }).count;

  const flightCount = (statuses: string, extra: unknown[] = []) =>
    (db
      .prepare(
        `SELECT COUNT(*) as count FROM flights f JOIN reservations r ON r.id = f.reservation_id
         WHERE ${statuses} AND ${flScope.clause}`
      )
      .get(...extra, ...flScope.params) as { count: number }).count;

  const upcomingCheckins = flightCount(
    "f.checkin_status IN ('pending', 'scheduled') AND f.departure_time > ?",
    [now]
  );
  const successfulCheckins = flightCount("f.checkin_status = 'success'");
  const failedCheckins = flightCount("f.checkin_status = 'failed'");

  const upcomingFlights = db
    .prepare(
      `SELECT f.*, r.confirmation_number, r.first_name, r.last_name,
              u.display_name AS owner_display_name
       FROM flights f
       JOIN reservations r ON r.id = f.reservation_id
       LEFT JOIN users u ON u.id = r.owner_user_id
       WHERE f.checkin_status IN ('pending', 'scheduled')
       AND f.departure_time > ? AND ${flScope.clause}
       ORDER BY f.departure_time ASC
       LIMIT 5`
    )
    .all(now, ...flScope.params);

  // The activity feed is operational/system-wide; only admins see it.
  const recentLogs = ctx.isAdmin
    ? db.prepare("SELECT * FROM worker_logs ORDER BY created_at DESC LIMIT 20").all()
    : [];

  return NextResponse.json({
    stats: {
      active_accounts: activeAccounts,
      total_reservations: totalReservations,
      upcoming_checkins: upcomingCheckins,
      successful_checkins: successfulCheckins,
      failed_checkins: failedCheckins,
    },
    upcoming_flights: upcomingFlights,
    recent_logs: recentLogs,
    is_admin: ctx.isAdmin,
  });
}
