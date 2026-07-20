import { canonicalInputHash } from "./canonical-input-hash.ts";
import type { LampChainStage } from "./lamp-chain.ts";
import type { ProviderOperation } from "./types.ts";

export const LAMP_CHAIN_STAGE_RECEIPT_VERSION =
  "lamp-chain-stage-receipt-v1" as const;

const SHA256_RE = /^[a-f0-9]{64}$/;

/** Mirrors LampCombinedGenerationProof; iteration equals the stage number. */
export interface LampChainGenerationProof {
  operationId: string;
  iteration: number;
  providerInteractionId: string;
  promptHash: string;
  artifactIdentityHash: string;
}

/** Same qualification union Combined records for canonical source audio. */
export type LampChainStageAudioQualification =
  | { outcome: "verified"; reason: "canonical_source_audio_verified" }
  | { outcome: "silent_source"; reason: "source_has_no_audio" }
  | { outcome: "failed"; reason: "canonical_source_audio_unverified" };

/**
 * Immutable structural proof for one completed chain stage: the exact
 * generation journal identity plus canonical-audio qualification. It
 * deliberately carries NO evaluation, NO sync, and NO repair evidence — chain
 * evaluations are detached post-delivery journals and SyncNet is
 * measurement-only for chain, so neither may ever appear in delivery proof.
 */
export interface LampChainStageReceipt {
  version: typeof LAMP_CHAIN_STAGE_RECEIPT_VERSION;
  /** 1-based; doubles as the generation iteration for this stage. */
  stage: number;
  stageKind: LampChainStage;
  generation: LampChainGenerationProof;
  audio: LampChainStageAudioQualification;
  recordedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Loose persistence bound; plan binding enforces 1..stageOrder.length (≤ 4). */
function isChainStageNumber(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 8
  );
}

function isLampChainStageKind(value: unknown): value is LampChainStage {
  return (
    value === "background" ||
    value === "lamp" ||
    value === "beautify" ||
    value === "iris"
  );
}

function generationOperationId(stage: number): string {
  return `video-generation:${stage}`;
}

/** Project an exact provider prompt/interaction/artifact identity. */
export function lampChainGenerationProof(
  operation: unknown,
  stage: number
): LampChainGenerationProof | null {
  if (!isChainStageNumber(stage) || !isRecord(operation)) return null;
  const journal = operation as unknown as ProviderOperation;
  if (
    journal.id !== generationOperationId(stage) ||
    journal.provider !== "gemini" ||
    journal.kind !== "video_generation" ||
    journal.iteration !== stage ||
    journal.status !== "completed" ||
    typeof journal.providerInteractionId !== "string" ||
    journal.providerInteractionId.length < 1 ||
    typeof journal.renderedPrompt !== "string" ||
    journal.renderedPrompt.length < 1 ||
    !journal.result ||
    typeof journal.result.videoUrl !== "string" ||
    journal.result.videoUrl.length < 1 ||
    typeof journal.result.rawUrl !== "string" ||
    journal.result.rawUrl.length < 1 ||
    typeof journal.result.durationSec !== "number" ||
    !Number.isFinite(journal.result.durationSec) ||
    journal.result.durationSec <= 0 ||
    typeof journal.result.audioVerified !== "boolean"
  ) {
    return null;
  }
  const promptHash = canonicalInputHash(journal.renderedPrompt);
  return {
    operationId: journal.id,
    iteration: stage,
    providerInteractionId: journal.providerInteractionId,
    promptHash,
    artifactIdentityHash: canonicalInputHash({
      operationId: journal.id,
      provider: journal.provider,
      kind: journal.kind,
      iteration: stage,
      providerInteractionId: journal.providerInteractionId,
      promptHash,
      artifact: {
        videoUrl: journal.result.videoUrl,
        rawUrl: journal.result.rawUrl,
        durationSec: journal.result.durationSec,
        audioVerified: journal.result.audioVerified,
      },
    }),
  };
}

/**
 * Build the only acceptable receipt for one chain stage. Unverified audio
 * THROWS: a stage receipt may only exist for a delivery-eligible stage.
 */
