import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateLampChainPlan,
  estimateLampChainSequence,
  lampChainPlanReservationUsd,
  lampChainSequenceReservationUsd,
  lampChainStageCount,
  lampBackgroundPlanReservationUsd,
} from "../lib/cost.ts";
import {
  assertPaidOperationAuthorized,
  assertVideoGenerationAuthorized,
  createSpendApproval,
  hasReusableLampChainApproval,
  hasReusableLampChainPlanApproval,
} from "../lib/server/spend-approval.ts";
import {
  lampChainEvaluationOperationId,
  LAMP_CHAIN_HOLISTIC_EVAL_ID,
} from "../lib/lamp-chain-operations.ts";
import { LIPSYNC_OPERATION_ID } from "../lib/v2-sync.ts";
import {
  buildLampChainStageReceipt,
  isLampChainStageReceipt,
  lampChainStageReceiptMatches,
} from "../lib/lamp-chain-candidate.ts";
import {
  assertNewRunExecution,
  assertRunExecution,
  assertRunExecutionTransition,
} from "../lib/server/storage/run-execution.ts";
import { createHash } from "node:crypto";
import {
  approveLampChainPlan,
  buildLampChainPlan,
  type LampChainControls,
} from "../lib/lamp-chain.ts";
import { buildLampChainPromptEnvelope } from "../lib/prompts/lamp-chain.ts";
import { createMockLampBackgroundCleanupPlan } from "../lib/lamp-background.ts";
import type {
  ProviderOperation,
  Run,
  RunExecution,
  VideoAsset,
} from "../lib/types.ts";

const NOW = 1_800_100_000_000;

const TWO_STAGE: LampChainControls = {
  beautifyLevel: 0,
  cleanlinessLevel: 2,
  eyeContact: false,
  stageOrder: ["background", "lamp"],
};
const FOUR_STAGE: LampChainControls = {
  beautifyLevel: 2,
  cleanlinessLevel: 3,
  eyeContact: true,
  stageOrder: ["background", "lamp", "beautify", "iris"],
};

const TRIPLE = (controls: LampChainControls) => ({
  beautifyLevel: controls.beautifyLevel,
  cleanlinessLevel: controls.cleanlinessLevel,
  eyeContact: controls.eyeContact,
});

