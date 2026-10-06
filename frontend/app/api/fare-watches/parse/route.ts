import { NextRequest, NextResponse } from "next/server";
import { llmChatJson, llmEnabled } from "@/lib/llm";

export const dynamic = "force-dynamic";

const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface ParsedWatch {
  name?: unknown;
  origin?: unknown;
  destination?: unknown;
  depart_date_start?: unknown;
  depart_date_end?: unknown;
  return_date_start?: unknown;
  return_date_end?: unknown;
  adults?: unknown;
  nonstop_only?: unknown;
  max_price?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function date(v: unknown): string {
  const s = str(v);
  return ISO_DATE.test(s) && !Number.isNaN(Date.parse(s)) ? s : "";
}

// POST { text } -> form fields for a new fare watch. The LLM only proposes
// values; the user reviews them in the form and the normal create route
// validates them again.
export async function POST(req: NextRequest) {
  if (!llmEnabled()) {
    return NextResponse.json(
      { error: "The local LLM is turned off. Set LLM_ENABLED=true in .env and restart." },
      { status: 400 }
    );
  }
  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  if (!text || !text.trim()) {
    return NextResponse.json({ error: "Describe the trip first" }, { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const system = `You turn a traveler's description of a trip into fields for a flight price watch.
Today's date is ${today}. Resolve relative dates ("next month", "the week of Nov 20", "spring break") to real future dates.
Use 3-letter IATA airport codes. When a city has several airports, use the main one (Chicago = ORD, New York = JFK, Washington = DCA, Phoenix = PHX).
If only one departure date is given, use a window of that date only. If a range like "sometime the week of" is given, cover that week.
Leave return dates empty for one-way trips. Do not guess a return trip that was not mentioned.
Fields:
- name: short friendly label, e.g. "Mom's visit in November"
- origin, destination: IATA codes
- depart_date_start, depart_date_end: YYYY-MM-DD
- return_date_start, return_date_end: YYYY-MM-DD or ""
- adults: number of travelers (default 1)
- nonstop_only: true or false
- max_price: alert price in USD as a number, or null`;

  const parsed = await llmChatJson<ParsedWatch>(system, text.slice(0, 1000), 400);
  if (!parsed) {
    return NextResponse.json(
      { error: "Couldn't get an answer from the local LLM. Check that LM Studio is running with a model loaded." },
      { status: 502 }
    );
  }

  const origin = str(parsed.origin).toUpperCase();
  const destination = str(parsed.destination).toUpperCase();
  let depart_date_start = date(parsed.depart_date_start);
  let depart_date_end = date(parsed.depart_date_end) || depart_date_start;
  if (depart_date_end && depart_date_start && depart_date_end < depart_date_start) {
    [depart_date_start, depart_date_end] = [depart_date_end, depart_date_start];
  }
  let return_date_start = date(parsed.return_date_start);
  let return_date_end = date(parsed.return_date_end) || return_date_start;
  if (return_date_end && return_date_start && return_date_end < return_date_start) {
    [return_date_start, return_date_end] = [return_date_end, return_date_start];
  }
  const adults = Math.max(1, Math.min(9, Math.round(Number(parsed.adults) || 1)));
  const maxPrice = Number(parsed.max_price);

  const fields = {
    name: str(parsed.name).slice(0, 80),
    origin: IATA.test(origin) ? origin : "",
    destination: IATA.test(destination) ? destination : "",
    depart_date_start,
    depart_date_end,
    return_date_start,
    return_date_end,
    adults,
    nonstop_only: parsed.nonstop_only === true,
    max_price: Number.isFinite(maxPrice) && maxPrice > 0 ? Math.round(maxPrice) : null,
  };

  const missing = [
    !fields.origin && "origin",
    !fields.destination && "destination",
    !fields.depart_date_start && "departure date",
  ].filter(Boolean);

  return NextResponse.json({ fields, missing });
}
