import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { encryptPassword } from "@/lib/credentials";
import { PROGRAMS } from "@/lib/airlines";
import { cleanBalance, cleanUrl, listLoyalty, recordBalance } from "@/lib/loyalty";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    accounts: listLoyalty(getDb()),
    programs: PROGRAMS,
    sync_interval_hours: Number(process.env.LOYALTY_SYNC_INTERVAL_HOURS || 72),
    // In Docker the Chrome window is on a virtual screen nobody can see
    can_sign_in_by_hand: (process.env.BROWSER_MODE || (process.platform === "darwin" ? "headed" : "")) === "headed",
  });
}

export async function POST(req: NextRequest) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const program = typeof b.program === "string" && PROGRAMS[b.program] ? b.program : "";
  if (!program) return NextResponse.json({ error: "Pick a program" }, { status: 400 });
  const info = PROGRAMS[program];
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const programName = str(b.program_name, 60);
  if (program === "other" && !programName) {
    return NextResponse.json({ error: "Name the program" }, { status: 400 });
  }
  const balance = cleanBalance(b.balance);
  const status = str(b.status_tier, 40);
  const db = getDb();
  const id = crypto.randomUUID();
  const password = typeof b.password === "string" && b.password ? encryptPassword(b.password) : "";
  const firstSync = Boolean(b.sync_enabled && password);
  db.prepare(
    `INSERT INTO loyalty_accounts (id, program, program_name, owner_name, member_number, username, password,
       login_url, account_url, sync_enabled, balance, balance_unit, status_tier, sync_requested,
       last_sync_status, last_sync_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    program,
    programName,
    str(b.owner_name, 60),
    str(b.member_number, 30),
    str(b.username, 120),
    password,
    cleanUrl(b.login_url),
    cleanUrl(b.account_url),
    b.sync_enabled ? 1 : 0,
    balance,
    info.unit,
    status,
    // Saved with a login: try a first sync right away
    firstSync ? "sync" : null,
    firstSync ? "queued" : null,
    firstSync ? "Starting within a minute" : null
  );
  if (balance !== null) recordBalance(db, id, balance, status, "manual");
  return NextResponse.json({ id }, { status: 201 });
}
