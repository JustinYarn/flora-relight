"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/lib/store";
import type { Run } from "@/lib/types";

/**
 * List hydration intentionally omits embedded frame pixels. Detail/Journey
 * pages lazily replace that compact record with the full run document. Active
 * in-tab runs are never replaced by a potentially older server snapshot.
 */
export function useRunDetails(runId: string): Run | undefined {
  const run = useAppStore((state) => state.runs.find((item) => item.id === runId));
  const hydrated = useAppStore((state) => state.hydrated);
  const fetchedRef = useRef<string | null>(null);
  const serverActive =
    run?.serverExecution?.status === "queued" ||
    run?.serverExecution?.status === "running" ||
    run?.serverExecution?.status === "reconcile_required";
  const singleRecoverable =
    run?.spendApproval?.source === "single" &&
    run.spendApproval.batchId === undefined &&
    (!run?.serverExecution ||
      (run.serverExecution.source === "single" && serverActive));

  useEffect(() => {
    if (
      !hydrated ||
      (!serverActive && !singleRecoverable && fetchedRef.current === runId)
    ) {
      return;
    }
    fetchedRef.current = runId;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        let recoveryShouldRetry = singleRecoverable;
        let recoveryBlocked = false;
        if (singleRecoverable) {
          const recovery = await fetch("/api/runs/recover", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId }),
            signal: controller.signal,
          });
          // A conflict is terminal until the user explicitly renews approval;
          // network/5xx failures remain safe to retry while this view is open.
          recoveryShouldRetry = recovery.status >= 500;
          recoveryBlocked = recovery.status >= 400 && recovery.status < 500;
        }
        const response = await fetch(`/api/runs?id=${encodeURIComponent(runId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok || controller.signal.aborted) {
          if (
            ((!recoveryBlocked && serverActive) || recoveryShouldRetry) &&
            !controller.signal.aborted
          ) {
            timer = setTimeout(() => void load(), 4_000);
          }
          return;
        }
        const payload = (await response.json()) as { run?: Run };
        const fullRun = payload.run;
        if (!fullRun || controller.signal.aborted) return;
        useAppStore.setState((state) => {
          const current = state.runs.find((item) => item.id === runId);
          // Only the legacy browser engine owns a running record locally.
          // Server-owned execution must refresh from its durable read model.
          if (
            current?.status === "running" &&
            !current.serverExecution &&
            !current.spendApproval
          ) {
            return state;
          }
          const exists = state.runs.some((item) => item.id === runId);
          return {
            ...state,
            runs: exists
              ? state.runs.map((item) => (item.id === runId ? fullRun : item))
              : [fullRun, ...state.runs],
          };
        });
        const remainsActive =
          fullRun.serverExecution?.status === "queued" ||
          fullRun.serverExecution?.status === "running" ||
          fullRun.serverExecution?.status === "reconcile_required";
        const remainsRecoverable =
          Boolean(fullRun.spendApproval) &&
          (!fullRun.serverExecution ||
            (fullRun.serverExecution.source === "single" && remainsActive));
        if (
          !recoveryBlocked &&
          (remainsActive || remainsRecoverable) &&
          !controller.signal.aborted
        ) {
          timer = setTimeout(() => void load(), 4_000);
        }
      } catch {
        // Keep active durable runs polling across temporary hosted-network
        // failures; non-active detail fetches remain best effort.
        fetchedRef.current = null;
        if ((serverActive || singleRecoverable) && !controller.signal.aborted) {
          timer = setTimeout(() => void load(), 4_000);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [hydrated, runId, serverActive, singleRecoverable]);

  return run;
}
