import assert from "node:assert/strict";
import test from "node:test";

import {
  isV2FinalGenerationProof,
  isV2CandidateSyncVerdict,
  isLipsyncOperationResult,
  LIPSYNC_OPERATION_ID,
  LIPSYNC_MODEL,
  v2CandidateSourceSyncMatchesCanonical,
  v2CandidateSyncJournalOwnerMatches,
  v2CompletedRunRecoveryDecision,
  v2FinalGenerationProof,
  v2LipsyncOperationInputHash,
  v2SyncPasses,
  v2SyncSettlementVerified,
  v2SyncVerdict,
  type SyncNetMetrics,
} from "../lib/v2-sync.ts";
import { lipsync2ProCostFromDuration } from "../lib/cost.ts";

const metrics = (
  confidence: number,
  distance: number,
  offsetSec = -0.04
): SyncNetMetrics => ({
  confidence,
  distance,
  offsetSec,
  speechPercentage: 0.87,
});

const RUN_ID = "run_fixture";

function finalGeneration(overrides: Record<string, unknown> = {}) {
  const resultOverrides =
    overrides.result && typeof overrides.result === "object"
      ? (overrides.result as Record<string, unknown>)
      : {};
  return {
    id: "video-generation:2",
    provider: "gemini",
    kind: "video_generation",
    iteration: 2,
    providerInteractionId: "interaction_final_fixture",
    renderedPrompt: "exact Final prompt bytes",
    status: "completed",
    startedAt: 1_799_999_999_000,
    updatedAt: 1_800_000_000_000,
    ...overrides,
    result: {
      videoUrl: `/api/media/runs/${RUN_ID}/relit-v2.mp4`,
      rawUrl: `/api/media/runs/${RUN_ID}/gen-v2.mp4`,
      durationSec: 5.3,
      audioVerified: true,
      usage: {
        total_input_tokens: 1,
        total_output_tokens: 1,
        output_tokens_by_modality: [],
      },
      costUsd: 1.12,
      ...resultOverrides,
    },
  };
}

function finalProof(operation = finalGeneration()) {
  const proof = v2FinalGenerationProof(operation);
  assert.ok(proof);
  return proof;
}

function passingCandidate(
  operation = finalGeneration(),
  sourceSync: SyncNetMetrics | null = null
) {
  return {
    outcome: "passed" as const,
    iteration: 2 as const,
    sourceFinal: finalProof(operation),
    recordedAt: 1_800_000_000_000,
    policy: "v2_source_relative_artifact_v2" as const,
    mode: sourceSync ? ("source_relative" as const) : ("absolute" as const),
    reason: "Candidate clears the effective bar.",
    metrics: sourceSync ? metrics(2.74, 7.42, -0.04) : metrics(5.2, 8, 0),
    sourceSync,
  };
}

function completedLipsync(operation = finalGeneration()) {
  const sourceFinal = finalProof(operation);
  const preSync = metrics(2, 15);
  const result = {
    predictionId: "prediction_repair_fixture",
    model: LIPSYNC_MODEL,
    videoUrl: `/api/media/runs/${RUN_ID}/relit-v2.mp4`,
    billableDurationSec: 5.3,
    costUsd: 0.441225,
    audioVerified: true as const,
    preSync,
    postSync: metrics(6.2, 8.1, 0),
    sourceFinal,
  };
  return {
    id: LIPSYNC_OPERATION_ID,
    runId: RUN_ID,
    provider: "replicate",
    kind: "lipsync",
    iteration: 2,
    inputHash: v2LipsyncOperationInputHash({
      runId: RUN_ID,
      preSync,
      sourceFinal,
    }),
    providerOperationId: result.predictionId,
    status: "completed",
    startedAt: 1_800_000_000_000,
    updatedAt: 1_800_000_001_000,
    result,
  };
}

test("V2 SyncNet gate admits its exact confidence and distance boundaries", () => {
  assert.equal(v2SyncPasses(metrics(4, 10)), true);
  assert.equal(v2SyncPasses(metrics(3.999, 10)), false);
  assert.equal(v2SyncPasses(metrics(4, 10.001)), false);
});

