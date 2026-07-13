import type { Batch, Run } from "@/lib/types";

const TERMINAL_RUN_STATUSES: ReadonlySet<Run["status"]> = new Set([
  "awaiting-review",
  "approved",
  "needs-changes",
  "failed",
]);

export interface BatchRecoverySummary {
  queued: number;
  protected: number;
  terminal: number;
  missing: number;
}

/**
 * A run may be dispatched after recovery only while it is still the exact
 * persisted queue skeleton. Anything that crossed a prior dispatch boundary
 * stays protected because replaying the browser engine from the beginning
 * could repeat paid manifest, anchor, or judge calls.
 */
export function isRecoverableBatchRun(run: Run): boolean {
  return (
    run.status === "running" &&
    run.iterations.length === 0 &&
    run.manifest === undefined &&
    run.cost === undefined &&
    run.live !== true &&
    run.finalVideo === undefined &&
    run.fallback === undefined &&
    run.review === undefined &&
    (run.providerOperations?.length ?? 0) === 0 &&
    Object.values(run.nodeStates).every((node) => node.status === "idle") &&
    run.log.some((entry) =>
      entry.message.startsWith("queued — waiting for a worker slot")
    ) &&
    !run.log.some(
      (entry) =>
        entry.message.startsWith("Picked up by a batch worker") ||
        entry.message.includes("batch dispatch checkpoint")
    )
  );
}

export function summarizeBatchRecovery(
  batch: Batch,
  runs: Run[]
): BatchRecoverySummary {
  const byId = new Map(runs.map((run) => [run.id, run]));
  let queued = 0;
  let protectedCount = 0;
  let terminal = 0;
  let missing = 0;
  for (const runId of batch.runIds) {
    const run = byId.get(runId);
    if (!run) {
      missing += 1;
    } else if (TERMINAL_RUN_STATUSES.has(run.status)) {
      terminal += 1;
    } else if (isRecoverableBatchRun(run)) {
      queued += 1;
    } else {
      protectedCount += 1;
    }
  }
  return { queued, protected: protectedCount, terminal, missing };
}

export function isTerminalRun(run: Run): boolean {
  return TERMINAL_RUN_STATUSES.has(run.status);
}
