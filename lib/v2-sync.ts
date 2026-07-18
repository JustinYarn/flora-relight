import { createHash } from "node:crypto";
import { canonicalInputHash } from "./canonical-input-hash.ts";

export const V2_SYNC_MIN_CONFIDENCE = 4;
export const V2_SYNC_MAX_DISTANCE = 10;
/**
 * Source-relative gate tolerances (see v2SyncVerdict). When the ORIGINAL
 * source cannot itself meet the absolute 4/10 bar (quiet or soft speaker,
 * low speech coverage), the Final is judged against what that footage can
 * actually score: confidence may sit at most this far below the source, and
 * distance at most this far above it.
 */
export const V2_SYNC_SOURCE_CONFIDENCE_TOLERANCE = 0.5;
export const V2_SYNC_SOURCE_DISTANCE_TOLERANCE = 1;
/**
 * ~one frame at 24-30fps. The relative gate trades away the absolute
 * confidence bar, so it must still refuse real audio/video drift outright.
 */
export const V2_SYNC_SOURCE_MAX_ABS_OFFSET_SEC = 0.05;
export const LIPSYNC_OPERATION_ID = "lipsync:2";
export const LIPSYNC_MODEL = "sync/lipsync-2-pro";
export const V2_FINAL_GENERATION_OPERATION_ID = "video-generation:2";
const V2_CANDIDATE_NAME = "relit-v2-candidate.mp4";
const V2_SOURCE_AUDIO_NAME = "source-audio.m4a";
const V2_CANONICAL_NAME = "relit-v2.mp4";

export interface SyncNetMetrics {
  confidence: number;
  distance: number;
  offsetSec: number;
  speechPercentage: number;
}

export function v2SyncPasses(metrics: SyncNetMetrics): boolean {
  return (
    Number.isFinite(metrics.confidence) &&
    Number.isFinite(metrics.distance) &&
    metrics.confidence >= V2_SYNC_MIN_CONFIDENCE &&
    metrics.distance <= V2_SYNC_MAX_DISTANCE
  );
}

export interface V2SyncVerdict {
  pass: boolean;
  mode: "absolute" | "source_relative";
  /** Human-readable explanation, safe to embed in run errors and logs. */
  reason: string;
}

/** Immutable Final identity projected only from the canonical provider journal. */
export interface V2FinalGenerationProof {
  operationId: typeof V2_FINAL_GENERATION_OPERATION_ID;
  providerInteractionId: string;
  finalPromptHash: string;
  /** Digest of the stable artifact identity fields retained in the journal. */
  artifactIdentityHash: string;
}

/**
 * Free, server-owned proof that the exact Final candidate cleared SyncNet or
 * legitimately had no sync dimension. A missing record is never equivalent
 * to a pass: it may mean the analyzer was unreachable before it returned.
 */
export type V2CandidateSyncVerdict =
  | {
      outcome: "passed";
      iteration: 2;
      sourceFinal: V2FinalGenerationProof;
      recordedAt: number;
      policy: "v2_source_relative_artifact_v2";
      mode: V2SyncVerdict["mode"];
      reason: string;
      metrics: SyncNetMetrics;
      sourceSync: SyncNetMetrics | null;
    }
  | {
      outcome: "skipped";
      iteration: 2;
      sourceFinal: V2FinalGenerationProof;
      recordedAt: number;
      policy: "v2_source_relative_artifact_v2";
      skipReason: "silent_source";
      reason: string;
    };

function usableBaseline(
  sourceSync: SyncNetMetrics | null | undefined
): sourceSync is SyncNetMetrics {
  return (
    !!sourceSync &&
    Number.isFinite(sourceSync.confidence) &&
    Number.isFinite(sourceSync.distance)
  );
}

