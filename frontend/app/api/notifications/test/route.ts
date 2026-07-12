import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAccessContext } from "@/lib/access";

export const dynamic = "force-dynamic";

export async function POST() {
  const ctx = getAccessContext();
  if (!ctx?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();

  // Test the caller's own services + shared/global ones (matches routing).
  const configs = db
    .prepare(
      "SELECT id FROM notification_configs WHERE is_active = 1 AND (user_id = ? OR user_id IS NULL OR user_id = '')"
    )
    .all(ctx.userId);

  if (!configs || configs.length === 0) {
    return NextResponse.json(
      { error: "No notification services configured for you yet. Add one below first." },
      { status: 400 }
    );
  }

  // The worker picks this marker up and sends to this user's services.
  db.prepare("INSERT INTO worker_logs (level, message) VALUES ('info', ?)").run(
    `__TEST_NOTIFICATION_${ctx.userId}__`
  );

  return NextResponse.json({
    ok: true,
    message: `Test notification queued for ${configs.length} service(s). Check your device shortly.`,
    count: configs.length,
  });
}
