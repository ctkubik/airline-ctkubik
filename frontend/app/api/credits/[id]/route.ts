import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAccessContext } from "@/lib/access";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Load a credit the caller may modify, plus whether it's auto-synced. */
function authorizedCredit(id: string) {
  const ctx = getAccessContext();
  if (!ctx) return { status: 401 as const };
  const row = getDb()
    .prepare("SELECT owner_user_id, source FROM travel_credits WHERE id = ?")
    .get(id) as { owner_user_id: string | null; source: string } | undefined;
  if (!row) return { status: 404 as const };
  if (!ctx.isAdmin && row.owner_user_id !== ctx.userId) return { status: 404 as const };
  return { status: 200 as const, source: row.source };
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = authorizedCredit(params.id);
  if (auth.status !== 200) {
    return NextResponse.json(
      { error: auth.status === 401 ? "Unauthorized" : "Not found" },
      { status: auth.status }
    );
  }
  // Auto-synced credits mirror Southwest and are read-only except "mark used".
  const body = await req.json();
  if (auth.source === "southwest") {
    const onlyUsed = Object.keys(body).every((k) => k === "is_used");
    if (!onlyUsed) {
      return NextResponse.json(
        { error: "This credit is synced from Southwest and can't be edited here (you can mark it used)." },
        { status: 400 }
      );
    }
  }

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
  return NextResponse.json(credit);
}

export function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = authorizedCredit(params.id);
  if (auth.status !== 200) {
    return NextResponse.json(
      { error: auth.status === 401 ? "Unauthorized" : "Not found" },
      { status: auth.status }
    );
  }
  // Deleting a synced credit is pointless — the next sync re-adds it. Hide it
  // by marking used instead.
  if (auth.source === "southwest") {
    return NextResponse.json(
      { error: "Synced credits can't be deleted (they'd return on the next sync). Mark it used instead." },
      { status: 400 }
    );
  }
  getDb().prepare("DELETE FROM travel_credits WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
