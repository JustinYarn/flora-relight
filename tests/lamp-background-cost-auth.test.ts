import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_CUT_MAX_OUTPUT_SECONDS,
  LAMP_BACKGROUND_EVALUATION_COUNT,
  LAMP_BACKGROUND_GENERATION_COUNT,
  PRICE_TABLE,
  estimateIteration,
  estimateLampBackgroundPlan,
  estimateLampBackgroundTwoPass,
  lampBackgroundPlanReservationUsd,
  lampBackgroundTwoPassReservationUsd,
} from "../lib/cost.ts";
import { FLORA_WORKFLOW } from "../lib/flora-workflow-def.ts";
import {
  LAMP_BACKGROUND_HOLISTIC_EVAL_ID,
  lampBackgroundEvaluationOperationId,
  lampBackgroundPlanOperationId,
} from "../lib/lamp-background-operations.ts";
import { lampEvaluationOperationId } from "../lib/lamp-evaluation.ts";
import {
  batchApprovalScope,
  batchCompletionIteration,
  batchExecutionId,
  batchMaximumIterations,
  batchMemberExecutionId,
  normalizedWorkflowMode,
} from "../lib/server/batch-contract.ts";
import { microsToUsd } from "../lib/server/batch-budget.ts";
import {
  assertPaidOperationAuthorized,
  assertVideoGenerationAuthorized,
  createSpendApproval,
  hasReusableLampApproval,
  hasReusableLampBackgroundPlanApproval,
  hasReusableLampBackgroundTwoPassApproval,
  lampBackgroundMaximumMicros,
  lampBackgroundPlanMaximumMicros,
} from "../lib/server/spend-approval.ts";
import type { ProviderOperation, Run, VideoAsset } from "../lib/types.ts";
import { LIPSYNC_OPERATION_ID } from "../lib/v2-sync.ts";
import {
  isTwoPassExecutionId,
  isTwoPassWorkflowMode,
  workflowModeFromExecutionId,
} from "../lib/workflow-mode.ts";
import { RELIGHT_WORKFLOW } from "../lib/workflow-def.ts";

const NOW = 1_800_000_000_000;