/**
 * Judge a candidate's SyncNet metrics against what its ORIGINAL source can
 * actually score. Sources that pass the absolute bar keep the absolute bar.
 * Sources that cannot pass it (measured once and persisted as the run's
 * baseline) switch the gate to source-relative: the candidate passes when it
 * is within tolerance of the source and shows no real A/V offset. An
 * absolute pass is always sufficient, so a baseline can only widen the gate,
 * never narrow it — a run that would have survived the absolute rule still
 * survives.
 */
export function v2SyncVerdict(
  metrics: SyncNetMetrics,
  sourceSync?: SyncNetMetrics | null
): V2SyncVerdict {
  const absolute = v2SyncPasses(metrics);
  const summary = `confidence ${metrics.confidence.toFixed(2)}, distance ${metrics.distance.toFixed(2)}, offset ${metrics.offsetSec.toFixed(2)}s`;
  if (!usableBaseline(sourceSync) || v2SyncPasses(sourceSync)) {
    return {
      pass: absolute,
      mode: "absolute",
      reason: `${summary} versus the absolute ${V2_SYNC_MIN_CONFIDENCE}/${V2_SYNC_MAX_DISTANCE} bar`,
    };
  }
  const sourceSummary = `source baseline confidence ${sourceSync.confidence.toFixed(2)}, distance ${sourceSync.distance.toFixed(2)}`;
  if (absolute) {
    return {
      pass: true,
      mode: "source_relative",
      reason: `${summary} clears the absolute bar outright (${sourceSummary})`,
    };
  }
  const minConfidence = Math.min(
    V2_SYNC_MIN_CONFIDENCE,
    sourceSync.confidence - V2_SYNC_SOURCE_CONFIDENCE_TOLERANCE
  );
  const maxDistance = Math.max(
    V2_SYNC_MAX_DISTANCE,
    sourceSync.distance + V2_SYNC_SOURCE_DISTANCE_TOLERANCE
  );
  const pass =
    Number.isFinite(metrics.confidence) &&
    Number.isFinite(metrics.distance) &&
    Number.isFinite(metrics.offsetSec) &&
    metrics.confidence >= minConfidence &&
    metrics.distance <= maxDistance &&
    Math.abs(metrics.offsetSec) <= V2_SYNC_SOURCE_MAX_ABS_OFFSET_SEC;
  return {
    pass,
    mode: "source_relative",
    reason: `${summary} versus the source-relative bar (confidence ≥ ${minConfidence.toFixed(2)}, distance ≤ ${maxDistance.toFixed(2)}, |offset| ≤ ${V2_SYNC_SOURCE_MAX_ABS_OFFSET_SEC.toFixed(2)}s; ${sourceSummary})`,
  };
}

export interface LipsyncOperationResult {
  predictionId: string;
  model: typeof LIPSYNC_MODEL;
  videoUrl: string;
  billableDurationSec: number;
  costUsd: number;
  audioVerified: true;
  preSync: SyncNetMetrics;
  postSync: SyncNetMetrics;
  /** Exact Gemini Final that was supplied to this repair claim. */
  sourceFinal: V2FinalGenerationProof;
}

export function isSyncNetMetrics(value: unknown): value is SyncNetMetrics {
  if (!value || typeof value !== "object") return false;
  const metrics = value as Partial<SyncNetMetrics>;
  return (
    typeof metrics.confidence === "number" &&
    Number.isFinite(metrics.confidence) &&
    typeof metrics.distance === "number" &&
    Number.isFinite(metrics.distance) &&
    typeof metrics.offsetSec === "number" &&
    Number.isFinite(metrics.offsetSec) &&
    typeof metrics.speechPercentage === "number" &&
    Number.isFinite(metrics.speechPercentage)
  );
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const RUN_ID_RE = /^[a-z0-9_-]{1,64}$/;

export function v2CandidateFinalPromptHash(renderedPrompt: string): string {
  return createHash("sha256").update(renderedPrompt, "utf8").digest("hex");
}

export function isV2FinalGenerationProof(
  value: unknown
): value is V2FinalGenerationProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Partial<V2FinalGenerationProof>;
  return (
    proof.operationId === V2_FINAL_GENERATION_OPERATION_ID &&
    typeof proof.providerInteractionId === "string" &&
    proof.providerInteractionId.length > 0 &&
    proof.providerInteractionId.length <= 512 &&
    typeof proof.finalPromptHash === "string" &&
    SHA256_RE.test(proof.finalPromptHash) &&
    typeof proof.artifactIdentityHash === "string" &&
    SHA256_RE.test(proof.artifactIdentityHash)
  );
}

