import { canonicalInputHash } from "./canonical-input-hash.ts";
import {
  LAMP_COMBINED_EVALUATOR_VERSION,
  LAMP_COMBINED_EVAL_IDS,
  type LampCombinedEvaluationArtifact,
} from "./lamp-combined-evaluation.ts";
import {
  LAMP_COMBINED_HOLISTIC_EVAL_ID,
  lampCombinedEvaluationOperationId,
} from "./lamp-combined-operations.ts";
import {
  lampCombinedCandidateIneligibility,
  type LampCombinedDeliveryCandidate,
  type LampCombinedIteration,
} from "./lamp-combined.ts";
import {
  isLampCombinedLipsyncResult,
  lampCombinedLipsyncOperationId,
  lampCombinedLipsyncProofMatchesGeneration,
  lampCombinedMandatorySyncVerdict,
  type LampCombinedSyncWindowEvidence,
} from "./lamp-combined-lipsync.ts";
import type { PaidOperation, ProviderOperation } from "./types.ts";
import {
  isLipsyncOperationResult,
  isSyncNetMetrics,
  LIPSYNC_OPERATION_ID,
  v2CandidateSourceSyncMatchesCanonical,
  v2FinalGenerationProof,
  v2FinalGenerationProofsEqual,
  v2LipsyncProofMatchesFinal,
  v2LipsyncOperationInputHash,
  v2SyncVerdict,
  v2SyncMetricsEqual,
  type SyncNetMetrics,
} from "./v2-sync.ts";

export const LAMP_COMBINED_CANDIDATE_RECEIPT_VERSION =
  "lamp-combined-candidate-v1" as const;

const SHA256_RE = /^[a-f0-9]{64}$/;

export interface LampCombinedGenerationProof {
  operationId: string;
  iteration: LampCombinedIteration;
  providerInteractionId: string;
  promptHash: string;
  artifactIdentityHash: string;
}

export interface LampCombinedEvaluationProof {
  operationId: string;
  inputHash: string;
  artifactIdentityHash: string;
}

export type LampCombinedCandidateAudioQualification =
  | { outcome: "verified"; reason: "canonical_source_audio_verified" }
  | { outcome: "silent_source"; reason: "source_has_no_audio" }
  | { outcome: "failed"; reason: "canonical_source_audio_unverified" };

export type LampCombinedCandidateSyncQualification =
  | {
      outcome: "passed" | "failed";
      policy: "combined_source_relative_v1";
      mode: "absolute" | "source_relative";
      reason: string;
      metrics: SyncNetMetrics;
      sourceSync: SyncNetMetrics | null;
    }
  | { outcome: "not_required"; reason: "silent_source" }
  | { outcome: "not_run"; reason: "audio_unverified" };

export interface LampCombinedRepairQualification {
  operationId: typeof LIPSYNC_OPERATION_ID;
  inputHash: string;
  predictionId: string;
  artifactIdentityHash: string;
  recordedAt: number;
  audio: { outcome: "verified"; reason: "canonical_source_audio_verified" };
  sync: {
    outcome: "passed" | "failed";
    policy: "combined_source_relative_v1";
    mode: "absolute" | "source_relative";
    reason: string;
    metrics: SyncNetMetrics;
    sourceSync: SyncNetMetrics | null;
  };
}

export interface LampCombinedLipsyncQualification {
  operationId: `lipsync:${LampCombinedIteration}`;
  inputHash: string;
  predictionId: string;
  artifactIdentityHash: string;
  videoUrl: string;
  videoSha256: string;
  audioMd5: string;
  recordedAt: number;
  preSync: SyncNetMetrics;
  postSync: SyncNetMetrics;
  sourceSync: SyncNetMetrics;
  windows: LampCombinedSyncWindowEvidence[];
}

/**
 * Immutable eligibility evidence for one exact generated take and its one
 * holistic Combined evaluation. New audio-bearing receipts require one exact
 * mandatory normalization proof; the optional repair field is legacy-only.
 */
