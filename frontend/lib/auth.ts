import { cookies } from "next/headers";
import crypto from "crypto";

const AUTH_COOKIE = "sw-checkin-auth";
const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

// In production there are NO fallback credentials: a well-known default
// secret would let anyone forge a valid auth cookie. The Docker entrypoint
// generates and persists AUTH_SECRET/AUTH_PASSWORD automatically if unset.
function getSecret(): string | null {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (process.env.NODE_ENV !== "production") return "dev-secret-do-not-use";
  return null;
}

function getPassword(): string | null {
  if (process.env.AUTH_PASSWORD) return process.env.AUTH_PASSWORD;
  if (process.env.NODE_ENV !== "production") return "admin";
  return null;
}

function getUsername(): string {
  return process.env.AUTH_USERNAME || "admin";
}

export function authConfigError(): string | null {
  if (!getSecret() || !getPassword()) {
    return (
      "AUTH_SECRET / AUTH_PASSWORD are not set. Set them in your .env file. " +
      "(The Docker image generates them automatically — check the container logs " +
      "for the generated login password.)"
    );
  }
  return null;
}

export function verifyCredentials(username: string, password: string): boolean {
  const expectedPassword = getPassword();
  if (!expectedPassword) return false;
  const userOk = timingSafeStringEqual(username, getUsername());
  const passOk = timingSafeStringEqual(password, expectedPassword);
  return userOk && passOk;
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

export function createToken(): string {
  const secret = getSecret();
  if (!secret) {
    throw new Error("AUTH_SECRET is not set");
  }
  const expiry = Date.now() + TOKEN_EXPIRY;
  const payload = `${expiry}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

export function verifyToken(token: string): boolean {
  const secret = getSecret();
  if (!secret) return false;

  const [payload, hmac] = token.split(".");
  if (!payload || !hmac) return false;

  const expiry = parseInt(payload, 10);
  if (isNaN(expiry) || Date.now() > expiry) return false;

  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return timingSafeStringEqual(hmac, expected);
}

export function isAuthenticated(): boolean {
  const cookieStore = cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  if (!token) return false;
  return verifyToken(token);
}
