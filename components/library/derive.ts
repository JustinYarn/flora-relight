/**
 * Pure read-model helpers for the Library. The "database" is the on-disk run
 * store (data/runs/<id>/run.json) surfaced through the zustand store; these
 * helpers turn one persisted Run into the row-level facts the Library shows.
 * Everything is defensive: salvaged runs (odd iteration numbering like v101),
 * runs with zero iterations, and runs missing relit files must all render.
 */

import type {
  Correction,
  Iteration,
  Run,
  RunStatus,
  Verdict,
  VideoAsset,
} from "@/lib/types";
import { isLampRun } from "@/lib/lamp-evaluation";
import { isLampBackgroundRun } from "@/lib/lamp-background-read";

function isFixedTwoPassRun(run: Run): boolean {
  return isLampRun(run) || isLampBackgroundRun(run);
}

/** Plain-English status meta shared by the Library rows and filter chips. */
export const STATUS_META: Record<RunStatus, { color: string; label: string }> = {
  running: { color: "var(--running)", label: "running" },
  "awaiting-review": { color: "var(--borderline)", label: "needs your review" },
  approved: { color: "var(--pass)", label: "approved" },
  "needs-changes": { color: "var(--fail)", label: "needs changes" },
  failed: { color: "var(--fail)", label: "failed" },
};

/**
 * Lamp always resolves v2 as Final. Legacy runs still resolve their historical
 * bestIterationIndex against Iteration.index (1-based), tolerate arbitrary
 * salvaged version numbers, and fall back to array position then newest.
 */
export function shippedIteration(run: Run): Iteration | undefined {
  const last = run.iterations[run.iterations.length - 1];
  if (isFixedTwoPassRun(run)) {
    return run.iterations.find((iteration) => iteration.index === 2) ?? last;
  }
  const bi = run.bestIterationIndex;
  if (bi === undefined) return last;
  return run.iterations.find((it) => it.index === bi) ?? run.iterations[bi] ?? last;
}

/** The cut to show as "after": Lamp Final or the legacy run's shipped generation. */
export function shippedVideo(run: Run): VideoAsset | undefined {
  return run.finalVideo ?? shippedIteration(run)?.generatedVideo;
}

/**
 * Overall score of Lamp Final or the legacy shipped cut. Prefers that composite;
 * if that attempt never got scored (crashed mid-judging), walks back to the
 * newest attempt that did.
 */
export function shippedComposite(
  run: Run
): { score: number; passed: boolean } | undefined {
  const it = shippedIteration(run);
  if (isFixedTwoPassRun(run)) return it?.composite;
  if (it?.composite) return it.composite;
  for (let i = run.iterations.length - 1; i >= 0; i -= 1) {
    const c = run.iterations[i]?.composite;
    if (c) return c;
  }
  return undefined;
}

/** Composite → verdict color: passed, or cleared the bar but a must-pass check failed. */
export function compositeVerdict(
  composite: { score: number; passed: boolean },
  passThreshold: number
): Verdict {
  if (composite.passed) return "pass";
  return composite.score >= passThreshold ? "borderline" : "fail";
}

/**
 * The fix list that drove the final attempt: corrections still active (not
 * resolved) in the last attempt's generation brief.
 */
export function activeFixes(run: Run): Correction[] {
  const last = run.iterations[run.iterations.length - 1];
  const corrections = last?.megaPrompt?.corrections;
  if (!corrections) return [];
  return corrections.filter((c) => !c.resolved);
}

/** "Jul 11, 2:52 PM" — compact date+time for row metadata. */
export function formatRunDate(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
