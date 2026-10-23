import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { normalizeAccountIds, normalizeLevel } from "@/lib/notifications";
import { parseTgramUrl } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// The full service URL (with its bot token or password), for the Show button
// on the Settings page. Admins only.
export function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (getSessionUser()?.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can see the full service details" }, { status: 403 });
  }
  const row = getDb().prepare("SELECT service_url FROM notification_configs WHERE id = ?").get(params.id) as
    | { service_url: string }
    | undefined;
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const tg = parseTgramUrl(row.service_url);
  return NextResponse.json({
    service_url: row.service_url,
    telegram: tg ? { token: tg.token, chat_ids: tg.chatIds } : null,
  });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const db = getDb();
  if ("service_url" in body) {
    if (getSessionUser()?.role !== "admin") {
      return NextResponse.json({ error: "Only an admin can change the service URL" }, { status: 403 });
    }
    const url = typeof body.service_url === "string" ? body.service_url.trim() : "";
    if (!/^[a-z0-9+.-]+:\/\/\S+$/i.test(url)) {
      return NextResponse.json({ error: "That doesn't look like a service URL (it starts with something like tgram://)" }, { status: 400 });
    }
    // A changed URL hasn't been tried yet
    db.prepare(
      "UPDATE notification_configs SET service_url = ?, last_status = NULL, last_error = NULL, last_sent_at = NULL WHERE id = ?"
    ).run(url, params.id);
  }
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
