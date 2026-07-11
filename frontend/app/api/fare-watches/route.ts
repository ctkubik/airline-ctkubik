import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

const IATA = /^[A-Za-z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function GET() {
  const db = getDb();
  const watches = db
    .prepare("SELECT * FROM fare_watches ORDER BY created_at DESC")
    .all();
  return NextResponse.json({
    watches,
    providerConfigured: Boolean(process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET),
    checkIntervalHours: Number(process.env.FARE_WATCH_INTERVAL_HOURS || 6),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    name,
    origin,
    destination,
    depart_date_start,
    depart_date_end,
    return_date_start,
    return_date_end,
    adults,
    nonstop_only,
    max_price,
  } = body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "Name is required (e.g. \"Mom's visit\")" }, { status: 400 });
  }
  if (!IATA.test(origin || "") || !IATA.test(destination || "")) {
    return NextResponse.json({ error: "Origin and destination must be 3-letter airport codes" }, { status: 400 });
  }
  if (!ISO_DATE.test(depart_date_start || "") || !ISO_DATE.test(depart_date_end || "")) {
    return NextResponse.json({ error: "Departure window requires start and end dates" }, { status: 400 });
  }
  if (depart_date_end < depart_date_start) {
    return NextResponse.json({ error: "Departure window end is before its start" }, { status: 400 });
  }
  const hasReturn = Boolean(return_date_start || return_date_end);
  if (hasReturn) {
    if (!ISO_DATE.test(return_date_start || "") || !ISO_DATE.test(return_date_end || "")) {
      return NextResponse.json({ error: "Return window requires both start and end dates" }, { status: 400 });
    }
    if (return_date_end < return_date_start) {
      return NextResponse.json({ error: "Return window end is before its start" }, { status: 400 });
    }
    if (return_date_start < depart_date_start) {
      return NextResponse.json({ error: "Return window starts before the departure window" }, { status: 400 });
    }
  }

  const session = getSessionUser();
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO fare_watches
     (id, name, origin, destination, depart_date_start, depart_date_end,
      return_date_start, return_date_end, adults, nonstop_only, max_price, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name.trim(),
    origin.toUpperCase(),
    destination.toUpperCase(),
    depart_date_start,
    depart_date_end,
    hasReturn ? return_date_start : null,
    hasReturn ? return_date_end : null,
    Math.max(1, Math.min(9, Number(adults) || 1)),
    nonstop_only ? 1 : 0,
    max_price ? Number(max_price) : null,
    session?.username || ""
  );

  const watch = db.prepare("SELECT * FROM fare_watches WHERE id = ?").get(id);
  return NextResponse.json(watch, { status: 201 });
}
