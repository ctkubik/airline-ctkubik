import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { maskServiceUrl, normalizeAccountIds, normalizeLevel } from "@/lib/notifications";

export function GET() {
  const db = getDb();
  const configs = db.prepare("SELECT * FROM notification_configs ORDER BY rowid").all() as {
    service_url: string;
  }[];
  return NextResponse.json(configs.map((c) => ({ ...c, service_url: maskServiceUrl(c.service_url) })));
}

export async function POST(req: NextRequest) {
  const { service_url, notification_level, label, account_ids } = await req.json();
  if (!service_url) {
    return NextResponse.json({ error: "Service URL required" }, { status: 400 });
  }
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO notification_configs (id, service_url, notification_level, label, account_ids) VALUES (?, ?, ?, ?, ?)"
  ).run(
    id,
    service_url,
    normalizeLevel(notification_level),
    typeof label === "string" ? label.trim().slice(0, 60) : "",
    normalizeAccountIds(account_ids)
  );
  return NextResponse.json({ id }, { status: 201 });
}