function video(runId = "run_chain_cost"): VideoAsset {
  return {
    id: `video_${runId}`,
    runId,
    kind: "original",
    url: `/api/media/${runId}/source.mp4`,
    label: "Chain cost fixture",
    durationSec: 8,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
}

function run(
  source: VideoAsset,
  controls: LampChainControls,
  approval: Run["spendApproval"],
  providerOperations?: ProviderOperation[]
): Run {
  return {
    id: source.runId!,
    workflowId: "lamp-chain-v1",
    workflowMode: "chain",
    chainControls: controls,
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

function completedGeneration(iteration: number): ProviderOperation {
  return {
    id: `video-generation:${iteration}`,
    provider: "gemini",
    kind: "video_generation",
    iteration,
    providerInteractionId: `interaction-${iteration}`,
    renderedPrompt: `stage prompt ${iteration}`,
    status: "completed",
    startedAt: NOW,
    updatedAt: NOW + 1,
    result: {
      videoUrl: `/api/media/runs/run_chain_cost/relit-v${iteration}.mp4`,
      rawUrl: `/api/media/runs/run_chain_cost/gen-v${iteration}.mp4`,
      durationSec: 8,
      audioVerified: true,
      usage: { videoTokenCount: 1, inputTokenCount: 1, textTokenCount: 1 },
      costUsd: 1.12,
    },
  } as unknown as ProviderOperation;
}

test("chain estimates scale with the enabled stage count and never price a repair", () => {
  assert.equal(lampChainStageCount(TRIPLE(TWO_STAGE)), 2);
  assert.equal(lampChainStageCount(TRIPLE(FOUR_STAGE)), 4);

  const two = estimateLampChainSequence(TRIPLE(TWO_STAGE), 8);
  const four = estimateLampChainSequence(TRIPLE(FOUR_STAGE), 8);
  assert.ok(four.totalUsd > two.totalUsd);
  for (const item of [...two.items, ...four.items]) {
    assert.ok(
      !/lipsync/i.test(item.label),
      "chain never bills a Lipsync repair"
    );
  }
  assert.equal(
    lampChainPlanReservationUsd(TRIPLE(TWO_STAGE)),
    lampBackgroundPlanReservationUsd()
  );
  assert.equal(
    lampChainPlanReservationUsd(TRIPLE(FOUR_STAGE)),
    lampBackgroundPlanReservationUsd() * 3
  );
  assert.ok(
    lampChainSequenceReservationUsd(TRIPLE(FOUR_STAGE), 8) >
      lampChainSequenceReservationUsd(TRIPLE(TWO_STAGE), 8)
  );
  assert.equal(estimateLampChainPlan(TRIPLE(FOUR_STAGE)).items.length, 6);
});

test("chain_sequence approvals bind the stage count and authorize only stage work", () => {
  const source = video();
  const approval = createSpendApproval(
    source,
    "single",
    undefined,
    NOW,
    "chain_sequence",
    TRIPLE(FOUR_STAGE)
  );
  assert.equal(approval.maxIterations, 4);

  const authorized = run(source, FOUR_STAGE, approval);
  // Detached stage evaluations are inside the grant…
  assertPaidOperationAuthorized(
    authorized,
    "judge",
    3,
    LAMP_CHAIN_HOLISTIC_EVAL_ID,
    lampChainEvaluationOperationId(3),
    NOW + 1
  );
  // …a Lipsync repair never is…
  assert.throws(() =>
    assertPaidOperationAuthorized(
      authorized,
      "lipsync",
      4,
      undefined,
      LIPSYNC_OPERATION_ID,
      NOW + 1
    )
  );
  // …nor a planner call, nor an out-of-range stage.
  assert.throws(() =>
    assertPaidOperationAuthorized(
      authorized,
      "plan",
      undefined,
      undefined,
      "plan:lamp-chain:background:gemini",
      NOW + 1
    )
  );
  assert.throws(() =>
    assertPaidOperationAuthorized(
      authorized,
      "judge",
      5,
      LAMP_CHAIN_HOLISTIC_EVAL_ID,
      lampChainEvaluationOperationId(4),
      NOW + 1
    )
  );

  // Two-stage grants stop at stage 2.
  const smallApproval = createSpendApproval(
    video("run_chain_small"),
    "single",
    undefined,
    NOW,
    "chain_sequence",
    TRIPLE(TWO_STAGE)
  );
  assert.equal(smallApproval.maxIterations, 2);
  const smallRun = run(video("run_chain_small"), TWO_STAGE, smallApproval);
  assert.throws(() =>
    assertPaidOperationAuthorized(
      smallRun,
      "judge",
      3,
      LAMP_CHAIN_HOLISTIC_EVAL_ID,
      lampChainEvaluationOperationId(3),
      NOW + 1
    )
  );
});

test("chain generation authorization is sequential and stage-bounded", () => {
  const source = video();
  const approval = createSpendApproval(
    source,
    "single",
    undefined,
    NOW,
    "chain_sequence",
    TRIPLE(FOUR_STAGE)
  );
  const fresh = run(source, FOUR_STAGE, approval);
  assertVideoGenerationAuthorized(fresh, 1, NOW + 1);
  // Stage 3 requires stage 2 completed.
  assert.throws(() => assertVideoGenerationAuthorized(fresh, 3, NOW + 1));
  const advanced = run(source, FOUR_STAGE, approval, [
    completedGeneration(1),
    completedGeneration(2),
  ]);
  assertVideoGenerationAuthorized(advanced, 3, NOW + 1);
  assert.throws(() => assertVideoGenerationAuthorized(advanced, 5, NOW + 1));

  // Plan-scope authorizes zero generations.
  const planApproval = createSpendApproval(
    video("run_chain_plan"),
    "single",
    undefined,
    NOW,
    "chain_plan",
    TRIPLE(FOUR_STAGE)
  );
  const planRun = run(video("run_chain_plan"), FOUR_STAGE, planApproval);
  assert.throws(() => assertVideoGenerationAuthorized(planRun, 1, NOW + 1));
  assertPaidOperationAuthorized(
    planRun,
    "plan",
    undefined,
    undefined,
    "plan:lamp-chain:iris:gemini",
    NOW + 1
  );

  assert.ok(hasReusableLampChainApproval(fresh, "single", undefined, NOW + 1));
  assert.ok(
    hasReusableLampChainPlanApproval(planRun, "single", undefined, NOW + 1)
  );
  assert.ok(!hasReusableLampChainApproval(planRun, "single", undefined, NOW + 1));
});

test("stage receipts bind exact generation proof and verified audio", () => {
  const operation = completedGeneration(1);
  const receipt = buildLampChainStageReceipt({
    stage: 1,
    stageKind: "background",
    generationOperation: operation,
    sourceHasAudio: true,
    recordedAt: NOW + 2,
  });
  assert.ok(isLampChainStageReceipt(receipt));
  assert.ok(
    lampChainStageReceiptMatches({
      receipt,
      generationOperation: operation,
      expectedRenderedPrompt: "stage prompt 1",
      stage: 1,
      stageKind: "background",
      sourceHasAudio: true,
    })
  );
  assert.ok(
    !lampChainStageReceiptMatches({
      receipt,
      generationOperation: operation,
      expectedRenderedPrompt: "different prompt",
      stage: 1,
      stageKind: "background",
      sourceHasAudio: true,
    })
  );
  // An unverified-audio journal can never mint a receipt.
  const badAudio = {
    ...operation,
    result: { ...operation.result!, audioVerified: false },
  };
  assert.throws(() =>
    buildLampChainStageReceipt({
      stage: 1,
      stageKind: "background",
      generationOperation: badAudio,
      sourceHasAudio: true,
      recordedAt: NOW + 2,
    })
  );
});

test("storage invariants: chain executions settle only with a full receipt trail", () => {
  const runId = "run_chain_exec";
  const controls = TWO_STAGE;
  const plan = approveLampChainPlan(
    buildLampChainPlan({
      planId: "plan-chain-exec",
      runId,
      createdAt: NOW,
      controls,
      backgroundPlan: createMockLampBackgroundCleanupPlan(runId, NOW),
    }),
    NOW + 1
  );
  const envelope = JSON.stringify(buildLampChainPromptEnvelope(plan, 75));
  const base: RunExecution = {
    runId,
    executionId: `lamp-chain:${runId}`,
    inputHash: createHash("sha256").update(envelope, "utf8").digest("hex"),
    renderedPrompt: envelope,
    combinedPlanOperationIds: ["plan:lamp-chain:background:gemini"],
    approvedPlanHash: "a".repeat(64),
    relightIntensity: 75,
    source: "single",
    status: "queued",
    phase: "queued",
    iteration: 0,
    revision: 1,
    startedAt: NOW,
    updatedAt: NOW,
  };
  assertNewRunExecution(base);

  // Chain identity requires the planner set + hash.
  assert.throws(() =>
    assertRunExecution({
      ...base,
      combinedPlanOperationIds: undefined,
      approvedPlanHash: undefined,
    })
  );
  // Chain forbids two-pass-only fields.
  assert.throws(() =>
    assertRunExecution({ ...base, deliveredIteration: 2 })
  );

  const receiptFor = (stage: number) =>
    buildLampChainStageReceipt({
      stage,
      stageKind: stage === 1 ? "background" : "lamp",
      generationOperation: completedGeneration(stage),
      sourceHasAudio: true,
      recordedAt: NOW + stage,
    });

  const running: RunExecution = {
    ...base,
    status: "running",
    phase: "video_generation",
    iteration: 2,
    revision: 5,
    workflowRunId: "wrun_test",
    updatedAt: NOW + 10,
    chainStageReceipts: [receiptFor(1), receiptFor(2)],
  };
  assertRunExecution(running);

  // Delivery requires the complete contiguous receipt trail…
  assert.throws(() =>
    assertRunExecution({
      ...running,
      status: "awaiting_review",
      phase: "complete",
      chainStageReceipts: [receiptFor(1)],
    })
  );
  // …and settles cleanly with it.
  assertRunExecution({
    ...running,
    status: "awaiting_review",
    phase: "complete",
  });

  // Receipts are append-only and immutable across transitions.
  const withOne: RunExecution = {
    ...running,
    iteration: 1,
    revision: 5,
    chainStageReceipts: [receiptFor(1)],
  };
  const appendSecond: RunExecution = {
    ...withOne,
    iteration: 2,
    revision: 6,
    updatedAt: NOW + 11,
    chainStageReceipts: [receiptFor(1), receiptFor(2)],
  };
  assertRunExecutionTransition(withOne, appendSecond, 5);
  assert.throws(() =>
    assertRunExecutionTransition(
      withOne,
      { ...appendSecond, chainStageReceipts: [receiptFor(2), receiptFor(2)] },
      5
    )
  );
  assert.throws(() =>
    assertRunExecutionTransition(
      appendSecond,
      {
        ...appendSecond,
        revision: 7,
        chainStageReceipts: [receiptFor(1)],
      },
      6
    )
  );
});
