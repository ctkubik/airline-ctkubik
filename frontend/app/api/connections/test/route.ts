import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

// POST { service: "lmstudio" | "aerodatabox" | "serpapi", key?, base_url?, model? }
// Tests the values typed on the page (or the saved ones when a field is left
// as is) without saving anything.
export async function POST(req: NextRequest) {
  if (getSessionUser()?.role !== "admin") {
    return NextResponse.json({ ok: false, message: "Only an admin can test API settings" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, string | undefined>;
  const typedKey = (body.key ?? "").trim();
  const keyFor = (name: string) => (typedKey && !typedKey.startsWith("••••") ? typedKey : getSetting(name));
  try {
    switch (body.service) {
      case "lmstudio":
        return NextResponse.json(await testLmStudio(body.base_url || getSetting("LLM_BASE_URL"), body.model ?? getSetting("LLM_MODEL")));
      case "aerodatabox":
        return NextResponse.json(await testAeroDataBox(keyFor("AERODATABOX_API_KEY")));
      case "serpapi":
        return NextResponse.json(await testSerpApi(keyFor("SERPAPI_API_KEY")));
      default:
        return NextResponse.json({ ok: false, message: "Unknown service" }, { status: 400 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { cause?: { code?: string } })?.cause?.code ?? "";
    let message = `Couldn't connect: ${msg}`;
    if (/timeout|abort/i.test(msg)) message = "No answer in time. Try again in a minute.";
    else if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/.test(code)) {
      message = "Couldn't reach the service. Check that this computer is online, then try again.";
    }
    return NextResponse.json({ ok: false, message });
  }
}

async function testLmStudio(baseUrl: string, model: string) {
  const base = baseUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
  } catch {
    return {
      ok: false,
      message: `Nothing answered at ${base}. Open LM Studio, go to the Developer tab, and start the server.`,
    };
  }
  if (!res.ok) return { ok: false, message: `LM Studio answered with error ${res.status}.` };
  const data = (await res.json()) as { data?: { id: string }[] };
  const models = (data.data || []).map((m) => m.id).filter((id) => !id.toLowerCase().includes("embed"));
  if (!models.length) {
    return { ok: false, models, message: "LM Studio is running but no chat model is loaded. Load one in LM Studio." };
  }
  const use = model && models.includes(model) ? model : models[0];
  const started = Date.now();
  const chat = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: use,
      messages: [
        { role: "system", content: "You are a connection test. Answer briefly." },
        { role: "user", content: "Reply with the single word OK." },
      ],
      max_tokens: 20,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60000),
    cache: "no-store",
  });
  if (!chat.ok) return { ok: false, models, message: `The model ${use} didn't answer (error ${chat.status}).` };
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const note = model && !models.includes(model) ? ` The model "${model}" isn't loaded, so it used ${use}.` : "";
  return { ok: true, models, message: `Connected. ${use} answered in ${seconds} seconds.${note}` };
}

async function testAeroDataBox(key: string) {
  if (!key) return { ok: false, message: "Enter your RapidAPI key first." };
  const host = "aerodatabox.p.rapidapi.com";
  const res = await fetch(`https://${host}/airports/iata/PHX`, {
    headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host },
    signal: AbortSignal.timeout(20000),
    cache: "no-store",
  });
  // A test lookup counts toward the month like any other
  const month = new Date().toISOString().slice(0, 7);
  getDb()
    .prepare(
      "INSERT INTO system_state (key, value, updated_at) VALUES (?, '1', datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1, updated_at = excluded.updated_at"
    )
    .run(`aerodatabox_lookups:${month}`);
  if (res.status === 401 || res.status === 403) {
    const text = await res.text();
    return {
      ok: false,
      message: /not subscribed/i.test(text)
        ? "The key works, but it isn't subscribed to AeroDataBox yet. On the AeroDataBox page in RapidAPI, click Subscribe and pick the free Basic plan."
        : "RapidAPI didn't accept that key. Copy it again from the X-RapidAPI-Key line on the AeroDataBox page.",
    };
  }
  if (res.status === 429) return { ok: false, message: "The key works, but this month's free lookups are used up." };
  if (!res.ok) return { ok: false, message: `AeroDataBox answered with error ${res.status}.` };
  const data = (await res.json()) as { name?: string };
  return { ok: true, message: `Connected. Test lookup found ${data.name || "Phoenix Sky Harbor"} (used 1 lookup).` };
}

async function testSerpApi(key: string) {
  if (!key) return { ok: false, message: "Enter your SerpApi key first." };
  // The account endpoint is free and doesn't use a search
  const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`, {
    signal: AbortSignal.timeout(20000),
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: "SerpApi didn't accept that key. Copy it again from serpapi.com/manage-api-key." };
  }
  if (!res.ok) return { ok: false, message: `SerpApi answered with error ${res.status}.` };
  const a = (await res.json()) as {
    error?: string;
    plan_name?: string;
    searches_per_month?: number;
    total_searches_left?: number;
    plan_searches_left?: number;
    this_month_usage?: number;
  };
  if (a.error) return { ok: false, message: `SerpApi: ${a.error}` };
  const left = a.total_searches_left ?? a.plan_searches_left;
  return {
    ok: true,
    message:
      `Connected to the ${a.plan_name || "SerpApi"} plan` +
      (a.searches_per_month ? ` (${a.searches_per_month} searches a month)` : "") +
      (left !== undefined ? `, ${left} searches left this month.` : "."),
  };
}
