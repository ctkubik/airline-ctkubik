import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/secrets";
import { getAccessContext, ownerScope } from "@/lib/access";

// Never SELECT a.* here: the password column holds the user's real Southwest
// password (the worker needs it to log in) and must not be sent to the client.
const ACCOUNT_COLUMNS =
  "a.id, a.username, a.display_name, a.is_active, a.retrieval_interval, " +
  "a.is_alist, a.auto_upgrade_seats, a.login_failure_count, a.owner_user_id, " +
  "a.last_login_success, a.last_login_error, a.created_at, a.updated_at";

export function GET() {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const scope = ownerScope(ctx, "a.owner_user_id");
  const accounts = getDb()
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS}, COUNT(r.id) as reservation_count,
              u.username as owner_username, u.display_name as owner_display_name
       FROM accounts a
       LEFT JOIN reservations r ON r.account_id = a.id
       LEFT JOIN users u ON u.id = a.owner_user_id
       WHERE ${scope.clause}
       GROUP BY a.id
       ORDER BY a.created_at DESC`
    )
    .all(...scope.params);
  return NextResponse.json(accounts);
}

export async function POST(req: NextRequest) {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { display_name, username, password, is_alist, auto_upgrade_seats, owner_user_id } =
    await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }
  // Members always own what they create; only admins may assign to someone else.
  const owner = ctx.isAdmin && owner_user_id ? owner_user_id : ctx.userId;

  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO accounts (id, display_name, username, password, is_alist, auto_upgrade_seats, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, display_name || "", username, encryptSecret(password), is_alist ? 1 : 0, auto_upgrade_seats ? 1 : 0, owner);
  const account = db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts a WHERE a.id = ?`)
    .get(id);
  return NextResponse.json(account, { status: 201 });
}
