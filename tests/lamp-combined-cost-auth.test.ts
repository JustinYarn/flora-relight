import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_CUT_MAX_OUTPUT_SECONDS,
  estimateLampCombinedPlan,
  estimateLampCombinedTwoPass,
  lampBackgroundPlanReservationUsd,
  lampCombinedPlanReservationUsd,
  lampCombinedTwoPassReservationUsd,
} from "../lib/cost.ts";
import {
  lampCombinedEvaluationOperationId,
  LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
  LAMP_COMBINED_BEAUTIFY_PLAN_OPERATION_ID,
  LAMP_COMBINED_HOLISTIC_EVAL_ID,
  LAMP_COMBINED_IRIS_PLAN_OPERATION_ID,
} from "../lib/lamp-combined-operations.ts";
import type { LampCombinedControls } from "../lib/lamp-combined.ts";
import { lampCombinedLipsyncOperationId } from "../lib/lamp-combined-lipsync.ts";
import { microsToUsd } from "../lib/server/batch-budget.ts";
import {
  assertPaidOperationAuthorized,
  assertVideoGenerationAuthorized,
  createSpendApproval,
  hasReusableLampCombinedPlanApproval,
  hasReusableLampCombinedTwoPassApproval,
  lampCombinedMaximumMicros,
  lampCombinedPlanMaximumMicros,
} from "../lib/server/spend-approval.ts";
import type { ProviderOperation, Run, VideoAsset } from "../lib/types.ts";

const NOW = 1_800_100_000_000;
const OFF_CONTROLS: LampCombinedControls = {
  beautifyLevel: 0,
  cleanlinessLevel: 2,
  eyeContact: false,
};
const ALL_CONTROLS: LampCombinedControls = {
  beautifyLevel: 2,
  cleanlinessLevel: 3,
  eyeContact: true,
};

