"use client";

/**
 * lib/persist.ts — client → server persistence sync.
 *
 * startPersistence(store) is called ONCE from the client side of the root
 * layout (components/shell/SessionCostChip.tsx, mounted on every page). It:
 *
 *   1. Runs the store's hydrate(): live-mode health check + pull of the
 *      persisted runs/batches from /api/runs.
 *   2. Subscribes to the store and pushes changes back:
 *      - each changed run → debounced PUT /api/runs (800ms per run id,
 *        leading-edge scheduled so a long engine run can't starve the flush);
 *      - the batch list → debounced whole-array PUT /api/batches.
 *      Embedded frame pixels are omitted from sync payloads; the archived
 *      videos remain the artifact of record and list/detail payloads stay
 *      below serverless request limits across multiple iterations.
 *   3. Retries failed hydration and PUTs with capped exponential backoff.
 *      Errors remain visible, but working memory never silently switches off
 *      after a temporary hosted-network failure.
 *
 * Mock-only environments (no /api routes): hydrate() resolves false and the
 * whole module goes inert — no subscription, no network chatter, behavior
 * identical to the pre-persistence app. usePersistenceStatus() reports "off"
 * so the UI hides its indicator dot.
 */

import { useSyncExternalStore } from "react";
import { useAppStore } from "@/lib/store";
import type { Batch, Run } from "@/lib/types";

export type PersistStatus = "off" | "saving" | "saved" | "error";

const DEBOUNCE_MS = 800;
const MAX_BACKOFF_EXPONENT = 6;
/** Sentinel key for the batches array in the error set. */
const BATCHES_KEY = "batches";
const CONNECTION_KEY = "connection";

type AppStoreApi = typeof useAppStore;

// ---------------------------------------------------------------------------
// Module state (client singleton — Next.js keeps one instance per tab)
// ---------------------------------------------------------------------------

let started = false;
/** null until hydrate() settles; false = persistence API absent (stay inert). */
let available: boolean | null = null;

/** Pending debounce/backoff timers, keyed by run id or BATCHES_KEY. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Last successfully pushed object, compared BY REFERENCE (the engine clones on every mutation). */
const lastPushedRun = new Map<string, Run>();
let lastPushedBatches: Batch[] | null = null;
/** Consecutive failed attempts per key; cleared on success or fresh mutation. */
const retries = new Map<string, number>();
/** Keys whose most recent PUT failed (drives the "error" status). */
const errored = new Set<string>();
/** Keys with an active network write; each key is strictly serialized. */
const flushing = new Set<string>();
/** A fresher mutation arrived while this key was in flight. */
const flushAgain = new Set<string>();
let inFlight = 0;

/**
 * A server poll is already a persisted checkpoint. Mark the exact object
 * reference before putting it in Zustand so the push subscriber does not
 * echo that read model back through a browser-writable API.
 */
export function markServerRunObserved(run: Run): void {
  lastPushedRun.set(run.id, run);
}

export function markServerBatchesObserved(batches: Batch[]): void {
  lastPushedBatches = batches;
}

// ---------------------------------------------------------------------------
// Status: tiny external store for the top-bar indicator dot
// ---------------------------------------------------------------------------

const statusListeners = new Set<() => void>();
let status: PersistStatus = "off";

function computeStatus(): PersistStatus {
  if (available !== true) return "off";
  if (errored.size > 0) return "error";
  if (timers.size > 0 || inFlight > 0) return "saving";
  return "saved";
}

function refreshStatus(): void {
  const next = computeStatus();
  if (next === status) return;
  status = next;
  statusListeners.forEach((listener) => listener());
}

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

const getStatus = (): PersistStatus => status;
const getServerStatus = (): PersistStatus => "off";

/** "off" (hidden) / "saving" / "saved" / "error" for the top-bar dot. */
export function usePersistenceStatus(): PersistStatus {
  return useSyncExternalStore(subscribeStatus, getStatus, getServerStatus);
}

// ---------------------------------------------------------------------------
// Flushers
// ---------------------------------------------------------------------------

async function put(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Base64 frame grids grow linearly with attempts and can breach Vercel's
 * 4.5MB body cap before /api/runs executes. They are transient judge inputs,
 * not the media artifact of record, so persist timestamps + served media URLs
 * and keep the pixels only in the active tab.
 */
function runForPersistence(run: Run): Run {
  return {
    ...run,
    // Signals the server to preserve any pixels archived by an older version.
    _compact: true,
    iterations: run.iterations.map((iteration) => ({
      ...iteration,
      relitKeyframeDataUrl: iteration.relitKeyframeDataUrl?.startsWith("data:")
        ? undefined
        : iteration.relitKeyframeDataUrl,
      beforeFrames: iteration.beforeFrames.map((frame) => ({
        timestampSec: frame.timestampSec,
      })),
      afterFrames: iteration.afterFrames.map((frame) => ({
        timestampSec: frame.timestampSec,
      })),
    })),
  };
}

/** On failure: retry forever with capped exponential backoff (max ~51s). */
function handleFailure(key: string, retry: () => void): void {
  const attempt = (retries.get(key) ?? 0) + 1;
  retries.set(key, attempt);
  errored.add(key);
  if (!timers.has(key)) {
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        retry();
      }, DEBOUNCE_MS * 2 ** Math.min(attempt, MAX_BACKOFF_EXPONENT))
    );
  }
}

