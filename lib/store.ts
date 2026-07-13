"use client";

/**
 * App store. Holds every run plus the workflow definition; the engine
 * (lib/engine.ts) drives run state through setState with copied structures,
 * so the canvas and inspector live-update.
 */

import { create } from "zustand";
import type {
  Batch,
  HumanGrade,
  NodeRunState,
  Run,
  VideoAsset,
  WorkflowDefinition,
} from "@/lib/types";
import { uid } from "@/lib/util";
import { estimateRun, formatUsd } from "@/lib/cost";
import { RELIGHT_WORKFLOW } from "@/lib/workflow-def";
import { runWorkflow } from "@/lib/engine";

/**
 * Batch worker pool size: at most this many runWorkflow() executions in
 * flight per batch. Real Omni calls will be rate-limited and per-clip cost is
 * real, so the bounded queue IS the mass-automation story — not a mock
 * convenience. Queued runs sit at status "running" with every node idle
 * (which the batch board reads as "queued") until a slot frees up.
 */
const BATCH_CONCURRENCY = 2;

interface AppStore {
  /** Newest first. */
  runs: Run[];
  /** Newest first. */
  batches: Batch[];
  workflow: WorkflowDefinition;
  /**
   * "mock" until /api/live/health reports that real API keys are configured
   * (checked during hydrate()). Live mode changes UX only in this store's
   * consumers: a LIVE badge, actual-spend readout, and confirm-spend dialogs
   * before anything that costs money.
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
  /** Creates the run, kicks off the async engine, returns the run id. */
  startRun(video: VideoAsset): string;
  /**
   * Mass automation: creates one Run per video plus a Batch pointing at them,
   * then drains the runs through a concurrency-limited worker queue. The
   * batch flips to "done" when every run settles at a terminal status
   * (awaiting-review / approved / needs-changes / failed). Returns batch id.
   * opts.budgetUsd caps the batch's total ESTIMATED live spend: once the next
   * run's estimate would exceed it, remaining runs are failed as skipped.
   */
  startBatch(
    videos: VideoAsset[],
    name?: string,
    opts?: { budgetUsd?: number }
  ): string;
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

function freshNodeStates(): Record<string, NodeRunState> {
  const states: Record<string, NodeRunState> = {};
  for (const node of RELIGHT_WORKFLOW.nodes) {
    states[node.id] = { nodeId: node.id, status: "idle" };
  }
  return states;
}

function buildRun(video: VideoAsset): Run {
  return {
    id: uid("run"),
    workflowId: RELIGHT_WORKFLOW.id,
    createdAt: Date.now(),
    originalVideo: video,
    status: "running",
    iterations: [],
    nodeStates: freshNodeStates(),
    log: [
      {
        at: Date.now(),
        level: "info",
        message: `Run created for "${video.label}" — ${RELIGHT_WORKFLOW.name}`,
      },
    ],
  };
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

export const useAppStore = create<AppStore>()((set, get) => ({
  runs: [],
  batches: [],
  workflow: RELIGHT_WORKFLOW,
  mode: "mock",
  hydrated: false,

  setMode: (mode) => set({ mode }),

  hydrate: () => {
    if (typeof window === "undefined") return Promise.resolve(false); // client-only
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async (): Promise<boolean> => {
      // 1. Live-mode health check — absent route or network error → stay mock.
      let mode: "mock" | "live" = "mock";
      try {
        const res = await fetch("/api/live/health", { cache: "no-store" });
        if (res.ok && healthSaysLive(await res.json())) mode = "live";
      } catch {
        /* mock-only environment */
      }

      // 2. Persisted runs/batches — replace in-memory state, newest first.
      let persisted: { runs: Run[]; batches: Batch[] } | null = null;
      try {
        const res = await fetch("/api/runs", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { runs?: unknown; batches?: unknown };
          if (Array.isArray(data.runs)) {
            persisted = {
              runs: data.runs as Run[],
              batches: Array.isArray(data.batches) ? (data.batches as Batch[]) : [],
            };
          }
        }
      } catch {
        /* mock-only environment */
      }

      if (!persisted) {
        set({ mode, hydrated: true });
        return false;
      }
      const { runs: persistedRuns, batches: persistedBatches } = persisted;
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
      return true;
    })();
    return hydratePromise;
  },

  startRun: (video: VideoAsset) => {
    const run = buildRun(video);
    set((state) => ({ runs: [run, ...state.runs] }));
    void runWorkflow(run.id); // fire-and-forget; engine drives the store
    return run.id;
  },

  startBatch: (videos: VideoAsset[], name = "Batch", opts) => {
    const batchRuns = videos.map((video) => {
      const run = buildRun(video);
      run.log.push({
        at: Date.now(),
        level: "info",
        message: "queued — waiting for a worker slot",
      });
      return run;
    });
    const batch: Batch = {
      id: uid("batch"),
      name,
      createdAt: Date.now(),
      runIds: batchRuns.map((r) => r.id),
      concurrency: BATCH_CONCURRENCY,
      status: batchRuns.length === 0 ? "done" : "running",
      budgetUsd: opts?.budgetUsd,
    };
    set((state) => ({
      runs: [...batchRuns, ...state.runs],
      batches: [batch, ...state.batches],
    }));

    // Bounded worker queue: at most BATCH_CONCURRENCY engines in flight.
    // runWorkflow() never rejects (it catches internally and fails the run),
    // but .catch is kept so a queue slot can never leak.
    //
    // Budget governance (lib/cost.ts): before dispatching each next run, the
    // queue checks dispatched-estimates + next-estimate against budgetUsd.
    // Estimates, not actuals — in mock mode nothing is spent; the same gate
    // guards real dollars when live adapters land.
    const budgetUsd = batch.budgetUsd;
    const estimateById = new Map(
      batchRuns.map((r) => [
        r.id,
        estimateRun(r.originalVideo.durationSec).totalUsd,
      ])
    );
    let dispatchedEstimateUsd = 0;
    const pending = batch.runIds.slice();
    const total = pending.length;
    let inFlight = 0;
    let settledCount = 0;
    const finishIfSettled = (): void => {
      if (settledCount >= total) {
        set((state) => ({
          batches: state.batches.map((b) =>
            b.id === batch.id ? { ...b, status: "done" as const } : b
          ),
        }));
      }
    };
    const pump = (): void => {
      while (inFlight < BATCH_CONCURRENCY && pending.length > 0) {
        const nextEstimate = estimateById.get(pending[0]) ?? 0;
        if (
          budgetUsd !== undefined &&
          dispatchedEstimateUsd + nextEstimate > budgetUsd
        ) {
          // Budget cap reached — do NOT dispatch anything else: settle every
          // remaining queued run as failed/skipped.
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
          `Picked up by a batch worker (${inFlight}/${BATCH_CONCURRENCY} slots busy, ${pending.length} still queued)`
        );
        void runWorkflow(runId)
          .catch(() => undefined)
          .then(() => {
            inFlight -= 1;
            settledCount += 1;
            if (settledCount >= total) {
              finishIfSettled();
            } else {
              pump();
            }
          });
      }
      // Covers the all-skipped case (budget hit with nothing in flight).
      if (inFlight === 0) finishIfSettled();
    };
    pump();
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
