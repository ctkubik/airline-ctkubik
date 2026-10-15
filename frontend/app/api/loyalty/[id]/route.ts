import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { encryptPassword } from "@/lib/credentials";
import { cleanBalance, cleanUrl, recordBalance } from "@/lib/loyalty";

const SIGNED_IN_MARKER = "__signed_in__"; // worker/lib/loyalty_sync.py

interface Row {
  id: string;
  balance: number | null;
  status_tier: string;
  sync_requested: string | null;
}

// PATCH { action } runs a sync step; PATCH { ...fields } edits the account.
//   action "sync": sync now          "signin": open Chrome to sign in by hand
//   action "code": { code } from the airline   "signed_in": done signing in by hand
//   action "cancel": stop a waiting sync
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const db = getDb();
  const row = db.prepare("SELECT id, balance, status_tier, sync_requested FROM loyalty_accounts WHERE id = ?")
    .get(params.id) as Row | undefined;
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const set = (sql: string, ...args: unknown[]) =>
    db.prepare(`UPDATE loyalty_accounts SET ${sql}, updated_at = datetime('now') WHERE id = ?`).run(...args, params.id);

  switch (b.action) {
    case "sync":
    case "signin":
      if (row.sync_requested) return NextResponse.json({ error: "A sync is already running" }, { status: 409 });
      set(
        "sync_requested = ?, pending_code = NULL, last_sync_status = 'queued', last_sync_message = ?",
        b.action === "sync" ? "sync" : "manual_signin",
        "Starting within a minute"
      );
      return NextResponse.json({ ok: true });
    case "code": {
      const code = typeof b.code === "string" ? b.code.replace(/\s+/g, "") : "";
      if (!/^[A-Za-z0-9-]{3,12}$/.test(code)) {
        return NextResponse.json({ error: "That doesn't look like a code" }, { status: 400 });
      }
      set("pending_code = ?", code);
      return NextResponse.json({ ok: true });
    }
    case "signed_in":
      set("pending_code = ?", SIGNED_IN_MARKER);
      return NextResponse.json({ ok: true });
    case "cancel":
      set("sync_requested = NULL, pending_code = NULL, last_sync_status = 'error', last_sync_message = 'Cancelled'");
      return NextResponse.json({ ok: true });
  }

  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const fields: [string, unknown][] = [];
  if (b.owner_name !== undefined) fields.push(["owner_name", str(b.owner_name, 60)]);
  if (b.program_name !== undefined) fields.push(["program_name", str(b.program_name, 60)]);
  if (b.member_number !== undefined) fields.push(["member_number", str(b.member_number, 30)]);
  if (b.username !== undefined) fields.push(["username", str(b.username, 120)]);
  if (b.login_url !== undefined) fields.push(["login_url", cleanUrl(b.login_url)]);
  if (b.account_url !== undefined) fields.push(["account_url", cleanUrl(b.account_url)]);
  if (b.sync_enabled !== undefined) fields.push(["sync_enabled", b.sync_enabled ? 1 : 0]);
  if (b.status_detail !== undefined) fields.push(["status_detail", str(b.status_detail, 120)]);
  if (b.status_expires !== undefined) fields.push(["status_expires", str(b.status_expires, 40) || null]);
  if (b.points_expire !== undefined) fields.push(["points_expire", str(b.points_expire, 40) || null]);
  if (typeof b.password === "string") {
    // A new password: clear the failure count so automatic syncs resume
    fields.push(["password", b.password ? encryptPassword(b.password) : ""]);
    fields.push(["sync_failures", 0]);
    fields.push(["last_sync_status", null]);
  }
  if (b.sync_enabled) fields.push(["sync_failures", 0]);

  // A balance or status typed in by hand goes into the history too
  const balance = b.balance !== undefined ? cleanBalance(b.balance) : row.balance;
  const status = b.status_tier !== undefined ? str(b.status_tier, 40) : row.status_tier;
  if (b.balance !== undefined) fields.push(["balance", balance]);
  if (b.status_tier !== undefined) fields.push(["status_tier", status]);

  const unique = new Map(fields);
  if (unique.size) {
    set(Array.from(unique.keys()).map((k) => `${k} = ?`).join(", "), ...Array.from(unique.values()));
  }
  if ((balance !== row.balance || status !== row.status_tier) && balance !== null) {
    recordBalance(db, params.id, balance, status, "manual");
  }
  return NextResponse.json({ ok: true });
}

export function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = getDb();
  db.prepare("DELETE FROM loyalty_history WHERE loyalty_account_id = ?").run(params.id);
  const res = db.prepare("DELETE FROM loyalty_accounts WHERE id = ?").run(params.id);
  if (res.changes && /^[A-Za-z0-9-]+$/.test(params.id)) {
    // The account's saved browser sign-in (cookies) and debug captures
    const dataDir = process.env.DATA_DIR || path.resolve("/app", "data");
    for (const dir of [path.join(dataDir, "browser-profiles", params.id), path.join(dataDir, "captures", "loyalty", params.id)]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return NextResponse.json({ ok: true });
}