function video(runId = "run_combined_cost"): VideoAsset {
  return {
    id: `video_${runId}`,
    runId,
    kind: "original",
    url: `/api/media/${runId}/source.mp4`,
    label: "Combined cost fixture",
    durationSec: 8,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
}

function run(
  source: VideoAsset,
  controls: LampCombinedControls,
  approval: Run["spendApproval"],
  providerOperations?: ProviderOperation[]
): Run {
  return {
    id: source.runId!,
    workflowId: "lamp-combined-v1",
    workflowMode: "combined",
    combinedControls: controls,
    relightIntensity: 75,
    createdAt: NOW,
    originalVideo: source,
    status: "running",
    spendApproval: approval,
    ...(providerOperations ? { providerOperations } : {}),
    iterations: [],
    nodeStates: {},
    log: [],
  };
}

test("Combined planner estimates and authorization include only enabled planner calls", () => {
  const offEstimate = estimateLampCombinedPlan(OFF_CONTROLS);
  const allEstimate = estimateLampCombinedPlan(ALL_CONTROLS);
  assert.equal(offEstimate.items.length, 2);
  assert.equal(allEstimate.items.length, 6);
  assert.equal(
    lampCombinedPlanReservationUsd(OFF_CONTROLS),
    lampBackgroundPlanReservationUsd()
  );
  assert.equal(
    lampCombinedPlanReservationUsd(ALL_CONTROLS),
    lampBackgroundPlanReservationUsd() * 3
  );

  const source = video();
  const approval = createSpendApproval(
    source,
    "single",
    undefined,
    NOW,
    "combined_plan",
    OFF_CONTROLS
  );
  const fixture = run(source, OFF_CONTROLS, approval);
  assert.deepEqual(approval.combinedControls, OFF_CONTROLS);
  assert.equal(approval.maxIterations, 0);
  assert.equal(
    approval.maxUsd,
    microsToUsd(lampCombinedPlanMaximumMicros(OFF_CONTROLS))
  );
  assert.equal(
    hasReusableLampCombinedPlanApproval(fixture, "single", undefined, NOW + 1),
    true
  );
  assert.doesNotThrow(() =>
    assertPaidOperationAuthorized(
      fixture,
      "plan",
      undefined,
      undefined,
      LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
      NOW + 1
    )
  );
  for (const disabledOperationId of [
    LAMP_COMBINED_BEAUTIFY_PLAN_OPERATION_ID,
    LAMP_COMBINED_IRIS_PLAN_OPERATION_ID,
  ]) {
    assert.throws(
      () =>
        assertPaidOperationAuthorized(
          fixture,
          "plan",
          undefined,
          undefined,
          disabledOperationId,
          NOW + 1
        ),
      /exactly the enabled planner operations/
    );
  }
  assert.throws(
    () => assertVideoGenerationAuthorized(fixture, 1, NOW + 1),
    /zero video generation attempts/
  );
});

test("Combined planner approval fails closed when persisted controls are tampered", () => {
  const source = video("run_combined_tamper");
  const approval = createSpendApproval(
    source,
    "single",
    undefined,
    NOW,
    "combined_plan",
    OFF_CONTROLS
  );
  const tampered = run(source, { ...OFF_CONTROLS, eyeContact: true }, approval);
  assert.equal(
    hasReusableLampCombinedPlanApproval(tampered, "single", undefined, NOW + 1),
    false
  );
  assert.throws(
    () =>
      assertPaidOperationAuthorized(
        tampered,
        "plan",
        undefined,
        undefined,
        LAMP_COMBINED_IRIS_PLAN_OPERATION_ID,
        NOW + 1
      ),
    /Live spend approval is invalid/
  );
});

test("Combined approvals cannot authorize work for another workflow mode", () => {
  const source = video("run_combined_wrong_mode");
  const approval = createSpendApproval(
    source,
    "single",
    undefined,
    NOW,
    "combined_plan",
    OFF_CONTROLS
  );
  const wrongMode = {
    ...run(source, OFF_CONTROLS, approval),
    workflowMode: "background" as const,
  };
  assert.equal(
    hasReusableLampCombinedPlanApproval(
      wrongMode,
      "single",
      undefined,
      NOW + 1
    ),
    false
  );
  assert.throws(
    () =>
      assertPaidOperationAuthorized(
        wrongMode,
        "plan",
        undefined,
        undefined,
        LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
        NOW + 1
      ),
    /Live spend approval is invalid/
  );
});

test("Combined two-pass reserves two generations, two mandatory normalizations, and two evals", () => {
  const source = video("run_combined_two_pass");
  const estimate = estimateLampCombinedTwoPass(source.durationSec);
  const approval = createSpendApproval(
    source,
    "single",
    undefined,
    NOW,
    "combined_two_pass",
    ALL_CONTROLS
  );
  const completedInitial: ProviderOperation = {
    id: "video-generation:1",
    provider: "gemini",
    kind: "video_generation",
    iteration: 1,
    providerInteractionId: "interaction_combined_initial",
    status: "completed",
    startedAt: NOW,
    updatedAt: NOW,
  };
  const fixture = run(source, ALL_CONTROLS, approval, [completedInitial]);
  assert.equal(estimate.items.length, 6);
  const lipsync = estimate.items.find((item) => item.provider === "replicate");
  assert.equal(lipsync?.units, source.durationSec * 2);
  assert.match(lipsync?.label ?? "", /Two mandatory/);
  assert.ok(
    lampCombinedTwoPassReservationUsd(FIRST_CUT_MAX_OUTPUT_SECONDS) >
      estimate.totalUsd
  );
  assert.equal(approval.maxUsd, microsToUsd(lampCombinedMaximumMicros()));
  assert.equal(
    hasReusableLampCombinedTwoPassApproval(
      fixture,
      "single",
      undefined,
      NOW + 1
    ),
    true
  );
  for (const iteration of [1, 2] as const) {
    assert.doesNotThrow(() =>
      assertPaidOperationAuthorized(
        fixture,
        "judge",
        iteration,
        LAMP_COMBINED_HOLISTIC_EVAL_ID,
        lampCombinedEvaluationOperationId(iteration),
        NOW + 1
      )
    );
  }
  for (const iteration of [1, 2] as const) {
    assert.doesNotThrow(() =>
      assertPaidOperationAuthorized(
        fixture,
        "lipsync",
        iteration,
        undefined,
        lampCombinedLipsyncOperationId(iteration),
        NOW + 1
      )
    );
  }
  assert.throws(
    () =>
      assertPaidOperationAuthorized(
        fixture,
        "plan",
        undefined,
        undefined,
        LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
        NOW + 1
      ),
    /planning requires a separate approval/
  );
  assert.doesNotThrow(() => assertVideoGenerationAuthorized(fixture, 1, NOW + 1));
  assert.doesNotThrow(() => assertVideoGenerationAuthorized(fixture, 2, NOW + 1));
  assert.throws(
    () => assertVideoGenerationAuthorized(fixture, 3, NOW + 1),
    /exactly two video generation attempts/
  );
});
