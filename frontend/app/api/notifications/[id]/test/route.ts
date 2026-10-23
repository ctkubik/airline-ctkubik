import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { checkTelegram, parseTgramUrl } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Test one notification service. Telegram is checked right here, step by
// step, so the answer names the exact problem. Other services are handed to
// the worker (it sends with Apprise and saves the result on the service).
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = getDb();
  const row = db.prepare("SELECT id, service_url FROM notification_configs WHERE id = ?").get(params.id) as
    | { id: string; service_url: string }
    | undefined;
  if (!row) return NextResponse.json({ ok: false, message: "That service no longer exists" }, { status: 404 });

  const tg = parseTgramUrl(row.service_url);
  if (tg) {
    const chats = tg.chatIds.length ? tg.chatIds : [""];
    const results = [];
    let url = row.service_url;
    for (const chat of chats) {
      const r = await checkTelegram(tg.token, chat, "✈️ Test from Airline Check-In: your flight alerts will arrive here.");
      // Telegram moved the group to a new ID: save it so alerts keep working
      if (r.new_chat_id) url = url.replace(`/${chat}`, `/${r.new_chat_id}`);
      results.push(r);
    }
    const failed = results.find((r) => !r.ok);
    db.prepare(
      `UPDATE notification_configs SET service_url = ?, last_status = ?, last_error = ?,
         last_sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`
    ).run(url, failed ? "failed" : "ok", failed ? failed.message : null, row.id);
    const moved = results.some((r) => r.new_chat_id);
    return NextResponse.json({
      ok: !failed,
      message: failed
        ? failed.message
        : `${results[0].message}${moved ? " The group's chat ID changed, so the app saved the new one." : ""}`,
      steps: results.flatMap((r) => r.steps),
    });
  }

  db.prepare("INSERT INTO worker_logs (level, message) VALUES ('info', ?)").run(`__TEST_NOTIFICATION__:${row.id}`);
  return NextResponse.json({
    ok: true,
    queued: true,
    message: "Sent to the worker. The result shows here in a few seconds.",
  });
}