test("verdict stays absolute without a baseline and prevents regression from a healthy source", () => {
  const noBaseline = v2SyncVerdict(metrics(3.9, 8));
  assert.equal(noBaseline.pass, false);
  assert.equal(noBaseline.mode, "absolute");
  assert.equal(v2SyncVerdict(metrics(4.2, 8), null).pass, true);

  // A healthy source activates the stricter source-relative regression bar.
  const healthySource = metrics(6.5, 7);
  const nearMiss = v2SyncVerdict(metrics(3.9, 8), healthySource);
  assert.equal(nearMiss.pass, false);
  assert.equal(nearMiss.mode, "source_relative");

  // Live Combined V2 regression: this used to scrape through the loose 4/10
  // absolute threshold despite looking visibly wrong to a human.
  const liveSource = metrics(7.1218, 7.8304, 0.2);
  const falsePass = v2SyncVerdict(metrics(5.7188, 9.8072, 0.08), liveSource);
  assert.equal(falsePass.pass, false);
});

test("run_bg01_049 regression: a quiet-speaker source admits its within-tolerance Final", () => {
  // Live 2026-07-16 evidence — source confidence 2.65 (47% speech), Final
  // candidate 2.74/7.42/-0.04s scored BETTER than the source yet the absolute
  // gate billed an unwinnable $0.82 repair and sealed the run failed.
  const quietSource: SyncNetMetrics = {
    confidence: 2.65,
    distance: 7.5,
    offsetSec: -0.02,
    speechPercentage: 0.47,
  };
  const candidate = v2SyncVerdict(metrics(2.74, 7.42, -0.04), quietSource);
  assert.equal(candidate.pass, true);
  assert.equal(candidate.mode, "source_relative");

  // The $0.82 repair that reached 3.70/6.76/0 must also count as a pass so
  // recovery of the already-sealed run can settle instead of re-killing it.
  const repaired = v2SyncVerdict(metrics(3.7, 6.76, 0), quietSource);
  assert.equal(repaired.pass, true);
  assert.equal(repaired.mode, "source_relative");
});

test("source-relative bar still refuses real regressions", () => {
  const quietSource = metrics(2.65, 7.5, -0.02);
  // Confidence tolerance: 2.65 - 0.5 = 2.15 is the exact floor.
  assert.equal(v2SyncVerdict(metrics(2.15, 8), quietSource).pass, true);
  assert.equal(v2SyncVerdict(metrics(2.149, 8), quietSource).pass, false);
  // Distance headroom never shrinks below the absolute 10.
  assert.equal(v2SyncVerdict(metrics(2.74, 10, 0), quietSource).pass, true);
  assert.equal(v2SyncVerdict(metrics(2.74, 10.001, 0), quietSource).pass, false);
  // The relative gate must refuse real A/V drift outright (~1 frame cap).
  assert.equal(v2SyncVerdict(metrics(2.74, 7.42, 0.03), quietSource).pass, true);
  assert.equal(
    v2SyncVerdict(metrics(2.74, 7.42, 0.031), quietSource).pass,
    false
  );
});

test("an absolute pass cannot bypass source-relative timing preservation", () => {
  const quietSource = metrics(2.65, 7.5);
  const verdict = v2SyncVerdict(metrics(5.2, 8, 0.3), quietSource);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.mode, "source_relative");
});

test("relative thresholds clamp to the absolute bar via min/max", () => {
  // A source failing only on distance keeps confidence pinned at min(4, 4.5).
  const farSource = metrics(5.0, 12, 0);
  assert.equal(v2SyncVerdict(metrics(4.05, 12.9, 0), farSource).pass, true);
  assert.equal(v2SyncVerdict(metrics(3.9, 12.9, 0), farSource).pass, false);
  // Distance headroom follows the source: max(10, 12 + 1) = 13.
  assert.equal(v2SyncVerdict(metrics(4.05, 13.001, 0), farSource).pass, false);
});

test("a corrupt baseline degrades to the absolute gate", () => {
  const corrupt = metrics(Number.NaN, 7.5);
  const verdict = v2SyncVerdict(metrics(3.9, 8), corrupt);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.mode, "absolute");
});

test("Lipsync cost is derived from actual output duration", () => {
  assert.ok(Math.abs(lipsync2ProCostFromDuration(5.3) - 0.441225) < 1e-12);
  assert.throws(() => lipsync2ProCostFromDuration(0), /positive and finite/);
});

test("completed Lipsync results retain both SyncNet checks", () => {
  const sourceFinal = finalProof();
  assert.equal(
    isLipsyncOperationResult({
      predictionId: "prediction_fixture",
      model: LIPSYNC_MODEL,
      videoUrl: "/api/media/runs/run_fixture/relit-v2.mp4",
      billableDurationSec: 5.3,
      costUsd: 0.441225,
      audioVerified: true,
      preSync: metrics(3.38, 11.22),
      postSync: metrics(6.2, 8.1),
      sourceFinal,
    }),
    true
  );
});

