import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

const USER_COLUMNS = "id, username, display_name, role, is_active, created_at, updated_at";

function countOtherActiveAdmins(db: ReturnType<typeof getDb>, excludeId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?")
      .get(excludeId) as { c: number }
  ).c;
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const target = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(params.id) as
    | { id: string; username: string; role: string }
    | undefined;
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const isAdmin = session.role === "admin";
  const isSelf = session.username === target.username;
  if (!isAdmin && !isSelf) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await req.json();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.password !== undefined) {
    if (typeof body.password !== "string" || body.password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }
    fields.push("password_hash = ?");
    values.push(bcrypt.hashSync(body.password, 10));
  }
  if (body.display_name !== undefined && isAdmin) {
    fields.push("display_name = ?");
    values.push(String(body.display_name));
  }
  if (body.role !== undefined && isAdmin) {
    const newRole = body.role === "admin" ? "admin" : "member";
    if (target.role === "admin" && newRole !== "admin" && countOtherActiveAdmins(db, target.id) === 0) {
      return NextResponse.json({ error: "Cannot demote the last active admin" }, { status: 400 });
    }
    fields.push("role = ?");
    values.push(newRole);
  }
  if (body.is_active !== undefined && isAdmin) {
    const active = body.is_active ? 1 : 0;
    if (target.role === "admin" && active === 0 && countOtherActiveAdmins(db, target.id) === 0) {
      return NextResponse.json({ error: "Cannot deactivate the last active admin" }, { status: 400 });
    }
    fields.push("is_active = ?");
    values.push(active);
  }

  if (fields.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  fields.push("updated_at = datetime('now')");
  values.push(params.id);
  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const user = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(params.id);
  return NextResponse.json(user);
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionUser();
  if (session?.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const db = getDb();
  const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(params.id) as
    | { id: string; role: string }
    | undefined;
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (target.role === "admin" && countOtherActiveAdmins(db, target.id) === 0) {
    return NextResponse.json({ error: "Cannot delete the last active admin" }, { status: 400 });
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
