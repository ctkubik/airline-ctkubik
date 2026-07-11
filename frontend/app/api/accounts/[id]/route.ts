import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAccessContext } from "@/lib/access";

/** Load an account the caller is allowed to touch, or null. */
function authorizedAccount(id: string): { ok: boolean; isAdmin: boolean } | null {
  const ctx = getAccessContext();
  if (!ctx) return null;
  const row = getDb().prepare("SELECT owner_user_id FROM accounts WHERE id = ?").get(id) as
    | { owner_user_id: string | null }
    | undefined;
  if (!row) return { ok: false, isAdmin: ctx.isAdmin };
  const ok = ctx.isAdmin || row.owner_user_id === ctx.userId;
  return { ok, isAdmin: ctx.isAdmin };
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = authorizedAccount(params.id);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!auth.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.display_name !== undefined) {
    fields.push("display_name = ?");
    values.push(body.display_name);
  }
  if (body.is_active !== undefined) {
    fields.push("is_active = ?");
    values.push(body.is_active ? 1 : 0);
  }
  if (body.retrieval_interval !== undefined) {
    fields.push("retrieval_interval = ?");
    values.push(body.retrieval_interval);
  }
  if (body.is_alist !== undefined) {
    fields.push("is_alist = ?");
    values.push(body.is_alist ? 1 : 0);
  }
  if (body.auto_upgrade_seats !== undefined) {
    fields.push("auto_upgrade_seats = ?");
    values.push(body.auto_upgrade_seats ? 1 : 0);
  }
  // Only admins may reassign an account to a different owner.
  if (body.owner_user_id !== undefined && auth.isAdmin) {
    fields.push("owner_user_id = ?");
    values.push(body.owner_user_id || null);
  }

  if (fields.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  fields.push("updated_at = datetime('now')");
  values.push(params.id);
  db.prepare(`UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  // When an account changes owner, its reservations and synced credits follow.
  if (body.owner_user_id !== undefined && auth.isAdmin) {
    const owner = body.owner_user_id || null;
    db.prepare("UPDATE reservations SET owner_user_id = ? WHERE account_id = ?").run(owner, params.id);
    db.prepare("UPDATE travel_credits SET owner_user_id = ? WHERE account_id = ?").run(owner, params.id);
  }

  // Exclude the password column: it holds the user's real Southwest password.
  const account = db
    .prepare(
      "SELECT id, username, display_name, is_active, retrieval_interval, " +
        "is_alist, auto_upgrade_seats, login_failure_count, owner_user_id, created_at, updated_at " +
        "FROM accounts WHERE id = ?"
    )
    .get(params.id);
  return NextResponse.json(account);
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = authorizedAccount(params.id);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!auth.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

  getDb().prepare("DELETE FROM accounts WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
