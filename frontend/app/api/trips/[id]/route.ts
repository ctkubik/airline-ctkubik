import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAccessContext, canAccessFlight } from "@/lib/access";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function authorize(id: string) {
  const ctx = getAccessContext();
  if (!ctx) return { status: 401 as const, ctx: null };
  const row = getDb().prepare("SELECT owner_user_id FROM trips WHERE id = ?").get(id) as
    | { owner_user_id: string | null }
    | undefined;
  if (!row) return { status: 404 as const, ctx };
  if (!ctx.isAdmin && row.owner_user_id !== ctx.userId) return { status: 404 as const, ctx };
  return { status: 200 as const, ctx };
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = authorize(params.id);
  if (auth.status !== 200 || !auth.ctx) {
    return NextResponse.json(
      { error: auth.status === 401 ? "Unauthorized" : "Not found" },
      { status: auth.status }
    );
  }
  const body = await req.json();
  const db = getDb();

  // Assign/unassign a flight leg. attach_flight/detach_flight carry a flight id;
  // both are verified against the caller's access before touching the row.
  if (body.attach_flight || body.detach_flight) {
    const flightId = String(body.attach_flight || body.detach_flight);
    if (!canAccessFlight(auth.ctx, flightId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    db.prepare("UPDATE flights SET trip_id = ? WHERE id = ?").run(
      body.attach_flight ? params.id : null,
      flightId
    );
    return NextResponse.json({ ok: true });
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "Name can't be empty" }, { status: 400 });
    fields.push("name = ?");
    values.push(name);
  }
  if (body.destination !== undefined) {
    fields.push("destination = ?");
    values.push(String(body.destination).trim());
  }
  for (const key of ["start_date", "end_date"] as const) {
    if (body[key] !== undefined) {
      const v = String(body[key] || "").trim();
      if (v && !ISO_DATE.test(v)) {
        return NextResponse.json({ error: `${key} must be YYYY-MM-DD` }, { status: 400 });
      }
      fields.push(`${key} = ?`);
      values.push(v || null);
    }
  }
  if (body.notes !== undefined) {
    fields.push("notes = ?");
    values.push(String(body.notes).trim());
  }

  if (fields.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  fields.push("updated_at = datetime('now')");
  values.push(params.id);
  db.prepare(`UPDATE trips SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return NextResponse.json({ ok: true });
}

export function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = authorize(params.id);
  if (auth.status !== 200) {
    return NextResponse.json(
      { error: auth.status === 401 ? "Unauthorized" : "Not found" },
      { status: auth.status }
    );
  }
  const db = getDb();
  // Detach legs first so the flights survive the trip's deletion.
  db.prepare("UPDATE flights SET trip_id = NULL WHERE trip_id = ?").run(params.id);
  db.prepare("DELETE FROM trips WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
