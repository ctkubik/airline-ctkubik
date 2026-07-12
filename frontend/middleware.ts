import { NextRequest, NextResponse } from "next/server";

// No production fallback: a well-known default secret would let anyone forge
// a valid auth cookie. Must stay in sync with lib/auth.ts getSecret().
function getSecret(): string | null {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (process.env.NODE_ENV !== "production") return "dev-secret-do-not-use";
  return null;
}

// Token format (must stay in sync with lib/auth.ts):
// base64url(JSON{u, r, exp}) + "." + hex(HMAC-SHA256(payload))
async function verifyToken(token: string): Promise<boolean> {
  const secret = getSecret();
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, hmac] = parts;

  // Use Web Crypto API (Edge-compatible)
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expected = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expected.length !== hmac.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ hmac.charCodeAt(i);
  }
  if (mismatch !== 0) return false;

  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const data = JSON.parse(atob(base64));
    return typeof data.exp === "number" && Date.now() <= data.exp;
  } catch {
    return false;
  }
}

function withSecurityHeaders(response: NextResponse, request: NextRequest): NextResponse {
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (request.headers.get("x-forwarded-proto") === "https") {
    response.headers.set("Strict-Transport-Security", "max-age=15552000");
  }
  return response;
}

// CSRF defense-in-depth (cookies are already SameSite=Lax): reject mutating
// requests whose Origin doesn't match the host they arrived on.
function crossOriginWrite(request: NextRequest): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false; // same-origin fetches and non-browser clients
  try {
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (crossOriginWrite(request)) {
    return withSecurityHeaders(
      NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 }),
      request
    );
  }

  // Allow login page and auth API without authentication.
  // /api/health is exempt so Docker healthchecks work without a cookie.
  // The iCalendar feed (/api/calendar/<token>) is token-authenticated so
  // calendar apps can subscribe without a cookie — but /api/calendar/token
  // (managing your own token) still requires auth.
  const isCalendarFeed =
    pathname.startsWith("/api/calendar/") && pathname !== "/api/calendar/token";
  if (pathname === "/login" || pathname === "/api/auth" || pathname === "/api/health" || isCalendarFeed) {
    return withSecurityHeaders(NextResponse.next(), request);
  }

  // Allow static assets
  if (pathname.startsWith("/_next") || pathname === "/favicon.ico") {
    return NextResponse.next();
  }

  const token = request.cookies.get("sw-checkin-auth")?.value;

  if (!token || !(await verifyToken(token))) {
    if (pathname.startsWith("/api/")) {
      return withSecurityHeaders(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        request
      );
    }
    return withSecurityHeaders(NextResponse.redirect(new URL("/login", request.url)), request);
  }

  return withSecurityHeaders(NextResponse.next(), request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
