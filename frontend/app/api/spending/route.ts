import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listTrips } from "@/lib/trips";

export const dynamic = "force-dynamic";

interface Item {
  kind: "trip" | "southwest";
  id: string;
  date: string;
  airline: string;
  traveler: string;
  route: string;
  confirmation_number: string;
  price: number | null;
  points: number | null;
  saved: number;
}

interface Group {
  name: string;
  spent: number;
  trips: number;
  points: number;
}

function add(map: Map<string, Group>, name: string, item: Item) {
  const g = map.get(name) ?? { name, spent: 0, trips: 0, points: 0 };
  g.spent += item.price ?? 0;
  g.points += item.points ?? 0;
  g.trips += 1;
  map.set(name, g);
}

// ["PHX-MDW", "MDW-BOS"] -> "PHX → MDW → BOS"
function chain(legs: string[]): string {
  const stops: string[] = [];
  for (const leg of legs) {
    const [from, to] = leg.split("-");
    if (stops[stops.length - 1] !== from) stops.push(from);
    stops.push(to);
  }
  return stops.join(" → ");
}

// GET ?year=2026|all -> spending on all airlines, by airline and traveler.
// Other airlines: the price saved on each trip. Southwest: the fare entered
// on the Flights page, summed per reservation, with rebooking savings.
export function GET(req: NextRequest) {
  const db = getDb();
  const items: Item[] = [];

  for (const t of listTrips(db)) {
    if (t.status === "cancelled") continue;
    const stops = t.segments.map((s) => s.departure_airport);
    const last = t.segments[t.segments.length - 1];
    items.push({
      kind: "trip",
      id: t.id,
      date: (t.segments[0]?.departure_local ?? t.created_at).slice(0, 10),
      airline: t.airline,
      traveler: t.traveler || "Unassigned",
      route: last ? [...stops, last.destination_airport].join(" → ") : "",
      confirmation_number: t.confirmation_number,
      price: t.price_paid,
      points: t.points_used,
      saved: 0,
    });
  }

  const sw = db
    .prepare(
      `SELECT r.id, r.confirmation_number, r.first_name, r.last_name,
              MIN(f.departure_time) AS date,
              GROUP_CONCAT(f.departure_airport || '-' || f.destination_airport, ' ') AS legs,
              SUM(f.original_price) AS price, COUNT(f.original_price) AS priced,
              COALESCE(SUM(f.rebooked_savings), 0) AS saved
       FROM reservations r JOIN flights f ON f.reservation_id = r.id
       GROUP BY r.id`
    )
    .all() as {
    id: string;
    confirmation_number: string;
    first_name: string;
    last_name: string;
    date: string;
    legs: string | null;
    price: number | null;
    priced: number;
    saved: number;
  }[];
  for (const r of sw) {
    items.push({
      kind: "southwest",
      id: r.id,
      date: (r.date ?? "").slice(0, 10),
      airline: "Southwest",
      traveler: `${r.first_name} ${r.last_name}`.trim() || "Unassigned",
      route: chain((r.legs ?? "").split(" ").filter(Boolean)),
      confirmation_number: r.confirmation_number,
      price: r.priced > 0 ? r.price : null,
      points: null,
      saved: r.saved,
    });
  }

  const years = Array.from(new Set(items.map((i) => i.date.slice(0, 4)).filter((y) => /^\d{4}$/.test(y))))
    .sort()
    .reverse();
  const asked = req.nextUrl.searchParams.get("year");
  const thisYear = String(new Date().getFullYear());
  const year = asked === "all" ? "all" : asked && years.includes(asked) ? asked : years.includes(thisYear) ? thisYear : years[0] ?? "all";
  const chosen = items
    .filter((i) => year === "all" || i.date.startsWith(year))
    .sort((a, b) => b.date.localeCompare(a.date));

  const byAirline = new Map<string, Group>();
  const byTraveler = new Map<string, Group>();
  for (const i of chosen) {
    add(byAirline, i.airline, i);
    add(byTraveler, i.traveler, i);
  }
  const sortGroups = (m: Map<string, Group>) => Array.from(m.values()).sort((a, b) => b.spent - a.spent);
  const today = new Date().toISOString().slice(0, 10);

  return NextResponse.json({
    year,
    years,
    totals: {
      spent: chosen.reduce((s, i) => s + (i.price ?? 0), 0),
      saved: chosen.reduce((s, i) => s + i.saved, 0),
      points: chosen.reduce((s, i) => s + (i.points ?? 0), 0),
      trips: chosen.length,
      upcoming: chosen.filter((i) => i.date >= today).length,
      missing_price: chosen.filter((i) => i.price === null).length,
    },
    by_airline: sortGroups(byAirline),
    by_traveler: sortGroups(byTraveler),
    items: chosen,
  });
}
