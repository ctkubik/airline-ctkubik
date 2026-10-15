// Trips on any airline: the app tracks them (spending, calendar, miles) but
// doesn't check in. Southwest trips stay on the Reservations page.
import type Database from "better-sqlite3";
import { airlineCode, airlineName, localToUtcIso } from "./airlines";

export interface SegmentInput {
  airline_code?: string;
  flight_number?: string;
  departure_airport?: string;
  destination_airport?: string;
  departure_local?: string;
  arrival_local?: string;
  seat?: string;
}

export interface TripInput {
  airline?: string;
  confirmation_number?: string;
  traveler?: string;
  price_paid?: number | string | null;
  currency?: string;
  points_used?: number | string | null;
  booked_on?: string | null;
  cabin?: string;
  notes?: string;
  loyalty_account_id?: string | null;
  status?: string;
  source?: string;
  segments?: SegmentInput[];
}

const AIRPORT = /^[A-Z]{3}$/;
const LOCAL = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function cleanSegment(s: SegmentInput, tripAirline: string): Required<SegmentInput> | null {
  const dep = str(s.departure_airport, 10).toUpperCase();
  const dest = str(s.destination_airport, 10).toUpperCase();
  const local = str(s.departure_local, 16).replace(" ", "T");
  if (!AIRPORT.test(dep) || !AIRPORT.test(dest) || !LOCAL.test(local)) return null;
  const arrival = str(s.arrival_local, 16).replace(" ", "T");
  let flight = str(s.flight_number, 12).toUpperCase().replace(/\s+/g, "");
  let code = str(s.airline_code, 3).toUpperCase();
  // "DL1234" -> code DL, number 1234
  const m = /^([A-Z0-9]{2})(\d{1,4})$/.exec(flight);
  if (m && !/^\d+$/.test(flight)) {
    code = code || m[1];
    flight = m[2];
  }
  return {
    airline_code: code || airlineCode(tripAirline),
    flight_number: flight,
    departure_airport: dep,
    destination_airport: dest,
    departure_local: local,
    arrival_local: LOCAL.test(arrival) ? arrival : "",
    seat: str(s.seat, 8).toUpperCase(),
  };
}

export function validateTrip(input: TripInput): { error?: string; trip?: TripInput; segments?: Required<SegmentInput>[] } {
  const airline = airlineName(str(input.airline, 60));
  if (!airline) return { error: "Which airline?" };
  const raw = Array.isArray(input.segments) ? input.segments : [];
  const segments = raw.map((s) => cleanSegment(s, airline));
  if (segments.length === 0) return { error: "Add at least one flight" };
  if (segments.some((s) => s === null)) {
    return { error: "Each flight needs a from and to airport code (3 letters) and a departure date" };
  }
  return {
    trip: {
      airline,
      confirmation_number: str(input.confirmation_number, 12).toUpperCase(),
      traveler: str(input.traveler, 80),
      price_paid: num(input.price_paid),
      currency: (str(input.currency, 3) || "USD").toUpperCase(),
      points_used: num(input.points_used),
      booked_on: LOCAL.test(str(input.booked_on, 10)) ? str(input.booked_on, 10) : null,
      cabin: str(input.cabin, 40),
      notes: str(input.notes, 500),
      loyalty_account_id: str(input.loyalty_account_id, 64) || null,
      status: input.status === "cancelled" ? "cancelled" : "booked",
      source: input.source === "email" ? "email" : "manual",
    },
    segments: (segments as Required<SegmentInput>[]).sort((a, b) =>
      a.departure_local.localeCompare(b.departure_local)
    ),
  };
}

export function saveSegments(db: Database.Database, tripId: string, segments: Required<SegmentInput>[]) {
  db.prepare("DELETE FROM trip_segments WHERE trip_id = ?").run(tripId);
  const insert = db.prepare(
    `INSERT INTO trip_segments (trip_id, position, airline_code, flight_number, departure_airport,
       destination_airport, departure_local, departure_time, arrival_local, seat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  segments.forEach((s, i) =>
    insert.run(
      tripId,
      i,
      s.airline_code,
      s.flight_number,
      s.departure_airport,
      s.destination_airport,
      s.departure_local,
      localToUtcIso(s.departure_local, s.departure_airport),
      s.arrival_local || null,
      s.seat
    )
  );
}

export interface TripRow {
  id: string;
  airline: string;
  confirmation_number: string;
  traveler: string;
  price_paid: number | null;
  currency: string;
  points_used: number | null;
  booked_on: string | null;
  cabin: string;
  notes: string;
  loyalty_account_id: string | null;
  status: string;
  source: string;
  created_at: string;
  segments: {
    id: string;
    airline_code: string;
    flight_number: string;
    departure_airport: string;
    destination_airport: string;
    departure_local: string;
    departure_time: string | null;
    arrival_local: string | null;
    seat: string;
  }[];
  first_departure?: string | null;
}

export function listTrips(db: Database.Database): TripRow[] {
  const trips = db.prepare("SELECT * FROM trips").all() as TripRow[];
  const segs = db
    .prepare("SELECT * FROM trip_segments ORDER BY trip_id, position")
    .all() as (TripRow["segments"][number] & { trip_id: string })[];
  const byTrip = new Map<string, TripRow["segments"]>();
  for (const s of segs) {
    const list = byTrip.get(s.trip_id) ?? [];
    list.push(s);
    byTrip.set(s.trip_id, list);
  }
  for (const t of trips) {
    t.segments = byTrip.get(t.id) ?? [];
    t.first_departure = t.segments[0]?.departure_time ?? t.segments[0]?.departure_local ?? null;
  }
  return trips.sort((a, b) => (a.first_departure ?? "").localeCompare(b.first_departure ?? ""));
}
