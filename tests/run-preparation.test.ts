import assert from "node:assert/strict";
import test from "node:test";

import {
  isPristinePreparedRun,
  prepareRunForConfirmation,
} from "../lib/run-preparation.ts";
import type { Run } from "../lib/types.ts";

function preparedRun(): Run {
  return {
    id: "run-prepare-only",
    workflowId: "lamp-v1",
    workflowMode: "lamp",
    relightIntensity: 75,
    createdAt: 1,
    originalVideo: {} as never,
    status: "running",
    iterations: [],
    nodeStates: {},
    log: [],
  } as Run;
}

test("only an untouched ingest skeleton may be rebound before confirmation", () => {
  assert.equal(isPristinePreparedRun(preparedRun(), null), true);

  const withPlan = preparedRun();
  withPlan.combinedPlan = { approval: { status: "draft" } } as never;
  assert.equal(isPristinePreparedRun(withPlan, null), false);

  const withApproval = preparedRun();
  withApproval.spendApproval = {} as never;
  assert.equal(isPristinePreparedRun(withApproval, null), false);

  const withProviderJournal = preparedRun();
  withProviderJournal.providerOperations = [{} as never];
  assert.equal(isPristinePreparedRun(withProviderJournal, null), false);

  const withHumanDecision = preparedRun();
  withHumanDecision.review = {
    decision: "approved",
    notes: "",
    reviewedAt: 2,
  };
  assert.equal(isPristinePreparedRun(withHumanDecision, null), false);

  assert.equal(isPristinePreparedRun(preparedRun(), {} as never), false);
});

test("no-spend Combined preparation freezes exact controls and no paid state", () => {
  const source = preparedRun();
  const controls = {
    beautifyLevel: 3 as const,
    cleanlinessLevel: 1 as const,
    eyeContact: true,
  };
  const combined = prepareRunForConfirmation(
    source,
    "combined",
    25,
    controls
  );

  assert.equal(combined.workflowId, "lamp-combined-v1");
  assert.equal(combined.workflowMode, "combined");
  assert.equal(combined.relightIntensity, 25);
  assert.deepEqual(combined.combinedControls, controls);
  assert.equal(combined.combinedPlan, undefined);
  assert.equal(combined.spendApproval, undefined);
  assert.equal(combined.serverExecution, undefined);
  assert.equal(combined.providerOperations, undefined);
  assert.equal(combined.iterations.length, 0);
  assert.equal(isPristinePreparedRun(combined, null), true);

  const retry = prepareRunForConfirmation(
    combined,
    "combined",
    25,
    controls
  );
  assert.equal(retry.workflowId, combined.workflowId);
  assert.equal(retry.relightIntensity, combined.relightIntensity);
  assert.deepEqual(retry.combinedControls, combined.combinedControls);
  assert.equal(retry.combinedPlan, undefined);
});

test("all focused modes can be prepared from the same pristine ingest shell", () => {
  for (const mode of ["background", "beautify", "iris"] as const) {
    const prepared = prepareRunForConfirmation(preparedRun(), mode);
    assert.equal(prepared.workflowMode, mode);
    assert.equal(prepared.workflowId, `lamp-${mode}-v1`);
    assert.equal(prepared.relightIntensity, undefined);
    assert.equal(prepared.combinedControls, undefined);
    assert.equal(isPristinePreparedRun(prepared, null), true);
  }
});