export interface LampCombinedCandidateQualificationReceipt {
  version: typeof LAMP_COMBINED_CANDIDATE_RECEIPT_VERSION;
  iteration: LampCombinedIteration;
  generation: LampCombinedGenerationProof;
  evaluation: LampCombinedEvaluationProof;
  recordedAt: number;
  audio: LampCombinedCandidateAudioQualification;
  sync: LampCombinedCandidateSyncQualification;
  /** Mandatory post-generation normalization for every audio-bearing take. */
  normalization?: LampCombinedLipsyncQualification;
  /** Legacy V2-only conditional repair proof retained for old receipts. */
  repair?: LampCombinedRepairQualification;
}

export type LampCombinedSyncEvidence =
  | { outcome: "silent_source" }
  | { outcome: "audio_unverified" }
  | {
      outcome: "measured";
      metrics: SyncNetMetrics;
      sourceSync: SyncNetMetrics | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function generationOperationId(iteration: LampCombinedIteration): string {
  return `video-generation:${iteration}`;
}

/** Project an exact provider prompt/interaction/artifact identity. */
export function lampCombinedGenerationProof(
  value: unknown,
  iteration: LampCombinedIteration
): LampCombinedGenerationProof | null {
  if (!isRecord(value)) return null;
  const operation = value as unknown as ProviderOperation;
  if (
    operation.id !== generationOperationId(iteration) ||
    operation.provider !== "gemini" ||
    operation.kind !== "video_generation" ||
    operation.iteration !== iteration ||
    operation.status !== "completed" ||
    typeof operation.providerInteractionId !== "string" ||
    operation.providerInteractionId.length < 1 ||
    typeof operation.renderedPrompt !== "string" ||
    operation.renderedPrompt.length < 1 ||
    !operation.result ||
    typeof operation.result.videoUrl !== "string" ||
    operation.result.videoUrl.length < 1 ||
    typeof operation.result.rawUrl !== "string" ||
    operation.result.rawUrl.length < 1 ||
    typeof operation.result.durationSec !== "number" ||
    !Number.isFinite(operation.result.durationSec) ||
    operation.result.durationSec <= 0 ||
    typeof operation.result.audioVerified !== "boolean"
  ) {
    return null;
  }
  const promptHash = canonicalInputHash(operation.renderedPrompt);
  return {
    operationId: operation.id,
    iteration,
    providerInteractionId: operation.providerInteractionId,
    promptHash,
    artifactIdentityHash: canonicalInputHash({
      operationId: operation.id,
      provider: operation.provider,
      kind: operation.kind,
      iteration,
      providerInteractionId: operation.providerInteractionId,
      promptHash,
      artifact: {
        videoUrl: operation.result.videoUrl,
        rawUrl: operation.result.rawUrl,
        durationSec: operation.result.durationSec,
        audioVerified: operation.result.audioVerified,
      },
    }),
  };
}

export function lampCombinedEvaluationProof(
  value: unknown,
  iteration: LampCombinedIteration,
  planId: string,
  planHash: string
): LampCombinedEvaluationProof | null {
  if (!isRecord(value)) return null;
  const operation = value as unknown as PaidOperation;
  const artifact = operation.result as
    | LampCombinedEvaluationArtifact
    | undefined;
  if (
    operation.id !== lampCombinedEvaluationOperationId(iteration) ||
    operation.provider !== "gemini" ||
    operation.kind !== "judge" ||
    operation.iteration !== iteration ||
    operation.evalId !== LAMP_COMBINED_HOLISTIC_EVAL_ID ||
    operation.status !== "completed" ||
    typeof operation.inputHash !== "string" ||
    !SHA256_RE.test(operation.inputHash) ||
    !artifact ||
    artifact.version !== LAMP_COMBINED_EVALUATOR_VERSION ||
    artifact.planId !== planId ||
    artifact.planHash !== planHash ||
    artifact.iteration !== iteration ||
    !Array.isArray(artifact.evalResults) ||
    artifact.evalResults.length !== LAMP_COMBINED_EVAL_IDS.length ||
    artifact.evalResults.some(
      (result, index) =>
        result?.evalId !== LAMP_COMBINED_EVAL_IDS[index] ||
        result.iteration !== iteration
    )
  ) {
    return null;
  }
  return {
    operationId: operation.id,
    inputHash: operation.inputHash,
    artifactIdentityHash: canonicalInputHash(artifact),
  };
}

function proofsEqual(
  left: LampCombinedGenerationProof,
  right: LampCombinedGenerationProof
): boolean {
  return (
    left.operationId === right.operationId &&
    left.iteration === right.iteration &&
    left.providerInteractionId === right.providerInteractionId &&
    left.promptHash === right.promptHash &&
    left.artifactIdentityHash === right.artifactIdentityHash
  );
}

function evaluationProofsEqual(
  left: LampCombinedEvaluationProof,
  right: LampCombinedEvaluationProof
): boolean {
  return (
    left.operationId === right.operationId &&
    left.inputHash === right.inputHash &&
    left.artifactIdentityHash === right.artifactIdentityHash
  );
}

function combinedLipsyncProofMatchesFinal(input: {
  finalGeneration: ProviderOperation;
  lipsyncOperation: PaidOperation;
  preSync: SyncNetMetrics;
  requireCanonicalOutput: boolean;
}): boolean {
  const sourceFinal = v2FinalGenerationProof(input.finalGeneration);
  const result = input.lipsyncOperation.result;
  if (
    !sourceFinal ||
    input.lipsyncOperation.id !== LIPSYNC_OPERATION_ID ||
    input.lipsyncOperation.runId.length < 1 ||
    input.lipsyncOperation.provider !== "replicate" ||
    input.lipsyncOperation.kind !== "lipsync" ||
    input.lipsyncOperation.iteration !== 2 ||
    input.lipsyncOperation.status !== "completed" ||
    !isLipsyncOperationResult(result) ||
    input.lipsyncOperation.providerOperationId !== result.predictionId ||
    !v2FinalGenerationProofsEqual(result.sourceFinal, sourceFinal) ||
    !v2SyncMetricsEqual(result.preSync, input.preSync) ||
    input.lipsyncOperation.inputHash !==
      v2LipsyncOperationInputHash({
        runId: input.lipsyncOperation.runId,
        preSync: input.preSync,
        sourceFinal,
      })
  ) {
    return false;
  }
  return (
    !input.requireCanonicalOutput ||
    v2LipsyncProofMatchesFinal({
      runId: input.lipsyncOperation.runId,
      finalGeneration: input.finalGeneration,
      lipsync: input.lipsyncOperation,
    })
  );
}

/** Build the only acceptable base receipt for one Combined candidate. */
export function buildLampCombinedCandidateQualificationReceipt(input: {
  iteration: LampCombinedIteration;
  generationOperation: ProviderOperation;
  evaluationOperation: PaidOperation;
  planId: string;
  planHash: string;
  sourceHasAudio: boolean | undefined;
  syncEvidence: LampCombinedSyncEvidence;
  lipsyncOperation?: PaidOperation | null;
  recordedAt: number;
}): LampCombinedCandidateQualificationReceipt {
  if (!timestamp(input.recordedAt)) {
    throw new Error("Lamp Combined candidate recordedAt is invalid.");
  }
  const generation = lampCombinedGenerationProof(
    input.generationOperation,
    input.iteration
  );
  const evaluation = lampCombinedEvaluationProof(
    input.evaluationOperation,
    input.iteration,
    input.planId,
    input.planHash
  );
  if (!generation || !evaluation) {
    throw new Error(
      "Lamp Combined candidate receipt requires exact completed generation and evaluation journals."
    );
  }

  let audio: LampCombinedCandidateAudioQualification;
  let sync: LampCombinedCandidateSyncQualification;
  let normalization: LampCombinedLipsyncQualification | undefined;
  if (input.sourceHasAudio === false) {
    if (input.syncEvidence.outcome !== "silent_source") {
      throw new Error("A silent Combined source requires an explicit SyncNet skip.");
    }
    audio = { outcome: "silent_source", reason: "source_has_no_audio" };
    sync = { outcome: "not_required", reason: "silent_source" };
  } else if (
    input.sourceHasAudio === true &&
    input.generationOperation.result?.audioVerified === true
  ) {
    if (input.syncEvidence.outcome !== "measured") {
      throw new Error("An audio-bearing Combined take requires measured SyncNet evidence.");
    }
    const lipsyncResult = input.lipsyncOperation?.result;
    if (
      !input.lipsyncOperation ||
      !isLampCombinedLipsyncResult(lipsyncResult, input.iteration) ||
      !lampCombinedLipsyncProofMatchesGeneration({
        runId: input.lipsyncOperation.runId,
        iteration: input.iteration,
        generation: input.generationOperation,
        operation: input.lipsyncOperation,
      }) ||
      !v2SyncMetricsEqual(input.syncEvidence.metrics, lipsyncResult.postSync) ||
      !v2SyncMetricsEqual(
        input.syncEvidence.sourceSync,
        lipsyncResult.sourceSync
      )
    ) {
      throw new Error(
        "An audio-bearing Combined take requires its exact mandatory Lipsync proof."
      );
    }
    const verdict = v2SyncVerdict(
      input.syncEvidence.metrics,
      input.syncEvidence.sourceSync
    );
    const mandatoryVerdict = lampCombinedMandatorySyncVerdict(lipsyncResult);
    audio = {
      outcome: "verified",
      reason: "canonical_source_audio_verified",
    };
    sync = {
      outcome: verdict.pass && mandatoryVerdict.pass ? "passed" : "failed",
      policy: "combined_source_relative_v1",
      mode: verdict.mode,
      reason: mandatoryVerdict.pass
        ? `${verdict.reason}; ${mandatoryVerdict.reason}`
        : mandatoryVerdict.reason,
      metrics: input.syncEvidence.metrics,
      sourceSync: input.syncEvidence.sourceSync,
    };
    normalization = {
      operationId: lampCombinedLipsyncOperationId(input.iteration),
      inputHash: input.lipsyncOperation.inputHash,
      predictionId: lipsyncResult.predictionId,
      artifactIdentityHash: canonicalInputHash({
        operationId: input.lipsyncOperation.id,
        inputHash: input.lipsyncOperation.inputHash,
        result: lipsyncResult,
      }),
      videoUrl: lipsyncResult.videoUrl,
      videoSha256: lipsyncResult.videoSha256,
      audioMd5: lipsyncResult.audioMd5,
      recordedAt: input.recordedAt,
      preSync: lipsyncResult.preSync,
      postSync: lipsyncResult.postSync,
      sourceSync: lipsyncResult.sourceSync,
      windows: lipsyncResult.windows,
    };
  } else {
    if (input.syncEvidence.outcome !== "audio_unverified") {
      throw new Error(
        "An unverified Combined audio track must record that SyncNet was not run."
      );
    }
    audio = {
      outcome: "failed",
      reason: "canonical_source_audio_unverified",
    };
    sync = { outcome: "not_run", reason: "audio_unverified" };
  }

  return {
    version: LAMP_COMBINED_CANDIDATE_RECEIPT_VERSION,
    iteration: input.iteration,
    generation,
    evaluation,
    recordedAt: input.recordedAt,
    audio,
    sync,
    ...(normalization ? { normalization } : {}),
  };
}

/** @deprecated Legacy pre-normalization receipt migration helper. */
export function appendLampCombinedRepairQualification(input: {
  receipt: LampCombinedCandidateQualificationReceipt;
  finalGeneration: ProviderOperation;
  lipsyncOperation: PaidOperation;
  canonicalSourceSync: unknown;
  recordedAt: number;
}): LampCombinedCandidateQualificationReceipt {
  if (
    input.receipt.iteration !== 2 ||
    input.receipt.repair ||
    input.receipt.sync.outcome !== "failed" ||
    !timestamp(input.recordedAt)
  ) {
    throw new Error("Only one failed Combined Final may append one repair proof.");
  }
  const generation = lampCombinedGenerationProof(input.finalGeneration, 2);
  const sourceFinal = v2FinalGenerationProof(input.finalGeneration);
  const result = input.lipsyncOperation.result;
  const verdict = isLipsyncOperationResult(result)
    ? v2SyncVerdict(result.postSync, input.receipt.sync.sourceSync)
    : null;
  if (
    !generation ||
    !sourceFinal ||
    !proofsEqual(generation, input.receipt.generation) ||
    input.lipsyncOperation.id !== LIPSYNC_OPERATION_ID ||
    input.lipsyncOperation.status !== "completed" ||
    !isLipsyncOperationResult(result) ||
    !v2FinalGenerationProofsEqual(result.sourceFinal, sourceFinal) ||
    !verdict ||
    !combinedLipsyncProofMatchesFinal({
      finalGeneration: input.finalGeneration,
      lipsyncOperation: input.lipsyncOperation,
      preSync: input.receipt.sync.metrics,
      requireCanonicalOutput: verdict.pass,
    }) ||
    !v2CandidateSourceSyncMatchesCanonical(
      input.receipt.sync.sourceSync,
      input.canonicalSourceSync
    )
  ) {
    throw new Error("Combined Final repair is not bound to its exact candidate.");
  }
  return {
    ...input.receipt,
    repair: {
      operationId: LIPSYNC_OPERATION_ID,
      inputHash: input.lipsyncOperation.inputHash,
      predictionId: result.predictionId,
      artifactIdentityHash: canonicalInputHash({
        operationId: input.lipsyncOperation.id,
        inputHash: input.lipsyncOperation.inputHash,
        result,
      }),
      recordedAt: input.recordedAt,
      audio: {
        outcome: "verified",
        reason: "canonical_source_audio_verified",
      },
      sync: {
        outcome: verdict.pass ? "passed" : "failed",
        policy: "combined_source_relative_v1",
        mode: verdict.mode,
        reason: verdict.reason,
        metrics: result.postSync,
        sourceSync: input.receipt.sync.sourceSync,
      },
    },
  };
}

function isGenerationProof(value: unknown): value is LampCombinedGenerationProof {
  return (
    isRecord(value) &&
    (value.iteration === 1 || value.iteration === 2) &&
    value.operationId === generationOperationId(value.iteration) &&
    typeof value.providerInteractionId === "string" &&
    value.providerInteractionId.length > 0 &&
    typeof value.promptHash === "string" &&
    SHA256_RE.test(value.promptHash) &&
    typeof value.artifactIdentityHash === "string" &&
    SHA256_RE.test(value.artifactIdentityHash)
  );
}

function isEvaluationProof(value: unknown): value is LampCombinedEvaluationProof {
  return (
    isRecord(value) &&
    typeof value.operationId === "string" &&
    typeof value.inputHash === "string" &&
    SHA256_RE.test(value.inputHash) &&
    typeof value.artifactIdentityHash === "string" &&
    SHA256_RE.test(value.artifactIdentityHash)
  );
}

function isSourceSync(value: unknown): value is SyncNetMetrics | null {
  return value === null || isSyncNetMetrics(value);
}

function isCombinedSyncWindow(value: unknown): value is LampCombinedSyncWindowEvidence {
  return (
    isRecord(value) &&
    typeof value.startSec === "number" &&
    Number.isFinite(value.startSec) &&
    value.startSec >= 0 &&
    typeof value.durationSec === "number" &&
    Number.isFinite(value.durationSec) &&
    value.durationSec > 0 &&
    isSyncNetMetrics(value.source) &&
    isSyncNetMetrics(value.candidate)
  );
}

function isNormalizationQualification(
  value: unknown,
  iteration: LampCombinedIteration
): value is LampCombinedLipsyncQualification {
  return (
    isRecord(value) &&
    value.operationId === lampCombinedLipsyncOperationId(iteration) &&
    typeof value.inputHash === "string" &&
    SHA256_RE.test(value.inputHash) &&
    typeof value.predictionId === "string" &&
    value.predictionId.length > 0 &&
    typeof value.artifactIdentityHash === "string" &&
    SHA256_RE.test(value.artifactIdentityHash) &&
    typeof value.videoUrl === "string" &&
    value.videoUrl.length > 0 &&
    typeof value.videoSha256 === "string" &&
    SHA256_RE.test(value.videoSha256) &&
    typeof value.audioMd5 === "string" &&
    /^[a-f0-9]{32}$/.test(value.audioMd5) &&
    timestamp(value.recordedAt) &&
    isSyncNetMetrics(value.preSync) &&
    isSyncNetMetrics(value.postSync) &&
    isSyncNetMetrics(value.sourceSync) &&
    Array.isArray(value.windows) &&
    value.windows.length > 0 &&
    value.windows.every(isCombinedSyncWindow)
  );
}

/** Structural validation used by storage before it can consult provider journals. */
export function isLampCombinedCandidateQualificationReceipt(
  value: unknown
): value is LampCombinedCandidateQualificationReceipt {
  if (!isRecord(value)) return false;
  if (
    value.version !== LAMP_COMBINED_CANDIDATE_RECEIPT_VERSION ||
    (value.iteration !== 1 && value.iteration !== 2) ||
    !isGenerationProof(value.generation) ||
    value.generation.iteration !== value.iteration ||
    !isEvaluationProof(value.evaluation) ||
    value.evaluation.operationId !==
      lampCombinedEvaluationOperationId(value.iteration) ||
    !timestamp(value.recordedAt) ||
    !isRecord(value.audio) ||
    !isRecord(value.sync)
  ) {
    return false;
  }
  const audioOutcome = value.audio.outcome;
  const syncOutcome = value.sync.outcome;
  if (
    !["verified", "silent_source", "failed"].includes(
      String(audioOutcome)
    ) ||
    !["passed", "failed", "not_required", "not_run"].includes(
      String(syncOutcome)
    )
  ) {
    return false;
  }
  if (syncOutcome === "passed" || syncOutcome === "failed") {
    if (
      value.sync.policy !== "combined_source_relative_v1" ||
      (value.sync.mode !== "absolute" && value.sync.mode !== "source_relative") ||
      typeof value.sync.reason !== "string" ||
      !isSyncNetMetrics(value.sync.metrics) ||
      !isSourceSync(value.sync.sourceSync)
    ) {
      return false;
    }
  }
  // Receipts persisted before mandatory two-take normalization have verified
  // audio and sync evidence but no `normalization` field. They remain valid
  // read-only history; eligibility and settlement reject them below.
  if (
    (value.normalization !== undefined &&
      (audioOutcome !== "verified" ||
        !isNormalizationQualification(value.normalization, value.iteration))) ||
    (audioOutcome === "silent_source" && value.normalization !== undefined)
  ) {
    return false;
  }
  if (value.repair !== undefined) {
    const repair = value.repair;
    if (
      value.iteration !== 2 ||
      syncOutcome !== "failed" ||
      !isRecord(repair) ||
      repair.operationId !== LIPSYNC_OPERATION_ID ||
      typeof repair.inputHash !== "string" ||
      !SHA256_RE.test(repair.inputHash) ||
      typeof repair.predictionId !== "string" ||
      repair.predictionId.length < 1 ||
      typeof repair.artifactIdentityHash !== "string" ||
      !SHA256_RE.test(repair.artifactIdentityHash) ||
      !timestamp(repair.recordedAt) ||
      !isRecord(repair.audio) ||
      repair.audio.outcome !== "verified" ||
      !isRecord(repair.sync) ||
      (repair.sync.outcome !== "passed" && repair.sync.outcome !== "failed") ||
      repair.sync.policy !== "combined_source_relative_v1" ||
      (repair.sync.mode !== "absolute" &&
        repair.sync.mode !== "source_relative") ||
      typeof repair.sync.reason !== "string" ||
      !isSyncNetMetrics(repair.sync.metrics) ||
      !isSourceSync(repair.sync.sourceSync)
    ) {
      return false;
    }
  }
  return true;
}

export function lampCombinedCandidateReceiptToDeliveryCandidate(
  receipt: LampCombinedCandidateQualificationReceipt
): LampCombinedDeliveryCandidate {
  const audioStatus =
    receipt.audio.outcome === "verified"
      ? "verified"
      : receipt.audio.outcome === "silent_source"
        ? "silent-source"
        : "failed";
  const effectiveSync = receipt.repair?.sync ?? receipt.sync;
  const syncStatus =
    receipt.audio.outcome === "verified" && !receipt.normalization
      ? "unverified"
      : effectiveSync.outcome === "passed"
      ? "pass"
      : effectiveSync.outcome === "not_required"
        ? "not-required"
        : effectiveSync.outcome === "failed"
          ? "fail"
          : "unverified";
  return {
    iteration: receipt.iteration,
    generationComplete: true,
    audioStatus,
    syncStatus,
    evaluationComplete: true,
  };
}

export function lampCombinedCandidateReceiptEligible(
  receipt: LampCombinedCandidateQualificationReceipt
): boolean {
  return (
    lampCombinedCandidateIneligibility(
      lampCombinedCandidateReceiptToDeliveryCandidate(receipt)
    ) === null
  );
}

/** Exact artifact the human sees; current receipts always prefer normalization. */
export function lampCombinedCandidateArtifactIdentityHash(
  receipt: LampCombinedCandidateQualificationReceipt
): string {
  if (!isLampCombinedCandidateQualificationReceipt(receipt)) {
    throw new Error("Lamp Combined candidate receipt is invalid.");
  }
  return (
    receipt.normalization?.artifactIdentityHash ??
    receipt.repair?.artifactIdentityHash ??
    receipt.generation.artifactIdentityHash
  );
}

/**
 * Re-prove a pre-normalization receipt for read-only history. This does not
 * make the take eligible: the delivery projection still requires the exact
 * mandatory normalization proof introduced by the current contract.
 */
export function lampCombinedLegacyCandidateReceiptMatches(input: {
  receipt: LampCombinedCandidateQualificationReceipt;
  generationOperation: ProviderOperation;
  evaluationOperation: PaidOperation;
  planId: string;
  planHash: string;
  sourceHasAudio: boolean | undefined;
  canonicalSourceSync: unknown;
}): boolean {
  const receipt = input.receipt;
  if (
    !isLampCombinedCandidateQualificationReceipt(receipt) ||
    receipt.normalization !== undefined ||
    receipt.repair !== undefined
  ) {
    return false;
  }
  const generation = lampCombinedGenerationProof(
    input.generationOperation,
    receipt.iteration
  );
  const evaluation = lampCombinedEvaluationProof(
    input.evaluationOperation,
    receipt.iteration,
    input.planId,
    input.planHash
  );
  if (
    !generation ||
    !evaluation ||
    !proofsEqual(generation, receipt.generation) ||
    !evaluationProofsEqual(evaluation, receipt.evaluation)
  ) {
    return false;
  }
  if (input.sourceHasAudio === false) {
    return (
      receipt.audio.outcome === "silent_source" &&
      receipt.sync.outcome === "not_required"
    );
  }
  return (
    input.sourceHasAudio === true &&
    input.generationOperation.result?.audioVerified === true &&
    receipt.audio.outcome === "verified" &&
    (receipt.sync.outcome === "passed" || receipt.sync.outcome === "failed") &&
    v2CandidateSourceSyncMatchesCanonical(
      receipt.sync.sourceSync,
      input.canonicalSourceSync
    )
  );
}

/** Re-prove a persisted receipt against canonical journals at settlement. */
export function lampCombinedCandidateReceiptMatches(input: {
  receipt: LampCombinedCandidateQualificationReceipt;
  generationOperation: ProviderOperation;
  evaluationOperation: PaidOperation;
  planId: string;
  planHash: string;
  sourceHasAudio: boolean | undefined;
  canonicalSourceSync: unknown;
  lipsyncOperation?: PaidOperation | null;
}): boolean {
  const receipt = input.receipt;
  if (!isLampCombinedCandidateQualificationReceipt(receipt)) return false;
  const generation = lampCombinedGenerationProof(
    input.generationOperation,
    receipt.iteration
  );
  const evaluation = lampCombinedEvaluationProof(
    input.evaluationOperation,
    receipt.iteration,
    input.planId,
    input.planHash
  );
  if (
    !generation ||
    !evaluation ||
    !proofsEqual(generation, receipt.generation) ||
    !evaluationProofsEqual(evaluation, receipt.evaluation)
  ) {
    return false;
  }
  if (input.sourceHasAudio === false) {
    if (
      receipt.audio.outcome !== "silent_source" ||
      receipt.sync.outcome !== "not_required"
    ) {
      return false;
    }
    if (receipt.normalization || input.lipsyncOperation) return false;
  } else if (input.sourceHasAudio === true) {
    if (
      receipt.audio.outcome !== "verified" ||
      input.generationOperation.result?.audioVerified !== true ||
      (receipt.sync.outcome !== "passed" && receipt.sync.outcome !== "failed") ||
      !v2CandidateSourceSyncMatchesCanonical(
        receipt.sync.sourceSync,
        input.canonicalSourceSync
      ) ||
      !receipt.normalization ||
      !input.lipsyncOperation ||
      !lampCombinedLipsyncProofMatchesGeneration({
        runId: input.lipsyncOperation.runId,
        iteration: receipt.iteration,
        generation: input.generationOperation,
        operation: input.lipsyncOperation,
      })
    ) {
      return false;
    }
    const normalized = input.lipsyncOperation.result;
    if (
      !isLampCombinedLipsyncResult(normalized, receipt.iteration) ||
      input.lipsyncOperation.inputHash !== receipt.normalization.inputHash ||
      normalized.predictionId !== receipt.normalization.predictionId ||
      normalized.videoUrl !== receipt.normalization.videoUrl ||
      normalized.videoSha256 !== receipt.normalization.videoSha256 ||
      normalized.audioMd5 !== receipt.normalization.audioMd5 ||
      canonicalInputHash({
        operationId: input.lipsyncOperation.id,
        inputHash: input.lipsyncOperation.inputHash,
        result: normalized,
      }) !== receipt.normalization.artifactIdentityHash ||
      !v2SyncMetricsEqual(normalized.preSync, receipt.normalization.preSync) ||
      !v2SyncMetricsEqual(normalized.postSync, receipt.normalization.postSync) ||
      !v2SyncMetricsEqual(normalized.sourceSync, receipt.normalization.sourceSync) ||
      !lampCombinedMandatorySyncVerdict(normalized).pass ||
      receipt.sync.outcome !== "passed"
    ) {
      return false;
    }
  } else {
    return false;
  }
  if (receipt.normalization) return receipt.repair === undefined;
  return false;
}
