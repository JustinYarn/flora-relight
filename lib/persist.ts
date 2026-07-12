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
 *      Runs are pushed verbatim — frame dataUrls included (~2MB/run is
 *      acceptable; the server file is the artifact of record).
 *   3. Retries failed PUTs with exponential backoff (max 5 attempts, then
 *      parks as "error" until that run mutates again).
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
const MAX_RETRIES = 5;
/** Sentinel key for the batches array in the error set. */
const BATCHES_KEY = "batches";

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
let inFlight = 0;

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

/** On failure: exponential backoff (1.6s, 3.2s, … capped attempts). */
function handleFailure(key: string, retry: () => void): void {
  const attempt = (retries.get(key) ?? 0) + 1;
  retries.set(key, attempt);
  errored.add(key);
  if (attempt <= MAX_RETRIES && !timers.has(key)) {
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        retry();
      }, DEBOUNCE_MS * 2 ** attempt)
    );
  }
  // Past MAX_RETRIES: give up until the object mutates again.
}

function flushRun(store: AppStoreApi, runId: string): void {
  const run = store.getState().runs.find((r) => r.id === runId);
  if (!run) {
    refreshStatus();
    return;
  }
  inFlight += 1;
  refreshStatus();
  void put("/api/runs", { run }).then((ok) => {
    inFlight -= 1;
    if (ok) {
      lastPushedRun.set(runId, run);
      retries.delete(runId);
      errored.delete(runId);
    } else {
      handleFailure(runId, () => flushRun(store, runId));
    }
    refreshStatus();
  });
}

function flushBatches(store: AppStoreApi): void {
  const batches = store.getState().batches;
  inFlight += 1;
  refreshStatus();
  void put("/api/batches", { batches }).then((ok) => {
    inFlight -= 1;
    if (ok) {
      lastPushedBatches = batches;
      retries.delete(BATCHES_KEY);
      errored.delete(BATCHES_KEY);
    } else {
      handleFailure(BATCHES_KEY, () => flushBatches(store));
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
  void (async () => {
    const ok = await store.getState().hydrate();
    available = ok;
    if (!ok) {
      // Mock-only environment: no persistence API. Stay inert.
      refreshStatus();
      return;
    }
    // Prime the "already pushed" refs from the hydrated state so we never
    // echo the server's own data straight back at it.
    const state = store.getState();
    for (const run of state.runs) lastPushedRun.set(run.id, run);
    lastPushedBatches = state.batches;
    store.subscribe(() => onStoreChange(store));
    refreshStatus();
  })();
}
