import type { HumanCheckGrade, HumanGrade } from "@/lib/types";

export const MAX_GRADE_NOTE_LENGTH = 4_000;
export const MAX_GRADE_OVERALL_NOTE_LENGTH = 8_000;

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

function hasExactKeys(value: Record<string, unknown>, ids: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === ids.length && ids.every((id) => id in value);
}

/**
 * Validate a final grade against its server-selected workflow scope. A Lamp
 * request from an already-open pre-deploy tab may still contain Flora's full
 * legacy key set; those answers are validated, then the retired extras are
 * discarded so every newly persisted Lamp grade has the current nine rows.
 */
export function parseHumanGrade(input: {
  value: unknown;
  requiredEvalIds: readonly string[];
  acceptedLegacyEvalIds?: readonly string[];
}): HumanGrade | null {
  const value = input.value;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.gradedAt) ||
    (value.gradedAt as number) < 0 ||
    typeof value.shipIt !== "boolean" ||
    !isRecord(value.scores) ||
    (value.overallNote !== undefined &&
      (typeof value.overallNote !== "string" ||
        value.overallNote.length > MAX_GRADE_OVERALL_NOTE_LENGTH))
  ) {
    return null;
  }

  const submittedEvalIds = hasExactKeys(value.scores, input.requiredEvalIds)
    ? input.requiredEvalIds
    : input.acceptedLegacyEvalIds &&
        hasExactKeys(value.scores, input.acceptedLegacyEvalIds)
      ? input.acceptedLegacyEvalIds
      : null;
  if (!submittedEvalIds) return null;

  const validated: Record<string, HumanCheckGrade> = {};
  for (const evalId of submittedEvalIds) {
    const candidate = value.scores[evalId];
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
    validated[evalId] = {
      points: points as HumanCheckGrade["points"],
      ...canonical,
      ...(typeof candidate.note === "string" && candidate.note.length > 0
        ? { note: candidate.note }
        : {}),
    };
  }

  const scores: Record<string, HumanCheckGrade> = {};
  for (const evalId of input.requiredEvalIds) {
    const grade = validated[evalId];
    if (!grade) return null;
    scores[evalId] = grade;
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
