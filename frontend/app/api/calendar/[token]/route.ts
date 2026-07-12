import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/*
  Token-authenticated iCalendar feed. Calendar apps can't send our auth cookie,
  so each user has an unguessable calendar_token that stands in for auth here.
  The feed exposes only that user's own flights (departure + a check-in event).
*/

function icsEscape(s: string): string {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function toICSDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const db = getDb();
  const user = db
    .prepare("SELECT id, username, display_name FROM users WHERE calendar_token = ? AND is_active = 1")
    .get(params.token) as { id: string; username: string; display_name: string } | undefined;

  if (!user) {
    return new NextResponse("Invalid calendar token", { status: 404 });
  }

  const flights = db
    .prepare(
      `SELECT f.id, f.flight_number, f.departure_airport, f.destination_airport,
              f.departure_time, f.checkin_status, r.confirmation_number,
              r.first_name, r.last_name
       FROM flights f
       JOIN reservations r ON r.id = f.reservation_id
       WHERE r.owner_user_id = ?
       ORDER BY f.departure_time ASC`
    )
    .all(user.id) as Array<{
    id: string;
    flight_number: string | null;
    departure_airport: string;
    destination_airport: string;
    departure_time: string;
    checkin_status: string;
    confirmation_number: string;
    first_name: string;
    last_name: string;
  }>;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SW Check-In//Travel//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape((user.display_name || user.username) + " — Flights")}`,
  ];

  const stamp = toICSDate(new Date(0)); // stable DTSTAMP so feeds don't churn

  for (const f of flights) {
    const dep = new Date(f.departure_time.endsWith("Z") ? f.departure_time : f.departure_time + "Z");
    if (isNaN(dep.getTime())) continue;
    const checkin = new Date(dep.getTime() - 24 * 3600 * 1000);
    const route = `${f.departure_airport} → ${f.destination_airport}`;
    const wn = f.flight_number ? ` (${String(f.flight_number).replace(/^WN/, "WN ")})` : "";
    const pax = `${f.first_name} ${f.last_name}`.trim();

    // Flight event (2h block)
    lines.push(
      "BEGIN:VEVENT",
      `UID:flight-${f.id}@sw-checkin`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toICSDate(dep)}`,
      `DTEND:${toICSDate(new Date(dep.getTime() + 2 * 3600 * 1000))}`,
      `SUMMARY:${icsEscape("✈ " + route + wn)}`,
      `DESCRIPTION:${icsEscape(`${pax} · Confirmation ${f.confirmation_number}`)}`,
      `LOCATION:${icsEscape(f.departure_airport)}`,
      "END:VEVENT"
    );

    // Check-in reminder event (30-min block at T-24h) — the actionable moment
    if (f.checkin_status !== "success") {
      lines.push(
        "BEGIN:VEVENT",
        `UID:checkin-${f.id}@sw-checkin`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${toICSDate(checkin)}`,
        `DTEND:${toICSDate(new Date(checkin.getTime() + 30 * 60 * 1000))}`,
        `SUMMARY:${icsEscape("🎫 Check-in opens: " + route)}`,
        `DESCRIPTION:${icsEscape(`Auto check-in for ${pax} (${f.confirmation_number}). The app handles this automatically.`)}`,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${icsEscape("Check-in for " + route)}`,
        "TRIGGER:-PT10M",
        "END:VALARM",
        "END:VEVENT"
      );
    }
  }

  lines.push("END:VCALENDAR");
  const body = lines.join("\r\n") + "\r\n";

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="flights.ics"',
      "Cache-Control": "no-cache",
    },
  });
}
