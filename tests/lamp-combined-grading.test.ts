import assert from "node:assert/strict";
import test from "node:test";

import {
  finalLampIteration,
  finalLampVideo,
  isGradeable,
  isGradeableLampCombinedCandidate,
} from "../components/grade/derive.ts";
import { mergeGradeFeedRuns } from "../components/grade/run-feed.ts";
import { parseHumanGrade } from "../lib/human-grade.ts";
import type { LampCombinedCandidateQualificationReceipt } from "../lib/lamp-combined-candidate.ts";
import { LAMP_COMBINED_EVAL_IDS } from "../lib/lamp-combined-evaluation.ts";
import { lampCombinedEvaluationOperationId } from "../lib/lamp-combined-operations.ts";
import type { HumanGrade, Run, VideoAsset } from "../lib/types.ts";

const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const EVAL_HASH_1 = "3".repeat(64);
const EVAL_HASH_2 = "4".repeat(64);
const INPUT_HASH_1 = "5".repeat(64);
const INPUT_HASH_2 = "6".repeat(64);

function receipt(
  iteration: 1 | 2
): LampCombinedCandidateQualificationReceipt {
  return {
    version: "lamp-combined-candidate-v1",
    iteration,
    generation: {
      operationId: `video-generation:${iteration}`,
      iteration,
      providerInteractionId: `interaction-${iteration}`,
      promptHash: iteration === 1 ? HASH_1 : HASH_2,
      artifactIdentityHash: iteration === 1 ? HASH_1 : HASH_2,
    },
    evaluation: {
      operationId: lampCombinedEvaluationOperationId(iteration),
      inputHash: iteration === 1 ? INPUT_HASH_1 : INPUT_HASH_2,
      artifactIdentityHash: iteration === 1 ? EVAL_HASH_1 : EVAL_HASH_2,
    },
    recordedAt: 20,
    audio: {
      outcome: "verified",
      reason: "canonical_source_audio_verified",
    },
    sync: {
      outcome: "passed",
      policy: "combined_source_relative_v1",
      mode: "absolute",
      reason: "fixture pass",
      metrics: {
        confidence: 6,
        distance: 8,
        offsetSec: 0,
        speechPercentage: 70,
      },
      sourceSync: {
        confidence: 6,
        distance: 8,
        offsetSec: 0,
        speechPercentage: 70,
      },
    },
  };
}

function video(runId: string, iteration: 1 | 2): VideoAsset {
  return {
    id: `candidate-${iteration}`,
    runId,
    kind: "generated",
    url: `/api/media/runs/${runId}/candidate-${iteration}.mp4`,
    label: `Candidate ${iteration}`,
    durationSec: 8,
    width: 1280,
    height: 720,
    hasAudio: true,
  };
}

function combinedRun(options: {
  live?: boolean;
  grade?: HumanGrade;
  globalFinalAlias?: VideoAsset;
} = {}): Run {
  const runId = "run_combined_grade_fixture";
  const initialReceipt = receipt(1);
  const finalReceipt = receipt(2);
  const initial = video(runId, 1);
  const final = video(runId, 2);
  return {
    id: runId,
    workflowId: "lamp-combined-v1",
    workflowMode: "combined",
    live: options.live ?? true,
    createdAt: 1,
    originalVideo: {
      ...initial,
      id: "source",
      kind: "original",
      url: `/api/media/runs/${runId}/source.mp4`,
      label: "Source",
    },
    status: "awaiting-review",
    iterations: [
      {
        index: 1,
        megaPrompt: {} as never,
        generatedVideo: initial,
        recoveredFromProviderOperation: true,
        beforeFrames: [],
        afterFrames: [],
        evalResults: [],
        status: "ungraded",
      },
      {
        index: 2,
        megaPrompt: {} as never,
        generatedVideo: final,
        recoveredFromProviderOperation: true,
        beforeFrames: [],
        afterFrames: [],
        evalResults: [],
        status: "ungraded",
      },
    ],
    nodeStates: {},
    log: [],
    serverExecution: {
      runId,
      executionId: `lamp-combined:${runId}`,
      inputHash: "a".repeat(64),
      renderedPrompt: "fixture prompt",
      combinedPlanOperationIds: ["plan:lamp-combined:background:gemini"],
      approvedPlanHash: "b".repeat(64),
      relightIntensity: 50,
      combinedCandidateReceipts: {
        initial: initialReceipt,
        final: finalReceipt,
      },
      source: "single",
      status: "awaiting_review",
      phase: "complete",
      iteration: 2,
      revision: 8,
      startedAt: 1,
      updatedAt: 20,
    },
    ...(options.globalFinalAlias
      ? { finalVideo: options.globalFinalAlias }
      : {}),
    ...(options.grade ? { humanGrade: options.grade } : {}),
  };
}

