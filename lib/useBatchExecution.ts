"use client";

import { useEffect } from "react";
import {
  markServerBatchesObserved,
  markServerRunObserved,
} from "@/lib/persist";
import { useAppStore } from "@/lib/store";
import type { Batch, BatchExecutionSummary, Run } from "@/lib/types";

const POLL_MS = 4_000;
const MAX_BACKOFF_MS = 32_000;

interface BatchCheckpointResponse {
  batch?: Batch;
  execution?: BatchExecutionSummary | null;
}

function changedMemberIds(
  current: BatchExecutionSummary | undefined,
  incoming: BatchExecutionSummary
): string[] {
  if (!current) {
    return incoming.members
      .filter((member) => member.state !== "queued")
      .map((member) => member.runId);
  }
  const previous = new Map(
    current.members.map((member) => [member.runId, member.state])
  );
  return incoming.members
    .filter((member) => previous.get(member.runId) !== member.state)
    .map((member) => member.runId);
}

async function fetchRun(runId: string, signal: AbortSignal): Promise<Run> {
  const response = await fetch(`/api/runs?id=${encodeURIComponent(runId)}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Run refresh failed (${response.status}).`);
  }
  const payload = (await response.json()) as { run?: Run };
  if (!payload.run || payload.run.id !== runId) {
    throw new Error("Run refresh returned the wrong run.");
  }
  return payload.run;
}

function logKey(entry: Run["log"][number]): string {
  return `${entry.at}:${entry.level}:${entry.nodeId ?? ""}:${entry.message}`;
}

/**
 * A review click can land while the batch poll is awaiting the network. Keep
 * those browser-writable fields instead of replacing them with the older
 * server snapshot; the persistence subscriber will then flush the merged run.
 */
function preserveConcurrentLocalReview(incoming: Run, latest: Run): Run {
  const reviewed =
    (latest.status === "approved" || latest.status === "needs-changes") &&
    latest.review !== undefined &&
    (incoming.review === undefined ||
      latest.review.reviewedAt >= incoming.review.reviewedAt);
  const serverLogKeys = new Set(incoming.log.map(logKey));
  const mergedLog = [
    ...incoming.log,
    ...latest.log.filter((entry) => !serverLogKeys.has(logKey(entry))),
  ].sort((left, right) => left.at - right.at);
  const latestGrade = latest.humanGrade;
  const incomingGrade = incoming.humanGrade;
  const humanGrade =
    latestGrade &&
    (!incomingGrade || latestGrade.gradedAt >= incomingGrade.gradedAt)
      ? latestGrade
      : incomingGrade;

  return {
    ...incoming,
    ...(reviewed
      ? {
          status: latest.status,
          review: latest.review,
          nodeStates: {
            ...incoming.nodeStates,
            ...(latest.nodeStates.review
              ? { review: latest.nodeStates.review }
              : {}),
          },
        }
      : {}),
    ...(humanGrade ? { humanGrade } : {}),
    log: mergedLog,
  };
}

/**
 * One poller owns a whole live batch. It advances the separate execution
 * cache monotonically and refreshes only members whose durable state changed,
 * avoiding one four-second request loop per video.
 */
export function useBatchExecution(
  batchId: string | undefined
): BatchExecutionSummary | undefined {
  const execution = useAppStore((state) =>
    batchId ? state.batchExecutions[batchId] : undefined
  );
  const hydrated = useAppStore((state) => state.hydrated);
  const mode = useAppStore((state) => state.mode);
  const executionId = execution?.executionId;

  useEffect(() => {
    // A durable execution remains server-owned even if provider readiness is
    // changed after launch. Current mode controls new work, not recovery reads.
    if (!batchId || !hydrated || (mode !== "live" && !executionId)) return;

    const controller = new AbortController();
    let stopped = false;
    let inFlight = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number): void => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), delay);
    };

    const load = async (): Promise<void> => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(
          `/api/batches?id=${encodeURIComponent(batchId)}`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!response.ok) throw new Error(`Batch refresh failed (${response.status}).`);
        const payload = (await response.json()) as BatchCheckpointResponse;
        if (!payload.batch || payload.batch.id !== batchId) {
          throw new Error("Batch refresh returned the wrong batch.");
        }

        const stateBeforeRuns = useAppStore.getState();
        const current = stateBeforeRuns.batchExecutions[batchId];
        const incoming = payload.execution ?? undefined;
        if (
          current &&
          incoming &&
          current.executionId !== incoming.executionId
        ) {
          throw new Error("A different durable execution owns this batch.");
        }

        const accepted =
          incoming && (!current || incoming.revision >= current.revision)
            ? incoming
            : current;
        const idsToRefresh =
          incoming && accepted === incoming
            ? changedMemberIds(current, incoming)
            : [];
        // A terminal execution is accepted only after every changed member has
        // refreshed successfully. Otherwise the next backoff poll retries and
        // a transient final-run read cannot strand a stale card until reload.
        const refreshedRuns = await Promise.all(
          idsToRefresh.map((runId) => fetchRun(runId, controller.signal))
        );
        if (stopped) return;

        const latest = useAppStore.getState();
        const observedById = new Map(
          stateBeforeRuns.runs.map((run) => [run.id, run])
        );
        const byId = new Map(
          refreshedRuns.map((run) => {
            const latestRun = latest.runs.find((candidate) => candidate.id === run.id);
            const observedRun = observedById.get(run.id);
            if (!latestRun || latestRun === observedRun) {
              markServerRunObserved(run);
              return [run.id, run] as const;
            }
            // Do not mark this merged value as already persisted: it contains
            // a concurrent local review which still needs its normal PUT.
            return [run.id, preserveConcurrentLocalReview(run, latestRun)] as const;
          })
        );
        const nextRuns = latest.runs.map((run) => byId.get(run.id) ?? run);
        for (const refreshed of byId.values()) {
          if (!nextRuns.some((candidate) => candidate.id === refreshed.id)) {
            nextRuns.push(refreshed);
          }
        }
        const nextBatches = latest.batches.some((batch) => batch.id === batchId)
          ? latest.batches.map((batch) =>
              batch.id === batchId ? payload.batch as Batch : batch
            )
          : [payload.batch, ...latest.batches];
        markServerBatchesObserved(nextBatches);
        useAppStore.setState({
          runs: nextRuns,
          batches: nextBatches,
          batchExecutions: accepted
            ? { ...latest.batchExecutions, [batchId]: accepted }
            : latest.batchExecutions,
        });

        failures = 0;
        const terminal =
          accepted?.status === "done" || accepted?.status === "failed";
        if (!terminal) schedule(POLL_MS);
      } catch {
        if (!controller.signal.aborted) {
          failures += 1;
          schedule(Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** (failures - 1)));
        }
      } finally {
        inFlight = false;
      }
    };

    const refreshVisible = (): void => {
      if (document.visibilityState === "visible") schedule(0);
    };
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    schedule(0);

    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [batchId, executionId, hydrated, mode]);

  return execution;
}