/** Project the exact prompt/provider/artifact identity retained for Final. */
export function v2FinalGenerationProof(
  value: unknown
): V2FinalGenerationProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const operation = value as {
    id?: unknown;
    provider?: unknown;
    kind?: unknown;
    iteration?: unknown;
    status?: unknown;
    providerInteractionId?: unknown;
    renderedPrompt?: unknown;
    result?: unknown;
  };
  if (
    operation.id !== V2_FINAL_GENERATION_OPERATION_ID ||
    operation.provider !== "gemini" ||
    operation.kind !== "video_generation" ||
    operation.iteration !== 2 ||
    operation.status !== "completed" ||
    typeof operation.providerInteractionId !== "string" ||
    operation.providerInteractionId.length < 1 ||
    operation.providerInteractionId.length > 512 ||
    typeof operation.renderedPrompt !== "string" ||
    operation.renderedPrompt.length < 1 ||
    !operation.result ||
    typeof operation.result !== "object" ||
    Array.isArray(operation.result)
  ) {
    return null;
  }
  const result = operation.result as {
    videoUrl?: unknown;
    rawUrl?: unknown;
    durationSec?: unknown;
    audioVerified?: unknown;
  };
  if (
    typeof result.videoUrl !== "string" ||
    result.videoUrl.length < 1 ||
    typeof result.rawUrl !== "string" ||
    result.rawUrl.length < 1 ||
    typeof result.durationSec !== "number" ||
    !Number.isFinite(result.durationSec) ||
    result.durationSec <= 0 ||
    result.audioVerified !== true
  ) {
    return null;
  }
  const finalPromptHash = v2CandidateFinalPromptHash(operation.renderedPrompt);
  return {
    operationId: V2_FINAL_GENERATION_OPERATION_ID,
    providerInteractionId: operation.providerInteractionId,
    finalPromptHash,
    artifactIdentityHash: canonicalInputHash({
      operationId: V2_FINAL_GENERATION_OPERATION_ID,
      provider: "gemini",
      kind: "video_generation",
      iteration: 2,
      providerInteractionId: operation.providerInteractionId,
      finalPromptHash,
      artifact: {
        videoUrl: result.videoUrl,
        rawUrl: result.rawUrl,
        durationSec: result.durationSec,
        audioVerified: true,
      },
    }),
  };
}

export function v2FinalGenerationProofsEqual(
  left: V2FinalGenerationProof,
  right: V2FinalGenerationProof
): boolean {
  return (
    left.operationId === right.operationId &&
    left.providerInteractionId === right.providerInteractionId &&
    left.finalPromptHash === right.finalPromptHash &&
    left.artifactIdentityHash === right.artifactIdentityHash
  );
}

export function v2SyncMetricsEqual(
  left: SyncNetMetrics | null,
  right: SyncNetMetrics | null
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.confidence === right.confidence &&
    left.distance === right.distance &&
    left.offsetSec === right.offsetSec &&
    left.speechPercentage === right.speechPercentage
  );
}

function canonicalSourceSync(
  value: unknown
): { valid: true; metrics: SyncNetMetrics | null } | { valid: false } {
  if (value === undefined || value === null) {
    return { valid: true, metrics: null };
  }
  return isSyncNetMetrics(value)
    ? { valid: true, metrics: value }
    : { valid: false };
}

export function v2CandidateSourceSyncMatchesCanonical(
  recorded: SyncNetMetrics | null,
  canonical: unknown
): boolean {
  const normalized = canonicalSourceSync(canonical);
  return (
    normalized.valid && v2SyncMetricsEqual(recorded, normalized.metrics)
  );
}