function flushRun(store: AppStoreApi, runId: string): void {
  if (flushing.has(runId)) {
    flushAgain.add(runId);
    refreshStatus();
    return;
  }
  const run = store.getState().runs.find((r) => r.id === runId);
  if (!run) {
    refreshStatus();
    return;
  }
  flushing.add(runId);
  inFlight += 1;
  refreshStatus();
  void put("/api/runs", { run: runForPersistence(run) }).then((ok) => {
    inFlight -= 1;
    flushing.delete(runId);
    if (ok) {
      lastPushedRun.set(runId, run);
      retries.delete(runId);
      errored.delete(runId);
    } else if (!store.getState().runs.some((item) => item.id === runId)) {
      // A delete may win while an older save is in flight. The server's
      // tombstone correctly rejects that save; do not retry a run the user
      // intentionally removed or leave the global memory indicator red.
      lastPushedRun.delete(runId);
      retries.delete(runId);
      errored.delete(runId);
      flushAgain.delete(runId);
    } else {
      handleFailure(runId, () => flushRun(store, runId));
    }
    if (flushAgain.delete(runId)) {
      schedule(runId, () => flushRun(store, runId));
    }
    refreshStatus();
  });
}

function flushBatches(store: AppStoreApi): void {
  if (flushing.has(BATCHES_KEY)) {
    flushAgain.add(BATCHES_KEY);
    refreshStatus();
    return;
  }
  const batches = store.getState().batches;
  flushing.add(BATCHES_KEY);
  inFlight += 1;
  refreshStatus();
  void put("/api/batches", { batches }).then((ok) => {
    inFlight -= 1;
    flushing.delete(BATCHES_KEY);
    if (ok) {
      lastPushedBatches = batches;
      retries.delete(BATCHES_KEY);
      errored.delete(BATCHES_KEY);
    } else {
      handleFailure(BATCHES_KEY, () => flushBatches(store));
    }
    if (flushAgain.delete(BATCHES_KEY)) {
      schedule(BATCHES_KEY, () => flushBatches(store));
    }
    refreshStatus();
  });
}

/**
 * Leading-edge schedule: the first change arms one timer; further changes
 * inside the window ride along (the flush reads the freshest state). A fresh
 * mutation also resets the retry counter so a previously given-up object
 * gets a new backoff budget.
 */
function schedule(key: string, flush: () => void): void {
  if (timers.has(key)) return;
  retries.delete(key);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      flush();
    }, DEBOUNCE_MS)
  );
  refreshStatus();
}

function onStoreChange(store: AppStoreApi): void {
  const state = store.getState();
  for (const run of state.runs) {
    if (lastPushedRun.get(run.id) !== run) {
      schedule(run.id, () => flushRun(store, run.id));
    }
  }
  if (lastPushedBatches !== state.batches) {
    schedule(BATCHES_KEY, () => flushBatches(store));
  }
}

/** Flush debounced/backoff work as soon as the tab is backgrounded. */
function flushPendingNow(store: AppStoreApi): void {
  for (const [key, timer] of timers) {
    if (key === CONNECTION_KEY) continue;
    clearTimeout(timer);
    timers.delete(key);
  }
  const state = store.getState();
  for (const run of state.runs) {
    if (lastPushedRun.get(run.id) !== run) flushRun(store, run.id);
  }
  if (lastPushedBatches !== state.batches) flushBatches(store);
  refreshStatus();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Boot the persistence layer: hydrate once, then push-sync store mutations.
 * Idempotent and SSR-safe — call it from a client component's effect.
 */
export function startPersistence(store: AppStoreApi = useAppStore): void {
  if (typeof window === "undefined") return; // browser only
  if (started) return;
  started = true;
  let subscribed = false;
  const connect = async (): Promise<void> => {
    try {
      const ok = await store.getState().hydrate();
      available = ok;
      retries.delete(CONNECTION_KEY);
      errored.delete(CONNECTION_KEY);
      if (!ok) {
        // Static/mock-only environment: no persistence API. Stay inert.
        refreshStatus();
        return;
      }
      if (!subscribed) {
        subscribed = true;
        // Prime the "already pushed" refs from the hydrated state so we never
        // echo the server's own data straight back at it.
        const state = store.getState();
        for (const run of state.runs) lastPushedRun.set(run.id, run);
        lastPushedBatches = state.batches;
        store.subscribe(() => onStoreChange(store));
        const flushWhenHidden = (): void => {
          if (document.visibilityState === "hidden") flushPendingNow(store);
        };
        document.addEventListener("visibilitychange", flushWhenHidden);
        window.addEventListener("pagehide", () => flushPendingNow(store));
      }
      refreshStatus();
    } catch {
      // Hosted APIs can be briefly unavailable during deploys or network
      // transitions. Keep retrying and make the failed durability boundary
      // visible instead of treating it like a no-API mock environment.
      available = true;
      handleFailure(CONNECTION_KEY, () => void connect());
      refreshStatus();
    }
  };
  void connect();
}
