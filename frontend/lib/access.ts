import { getDb } from "./db";
import { getSessionUser, SessionUser } from "./auth";

export interface AccessContext {
  user: SessionUser;
  userId: string | null;
  isAdmin: boolean;
}

/**
 * Resolve the current request's access context.
 *
 * Members are scoped to the rows they own (owner_user_id === their user id);
 * admins see everything. The session token carries username + role; the user
 * id is looked up from the users table (the env break-glass admin is
 * bootstrapped into that table on first login, so it always resolves).
 *
 * Returns null only when there is no valid session (middleware already blocks
 * those, so routes can treat null as 401).
 */
export function getAccessContext(): AccessContext | null {
  const user = getSessionUser();
  if (!user) return null;
  const row = getDb()
    .prepare("SELECT id FROM users WHERE username = ?")
    .get(user.username) as { id: string } | undefined;
  return {
    user,
    userId: row?.id ?? null,
    isAdmin: user.role === "admin",
  };
}

/**
 * SQL fragment that scopes a query to what the context may see.
 * Admins get an always-true clause; members get `column = ?` and the bound id.
 * Members with no resolvable id get a never-true clause (see nothing) — safe.
 */
export function ownerScope(ctx: AccessContext, column: string): { clause: string; params: unknown[] } {
  if (ctx.isAdmin) return { clause: "1=1", params: [] };
  if (!ctx.userId) return { clause: "1=0", params: [] };
  return { clause: `${column} = ?`, params: [ctx.userId] };
}

/**
 * True if the current session may view/act on a given flight, resolved via the
 * flight's reservation owner. Used by the per-flight sub-routes (fares, logs,
 * captures, audits, update, check-seats) so a member can't read another user's
 * flight data by guessing an id.
 */
export function canAccessFlight(ctx: AccessContext, flightId: string): boolean {
  if (ctx.isAdmin) return true;
  if (!ctx.userId) return false;
  const row = getDb()
    .prepare(
      "SELECT r.owner_user_id AS owner FROM flights f " +
        "JOIN reservations r ON r.id = f.reservation_id WHERE f.id = ?"
    )
    .get(flightId) as { owner: string | null } | undefined;
  return !!row && row.owner === ctx.userId;
}