function canonicalRunMediaUrl(runId: string, fileName: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error("Invalid V2 sync run id.");
  return `/api/media/runs/${runId}/${fileName}`;
}

export function v2LipsyncCanonicalInput(input: {
  runId: string;
  preSync: SyncNetMetrics;
  sourceFinal: V2FinalGenerationProof;
}): Record<string, unknown> {
  if (!isSyncNetMetrics(input.preSync)) {
    throw new Error("Invalid pre-repair SyncNet metrics.");
  }
  if (!isV2FinalGenerationProof(input.sourceFinal)) {
    throw new Error("Invalid Final generation proof for Lipsync repair.");
  }
  return {
    model: LIPSYNC_MODEL,
    candidateUrl: canonicalRunMediaUrl(input.runId, V2_CANDIDATE_NAME),
    sourceAudioUrl: canonicalRunMediaUrl(input.runId, V2_SOURCE_AUDIO_NAME),
    syncMode: "cut_off",
    temperature: 0.5,
    activeSpeaker: false,
    preSync: input.preSync,
    sourceFinal: input.sourceFinal,
  };
}

export function v2LipsyncOperationInputHash(input: {
  runId: string;
  preSync: SyncNetMetrics;
  sourceFinal: V2FinalGenerationProof;
}): string {
  return canonicalInputHash({
    operationId: LIPSYNC_OPERATION_ID,
    payload: v2LipsyncCanonicalInput(input),
  });
}

export function isV2CandidateSyncVerdict(
  value: unknown
): value is V2CandidateSyncVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const verdict = value as Partial<V2CandidateSyncVerdict>;
  if (
    verdict.iteration !== 2 ||
    !isV2FinalGenerationProof(verdict.sourceFinal) ||
    typeof verdict.recordedAt !== "number" ||
    !Number.isSafeInteger(verdict.recordedAt) ||
    verdict.recordedAt < 0 ||
    verdict.policy !== "v2_source_relative_artifact_v2" ||
    typeof verdict.reason !== "string" ||
    verdict.reason.length < 1 ||
    verdict.reason.length > 1_000
  ) {
    return false;
  }
  if (verdict.outcome === "skipped") {
    return verdict.skipReason === "silent_source";
  }
  return (
    verdict.outcome === "passed" &&
    (verdict.mode === "absolute" || verdict.mode === "source_relative") &&
    isSyncNetMetrics(verdict.metrics) &&
    (verdict.sourceSync === null || isSyncNetMetrics(verdict.sourceSync)) &&
    v2SyncVerdict(verdict.metrics, verdict.sourceSync).pass
  );
}

export function v2CandidateSyncVerdictMatchesFinal(
  value: unknown,
  finalGeneration: unknown,
  canonicalSourceSyncValue: unknown,
  sourceHasAudio: unknown
): value is V2CandidateSyncVerdict {
  if (!isV2CandidateSyncVerdict(value)) return false;
  const sourceFinal = v2FinalGenerationProof(finalGeneration);
  if (
    !sourceFinal ||
    !v2FinalGenerationProofsEqual(value.sourceFinal, sourceFinal)
  ) {
    return false;
  }
  if (value.outcome === "skipped") return sourceHasAudio === false;
  return v2CandidateSourceSyncMatchesCanonical(
    value.sourceSync,
    canonicalSourceSyncValue
  );
}

