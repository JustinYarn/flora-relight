import assert from "node:assert/strict";
import test from "node:test";

import {
  isGradeable,
  needsLampHumanGrade,
} from "../components/grade/derive.ts";
import type { Run, WorkflowMode } from "../lib/types.ts";

type PlanMode = Extract<WorkflowMode, "background" | "beautify" | "iris">;

function noOpRun(
  mode: PlanMode,
  status: Run["status"],
  graded: boolean
): Run {
  const id = `run-${mode}-no-op`;
  const source = {
    id: `source-${mode}`,
    runId: id,
    kind: "original" as const,
    url: `/source/${mode}.mp4`,
    label: `${mode}.mp4`,
    durationSec: 8,
    width: 1280,
    height: 720,
    hasAudio: true,
  };
  const delivered = {
    ...source,
    id: `delivered-${mode}`,
    kind: "final" as const,
  };
  const approval = {
    status: "approved" as const,
    approvedAt: 2,
    approvedBy: "human" as const,
  };
  const plan = {
    runId: id,
    decision: "exceptional-no-op" as const,
    approval,
  };
  return {
    id,
    workflowMode: mode,
    workflowId: `lamp-${mode}-v1`,
    createdAt: 1,
    originalVideo: source,
    finalVideo: delivered,
    status,
    iterations: [
      {
        index: 2,
        megaPrompt: {} as never,
        generatedVideo: delivered,
        beforeFrames: [],
        afterFrames: [],
        evalResults: [],
        status: "ungraded",
      },
    ],
    nodeStates: {},
    log: [],
    ...(mode === "background"
      ? { backgroundCleanupPlan: plan as never }
      : mode === "beautify"
        ? { beautifyPlan: plan as never }
        : { irisPlan: plan as never }),
    ...(graded
      ? {
          humanGrade: {
            gradedAt: 3,
            scores: {},
            shipIt: status === "approved",
          },
        }
      : {}),
  };
}

test("all approved plan no-ops enter Grade and remain in Results after grading", () => {
  for (const mode of ["background", "beautify", "iris"] as const) {
    const awaiting = noOpRun(mode, "awaiting-review", false);
    assert.equal(isGradeable(awaiting), true, `${mode} should enter Grade`);
    assert.equal(needsLampHumanGrade(awaiting), true);

    for (const status of ["approved", "needs-changes"] as const) {
      const graded = noOpRun(mode, status, true);
      assert.equal(
        isGradeable(graded),
        true,
        `${mode} ${status} no-op should remain in Results`
      );
      assert.equal(needsLampHumanGrade(graded), false);
    }
  }
});

test("plan no-op grading still requires the exact source delivery", () => {
  const run = noOpRun("iris", "awaiting-review", false);
  const changed = {
    ...run,
    finalVideo: {
      ...run.finalVideo!,
      url: "/generated/not-the-source.mp4",
    },
  };
  assert.equal(isGradeable(changed), false);
});
