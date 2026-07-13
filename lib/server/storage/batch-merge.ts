/**
 * Monotonic merge rules for durable batch checkpoints.
 *
 * Browser saves may arrive late or concurrently with server-side batch start.
 * Treating those saves as whole-document replacements can turn a running batch
 * back into an upload draft or erase another tab's completed upload. These
 * helpers make every storage driver apply the same forward-only merge.
 */

import type { Batch, BatchUploadItem } from "@/lib/types";

const BATCH_STATUS_RANK: Record<Batch["status"], number> = {
  uploading: 0,
  failed: 1,
  ready: 2,
  running: 3,
  done: 4,
};

// `failed` currently means upload preparation failed, not that an executing
// queue terminally failed. A later durable ingest receipt must therefore be
// able to recover failed -> ready. Keeping it below `running` also prevents a
// delayed upload failure snapshot from stopping a queue that already started.

// A failed upload may later be retried successfully. Keeping `ready` above
// `failed` lets that success win while preventing a delayed failure response
// from replacing a durable ready receipt. An intermediate retrying checkpoint
// remains displayed as failed until the retry reaches ready.
const UPLOAD_STATUS_RANK: Record<BatchUploadItem["status"], number> = {
  pending: 0,
  uploading: 1,
  failed: 2,
  ready: 3,
};

function batchTime(batch: Batch): number {
  return Number.isFinite(batch.updatedAt) ? (batch.updatedAt as number) : batch.createdAt;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mergeUploadItem(
  current: BatchUploadItem | undefined,
  incoming: BatchUploadItem
): BatchUploadItem {
  const incomingRank = UPLOAD_STATUS_RANK[incoming.status];
  if (incomingRank === undefined) {
    throw new Error("Invalid batch upload status");
  }
  if (!current) return { ...incoming };
  if (current.runId !== incoming.runId) {
    throw new Error("Cannot merge batch upload items with different run ids");
  }

  const currentRank = UPLOAD_STATUS_RANK[current.status];
  if (currentRank === undefined) throw new Error("Invalid batch upload status");

  const incomingWins =
    incomingRank > currentRank ||
    (incomingRank === currentRank && incoming.updatedAt > current.updatedAt);
  const winner = incomingWins ? incoming : current;
  const loser = incomingWins ? current : incoming;
  const merged: BatchUploadItem = {
    ...loser,
    ...winner,
    runId: current.runId,
    status: winner.status,
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
  };

  // JSON transport omits undefined properties. A successful, newer receipt
  // therefore needs an explicit way to clear an older failure message.
  if (winner.status === "ready" && winner.error === undefined) {
    merged.error = undefined;
  }
  return merged;
}

export function mergeBatchUploads(
  current: BatchUploadItem[] | undefined,
  incoming: BatchUploadItem[] | undefined
): BatchUploadItem[] | undefined {
  if (!current && !incoming) return undefined;

  const byRunId = new Map<string, BatchUploadItem>();
  const order: string[] = [];
  for (const item of [...(current ?? []), ...(incoming ?? [])]) {
    if (!byRunId.has(item.runId)) order.push(item.runId);
    byRunId.set(item.runId, mergeUploadItem(byRunId.get(item.runId), item));
  }
  return order.map((runId) => byRunId.get(runId) as BatchUploadItem);
}

/** Merge one incoming checkpoint into its current durable batch record. */
export function mergeBatch(current: Batch | null, incoming: Batch): Batch {
  const incomingRank = BATCH_STATUS_RANK[incoming.status];
  if (incomingRank === undefined) throw new Error("Invalid batch status");
  if (!current) {
    return {
      ...incoming,
      runIds: unique(incoming.runIds),
      uploads: mergeBatchUploads(undefined, incoming.uploads),
      updatedAt: batchTime(incoming),
    };
  }
  if (current.id !== incoming.id) {
    throw new Error("Cannot merge batches with different ids");
  }

  const currentRank = BATCH_STATUS_RANK[current.status];
  if (currentRank === undefined) throw new Error("Invalid batch status");

  const advances = incomingRank > currentRank;
  const regresses = incomingRank < currentRank;
  const incomingIsNewer = batchTime(incoming) > batchTime(current);
  const winner = advances || (!regresses && incomingIsNewer) ? incoming : current;
  const loser = winner === incoming ? current : incoming;

  let runIds: string[];
  let budgetUsd: number | undefined;
  if (advances) {
    // A server transition such as ready -> running intentionally selects the
    // runnable subset. Do not union stale failed uploads back into that list.
    runIds = unique(incoming.runIds);
    budgetUsd = incoming.budgetUsd;
  } else if (regresses) {
    runIds = unique(current.runIds);
    budgetUsd = current.budgetUsd;
  } else {
    // At the same phase, additions are safe and prevent concurrent snapshots
    // from dropping members. Narrowing is reserved for a status advance.
    runIds = unique([...current.runIds, ...incoming.runIds]);
    budgetUsd =
      incomingIsNewer && incoming.budgetUsd !== undefined
        ? incoming.budgetUsd
        : current.budgetUsd;
  }

  return {
    ...loser,
    ...winner,
    id: current.id,
    createdAt: current.createdAt,
    status: advances ? incoming.status : current.status,
    runIds,
    uploads: mergeBatchUploads(current.uploads, incoming.uploads),
    updatedAt: regresses
      ? batchTime(current)
      : Math.max(batchTime(current), batchTime(incoming)),
    budgetUsd,
  };
}

/** Merge supplied records without deleting durable batches omitted by a save. */
export function mergeBatchList(current: Batch[], incoming: Batch[]): Batch[] {
  const byId = new Map(current.map((batch) => [batch.id, batch]));
  for (const batch of incoming) {
    byId.set(batch.id, mergeBatch(byId.get(batch.id) ?? null, batch));
  }
  return [...byId.values()].sort(
    (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)
  );
}
