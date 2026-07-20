import { canonicalInputHash } from "./canonical-input-hash.ts";
import type { LampCombinedIteration } from "./lamp-combined.ts";
import type { PaidOperation, ProviderOperation } from "./types.ts";
import {
  isSyncNetMetrics,
  LIPSYNC_MODEL,
  v2SyncMetricsEqual,
  type SyncNetMetrics,
} from "./v2-sync.ts";
import { lampCombinedLipsyncOperationId } from "./lamp-combined-lipsync-verdict.ts";
export {
  lampCombinedLipsyncOperationId,
  lampCombinedMandatorySyncVerdict,
  LAMP_COMBINED_MIN_SPEECH_WINDOW,
  type LampCombinedMandatorySyncVerdict,
} from "./lamp-combined-lipsync-verdict.ts";

export const LAMP_COMBINED_LIPSYNC_RESULT_VERSION =
  "lamp-combined-lipsync-v1" as const;
export const LAMP_COMBINED_SYNC_WINDOW_SEC = 3;
export const LAMP_COMBINED_SYNC_WINDOW_STRIDE_SEC = 2.5;

const SHA256_RE = /^[a-f0-9]{64}$/;
const MD5_RE = /^[a-f0-9]{32}$/;

export interface LampCombinedLipsyncGenerationBinding {
  operationId: string;
  iteration: LampCombinedIteration;
  providerInteractionId: string;
  promptHash: string;
  artifactIdentityHash: string;
}

export interface LampCombinedSyncWindowEvidence {
  startSec: number;
  durationSec: number;
  source: SyncNetMetrics;
  candidate: SyncNetMetrics;
}

