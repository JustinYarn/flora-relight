import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  appendLampCombinedRepairQualification,
  buildLampCombinedCandidateQualificationReceipt,
  lampCombinedCandidateReceiptEligible,
  lampCombinedCandidateReceiptMatches,
} from "../lib/lamp-combined-candidate.ts";
import {
  LAMP_COMBINED_EVALUATOR_VERSION,
  LAMP_COMBINED_EVAL_IDS,
} from "../lib/lamp-combined-evaluation.ts";
import {
  LAMP_COMBINED_HOLISTIC_EVAL_ID,
  lampCombinedEvaluationOperationId,
} from "../lib/lamp-combined-operations.ts";
import {
  approveLampCombinedPlan,
  buildLampCombinedPlan,
  hashLampCombinedPlan,
} from "../lib/lamp-combined.ts";
import { createMockLampBackgroundCleanupPlan } from "../lib/lamp-background.ts";
import {
  lampCombinedApprovalDisposition,
  validateLampCombinedApprovalMutation,
} from "../lib/server/storage/lamp-combined-approval.ts";
import {
  assertRunExecution,
  assertRunExecutionTransition,
} from "../lib/server/storage/run-execution.ts";
import type {
  PaidOperation,
  ProviderOperation,
  RunExecution,
  Run,
  SpendApproval,
} from "../lib/types.ts";
import {
  LIPSYNC_MODEL,
  LIPSYNC_OPERATION_ID,
  v2FinalGenerationProof,
  v2LipsyncOperationInputHash,
  type SyncNetMetrics,
} from "../lib/v2-sync.ts";

const PASS: SyncNetMetrics = {
  confidence: 6,
  distance: 8,
  offsetSec: 0.01,
  speechPercentage: 72,
};
const FAIL: SyncNetMetrics = {
  confidence: 2,
  distance: 14,
  offsetSec: 0.2,
  speechPercentage: 72,
};
const PLAN_HASH = "a".repeat(64);
const PLAN_ID = "combined-plan-runtime";
const RUN_ID = "run_combined_runtime";

function generation(
  iteration: 1 | 2,
  audioVerified = true
): ProviderOperation {
  return {
    id: `video-generation:${iteration}`,
    provider: "gemini",
    kind: "video_generation",
    iteration,
    renderedPrompt: `exact-prompt-${iteration}`,
    providerInteractionId: `interaction-${iteration}`,
    status: "completed",
    startedAt: 10,
    updatedAt: 20,
    result: {
      videoUrl: `/api/media/runs/${RUN_ID}/relit-v${iteration}.mp4`,
      rawUrl: `/raw/${iteration}.mp4`,
      durationSec: 8,
      audioVerified,
      usage: {
        total_input_tokens: 1,
        total_output_tokens: 1,
        output_tokens_by_modality: [],
      },
      costUsd: 1,
    },
  };
}

function evaluation(iteration: 1 | 2): PaidOperation {
  return {
    id: lampCombinedEvaluationOperationId(iteration),
    runId: RUN_ID,
    provider: "gemini",
    kind: "judge",
    iteration,
    evalId: LAMP_COMBINED_HOLISTIC_EVAL_ID,
    inputHash: String(iteration).repeat(64),
    status: "completed",
    startedAt: 20,
    updatedAt: 30,
    result: {
      version: LAMP_COMBINED_EVALUATOR_VERSION,
      planVersion: "lamp-combined-plan-v1",
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      iteration,
      evalResults: LAMP_COMBINED_EVAL_IDS.map((evalId) => ({
        evalId,
        iteration,
        score: 95,
        confidence: 1,
        verdict: "pass",
        violations: [],
        reasoning: "pass",
      })),
      usage: { promptTokenCount: 1, candidatesTokenCount: 1 },
      costUsd: 0.02,
    },
  };
}

