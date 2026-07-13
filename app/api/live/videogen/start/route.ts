/**
 * Retired client-start endpoint.
 *
 * Live first-cut creation is owned exclusively by the immutable
 * RunExecution/BatchExecution coordinators. Accepting a browser-supplied
 * prompt here would let a stale bundle race the durable execution for the
 * same paid provider-operation id, so this compatibility route is fail-closed.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error:
        "Direct video-generation starts are retired. Start or retry the durable run from Studio.",
    },
    { status: 410 }
  );
}
