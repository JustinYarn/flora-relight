import type {
  EvalDefinition,
  GradeClipDraft,
  HumanCheckGrade,
  Verdict,
} from "./types.ts";

/**
 * Slider work lives in a separate revisioned draft document. It never writes
 * Run.humanGrade, so trying the experiment cannot replace a canonical grade.
 */
export const LAMP_SLIDER_DRAFT_ID = "lamp-slider-calibration-v1";

export const SLIDER_SCORE_MIN = 0;
export const SLIDER_SCORE_MAX = 100;

export function isSliderScore(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= SLIDER_SCORE_MIN &&
    (value as number) <= SLIDER_SCORE_MAX
  );
}

/** Audio verification is binary; intermediate values would invent precision. */
export function isSliderScoreForEval(
  evalId: string,
  value: unknown
): value is number {
  return (
    isSliderScore(value) &&
    (evalId !== "audio-integrity" || value === 0 || value === 100)
  );
}

/**
 * Grade drafts still carry the legacy point field for schema compatibility.
 * Slider comparisons use numericScore directly; this bucket is not the result.
 *
 * The bands preserve every existing anchor exactly:
 * 30→1, 55→2, 72→3, 85→4, 95→5.
 */
export function pointsForSliderScore(
  score: number
): HumanCheckGrade["points"] {
  if (!isSliderScore(score)) {
    throw new Error(`Slider score must be an integer from 0 to 100: ${score}`);
  }
  if (score >= 95) return 5;
  if (score >= 80) return 4;
  if (score >= 65) return 3;
  if (score >= 40) return 2;
  return 1;
}

/** Compare human and AI scores under the exact threshold of this rubric row. */
export function verdictForSliderScore(
  score: number,
  definition: Pick<
    EvalDefinition,
    "passThreshold" | "borderlineThreshold"
  >
): Verdict {
  if (!isSliderScore(score)) {
    throw new Error(`Slider score must be an integer from 0 to 100: ${score}`);
  }
  if (score >= definition.passThreshold) return "pass";
  if (score >= definition.borderlineThreshold) return "borderline";
  return "fail";
}

export function numericScoreForAnswer(
  answer: GradeClipDraft["answers"][string] | undefined
): number | undefined {
  return isSliderScore(answer?.numericScore)
    ? answer.numericScore
    : undefined;
}

export function isSliderClipComplete(
  clip: GradeClipDraft | undefined,
  evalIds: readonly string[]
): boolean {
  return evalIds.every(
    (evalId) =>
      isSliderScoreForEval(
        evalId,
        numericScoreForAnswer(clip?.answers[evalId])
      )
  );
}
