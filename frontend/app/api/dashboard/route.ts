import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET() {
  const db = getDb();
  const now = new Date().toISOString();

  const activeAccounts = (db.prepare("SELECT COUNT(*) as count FROM accounts WHERE is_active = 1").get() as { count: number }).count;
  const totalReservations = (db.prepare("SELECT COUNT(*) as count FROM reservations WHERE is_active = 1").get() as { count: number }).count;
  const upcomingCheckins = (db.prepare(
    "SELECT COUNT(*) as count FROM flights WHERE checkin_status IN ('pending', 'scheduled') AND departure_time > ?"
  ).get(now) as { count: number }).count;
  const successfulCheckins = (db.prepare("SELECT COUNT(*) as count FROM flights WHERE checkin_status = 'success'").get() as { count: number }).count;
  const failedCheckins = (db.prepare("SELECT COUNT(*) as count FROM flights WHERE checkin_status = 'failed'").get() as { count: number }).count;

  const upcomingFlights = db
    .prepare(
      `SELECT f.*, r.confirmation_number, r.first_name, r.last_name
       FROM flights f
       JOIN reservations r ON r.id = f.reservation_id
       WHERE f.checkin_status IN ('pending', 'scheduled')
       AND f.departure_time > ?
       ORDER BY f.departure_time ASC
       LIMIT 5`
    )
    .all(now);

  const recentLogs = db
    .prepare("SELECT * FROM worker_logs ORDER BY created_at DESC LIMIT 20")
    .all();

  // Safety net: the worker writes heartbeats (see worker/safety_net.py)
  const state = (key: string) =>
    db.prepare("SELECT updated_at FROM system_state WHERE key = ?").get(key) as { updated_at: string } | undefined;
  const ageMinutes = (row?: { updated_at: string }) =>
    row ? (Date.now() - new Date(row.updated_at.replace(" ", "T") + "Z").getTime()) / 60000 : null;
  const aliveAge = ageMinutes(state("worker_alive"));
  const loopAge = ageMinutes(state("worker_loop"));
  let workerProblem: string | null = null;
  if (aliveAge === null) workerProblem = "The check-in worker hasn't started yet.";
  else if (aliveAge > 5) workerProblem = `The check-in worker stopped ${Math.round(aliveAge)} minutes ago.`;
  else if (loopAge !== null && loopAge > 45) workerProblem = `The check-in worker has been stuck for ${Math.round(loopAge)} minutes.`;

  return NextResponse.json({
    system: {
      worker_alive_minutes_ago: aliveAge,
      worker_loop_minutes_ago: loopAge,
      problem: workerProblem,
    },
    stats: {
      active_accounts: activeAccounts,
      total_reservations: totalReservations,
      upcoming_checkins: upcomingCheckins,
      successful_checkins: successfulCheckins,
      failed_checkins: failedCheckins,
    },
    upcoming_flights: upcomingFlights,
    recent_logs: recentLogs,
  });
}
