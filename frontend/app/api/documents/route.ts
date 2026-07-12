import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "@/lib/db";
import { getAccessContext, ownerScope } from "@/lib/access";
import { encryptSecret, decryptSecret } from "@/lib/secrets";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_TYPES = [
  "passport",
  "global_entry",
  "tsa_precheck",
  "known_traveler",
  "visa",
  "drivers_license",
  "loyalty",
  "other",
];

function decodeRow(row: Record<string, unknown>) {
  // Return the document number to the authorized owner/admin; store encrypted.
  let number = "";
  try {
    number = row.number_enc ? decryptSecret(String(row.number_enc)) : "";
  } catch {
    number = "";
  }
  const { number_enc, ...rest } = row;
  void number_enc;
  return { ...rest, number };
}

export function GET() {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  const scope = ownerScope(ctx, "d.owner_user_id");
  const rows = db
    .prepare(
      `SELECT d.*, u.username AS owner_username, u.display_name AS owner_display_name
       FROM documents d LEFT JOIN users u ON u.id = d.owner_user_id
       WHERE ${scope.clause}
       ORDER BY CASE WHEN d.expiration_date IS NULL THEN 1 ELSE 0 END, d.expiration_date ASC`
    )
    .all(...scope.params) as Record<string, unknown>[];
  return NextResponse.json({ documents: rows.map(decodeRow), isAdmin: ctx.isAdmin });
}

export async function POST(req: NextRequest) {
  const ctx = getAccessContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { doc_type, label, holder_name, number, expiration_date, notes, owner_user_id } =
    await req.json();

  const type = DOC_TYPES.includes(doc_type) ? doc_type : "other";
  if (!label && !holder_name) {
    return NextResponse.json({ error: "Give the document a label or holder name" }, { status: 400 });
  }
  if (expiration_date && !ISO_DATE.test(expiration_date)) {
    return NextResponse.json({ error: "Expiration must be a date (YYYY-MM-DD)" }, { status: 400 });
  }
  const owner = ctx.isAdmin && owner_user_id ? owner_user_id : ctx.userId;

  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO documents
     (id, owner_user_id, doc_type, label, holder_name, number_enc, expiration_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    owner,
    type,
    label || "",
    holder_name || "",
    number ? encryptSecret(String(number)) : "",
    expiration_date || null,
    notes || ""
  );
  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Record<string, unknown>;
  return NextResponse.json(decodeRow(row), { status: 201 });
}
