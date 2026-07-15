/**
 * Pure read-model helpers for /grade: the 5-point human scale, the grading
 * queue, and the human-vs-AI agreement math. No React, no store — everything
 * here is a plain function over persisted Runs so both modes of the Grade
 * page (and any future export) compute identical numbers.
 *
 * The AI side of every Lamp comparison is v2's evalResults. The grader shows
 * the delivered final video, so the human and AI compare the same cut.
 */

import type {
  EvalResult,
  HumanCheckGrade,
  Iteration,
  Run,
  Verdict,
  VideoAsset,
} from "@/lib/types";
import {
  EVAL_DEFS,
  humanGradeEvalDefsForMode,
} from "../../lib/prompts/eval-defs.ts";
import {
  lampCompositeForResults,
  LAMP_UNAVAILABLE_EVAL_IDS,
} from "../../lib/lamp-evaluation.ts";

// ---------------------------------------------------------------------------
// The 5-point scale
// ---------------------------------------------------------------------------

export interface ScalePoint {
  points: HumanCheckGrade["points"];
  label: string;
  /** Mapped onto the evals' 0–100 scale so human and AI scores subtract cleanly. */
  score: number;
  verdict: Verdict;
}

/** Best → worst, rendered left to right as one row of five buttons. */
export const SCALE: ScalePoint[] = [
  { points: 5, label: "perfect", score: 95, verdict: "pass" },
  { points: 4, label: "minor issues", score: 85, verdict: "pass" },
  { points: 3, label: "noticeable", score: 72, verdict: "borderline" },
  { points: 2, label: "clear problems", score: 55, verdict: "fail" },
  { points: 1, label: "badly wrong", score: 30, verdict: "fail" },
];

export function scalePoint(points: HumanCheckGrade["points"]): ScalePoint {
  const p = SCALE.find((s) => s.points === points);
  if (!p) throw new Error(`Unknown scale point ${points}`);
  return p;
}

/** Plain-English rendering of a human verdict ("what you said"). */
export function humanVerdictWord(points: HumanCheckGrade["points"]): string {
  return scalePoint(points).label;
}

// ---------------------------------------------------------------------------
// The grading queue
// ---------------------------------------------------------------------------

/**
 * A run belongs on the Grade page when it produced a REAL relit cut — a
 * shipped video that exists and is not a mock/simulated CSS-filter stand-in.
 */
export function isGradeable(run: Run): boolean {
  const v = finalLampVideo(run);
  const serverVerifiedArtifact =
    finalLampIteration(run)?.recoveredFromProviderOperation === true;
  return (
    (!run.serverExecution || run.serverExecution.status === "awaiting_review") &&
    serverVerifiedArtifact &&
    v !== undefined &&
    !v.simulatedFilter
  );
}

export function isLampRun(run: Run): boolean {
  return (
    run.workflowMode === "lamp" ||
    run.workflowId === "lamp-v1" ||
    run.serverExecution?.executionId.startsWith("lamp:") === true
  );
}

export function humanGradeEvalDefsForRun(run: Run) {
  return humanGradeEvalDefsForMode(isLampRun(run) ? "lamp" : "flora");
}

/** Lamp's human grade and comparison target is strictly v2. */
export function finalLampIteration(run: Run): Iteration | undefined {
  const second = run.iterations.find((iteration) => iteration.index === 2);
  if (isLampRun(run)) return second;
  // Legacy Flora records keep their historical fallback behavior.
  return second ?? run.iterations.at(-1);
}

/** The delivered remux when present, otherwise Lamp's generated v2 artifact. */
export function finalLampVideo(run: Run): VideoAsset | undefined {
  return run.finalVideo ?? finalLampIteration(run)?.generatedVideo;
}

/** Canonical blind lock: presentation status is browser-writable; execution is not. */
export function isLampBlindGradeLocked(run: Run): boolean {
  return (
    run.serverExecution?.executionId.startsWith("lamp:") === true &&
    run.serverExecution.status === "awaiting_review" &&
    run.humanGrade === undefined
  );
}

// ---------------------------------------------------------------------------
// Human vs AI comparison
// ---------------------------------------------------------------------------

/** One human-vs-AI pairing on one check of one graded run. */
export interface CheckComparison {
  run: Run;
  evalId: string;
  human: HumanCheckGrade;
  ai: EvalResult;
}

/**
 * Every check of every graded run where BOTH sides exist: the human graded it
 * and the final v2 carries an AI result for it. Runs that crashed
 * mid-judging simply contribute fewer pairs.
 */
export function collectComparisons(gradedRuns: Run[]): CheckComparison[] {
  const out: CheckComparison[] = [];
  for (const run of gradedRuns) {
    const aiResults = finalLampIteration(run)?.evalResults ?? [];
    for (const def of humanGradeEvalDefsForRun(run)) {
      if (
        isLampRun(run) &&
        LAMP_UNAVAILABLE_EVAL_IDS.includes(
          def.id as (typeof LAMP_UNAVAILABLE_EVAL_IDS)[number]
        )
      ) {
        continue;
      }
      const human = run.humanGrade?.scores[def.id];
      const ai = aiResults.find((r) => r.evalId === def.id);
      if (human && ai) out.push({ run, evalId: def.id, human, ai });
    }
  }
  return out;
}

