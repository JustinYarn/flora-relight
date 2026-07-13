/**
 * /api/batches — monotonic persistence for browser batch checkpoints.
 *
 * PUT → body { batches: Batch[] }. Every supplied record is merged
 * independently; delayed snapshots cannot delete omitted batches or regress
 * server-owned progress.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Batch } from "@/lib/types";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";
import { summarizeBatchExecution } from "@/lib/server/batch-execution-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestedId =
    req.nextUrl.searchParams.get("id") ??
    req.nextUrl.searchParams.get("batchId");
  if (!isValidRunId(requestedId)) {
    return NextResponse.json(
      { error: "A batch id is required." },
      { status: 400 }
    );
  }

  const storage = getStorage();
  const [batches, execution] = await Promise.all([
    storage.getBatches(),
    storage.getBatchExecution(requestedId),
  ]);
  const batch = batches.find((item) => item.id === requestedId);
  if (!batch) {
    return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  }
  return NextResponse.json(
    { batch, execution: execution ? summarizeBatchExecution(execution) : null },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } }
  );
}

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
  const persistedBatches = (batches as Batch[]).map((batch) => {
    // This is a server-owned read projection. A stale tab must never copy it
    // into the browser-writable Batch document.
    const clean = { ...batch } as Batch & { serverExecution?: unknown };
    delete clean.serverExecution;
    return clean;
  });
  for (const b of persistedBatches) {
    if (!b || typeof b.id !== "string" || typeof b.createdAt !== "number") {
      return NextResponse.json(
        { error: "Every batch needs a string id and numeric createdAt." },
        { status: 400 }
      );
    }
  }

  const storage = getStorage();
  const durableBatches = await storage.getBatches();
  const currentById = new Map(durableBatches.map((batch) => [batch.id, batch]));
  const protectedBatches = await Promise.all(
    persistedBatches.map(async (batch) => {
      const execution = await storage.getBatchExecution(batch.id);
      const current = currentById.get(batch.id);
      if (!execution || !current) return batch;
      // Once the server dispatcher exists, browser snapshots may still merge
      // harmless upload receipts/name text, but they cannot rewrite dispatch
      // status, membership, concurrency, or the winning budget.
      return {
        ...batch,
        status: current.status,
        runIds: current.runIds,
        concurrency: current.concurrency,
        budgetUsd: current.budgetUsd,
      };
    })
  );

  // `putBatches` remains the compatibility shape used by the browser, but its
  // driver contract is now per-record monotonic upsert rather than replacement.
  await storage.putBatches(protectedBatches);
  return NextResponse.json({ ok: true, count: protectedBatches.length });
}
