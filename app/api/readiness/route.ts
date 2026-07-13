/**
 * GET /api/readiness — secret-safe, no-provider-call production readiness.
 *
 * 200 means the current runtime has a permitted storage backend and a working
 * ffmpeg binary. 503 means uploads/processing must remain disabled. In a
 * hosted/production runtime, only actively verified private Blob + database
 * storage is permitted; local development may use the fs driver. The cloud
 * probe is provider-free and never touches user media.
 */

import { NextResponse } from "next/server";
import { getAppReadiness } from "@/lib/server/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const readiness = await getAppReadiness();
  return NextResponse.json(readiness, {
    status: readiness.ready ? 200 : 503,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}