test("a null Lipsync journal requires an explicit Final-artifact-bound candidate verdict", () => {
  const final = finalGeneration();
  const passed = passingCandidate(final);

  assert.equal(isV2CandidateSyncVerdict(passed), true);
  assert.equal(
    v2SyncSettlementVerified({
      runId: RUN_ID,
      candidateVerdict: undefined,
      finalGeneration: final,
      lipsync: null,
      canonicalSourceSync: null,
      sourceHasAudio: true,
    }),
    false
  );
  assert.equal(
    v2SyncSettlementVerified({
      runId: RUN_ID,
      candidateVerdict: passed,
      finalGeneration: final,
      lipsync: null,
      canonicalSourceSync: null,
      sourceHasAudio: true,
    }),
    true
  );
  assert.equal(
    v2SyncSettlementVerified({
      runId: RUN_ID,
      candidateVerdict: passed,
      finalGeneration: finalGeneration({
        renderedPrompt: "changed Final prompt bytes",
      }),
      lipsync: null,
      canonicalSourceSync: null,
      sourceHasAudio: true,
    }),
    false
  );
  assert.equal(
    isV2CandidateSyncVerdict({
      ...passed,
      metrics: metrics(1, 20, 0.5),
    }),
    false
  );
});

test("candidate proof rejects every changed Final journal identity field", () => {
  const final = finalGeneration();
  const passed = passingCandidate(final);
  const changedFinals = [
    finalGeneration({ providerInteractionId: "interaction_changed" }),
    finalGeneration({ renderedPrompt: "changed prompt" }),
    finalGeneration({
      result: {
        videoUrl: `/api/media/runs/${RUN_ID}/other-final.mp4`,
      },
    }),
    finalGeneration({
      result: { rawUrl: `/api/media/runs/${RUN_ID}/other-raw.mp4` },
    }),
    finalGeneration({ result: { durationSec: 5.31 } }),
    finalGeneration({ result: { audioVerified: false } }),
  ];
  for (const changed of changedFinals) {
    assert.equal(
      v2SyncSettlementVerified({
        runId: RUN_ID,
        candidateVerdict: passed,
        finalGeneration: changed,
        lipsync: null,
        canonicalSourceSync: null,
        sourceHasAudio: true,
      }),
      false
    );
  }
});

test("candidate proof is bound to the exact canonical source baseline", () => {
  const quietSource = metrics(2.65, 7.5, -0.02);
  const passed = passingCandidate(finalGeneration(), quietSource);
  assert.equal(
    v2CandidateSourceSyncMatchesCanonical(quietSource, { ...quietSource }),
    true
  );
  assert.equal(
    v2CandidateSourceSyncMatchesCanonical(quietSource, {
      ...quietSource,
      confidence: 2.66,
    }),
    false
  );
  assert.equal(
    v2SyncSettlementVerified({
      runId: RUN_ID,
      candidateVerdict: passed,
      finalGeneration: finalGeneration(),
      lipsync: null,
      canonicalSourceSync: quietSource,
      sourceHasAudio: true,
    }),
    true
  );
  assert.equal(
    v2SyncSettlementVerified({
      runId: RUN_ID,
      candidateVerdict: passed,
      finalGeneration: finalGeneration(),
      lipsync: null,
      canonicalSourceSync: { ...quietSource, distance: 7.6 },
      sourceHasAudio: true,
    }),
    false
  );
});

test("an explicit silent-source skip requires hasAudio === false exactly", () => {
  const final = finalGeneration();
  const skipped = {
    outcome: "skipped" as const,
    iteration: 2 as const,
    sourceFinal: finalProof(final),
    recordedAt: 1_800_000_000_001,
    policy: "v2_source_relative_artifact_v2" as const,
    skipReason: "silent_source" as const,
    reason: "Canonical source is silent.",
  };
  assert.equal(isV2CandidateSyncVerdict(skipped), true);
  assert.equal(
    v2SyncSettlementVerified({
      runId: RUN_ID,
      candidateVerdict: skipped,
      finalGeneration: final,
      lipsync: null,
      canonicalSourceSync: null,
      sourceHasAudio: false,
    }),
    true
  );
  for (const malformed of [true, undefined, null, 0, "false"]) {
    assert.equal(
      v2SyncSettlementVerified({
        runId: RUN_ID,
        candidateVerdict: skipped,
        finalGeneration: final,
        lipsync: null,
        canonicalSourceSync: null,
        sourceHasAudio: malformed,
      }),
      false
    );
  }
});

