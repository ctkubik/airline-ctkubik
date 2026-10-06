import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { normalizeAccountIds, normalizeLevel } from "@/lib/notifications";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const db = getDb();
  if ("label" in body) {
    db.prepare("UPDATE notification_configs SET label = ? WHERE id = ?").run(
      typeof body.label === "string" ? body.label.trim().slice(0, 60) : "",
      params.id
    );
  }
  if ("notification_level" in body) {
    db.prepare("UPDATE notification_configs SET notification_level = ? WHERE id = ?").run(
      normalizeLevel(body.notification_level),
      params.id
    );
  }
  if ("account_ids" in body) {
    db.prepare("UPDATE notification_configs SET account_ids = ? WHERE id = ?").run(
      normalizeAccountIds(body.account_ids),
      params.id
    );
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = getDb();
  db.prepare("DELETE FROM notification_configs WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
