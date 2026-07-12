/**
 * GET /api/storage/info — { driver: "fs" | "blob" }
 *
 * Lets the client pick its upload path: fs → multipart POST /api/ingest;
 * blob → client-direct upload via /api/ingest/token + /api/ingest/finalize
 * (deployed Vercel functions cap request bodies at 4.5MB). force-dynamic so
 * the driver is resolved from the runtime env, never baked in at build.
 */

import { NextResponse } from "next/server";
import { getStorage } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ driver: getStorage().name });
}
