import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { llmChat, llmEnabled } from "@/lib/llm";

export const dynamic = "force-dynamic";

interface DiagnosticRow {
  id: number;
  category: string;
  endpoint: string | null;
  expected_behavior: string | null;
  actual_behavior: string | null;
  response_snapshot: string | null;
  created_at: string;
  ai_explanation: string | null;
}

const SYSTEM_PROMPT = `You explain errors from a self-hosted app that automatically checks people in to Southwest Airlines flights, tracks fare drops, and tries seat upgrades. The app talks to Southwest's private mobile API through a real Chrome browser so Southwest's bot protection (WAF) lets it through.

Explain the diagnostic for a non-technical owner in plain English:
1. What happened (one or two sentences).
2. The most likely cause.
3. What they should do, if anything. Say so plainly when it is a temporary Southwest-side problem that will retry on its own.

Keep it under 120 words. No headings, no markdown tables. Never invent details that are not in the diagnostic.`;

// POST { id } -> { explanation }. Cached on the diagnostic row; pass
// { refresh: true } to regenerate.
export async function POST(req: NextRequest) {
  if (!llmEnabled()) {
    return NextResponse.json(
      { error: "The local LLM is turned off. Set LLM_ENABLED=true in .env and restart." },
      { status: 400 }
    );
  }

  const { id, refresh } = (await req.json().catch(() => ({}))) as { id?: number; refresh?: boolean };
  const db = getDb();
  const row = db.prepare("SELECT * FROM diagnostics WHERE id = ?").get(Number(id)) as DiagnosticRow | undefined;
  if (!row) {
    return NextResponse.json({ error: "Diagnostic not found" }, { status: 404 });
  }
  if (row.ai_explanation && !refresh) {
    return NextResponse.json({ explanation: row.ai_explanation, cached: true });
  }

  const details = [
    `Category: ${row.category}`,
    `When (UTC): ${row.created_at}`,
    `Endpoint: ${row.endpoint || "n/a"}`,
    `Expected: ${row.expected_behavior || "n/a"}`,
    `Actual: ${(row.actual_behavior || "n/a").slice(0, 1500)}`,
    `Response body (truncated): ${(row.response_snapshot || "n/a").slice(0, 1500)}`,
  ].join("\n");

  const reply = await llmChat(SYSTEM_PROMPT, details, 400);
  const explanation = reply?.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!explanation) {
    return NextResponse.json(
      { error: "Couldn't get an answer from the local LLM. Check that LM Studio is running with a model loaded." },
      { status: 502 }
    );
  }

  db.prepare("UPDATE diagnostics SET ai_explanation = ? WHERE id = ?").run(explanation, row.id);
  return NextResponse.json({ explanation, cached: false });
}