function grade(target?: {
  iteration: 1 | 2;
  artifactHash: string;
}): Record<string, unknown> {
  return {
    gradedAt: 123,
    shipIt: true,
    scores: Object.fromEntries(
      LAMP_COMBINED_EVAL_IDS.map((evalId) => [
        evalId,
        { points: 4, score: 85, verdict: "pass" },
      ])
    ),
    ...(target
      ? {
          gradedIteration: target.iteration,
          gradedCandidateArtifactIdentityHash: target.artifactHash,
        }
      : {}),
  };
}

test("Combined human grades require one exact candidate target", () => {
  const parsed = parseHumanGrade({
    value: grade({ iteration: 1, artifactHash: HASH_1 }),
    requiredEvalIds: LAMP_COMBINED_EVAL_IDS,
    requireCombinedTarget: true,
  });
  assert.ok(parsed);
  assert.equal(parsed.gradedIteration, 1);
  assert.equal(parsed.gradedCandidateArtifactIdentityHash, HASH_1);

  assert.equal(
    parseHumanGrade({
      value: grade(),
      requiredEvalIds: LAMP_COMBINED_EVAL_IDS,
      requireCombinedTarget: true,
    }),
    null
  );
  assert.equal(
    parseHumanGrade({
      value: grade({ iteration: 2, artifactHash: "not-a-hash" }),
      requiredEvalIds: LAMP_COMBINED_EVAL_IDS,
      requireCombinedTarget: true,
    }),
    null
  );
  assert.equal(
    parseHumanGrade({
      value: grade({ iteration: 1, artifactHash: HASH_1 }),
      requiredEvalIds: LAMP_COMBINED_EVAL_IDS,
    }),
    null,
    "candidate fields must never leak into another workflow's grade"
  );
});

test("only a live, qualified, provider-backed Combined take enters blind grading", () => {
  const live = combinedRun();
  assert.equal(isGradeableLampCombinedCandidate(live, 1), true);
  assert.equal(isGradeableLampCombinedCandidate(live, 2), true);
  assert.equal(
    isGradeableLampCombinedCandidate(combinedRun({ live: false }), 1),
    false,
    "provider-free demos stay preview-only"
  );

  const missingProviderProof = structuredClone(live);
  delete missingProviderProof.iterations[0].recoveredFromProviderOperation;
  assert.equal(isGradeableLampCombinedCandidate(missingProviderProof, 1), false);

  const missingReceipt = structuredClone(live);
  delete missingReceipt.serverExecution!.combinedCandidateReceipts!.initial;
  assert.equal(isGradeableLampCombinedCandidate(missingReceipt, 1), false);
});

test("the explicit pre-grade choice selects its own video, never a global Final alias", () => {
  const runId = "run_combined_grade_fixture";
  const run = combinedRun({ globalFinalAlias: video(runId, 2) });

  assert.equal(finalLampIteration(run, 1)?.index, 1);
  assert.equal(
    finalLampVideo(run, 1)?.url,
    video(runId, 1).url,
    "a v1 grade must not silently play or stamp v2"
  );
});

test("a saved Combined grade remains visible only while its artifact hash matches", () => {
  const validGrade = grade({
    iteration: 1,
    artifactHash: HASH_1,
  }) as unknown as HumanGrade;
  const valid = combinedRun({ grade: validGrade });
  assert.equal(finalLampIteration(valid)?.index, 1);
  assert.equal(isGradeable(valid), true);

  const wrongArtifact = combinedRun({
    grade: {
      ...validGrade,
      gradedCandidateArtifactIdentityHash: HASH_2,
    },
  });
  assert.equal(isGradeable(wrongArtifact), false);
});

test("the saved human winner drives Grade reconciliation", () => {
  const validGrade = grade({
    iteration: 1,
    artifactHash: HASH_1,
  }) as unknown as HumanGrade;
  const local = combinedRun({ grade: validGrade });
  local.iterations[0].evalResults = [
    { evalId: LAMP_COMBINED_EVAL_IDS[0] },
  ] as Run["iterations"][number]["evalResults"];

  const incoming = structuredClone(local);
  delete incoming.humanGrade;
  incoming.status = "awaiting-review";
  incoming.iterations[0].evalResults = [];
  incoming.serverExecution!.revision += 1;
  incoming.serverExecution!.updatedAt += 1;

  const [merged] = mergeGradeFeedRuns([local], [incoming]);

  assert.equal(merged.humanGrade?.gradedIteration, 1);
  assert.equal(finalLampIteration(merged)?.index, 1);
  assert.equal(merged.iterations[0].evalResults.length, 1);
});