test("Combined receipt binds exact generation, evaluation, and canonical baseline", () => {
  const gen = generation(1);
  const judge = evaluation(1);
  const receipt = buildLampCombinedCandidateQualificationReceipt({
    iteration: 1,
    generationOperation: gen,
    evaluationOperation: judge,
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    sourceHasAudio: true,
    syncEvidence: { outcome: "measured", metrics: PASS, sourceSync: PASS },
    recordedAt: 40,
  });
  assert.equal(lampCombinedCandidateReceiptEligible(receipt), true);
  assert.equal(
    lampCombinedCandidateReceiptMatches({
      receipt,
      generationOperation: gen,
      evaluationOperation: judge,
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      sourceHasAudio: true,
      canonicalSourceSync: PASS,
      lipsyncOperation: null,
    }),
    true
  );

  const changedArtifact = structuredClone(gen);
  changedArtifact.result!.rawUrl = "/raw/tampered.mp4";
  assert.equal(
    lampCombinedCandidateReceiptMatches({
      receipt,
      generationOperation: changedArtifact,
      evaluationOperation: judge,
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      sourceHasAudio: true,
      canonicalSourceSync: PASS,
      lipsyncOperation: null,
    }),
    false
  );
  assert.equal(
    lampCombinedCandidateReceiptMatches({
      receipt,
      generationOperation: gen,
      evaluationOperation: judge,
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      sourceHasAudio: true,
      canonicalSourceSync: { ...PASS, confidence: 5.9 },
      lipsyncOperation: null,
    }),
    false
  );
});

test("Initial SyncNet failure is explicit, ineligible, and never repairable", () => {
  const receipt = buildLampCombinedCandidateQualificationReceipt({
    iteration: 1,
    generationOperation: generation(1),
    evaluationOperation: evaluation(1),
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    sourceHasAudio: true,
    syncEvidence: { outcome: "measured", metrics: FAIL, sourceSync: PASS },
    recordedAt: 40,
  });
  assert.equal(receipt.sync.outcome, "failed");
  assert.equal(lampCombinedCandidateReceiptEligible(receipt), false);
  assert.throws(
    () =>
      appendLampCombinedRepairQualification({
        receipt,
        finalGeneration: generation(2),
        lipsyncOperation: {} as PaidOperation,
        canonicalSourceSync: PASS,
        recordedAt: 50,
      }),
    /Only one failed Combined Final/
  );
});

test("Final may append exactly one artifact-bound Lipsync repair", () => {
  const gen = generation(2);
  const base = buildLampCombinedCandidateQualificationReceipt({
    iteration: 2,
    generationOperation: gen,
    evaluationOperation: evaluation(2),
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    sourceHasAudio: true,
    syncEvidence: { outcome: "measured", metrics: FAIL, sourceSync: PASS },
    recordedAt: 40,
  });
  const sourceFinal = v2FinalGenerationProof(gen);
  assert.ok(sourceFinal);
  const lipsync: PaidOperation = {
    id: LIPSYNC_OPERATION_ID,
    runId: RUN_ID,
    provider: "replicate",
    kind: "lipsync",
    iteration: 2,
    inputHash: v2LipsyncOperationInputHash({
      runId: RUN_ID,
      preSync: FAIL,
      sourceFinal,
    }),
    providerOperationId: "prediction-1",
    status: "completed",
    startedAt: 50,
    updatedAt: 60,
    result: {
      predictionId: "prediction-1",
      model: LIPSYNC_MODEL,
      videoUrl: `/api/media/runs/${RUN_ID}/relit-v2.mp4`,
      billableDurationSec: 8,
      costUsd: 0.666,
      audioVerified: true,
      preSync: FAIL,
      postSync: PASS,
      sourceFinal,
    },
  };
  const repaired = appendLampCombinedRepairQualification({
    receipt: base,
    finalGeneration: gen,
    lipsyncOperation: lipsync,
    canonicalSourceSync: PASS,
    recordedAt: 70,
  });
  assert.equal(repaired.repair?.sync.outcome, "passed");
  assert.equal(lampCombinedCandidateReceiptEligible(repaired), true);
  assert.equal(
    lampCombinedCandidateReceiptMatches({
      receipt: repaired,
      generationOperation: gen,
      evaluationOperation: evaluation(2),
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      sourceHasAudio: true,
      canonicalSourceSync: PASS,
      lipsyncOperation: lipsync,
    }),
    true
  );
  assert.throws(
    () =>
      appendLampCombinedRepairQualification({
        receipt: repaired,
        finalGeneration: gen,
        lipsyncOperation: lipsync,
        canonicalSourceSync: PASS,
        recordedAt: 80,
      }),
    /Only one failed Combined Final/
  );
});

