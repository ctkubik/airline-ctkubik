import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "@/lib/db";
import { getAccessContext, ownerScope } from "@/lib/access";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONFIRMATION = /^[A-Za-z0-9]{4,8}$/;

export function GET() {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  const scope = ownerScope(ctx, "tc.owner_user_id");
  const credits = db
    .prepare(
      `SELECT tc.*, a.display_name AS account_display_name, a.username AS account_username,
              u.display_name AS owner_display_name, u.username AS owner_username
       FROM travel_credits tc
       LEFT JOIN accounts a ON a.id = tc.account_id
       LEFT JOIN users u ON u.id = tc.owner_user_id
       WHERE ${scope.clause}
       ORDER BY tc.is_used ASC,
                CASE WHEN tc.expiration_date IS NULL THEN 1 ELSE 0 END,
                tc.expiration_date ASC`
    )
    .all(...scope.params) as Record<string, unknown>[];

  const active = credits.filter((c) => !c.is_used);
  const totalActive = active.reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const soonCutoff = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const expiringSoon = active
    .filter((c) => c.expiration_date && String(c.expiration_date) <= soonCutoff)
    .reduce((sum, c) => sum + Number(c.amount || 0), 0);

  return NextResponse.json({ credits, totalActive, expiringSoon, isAdmin: ctx.isAdmin });
}

export async function POST(req: NextRequest) {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  // The credit's owner: if it's tied to an account, follow that account's
  // owner (a member only sees accounts they own; an admin attributing a credit
  // to Mom's account makes it Mom's). Otherwise the creator owns it.
  let owner = ctx.userId;
  let resolvedAccountId: string | null = null;
  if (account_id) {
    const acct = db
      .prepare("SELECT id, owner_user_id FROM accounts WHERE id = ?")
      .get(account_id) as { id: string; owner_user_id: string | null } | undefined;
    if (!acct) {
      return NextResponse.json({ error: "Unknown account" }, { status: 400 });
    }
    if (!ctx.isAdmin && acct.owner_user_id !== ctx.userId) {
      return NextResponse.json({ error: "Unknown account" }, { status: 400 });
    }
    resolvedAccountId = acct.id;
    owner = acct.owner_user_id ?? ctx.userId;
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO travel_credits
     (id, account_id, owner_user_id, owner_name, confirmation_number, amount, expiration_date, notes, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`
  ).run(
    id,
    resolvedAccountId,
    owner,
    owner_name || "",
    confirmation_number.toUpperCase(),
    Math.round(amt * 100) / 100,
    expiration_date || null,
    notes || ""
  );

  const credit = db.prepare("SELECT * FROM travel_credits WHERE id = ?").get(id);
  return NextResponse.json(credit, { status: 201 });
}
