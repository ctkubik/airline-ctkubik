import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.amount !== undefined) {
    const amt = Number(body.amount);
    if (!isFinite(amt) || amt <= 0) {
      return NextResponse.json({ error: "Amount must be a positive number" }, { status: 400 });
    }
    fields.push("amount = ?");
    values.push(Math.round(amt * 100) / 100);
  }
  if (body.expiration_date !== undefined) {
    if (body.expiration_date && !ISO_DATE.test(body.expiration_date)) {
      return NextResponse.json({ error: "Expiration date must be a date (YYYY-MM-DD)" }, { status: 400 });
    }
    fields.push("expiration_date = ?");
    values.push(body.expiration_date || null);
    // Re-arm expiration alerts when the date changes
    fields.push("notified_30d = 0", "notified_7d = 0");
  }
  if (body.is_used !== undefined) {
    fields.push("is_used = ?");
    values.push(body.is_used ? 1 : 0);
  }
  if (body.owner_name !== undefined) {
    fields.push("owner_name = ?");
    values.push(String(body.owner_name));
  }
  if (body.notes !== undefined) {
    fields.push("notes = ?");
    values.push(String(body.notes));
  }

  if (fields.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  fields.push("updated_at = datetime('now')");
  values.push(params.id);
  db.prepare(`UPDATE travel_credits SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const credit = db.prepare("SELECT * FROM travel_credits WHERE id = ?").get(params.id);
  if (!credit) {
    return NextResponse.json({ error: "Credit not found" }, { status: 404 });
  }
  return NextResponse.json(credit);
}

export function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  getDb().prepare("DELETE FROM travel_credits WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