function fixtureVideo(runId = "run_background_cost_fixture"): VideoAsset {
  return {
    id: "video_background_cost_fixture",
    runId,
    kind: "original",
    url: `/api/media/${runId}/source.mp4`,
    label: "Background cleanup fixture",
    durationSec: 7.5,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
}

function fixtureRun(
  video: VideoAsset,
  approval: Run["spendApproval"],
  providerOperations?: ProviderOperation[]
): Run {
  return {
    id: video.runId as string,
    workflowId: "lamp-background-v1",
    workflowMode: "background",
    createdAt: NOW,
    originalVideo: video,
    status: "running",
    spendApproval: approval,
    ...(providerOperations ? { providerOperations } : {}),
    iterations: [],
    nodeStates: {},
    log: [],
  };
}

test("legacy Flora estimates remain bound to Flora after the default workflow changes", () => {
  assert.equal(RELIGHT_WORKFLOW.id, "lamp-background-v1");
  assert.deepEqual(RELIGHT_WORKFLOW.config.judges, ["gemini"]);

  const judgeItems = estimateIteration(5).items.filter(
    (item) => item.provider === "claude" || item.provider === "gemini"
  );
  assert.deepEqual(
    judgeItems.map((item) => item.provider),
    FLORA_WORKFLOW.config.judges
  );
  assert.equal(judgeItems.length, 2);
  assert.ok(judgeItems.every((item) => item.units > 0));
});

test("Lamp Background planning has one conservative Gemini reservation and zero generation rights", () => {
  const video = fixtureVideo();
  const estimate = estimateLampBackgroundPlan();
  const approval = createSpendApproval(
    video,
    "single",
    undefined,
    NOW,
    "background_plan"
  );
  const run = fixtureRun(video, approval);

  assert.equal(estimate.items.length, 2);
  assert.ok(estimate.items.every((item) => item.provider === "gemini"));
  assert.ok(lampBackgroundPlanReservationUsd() > estimate.totalUsd);
  assert.equal(
    lampBackgroundPlanMaximumMicros(),
    Math.round(lampBackgroundPlanReservationUsd() * 1_000_000)
  );
  assert.equal(approval.scope, "background_plan");
  assert.equal(approval.maxIterations, 0);
  assert.equal(
    approval.maxUsd,
    microsToUsd(lampBackgroundPlanMaximumMicros())
  );
  assert.equal(
    hasReusableLampBackgroundPlanApproval(run, "single", undefined, NOW + 1),
    true
  );
  assert.equal(
    hasReusableLampBackgroundTwoPassApproval(
      run,
      "single",
      undefined,
      NOW + 1
    ),
    false
  );
  assert.equal(hasReusableLampApproval(run, "single", undefined, NOW + 1), false);

  assert.doesNotThrow(() =>
    assertPaidOperationAuthorized(
      run,
      "plan",
      undefined,
      undefined,
      lampBackgroundPlanOperationId(),
      NOW + 1
    )
  );
  assert.throws(
    () =>
      assertPaidOperationAuthorized(
        run,
        "plan",
        undefined,
        undefined,
        "plan:lamp-background:second",
        NOW + 1
      ),
    /exactly one cleanup-plan operation/
  );
  assert.throws(
    () =>
      assertPaidOperationAuthorized(
        run,
        "judge",
        1,
        LAMP_BACKGROUND_HOLISTIC_EVAL_ID,
        lampBackgroundEvaluationOperationId(1),
        NOW + 1
      ),
    /exactly one cleanup-plan operation/
  );
  assert.throws(
    () => assertVideoGenerationAuthorized(run, 1, NOW + 1),
    /zero video generation attempts/
  );
});

test("Lamp Background two-pass approval excludes planning and binds exact evaluations, generations, and Final repair", () => {
  const video = fixtureVideo("run_background_two_pass_fixture");
  const estimate = estimateLampBackgroundTwoPass(video.durationSec);
  const approval = createSpendApproval(
    video,
    "single",
    undefined,
    NOW,
    "background_two_pass"
  );
  const completedInitial: ProviderOperation = {
    id: "video-generation:1",
    provider: "gemini",
    kind: "video_generation",
    iteration: 1,
    providerInteractionId: "interaction_background_initial",
    status: "completed",
    startedAt: NOW,
    updatedAt: NOW,
  };
  const run = fixtureRun(video, approval, [completedInitial]);

  assert.equal(LAMP_BACKGROUND_GENERATION_COUNT, 2);
  assert.equal(LAMP_BACKGROUND_EVALUATION_COUNT, 2);
  assert.equal(estimate.items.length, 6);
  assert.equal(
    estimate.items.some((item) => /plan/i.test(item.label)),
    false
  );
  assert.ok(
    lampBackgroundTwoPassReservationUsd(FIRST_CUT_MAX_OUTPUT_SECONDS) >
      estimate.totalUsd
  );
  assert.equal(approval.scope, "background_two_pass");
  assert.equal(approval.maxIterations, 2);
  assert.equal(
    approval.maxUsd,
    microsToUsd(lampBackgroundMaximumMicros())
  );
  assert.equal(
    hasReusableLampBackgroundTwoPassApproval(
      run,
      "single",
      undefined,
      NOW + 1
    ),
    true
  );
  assert.equal(
    hasReusableLampBackgroundPlanApproval(run, "single", undefined, NOW + 1),
    false
  );
  assert.equal(hasReusableLampApproval(run, "single", undefined, NOW + 1), false);

  for (const iteration of [1, 2] as const) {
    assert.doesNotThrow(() =>
      assertPaidOperationAuthorized(
        run,
        "judge",
        iteration,
        LAMP_BACKGROUND_HOLISTIC_EVAL_ID,
        lampBackgroundEvaluationOperationId(iteration),
        NOW + 1
      )
    );
  }
  assert.doesNotThrow(() =>
    assertPaidOperationAuthorized(
      run,
      "lipsync",
      2,
      undefined,
      LIPSYNC_OPERATION_ID,
      NOW + 1
    )
  );
  assert.throws(
    () =>
      assertPaidOperationAuthorized(
        run,
        "plan",
        undefined,
        undefined,
        lampBackgroundPlanOperationId(),
        NOW + 1
      ),
    /planning requires a separate approval/
  );
  assert.throws(
    () =>
      assertPaidOperationAuthorized(
        run,
        "judge",
        1,
        "lamp-holistic",
        lampEvaluationOperationId(1),
        NOW + 1
      ),
    /two holistic evaluations/
  );
  assert.throws(
    () =>
      assertPaidOperationAuthorized(
        run,
        "lipsync",
        1,
        undefined,
        LIPSYNC_OPERATION_ID,
        NOW + 1
      ),
    /at most one Lipsync-2-Pro repair for Final/
  );

  assert.doesNotThrow(() =>
    assertVideoGenerationAuthorized(run, 1, NOW + 1)
  );
  assert.doesNotThrow(() =>
    assertVideoGenerationAuthorized(run, 2, NOW + 1)
  );
  assert.throws(
    () => assertVideoGenerationAuthorized(run, 3, NOW + 1),
    /exactly two video generation attempts/
  );
});

test("execution helpers distinguish both historical methods from Lamp Background", () => {
  assert.equal(normalizedWorkflowMode(undefined), "flora");
  assert.equal(normalizedWorkflowMode("invalid" as never), "flora");
  assert.equal(normalizedWorkflowMode("lamp"), "lamp");
  assert.equal(normalizedWorkflowMode("background"), "background");

  assert.equal(isTwoPassWorkflowMode("flora"), false);
  assert.equal(isTwoPassWorkflowMode("lamp"), true);
  assert.equal(isTwoPassWorkflowMode("background"), true);
  assert.equal(workflowModeFromExecutionId("first-cut:run_fixture"), "flora");
  assert.equal(workflowModeFromExecutionId("lamp:run_fixture"), "lamp");
  assert.equal(
    workflowModeFromExecutionId("lamp-background:run_fixture"),
    "background"
  );
  assert.equal(
    workflowModeFromExecutionId("lamp-background-batch:batch_fixture"),
    "background"
  );
  assert.equal(isTwoPassExecutionId("batch:batch_fixture:run_fixture"), false);
  assert.equal(isTwoPassExecutionId("lamp:run_fixture"), true);
  assert.equal(isTwoPassExecutionId("lamp-background:run_fixture"), true);

  assert.equal(
    batchExecutionId("batch_fixture", "background"),
    "lamp-background-batch:batch_fixture"
  );
  assert.equal(
    batchMemberExecutionId(
      "batch_fixture",
      "run_fixture",
      "background"
    ),
    "lamp-background:run_fixture"
  );
  assert.equal(batchApprovalScope("background"), "background_two_pass");
  assert.equal(batchMaximumIterations("background"), 2);
  assert.equal(batchCompletionIteration("background"), 2);
});

test("background reservations use the current verified Omni, Gemini, and optional repair rates", () => {
  const durationSec = 7.5;
  const estimate = estimateLampBackgroundTwoPass(durationSec);
  const [
    generation,
    generationInput,
    evaluationInput,
    evaluationOutput,
    lipsync,
    localAudio,
  ] = estimate.items;

  assert.equal(
    generation.usd,
    durationSec *
      LAMP_BACKGROUND_GENERATION_COUNT *
      PRICE_TABLE.omniFlashPerOutputSecond.usd
  );
  assert.equal(generationInput.provider, "omni");
  assert.equal(evaluationInput.provider, "gemini");
  assert.equal(evaluationOutput.provider, "gemini");
  assert.equal(
    lipsync.usd,
    durationSec * PRICE_TABLE.lipsync2ProPerOutputSecond.usd
  );
  assert.equal(localAudio.usd, 0);
});
