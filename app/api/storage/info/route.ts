/**
 * GET /api/storage/info — secret-safe upload-path selection.
 *
 * Production returns 503 with driver:null when durable storage is incomplete
 * or Blob access is not explicitly private;
 * it never advertises the ephemeral fs upload path. Local development may use
 * fs exactly as before. See /api/readiness for the full ffmpeg-aware probe.
 */

import { NextResponse } from "next/server";
import { getStorageConfiguration } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const configuration = getStorageConfiguration();
  const body = {
    driver: configuration.driver,
    configured: configuration.configured,
    durable: configuration.durable,
    status: configuration.status,
    cloud: configuration.cloud,
  };

  return NextResponse.json(
    configuration.configured
      ? body
      : {
          ...body,
          error: "Durable storage is not configured for this runtime.",
          code: "STORAGE_NOT_CONFIGURED",
        },
    {
      status: configuration.configured ? 200 : 503,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    }
  );
}
