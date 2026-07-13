"use client";

/**
 * App store. Holds every run plus the workflow definition; the engine
 * (lib/engine.ts) drives run state through setState with copied structures,
 * so the canvas and inspector live-update.
 */

import { create } from "zustand";
import type {
  Batch,
  BatchExecutionSummary,
  BatchUploadItem,
  HumanGrade,
  Run,
  RunExecution,
  VideoAsset,
  WorkflowDefinition,
} from "@/lib/types";
import { uid } from "@/lib/util";
import { estimateRun, formatUsd } from "@/lib/cost";
import { RELIGHT_WORKFLOW } from "@/lib/workflow-def";
import { runWorkflow } from "@/lib/engine";
import { buildQueuedRun } from "@/lib/run-factory";
import {
  isRecoverableBatchRun,
  isTerminalRun,
  summarizeBatchRecovery,
  type BatchRecoverySummary,
} from "@/lib/batch-recovery";

/**
 * Batch worker pool size: at most this many runWorkflow() executions in
 * flight per batch. Real Omni calls will be rate-limited and per-clip cost is
 * real, so the bounded queue IS the mass-automation story — not a mock
 * convenience. Queued runs sit at status "running" with every node idle
 * (which the batch board reads as "queued") until a slot frees up.
 */
const BATCH_CONCURRENCY = 2;

/**
 * One browser tab may own a batch queue at a time. This prevents a second
 * mock resume click (or React strict-mode re-entry) from dispatching the same
 * in-memory members twice. It is deliberately not treated as sufficient for
 * live recovery because it cannot coordinate a second tab or device.
 */
const activeBatchQueues = new Set<string>();

export function isBatchQueueActive(batchId: string): boolean {
  return activeBatchQueues.has(batchId);
}

export interface BatchResumeResult extends BatchRecoverySummary {
  resumed: number;
  alreadyActive: boolean;
  liveBlocked: boolean;
}

function hasBudgetSkip(run: Run): boolean {
  return run.log.some((entry) => entry.message.includes("batch budget reached"));
}

interface AppStore {
  /** Newest first. */
  runs: Run[];
  /** Newest first. */
  batches: Batch[];
  /** Server-owned batch progress, cached separately from writable Batch docs. */
  batchExecutions: Record<string, BatchExecutionSummary>;
  workflow: WorkflowDefinition;
  /**
   * "mock" until /api/live/health reports that the server-owned first-cut
   * capability is configured. Live mode also blocks every browser executor;
   * the server response must explicitly claim live run/batch ownership.
   */
  mode: "mock" | "live";
  /**
   * True once hydrate() has finished pulling persisted state (or confirmed
   * the persistence API is absent).
   */
  hydrated: boolean;
  setMode(mode: "mock" | "live"): void;
  /**
   * One-time boot sync (called by lib/persist.ts startPersistence):
   *   1. GET /api/live/health → flips mode to "live" when the server says
   *      keys exist. 404/network error → stay "mock".
   *   2. GET /api/runs → replaces runs/batches with the persisted ones
   *      (newest first; in-memory entries not on disk are kept).
   * Resolves true when the persistence API is reachable — lib/persist.ts
   * uses that to decide whether to start push-sync. Mock-only environments
   * (no /api routes) resolve false and behave exactly as before.
   */
  hydrate(): Promise<boolean>;
  /** Persists the run, then kicks off the async engine. */
  startRun(
    video: VideoAsset,
    opts?: { approveLiveSpend?: boolean }
  ): Promise<string>;
  /**
   * Mock-only convenience: creates one Run per video plus a Batch pointing at
   * them, then drains the runs through a browser worker queue. The
   * batch flips to "done" when every run settles at a terminal status
   * (awaiting-review / approved / needs-changes / failed). Returns batch id.
   * opts.budgetUsd caps the batch's total ESTIMATED spend: once the next
   * run's estimate would exceed it, remaining runs are failed as skipped.
   */
  startBatch(
    videos: VideoAsset[],
    name?: string,
    opts?: { budgetUsd?: number }
  ): string;
  /** Persist a multi-file selection before the first upload starts. */
  createBatchDraft(
    items: Array<{ runId: string; label: string }>,
    name?: string
  ): string;
  /** Persist one upload transition so ready files survive refresh. */
  updateBatchUpload(
    batchId: string,
    runId: string,
    patch: Partial<Pick<BatchUploadItem, "status" | "video" | "error">>
  ): void;
  /** Launch the successfully prepared members of a durable upload batch. */
  startBatchFromDraft(
    batchId: string,
    opts?: {
      budgetUsd?: number;
      approveLiveSpend?: boolean;
      /** Explicitly freeze/start only the ready members of an interrupted upload. */
      allowIncompleteUploads?: boolean;
    }
  ): Promise<string | null>;
  /**
   * Mock-only recovery for untouched, durably persisted queue skeletons.
   * Live server executions use startBatchFromDraft's idempotent dispatch
   * repair and never enter this browser queue.
   */
  resumeBatch(batchId: string): Promise<BatchResumeResult>;
  submitReview(runId: string, decision: "approved" | "needs-changes", notes: string): void;
  /**
   * Record the blind human grade for one run (the /grade flow). Plain
   * immutable update — the persistence subscriber pushes the changed run to
   * /api/runs like every other mutation, so the grade lands in run.json.
   */
  setHumanGrade(runId: string, grade: HumanGrade): void;
  /**
   * Permanently delete one run: optimistically drop it from the store, then
   * DELETE /api/runs?id=… (the server removes run.json and the whole media
   * folder). On failure the run is restored and the error rethrown — the
   * caller owns both the confirmation step and the failure message.
   */
  removeRun(runId: string): Promise<void>;
}

