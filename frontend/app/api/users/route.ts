import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

const USER_COLUMNS = "id, username, display_name, role, is_active, created_at, updated_at";

export function GET() {
  const session = getSessionUser();
  if (session?.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  const users = getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC`)
    .all();
  return NextResponse.json(users);
}

export async function POST(req: NextRequest) {
  const session = getSessionUser();
  if (session?.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { username, password, display_name, role } = await req.json();
  if (!username || typeof username !== "string" || !/^[\w.@+-]{2,64}$/.test(username)) {
    return NextResponse.json({ error: "Valid username required (letters, numbers, . @ + - _)" }, { status: 400 });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) {
    return NextResponse.json({ error: "Username already exists" }, { status: 409 });
  }

  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)"
  ).run(id, username, bcrypt.hashSync(password, 10), display_name || "", role === "admin" ? "admin" : "member");

  const user = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id);
  return NextResponse.json(user, { status: 201 });
}