export interface LampCombinedLipsyncResult {
  version: typeof LAMP_COMBINED_LIPSYNC_RESULT_VERSION;
  iteration: LampCombinedIteration;
  predictionId: string;
  model: typeof LIPSYNC_MODEL;
  videoUrl: string;
  videoSha256: string;
  audioMd5: string;
  billableDurationSec: number;
  costUsd: number;
  audioVerified: true;
  preSync: SyncNetMetrics;
  postSync: SyncNetMetrics;
  sourceSync: SyncNetMetrics;
  windows: LampCombinedSyncWindowEvidence[];
  sourceGeneration: LampCombinedLipsyncGenerationBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function lampCombinedLipsyncGenerationBinding(
  value: unknown,
  iteration: LampCombinedIteration
): LampCombinedLipsyncGenerationBinding | null {
  if (!isRecord(value)) return null;
  const operation = value as unknown as ProviderOperation;
  if (
    operation.id !== `video-generation:${iteration}` ||
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
    operation.result.audioVerified !== true
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

export function lampCombinedLipsyncCanonicalInput(input: {
  runId: string;
  iteration: LampCombinedIteration;
  sourceGeneration: LampCombinedLipsyncGenerationBinding;
}) {
  if (input.sourceGeneration.iteration !== input.iteration) {
    throw new Error("Combined Lipsync generation binding has the wrong take.");
  }
  return {
    version: "lamp-combined-lipsync-input-v2" as const,
    runId: input.runId,
    iteration: input.iteration,
    operationId: lampCombinedLipsyncOperationId(input.iteration),
    model: LIPSYNC_MODEL,
    sourceGeneration: input.sourceGeneration,
  };
}

export function lampCombinedLipsyncInputHash(
  input: Parameters<typeof lampCombinedLipsyncCanonicalInput>[0]
): string {
  return canonicalInputHash(lampCombinedLipsyncCanonicalInput(input));
}

function generationBindingsEqual(
  left: LampCombinedLipsyncGenerationBinding,
  right: LampCombinedLipsyncGenerationBinding
): boolean {
  return (
    left.operationId === right.operationId &&
    left.iteration === right.iteration &&
    left.providerInteractionId === right.providerInteractionId &&
    left.promptHash === right.promptHash &&
    left.artifactIdentityHash === right.artifactIdentityHash
  );
}

function isWindowEvidence(value: unknown): value is LampCombinedSyncWindowEvidence {
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

export function isLampCombinedLipsyncResult(
  value: unknown,
  iteration?: LampCombinedIteration
): value is LampCombinedLipsyncResult {
  if (!isRecord(value)) return false;
  return (
    value.version === LAMP_COMBINED_LIPSYNC_RESULT_VERSION &&
    (value.iteration === 1 || value.iteration === 2) &&
    (iteration === undefined || value.iteration === iteration) &&
    typeof value.predictionId === "string" &&
    value.predictionId.length > 0 &&
    value.model === LIPSYNC_MODEL &&
    typeof value.videoUrl === "string" &&
    value.videoUrl.length > 0 &&
    typeof value.videoSha256 === "string" &&
    SHA256_RE.test(value.videoSha256) &&
    typeof value.audioMd5 === "string" &&
    MD5_RE.test(value.audioMd5) &&
    typeof value.billableDurationSec === "number" &&
    Number.isFinite(value.billableDurationSec) &&
    value.billableDurationSec > 0 &&
    typeof value.costUsd === "number" &&
    Number.isFinite(value.costUsd) &&
    value.costUsd >= 0 &&
    value.audioVerified === true &&
    isSyncNetMetrics(value.preSync) &&
    isSyncNetMetrics(value.postSync) &&
    isSyncNetMetrics(value.sourceSync) &&
    Array.isArray(value.windows) &&
    value.windows.length > 0 &&
    value.windows.every(isWindowEvidence) &&
    isRecord(value.sourceGeneration) &&
    value.sourceGeneration.iteration === value.iteration &&
    typeof value.sourceGeneration.operationId === "string" &&
    typeof value.sourceGeneration.providerInteractionId === "string" &&
    typeof value.sourceGeneration.promptHash === "string" &&
    SHA256_RE.test(value.sourceGeneration.promptHash) &&
    typeof value.sourceGeneration.artifactIdentityHash === "string" &&
    SHA256_RE.test(value.sourceGeneration.artifactIdentityHash)
  );
}

export function lampCombinedLipsyncProofMatchesGeneration(input: {
  runId: string;
  iteration: LampCombinedIteration;
  generation: ProviderOperation;
  operation: PaidOperation;
}): boolean {
  const sourceGeneration = lampCombinedLipsyncGenerationBinding(
    input.generation,
    input.iteration
  );
  const result = input.operation.result;
  return Boolean(
    sourceGeneration &&
      input.operation.id === lampCombinedLipsyncOperationId(input.iteration) &&
      input.operation.runId === input.runId &&
      input.operation.provider === "replicate" &&
      input.operation.kind === "lipsync" &&
      input.operation.iteration === input.iteration &&
      input.operation.status === "completed" &&
      isLampCombinedLipsyncResult(result, input.iteration) &&
      input.operation.providerOperationId === result.predictionId &&
      generationBindingsEqual(result.sourceGeneration, sourceGeneration) &&
      input.operation.inputHash ===
        lampCombinedLipsyncInputHash({
          runId: input.runId,
          iteration: input.iteration,
          sourceGeneration,
        })
  );
}

export function lampCombinedLipsyncResultsEqual(
  left: LampCombinedLipsyncResult,
  right: LampCombinedLipsyncResult
): boolean {
  return (
    left.iteration === right.iteration &&
    left.predictionId === right.predictionId &&
    left.videoUrl === right.videoUrl &&
    left.videoSha256 === right.videoSha256 &&
    left.audioMd5 === right.audioMd5 &&
    v2SyncMetricsEqual(left.preSync, right.preSync) &&
    v2SyncMetricsEqual(left.postSync, right.postSync) &&
    v2SyncMetricsEqual(left.sourceSync, right.sourceSync)
  );
}