const VERDICT_RANK: Record<Verdict, number> = { pass: 2, borderline: 1, fail: 0 };

/**
 * Verdict-level agreement: 1 = same verdict, 0.5 = one step apart
 * (pass↔borderline or borderline↔fail), 0 = hard disagreement (pass↔fail).
 */
export function verdictAgreement(a: Verdict, b: Verdict): number {
  const gap = Math.abs(VERDICT_RANK[a] - VERDICT_RANK[b]);
  return gap === 0 ? 1 : gap === 1 ? 0.5 : 0;
}

export type Direction = "AI is harsher" | "You are harsher" | "aligned";

export interface CheckStats {
  evalId: string;
  /** How many graded runs had an AI result for this check. */
  compared: number;
  /** Mean verdict agreement, 0–100. */
  agreementPct: number;
  /** mean(human score − AI score); negative = you score it lower (you're harsher). */
  meanScoreGap: number;
  direction: Direction;
}

/** Per-check aggregate over the supplied mode-specific definitions. */
export function perCheckStats(
  comps: CheckComparison[],
  definitions = EVAL_DEFS
): CheckStats[] {
  return definitions.map((def) => {
    const mine = comps.filter((c) => c.evalId === def.id);
    if (mine.length === 0) {
      return {
        evalId: def.id,
        compared: 0,
        agreementPct: 0,
        meanScoreGap: 0,
        direction: "aligned" as const,
      };
    }
    const agreement =
      mine.reduce(
        (sum, c) => sum + verdictAgreement(c.human.verdict, c.ai.verdict),
        0
      ) / mine.length;
    const gap =
      mine.reduce((sum, c) => sum + (c.human.score - c.ai.score), 0) /
      mine.length;
    // Harshness: who hands out the worse verdict more often?
    let aiHarsher = 0;
    let humanHarsher = 0;
    for (const c of mine) {
      const d = VERDICT_RANK[c.ai.verdict] - VERDICT_RANK[c.human.verdict];
      if (d < 0) aiHarsher += 1;
      else if (d > 0) humanHarsher += 1;
    }
    const direction: Direction =
      aiHarsher > humanHarsher
        ? "AI is harsher"
        : humanHarsher > aiHarsher
          ? "You are harsher"
          : "aligned";
    return {
      evalId: def.id,
      compared: mine.length,
      agreementPct: agreement * 100,
      meanScoreGap: gap,
      direction,
    };
  });
}

/** Overall verdict-level agreement across every compared pair, 0–100. */
export function overallAgreementPct(comps: CheckComparison[]): number | undefined {
  if (comps.length === 0) return undefined;
  return (
    (comps.reduce(
      (sum, c) => sum + verdictAgreement(c.human.verdict, c.ai.verdict),
      0
    ) /
      comps.length) *
    100
  );
}

/**
 * The check you and the AI diverge on most: lowest agreement among checks
 * with data (ties broken by the larger absolute score gap).
 */
export function biggestDivergence(stats: CheckStats[]): CheckStats | undefined {
  const withData = stats.filter((s) => s.compared > 0);
  if (withData.length === 0) return undefined;
  return [...withData].sort(
    (a, b) =>
      a.agreementPct - b.agreementPct ||
      Math.abs(b.meanScoreGap) - Math.abs(a.meanScoreGap)
  )[0];
}

export interface Disagreement extends CheckComparison {
  /**
   * Calibration weight: |human − AI| × AI confidence. A confident AI that a
   * human numerically contradicts is the juiciest rubric-fix signal.
   */
  weight: number;
}

/**
 * The biggest disagreements: every pair whose VERDICTS differ, ranked by
 * score-gap × AI-confidence descending, capped for the UI.
 */
export function biggestDisagreements(
  comps: CheckComparison[],
  cap = 20
): Disagreement[] {
  return comps
    .filter((c) => c.human.verdict !== c.ai.verdict)
    .map((c) => ({
      ...c,
      weight: Math.abs(c.human.score - c.ai.score) * c.ai.confidence,
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, cap);
}

// ---------------------------------------------------------------------------
// Clip-level rates
// ---------------------------------------------------------------------------

/** % of graded runs the human would ship (shipIt). */
export function shipRatePct(gradedRuns: Run[]): number | undefined {
  if (gradedRuns.length === 0) return undefined;
  const yes = gradedRuns.filter((r) => r.humanGrade?.shipIt).length;
  return (yes / gradedRuns.length) * 100;
}

/** % of graded runs whose complete final v2 evaluation passed every applicable gate. */
export function aiPassRatePct(gradedRuns: Run[]): number | undefined {
  const scored = gradedRuns
    .map((run) => {
      const final = finalLampIteration(run);
      return lampCompositeForResults(final?.evalResults ?? []);
    })
    .filter((composite) => composite !== undefined);
  if (scored.length === 0) return undefined;
  const passed = scored.filter((composite) => composite.passed).length;
  return (passed / scored.length) * 100;
}
