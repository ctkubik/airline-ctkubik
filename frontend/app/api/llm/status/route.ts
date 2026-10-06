import { NextResponse } from "next/server";
import { llmStatus } from "@/lib/llm";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await llmStatus());
}
