/** Paid provider diagnostics are deliberately unavailable in application code. */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}
