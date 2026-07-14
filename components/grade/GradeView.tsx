"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { GradeClipDraft, Run } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { EmptyState } from "@/components/ui";
import { finalLampIteration, isGradeable } from "@/components/grade/derive";
import { ClipGrader } from "@/components/grade/ClipGrader";
import { ResultsView } from "@/components/grade/ResultsView";
import { useGradeDraft } from "@/components/grade/useGradeDraft";
import { markServerRunObserved } from "@/lib/persist";

/*
 * /grade has two modes:
 *
 *   Grade clips — blind by design: automated scores are hidden so they do not
 *                 anchor the human read. Draft answers autosave independently
 *                 from the run document.
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

export function GradeView() {
  const runs = useAppStore((s) => s.runs);
  const hydrated = useAppStore((s) => s.hydrated);
  const [mode, setMode] = useState<Mode>("grade");
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

  // Entering Grade refreshes only server-verified provider artifacts. This
  // makes a video available for manual grading after the browser-side judge
  // pipeline crashed, without replacing newer in-tab logs/evals for a run
  // that may still be active.
  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    void (async () => {
      const verifiedRuns: Run[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const url = cursor
          ? `/api/runs?limit=25&cursor=${encodeURIComponent(cursor)}`
          : "/api/runs?limit=25";
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          runs?: Run[];
          nextCursor?: string | null;
        };
        if (!Array.isArray(payload.runs)) return;
        verifiedRuns.push(...payload.runs);
        const next =
          typeof payload.nextCursor === "string" && payload.nextCursor.length > 0
            ? payload.nextCursor
            : null;
        if (!next || next === cursor) break;
        cursor = next;
      }
      if (controller.signal.aborted) return;
      const byId = new Map(verifiedRuns.map((run) => [run.id, run]));
      useAppStore.setState((state) => ({
        runs: state.runs.map((local) => {
          const server = byId.get(local.id);
          if (!server) return local;
          // Durable execution truth is server-owned. Replacing the whole read
          // model here also removes any stale locally cached trust marker when
          // the server has put an artifact into reconciliation.
          if (server.serverExecution) return server;
          const verifiedIterations = server.iterations.filter(
            (iteration) =>
              iteration.recoveredFromProviderOperation === true &&
              iteration.generatedVideo !== undefined
          );
          if (verifiedIterations.length === 0) return local;
          const verifiedByIndex = new Map(
            verifiedIterations.map((iteration) => [iteration.index, iteration])
          );
          const localIndexes = new Set(local.iterations.map((iteration) => iteration.index));
          const iterations = local.iterations.map((iteration) => {
            const verified = verifiedByIndex.get(iteration.index);
            return verified
              ? {
                  ...iteration,
                  interactionId: verified.interactionId,
                  generatedVideo: verified.generatedVideo,
                  recoveredFromProviderOperation: true as const,
                }
              : iteration;
          });
          for (const verified of verifiedIterations) {
            if (!localIndexes.has(verified.index)) iterations.push(verified);
          }
          iterations.sort((a, b) => a.index - b.index);
          return {
            ...local,
            originalVideo: server.originalVideo,
            providerOperations: server.providerOperations,
            iterations,
            finalVideo: local.finalVideo?.simulatedFilter
              ? local.finalVideo
              : undefined,
          };
        }),
      }));
    })().catch(() => {
      // Persistence status already surfaces connection failures. Keep the
      // locally loaded grading workspace intact and let its normal retry path
      // recover instead of blanking the queue.
    });
    return () => controller.abort();
  }, [hydrated]);

  // Keep the grading queue live while durable Lamp finals finish. The broad
  // refresh above discovers all persisted runs once; this focused loop then
  // polls only active execution ids and stops as soon as each cut settles.
  useEffect(() => {
    if (!hydrated || !activeServerRunKey) return;
    const runIds = activeServerRunKey.split("|");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async (): Promise<void> => {
      try {
        const refreshed = await Promise.all(
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
        if (controller.signal.aborted) return;
        const byId = new Map(refreshed.map((run) => [run.id, run]));
        for (const run of refreshed) markServerRunObserved(run);
        useAppStore.setState((state) => ({
          runs: state.runs.map((run) => byId.get(run.id) ?? run),
        }));
        if (
          refreshed.some(
            (run) =>
              run.serverExecution?.status === "queued" ||
              run.serverExecution?.status === "running"
          )
        ) {
          timer = setTimeout(() => void load(), 4_000);
        }
      } catch {
        if (!controller.signal.aborted) {
          timer = setTimeout(() => void load(), 4_000);
        }
      }
    };

    const refreshVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 0);
    };
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    void load();
    return () => {
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
  const queue = useMemo(() => {
    const ungraded = gradeable.filter((r) => !r.humanGrade);
    const skipped = draft?.skippedRunIds ?? [];
    // Skipped clips come back at the end, in the order they were skipped.
    const ordered = [
      ...ungraded.filter((r) => !skipped.includes(r.id)),
      ...skipped
        .map((id) => ungraded.find((r) => r.id === id))
        .filter((r): r is (typeof ungraded)[number] => r !== undefined),
    ];
    const restoredCurrent = draft?.currentRunId;
    if (!restoredCurrent) return ordered;
    const currentIndex = ordered.findIndex((run) => run.id === restoredCurrent);
    if (currentIndex <= 0) return ordered;
    return [ordered[currentIndex], ...ordered.filter((_, i) => i !== currentIndex)];
  }, [draft?.currentRunId, draft?.skippedRunIds, gradeable]);
  const current = queue[0];

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
    (runId: string) => {
      updateDraft(
        (workspace) => {
          const clips = { ...workspace.clips };
          delete clips[runId];
          return {
            ...workspace,
            clips,
            skippedRunIds: workspace.skippedRunIds.filter((id) => id !== runId),
            ...(workspace.currentRunId === runId
              ? { currentRunId: undefined }
              : {}),
          };
        },
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
            ? "grade all 11 rubric rows by eye — Lamp keeps the final AI evaluation sealed until you save"
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
        gradeable.length === 0 ? (
          <EmptyState
            title="Nothing to grade yet"
            hint="Finish a Lamp run first — once its real final video is ready, it lands here for blind grading."
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
          <ClipGrader
            key={current.id}
            run={current}
            remaining={queue.length}
            draft={draft?.clips[current.id] ?? emptyClipDraft()}
            draftSaveState={saveState}
            onDraftChange={(update) => updateClipDraft(current.id, update)}
            onRetryDraftSave={retry}
            onSubmitted={clearSubmittedDraft}
            onSkip={skipCurrent}
          />
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
