/**
 * /api/runs — dumb persistence for run state.
 *
 * GET    → { runs: Run[] (full run.json, newest first), batches: Batch[] }
 * PUT    → body { run: Run } — upsert one run's JSON (client store is the
 *          in-session source of truth and pushes here after mutations).
 * DELETE → ?id=<runId> — permanently removes the run and its entire media
 *          folder (source, generated videos, anchors, exports). Irreversible;
 *          the UI owns the confirmation step.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Run } from "@/lib/types";
import {
  deleteRun,
  isValidRunId,
  listRuns,
  readBatches,
  writeRun,
} from "@/lib/server/runstore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [runs, batches] = await Promise.all([listRuns(), readBatches()]);
  return NextResponse.json(
    { runs, batches },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const run = (body as { run?: unknown })?.run;
  if (!run || typeof run !== "object") {
    return NextResponse.json({ error: "Expected body { run }." }, { status: 400 });
  }
  const candidate = run as Run;
  if (!isValidRunId(candidate.id)) {
    return NextResponse.json(
      { error: "run.id must match [a-z0-9_-] (1-64 chars)." },
      { status: 400 }
    );
  }
  if (typeof candidate.createdAt !== "number") {
    return NextResponse.json(
      { error: "run.createdAt must be a number." },
      { status: 400 }
    );
  }

  await writeRun(candidate);
  return NextResponse.json({ ok: true, id: candidate.id });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!isValidRunId(id)) {
    return NextResponse.json(
      { error: "id must match [a-z0-9_-] (1-64 chars)." },
      { status: 400 }
    );
  }
  const existed = await deleteRun(id);
  return NextResponse.json({ ok: true, id, existed });
}
