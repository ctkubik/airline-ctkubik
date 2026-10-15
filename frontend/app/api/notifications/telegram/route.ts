import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "@/lib/db";
import { normalizeAccountIds, normalizeLevel } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// Guided Telegram setup (components/telegram-setup.tsx). The bot token stays
// on the server side of the dashboard; it's only sent on to Telegram itself.
//   { action: "chats", token }            -> chats that have messaged the bot
//   { action: "test", token, chat_id }    -> send a test message
//   { action: "save", token, chat_id, label, notification_level, account_ids }
//                                          -> add it as an alert service

const TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/;
const CHAT = /^-?\d{1,20}$/;

interface Update {
  message?: { chat?: Chat; from?: { first_name?: string } };
  my_chat_member?: { chat?: Chat };
  channel_post?: { chat?: Chat };
}

interface Chat {
  id: number;
  type: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

async function telegram(token: string, method: string, body?: object) {
  // TELEGRAM_API_BASE is only for testing against a stand-in server
  const base = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
  const res = await fetch(`${base}/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
  return { status: res.status, ...data };
}

function explain(status: number, description?: string): string {
  if (status === 401 || status === 404) {
    return "Telegram didn't recognize that bot token. Copy it again from BotFather (the whole line, numbers, colon and letters).";
  }
  if (/chat not found/i.test(description || "")) {
    return "Telegram can't find that chat. Open your bot in Telegram, tap Start, send it a message, then click Find my chat again.";
  }
  if (/blocked/i.test(description || "")) return "That chat blocked the bot. Unblock it in Telegram and try again.";
  if (/kicked|not a member/i.test(description || "")) return "The bot isn't in that group anymore. Add it back and try again.";
  return `Telegram said: ${description || `error ${status}`}`;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const token = String(body.token ?? "").trim();
  if (!TOKEN.test(token)) {
    return NextResponse.json(
      { ok: false, message: "That doesn't look like a bot token. It looks like 123456789:AAH4k... (numbers, a colon, then letters)." },
      { status: 400 }
    );
  }
  try {
    if (body.action === "chats") {
      const me = await telegram(token, "getMe");
      if (!me.ok) return NextResponse.json({ ok: false, message: explain(me.status, me.description) });
      const bot = me.result as { username?: string; first_name?: string };
      const updates = await telegram(token, "getUpdates");
      if (!updates.ok) {
        const msg = /webhook/i.test(updates.description || "")
          ? "This bot is connected to another app (a webhook). Create a new bot just for alerts."
          : explain(updates.status, updates.description);
        return NextResponse.json({ ok: false, message: msg });
      }
      const chats = new Map<string, { id: string; name: string; type: string }>();
      for (const u of (updates.result as Update[]) || []) {
        const chat = u.message?.chat || u.my_chat_member?.chat || u.channel_post?.chat;
        if (!chat) continue;
        const name =
          chat.title ||
          [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
          (chat.username ? `@${chat.username}` : String(chat.id));
        chats.set(String(chat.id), {
          id: String(chat.id),
          name,
          type: chat.type === "private" ? "Direct chat" : chat.type === "channel" ? "Channel" : "Group",
        });
      }
      return NextResponse.json({
        ok: true,
        bot: bot.username ? `@${bot.username}` : bot.first_name,
        bot_link: bot.username ? `https://t.me/${bot.username}` : null,
        chats: Array.from(chats.values()),
      });
    }

    const chatId = String(body.chat_id ?? "").trim();
    if (!CHAT.test(chatId)) {
      return NextResponse.json({ ok: false, message: "Pick a chat first (click Find my chat)." }, { status: 400 });
    }

    if (body.action === "test") {
      const sent = await telegram(token, "sendMessage", {
        chat_id: chatId,
        text: "✈️ Test from Airline Check-In: your flight alerts will arrive here.",
      });
      return NextResponse.json(
        sent.ok
          ? { ok: true, message: "Sent. Check Telegram for the test message." }
          : { ok: false, message: explain(sent.status, sent.description) }
      );
    }

    if (body.action === "save") {
      const label = String(body.label ?? "").trim().slice(0, 60) || "Telegram";
      getDb()
        .prepare(
          "INSERT INTO notification_configs (id, service_url, notification_level, label, account_ids) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          crypto.randomUUID(),
          `tgram://${token}/${chatId}`,
          normalizeLevel(body.notification_level),
          label,
          normalizeAccountIds(body.account_ids)
        );
      return NextResponse.json({ ok: true, message: `Saved. Alerts will go to ${label}.` });
    }
    return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code ?? "";
    return NextResponse.json({
      ok: false,
      message: /ENOTFOUND|EAI_AGAIN|ECONN/.test(code) || /fetch failed|abort|timeout/i.test(String(err))
        ? "Couldn't reach Telegram. Check that this computer is online, then try again."
        : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
