import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { buildCalendar, tokenMatches } from "@/lib/calendar";

export const dynamic = "force-dynamic";

// Public (no login cookie) but requires the secret token from Settings;
// calendar apps can't log in. Exempted from auth in middleware.ts.
export function GET(req: NextRequest) {
  const db = getDb();
  if (!tokenMatches(db, req.nextUrl.searchParams.get("token"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return new NextResponse(buildCalendar(db), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="flights.ics"',
      "Cache-Control": "no-store",
    },
  });
}
