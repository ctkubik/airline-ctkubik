// Optional local LLM client (LM Studio or any OpenAI-compatible server).
// Mirrors worker/lib/llm.py and reads the same environment variables:
//   LLM_ENABLED, LLM_BASE_URL (default http://localhost:1234/v1),
//   LLM_MODEL (blank = whatever model is loaded), LLM_TIMEOUT (seconds).
// Every helper returns null on any failure so callers degrade gracefully.

const DEFAULT_BASE_URL = "http://localhost:1234/v1";

export function llmEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.LLM_ENABLED || "").trim().toLowerCase());
}

function baseUrl(): string {
  return (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function timeoutMs(): number {
  const seconds = Number(process.env.LLM_TIMEOUT || 60);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
}

async function listModels(): Promise<string[]> {
  const res = await fetch(`${baseUrl()}/models`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!res.ok) throw new Error(`LLM server returned ${res.status}`);
  const data = (await res.json()) as { data?: { id: string }[] };
  // Embedding models can't chat; skip them when picking automatically.
  return (data.data || []).map((m) => m.id).filter((id) => !id.toLowerCase().includes("embed"));
}

export interface LlmStatus {
  enabled: boolean;
  baseUrl: string;
  reachable: boolean;
  model: string | null;
  error?: string;
}

export async function llmStatus(): Promise<LlmStatus> {
  const status: LlmStatus = { enabled: llmEnabled(), baseUrl: baseUrl(), reachable: false, model: null };
  if (!status.enabled) return status;
  try {
    const models = await listModels();
    status.reachable = true;
    status.model = process.env.LLM_MODEL?.trim() || models[0] || null;
    if (!status.model) status.error = "LM Studio is running but no model is loaded";
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
  }
  return status;
}

export async function llmChat(system: string, user: string, maxTokens = 512): Promise<string | null> {
  if (!llmEnabled()) return null;
  try {
    const model = process.env.LLM_MODEL?.trim() || (await listModels())[0];
    if (!model) return null;
    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs()),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

export async function llmChatJson<T = Record<string, unknown>>(
  system: string,
  user: string,
  maxTokens = 512
): Promise<T | null> {
  const reply = await llmChat(`${system}\nRespond with a single JSON object and nothing else.`, user, maxTokens);
  return reply === null ? null : (extractJson(reply) as T | null);
}

// Pull the first JSON object out of a model reply (handles code fences,
// leading prose, and reasoning-model <think> blocks).
export function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  let start = cleaned.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const value = JSON.parse(cleaned.slice(start, i + 1));
            return value && typeof value === "object" && !Array.isArray(value) ? value : null;
          } catch {
            break;
          }
        }
      }
    }
    start = cleaned.indexOf("{", start + 1);
  }
  return null;
}
