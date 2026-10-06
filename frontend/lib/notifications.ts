// Helpers for the notification services API (app/api/notifications).

// Service URLs hold secrets (Twilio auth tokens, bot tokens). Only the worker
// needs the full URL, so the dashboard gets a masked version.
export function maskServiceUrl(url: string): string {
  const scheme = url.match(/^([a-z0-9+.-]+):\/\//i)?.[1] ?? "";
  const rest = url.slice(scheme ? scheme.length + 3 : 0);
  const tail = rest.length > 8 ? rest.slice(-4) : "";
  return `${scheme ? scheme + "://" : ""}••••${tail}`;
}

// account_ids: a list of Southwest account ids, or empty/null for everyone
export function normalizeAccountIds(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return ids.length ? JSON.stringify(ids) : null;
}

export function normalizeLevel(value: unknown): number {
  const n = Number(value);
  return n >= 1 && n <= 3 ? Math.round(n) : 1;
}
