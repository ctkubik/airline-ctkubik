import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { flight_id, original_price, original_currency, rebooked_savings } = body;

  if (!flight_id) {
    return NextResponse.json({ error: "flight_id required" }, { status: 400 });
  }

  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (original_price !== undefined) {
    fields.push("original_price = ?");
    values.push(original_price === null || original_price === "" ? null : Number(original_price));
  }
  if (original_currency !== undefined) {
    fields.push("original_currency = ?");
    values.push(original_currency || "USD");
  }

  // Savings tracker: the traveler rebooked to claim a fare drop (null = undo)
  if (rebooked_savings !== undefined) {
    const amount = rebooked_savings === null || rebooked_savings === "" ? null : Number(rebooked_savings);
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || amount > 10000)) {
      return NextResponse.json({ error: "Enter the amount you got back" }, { status: 400 });
    }
    fields.push("rebooked_savings = ?", "rebooked_at = ?");
    values.push(amount, amount === null ? null : new Date().toISOString());
  }

  if (fields.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  values.push(flight_id);
  db.prepare(`UPDATE flights SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const flight = db.prepare("SELECT * FROM flights WHERE id = ?").get(flight_id);
  return NextResponse.json(flight);
}
