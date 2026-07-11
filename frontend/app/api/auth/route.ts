import { NextRequest, NextResponse } from "next/server";
import { authenticateUser, createToken, getSessionUser, authConfigError } from "@/lib/auth";
import { isRateLimited, recordFailure, recordSuccess, clientIp } from "@/lib/rate-limit";
import { getDb } from "@/lib/db";

function logAuthEvent(message: string, level: "info" | "warning") {
  try {
    getDb()
      .prepare("INSERT INTO worker_logs (level, message) VALUES (?, ?)")
      .run(level, message);
  } catch {
    // never fail a login over a log write
  }
}

export async function POST(req: NextRequest) {
  const configError = authConfigError();
  if (configError) {
    return NextResponse.json({ error: configError }, { status: 500 });
  }

  const { username, password } = await req.json();
  if (typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  const ip = clientIp(req.headers);
  const rlKey = `${ip}:${username.toLowerCase()}`;
  const rl = isRateLimited(rlKey);
  if (rl.limited) {
    logAuthEvent(`Login rate-limited for '${username}' from ${ip}`, "warning");
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${Math.ceil(rl.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  const user = authenticateUser(username, password);
  if (!user) {
    recordFailure(rlKey);
    logAuthEvent(`Failed login for '${username}' from ${ip}`, "warning");
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }
  recordSuccess(rlKey);
  logAuthEvent(`Login: ${user.username} (${user.role}) from ${ip}`, "info");

  const token = createToken(user);
  const response = NextResponse.json({ ok: true, user });
  // `secure` must follow the actual protocol, not NODE_ENV: browsers drop
  // Secure cookies over plain http on non-localhost hosts, which breaks
  // logging in at http://<lan-ip>:3000 from another device.
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const isHttps = (forwardedProto || req.nextUrl.protocol.replace(":", "")) === "https";
  response.cookies.set("sw-checkin-auth", token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60, // 7 days
  });
  return response;
}

export async function GET() {
  const user = getSessionUser();
  return NextResponse.json({ authenticated: user !== null, user });
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("sw-checkin-auth");
  return response;
}
