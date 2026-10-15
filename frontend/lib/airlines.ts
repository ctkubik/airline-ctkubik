// Airlines, loyalty programs and airport time zones for trips on any airline.
import programs from "./loyalty-programs.json";
import airportTimezones from "./airport-timezones.json";

export interface LoyaltyProgram {
  name: string;
  airline: string;
  unit: string;
  home_url: string;
  tiers: string[];
}

// Same file as worker/lib/loyalty_programs.json (a worker test checks they match)
export const PROGRAMS = programs as Record<string, LoyaltyProgram>;

// Two-letter codes used in flight numbers ("DL 1234")
export const AIRLINES: { name: string; code: string }[] = [
  { name: "Alaska", code: "AS" },
  { name: "Allegiant", code: "G4" },
  { name: "American", code: "AA" },
  { name: "Breeze", code: "MX" },
  { name: "Delta", code: "DL" },
  { name: "Frontier", code: "F9" },
  { name: "Hawaiian", code: "HA" },
  { name: "JetBlue", code: "B6" },
  { name: "Southwest", code: "WN" },
  { name: "Spirit", code: "NK" },
  { name: "Sun Country", code: "SY" },
  { name: "United", code: "UA" },
  { name: "Aer Lingus", code: "EI" },
  { name: "Aeromexico", code: "AM" },
  { name: "Air Canada", code: "AC" },
  { name: "Air France", code: "AF" },
  { name: "British Airways", code: "BA" },
  { name: "Emirates", code: "EK" },
  { name: "Iberia", code: "IB" },
  { name: "Icelandair", code: "FI" },
  { name: "Japan Airlines", code: "JL" },
  { name: "KLM", code: "KL" },
  { name: "Lufthansa", code: "LH" },
  { name: "Qantas", code: "QF" },
  { name: "Qatar Airways", code: "QR" },
  { name: "Singapore Airlines", code: "SQ" },
  { name: "Virgin Atlantic", code: "VS" },
  { name: "WestJet", code: "WS" },
];

export function airlineCode(name: string): string {
  const n = name.trim().toLowerCase();
  return AIRLINES.find((a) => a.name.toLowerCase() === n || a.code.toLowerCase() === n)?.code ?? "";
}

// "DL", "delta" or "Delta Air Lines" -> "Delta", so spending groups by airline
export function airlineName(nameOrCode: string): string {
  const n = nameOrCode.trim().toLowerCase();
  const exact = AIRLINES.find((a) => a.name.toLowerCase() === n || a.code.toLowerCase() === n);
  if (exact) return exact.name;
  const prefix = AIRLINES.filter((a) => n.startsWith(a.name.toLowerCase() + " ")).sort((a, b) => b.name.length - a.name.length)[0];
  return prefix?.name ?? nameOrCode.trim();
}

export function isSouthwest(name: string): boolean {
  return /^(southwest|wn)$/i.test(name.trim()) || /southwest/i.test(name);
}

const TZ = airportTimezones as Record<string, string>;

export function airportTimezone(code: string | null | undefined): string | null {
  return (code && TZ[code.trim().toUpperCase()]) || null;
}

// Offset (ms) of a time zone from UTC at a given instant
function tzOffset(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - at.getTime();
}

// "2026-11-20T07:15" at airport "PHX" -> UTC ISO string. Without a known
// time zone, the server's own zone is used (close enough for a calendar).
export function localToUtcIso(local: string | null | undefined, airport: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(local || "");
  if (!m) return null;
  const [y, mo, d, h = "00", mi = "00"] = m.slice(1);
  const tz = airportTimezone(airport);
  if (!tz) return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).toISOString();
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  // Two passes handle a daylight-saving change between the guess and the answer
  let utc = guess - tzOffset(tz, new Date(guess));
  utc = guess - tzOffset(tz, new Date(utc));
  return new Date(utc).toISOString();
}