/** Append an info entry to one run's log (used by the batch worker queue). */
function appendRunLog(runId: string, message: string): void {
  useAppStore.setState((state) => ({
    runs: state.runs.map((r) =>
      r.id === runId
        ? {
            ...r,
            log: [...r.log, { at: Date.now(), level: "info" as const, message }],
          }
        : r
    ),
  }));
}

/**
 * Budget cap hit: settle a still-queued run as failed WITHOUT dispatching it.
 * projectedUsd is what the batch's estimated spend would have reached had
 * this run been dispatched — the number that broke the cap.
 */
function skipRunForBudget(
  runId: string,
  projectedUsd: number,
  capUsd: number
): void {
  useAppStore.setState((state) => ({
    runs: state.runs.map((r) =>
      r.id === runId
        ? {
            ...r,
            status: "failed" as const,
            log: [
              ...r.log,
              {
                at: Date.now(),
                level: "warn" as const,
                message: `skipped — batch budget reached (${formatUsd(projectedUsd)} est > ${formatUsd(capUsd)} cap)`,
              },
            ],
          }
        : r
    ),
  }));
}

/**
 * Drain one prepared batch through the current in-tab worker pool. Queue state
 * is now persisted before this function starts; a later server-owned worker
 * can replace this executor without changing the Batch/Run preparation shape.
 */
function runMockBatchQueue(
  batch: Batch,
  batchRuns: Run[],
  opts?: { reservedEstimateUsd?: number }
): boolean {
  const state = useAppStore.getState();
  if (state.mode === "live" || state.batchExecutions[batch.id]) {
    throw new Error(
      "Browser batch execution is mock-only; the durable server owns this batch."
    );
  }
  if (activeBatchQueues.has(batch.id)) return false;
  activeBatchQueues.add(batch.id);
  const budgetUsd = batch.budgetUsd;
  const concurrency =
    Number.isSafeInteger(batch.concurrency) && batch.concurrency > 0
      ? batch.concurrency
      : BATCH_CONCURRENCY;
  const estimateById = new Map(
    batchRuns.map((r) => [
      r.id,
      estimateRun(r.originalVideo.durationSec).totalUsd,
    ])
  );
  let dispatchedEstimateUsd = opts?.reservedEstimateUsd ?? 0;
  const selectedIds = new Set(batchRuns.map((run) => run.id));
  const pending = batch.runIds.filter((runId) => selectedIds.has(runId));
  const total = pending.length;
  let inFlight = 0;
  let settledCount = 0;

  const finishQueue = (): void => {
    if (settledCount < total) return;
    activeBatchQueues.delete(batch.id);
    const current = useAppStore.getState();
    const currentRuns = new Map(current.runs.map((run) => [run.id, run]));
    const allTerminal = batch.runIds.every((runId) => {
      const run = currentRuns.get(runId);
      return run ? isTerminalRun(run) : false;
    });
    if (!allTerminal) return;
    useAppStore.setState((state) => ({
      batches: state.batches.map((b) =>
        b.id === batch.id
          ? { ...b, status: "done" as const, updatedAt: Date.now() }
          : b
      ),
    }));
  };

  const pump = (): void => {
    while (inFlight < concurrency && pending.length > 0) {
      const nextEstimate = estimateById.get(pending[0]) ?? 0;
      if (
        budgetUsd !== undefined &&
        dispatchedEstimateUsd + nextEstimate > budgetUsd
      ) {
        while (pending.length > 0) {
          const skippedId = pending.shift() as string;
          skipRunForBudget(
            skippedId,
            dispatchedEstimateUsd + (estimateById.get(skippedId) ?? 0),
            budgetUsd
          );
          settledCount += 1;
        }
        break;
      }

      const runId = pending.shift() as string;
      dispatchedEstimateUsd += nextEstimate;
      inFlight += 1;
      appendRunLog(
        runId,
        `Picked up by a batch worker (${inFlight}/${concurrency} slots busy, ${pending.length} still queued)`
      );
      void runWorkflow(runId)
        .catch(() => undefined)
        .then(() => {
          inFlight -= 1;
          settledCount += 1;
          if (settledCount >= total) finishQueue();
          else pump();
        });
    }
    if (inFlight === 0) finishQueue();
  };

  pump();
  return true;
}

