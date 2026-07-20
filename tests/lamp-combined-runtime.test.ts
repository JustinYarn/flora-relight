import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildLampCombinedCandidateQualificationReceipt,
  isLampCombinedCandidateQualificationReceipt,
  lampCombinedCandidateReceiptEligible,
  lampCombinedCandidateReceiptToDeliveryCandidate,
  lampCombinedLegacyCandidateReceiptMatches,
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
  lampCombinedLipsyncGenerationBinding,
  lampCombinedLipsyncInputHash,
  lampCombinedLipsyncOperationId,
  lampCombinedMandatorySyncVerdict,
} from "../lib/lamp-combined-lipsync.ts";
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

function normalization(
  iteration: 1 | 2,
  preSync: SyncNetMetrics = PASS,
  postSync: SyncNetMetrics = PASS
): PaidOperation {
  const gen = generation(iteration);
  const sourceGeneration = lampCombinedLipsyncGenerationBinding(gen, iteration);
  assert.ok(sourceGeneration);
  const predictionId = `prediction-${iteration}`;
  return {
    id: lampCombinedLipsyncOperationId(iteration),
    runId: RUN_ID,
    provider: "replicate",
    kind: "lipsync",
    iteration,
    inputHash: lampCombinedLipsyncInputHash({
      runId: RUN_ID,
      iteration,
      sourceGeneration,
    }),
    providerOperationId: predictionId,
    status: "completed",
    startedAt: 20,
    updatedAt: 30,
    result: {
      version: "lamp-combined-lipsync-v1",
      iteration,
      predictionId,
      model: LIPSYNC_MODEL,
      videoUrl: `/api/media/runs/${RUN_ID}/lipsync-v${iteration}-remuxed.mp4`,
      videoSha256: "b".repeat(64),
      audioMd5: "c".repeat(32),
      billableDurationSec: 8,
      costUsd: 0.666,
      audioVerified: true,
      preSync,
      postSync,
      sourceSync: PASS,
      windows: [
        {
          startSec: 0,
          durationSec: 3,
          source: PASS,
          candidate: postSync,
        },
      ],
      sourceGeneration,
    },
  };
}

test("Combined Lipsync identity ignores mutable billing metadata", () => {
  const original = generation(1);
  const withReconciledBilling = structuredClone(original);
  withReconciledBilling.result!.costUsd = 1.25;
  withReconciledBilling.result!.usage = {
    total_input_tokens: 2,
    total_output_tokens: 3,
    output_tokens_by_modality: [],
  };
  assert.deepEqual(
    lampCombinedLipsyncGenerationBinding(original, 1),
    lampCombinedLipsyncGenerationBinding(withReconciledBilling, 1)
  );
});

test("Combined receipt binds exact generation, evaluation, and canonical baseline", () => {
  const gen = generation(1);
  const judge = evaluation(1);
  const lipsync = normalization(1);
  const receipt = buildLampCombinedCandidateQualificationReceipt({
    iteration: 1,
    generationOperation: gen,
    evaluationOperation: judge,
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    sourceHasAudio: true,
    syncEvidence: { outcome: "measured", metrics: PASS, sourceSync: PASS },
    lipsyncOperation: lipsync,
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
      lipsyncOperation: lipsync,
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
      lipsyncOperation: lipsync,
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
      lipsyncOperation: lipsync,
    }),
    false
  );
});

test("every audio-bearing Combined take requires a completed mandatory normalization", () => {
  assert.throws(
    () =>
      buildLampCombinedCandidateQualificationReceipt({
        iteration: 1,
        generationOperation: generation(1),
        evaluationOperation: evaluation(1),
        planId: PLAN_ID,
        planHash: PLAN_HASH,
        sourceHasAudio: true,
        syncEvidence: { outcome: "measured", metrics: PASS, sourceSync: PASS },
        recordedAt: 40,
      }),
    /mandatory Lipsync proof/
  );
  const inProgress = {
    ...normalization(1),
    status: "in_progress" as const,
    result: undefined,
  };
  assert.throws(
    () =>
      buildLampCombinedCandidateQualificationReceipt({
        iteration: 1,
        generationOperation: generation(1),
        evaluationOperation: evaluation(1),
        planId: PLAN_ID,
        planHash: PLAN_HASH,
        sourceHasAudio: true,
        syncEvidence: { outcome: "measured", metrics: PASS, sourceSync: PASS },
        lipsyncOperation: inProgress,
        recordedAt: 40,
      }),
    /mandatory Lipsync proof/
  );
});

