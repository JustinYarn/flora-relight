"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/lib/store";
import { EmptyState } from "@/components/ui";
import { isGradeable } from "@/components/grade/derive";
import { ClipGrader } from "@/components/grade/ClipGrader";
import { ResultsView } from "@/components/grade/ResultsView";

/*
 * /grade — grade the before/after cuts yourself, blind, on the same 11
 * checks the AI judges used; then flip to "Compare with AI" to see where
 * your judgement and the judges diverge. Two modes on one page:
 *
 *   Grade clips      — BLIND by design: the AI's scores/verdicts are never
 *                      shown here, so nothing anchors your read of a clip.
 *   Compare with AI  — agreement stats, per-check score gaps, and the
 *                      highest-signal disagreements for rubric calibration.
 *
 * Data comes straight from the store (persistence hydration pulls
 * data/runs/ on boot); grades write back through setHumanGrade and ride the
 * normal run sync into run.json.
 */

type Mode = "grade" | "results";

/** Pinned segmented control — same visual contract as RunTabs, buttons not links. */
function ModeTabs({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  const cls = (m: Mode) =>
    `rounded-md px-3 py-1 text-sm transition ${
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
        Compare with AI
      </button>
    </nav>
  );
}

export function GradeView() {
  const runs = useAppStore((s) => s.runs);
  const hydrated = useAppStore((s) => s.hydrated);
  const [mode, setMode] = useState<Mode>("grade");
  /** Clips skipped this session — they drop to the back of the queue. */
  const [skipped, setSkipped] = useState<string[]>([]);

  const gradeable = useMemo(
    () => runs.filter(isGradeable).sort((a, b) => b.createdAt - a.createdAt),
    [runs]
  );
  const graded = useMemo(
    () => gradeable.filter((r) => r.humanGrade),
    [gradeable]
  );
  const queue = useMemo(() => {
    const ungraded = gradeable.filter((r) => !r.humanGrade);
    // Skipped clips come back at the end, in the order they were skipped.
    return [
      ...ungraded.filter((r) => !skipped.includes(r.id)),
      ...skipped
        .map((id) => ungraded.find((r) => r.id === id))
        .filter((r): r is (typeof ungraded)[number] => r !== undefined),
    ];
  }, [gradeable, skipped]);
  const current = queue[0];

  return (
    <main className="mx-auto max-w-5xl px-6 pb-16 pt-8">
      <header className="flex flex-wrap items-center gap-3 pb-5">
        <h1 className="text-base font-semibold text-ink">Grade</h1>
        <p className="text-2xs text-faint">
          {mode === "grade"
            ? "your eyes on the same 11 checks — the AI's verdicts stay hidden until you compare"
            : "where your judgement and the AI judges line up — and where they don't"}
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

      {!hydrated ? (
        <p className="py-10 text-center text-2xs text-faint">loading runs…</p>
      ) : mode === "grade" ? (
        gradeable.length === 0 ? (
          <EmptyState
            title="Nothing to grade yet"
            hint="Finish some runs first — once a clip has a real relit cut, it lands here for blind grading."
            action={
              <Link
                href="/"
                className="mt-1 rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition hover:border-faint"
              >
                Go to Studio
              </Link>
            }
          />
        ) : current ? (
          <ClipGrader
            key={current.id}
            run={current}
            remaining={queue.length}
            onSkip={() =>
              setSkipped((cur) => [
                ...cur.filter((id) => id !== current.id),
                current.id,
              ])
            }
          />
        ) : (
          <EmptyState
            title="All clips graded"
            hint={`You graded every clip with a real relit cut (${graded.length} of ${gradeable.length}). See how your calls stack up against the AI's.`}
            action={
              <button
                onClick={() => setMode("results")}
                className="mt-1 rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition hover:border-faint"
              >
                Compare with AI
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
              className="mt-1 rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition hover:border-faint"
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
