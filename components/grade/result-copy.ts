import type { Run } from "../../lib/types.ts";
import { isLampCombinedRun } from "../../lib/lamp-combined-read.ts";

type ResultRunIdentity = Pick<
  Run,
  "workflowId" | "workflowMode" | "serverExecution" | "humanGrade"
>;

export interface CombinedWinnerResultCopy {
  summaryLabel: string;
  playerLabel: string;
  aiColumnLabel: string;
  reviewLabel: string;
}

/**
 * Combined has no server- or AI-selected Final. Once a blind human grade
 * chooses a candidate, every result label must stay bound to that exact take.
 */
export function combinedWinnerResultCopy(
  run: ResultRunIdentity,
  deliveredIteration?: number
): CombinedWinnerResultCopy | undefined {
  if (!isLampCombinedRun(run)) return undefined;

  const candidate = deliveredIteration ?? run.humanGrade?.gradedIteration;
  const take = candidate === 1 || candidate === 2 ? String(candidate) : "—";
  return {
    summaryLabel: `Chosen Take ${take}`,
    playerLabel: `CHOSEN TAKE ${take}`,
    aiColumnLabel: "chosen take AI",
    reviewLabel: "Review chosen take →",
  };
}
