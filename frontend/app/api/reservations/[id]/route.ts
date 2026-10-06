import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Set whose trip a manually added reservation is (for routing alerts)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { owner_account_id } = await req.json();
  const db = getDb();
  db.prepare("UPDATE reservations SET owner_account_id = ? WHERE id = ?").run(
    typeof owner_account_id === "string" && owner_account_id ? owner_account_id : null,
    params.id
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = getDb();
  db.prepare("DELETE FROM reservations WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
