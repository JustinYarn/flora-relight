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
  WorkflowMode,
  WorkflowDefinition,
} from "@/lib/types";
import { uid } from "@/lib/util";
import { estimateRun, formatUsd } from "@/lib/cost";
import {
  DEFAULT_RELIGHT_INTENSITY,
  normalizeRelightIntensity,
} from "@/lib/relight-intensity";
import { workflowForMode } from "@/lib/workflow-def";
import { runWorkflow } from "@/lib/engine";
import { buildQueuedRun } from "@/lib/run-factory";
import {
  approveLampBackgroundCleanupPlan,
  hashLampBackgroundCleanupPlan,
  lampBackgroundPlanRequiresGeneration,
  type LampBackgroundCleanupPlan,
} from "@/lib/lamp-background";
import { lampBackgroundNoOpPromptForRun } from "@/lib/lamp-background-read";
import {
  applyLampBeautifyIntensityOverride,
  approveLampBeautifyPlan,
  hashLampBeautifyPlan,
  lampBeautifyPlanRequiresGeneration,
  type LampBeautifyIntensity,
  type LampBeautifyPlan,
} from "@/lib/lamp-beautify";
import { lampBeautifyNoOpPromptForRun } from "@/lib/lamp-beautify-read";
import {
  applyLampIrisIntensityOverride,
  approveLampIrisPlan,
  hashLampIrisPlan,
  lampIrisPlanRequiresGeneration,
  type LampIrisIntensity,
  type LampIrisPlan,
} from "@/lib/lamp-iris";
import { lampIrisNoOpPromptForRun } from "@/lib/lamp-iris-read";
import {
  isRecoverableBatchRun,
  isTerminalRun,
  summarizeBatchRecovery,
  type BatchRecoverySummary,
} from "@/lib/batch-recovery";
import {
  DEFAULT_WORKFLOW_MODE,
  parseSelectableWorkflowMode,
  type SelectableWorkflowMode,
} from "@/lib/workflow-mode";
import { needsSingleExecutionAdoption } from "@/lib/single-execution-adoption";

const WORKFLOW_MODE_PREFERENCE_KEY = "flora-relight:workflow-mode";

function readWorkflowModePreference(): SelectableWorkflowMode | null {
  try {
    return parseSelectableWorkflowMode(
      window.localStorage.getItem(WORKFLOW_MODE_PREFERENCE_KEY)
    );
  } catch {
    return null;
  }
}