test("Final without a repair receipt rejects every existing Lipsync journal", () => {
  const gen = generation(2);
  const judge = evaluation(2);
  const receipt = buildLampCombinedCandidateQualificationReceipt({
    iteration: 2,
    generationOperation: gen,
    evaluationOperation: judge,
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    sourceHasAudio: true,
    syncEvidence: { outcome: "measured", metrics: FAIL, sourceSync: PASS },
    recordedAt: 40,
  });
  const sourceFinal = v2FinalGenerationProof(gen)!;
  const inputHash = v2LipsyncOperationInputHash({
    runId: RUN_ID,
    preSync: FAIL,
    sourceFinal,
  });
  const inProgress: PaidOperation = {
    id: LIPSYNC_OPERATION_ID,
    runId: RUN_ID,
    provider: "replicate",
    kind: "lipsync",
    iteration: 2,
    inputHash,
    providerOperationId: "prediction-orphan",
    status: "in_progress",
    startedAt: 50,
    updatedAt: 60,
  };
  const completed: PaidOperation = {
    ...inProgress,
    status: "completed",
    result: {
      predictionId: "prediction-orphan",
      model: LIPSYNC_MODEL,
      videoUrl: `/api/media/runs/${RUN_ID}/lipsync-v2-remuxed.mp4`,
      billableDurationSec: 8,
      costUsd: 0.666,
      audioVerified: true,
      preSync: FAIL,
      postSync: PASS,
      sourceFinal,
    },
  };
  const reconcileRequired: PaidOperation = {
    ...inProgress,
    status: "reconcile_required",
    error: "Provider outcome is ambiguous.",
  };
  const matches = (lipsyncOperation: PaidOperation | null) =>
    lampCombinedCandidateReceiptMatches({
      receipt,
      generationOperation: gen,
      evaluationOperation: judge,
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      sourceHasAudio: true,
      canonicalSourceSync: PASS,
      lipsyncOperation,
    });

  assert.equal(receipt.repair, undefined);
  assert.equal(matches(null), true);
  assert.equal(matches(inProgress), false);
  assert.equal(matches(completed), false);
  assert.equal(matches(reconcileRequired), false);
});

test("a durably completed but failing Final repair stays explicit and ineligible", () => {
  const gen = generation(2);
  const base = buildLampCombinedCandidateQualificationReceipt({
    iteration: 2,
    generationOperation: gen,
    evaluationOperation: evaluation(2),
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    sourceHasAudio: true,
    syncEvidence: { outcome: "measured", metrics: FAIL, sourceSync: PASS },
    recordedAt: 40,
  });
  const sourceFinal = v2FinalGenerationProof(gen)!;
  const lipsync: PaidOperation = {
    id: LIPSYNC_OPERATION_ID,
    runId: RUN_ID,
    provider: "replicate",
    kind: "lipsync",
    iteration: 2,
    inputHash: v2LipsyncOperationInputHash({
      runId: RUN_ID,
      preSync: FAIL,
      sourceFinal,
    }),
    providerOperationId: "prediction-failed",
    status: "completed",
    startedAt: 50,
    updatedAt: 60,
    result: {
      predictionId: "prediction-failed",
      model: LIPSYNC_MODEL,
      videoUrl: `/api/media/runs/${RUN_ID}/lipsync-v2-remuxed.mp4`,
      billableDurationSec: 8,
      costUsd: 0.666,
      audioVerified: true,
      preSync: FAIL,
      postSync: FAIL,
      sourceFinal,
    },
  };
  const repaired = appendLampCombinedRepairQualification({
    receipt: base,
    finalGeneration: gen,
    lipsyncOperation: lipsync,
    canonicalSourceSync: PASS,
    recordedAt: 70,
  });
  assert.equal(repaired.repair?.sync.outcome, "failed");
  assert.equal(lampCombinedCandidateReceiptEligible(repaired), false);
  assert.equal(
    lampCombinedCandidateReceiptMatches({
      receipt: repaired,
      generationOperation: gen,
      evaluationOperation: evaluation(2),
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      sourceHasAudio: true,
      canonicalSourceSync: PASS,
      lipsyncOperation: lipsync,
    }),
    true
  );
});

