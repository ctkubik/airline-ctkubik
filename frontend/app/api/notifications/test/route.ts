import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// Test every service. The worker sends the messages (that's how real alerts
// go out too), so a stopped worker is the first thing to rule out.
export async function POST() {
  const db = getDb();
  const configs = db.prepare("SELECT id FROM notification_configs WHERE is_active = 1").all();

  if (!configs || configs.length === 0) {
    return NextResponse.json({ error: "No notification services configured" }, { status: 400 });
  }

  const alive = db.prepare("SELECT updated_at FROM system_state WHERE key = 'worker_alive'").get() as
    | { updated_at: string }
    | undefined;
  const age = alive ? (Date.now() - new Date(alive.updated_at.replace(" ", "T") + "Z").getTime()) / 60000 : null;
  const workerProblem =
    age === null
      ? "The check-in worker isn't running, so no alerts can go out. On the Mac, run: ~/airline-ctkubik/macos/ctl.sh restart"
      : age > 5
        ? `The check-in worker stopped ${Math.round(age)} minutes ago, so alerts can't go out until it restarts.`
        : null;

  db.prepare("INSERT INTO worker_logs (level, message) VALUES ('info', '__TEST_NOTIFICATION__')").run();

  const count = configs.length;
  return NextResponse.json({
    ok: true,
    message: `Test queued for ${count} service(s). Results show next to each service in a few seconds.`,
    worker_problem: workerProblem,
    queued_at: new Date().toISOString(),
    count,
  });
}
