import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAccessContext } from "@/lib/access";

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  const row = db.prepare("SELECT user_id FROM notification_configs WHERE id = ?").get(params.id) as
    | { user_id: string | null }
    | undefined;
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Members may only delete their own; admins may delete any (incl. shared).
  if (!ctx.isAdmin && row.user_id !== ctx.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  db.prepare("DELETE FROM notification_configs WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
