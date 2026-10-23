// Settings people enter on the API Connections page. A value saved there wins
// over the same name in .env; with neither, the default applies. The worker
// reads the same table (worker/lib/app_settings.py), so changes apply within
// a minute with no restart. API keys are encrypted like account passwords.
import { getDb } from "./db";
import { decryptPassword, encryptPassword } from "./credentials";

interface SettingDef {
  secret?: boolean;
  default: string;
  // Allowed values: "int" (whole number >= 0), "bool", "url", "text"
  kind: "int" | "bool" | "url" | "text";
}

export const SETTINGS: Record<string, SettingDef> = {
  AERODATABOX_API_KEY: { secret: true, default: "", kind: "text" },
  FLIGHT_STATUS_DELAY_MINUTES: { default: "15", kind: "int" },
  FLIGHT_STATUS_MONTHLY_LIMIT: { default: "550", kind: "int" },
  SERPAPI_API_KEY: { secret: true, default: "", kind: "text" },
  SERPAPI_MONTHLY_LIMIT: { default: "240", kind: "int" },
  TRIP_PRICE_CHECK_HOURS: { default: "48", kind: "int" },
  TRIP_PRICE_DROP_ALERT: { default: "20", kind: "int" },
  LLM_ENABLED: { default: "", kind: "bool" },
  LLM_BASE_URL: { default: "http://localhost:1234/v1", kind: "url" },
  LLM_MODEL: { default: "", kind: "text" },
  LLM_TIMEOUT: { default: "60", kind: "int" },
  LLM_API_KEY: { secret: true, default: "", kind: "text" },
  // Southwest's phone-app service; off means the website does everything
  SOUTHWEST_PHONE_APP: { default: "", kind: "bool" },
};

export type SettingSource = "app" | "env" | "default";

function stored(name: string): string | null {
  try {
    const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(name) as
      | { value: string }
      | undefined;
    if (row === undefined) return null;
    return SETTINGS[name]?.secret ? decryptPassword(row.value) : row.value;
  } catch {
    return null;
  }
}

export function settingSource(name: string): SettingSource {
  if (stored(name) !== null) return "app";
  return process.env[name]?.trim() ? "env" : "default";
}

export function getSetting(name: string): string {
  const fromApp = stored(name);
  if (fromApp !== null) return fromApp;
  const fromEnv = process.env[name]?.trim();
  return fromEnv || SETTINGS[name]?.default || "";
}

export function settingNumber(name: string): number {
  const n = Number(getSetting(name));
  return Number.isFinite(n) ? n : Number(SETTINGS[name]?.default || 0);
}

export function settingOn(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(getSetting(name).trim().toLowerCase());
}

// Returns an error message, or null when saved. An empty value removes the
// app's value (falling back to .env or the default).
export function saveSetting(name: string, value: string, by: string): string | null {
  const def = SETTINGS[name];
  if (!def) return `Unknown setting ${name}`;
  const v = value.trim();
  const db = getDb();
  if (v === "") {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(name);
    return null;
  }
  if (def.kind === "int" && !/^\d{1,6}$/.test(v)) return `${name} must be a whole number`;
  if (def.kind === "bool" && !/^(true|false)$/.test(v)) return `${name} must be true or false`;
  if (def.kind === "url") {
    try {
      const u = new URL(v);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      return "Enter a full address like http://localhost:1234/v1";
    }
  }
  if (v.length > 500 || /[\r\n]/.test(v)) return `${name} doesn't look right`;
  if (name === "LLM_BASE_URL") {
    // Save it with /v1 so the worker and dashboard agree
    const u = new URL(v);
    if (u.pathname === "" || u.pathname === "/") return saveSetting(name, `${v.replace(/\/+$/, "")}/v1`, by);
  }
  db.prepare(
    "INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
  ).run(name, def.secret ? encryptPassword(v) : v, by);
  return null;
}

// What the page may see: secrets only as their last 4 characters
export function publicSettings() {
  const out: Record<string, { value: string; source: SettingSource; secret: boolean; default: string }> = {};
  for (const [name, def] of Object.entries(SETTINGS)) {
    const raw = getSetting(name);
    const value = def.kind === "bool" ? (settingOn(name) ? "true" : "false") : raw;
    out[name] = {
      value: def.secret ? (value ? `••••${value.slice(-4)}` : "") : value,
      source: settingSource(name),
      secret: Boolean(def.secret),
      default: def.default,
    };
  }
  return out;
}
