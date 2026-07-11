import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "@/lib/db";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONFIRMATION = /^[A-Za-z0-9]{4,8}$/;

export function GET() {
  const db = getDb();
  const credits = db
    .prepare(
      `SELECT tc.*, a.display_name AS account_display_name, a.username AS account_username
       FROM travel_credits tc
       LEFT JOIN accounts a ON a.id = tc.account_id
       ORDER BY tc.is_used ASC,
                CASE WHEN tc.expiration_date IS NULL THEN 1 ELSE 0 END,
                tc.expiration_date ASC`
    )
    .all() as Record<string, unknown>[];

  const active = credits.filter((c) => !c.is_used);
  const totalActive = active.reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const soonCutoff = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const expiringSoon = active
    .filter((c) => c.expiration_date && String(c.expiration_date) <= soonCutoff)
    .reduce((sum, c) => sum + Number(c.amount || 0), 0);

  return NextResponse.json({ credits, totalActive, expiringSoon });
}

export async function POST(req: NextRequest) {
  const { account_id, owner_name, confirmation_number, amount, expiration_date, notes } =
    await req.json();

  if (!CONFIRMATION.test(confirmation_number || "")) {
    return NextResponse.json(
      { error: "Confirmation number should be the 6-character Southwest code (letters/numbers)" },
      { status: 400 }
    );
  }
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) {
    return NextResponse.json({ error: "Amount must be a positive number" }, { status: 400 });
  }
  if (expiration_date && !ISO_DATE.test(expiration_date)) {
    return NextResponse.json({ error: "Expiration date must be a date (YYYY-MM-DD)" }, { status: 400 });
  }

  const db = getDb();
  if (account_id) {
    const exists = db.prepare("SELECT id FROM accounts WHERE id = ?").get(account_id);
    if (!exists) {
      return NextResponse.json({ error: "Unknown account" }, { status: 400 });
    }
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO travel_credits
     (id, account_id, owner_name, confirmation_number, amount, expiration_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    account_id || null,
    owner_name || "",
    confirmation_number.toUpperCase(),
    Math.round(amt * 100) / 100,
    expiration_date || null,
    notes || ""
  );

  const credit = db.prepare("SELECT * FROM travel_credits WHERE id = ?").get(id);
  return NextResponse.json(credit, { status: 201 });
}
