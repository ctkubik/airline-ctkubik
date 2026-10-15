import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSetting, settingNumber } from "@/lib/settings";

export const dynamic = "force-dynamic";

// Which paid-data services have keys, and this month's usage (counted by the
// worker in system_state; see worker/lib/flight_status.py and google_flights.py)
export function GET() {
  const db = getDb();
  const month = new Date().toISOString().slice(0, 7);
  const used = (key: string) => {
    const row = db.prepare("SELECT value FROM system_state WHERE key = ?").get(`${key}:${month}`) as
      | { value: string }
      | undefined;
    return Number(row?.value || 0);
  };
  return NextResponse.json({
    flight_status: {
      configured: Boolean(getSetting("AERODATABOX_API_KEY")),
      used: used("aerodatabox_lookups"),
      limit: settingNumber("FLIGHT_STATUS_MONTHLY_LIMIT"),
    },
    google_flights: {
      configured: Boolean(getSetting("SERPAPI_API_KEY")),
      used: used("serpapi_searches"),
      limit: settingNumber("SERPAPI_MONTHLY_LIMIT"),
    },
  });
}