test("a completed normalization that fails the strict post-check is explicit and ineligible", () => {
  const lipsync = normalization(1, FAIL, FAIL);
  const receipt = buildLampCombinedCandidateQualificationReceipt({
    iteration: 1,
    generationOperation: generation(1),
    evaluationOperation: evaluation(1),
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    sourceHasAudio: true,
    syncEvidence: { outcome: "measured", metrics: FAIL, sourceSync: PASS },
    lipsyncOperation: lipsync,
    recordedAt: 40,
  });
  assert.equal(receipt.sync.outcome, "failed");
  assert.equal(lampCombinedCandidateReceiptEligible(receipt), false);
  assert.equal(
    lampCombinedMandatorySyncVerdict(
      lipsync.result as NonNullable<PaidOperation["result"]> & {
        postSync: SyncNetMetrics;
        sourceSync: SyncNetMetrics;
        windows: Array<{
          startSec: number;
          durationSec: number;
          source: SyncNetMetrics;
          candidate: SyncNetMetrics;
        }>;
      }
    ).pass,
    false
  );
});

test("both Take 1 and Take 2 bind their own normalized artifact", () => {
  for (const iteration of [1, 2] as const) {
    const gen = generation(iteration);
    const judge = evaluation(iteration);
    const lipsync = normalization(iteration);
    const receipt = buildLampCombinedCandidateQualificationReceipt({
      iteration,
      generationOperation: gen,
      evaluationOperation: judge,
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      sourceHasAudio: true,
      syncEvidence: { outcome: "measured", metrics: PASS, sourceSync: PASS },
      lipsyncOperation: lipsync,
      recordedAt: 40,
    });
    assert.equal(receipt.normalization?.operationId, `lipsync:${iteration}`);
    assert.equal(receipt.repair, undefined);
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
        lipsyncOperation: lipsync,
      }),
      true
    );
  }
});

test("a normalized receipt rejects missing, changed, and unresolved Lipsync journals", () => {
  const gen = generation(2);
  const judge = evaluation(2);
  const completed = normalization(2);
  const receipt = buildLampCombinedCandidateQualificationReceipt({
    iteration: 2,
    generationOperation: gen,
    evaluationOperation: judge,
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    sourceHasAudio: true,
    syncEvidence: { outcome: "measured", metrics: PASS, sourceSync: PASS },
    lipsyncOperation: completed,
    recordedAt: 40,
  });
  const inProgress: PaidOperation = {
    ...completed,
    status: "in_progress",
    result: undefined,
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

  assert.equal(matches(null), false);
  assert.equal(matches(inProgress), false);
  assert.equal(matches(completed), true);
  assert.equal(matches(reconcileRequired), false);
  const changed = structuredClone(completed);
  (changed.result as { videoSha256: string }).videoSha256 = "d".repeat(64);
  assert.equal(
    matches(changed),
    false
  );
});

test("legacy Combined receipts stay readable but cannot pass the current delivery gate", () => {
  const gen = generation(1);
  const judge = evaluation(1);
  const current = buildLampCombinedCandidateQualificationReceipt({
    iteration: 1,
    generationOperation: gen,
    evaluationOperation: judge,
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    sourceHasAudio: true,
    syncEvidence: { outcome: "measured", metrics: PASS, sourceSync: PASS },
    lipsyncOperation: normalization(1),
    recordedAt: 40,
  });
  const legacy = structuredClone(current);
  delete legacy.normalization;

  assert.equal(isLampCombinedCandidateQualificationReceipt(legacy), true);
  assert.equal(lampCombinedCandidateReceiptEligible(legacy), false);
  assert.equal(
    lampCombinedCandidateReceiptToDeliveryCandidate(legacy).syncStatus,
    "unverified"
  );
  assert.equal(
    lampCombinedLegacyCandidateReceiptMatches({
      receipt: legacy,
      generationOperation: gen,
      evaluationOperation: judge,
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      sourceHasAudio: true,
      canonicalSourceSync: PASS,
    }),
    true
  );
  assert.equal(
    lampCombinedCandidateReceiptMatches({
      receipt: legacy,
      generationOperation: gen,
      evaluationOperation: judge,
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      sourceHasAudio: true,
      canonicalSourceSync: PASS,
      lipsyncOperation: null,
    }),
    false
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
