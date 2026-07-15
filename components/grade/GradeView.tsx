"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { BatchExecutionSummary, GradeClipDraft, Run } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { EmptyState } from "@/components/ui";
import { finalLampIteration, isGradeable } from "@/components/grade/derive";
import { ClipGrader } from "@/components/grade/ClipGrader";
import { ResultsView } from "@/components/grade/ResultsView";
import { useGradeDraft } from "@/components/grade/useGradeDraft";
import { formatRunDate } from "@/components/library/derive";
import { markServerRunObserved } from "@/lib/persist";
import { mergeGradeFeedRuns } from "@/components/grade/run-feed";

/*
 * /grade has two modes:
 *
 *   Grade clips — automated scores start hidden so they do not anchor the
 *                 human read, with an explicit per-video reveal available.
 *                 Draft answers autosave independently from the run document.
 *   Results     — shows saved human grades and, only when they exist, the
 *                 automated comparisons useful for rubric calibration.
 *
 * The queue admits only provider-journal-backed artifacts. Final grades use a
 * dedicated atomic API write instead of the browser's whole-run sync path.
 */

type Mode = "grade" | "results";

function emptyClipDraft(): GradeClipDraft {
  return { answers: {}, overallNote: "" };
}

/** Pinned segmented control — same visual contract as RunTabs, buttons not links. */
function ModeTabs({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  const cls = (m: Mode) =>
    `min-h-10 rounded-md px-3 py-1 text-sm transition-[transform,color,background-color] duration-150 ease-out active:scale-[0.96] ${
      mode === m ? "bg-raised text-ink" : "text-muted hover:text-ink"
    }`;
  return (
    <nav
      className="flex items-center rounded-lg border border-edge p-0.5"
      aria-label="Grade page mode"
    >
      <button className={cls("grade")} onClick={() => onChange("grade")}>
        Grade clips
      </button>
      <button className={cls("results")} onClick={() => onChange("results")}>
        Results
      </button>
    </nav>
  );
}

export function GradeView(
  { requestedRunId }: { requestedRunId?: string } = {}
) {
  const runs = useAppStore((s) => s.runs);
  const batchExecutions = useAppStore((s) => s.batchExecutions);
  const hydrated = useAppStore((s) => s.hydrated);
  const [mode, setMode] = useState<Mode>("grade");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    requestedRunId ?? null
  );
  const selectedRunIdRef = useRef<string | null>(requestedRunId ?? null);
  const appliedRequestedRunId = useRef<string | null>(null);
  const lastRequestedRunId = useRef<string | undefined>(requestedRunId);
  const [feedStatus, setFeedStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const { draft, ready: draftReady, saveState, updateDraft, retry } =
    useGradeDraft();
  const activeServerRunKey = useMemo(
    () =>
      runs
        .filter(
          (run) =>
            run.serverExecution?.status === "queued" ||
            run.serverExecution?.status === "running"
        )
        .map((run) => run.id)
        .sort()
        .join("|"),
    [runs]
  );
  const activeBatchExecutionKey = useMemo(
    () =>
      Object.values(batchExecutions)
        .filter(
          (execution) =>
            execution.status === "queued" || execution.status === "running"
        )
        .map((execution) => execution.batchId)
        .sort()
        .join("|"),
    [batchExecutions]
  );

  // Entering Grade refreshes the full authoritative run feed. While a durable
  // batch or run is active this keeps polling the list because a batch child
  // may not have its RunExecution yet when the start response first reaches
  // the browser, and an explicitly deleted active run must leave the cache.
  // Focus also discovers work created by another tab/device.
  useEffect(() => {
    if (!hydrated) return;
    if (lastRequestedRunId.current !== requestedRunId) {
      setFeedStatus("loading");
    }
    const controller = new AbortController();
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number): void => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void load();
      }, delay);
    };

    const load = async (): Promise<void> => {
      if (stopped || inFlight) return;
      inFlight = true;
      const stateAtReadStart = useAppStore.getState();
      const runsAtReadStart = new Map(
        stateAtReadStart.runs
          .filter((run) => run.serverExecution !== undefined)
          .map((run) => [run.id, run] as const)
      );
      const batchExecutionsAtReadStart = new Map(
        Object.entries(stateAtReadStart.batchExecutions)
      );
      const verifiedRuns: Run[] = [];
      let discoveredBatchExecutions: BatchExecutionSummary[] = [];
      let batchFeedReceived = false;
      let feedComplete = false;
      let shouldContinue =
        activeBatchExecutionKey.length > 0 || activeServerRunKey.length > 0;
      let cursor: string | null = null;
      try {
        for (let page = 0; page < 20; page += 1) {
          const url = cursor
            ? `/api/runs?limit=25&cursor=${encodeURIComponent(cursor)}`
            : "/api/runs?limit=25";
          const response = await fetch(url, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(`Run feed refresh failed (${response.status}).`);
          }
          const payload = (await response.json()) as {
            runs?: Run[];
            batchExecutions?: BatchExecutionSummary[];
            nextCursor?: string | null;
          };
          if (!Array.isArray(payload.runs)) {
            throw new Error("Run feed refresh returned an invalid payload.");
          }
          verifiedRuns.push(...payload.runs);
          if (page === 0 && Array.isArray(payload.batchExecutions)) {
            discoveredBatchExecutions = payload.batchExecutions;
            batchFeedReceived = true;
          }
          const next =
            typeof payload.nextCursor === "string" &&
            payload.nextCursor.length > 0
              ? payload.nextCursor
              : null;
          if (!next) {
            feedComplete = true;
            break;
          }
          if (next === cursor) break;
          cursor = next;
        }
        if (stopped || controller.signal.aborted) return;

        useAppStore.setState((state) => {
          const nextBatchExecutions = { ...state.batchExecutions };
          const incomingBatchIds = new Set(
            discoveredBatchExecutions.map((execution) => execution.batchId)
          );
          if (batchFeedReceived) {
            for (const [batchId, current] of Object.entries(
              nextBatchExecutions
            )) {
              if (
                !incomingBatchIds.has(batchId) &&
                batchExecutionsAtReadStart.get(batchId) === current
              ) {
                delete nextBatchExecutions[batchId];
              }
            }
          }
          for (const incoming of discoveredBatchExecutions) {
            const current = nextBatchExecutions[incoming.batchId];
            if (
              !current ||
              (current.executionId === incoming.executionId &&
                incoming.revision >= current.revision) ||
              (current.executionId !== incoming.executionId &&
                incoming.updatedAt >= current.updatedAt)
            ) {
              nextBatchExecutions[incoming.batchId] = incoming;
            }
          }
          const currentById = new Map(state.runs.map((run) => [run.id, run]));
          const incomingIds = new Set(verifiedRuns.map((run) => run.id));
          const mergedRuns = mergeGradeFeedRuns(state.runs, verifiedRuns, {
            ...(feedComplete
              ? { pruneMissingServerOwnedFrom: runsAtReadStart }
              : {}),
          });
          for (const run of mergedRuns) {
            if (
              incomingIds.has(run.id) &&
              currentById.get(run.id) !== run
            ) {
              markServerRunObserved(run);
            }
          }
          return {
            runs: mergedRuns,
            batchExecutions: nextBatchExecutions,
          };
        });
        setFeedStatus("ready");

        const discoveredActiveBatch = discoveredBatchExecutions.some(
          (execution) =>
            execution.status === "queued" || execution.status === "running"
        );
        shouldContinue = shouldContinue || discoveredActiveBatch;
      } catch {
        // Keep the locally loaded grading workspace intact. Active work keeps
        // retrying; otherwise focus or a remount provides the next read.
        if (!stopped && !controller.signal.aborted) {
          setFeedStatus((current) =>
            current === "ready" ? current : "error"
          );
        }
      } finally {
        inFlight = false;
        if (shouldContinue) schedule(4_000);
      }
    };

    const refreshVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      schedule(0);
    };
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    void load();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [activeBatchExecutionKey, activeServerRunKey, hydrated, requestedRunId]);

  // Keep the grading queue live while durable Lamp finals finish. The broad
  // refresh above discovers all persisted runs once; this focused loop then
  // polls only active execution ids and stops as soon as each cut settles.
  useEffect(() => {
    if (!hydrated || !activeServerRunKey) return;
    const runIds = activeServerRunKey.split("|");
    const controller = new AbortController();
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number): void => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void load();
      }, delay);
    };

    const load = async (): Promise<void> => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const settled = await Promise.allSettled(
          runIds.map(async (runId) => {
            const response = await fetch(
              `/api/runs?id=${encodeURIComponent(runId)}`,
              { cache: "no-store", signal: controller.signal }
            );
            if (!response.ok) {
              throw new Error(`Run refresh failed (${response.status}).`);
            }
            const payload = (await response.json()) as { run?: Run };
            if (!payload.run || payload.run.id !== runId) {
              throw new Error("Run refresh returned the wrong run.");
            }
            return payload.run;
          })
        );
        if (stopped || controller.signal.aborted) return;
        const refreshed = settled.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : []
        );
        if (refreshed.length > 0) {
          useAppStore.setState((state) => {
            const currentById = new Map(
              state.runs.map((run) => [run.id, run])
            );
            const refreshedIds = new Set(refreshed.map((run) => run.id));
            const mergedRuns = mergeGradeFeedRuns(state.runs, refreshed);
            for (const run of mergedRuns) {
              if (
                refreshedIds.has(run.id) &&
                currentById.get(run.id) !== run
              ) {
                markServerRunObserved(run);
              }
            }
            return { runs: mergedRuns };
          });
        }
      } catch {
        // Failed ids remain independently retryable without withholding
        // successful batch peers.
      } finally {
        inFlight = false;
        schedule(4_000);
      }
    };

    const refreshVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      schedule(0);
    };
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    void load();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [activeServerRunKey, hydrated]);

  const gradeable = useMemo(
    () => runs.filter(isGradeable).sort((a, b) => b.createdAt - a.createdAt),
    [runs]
  );
  const graded = useMemo(
    () => gradeable.filter((r) => r.humanGrade),
    [gradeable]
  );
  const hasAutomatedResults = useMemo(
    () =>
      graded.some(
        (run) => (finalLampIteration(run)?.evalResults.length ?? 0) > 0
    ),
    [graded]
  );
  const ungraded = useMemo(
    () => gradeable.filter((run) => !run.humanGrade),
    [gradeable]
  );
  const queue = useMemo(() => {
    const skipped = draft?.skippedRunIds ?? [];
    // Skipped clips come back at the end, in the order they were skipped.
    const ordered = [
      ...ungraded.filter((r) => !skipped.includes(r.id)),
      ...skipped
        .map((id) => ungraded.find((r) => r.id === id))
        .filter((r): r is (typeof ungraded)[number] => r !== undefined),
    ];
    const restoredCurrent =
      selectedRunId && ordered.some((run) => run.id === selectedRunId)
        ? selectedRunId
        : draft?.currentRunId;
    if (!restoredCurrent) return ordered;
    const currentIndex = ordered.findIndex((run) => run.id === restoredCurrent);
    if (currentIndex <= 0) return ordered;
    return [ordered[currentIndex], ...ordered.filter((_, i) => i !== currentIndex)];
  }, [draft?.currentRunId, draft?.skippedRunIds, selectedRunId, ungraded]);
  const current = queue[0];
  const requestedRun = requestedRunId
    ? runs.find((run) => run.id === requestedRunId)
    : undefined;
  const requestedUngraded = requestedRunId
    ? ungraded.find((run) => run.id === requestedRunId)
    : undefined;
  const requestedRunChanged = lastRequestedRunId.current !== requestedRunId;

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  // A deep link selects once. Subsequent Skip/Save choices own navigation and
  // are not pulled back to the original query-string run.
  useEffect(() => {
    if (lastRequestedRunId.current !== requestedRunId) {
      lastRequestedRunId.current = requestedRunId;
      appliedRequestedRunId.current = null;
    }
    if (
      !draftReady ||
      !requestedRunId ||
      appliedRequestedRunId.current === requestedRunId ||
      !ungraded.some((run) => run.id === requestedRunId)
    ) {
      return;
    }
    appliedRequestedRunId.current = requestedRunId;
    selectedRunIdRef.current = requestedRunId;
    setSelectedRunId(requestedRunId);
    updateDraft(
      (workspace) => ({
        ...workspace,
        currentRunId: requestedRunId,
        skippedRunIds: workspace.skippedRunIds.filter(
          (id) => id !== requestedRunId
        ),
      }),
      { immediate: true }
    );
  }, [draftReady, requestedRunId, ungraded, updateDraft]);

  const updateClipDraft = useCallback(
    (runId: string, update: (current: GradeClipDraft) => GradeClipDraft) => {
      updateDraft((workspace) => ({
        ...workspace,
        clips: {
          ...workspace.clips,
          [runId]: update(workspace.clips[runId] ?? emptyClipDraft()),
        },
      }));
    },
    [updateDraft]
  );

  const skipCurrent = useCallback(() => {
    if (!current) return;
    const nextRunId = queue[1]?.id;
    selectedRunIdRef.current = nextRunId ?? null;
    setSelectedRunId(nextRunId ?? null);
    updateDraft(
      (workspace) => ({
        ...workspace,
        skippedRunIds: [
          ...workspace.skippedRunIds.filter((id) => id !== current.id),
          current.id,
        ],
        ...(nextRunId ? { currentRunId: nextRunId } : { currentRunId: undefined }),
      }),
      { immediate: true }
    );
  }, [current, queue, updateDraft]);

  const clearSubmittedDraft = useCallback(
    (runId: string, nextRunId?: string) => {
      updateDraft(
        (workspace) => {
          const clips = { ...workspace.clips };
          delete clips[runId];
          return {
            ...workspace,
            clips,
            skippedRunIds: workspace.skippedRunIds.filter((id) => id !== runId),
            ...(workspace.currentRunId === runId
              ? { currentRunId: nextRunId }
              : {}),
          };
        },
        { immediate: true }
      );
    },
    [updateDraft]
  );

  const selectRun = useCallback(
    (runId: string) => {
      selectedRunIdRef.current = runId;
      setSelectedRunId(runId);
      updateDraft(
        (workspace) => ({
          ...workspace,
          currentRunId: runId,
          skippedRunIds: workspace.skippedRunIds.filter((id) => id !== runId),
        }),
        { immediate: true }
      );
    },
    [updateDraft]
  );

  // Restore the exact clip position, including after new runs arrive.
  useEffect(() => {
    if (!draftReady || !current || draft?.currentRunId === current.id) return;
    updateDraft((workspace) => ({ ...workspace, currentRunId: current.id }));
  }, [current, draft?.currentRunId, draftReady, updateDraft]);

  // A successfully submitted grade wins over a stale draft left by a prior
  // interrupted save; prune it as soon as hydrated runs prove submission.
  useEffect(() => {
    if (!hydrated || !draftReady || !draft) return;
    const submittedIds = gradeable.filter((run) => run.humanGrade).map((run) => run.id);
    const submitted = new Set(submittedIds);
    const stale = Object.keys(draft.clips).filter((id) => submitted.has(id));
    const currentWasSubmitted = Boolean(
      draft.currentRunId && submitted.has(draft.currentRunId)
    );
    if (
      stale.length === 0 &&
      !draft.skippedRunIds.some((id) => submitted.has(id)) &&
      !currentWasSubmitted
    ) {
      return;
    }
    updateDraft((workspace) => {
      const clips = { ...workspace.clips };
      for (const id of submittedIds) delete clips[id];
      return {
        ...workspace,
        clips,
        skippedRunIds: workspace.skippedRunIds.filter((id) => !submitted.has(id)),
        ...(workspace.currentRunId && submitted.has(workspace.currentRunId)
          ? { currentRunId: undefined }
          : {}),
      };
    });
  }, [draft, draftReady, gradeable, hydrated, updateDraft]);

  return (
    <main className="mx-auto max-w-5xl px-6 pb-16 pt-8">
      <header className="flex flex-wrap items-center gap-3 pb-5">
        <h1 className="text-balance text-base font-semibold text-ink">Grade</h1>
        <p className="text-pretty text-2xs text-faint">
          {mode === "grade"
            ? "grade every active rubric row by eye — Lamp uses nine, and the completed final AI evaluation starts hidden until you reveal it"
            : hasAutomatedResults
              ? "compare each final video first, then use the aggregate view to calibrate the method"
              : "your saved human grades — no final AI results are available to compare"}
        </p>
        <span className="ml-auto flex items-center gap-3">
          {mode === "grade" ? (
            <span className="text-2xs tabular-nums text-muted">
              {graded.length} of {gradeable.length} graded
            </span>
          ) : null}
          <ModeTabs mode={mode} onChange={setMode} />
        </span>
      </header>

      {!hydrated || !draftReady ? (
        <p className="py-10 text-center text-2xs text-faint">
          {!hydrated ? "loading runs…" : "restoring saved grading work…"}
        </p>
      ) : mode === "grade" ? (
        requestedRunId &&
        appliedRequestedRunId.current !== requestedRunId &&
        !requestedUngraded ? (
          requestedRunChanged || feedStatus === "loading" ? (
            <p className="py-10 text-center text-2xs text-faint">
              loading the requested video…
            </p>
          ) : requestedRun?.humanGrade ? (
            <EmptyState
              title="This video is already graded"
              hint="Its saved human grade and AI comparison are available in Results."
              action={
                <button
                  onClick={() => setMode("results")}
                  className="mt-1 min-h-10 rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition-[transform,border-color] duration-150 ease-out hover:border-faint active:scale-[0.96]"
                >
                  View results
                </button>
              }
            />
          ) : requestedRun ? (
            <EmptyState
              title="This video is not ready to grade"
              hint="Lamp adds a video here only after Final and its saved AI evaluation are complete."
              action={
                <Link
                  href={`/runs/${encodeURIComponent(requestedRun.id)}`}
                  className="mt-1 inline-flex min-h-10 items-center rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition-[transform,border-color] duration-150 ease-out hover:border-faint active:scale-[0.96]"
                >
                  Open run
                </Link>
              }
            />
          ) : (
            <EmptyState
              title={
                feedStatus === "error"
                  ? "Could not load this video"
                  : "This video is unavailable"
              }
              hint="It may have been deleted, or the link may no longer match a saved run."
              action={
                <Link
                  href="/library"
                  className="mt-1 inline-flex min-h-10 items-center rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition-[transform,border-color] duration-150 ease-out hover:border-faint active:scale-[0.96]"
                >
                  Open Runs
                </Link>
              }
            />
          )
        ) : gradeable.length === 0 ? (
          <EmptyState
            title="Nothing to grade yet"
            hint="Finish a Lamp run first — once Final and its AI evaluation are complete, the video lands here for grading."
            action={
              <Link
                href="/"
                className="mt-1 inline-flex min-h-10 items-center rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition-[transform,border-color] duration-150 ease-out hover:border-faint active:scale-[0.96]"
              >
                Go to Create
              </Link>
            }
          />
        ) : current ? (
          <>
            <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-edge pb-4">
              <label
                htmlFor="grade-run-selector"
                className="text-2xs font-medium uppercase tracking-[0.14em] text-faint"
              >
                Video to grade
              </label>
              <select
                id="grade-run-selector"
                value={current.id}
                onChange={(event) => selectRun(event.target.value)}
                className="min-h-10 min-w-0 max-w-full flex-1 rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm text-ink transition-[transform,border-color,background-color] duration-150 ease-out hover:border-faint focus:border-accent focus:outline-none active:scale-[0.99] sm:max-w-xl"
              >
                {ungraded.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.originalVideo.label} · {formatRunDate(run.createdAt)} ·{" "}
                    {run.id.slice(-6)}
                  </option>
                ))}
              </select>
              <span className="text-2xs tabular-nums text-faint">
                {ungraded.length} ungraded
              </span>
            </div>
            <ClipGrader
              key={current.id}
              run={current}
              remaining={queue.length}
              draft={draft?.clips[current.id] ?? emptyClipDraft()}
              draftSaveState={saveState}
              onDraftChange={(update) => updateClipDraft(current.id, update)}
              onRetryDraftSave={retry}
              onSubmitted={(runId) => {
                const nextRunId = queue.find((run) => run.id !== runId)?.id;
                if (selectedRunIdRef.current === runId) {
                  selectedRunIdRef.current = nextRunId ?? null;
                  setSelectedRunId(nextRunId ?? null);
                }
                clearSubmittedDraft(runId, nextRunId);
              }}
              onSkip={skipCurrent}
            />
          </>
        ) : (
          <EmptyState
            title="All clips graded"
            hint={
              hasAutomatedResults
                ? `You graded every clip with a real relit cut (${graded.length} of ${gradeable.length}). See how your calls compare with the available automated results.`
                : `You graded every clip with a real relit cut (${graded.length} of ${gradeable.length}). Your human grades are saved even though automated checks were not run.`
            }
            action={
              <button
                onClick={() => setMode("results")}
                className="mt-1 min-h-10 rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition-[transform,border-color] duration-150 ease-out hover:border-faint active:scale-[0.96]"
              >
                {hasAutomatedResults ? "Compare results" : "View saved grades"}
              </button>
            }
          />
        )
      ) : graded.length === 0 ? (
        <EmptyState
          title="No grades yet"
          hint="Grade a few clips first — then this view shows agreement rates, score gaps, and the disagreements worth digging into."
          action={
            <button
              onClick={() => setMode("grade")}
              className="mt-1 min-h-10 rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition-[transform,border-color] duration-150 ease-out hover:border-faint active:scale-[0.96]"
            >
              Start grading
            </button>
          }
        />
      ) : (
        <ResultsView gradedRuns={graded} />
      )}
    </main>
  );
}
