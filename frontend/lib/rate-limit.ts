/**
 * In-memory login rate limiter (single-process app, so no store needed).
 *
 * Sliding lockout: after MAX_ATTEMPTS failures within WINDOW_MS for the same
 * key (client IP + username), further attempts are rejected until the window
 * expires. Successful login clears the counter.
 */

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 8;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function sweep() {
  const now = Date.now();
  buckets.forEach((b, k) => {
    if (b.resetAt <= now) buckets.delete(k);
  });
}

export function isRateLimited(key: string): { limited: boolean; retryAfterSec: number } {
  const b = buckets.get(key);
  if (!b || b.resetAt <= Date.now()) return { limited: false, retryAfterSec: 0 };
  if (b.count < MAX_ATTEMPTS) return { limited: false, retryAfterSec: 0 };
  return { limited: true, retryAfterSec: Math.ceil((b.resetAt - Date.now()) / 1000) };
}

export function recordFailure(key: string): void {
  if (buckets.size > 10000) sweep(); // bound memory under abuse
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    b.count += 1;
  }
}

export function recordSuccess(key: string): void {
  buckets.delete(key);
}

/** Client IP for rate limiting: Cloudflare header first, then proxy chain. */
export function clientIp(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip") ||
    headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown"
  );
}
