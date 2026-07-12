import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "@/lib/db";
import { getAccessContext, ownerScope } from "@/lib/access";

export const dynamic = "force-dynamic";

const IATA = /^[A-Za-z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Manually add a flight on any airline (not Southwest). It's tracked for
 * status + calendar + check-in reminders, but never auto-checked-in. Backed by
 * a lightweight non-Southwest reservation so it groups like everything else.
 */
export async function POST(req: NextRequest) {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const airline = String(body.airline || "").toUpperCase().trim();
  const flightNumber = String(body.flight_number || "").replace(/\s+/g, "").trim();
  const departureDate = String(body.departure_date || "");
  const departureTime = String(body.departure_time || "").trim();
  const from = String(body.departure_airport || "").toUpperCase().trim();
  const to = String(body.destination_airport || "").toUpperCase().trim();
  const passengerFirst = String(body.passenger_first || "").trim();
  const passengerLast = String(body.passenger_last || "").trim();
  const confirmation = String(body.confirmation_number || "").toUpperCase().trim();

  if (!airline || !/^[A-Z0-9]{2,3}$/.test(airline)) {
    return NextResponse.json({ error: "Pick an airline (2-letter carrier code)" }, { status: 400 });
  }
  if (!flightNumber || !/^\d{1,5}$/.test(flightNumber)) {
    return NextResponse.json({ error: "Enter the flight number (digits only)" }, { status: 400 });
  }
  if (!ISO_DATE.test(departureDate)) {
    return NextResponse.json({ error: "Departure date is required" }, { status: 400 });
  }
  if (from && !IATA.test(from)) {
    return NextResponse.json({ error: "From must be a 3-letter airport code" }, { status: 400 });
  }
  if (to && !IATA.test(to)) {
    return NextResponse.json({ error: "To must be a 3-letter airport code" }, { status: 400 });
  }

  const owner = ctx.isAdmin && body.owner_user_id ? body.owner_user_id : ctx.userId;
  const departure = `${departureDate}T${(departureTime || "00:00").slice(0, 5)}:00`;

  const db = getDb();
  const resId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO reservations (id, confirmation_number, first_name, last_name, owner_user_id, is_southwest) VALUES (?, ?, ?, ?, ?, 0)"
  ).run(resId, confirmation || "-", passengerFirst || "", passengerLast || "", owner);

  const flightId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO flights
       (id, reservation_id, flight_number, departure_airport, destination_airport,
        departure_time, airline, auto_checkin, checkin_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')`
  ).run(flightId, resId, flightNumber, from, to, departure, airline);

  const flight = db.prepare("SELECT * FROM flights WHERE id = ?").get(flightId);
  return NextResponse.json(flight, { status: 201 });
}

export function GET() {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();

  // Ensure fare_history table exists with all columns
  db.exec(`
    CREATE TABLE IF NOT EXISTS fare_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flight_id TEXT NOT NULL,
      price_change INTEGER NOT NULL,
      currency_code TEXT NOT NULL DEFAULT 'USD',
      best_flight_number TEXT,
      best_flight_nonstop INTEGER DEFAULT 0,
      best_flight_stops TEXT,
      best_flight_depart_time TEXT,
      my_flight_fare INTEGER,
      checked_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const now = new Date().toISOString();

  // Single query with LEFT JOINs to get latest and baseline fares (eliminates N+1)
  const scope = ownerScope(ctx, "r.owner_user_id");
  const flights = db
    .prepare(
      `SELECT f.*, r.confirmation_number, r.first_name, r.last_name, r.owner_user_id,
              u.display_name AS owner_display_name, u.username AS owner_username,
              lf.price_change AS lf_price_change, lf.currency_code AS lf_currency_code,
              lf.checked_at AS lf_checked_at, lf.best_flight_number AS lf_best_flight_number,
              lf.best_flight_nonstop AS lf_best_flight_nonstop, lf.best_flight_stops AS lf_best_flight_stops,
              lf.best_flight_depart_time AS lf_best_flight_depart_time, lf.my_flight_fare AS lf_my_flight_fare,
              bf.price_change AS bf_price_change, bf.currency_code AS bf_currency_code,
              bf.checked_at AS bf_checked_at
       FROM flights f
       JOIN reservations r ON r.id = f.reservation_id
       LEFT JOIN (
         SELECT fh1.flight_id, fh1.price_change, fh1.currency_code, fh1.checked_at,
                fh1.best_flight_number, fh1.best_flight_nonstop, fh1.best_flight_stops,
                fh1.best_flight_depart_time, fh1.my_flight_fare
         FROM fare_history fh1
         INNER JOIN (SELECT flight_id, MAX(checked_at) AS max_checked FROM fare_history GROUP BY flight_id) fh2
         ON fh1.flight_id = fh2.flight_id AND fh1.checked_at = fh2.max_checked
       ) lf ON lf.flight_id = f.id
       LEFT JOIN (
         SELECT fh1.flight_id, fh1.price_change, fh1.currency_code, fh1.checked_at
         FROM fare_history fh1
         INNER JOIN (SELECT flight_id, MIN(checked_at) AS min_checked FROM fare_history GROUP BY flight_id) fh2
         ON fh1.flight_id = fh2.flight_id AND fh1.checked_at = fh2.min_checked
       ) bf ON bf.flight_id = f.id
       LEFT JOIN users u ON u.id = r.owner_user_id
       WHERE f.departure_time > ? AND ${scope.clause}
       ORDER BY f.departure_time ASC`
    )
    .all(now, ...scope.params);

  const result = (flights as Record<string, unknown>[]).map((f) => {
    const latestFare = f.lf_price_change != null ? {
      price_change: f.lf_price_change,
      currency_code: f.lf_currency_code,
      checked_at: f.lf_checked_at,
      best_flight_number: f.lf_best_flight_number,
      best_flight_nonstop: f.lf_best_flight_nonstop,
      best_flight_stops: f.lf_best_flight_stops,
      best_flight_depart_time: f.lf_best_flight_depart_time,
      my_flight_fare: f.lf_my_flight_fare,
    } : null;

    const baselineFare = f.bf_price_change != null ? {
      price_change: f.bf_price_change,
      currency_code: f.bf_currency_code,
      checked_at: f.bf_checked_at,
    } : null;

    // Remove the lf_/bf_ prefixed columns from the response
    const clean = { ...f };
    for (const key of Object.keys(clean)) {
      if (key.startsWith("lf_") || key.startsWith("bf_")) delete clean[key];
    }

    return { ...clean, latest_fare: latestFare, baseline_fare: baselineFare };
  });

  return NextResponse.json(result);
}