function writeWorkflowModePreference(mode: SelectableWorkflowMode): void {
  try {
    window.localStorage.setItem(WORKFLOW_MODE_PREFERENCE_KEY, mode);
  } catch {
    // Private browsing or a locked-down browser may disable local storage.
    // The in-memory selection still works for the current tab.
  }
}

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
  /** Product workflow for new work. Flora is retained only for old runs. */
  workflowMode: SelectableWorkflowMode;
  /**
   * True once hydrate() has finished pulling persisted state (or confirmed
   * the persistence API is absent).
   */
  hydrated: boolean;
  setMode(mode: "mock" | "live"): void;
  /** Selects the method for the next run and remembers it in this browser. */
  setWorkflowMode(mode: SelectableWorkflowMode): void;
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
    opts?: {
      approveLiveSpend?: boolean;
      approvePlanSpend?: boolean;
      workflowMode?: WorkflowMode;
      relightIntensity?: number;
      prepareOnly?: boolean;
    }
  ): Promise<string>;
  /**
   * Approve the source-specific Lamp Background plan. Cleanup plans launch
   * the fixed two-pass flow; exceptional no-op plans deliver the exact source
   * without authorizing generation.
   */
  approveBeautifyPlan(
    runId: string,
    opts?: {
      approveLiveSpend?: boolean;
      intensityOverride?: LampBeautifyIntensity;
    }
  ): Promise<void>;
  approveIrisPlan(
    runId: string,
    opts?: {
      approveLiveSpend?: boolean;
      intensityOverride?: LampIrisIntensity;
    }
  ): Promise<void>;
  approveBackgroundPlan(
    runId: string,
    opts?: { approveLiveSpend?: boolean }
  ): Promise<void>;
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
    opts?: {
      budgetUsd?: number;
      workflowMode?: WorkflowMode;
      relightIntensity?: number;
    }
  ): string;
  /** Persist a multi-file selection before the first upload starts. */
  createBatchDraft(
    items: Array<{ runId: string; label: string }>,
    name?: string,
    workflowMode?: WorkflowMode,
    relightIntensity?: number
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
      workflowMode?: WorkflowMode;
      relightIntensity?: number;
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
   * Record the human grade for one run (the /grade flow). Plain
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
  removeRun(runId: string, options?: { force?: boolean }): Promise<void>;
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

/** Provider-free exceptional no-op settlement for the beautify mock. */
function materializeMockBeautifyNoOp(
  run: Run,
  approvedPlan: LampBeautifyPlan
): Run {
  const finalVideo: VideoAsset = {
    ...run.originalVideo,
    id: `lamp-beautify-no-op-${run.id}`,
    kind: "final",
    label: "Lamp Beautify demo — approved unchanged source",
  };
  const nodeStates = { ...run.nodeStates };
  for (const nodeId of ["initial", "critique", "final"] as const) {
    nodeStates[nodeId] = {
      nodeId,
      status: "skipped",
      detail: "approved exceptional no-op — no generation",
    };
  }
  nodeStates.plan = {
    nodeId: "plan",
    status: "succeeded",
    detail: "exceptional no-op approved",
  };
  nodeStates.review = {
    nodeId: "review",
    status: "queued",
    detail: "exact source ready for human grade",
  };
  return {
    ...run,
    workflowId: "lamp-beautify-v1",
    workflowMode: "beautify",
    beautifyPlan: approvedPlan,
    iterations: [
      {
        index: 2,
        megaPrompt: lampBeautifyNoOpPromptForRun(approvedPlan),
        generatedVideo: finalVideo,
        beforeFrames: [],
        afterFrames: [],
        evalResults: [],
        status: "ungraded",
      },
    ],
    finalVideo,
    status: "awaiting-review",
    nodeStates,
    log: [
      ...run.log,
      {
        at: Date.now(),
        nodeId: "review",
        level: "info" as const,
        message:
          "Lamp Beautify plan approved as an exceptional no-op. The exact source is ready for human grading; no generation was dispatched.",
      },
    ],
  };
}

/** Provider-free exceptional no-op settlement for the iris mock. */
function materializeMockIrisNoOp(
  run: Run,
  approvedPlan: LampIrisPlan
): Run {
  const finalVideo: VideoAsset = {
    ...run.originalVideo,
    id: `lamp-iris-no-op-${run.id}`,
    kind: "final",
    label: "Lamp Iris demo — approved unchanged source",
  };
  const nodeStates = { ...run.nodeStates };
  for (const nodeId of ["initial", "critique", "final"] as const) {
    nodeStates[nodeId] = {
      nodeId,
      status: "skipped",
      detail: "approved exceptional no-op — no generation",
    };
  }
  nodeStates.plan = {
    nodeId: "plan",
    status: "succeeded",
    detail: "exceptional no-op approved",
  };
  nodeStates.review = {
    nodeId: "review",
    status: "queued",
    detail: "exact source ready for human grade",
  };
  return {
    ...run,
    workflowId: "lamp-iris-v1",
    workflowMode: "iris",
    irisPlan: approvedPlan,
    iterations: [
      {
        index: 2,
        megaPrompt: lampIrisNoOpPromptForRun(approvedPlan),
        generatedVideo: finalVideo,
        beforeFrames: [],
        afterFrames: [],
        evalResults: [],
        status: "ungraded",
      },
    ],
    finalVideo,
    status: "awaiting-review",
    nodeStates,
    log: [
      ...run.log,
      {
        at: Date.now(),
        nodeId: "review",
        level: "info" as const,
        message:
          "Lamp Iris plan approved as an exceptional no-op. The exact source is ready for human grading; no generation was dispatched.",
      },
    ],
  };
}

/** Provider-free exceptional no-op settlement for the mock workflow. */
function materializeMockBackgroundNoOp(
  run: Run,
  approvedPlan: LampBackgroundCleanupPlan
): Run {
  const finalVideo: VideoAsset = {
    ...run.originalVideo,
    id: `lamp-background-no-op-${run.id}`,
    kind: "final",
    label: "Lamp Background demo — approved unchanged source",
  };
  const nodeStates = { ...run.nodeStates };
  for (const nodeId of ["initial", "critique", "final"] as const) {
    nodeStates[nodeId] = {
      nodeId,
      status: "skipped",
      detail: "approved exceptional no-op — no generation",
    };
  }
  nodeStates.plan = {
    nodeId: "plan",
    status: "succeeded",
    detail: "exceptional no-op approved",
  };
  nodeStates.review = {
    nodeId: "review",
    status: "queued",
    detail: "exact source ready for human grade",
  };
  return {
    ...run,
    workflowId: "lamp-background-v1",
    workflowMode: "background",
    backgroundCleanupPlan: approvedPlan,
    iterations: [
      {
        index: 2,
        megaPrompt: lampBackgroundNoOpPromptForRun(approvedPlan),
        generatedVideo: finalVideo,
        beforeFrames: [],
        afterFrames: [],
        evalResults: [],
        status: "ungraded",
      },
    ],
    finalVideo,
    status: "awaiting-review",
    nodeStates,
    log: [
      ...run.log,
      {
        at: Date.now(),
        nodeId: "review",
        level: "info",
        message:
          "Lamp Background plan approved as an exceptional no-op. The exact source is ready for human grading; no generation or AI evaluation ran.",
      },
    ],
  };
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
  workflow: workflowForMode(DEFAULT_WORKFLOW_MODE),
  mode: "mock",
  workflowMode: DEFAULT_WORKFLOW_MODE,
  hydrated: false,

  setMode: (mode) => set({ mode }),

  setWorkflowMode: (workflowMode) => {
    writeWorkflowModePreference(workflowMode);
    set({
      workflowMode,
      workflow: workflowForMode(workflowMode),
    });
  },

  hydrate: () => {
    if (typeof window === "undefined") return Promise.resolve(false); // client-only
    if (hydratePromise) return hydratePromise;
    const hydration = (async (): Promise<boolean> => {
      // Restore only selectable methods. A stale saved "flora" can never
      // resurrect the retired one-pass flow for new work.
      const savedWorkflowMode = readWorkflowModePreference();
      if (savedWorkflowMode) {
        set({
          workflowMode: savedWorkflowMode,
          workflow: workflowForMode(savedWorkflowMode),
        });
      }
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

  startRun: async (
    video: VideoAsset,
    opts?: {
      approveLiveSpend?: boolean;
      approvePlanSpend?: boolean;
      workflowMode?: WorkflowMode;
      relightIntensity?: number;
      prepareOnly?: boolean;
    }
  ) => {
    const workflowMode = opts?.workflowMode ?? get().workflowMode;
    const mock = get().mode === "mock";
    const savedRun = video.runId
      ? get().runs.find((run) => run.id === video.runId)
      : undefined;
    const relightIntensity = normalizeRelightIntensity(
      opts?.relightIntensity ??
        savedRun?.relightIntensity ??
        DEFAULT_RELIGHT_INTENSITY
    );
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video,
        approveLiveSpend: opts?.approveLiveSpend,
        approvePlanSpend: opts?.approvePlanSpend,
        workflowMode,
        mock,
        relightIntensity,
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          run?: Run;
          serverOwned?: boolean;
          planReviewRequired?: boolean;
          error?: string;
        }
      | null;
    if (!response.ok || !payload?.run) {
      if (payload?.run) {
        set((state) => ({
          runs: [
            payload.run!,
            ...state.runs.filter((item) => item.id !== payload.run!.id),
          ],
        }));
      }
      throw new Error(payload?.error ?? `Run preparation failed (${response.status}).`);
    }
    const run = payload.run;
    set((state) => ({
      runs: [run, ...state.runs.filter((item) => item.id !== run.id)],
    }));
    // Plan preparation deliberately stops at a visible draft. The explicit
    // approval actions below own either generation admission or the rare
    // exact-source no-op settlement. Background retains its historical
    // always-stop behavior, while the response flag safely covers Beautify
    // and Iris drafts without changing approved-plan resume semantics.
    if (
      workflowMode === "background" ||
      payload.planReviewRequired === true ||
      opts?.prepareOnly === true
    ) {
      return run.id;
    }
    // Live first-cut execution is owned by the durable server Workflow started
    // by POST /api/runs. Keep the browser engine only for the zero-cost mock.
    if (payload.serverOwned !== true && mock) {
      void runWorkflow(run.id); // fire-and-forget; mock engine drives the store
    } else if (payload.serverOwned !== true) {
      throw new Error(
        "The live server did not claim this run, so browser execution was refused."
      );
    }
    return run.id;
  },

  approveBeautifyPlan: async (runId, opts) => {
    const run = get().runs.find((item) => item.id === runId);
    if (!run || run.workflowMode !== "beautify") {
      throw new Error("Lamp Beautify run not found.");
    }
    const plan = run.beautifyPlan;
    if (!plan) {
      throw new Error("This run does not have an enhancement plan to approve.");
    }
    const resumingPausedLiveTouchUp =
      get().mode === "live" &&
      plan.approval.status === "approved" &&
      (run.serverExecution?.status === "user_action_required" ||
        run.serverExecution === undefined);
    if (plan.approval.status === "approved" && !resumingPausedLiveTouchUp) {
      return;
    }

    const override =
      opts?.intensityOverride !== undefined && plan.decision === "enhance"
        ? opts.intensityOverride
        : undefined;
    if (get().mode === "live") {
      const hashedPlan =
        override !== undefined
          ? applyLampBeautifyIntensityOverride(plan, override)
          : plan;
      const planHash = await hashLampBeautifyPlan(hashedPlan);
      const response = await fetch("/api/beautify-plan/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          planHash,
          approveLiveSpend: opts?.approveLiveSpend === true,
          ...(override !== undefined
            ? { intensityOverride: override }
            : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { run?: Run; serverOwned?: boolean; error?: string }
        | null;
      if (!response.ok || !payload?.run) {
        throw new Error(
          payload?.error ??
            `Enhancement-plan approval failed (${response.status}).`
        );
      }
      if (payload.serverOwned !== true) {
        throw new Error(
          "The live server did not claim the approved enhancement, so browser execution was refused."
        );
      }
      set((state) => ({
        runs: state.runs.map((item) =>
          item.id === runId ? payload.run! : item
        ),
      }));
      return;
    }

    const approvedPlan = approveLampBeautifyPlan(
      override !== undefined
        ? applyLampBeautifyIntensityOverride(plan, override)
        : plan,
      Date.now()
    );
    if (!lampBeautifyPlanRequiresGeneration(approvedPlan)) {
      set((state) => ({
        runs: state.runs.map((item) =>
          item.id === runId
            ? materializeMockBeautifyNoOp(item, approvedPlan)
            : item
        ),
      }));
      return;
    }
    set((state) => ({
      runs: state.runs.map((item) =>
        item.id === runId
          ? {
              ...item,
              beautifyPlan: approvedPlan,
              nodeStates: {
                ...item.nodeStates,
                plan: {
                  nodeId: "plan",
                  status: "succeeded",
                  detail: `${approvedPlan.enhance.length} enhancement${
                    approvedPlan.enhance.length === 1 ? "" : "s"
                  } approved`,
                },
              },
              log: [
                ...item.log,
                {
                  at: Date.now(),
                  nodeId: "plan",
                  level: "info" as const,
                  message:
                    "Enhancement plan approved. Starting the fixed two-pass Lamp Beautify demo.",
                },
              ],
            }
          : item
      ),
    }));
    void runWorkflow(runId);
  },

  approveIrisPlan: async (runId, opts) => {
    const run = get().runs.find((item) => item.id === runId);
    if (!run || run.workflowMode !== "iris") {
      throw new Error("Lamp Iris run not found.");
    }
    const plan = run.irisPlan;
    if (!plan) {
      throw new Error("This run does not have a gaze plan to approve.");
    }
    const resumingPausedLiveCorrection =
      get().mode === "live" &&
      plan.approval.status === "approved" &&
      (run.serverExecution?.status === "user_action_required" ||
        run.serverExecution === undefined);
    if (plan.approval.status === "approved" && !resumingPausedLiveCorrection) {
      return;
    }

    const override =
      opts?.intensityOverride !== undefined && plan.decision === "correct"
        ? opts.intensityOverride
        : undefined;
    if (get().mode === "live") {
      const hashedPlan =
        override !== undefined
          ? applyLampIrisIntensityOverride(plan, override)
          : plan;
      const planHash = await hashLampIrisPlan(hashedPlan);
      const response = await fetch("/api/iris-plan/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          planHash,
          approveLiveSpend: opts?.approveLiveSpend === true,
          ...(override !== undefined
            ? { intensityOverride: override }
            : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { run?: Run; serverOwned?: boolean; error?: string }
        | null;
      if (!response.ok || !payload?.run) {
        throw new Error(
          payload?.error ??
            `Gaze-plan approval failed (${response.status}).`
        );
      }
      if (payload.serverOwned !== true) {
        throw new Error(
          "The live server did not claim the approved correction, so browser execution was refused."
        );
      }
      set((state) => ({
        runs: state.runs.map((item) =>
          item.id === runId ? payload.run! : item
        ),
      }));
      return;
    }

    const approvedPlan = approveLampIrisPlan(
      override !== undefined
        ? applyLampIrisIntensityOverride(plan, override)
        : plan,
      Date.now()
    );
    if (!lampIrisPlanRequiresGeneration(approvedPlan)) {
      set((state) => ({
        runs: state.runs.map((item) =>
          item.id === runId
            ? materializeMockIrisNoOp(item, approvedPlan)
            : item
        ),
      }));
      return;
    }
    set((state) => ({
      runs: state.runs.map((item) =>
        item.id === runId
          ? {
              ...item,
              irisPlan: approvedPlan,
              nodeStates: {
                ...item.nodeStates,
                plan: {
                  nodeId: "plan",
                  status: "succeeded",
                  detail: `${approvedPlan.correct.length} gaze correction${
                    approvedPlan.correct.length === 1 ? "" : "s"
                  } approved`,
                },
              },
              log: [
                ...item.log,
                {
                  at: Date.now(),
                  nodeId: "plan",
                  level: "info" as const,
                  message:
                    "Gaze plan approved. Starting the fixed two-pass Lamp Iris demo.",
                },
              ],
            }
          : item
      ),
    }));
    void runWorkflow(runId);
  },

  approveBackgroundPlan: async (runId, opts) => {
    const run = get().runs.find((item) => item.id === runId);
    if (!run || run.workflowMode !== "background") {
      throw new Error("Lamp Background run not found.");
    }
    const plan = run.backgroundCleanupPlan;
    if (!plan) {
      throw new Error("This run does not have a cleanup plan to approve.");
    }
    const resumingPausedLiveCleanup =
      get().mode === "live" &&
      plan.approval.status === "approved" &&
      (run.serverExecution?.status === "user_action_required" ||
        run.serverExecution === undefined);
    if (
      plan.approval.status === "approved" &&
      !resumingPausedLiveCleanup
    ) {
      return;
    }

    if (get().mode === "live") {
      const planHash = await hashLampBackgroundCleanupPlan(plan);
      const response = await fetch("/api/background-plan/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          planHash,
          approveLiveSpend: opts?.approveLiveSpend === true,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { run?: Run; serverOwned?: boolean; error?: string }
        | null;
      if (!response.ok || !payload?.run) {
        throw new Error(
          payload?.error ?? `Cleanup-plan approval failed (${response.status}).`
        );
      }
      if (payload.serverOwned !== true) {
        throw new Error(
          "The live server did not claim the approved cleanup, so browser execution was refused."
        );
      }
      set((state) => ({
        runs: state.runs.map((item) =>
          item.id === runId ? payload.run! : item
        ),
      }));
      return;
    }

    const approvedPlan = approveLampBackgroundCleanupPlan(plan, Date.now());
    if (!lampBackgroundPlanRequiresGeneration(approvedPlan)) {
      set((state) => ({
        runs: state.runs.map((item) =>
          item.id === runId
            ? materializeMockBackgroundNoOp(item, approvedPlan)
            : item
        ),
      }));
      return;
    }
    set((state) => ({
      runs: state.runs.map((item) =>
        item.id === runId
          ? {
              ...item,
              backgroundCleanupPlan: approvedPlan,
              nodeStates: {
                ...item.nodeStates,
                plan: {
                  nodeId: "plan",
                  status: "succeeded",
                  detail: `${approvedPlan.remove.length} removal target${
                    approvedPlan.remove.length === 1 ? "" : "s"
                  } approved`,
                },
              },
              log: [
                ...item.log,
                {
                  at: Date.now(),
                  nodeId: "plan",
                  level: "info" as const,
                  message:
                    "Cleanup plan approved. Starting the fixed two-pass Lamp Background demo.",
                },
              ],
            }
          : item
      ),
    }));
    void runWorkflow(runId);
  },

  createBatchDraft: (
    items,
    name = "Upload batch",
    workflowMode = get().workflowMode,
    relightIntensity = DEFAULT_RELIGHT_INTENSITY
  ) => {
    const now = Date.now();
    const batch: Batch = {
      id: uid("batch"),
      name,
      createdAt: now,
      updatedAt: now,
      runIds: items.map((item) => item.runId),
      concurrency: BATCH_CONCURRENCY,
      status: items.length === 0 ? "failed" : "uploading",
      workflowMode,
      relightIntensity: normalizeRelightIntensity(relightIntensity),
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
        workflowMode:
          opts?.workflowMode ?? existing.workflowMode ?? "flora",
        relightIntensity: normalizeRelightIntensity(
          opts?.relightIntensity ??
            existing.relightIntensity ??
            DEFAULT_RELIGHT_INTENSITY
        ),
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
    const now = Date.now();
    const workflowMode = opts?.workflowMode ?? get().workflowMode;
    const relightIntensity = normalizeRelightIntensity(
      opts?.relightIntensity ?? DEFAULT_RELIGHT_INTENSITY
    );
    const batchRuns = videos.map((video) =>
      buildQueuedRun(video, now, workflowMode, relightIntensity)
    );
    const batch: Batch = {
      id: uid("batch"),
      name,
      createdAt: now,
      updatedAt: now,
      runIds: batchRuns.map((r) => r.id),
      concurrency: BATCH_CONCURRENCY,
      status: batchRuns.length === 0 ? "done" : "running",
      budgetUsd: opts?.budgetUsd,
      workflowMode,
      relightIntensity,
    };
    set((state) => ({
      runs: [...batchRuns, ...state.runs],
      batches: [batch, ...state.batches],
    }));
    runMockBatchQueue(batch, batchRuns);
    return batch.id;
  },

  removeRun: async (runId, options) => {
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
      res = await fetch(
        `/api/runs?id=${encodeURIComponent(runId)}${
          options?.force ? "&force=1" : ""
        }`,
        { method: "DELETE" }
      );
    } catch (err) {
      restore();
      throw err;
    }
    if (!res.ok) {
      restore();
      const body = (await res.json().catch(() => null)) as
        | { error?: unknown }
        | null;
      throw new Error(
        typeof body?.error === "string"
          ? body.error
          : `Delete failed (HTTP ${res.status}).`
      );
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
