import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAccessContext } from "@/lib/access";
import { encryptSecret, decryptSecret } from "@/lib/secrets";
import { generateBase32Secret, provisioningUri, verifyTotp } from "@/lib/totp";

/*
  Two-factor auth (TOTP) management for the current user.
  GET    → { enabled }
  POST   → start enrollment: returns a new secret + otpauth URI (not yet enabled)
  PUT    → confirm enrollment with a code → enables 2FA
  DELETE → disable 2FA (requires a valid current code)
*/

export function GET() {
  const ctx = getAccessContext();
  if (!ctx?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const row = getDb().prepare("SELECT totp_enabled FROM users WHERE id = ?").get(ctx.userId) as
    | { totp_enabled: number }
    | undefined;
  return NextResponse.json({ enabled: !!row?.totp_enabled });
}

export function POST() {
  const ctx = getAccessContext();
  if (!ctx?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const secret = generateBase32Secret();
  // Store the pending secret (encrypted) but leave 2FA disabled until confirmed.
  getDb()
    .prepare("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?")
    .run(encryptSecret(secret), ctx.userId);
  return NextResponse.json({
    secret,
    otpauth_uri: provisioningUri(secret, ctx.user.username),
  });
}

export async function PUT(req: NextRequest) {
  const ctx = getAccessContext();
  if (!ctx?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { code } = await req.json();
  const db = getDb();
  const row = db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(ctx.userId) as
    | { totp_secret: string | null }
    | undefined;
  if (!row?.totp_secret) {
    return NextResponse.json({ error: "Start enrollment first" }, { status: 400 });
  }
  const secret = decryptSecret(row.totp_secret);
  if (!verifyTotp(secret, String(code || ""))) {
    return NextResponse.json({ error: "That code didn't match. Check your authenticator app." }, { status: 400 });
  }
  db.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(ctx.userId);
  return NextResponse.json({ ok: true, enabled: true });
}

export async function DELETE(req: NextRequest) {
  const ctx = getAccessContext();
  if (!ctx?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { code } = await req.json().catch(() => ({}));
  const db = getDb();
  const row = db.prepare("SELECT totp_secret, totp_enabled FROM users WHERE id = ?").get(ctx.userId) as
    | { totp_secret: string | null; totp_enabled: number }
    | undefined;
  if (row?.totp_enabled && row.totp_secret) {
    // Require a valid code to turn it off (prevents a hijacked session disabling it silently).
    if (!verifyTotp(decryptSecret(row.totp_secret), String(code || ""))) {
      return NextResponse.json({ error: "Enter a current code to disable 2FA" }, { status: 400 });
    }
  }
  db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?").run(ctx.userId);
  return NextResponse.json({ ok: true, enabled: false });
}
