import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = getDb();
  const watch = db.prepare("SELECT * FROM fare_watches WHERE id = ?").get(params.id);
  if (!watch) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const history = db
    .prepare(
      "SELECT price, currency, departure_date, return_date, airline, checked_at " +
        "FROM fare_watch_history WHERE watch_id = ? ORDER BY checked_at DESC LIMIT 100"
    )
    .all(params.id);
  return NextResponse.json({ watch, history });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    fields.push("name = ?");
    values.push(String(body.name).trim());
  }
  if (body.is_active !== undefined) {
    fields.push("is_active = ?");
    values.push(body.is_active ? 1 : 0);
  }
  if (body.max_price !== undefined) {
    fields.push("max_price = ?");
    values.push(body.max_price ? Number(body.max_price) : null);
  }
  if (body.nonstop_only !== undefined) {
    fields.push("nonstop_only = ?");
    values.push(body.nonstop_only ? 1 : 0);
  }

  if (fields.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  fields.push("updated_at = datetime('now')");
  values.push(params.id);
  db.prepare(`UPDATE fare_watches SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const watch = db.prepare("SELECT * FROM fare_watches WHERE id = ?").get(params.id);
  return NextResponse.json(watch);
}

export function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = getDb();
  db.prepare("DELETE FROM fare_watch_history WHERE watch_id = ?").run(params.id);
  db.prepare("DELETE FROM fare_watches WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
