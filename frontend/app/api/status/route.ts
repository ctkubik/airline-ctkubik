import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAccessContext, ownerScope } from "@/lib/access";

export const dynamic = "force-dynamic";

/*
  System status for the in-app health banner: whether the worker is alive
  (heartbeat freshness) and whether any of the caller's Southwest logins are
  currently failing. Scoped by owner — members only see their own accounts.
*/
export function GET() {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();

  const hb = db.prepare("SELECT last_poll_at, browser_ok FROM worker_status WHERE id = 1").get() as
    | { last_poll_at: string | null; browser_ok: number }
    | undefined;

  let workerStale = true;
  let lastPollSeconds: number | null = null;
  if (hb?.last_poll_at) {
    const age = (Date.now() - new Date(hb.last_poll_at + "Z").getTime()) / 1000;
    lastPollSeconds = Math.round(age);
    // The worker polls every 60s; flag stale past ~5 minutes.
    workerStale = age > 300;
  }

  const scope = ownerScope(ctx, "owner_user_id");
  const failing = db
    .prepare(
      `SELECT username, display_name, login_failure_count, last_login_error
       FROM accounts
       WHERE is_active = 1 AND login_failure_count > 0 AND ${scope.clause}`
    )
    .all(...scope.params) as Array<{
    username: string;
    display_name: string;
    login_failure_count: number;
  }>;

  const deactivated = db
    .prepare(
      `SELECT username, display_name FROM accounts
       WHERE is_active = 0 AND last_login_error IS NOT NULL AND ${scope.clause}`
    )
    .all(...scope.params) as Array<{ username: string; display_name: string }>;

  return NextResponse.json({
    worker: {
      stale: workerStale,
      last_poll_seconds: lastPollSeconds,
      browser_ok: hb ? !!hb.browser_ok : false,
    },
    failing_accounts: failing.map((a) => ({
      name: a.display_name || a.username,
      failures: a.login_failure_count,
    })),
    deactivated_accounts: deactivated.map((a) => ({ name: a.display_name || a.username })),
  });
}
