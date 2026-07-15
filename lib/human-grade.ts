import type {
  HumanCheckGrade,
  HumanGrade,
  WorkflowMode,
} from "./types.ts";
import { humanGradeEvalDefsForMode } from "./prompts/eval-defs.ts";

const MAX_GRADE_NOTE_LENGTH = 4_000;
const MAX_GRADE_OVERALL_NOTE_LENGTH = 8_000;

const HUMAN_GRADE_SCALE: Record<
  HumanCheckGrade["points"],
  Pick<HumanCheckGrade, "score" | "verdict">
> = {
  1: { score: 30, verdict: "fail" },
  2: { score: 55, verdict: "fail" },
  3: { score: 72, verdict: "borderline" },
  4: { score: 85, verdict: "pass" },
  5: { score: 95, verdict: "pass" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an exact, mode-specific final human grade. */
export function parseHumanGrade(
  value: unknown,
  workflowMode: WorkflowMode
): HumanGrade | null {
  const definitions = humanGradeEvalDefsForMode(workflowMode);
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.gradedAt) ||
    (value.gradedAt as number) < 0 ||
    typeof value.shipIt !== "boolean" ||
    !isRecord(value.scores) ||
    Object.keys(value.scores).length !== definitions.length ||
    (value.overallNote !== undefined &&
      (typeof value.overallNote !== "string" ||
        value.overallNote.length > MAX_GRADE_OVERALL_NOTE_LENGTH))
  ) {
    return null;
  }

  const scores: Record<string, HumanCheckGrade> = {};
  for (const definition of definitions) {
    const candidate = value.scores[definition.id];
    if (!isRecord(candidate)) return null;
    const points = candidate.points;
    if (
      !Number.isInteger(points) ||
      (points as number) < 1 ||
      (points as number) > 5
    ) {
      return null;
    }
    const canonical = HUMAN_GRADE_SCALE[points as HumanCheckGrade["points"]];
    if (
      candidate.score !== canonical.score ||
      candidate.verdict !== canonical.verdict ||
      (candidate.note !== undefined &&
        (typeof candidate.note !== "string" ||
          candidate.note.length > MAX_GRADE_NOTE_LENGTH))
    ) {
      return null;
    }
    scores[definition.id] = {
      points: points as HumanCheckGrade["points"],
      ...canonical,
      ...(typeof candidate.note === "string" && candidate.note.length > 0
        ? { note: candidate.note }
        : {}),
    };
  }

  return {
    gradedAt: value.gradedAt as number,
    scores,
    shipIt: value.shipIt,
    ...(typeof value.overallNote === "string" && value.overallNote.length > 0
      ? { overallNote: value.overallNote }
      : {}),
  };
}
