import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAccessContext, canAccessFlight } from "@/lib/access";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canAccessFlight(ctx, id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = getDb();
  const logs = db
    .prepare("SELECT * FROM worker_logs WHERE flight_id = ? ORDER BY created_at DESC LIMIT 100")
    .all(id);
  return NextResponse.json(logs);
}