export function buildLampChainStageReceipt(input: {
  stage: number;
  stageKind: LampChainStage;
  generationOperation: unknown;
  sourceHasAudio: boolean;
  recordedAt: number;
}): LampChainStageReceipt {
  if (!isChainStageNumber(input.stage)) {
    throw new Error("Lamp Chain stage receipt stage is invalid.");
  }
  if (!isLampChainStageKind(input.stageKind)) {
    throw new Error("Lamp Chain stage receipt stage kind is invalid.");
  }
  if (typeof input.sourceHasAudio !== "boolean") {
    throw new Error("Lamp Chain stage receipt requires the source audio flag.");
  }
  if (!timestamp(input.recordedAt)) {
    throw new Error("Lamp Chain stage receipt recordedAt is invalid.");
  }
  const generation = lampChainGenerationProof(
    input.generationOperation,
    input.stage
  );
  if (!generation) {
    throw new Error(
      "Lamp Chain stage receipt requires one exact completed generation journal."
    );
  }
  const journal = input.generationOperation as ProviderOperation;

  let audio: LampChainStageAudioQualification;
  if (input.sourceHasAudio === false) {
    audio = { outcome: "silent_source", reason: "source_has_no_audio" };
  } else if (journal.result?.audioVerified === true) {
    audio = { outcome: "verified", reason: "canonical_source_audio_verified" };
  } else {
    // Fail closed: an unverified track never earns delivery proof.
    throw new Error(
      "Lamp Chain stage audio is unverified; no stage receipt may be recorded."
    );
  }

  return {
    version: LAMP_CHAIN_STAGE_RECEIPT_VERSION,
    stage: input.stage,
    stageKind: input.stageKind,
    generation,
    audio,
    recordedAt: input.recordedAt,
  };
}

function isGenerationProof(value: unknown): value is LampChainGenerationProof {
  return (
    isRecord(value) &&
    isChainStageNumber(value.iteration) &&
    value.operationId === generationOperationId(value.iteration) &&
    typeof value.providerInteractionId === "string" &&
    value.providerInteractionId.length > 0 &&
    typeof value.promptHash === "string" &&
    SHA256_RE.test(value.promptHash) &&
    typeof value.artifactIdentityHash === "string" &&
    SHA256_RE.test(value.artifactIdentityHash)
  );
}

/** Structural validation used by storage before it can consult provider journals. */
export function isLampChainStageReceipt(
  value: unknown
): value is LampChainStageReceipt {
  if (!isRecord(value)) return false;
  if (
    value.version !== LAMP_CHAIN_STAGE_RECEIPT_VERSION ||
    !isChainStageNumber(value.stage) ||
    !isLampChainStageKind(value.stageKind) ||
    !isGenerationProof(value.generation) ||
    value.generation.iteration !== value.stage ||
    !timestamp(value.recordedAt) ||
    !isRecord(value.audio)
  ) {
    return false;
  }
  const audio = value.audio;
  return (
    (audio.outcome === "verified" &&
      audio.reason === "canonical_source_audio_verified") ||
    (audio.outcome === "silent_source" &&
      audio.reason === "source_has_no_audio") ||
    (audio.outcome === "failed" &&
      audio.reason === "canonical_source_audio_unverified")
  );
}

function proofsEqual(
  left: LampChainGenerationProof,
  right: LampChainGenerationProof
): boolean {
  return (
    left.operationId === right.operationId &&
    left.iteration === right.iteration &&
    left.providerInteractionId === right.providerInteractionId &&
    left.promptHash === right.promptHash &&
    left.artifactIdentityHash === right.artifactIdentityHash
  );
}

/** Re-prove a persisted stage receipt against canonical journals at settlement. */
export function lampChainStageReceiptMatches(input: {
  receipt: LampChainStageReceipt;
  generationOperation: unknown;
  expectedRenderedPrompt: string;
  stage: number;
  stageKind: LampChainStage;
  sourceHasAudio: boolean;
}): boolean {
  const receipt = input.receipt;
  if (!isLampChainStageReceipt(receipt)) return false;
  if (receipt.stage !== input.stage || receipt.stageKind !== input.stageKind) {
    return false;
  }
  const generation = lampChainGenerationProof(
    input.generationOperation,
    input.stage
  );
  if (!generation || !proofsEqual(generation, receipt.generation)) {
    return false;
  }
  const journal = input.generationOperation as ProviderOperation;
  // The receipt binds this stage's exact FROZEN prompt, not merely any take.
  if (journal.renderedPrompt !== input.expectedRenderedPrompt) return false;
  if (input.sourceHasAudio === false) {
    return receipt.audio.outcome === "silent_source";
  }
  // Delivery law at settlement: an audio-bearing stage must prove "verified".
  return (
    receipt.audio.outcome === "verified" &&
    journal.result?.audioVerified === true
  );
}