/**
 * Selector-friendly: what every run in this session WOULD cost against live
 * APIs (sum of pre-flight estimates). Mock mode spends $0 — this is the
 * "keep me in check" number in the top bar.
 */
export function sessionEstimatedSpend(runs: Run[]): number {
  return runs.reduce((sum, r) => sum + (r.cost?.estimatedUsd ?? 0), 0);
}

/** Module-level guard: hydrate() is idempotent even under strict-mode double calls. */
let hydratePromise: Promise<boolean> | null = null;

/** Tolerant reader for whatever shape /api/live/health lands with. */
function healthSaysLive(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as { live?: unknown; mode?: unknown };
  return d.live === true || d.mode === "live";
}

function needsSingleExecutionAdoption(run: Run): boolean {
  if (
    !run.spendApproval ||
    run.spendApproval.source !== "single" ||
    run.spendApproval.batchId !== undefined
  ) {
    return false;
  }
  const execution = run.serverExecution;
  if (!execution) return true;
  return (
    execution.source === "single" &&
    (execution.status === "queued" ||
      execution.status === "running" ||
      execution.status === "reconcile_required")
  );
}

/** Best-effort durable-outbox adoption; callers keep the saved Run on error. */
async function adoptSingleExecution(runId: string): Promise<RunExecution | null> {
  const response = await fetch("/api/runs/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { execution?: RunExecution };
  return payload.execution ?? null;
}

const scheduledSingleAdoptions = new Set<string>();

function mergeRecoveredExecution(runId: string, execution: RunExecution): void {
  useAppStore.setState((state) => ({
    runs: state.runs.map((item) =>
      item.id === runId ? { ...item, serverExecution: execution } : item
    ),
  }));
}

/** One delayed retry covers a reload that lands inside the enqueue lease. */
function scheduleSingleExecutionAdoption(runId: string): void {
  if (scheduledSingleAdoptions.has(runId)) return;
  scheduledSingleAdoptions.add(runId);
  window.setTimeout(() => {
    void adoptSingleExecution(runId)
      .then((execution) => {
        if (execution) mergeRecoveredExecution(runId, execution);
      })
      .catch(() => undefined)
      .finally(() => scheduledSingleAdoptions.delete(runId));
  }, 31_000);
}

export const useAppStore = create<AppStore>()((set, get) => ({
  runs: [],
  batches: [],
  batchExecutions: {},
  workflow: RELIGHT_WORKFLOW,
  mode: "mock",
  hydrated: false,

  setMode: (mode) => set({ mode }),

  hydrate: () => {
    if (typeof window === "undefined") return Promise.resolve(false); // client-only
    if (hydratePromise) return hydratePromise;
    const hydration = (async (): Promise<boolean> => {
      // 1. Live-mode health check. A missing route means a mock-only static
      // environment; a transient/network/server failure must be retried so a
      // live deployment never silently boots with persistence disabled.
      let mode: "mock" | "live" = "mock";
      const healthResponse = await fetch("/api/live/health", { cache: "no-store" });
      if (healthResponse.ok) {
        if (healthSaysLive(await healthResponse.json())) mode = "live";
      } else if (healthResponse.status !== 404) {
        throw new Error(`Live readiness failed (${healthResponse.status}).`);
      }

      // 2. Persisted runs/batches — compact runs arrive in bounded pages so a
      // 50+ clip corpus never becomes one oversized serverless response.
      const persistedRuns: Run[] = [];
      let persistedBatches: Batch[] = [];
      let cursor: string | null | undefined;
      // 20 pages is a generous interactive ceiling (up to 500 runs today) while
      // still bounding startup work if a malformed server repeats a cursor.
      for (let page = 0; page < 20; page++) {
        const url = cursor
          ? `/api/runs?limit=25&cursor=${encodeURIComponent(cursor)}`
          : "/api/runs?limit=25";
        const response = await fetch(url, { cache: "no-store" });
        if (response.status === 404 && page === 0) {
          // Static/mock-only hosts intentionally have no persistence API.
          set({ mode, hydrated: true });
          return false;
        }
        if (!response.ok) {
          throw new Error(`Run hydration failed (${response.status}).`);
        }
        const data = (await response.json()) as {
          runs?: unknown;
          batches?: unknown;
          batchExecutions?: unknown;
          nextCursor?: unknown;
        };
        if (!Array.isArray(data.runs)) {
          throw new Error("Run hydration returned an invalid payload.");
        }
        persistedRuns.push(...(data.runs as Run[]));
        if (page === 0) {
          persistedBatches = Array.isArray(data.batches)
            ? (data.batches as Batch[])
            : [];
          if (Array.isArray(data.batchExecutions)) {
            const executionMap: Record<string, BatchExecutionSummary> = {};
            for (const execution of data.batchExecutions as BatchExecutionSummary[]) {
              const current = executionMap[execution.batchId];
              if (!current || execution.revision >= current.revision) {
                executionMap[execution.batchId] = execution;
              }
            }
            set((state) => {
              const merged = { ...state.batchExecutions };
              for (const incoming of Object.values(executionMap)) {
                const current = merged[incoming.batchId];
                if (
                  !current ||
                  (current.executionId === incoming.executionId &&
                    incoming.revision >= current.revision)
                ) {
                  merged[incoming.batchId] = incoming;
                }
              }
              return { batchExecutions: merged };
            });
          }
        }
        const nextCursor =
          typeof data.nextCursor === "string" && data.nextCursor.length > 0
            ? data.nextCursor
            : null;
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      set((state) => {
        // Persisted state wins per id; anything created in-memory before
        // hydration finished (rare — a very fast first click) is kept.
        const runIds = new Set(persistedRuns.map((r) => r.id));
        const runs = [
          ...persistedRuns,
          ...state.runs.filter((r) => !runIds.has(r.id)),
        ].sort((a, b) => b.createdAt - a.createdAt);
        const batchIds = new Set(persistedBatches.map((b) => b.id));
        const batches = [
          ...persistedBatches,
          ...state.batches.filter((b) => !batchIds.has(b.id)),
        ].sort((a, b) => b.createdAt - a.createdAt);
        return { runs, batches, mode, hydrated: true };
      });

      // Adopt confirmed single runs that were interrupted between the durable
      // Run/RunExecution writes and Workflow submission. Also gives a later
      // session a non-paid settlement-repair path after an artifact commit.
      // Keep this bounded and best-effort: hydration truth is still useful if
      // one recovery request encounters a transient hosted-network failure.
      for (const run of persistedRuns.filter(needsSingleExecutionAdoption)) {
        try {
          const execution = await adoptSingleExecution(run.id);
          if (!execution) {
            scheduleSingleExecutionAdoption(run.id);
            continue;
          }
          mergeRecoveredExecution(run.id, execution);
          if (execution.status === "queued" && !execution.workflowRunId) {
            scheduleSingleExecutionAdoption(run.id);
          }
        } catch {
          // Detail polling plus one delayed attempt retry idempotent adoption.
          scheduleSingleExecutionAdoption(run.id);
        }
      }
      return true;
    })();
    hydratePromise = hydration.catch((error) => {
      // Retry callers must receive a fresh network attempt, not the same
      // permanently rejected promise.
      hydratePromise = null;
      throw error;
    });
    return hydratePromise;
  },

  startRun: async (video: VideoAsset, opts?: { approveLiveSpend?: boolean }) => {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video, approveLiveSpend: opts?.approveLiveSpend }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { run?: Run; serverOwned?: boolean; error?: string }
      | null;
    if (!response.ok || !payload?.run) {
      throw new Error(payload?.error ?? `Run preparation failed (${response.status}).`);
    }
    const run = payload.run;
    set((state) => ({
      runs: [run, ...state.runs.filter((item) => item.id !== run.id)],
    }));
    // Live first-cut execution is owned by the durable server Workflow started
    // by POST /api/runs. Keep the browser engine only for the zero-cost mock.
    if (payload.serverOwned !== true && get().mode === "mock") {
      void runWorkflow(run.id); // fire-and-forget; mock engine drives the store
    } else if (payload.serverOwned !== true) {
      throw new Error(
        "The live server did not claim this run, so browser execution was refused."
      );
    }
    return run.id;
  },

  createBatchDraft: (items, name = "Upload batch") => {
    const now = Date.now();
    const batch: Batch = {
      id: uid("batch"),
      name,
      createdAt: now,
      updatedAt: now,
      runIds: items.map((item) => item.runId),
      concurrency: BATCH_CONCURRENCY,
      status: items.length === 0 ? "failed" : "uploading",
      uploads: items.map((item) => ({
        ...item,
        status: "pending" as const,
        updatedAt: now,
      })),
    };
    set((state) => ({ batches: [batch, ...state.batches] }));
    return batch.id;
  },

  updateBatchUpload: (batchId, runId, patch) => {
    set((state) => ({
      batches: state.batches.map((batch) => {
        if (batch.id !== batchId || !batch.uploads) return batch;
        const uploads = batch.uploads.map((item) =>
          item.runId === runId
            ? { ...item, ...patch, updatedAt: Date.now() }
            : item
        );
        const allSettled = uploads.every(
          (item) => item.status === "ready" || item.status === "failed"
        );
        const status: Batch["status"] = allSettled
          ? uploads.some((item) => item.status === "ready")
            ? "ready"
            : "failed"
          : "uploading";
        return { ...batch, uploads, status, updatedAt: Date.now() };
      }),
    }));
  },

  startBatchFromDraft: async (batchId, opts) => {
    const existing = get().batches.find((batch) => batch.id === batchId);
    if (!existing || existing.status === "done") {
      return null;
    }
    const response = await fetch("/api/batches/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId,
        budgetUsd: opts?.budgetUsd,
        approveLiveSpend: opts?.approveLiveSpend,
        allowIncompleteUploads: opts?.allowIncompleteUploads,
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          batch?: Batch;
          runs?: Run[];
          resumed?: boolean;
          executionOwner?: "server" | "browser_mock";
          execution?: BatchExecutionSummary | null;
          error?: string;
        }
      | null;
    if (!response.ok || !payload?.batch || !Array.isArray(payload.runs)) {
      throw new Error(payload?.error ?? `Batch preparation failed (${response.status}).`);
    }
    const batch = payload.batch;
    const batchRuns = payload.runs;
    const runIds = batchRuns.map((run) => run.id);
    if (payload.executionOwner === "server" && !payload.execution) {
      throw new Error("The server did not return the durable batch execution it owns.");
    }
    if (payload.executionOwner !== "server" && payload.executionOwner !== "browser_mock") {
      throw new Error("The server did not identify who owns this batch execution.");
    }
    set((state) => {
      const currentExecution = state.batchExecutions[batch.id];
      const incomingExecution = payload.execution ?? undefined;
      if (
        currentExecution &&
        incomingExecution &&
        currentExecution.executionId !== incomingExecution.executionId
      ) {
        throw new Error("A different durable execution already owns this batch.");
      }
      const acceptedExecution =
        incomingExecution &&
        (!currentExecution || incomingExecution.revision >= currentExecution.revision)
          ? incomingExecution
          : currentExecution;
      return {
        runs: [
          ...batchRuns,
          ...state.runs.filter((run) => !runIds.includes(run.id)),
        ],
        batches: state.batches.map((item) =>
          item.id === batch.id ? batch : item
        ),
        batchExecutions: acceptedExecution
          ? { ...state.batchExecutions, [batch.id]: acceptedExecution }
          : state.batchExecutions,
      };
    });
    if (payload.executionOwner === "server") {
      // The durable batch Workflow owns dispatch and progress. Per-run cards
      // poll their server executions; the board separately refreshes this
      // batch checkpoint, so closing this tab cannot pause or duplicate work.
    } else if (payload.resumed === true) {
      // The server had already committed this start, most commonly because
      // the first response was lost. Apply the recovery classifier instead
      // of assuming every member is still untouched.
      await get().resumeBatch(batch.id);
    } else {
      runMockBatchQueue(batch, batchRuns);
    }
    return batch.id;
  },

  resumeBatch: async (batchId) => {
    const state = get();
    const batch = state.batches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "running") {
      return {
        queued: 0,
        protected: 0,
        terminal: 0,
        missing: batch?.runIds.length ?? 0,
        resumed: 0,
        alreadyActive: false,
        liveBlocked: false,
      };
    }

    const memberIds = new Set(batch.runIds);
    const memberRuns = state.runs.filter((run) => memberIds.has(run.id));
    const summary = summarizeBatchRecovery(batch, memberRuns);
    const queuedRuns = memberRuns.filter(isRecoverableBatchRun);
    if (state.mode === "live") {
      return {
        ...summary,
        resumed: 0,
        alreadyActive: false,
        liveBlocked: false,
      };
    }
    if (queuedRuns.length === 0) {
      return {
        ...summary,
        resumed: 0,
        alreadyActive: false,
        liveBlocked: false,
      };
    }

    const queuedIds = new Set(queuedRuns.map((run) => run.id));
    // A resumed queue keeps the original cap conservative: reserve every
    // already-started/terminal member's estimate, excluding only members the
    // old queue explicitly skipped because the cap had already been reached.
    const reservedEstimateUsd = memberRuns
      .filter((run) => !queuedIds.has(run.id) && !hasBudgetSkip(run))
      .reduce(
        (sum, run) =>
          sum +
          (run.cost?.estimatedUsd ??
            estimateRun(run.originalVideo.durationSec).totalUsd),
        0
      );
    const started = runMockBatchQueue(batch, queuedRuns, { reservedEstimateUsd });
    return {
      ...summary,
      resumed: started ? queuedRuns.length : 0,
      alreadyActive: !started,
      liveBlocked: false,
    };
  },

  startBatch: (videos: VideoAsset[], name = "Batch", opts) => {
    if (get().mode === "live") {
      throw new Error(
        "Direct browser batches are mock-only. Use the durable upload batch flow in live mode."
      );
    }
    const batchRuns = videos.map(buildQueuedRun);
    const now = Date.now();
    const batch: Batch = {
      id: uid("batch"),
      name,
      createdAt: now,
      updatedAt: now,
      runIds: batchRuns.map((r) => r.id),
      concurrency: BATCH_CONCURRENCY,
      status: batchRuns.length === 0 ? "done" : "running",
      budgetUsd: opts?.budgetUsd,
    };
    set((state) => ({
      runs: [...batchRuns, ...state.runs],
      batches: [batch, ...state.batches],
    }));
    runMockBatchQueue(batch, batchRuns);
    return batch.id;
  },

  removeRun: async (runId) => {
    const removed = get().runs.find((r) => r.id === runId);
    // Optimistic removal; restored below if the server says no. Order is
    // preserved by re-sorting on createdAt (runs are kept newest first).
    set((state) => ({ runs: state.runs.filter((r) => r.id !== runId) }));
    const restore = (): void => {
      if (!removed) return;
      set((state) =>
        state.runs.some((r) => r.id === runId)
          ? state
          : {
              runs: [removed, ...state.runs].sort(
                (a, b) => b.createdAt - a.createdAt
              ),
            }
      );
    };
    let res: Response;
    try {
      res = await fetch(`/api/runs?id=${encodeURIComponent(runId)}`, {
        method: "DELETE",
      });
    } catch (err) {
      restore();
      throw err;
    }
    if (!res.ok) {
      restore();
      throw new Error(`Delete failed (HTTP ${res.status}).`);
    }
  },

  setHumanGrade: (runId, grade) => {
    set((state) => ({
      runs: state.runs.map((r) =>
        r.id === runId ? { ...r, humanGrade: grade } : r
      ),
    }));
  },

  submitReview: (runId, decision, notes) => {
    set((state) => ({
      runs: state.runs.map((r) =>
        r.id === runId
          ? {
              ...r,
              status: decision,
              review: { decision, notes, reviewedAt: Date.now() },
              nodeStates: {
                ...r.nodeStates,
                review: {
                  nodeId: "review",
                  status: "succeeded",
                  detail: decision === "approved" ? "approved" : "changes requested",
                },
              },
              log: [
                ...r.log,
                {
                  at: Date.now(),
                  nodeId: "review",
                  level: "info" as const,
                  message:
                    decision === "approved"
                      ? "Reviewer approved the final video"
                      : "Reviewer requested changes",
                },
              ],
            }
          : r
      ),
    }));
  },
}));
