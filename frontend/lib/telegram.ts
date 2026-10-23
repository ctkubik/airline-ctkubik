// Telegram Bot API helpers shared by the guided setup
// (app/api/notifications/telegram) and the per-service test button
// (app/api/notifications/[id]/test).

export const TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/;
export const CHAT = /^-?\d{1,20}$/;

// People paste tokens with spaces, a "bot" prefix, or the whole API URL.
export function cleanToken(raw: unknown): string {
  let t = String(raw ?? "").replace(/\s+/g, "");
  t = t.replace(/^https?:\/\/api\.telegram\.org\//i, "");
  t = t.replace(/^bot(?=\d)/i, "");
  return t.replace(/\/.*$/, "");
}

export function cleanChatId(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, "");
}

// Problems with a token or chat ID that we can spot before asking Telegram
export function tokenProblem(token: string): string | null {
  if (!token) return "Paste the bot token from BotFather.";
  if (!token.includes(":")) {
    return "That's missing the colon. A bot token looks like 123456789:AAH4k... Copy the whole line from BotFather.";
  }
  if (!TOKEN.test(token)) {
    return "That doesn't look like a bot token. It looks like 123456789:AAH4k... (numbers, a colon, then about 35 letters).";
  }
  return null;
}

export function chatProblem(chatId: string): string | null {
  if (!chatId) return "Pick a chat (click Find my chat) or type the chat ID.";
  if (chatId.startsWith("@")) {
    return "Use the number for the chat, not the @username. Click Find my chat, or get the number from @userinfobot.";
  }
  if (!CHAT.test(chatId)) return "A chat ID is a number, like 123456789 (groups start with a minus sign, like -1001234567890).";
  return null;
}

// tgram://<token>/<chat id>[/<chat id>...][?options]
export function parseTgramUrl(url: string): { token: string; chatIds: string[] } | null {
  const m = /^(?:tgram|telegram):\/\/([^/?#]+)\/?([^?#]*)/i.exec(url.trim());
  if (!m) return null;
  return {
    token: cleanToken(decodeURIComponent(m[1])),
    chatIds: m[2].split("/").map((c) => decodeURIComponent(c).trim()).filter(Boolean),
  };
}

export interface TelegramReply {
  status: number;
  ok?: boolean;
  result?: unknown;
  description?: string;
  parameters?: { migrate_to_chat_id?: number; retry_after?: number };
}

export async function telegram(token: string, method: string, body?: object): Promise<TelegramReply> {
  // TELEGRAM_API_BASE is only for testing against a stand-in server
  const base = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
  const res = await fetch(`${base}/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as Omit<TelegramReply, "status">;
  return { status: res.status, ...data };
}

export function explain(status: number, description?: string, retryAfter?: number): string {
  const d = description || "";
  if (status === 401 || status === 404) {
    return "Telegram didn't recognize that bot token. Copy it again from BotFather (the whole line, numbers, colon and letters). If you sent /revoke, use the new token.";
  }
  if (/chat not found/i.test(d)) {
    return "Telegram can't find that chat. Open your bot in Telegram, tap Start, send it a message, then try again. For a group, the bot must be a member.";
  }
  if (/bot can't initiate conversation|bot can't send messages to bots/i.test(d)) {
    return "The bot can't message you until you message it first. Open your bot in Telegram and tap Start.";
  }
  if (/blocked/i.test(d)) return "That chat blocked the bot. Open the bot in Telegram, tap Unblock or Restart, then try again.";
  if (/kicked|not a member/i.test(d)) return "The bot isn't in that group anymore. Add it back and try again.";
  if (/not enough rights|have no rights/i.test(d)) {
    return "The bot isn't allowed to post in that group or channel. Make it an admin, or allow members to send messages.";
  }
  if (status === 429) return `Telegram is rate limiting this bot. Wait ${retryAfter ?? 30} seconds and try again.`;
  return `Telegram said: ${d || `error ${status}`}`;
}

export function networkProblem(err: unknown): string {
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? "";
  return /ENOTFOUND|EAI_AGAIN|ECONN/.test(code) || /fetch failed|abort|timeout/i.test(String(err))
    ? "Couldn't reach Telegram. Check that this computer is online, then try again."
    : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
}

export interface CheckStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface CheckResult {
  ok: boolean;
  message: string;
  steps: CheckStep[];
  bot?: string;
  // Set when Telegram moved a group to a new chat ID and the test used it
  new_chat_id?: string;
}

// Check a bot token and chat step by step and send a test message, so a
// failure says exactly which part is wrong.
export async function checkTelegram(token: string, chatId: string, text: string): Promise<CheckResult> {
  const steps: CheckStep[] = [];
  const fail = (step: string, detail: string): CheckResult => {
    steps.push({ step, ok: false, detail });
    return { ok: false, message: detail, steps };
  };

  const tp = tokenProblem(token);
  if (tp) return fail("Bot token format", tp);
  steps.push({ step: "Bot token format", ok: true, detail: "Looks right" });
  const cp = chatProblem(chatId);
  if (cp) return fail("Chat ID format", cp);
  steps.push({ step: "Chat ID format", ok: true, detail: chatId });

  try {
    const me = await telegram(token, "getMe");
    if (!me.ok) return fail("Bot token accepted by Telegram", explain(me.status, me.description));
    const info = me.result as { username?: string; first_name?: string };
    const bot = info.username ? `@${info.username}` : info.first_name || "your bot";
    steps.push({ step: "Bot token accepted by Telegram", ok: true, detail: bot });

    let target = chatId;
    let sent = await telegram(token, "sendMessage", { chat_id: target, text });
    const moved = sent.parameters?.migrate_to_chat_id;
    if (!sent.ok && moved) {
      target = String(moved);
      steps.push({ step: "Chat moved", ok: true, detail: `The group has a new chat ID: ${target}` });
      sent = await telegram(token, "sendMessage", { chat_id: target, text });
    }
    if (!sent.ok) {
      const r = fail("Message delivered", explain(sent.status, sent.description, sent.parameters?.retry_after));
      return { ...r, bot };
    }
    const chat = (sent.result as { chat?: { title?: string; first_name?: string } })?.chat;
    steps.push({ step: "Message delivered", ok: true, detail: chat?.title || chat?.first_name || target });
    return {
      ok: true,
      message: `Sent through ${bot}. Check Telegram for the test message.`,
      steps,
      bot,
      new_chat_id: target !== chatId ? target : undefined,
    };
  } catch (err) {
    return fail("Reach Telegram", networkProblem(err));
  }
}
