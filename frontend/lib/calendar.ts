// Private calendar feed (an .ics subscription) of upcoming flights and
// check-in times. Calendar apps can't log in, so the feed URL carries a
// random token instead; anyone with the link can read the feed, and a new
// link can be made in Settings to cut off the old one.
import crypto from "crypto";
import type Database from "better-sqlite3";
import { localToUtcIso } from "./airlines";

const TOKEN_KEY = "calendar_token";

export function getCalendarToken(db: Database.Database, regenerate = false): string {
  const row = db.prepare("SELECT value FROM system_state WHERE key = ?").get(TOKEN_KEY) as
    | { value: string }
    | undefined;
  if (row?.value && !regenerate) return row.value;
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(
    "INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(TOKEN_KEY, token);
  return token;
}

export function tokenMatches(db: Database.Database, candidate: string | null): boolean {
  const row = db.prepare("SELECT value FROM system_state WHERE key = ?").get(TOKEN_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value || !candidate) return false;
  const a = Buffer.from(row.value);
  const b = Buffer.from(candidate);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// Lines longer than 75 octets must be folded (RFC 5545)
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

interface FeedFlight {
  id: string;
  flight_number: string | null;
  departure_airport: string | null;
  destination_airport: string | null;
  departure_time: string;
  checkin_status: string;
  assigned_seat: string | null;
  readiness_status: string | null;
  checkin_hours: number | null;
  confirmation_number: string;
  first_name: string;
  last_name: string;
}

export function buildCalendar(db: Database.Database): string {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const flights = db
    .prepare(
      `SELECT f.id, f.flight_number, f.departure_airport, f.destination_airport, f.departure_time,
              f.checkin_status, f.assigned_seat, f.readiness_status, f.checkin_hours,
              r.confirmation_number, r.first_name, r.last_name
       FROM flights f JOIN reservations r ON r.id = f.reservation_id
       WHERE r.is_active = 1 AND f.departure_time > ?
       ORDER BY f.departure_time`
    )
    .all(since) as FeedFlight[];

  const stamp = icsDate(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//airline-checkin//flights//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Flights",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const f of flights) {
    const depart = new Date(f.departure_time);
    if (Number.isNaN(depart.getTime())) continue;
    const route = `${f.departure_airport ?? "?"} → ${f.destination_airport ?? "?"}`;
    const who = `${f.first_name} ${f.last_name}`;
    const flightNo = f.flight_number ? `WN ${f.flight_number.replace(/^WN\s*/, "")}` : "Southwest";
    const status =
      f.checkin_status === "success"
        ? `Checked in${f.assigned_seat ? `, seat ${f.assigned_seat}` : ""}`
        : f.checkin_status === "failed"
          ? "Automatic check-in FAILED: check in in the Southwest app"
          : "Automatic check-in scheduled";

    lines.push(
      "BEGIN:VEVENT",
      `UID:flight-${f.id}@airline-checkin`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(depart)}`,
      "DURATION:PT1H",
      `SUMMARY:${escapeText(`✈ ${flightNo} ${route}`)}`,
      `LOCATION:${escapeText(f.departure_airport ?? "")}`,
      `DESCRIPTION:${escapeText(`${who}\nConfirmation ${f.confirmation_number}\n${status}\n(Arrival time isn't tracked; this event is one hour long.)`)}`,
      "END:VEVENT"
    );

    const checkin = new Date(depart.getTime() - (f.checkin_hours || 24) * 3600000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:checkin-${f.id}@airline-checkin`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(checkin)}`,
      "DURATION:PT15M",
      `SUMMARY:${escapeText(`Check-in opens: ${f.confirmation_number} ${route}`)}`,
      `DESCRIPTION:${escapeText(`${who}\n${status}${f.readiness_status === "problem" ? "\nThe app flagged a problem with this check-in." : ""}`)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT"
    );
  }
  // Trips on other airlines (no check-in to show)
  const segments = db
    .prepare(
      `SELECT s.id, s.airline_code, s.flight_number, s.departure_airport, s.destination_airport,
              s.departure_time, s.departure_local, s.arrival_local, t.airline, t.confirmation_number, t.traveler
       FROM trip_segments s JOIN trips t ON t.id = s.trip_id
       WHERE t.status != 'cancelled' AND s.departure_time > ?
       ORDER BY s.departure_time`
    )
    .all(since) as {
    id: string;
    airline_code: string;
    flight_number: string;
    departure_airport: string;
    destination_airport: string;
    departure_time: string;
    departure_local: string;
    arrival_local: string | null;
    airline: string;
    confirmation_number: string;
    traveler: string;
  }[];
  for (const s of segments) {
    const depart = new Date(s.departure_time);
    if (Number.isNaN(depart.getTime())) continue;
    // Length from the arrival time at the destination's time zone; an hour
    // when there's no arrival time or it doesn't make sense
    let minutes = 60;
    const arrive = localToUtcIso(s.arrival_local, s.destination_airport);
    if (arrive) {
      const diff = (Date.parse(arrive) - depart.getTime()) / 60000;
      if (diff > 20 && diff < 24 * 60) minutes = diff;
    }
    const flightNo = s.flight_number ? `${s.airline_code} ${s.flight_number}` : s.airline;
    lines.push(
      "BEGIN:VEVENT",
      `UID:trip-${s.id}@airline-checkin`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(depart)}`,
      `DURATION:PT${Math.round(minutes)}M`,
      `SUMMARY:${escapeText(`✈ ${flightNo} ${s.departure_airport} → ${s.destination_airport}`)}`,
      `LOCATION:${escapeText(s.departure_airport)}`,
      `DESCRIPTION:${escapeText(
        [s.traveler, s.confirmation_number && `Confirmation ${s.confirmation_number}`, s.airline,
          s.arrival_local && `Arrives ${s.arrival_local.replace("T", " ")} local time`]
          .filter(Boolean)
          .join("\n")
      )}`,
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
