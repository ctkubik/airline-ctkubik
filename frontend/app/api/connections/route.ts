import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { SETTINGS, getSetting, publicSettings, saveSetting, settingOn, settingSource } from "@/lib/settings";

export const dynamic = "force-dynamic";

// GET -> every API Connections setting (keys masked) and whether this user may edit
export function GET() {
  return NextResponse.json({
    settings: publicSettings(),
    can_edit: getSessionUser()?.role === "admin",
    docker: process.env.BROWSER_MODE === "xvfb" || process.env.DATA_DIR === "/app/data" || !process.env.DATA_DIR,
  });
}

// POST { values: { NAME: "value" }, remove: ["NAME"] }
// A masked key ("••••1234") or a blank key field means "keep the saved key".
export async function POST(req: NextRequest) {
  const user = getSessionUser();
  if (user?.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can change API settings" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { values?: Record<string, unknown>; remove?: unknown };
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(body.values ?? {})) {
    if (!SETTINGS[name]) continue;
    const value = typeof raw === "boolean" ? String(raw) : typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
    if (SETTINGS[name].secret && (value.trim() === "" || value.startsWith("••••"))) continue;
    // Unchanged values that come from .env or the default stay there
    const current = SETTINGS[name].kind === "bool" ? String(settingOn(name)) : getSetting(name);
    if (settingSource(name) !== "app" && value.trim() === current) continue;
    const err = saveSetting(name, value, user.username);
    if (err) errors.push(err);
  }
  for (const name of Array.isArray(body.remove) ? body.remove : []) {
    if (typeof name === "string" && SETTINGS[name]) saveSetting(name, "", user.username);
  }
  if (errors.length) return NextResponse.json({ error: errors.join(". "), settings: publicSettings() }, { status: 400 });
  return NextResponse.json({ ok: true, settings: publicSettings() });
}
