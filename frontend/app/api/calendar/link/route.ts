import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCalendarToken } from "@/lib/calendar";

export const dynamic = "force-dynamic";

// GET: the calendar feed token (created on first use). POST: a new token,
// which stops the old link from working.
export function GET() {
  return NextResponse.json({ token: getCalendarToken(getDb()) });
}

export function POST() {
  return NextResponse.json({ token: getCalendarToken(getDb(), true) });
}