export function v2LipsyncProofMatchesFinal(input: {
  runId: string;
  finalGeneration: unknown;
  lipsync: unknown;
}): boolean {
  const sourceFinal = v2FinalGenerationProof(input.finalGeneration);
  if (
    !sourceFinal ||
    !input.lipsync ||
    typeof input.lipsync !== "object" ||
    Array.isArray(input.lipsync)
  ) {
    return false;
  }
  const operation = input.lipsync as {
    id?: unknown;
    runId?: unknown;
    provider?: unknown;
    kind?: unknown;
    iteration?: unknown;
    inputHash?: unknown;
    providerOperationId?: unknown;
    status?: unknown;
    result?: unknown;
  };
  if (
    operation.id !== LIPSYNC_OPERATION_ID ||
    operation.runId !== input.runId ||
    operation.provider !== "replicate" ||
    operation.kind !== "lipsync" ||
    operation.iteration !== 2 ||
    operation.status !== "completed" ||
    typeof operation.inputHash !== "string" ||
    !SHA256_RE.test(operation.inputHash) ||
    !isLipsyncOperationResult(operation.result) ||
    operation.providerOperationId !== operation.result.predictionId ||
    !v2FinalGenerationProofsEqual(
      operation.result.sourceFinal,
      sourceFinal
    ) ||
    operation.result.videoUrl !==
      canonicalRunMediaUrl(input.runId, V2_CANONICAL_NAME)
  ) {
    return false;
  }
  return (
    operation.inputHash ===
    v2LipsyncOperationInputHash({
      runId: input.runId,
      preSync: operation.result.preSync,
      sourceFinal,
    })
  );
}

/**
 * Settlement accepts exactly one of two durable proofs: a journaled candidate
 * pass/legitimate skip for this Final prompt, or a completed paid repair whose
 * post-repair metrics clear the same effective gate. Null Lipsync alone proves
 * nothing.
 */
export function v2SyncSettlementVerified(input: {
  runId: string;
  candidateVerdict: unknown;
  finalGeneration: unknown;
  lipsync: unknown | null;
  canonicalSourceSync?: unknown;
  sourceHasAudio: unknown;
}): boolean {
  if (input.lipsync === null) {
    return v2CandidateSyncVerdictMatchesFinal(
      input.candidateVerdict,
      input.finalGeneration,
      input.canonicalSourceSync,
      input.sourceHasAudio
    );
  }
  const normalized = canonicalSourceSync(input.canonicalSourceSync);
  if (
    !normalized.valid ||
    !v2LipsyncProofMatchesFinal({
      runId: input.runId,
      finalGeneration: input.finalGeneration,
      lipsync: input.lipsync,
    })
  ) {
    return false;
  }
  const operation = input.lipsync as { result: LipsyncOperationResult };
  return v2SyncVerdict(operation.result.postSync, normalized.metrics).pass;
}

export function v2CandidateSyncJournalOwnerMatches(
  execution: unknown,
  expected: { runId: string; executionId: string; workflowRunId: string }
): boolean {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    return false;
  }
  const current = execution as {
    runId?: unknown;
    executionId?: unknown;
    workflowRunId?: unknown;
    status?: unknown;
    phase?: unknown;
    iteration?: unknown;
  };
  return (
    current.runId === expected.runId &&
    current.executionId === expected.executionId &&
    current.workflowRunId === expected.workflowRunId &&
    current.status === "running" &&
    (current.phase === "video_generation" || current.phase === "evaluating") &&
    current.iteration === 2
  );
}

export function v2CompletedRunRecoveryDecision(
  syncVerified: boolean
): "settle" | "hold_for_live_sync_gate" {
  return syncVerified ? "settle" : "hold_for_live_sync_gate";
}

export function isLipsyncOperationResult(
  value: unknown
): value is LipsyncOperationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<LipsyncOperationResult>;
  return (
    typeof result.predictionId === "string" &&
    result.predictionId.length > 0 &&
    result.model === LIPSYNC_MODEL &&
    typeof result.videoUrl === "string" &&
    result.videoUrl.length > 0 &&
    typeof result.billableDurationSec === "number" &&
    Number.isFinite(result.billableDurationSec) &&
    result.billableDurationSec > 0 &&
    typeof result.costUsd === "number" &&
    Number.isFinite(result.costUsd) &&
    result.costUsd >= 0 &&
    result.audioVerified === true &&
    isSyncNetMetrics(result.preSync) &&
    isSyncNetMetrics(result.postSync) &&
    isV2FinalGenerationProof(result.sourceFinal)
  );
}
