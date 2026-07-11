import { NextRequest, NextResponse } from "next/server";
import { verifyCredentials, createToken, isAuthenticated, authConfigError } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const configError = authConfigError();
  if (configError) {
    return NextResponse.json({ error: configError }, { status: 500 });
  }

  const { username, password } = await req.json();

  if (!verifyCredentials(username, password)) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const token = createToken();
  const response = NextResponse.json({ ok: true });
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
  return NextResponse.json({ authenticated: isAuthenticated() });
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("sw-checkin-auth");
  return response;
}
