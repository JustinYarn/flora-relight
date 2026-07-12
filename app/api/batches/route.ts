/**
 * /api/batches — dumb persistence for the batch list.
 *
 * PUT → body { batches: Batch[] } — whole-array atomic write (low volume;
 * the client store owns batch state in-session and pushes the full list).
 */

import { NextRequest, NextResponse } from "next/server";
import type { Batch } from "@/lib/types";
import { writeBatches } from "@/lib/server/runstore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const batches = (body as { batches?: unknown })?.batches;
  if (!Array.isArray(batches)) {
    return NextResponse.json(
      { error: "Expected body { batches: Batch[] }." },
      { status: 400 }
    );
  }
  for (const b of batches as Batch[]) {
    if (!b || typeof b.id !== "string" || typeof b.createdAt !== "number") {
      return NextResponse.json(
        { error: "Every batch needs a string id and numeric createdAt." },
        { status: 400 }
      );
    }
  }

  await writeBatches(batches as Batch[]);
  return NextResponse.json({ ok: true, count: (batches as Batch[]).length });
}
