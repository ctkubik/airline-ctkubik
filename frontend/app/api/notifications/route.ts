import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "@/lib/db";
import { getAccessContext } from "@/lib/access";

/*
  Notification services are per-user. Members see and manage only their own;
  admins additionally see shared/global services (user_id NULL) and everyone
  else's. New services created by a member belong to that member; an admin can
  create a shared one by passing scope: "global".
*/

export function GET() {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  const rows = ctx.isAdmin
    ? db
        .prepare(
          `SELECT nc.*, u.username AS owner_username, u.display_name AS owner_display_name
           FROM notification_configs nc LEFT JOIN users u ON u.id = nc.user_id ORDER BY nc.rowid`
        )
        .all()
    : db.prepare("SELECT * FROM notification_configs WHERE user_id = ? ORDER BY rowid").all(ctx.userId);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { service_url, notification_level, label, scope } = await req.json();
  if (!service_url) {
    return NextResponse.json({ error: "Service URL required" }, { status: 400 });
  }
  // Members own their services; only an admin may create a shared/global one.
  const userId = ctx.isAdmin && scope === "global" ? null : ctx.userId;

  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO notification_configs (id, service_url, notification_level, user_id, label) VALUES (?, ?, ?, ?, ?)"
  ).run(id, service_url, notification_level || 1, userId, label || "");
  const config = db.prepare("SELECT * FROM notification_configs WHERE id = ?").get(id);
  return NextResponse.json(config, { status: 201 });
}
