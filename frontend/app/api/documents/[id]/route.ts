import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAccessContext } from "@/lib/access";
import { encryptSecret } from "@/lib/secrets";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function authorize(id: string) {
  const ctx = getAccessContext();
  if (!ctx) return { status: 401 as const };
  const row = getDb().prepare("SELECT owner_user_id FROM documents WHERE id = ?").get(id) as
    | { owner_user_id: string | null }
    | undefined;
  if (!row) return { status: 404 as const };
  if (!ctx.isAdmin && row.owner_user_id !== ctx.userId) return { status: 404 as const };
  return { status: 200 as const };
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = authorize(params.id);
  if (auth.status !== 200) {
    return NextResponse.json({ error: auth.status === 401 ? "Unauthorized" : "Not found" }, { status: auth.status });
  }
  const body = await req.json();
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.label !== undefined) {
    fields.push("label = ?");
    values.push(String(body.label));
  }
  if (body.holder_name !== undefined) {
    fields.push("holder_name = ?");
    values.push(String(body.holder_name));
  }
  if (body.number !== undefined) {
    fields.push("number_enc = ?");
    values.push(body.number ? encryptSecret(String(body.number)) : "");
  }
  if (body.expiration_date !== undefined) {
    if (body.expiration_date && !ISO_DATE.test(body.expiration_date)) {
      return NextResponse.json({ error: "Expiration must be a date (YYYY-MM-DD)" }, { status: 400 });
    }
    fields.push("expiration_date = ?", "notified_30d = 0", "notified_7d = 0");
    values.push(body.expiration_date || null);
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
  db.prepare(`UPDATE documents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return NextResponse.json({ ok: true });
}

export function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = authorize(params.id);
  if (auth.status !== 200) {
    return NextResponse.json({ error: auth.status === 401 ? "Unauthorized" : "Not found" }, { status: auth.status });
  }
  getDb().prepare("DELETE FROM documents WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