function queuedExecution(): RunExecution {
  const renderedPrompt = "exact-combined-prompt";
  return {
    runId: RUN_ID,
    executionId: `lamp-combined:${RUN_ID}`,
    inputHash: createHash("sha256").update(renderedPrompt).digest("hex"),
    renderedPrompt,
    combinedPlanOperationIds: [
      "plan:lamp-combined:background:gemini",
    ],
    approvedPlanHash: PLAN_HASH,
    relightIntensity: 50,
    source: "single",
    status: "queued",
    phase: "queued",
    iteration: 0,
    revision: 1,
    startedAt: 10,
    updatedAt: 10,
  };
}

test("Combined execution identity is single-only and planner ids are immutable", () => {
  const queued = assertRunExecution(queuedExecution());
  assert.throws(
    () =>
      assertRunExecution({
        ...queued,
        source: "batch",
        batchId: "batch_1",
      }),
    /single-run only/
  );
  assert.throws(
    () =>
      assertRunExecutionTransition(
        queued,
        {
          ...queued,
          combinedPlanOperationIds: [
            ...queued.combinedPlanOperationIds!,
            "plan:lamp-combined:iris:gemini",
          ],
          status: "running",
          phase: "preparing",
          workflowRunId: "workflow-1",
          revision: 2,
          updatedAt: 20,
        },
        1
      ),
    /identity fields are immutable/
  );
  assert.throws(
    () =>
      assertRunExecution({
        ...queued,
        status: "awaiting_review",
        phase: "complete",
        iteration: 2,
      }),
    /requires explicit receipts for both candidates/
  );
});

test("atomic Combined approval accepts one exact draft and replays only exact approved state", async () => {
  const createdAt = 100;
  const draft = buildLampCombinedPlan({
    planId: PLAN_ID,
    runId: RUN_ID,
    createdAt,
    controls: {
      beautifyLevel: 0,
      cleanlinessLevel: 2,
      eyeContact: false,
    },
    backgroundPlan: createMockLampBackgroundCleanupPlan(RUN_ID, createdAt),
  });
  const approved = approveLampCombinedPlan(draft, 200);
  const approval: SpendApproval = {
    id: "approval-combined",
    source: "single",
    scope: "combined_two_pass",
    runId: RUN_ID,
    sourceUrl: "/api/media/source.mp4",
    durationSec: 8,
    approvedAt: 200,
    expiresAt: Date.now() + 60_000,
    maxUsd: 5,
    maxIterations: 2,
    combinedControls: draft.controls,
  };
  const input = await validateLampCombinedApprovalMutation(RUN_ID, {
    expectedPlanHash: await hashLampCombinedPlan(draft),
    expectedDraftPlan: draft,
    approvedPlan: approved,
    spendApproval: approval,
  });
  const run = {
    id: RUN_ID,
    workflowId: "lamp-combined-v1",
    workflowMode: "combined",
    relightIntensity: 50,
    combinedControls: draft.controls,
    combinedPlan: draft,
    createdAt,
    originalVideo: {
      id: "source",
      runId: RUN_ID,
      label: "source.mp4",
      kind: "original",
      url: approval.sourceUrl,
      width: 1920,
      height: 1080,
      durationSec: approval.durationSec,
      hasAudio: true,
    },
    status: "running",
    iterations: [],
    nodeStates: {},
    log: [],
  } as Run;
  assert.equal(
    await lampCombinedApprovalDisposition(run, input),
    "approve_draft"
  );
  assert.equal(
    await lampCombinedApprovalDisposition(
      { ...run, combinedPlan: approved, spendApproval: approval },
      input
    ),
    "already_approved"
  );
  assert.equal(
    await lampCombinedApprovalDisposition(
      { ...run, combinedPlan: approved },
      input
    ),
    "renew_approval"
  );
  assert.equal(
    await lampCombinedApprovalDisposition(
      {
        ...run,
        combinedPlan: approved,
        spendApproval: { ...approval, expiresAt: Date.now() - 1 },
      },
      input
    ),
    "renew_approval"
  );
  assert.equal(
    await lampCombinedApprovalDisposition(
      {
        ...run,
        combinedPlan: approved,
        spendApproval: { ...approval, sourceUrl: "/api/media/other.mp4" },
      },
      input
    ),
    "conflict"
  );
  assert.equal(
    await lampCombinedApprovalDisposition(
      {
        ...run,
        combinedControls: { ...draft.controls, eyeContact: true },
      },
      input
    ),
    "conflict"
  );
});
