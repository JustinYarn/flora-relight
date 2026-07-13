/**
 * Retired blocking video-generation endpoint.
 *
 * Keeping an explicit 410 prevents older browser bundles from falling through
 * to an unguarded paid path. All new video generation is owned by the durable
 * RunExecution/BatchExecution coordinators, which bind spend approval, prompt,
 * source identity, and the exactly-once provider journal before dispatch.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error:
        "Direct video-generation requests are retired. Start or retry the durable run from Studio.",
    },
    { status: 410 }
  );
}
