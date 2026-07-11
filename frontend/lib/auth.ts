import { cookies } from "next/headers";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { getDb } from "./db";

const AUTH_COOKIE = "sw-checkin-auth";
const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SessionUser {
  username: string;
  role: "admin" | "member";
}

// In production there are NO fallback credentials: a well-known default
// secret would let anyone forge a valid auth cookie. The Docker entrypoint
// generates and persists AUTH_SECRET/AUTH_PASSWORD automatically if unset.
function getSecret(): string | null {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (process.env.NODE_ENV !== "production") return "dev-secret-do-not-use";
  return null;
}

function getEnvPassword(): string | null {
  if (process.env.AUTH_PASSWORD) return process.env.AUTH_PASSWORD;
  if (process.env.NODE_ENV !== "production") return "admin";
  return null;
}

function getEnvUsername(): string {
  return process.env.AUTH_USERNAME || "admin";
}

export function authConfigError(): string | null {
  if (!getSecret()) {
    return (
      "AUTH_SECRET is not set. Set it in your .env file. " +
      "(The Docker image generates it automatically — check the container logs.)"
    );
  }
  // Env password is only required until at least one user account exists.
  if (!getEnvPassword()) {
    const count = (getDb().prepare("SELECT COUNT(*) as c FROM users WHERE is_active = 1").get() as { c: number }).c;
    if (count === 0) {
      return (
        "No users exist yet and AUTH_PASSWORD is not set. Set it in your .env file " +
        "(or let the Docker entrypoint generate one — see container logs), then log " +
        "in once as admin to create user accounts."
      );
    }
  }
  return null;
}

/**
 * Check credentials against the users table, with the AUTH_USERNAME /
 * AUTH_PASSWORD environment pair acting as a break-glass admin login that
 * also bootstraps the first admin user row.
 */
export function authenticateUser(username: string, password: string): SessionUser | null {
  const db = getDb();

  const envPassword = getEnvPassword();
  if (
    envPassword &&
    timingSafeStringEqual(username, getEnvUsername()) &&
    timingSafeStringEqual(password, envPassword)
  ) {
    // Ensure the env admin exists as a real user row so it shows up in the
    // Users page and can own things.
    const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (!existing) {
      db.prepare(
        "INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'admin')"
      ).run(crypto.randomUUID(), username, bcrypt.hashSync(password, 10), "Administrator");
    }
    return { username, role: "admin" };
  }

  const row = db
    .prepare("SELECT username, password_hash, role, is_active FROM users WHERE username = ?")
    .get(username) as { username: string; password_hash: string; role: string; is_active: number } | undefined;
  if (!row || !row.is_active) return null;
  if (!bcrypt.compareSync(password, row.password_hash)) return null;
  return { username: row.username, role: row.role === "admin" ? "admin" : "member" };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch; compare against self to keep
  // timing constant while still returning false.
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufB, bufB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createToken(user: SessionUser): string {
  const secret = getSecret();
  if (!secret) {
    throw new Error("AUTH_SECRET is not set");
  }
  const payload = Buffer.from(
    JSON.stringify({ u: user.username, r: user.role, exp: Date.now() + TOKEN_EXPIRY })
  ).toString("base64url");
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

export function verifyToken(token: string): SessionUser | null {
  const secret = getSecret();
  if (!secret) return null;

  const [payload, hmac] = token.split(".");
  if (!payload || !hmac) return null;

  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (!timingSafeStringEqual(hmac, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof data.exp !== "number" || Date.now() > data.exp) return null;
    if (typeof data.u !== "string") return null;
    return { username: data.u, role: data.r === "admin" ? "admin" : "member" };
  } catch {
    return null;
  }
}

export function getSessionUser(): SessionUser | null {
  const cookieStore = cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  if (!token) return null;
  return verifyToken(token);
}

export function isAuthenticated(): boolean {
  return getSessionUser() !== null;
}

export function isAdmin(): boolean {
  return getSessionUser()?.role === "admin";
}
