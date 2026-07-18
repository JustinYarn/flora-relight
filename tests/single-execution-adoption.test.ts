import assert from "node:assert/strict";
import test from "node:test";

import { needsSingleExecutionAdoption } from "../lib/single-execution-adoption.ts";
import type { Run } from "../lib/types.ts";

function fixture(mode: "background" | "beautify" | "iris"): Run {
  const plan = {
    runId: `run-${mode}`,
    decision: "exceptional-no-op",
    approval: {
      status: "approved",
      approvedAt: 2,
      approvedBy: "human",
    },
  };
  return {
    id: `run-${mode}`,
    workflowId: `lamp-${mode}-v1`,
    workflowMode: mode,
    createdAt: 1,
    originalVideo: {} as never,
    status: "awaiting-review",
    iterations: [],
    nodeStates: {},
    log: [],
    spendApproval: {
      source: "single",
    } as never,
    ...(mode === "background"
      ? { backgroundCleanupPlan: plan as never }
      : mode === "beautify"
        ? { beautifyPlan: plan as never }
        : { irisPlan: plan as never }),
  } as Run;
}

test("draft and no-op plans never trigger durable recovery adoption", () => {
  for (const mode of ["background", "beautify", "iris"] as const) {
    const noOp = fixture(mode);
    assert.equal(needsSingleExecutionAdoption(noOp), false);

    const draft = structuredClone(noOp) as Run;
    const plan =
      mode === "background"
        ? draft.backgroundCleanupPlan
        : mode === "beautify"
          ? draft.beautifyPlan
          : draft.irisPlan;
    if (!plan) throw new Error("fixture plan missing");
    plan.approval = { status: "draft" };
    assert.equal(needsSingleExecutionAdoption(draft), false);
  }
});

test("approved generation plans remain eligible for durable adoption", () => {
  for (const mode of ["background", "beautify", "iris"] as const) {
    const run = fixture(mode);
    const plan =
      mode === "background"
        ? run.backgroundCleanupPlan
        : mode === "beautify"
          ? run.beautifyPlan
          : run.irisPlan;
    if (!plan) throw new Error("fixture plan missing");
    plan.decision =
      mode === "background" ? "cleanup" : mode === "beautify" ? "enhance" : "correct";
    assert.equal(needsSingleExecutionAdoption(run), true);
  }
});
