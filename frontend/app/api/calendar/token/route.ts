import { NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "@/lib/db";
import { getAccessContext } from "@/lib/access";

/*
  Returns (creating on first use) the current user's calendar subscription
  token. POST rotates it, which immediately invalidates the old feed URL.
*/

function ensureToken(userId: string, forceNew = false): string {
  const db = getDb();
  const row = db.prepare("SELECT calendar_token FROM users WHERE id = ?").get(userId) as
    | { calendar_token: string | null }
    | undefined;
  if (!forceNew && row?.calendar_token) return row.calendar_token;
  const token = crypto.randomBytes(24).toString("base64url");
  db.prepare("UPDATE users SET calendar_token = ? WHERE id = ?").run(token, userId);
  return token;
}

export function GET() {
  const ctx = getAccessContext();
  if (!ctx?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ token: ensureToken(ctx.userId) });
}

export async function POST() {
  const ctx = getAccessContext();
  if (!ctx?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ token: ensureToken(ctx.userId, true) });
}
