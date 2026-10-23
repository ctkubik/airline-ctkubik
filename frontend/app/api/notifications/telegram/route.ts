import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "@/lib/db";
import { normalizeAccountIds, normalizeLevel } from "@/lib/notifications";
import {
  checkTelegram,
  chatProblem,
  cleanChatId,
  cleanToken,
  explain,
  networkProblem,
  telegram,
  tokenProblem,
} from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Guided Telegram setup (components/telegram-setup.tsx). The bot token stays
// on the server side of the dashboard; it's only sent on to Telegram itself.
//   { action: "chats", token }            -> chats that have messaged the bot
//   { action: "test", token, chat_id }    -> check each part and send a test message
//   { action: "save", token, chat_id, label, notification_level, account_ids }
//                                          -> add it as an alert service

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

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const token = cleanToken(body.token);
  const badToken = tokenProblem(token);
  if (badToken) return NextResponse.json({ ok: false, message: badToken }, { status: 400 });
  try {
    if (body.action === "chats") {
      const me = await telegram(token, "getMe");
      if (!me.ok) return NextResponse.json({ ok: false, message: explain(me.status, me.description) });
      const bot = me.result as { username?: string; first_name?: string };
      const updates = await telegram(token, "getUpdates");
      if (!updates.ok) {
        const msg = /webhook/i.test(updates.description || "")
          ? "This bot is connected to another app (a webhook), so the app can't list its chats. Type the chat ID by hand below, or create a new bot just for alerts."
          : /conflict/i.test(updates.description || "")
            ? "Another program is reading this bot's messages right now. Stop it, or type the chat ID by hand below."
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

    let chatId = cleanChatId(body.chat_id);
    const badChat = chatProblem(chatId);
    if (badChat) return NextResponse.json({ ok: false, message: badChat }, { status: 400 });

    if (body.action === "test") {
      return NextResponse.json(
        await checkTelegram(token, chatId, "✈️ Test from Airline Check-In: your flight alerts will arrive here.")
      );
    }

    if (body.action === "save") {
      // Check before saving so a typo doesn't fail silently later. Groups
      // that Telegram moved to a new ID are saved with the new one.
      const check = await checkTelegram(token, chatId, "✅ Airline Check-In alerts are connected to this chat.");
      if (!check.ok) {
        return NextResponse.json({ ok: false, message: `Not saved. ${check.message}`, steps: check.steps });
      }
      chatId = check.new_chat_id ?? chatId;
      const label = String(body.label ?? "").trim().slice(0, 60) || "Telegram";
      getDb()
        .prepare(
          `INSERT INTO notification_configs (id, service_url, notification_level, label, account_ids, last_status, last_sent_at)
           VALUES (?, ?, ?, ?, ?, 'ok', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
        )
        .run(
          crypto.randomUUID(),
          `tgram://${token}/${chatId}`,
          normalizeLevel(body.notification_level),
          label,
          normalizeAccountIds(body.account_ids)
        );
      return NextResponse.json({ ok: true, message: `Saved. Telegram confirmed delivery, and alerts will go to ${label}.` });
    }
    return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, message: networkProblem(err) });
  }
}
