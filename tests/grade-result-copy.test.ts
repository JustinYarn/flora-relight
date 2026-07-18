import assert from "node:assert/strict";
import test from "node:test";

import { combinedWinnerResultCopy } from "../components/grade/result-copy.ts";
import type { Run } from "../lib/types.ts";

function resultRun(
  mode: "lamp" | "combined",
  gradedIteration?: 1 | 2
): Pick<
  Run,
  "workflowId" | "workflowMode" | "serverExecution" | "humanGrade"
> {
  return {
    workflowId: mode === "combined" ? "lamp-combined-v1" : "lamp-v1",
    workflowMode: mode,
    ...(gradedIteration
      ? { humanGrade: { gradedIteration } as Run["humanGrade"] }
      : {}),
  };
}

test("Combined result copy names the exact human-chosen take", () => {
  assert.deepEqual(combinedWinnerResultCopy(resultRun("combined", 1)), {
    summaryLabel: "Chosen Take 1",
    playerLabel: "CHOSEN TAKE 1",
    aiColumnLabel: "chosen take AI",
    reviewLabel: "Review chosen take →",
  });
  assert.equal(
    combinedWinnerResultCopy(resultRun("combined", 2))?.summaryLabel,
    "Chosen Take 2"
  );
});

test("Combined result copy never falls through to Final v2", () => {
  const labels = Object.values(
    combinedWinnerResultCopy(resultRun("combined", 1)) ?? {}
  ).join(" ");
  assert.doesNotMatch(labels, /final|v2/i);
  assert.equal(combinedWinnerResultCopy(resultRun("lamp")), undefined);
});