test("a completed passing repair must match its paid claim and current Final", () => {
  const final = finalGeneration();
  const lipsync = completedLipsync(final);
  assert.equal(
    v2SyncSettlementVerified({
      runId: RUN_ID,
      candidateVerdict: undefined,
      finalGeneration: final,
      lipsync,
      canonicalSourceSync: null,
      sourceHasAudio: true,
    }),
    true
  );
  assert.equal(
    v2SyncSettlementVerified({
      runId: RUN_ID,
      candidateVerdict: undefined,
      finalGeneration: final,
      lipsync: { ...lipsync, inputHash: "0".repeat(64) },
      canonicalSourceSync: null,
      sourceHasAudio: true,
    }),
    false
  );
  assert.equal(
    v2SyncSettlementVerified({
      runId: RUN_ID,
      candidateVerdict: undefined,
      finalGeneration: final,
      lipsync: { ...lipsync, providerOperationId: "prediction_changed" },
      canonicalSourceSync: null,
      sourceHasAudio: true,
    }),
    false
  );
});

test("completed repair proof rejects interaction, prompt, artifact, duration, and audio mutations", () => {
  const final = finalGeneration();
  const lipsync = completedLipsync(final);
  const changedFinals = [
    finalGeneration({ providerInteractionId: "interaction_changed" }),
    finalGeneration({ renderedPrompt: "changed prompt" }),
    finalGeneration({
      result: {
        videoUrl: `/api/media/runs/${RUN_ID}/other-final.mp4`,
      },
    }),
    finalGeneration({
      result: { rawUrl: `/api/media/runs/${RUN_ID}/other-raw.mp4` },
    }),
    finalGeneration({ result: { durationSec: 5.31 } }),
    finalGeneration({ result: { audioVerified: false } }),
  ];
  for (const changed of changedFinals) {
    assert.equal(
      v2SyncSettlementVerified({
        runId: RUN_ID,
        candidateVerdict: undefined,
        finalGeneration: changed,
        lipsync,
        canonicalSourceSync: null,
        sourceHasAudio: true,
      }),
      false
    );
  }
});

test("candidate verdict replay requires the same live execution/workflow owner", () => {
  const execution = {
    runId: RUN_ID,
    executionId: "lamp:fixture",
    workflowRunId: "workflow_fixture",
    status: "running",
    phase: "evaluating",
    iteration: 2,
  };
  const expected = {
    runId: RUN_ID,
    executionId: "lamp:fixture",
    workflowRunId: "workflow_fixture",
  };
  assert.equal(v2CandidateSyncJournalOwnerMatches(execution, expected), true);
  assert.equal(
    v2CandidateSyncJournalOwnerMatches(
      { ...execution, workflowRunId: "workflow_other" },
      expected
    ),
    false
  );
  assert.equal(
    v2CandidateSyncJournalOwnerMatches(
      { ...execution, executionId: "lamp:other" },
      expected
    ),
    false
  );
  assert.equal(
    v2CandidateSyncJournalOwnerMatches(
      { ...execution, status: "reconcile_required" },
      expected
    ),
    false
  );
});

test("completed-run recovery holds for the live gate until proof exists", () => {
  assert.equal(
    v2CompletedRunRecoveryDecision(false),
    "hold_for_live_sync_gate"
  );
  assert.equal(v2CompletedRunRecoveryDecision(true), "settle");
});

test("Final proof itself refuses an unverified artifact marker", () => {
  assert.equal(isV2FinalGenerationProof(finalProof()), true);
  assert.equal(
    v2FinalGenerationProof(finalGeneration({ provider: "replicate" })),
    null
  );
  assert.equal(
    v2FinalGenerationProof(finalGeneration({ kind: "lipsync" })),
    null
  );
  assert.equal(
    v2FinalGenerationProof(
      finalGeneration({ result: { audioVerified: false } })
    ),
    null
  );
});

test("completed repair proof refuses the wrong run or operation kind", () => {
  const final = finalGeneration();
  const lipsync = completedLipsync(final);
  for (const changed of [
    { ...lipsync, runId: "run_other" },
    { ...lipsync, provider: "gemini" },
    { ...lipsync, kind: "judge" },
    { ...lipsync, iteration: 1 },
  ]) {
    assert.equal(
      v2SyncSettlementVerified({
        runId: RUN_ID,
        candidateVerdict: undefined,
        finalGeneration: final,
        lipsync: changed,
        canonicalSourceSync: null,
        sourceHasAudio: true,
      }),
      false
    );
  }
});
