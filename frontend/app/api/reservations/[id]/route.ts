import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// PATCH { owner_account_id }: whose trip a manual reservation is (alerts)
// PATCH { action: "retry" }: look the flights up again within a minute
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const db = getDb();
  if (body.action === "retry") {
    db.prepare(
      "UPDATE reservations SET next_lookup_at = NULL, lookup_status = 'pending', " +
        "lookup_message = 'Looking up the flights within a minute' WHERE id = ?"
    ).run(params.id);
    return NextResponse.json({ ok: true });
  }
  const { owner_account_id } = body;
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
