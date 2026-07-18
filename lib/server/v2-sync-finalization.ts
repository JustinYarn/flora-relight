import "server-only";

import fsp from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  audioStreamMd5,
  conformVideoDuration,
  probe,
  remuxFullAudio,
  transcodeAudioToWav,
} from "@/lib/server/ffmpeg";
import { audioIntegrityDurationsAgree } from "@/lib/server/audio-integrity";
import {
  beginPaidOperation,
  completePaidOperation,
  markPaidOperationReconcileRequired,
  paidOperationBlockedMessage,
  persistPaidOperationProviderId,
} from "@/lib/server/paid-operation";
import {
  createLipsyncPrediction,
  getLipsyncPrediction,
  uploadLipsyncInputs,
  LipsyncCreateRejectedError,
  type PreparedLipsyncInputs,
} from "@/lib/server/replicate-lipsync";
import { RAW_VIDEO_TRAILING_PADDING_TOLERANCE_SEC } from "@/lib/server/audio-integrity";
import { analyzeVideoSync, v2SyncConfigIssue } from "@/lib/server/syncnet";
import {
  getStorage,
  scratchMediaPath,
  type StorageDriver,
} from "@/lib/server/storage";
import { lipsync2ProCostFromDuration } from "@/lib/cost";
import { resolveSourceUrl } from "@/lib/server/gemini";
import {
  isLipsyncOperationResult,
  LIPSYNC_MODEL,
  LIPSYNC_OPERATION_ID,
  V2_FINAL_GENERATION_OPERATION_ID,
  v2FinalGenerationProof,
  v2LipsyncCanonicalInput,
  v2LipsyncOperationInputHash,
  v2LipsyncProofMatchesFinal,
  v2SyncVerdict,
  type LipsyncOperationResult,
  type SyncNetMetrics,
} from "@/lib/v2-sync";

const CANDIDATE_NAME = "relit-v2-candidate.mp4";
const CANONICAL_NAME = "relit-v2.mp4";
const RAW_LIPSYNC_NAME = "lipsync-v2.mp4";
const CONFORMED_NAME = "lipsync-v2-conformed.mp4";
const REPAIRED_NAME = "lipsync-v2-remuxed.mp4";
const SOURCE_AUDIO_NAME = "source-audio.m4a";

export type V2LipsyncCheckpoint =
  | { state: "unclaimed" }
  | { state: "started"; predictionId: string }
  | { state: "completed"; result: LipsyncOperationResult }
  | { state: "blocked"; reason: string };

export type V2CandidateSyncCheck =
  | {
      skipped: true;
      videoUrl: string;
      skipReason: "silent_source";
    }
  | {
      skipped: false;
      videoUrl: string;
      metrics: SyncNetMetrics;
      /**
       * Durable baseline of the ORIGINAL source, measured/persisted by this
       * same analysis. Null only when the source itself cannot be analyzed —
       * every gate then falls back to the absolute bar.
       */
      sourceSync: SyncNetMetrics | null;
    };

export type V2LipsyncPollResult =
  | { done: false }
  | { done: true; outputUrl: string };

/**
 * Stream a Replicate delivery URL to disk. The Gemini Files downloader must
 * never be used here: it parses its input as a Files-API name (split on
 * "files/") and throws deterministically on any external https URL — which
 * stranded billed repairs in reconcile_required before this helper existed.
 */
async function downloadReplicateOutput(
  url: string,
  destPath: string
): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Lipsync output download failed: HTTP ${response.status}${
        response.body ? "" : " (empty body)"
      }`
    );
  }
  await pipeline(
    Readable.fromWeb(response.body as import("stream/web").ReadableStream),
    createWriteStream(destPath)
  );
}

async function cleanupRemoteScratch(
  storage: StorageDriver,
  runId: string
): Promise<void> {
  if (storage.name !== "blob") return;
  await fsp.rm(path.dirname(scratchMediaPath(runId, CANONICAL_NAME)), {
    recursive: true,
    force: true,
  });
}

async function mediaPath(
  storage: StorageDriver,
  runId: string,
  fileName: string
): Promise<string> {
  return storage.getMediaToFile(
    runId,
    fileName,
    scratchMediaPath(runId, fileName)
  );
}

async function ensureCandidate(
  storage: StorageDriver,
  runId: string
): Promise<string> {
  if (await storage.mediaExists(runId, CANDIDATE_NAME)) {
    return mediaPath(storage, runId, CANDIDATE_NAME);
  }
  const canonicalPath = await mediaPath(storage, runId, CANONICAL_NAME);
  const candidatePath = await storage.mediaWritePath(runId, CANDIDATE_NAME);
  await fsp.copyFile(canonicalPath, candidatePath);
  await storage.putMediaFromFile(runId, CANDIDATE_NAME, candidatePath);
  return candidatePath;
}

export async function readV2LipsyncCheckpoint(
  runId: string
): Promise<V2LipsyncCheckpoint> {
  const operation = await getStorage().getPaidOperation(
    runId,
    LIPSYNC_OPERATION_ID
  );
  if (!operation) return { state: "unclaimed" };
  if (operation.status === "completed") {
    return isLipsyncOperationResult(operation.result)
      ? { state: "completed", result: operation.result }
      : { state: "blocked", reason: "Completed Lipsync result is invalid." };
  }
  if (operation.status === "in_progress" && operation.providerOperationId) {
    return {
      state: "started",
      predictionId: operation.providerOperationId,
    };
  }
  return {
    state: "blocked",
    reason:
      operation.status === "reconcile_required"
        ? operation.error ?? "Lipsync prediction requires reconciliation."
        : "Lipsync prediction may have started without a durable provider id.",
  };
}

/**
 * Measure the ORIGINAL source's SyncNet metrics once and persist them as the
 * run's durable baseline for the source-relative Final gate. The read is free
 * (local analyzer, already retry-laddered) and idempotent. Persistence rides
 * the server-owned canonical-source write, so a stale browser Run PUT can
 * never erase the baseline between the gate and settlement — the settle-time
 * re-verification must see exactly the value the gate judged with.
 *
 * Returns null only when the source itself cannot be analyzed after the full
 * retry ladder. The gate then stays at the absolute bar — the pre-baseline
 * behavior — instead of inventing a new way for a paid run to fail.
 */
export async function ensureSourceSyncBaseline(
  runId: string
): Promise<SyncNetMetrics | null> {
  const storage = getStorage();
  const run = await storage.getRun(runId);
  if (!run) {
    throw new Error("Run not found while measuring the source sync baseline.");
  }
  if (run.originalVideo.syncBaseline) return run.originalVideo.syncBaseline;
  let metrics: SyncNetMetrics;
  try {
    metrics = await analyzeVideoSync(
      await resolveSourceUrl(run.originalVideo.url)
    );
  } catch (error) {
    console.warn(
      `[syncnet] source baseline unavailable for ${runId}; Final gate stays absolute — ${
        error instanceof Error ? error.message.slice(0, 200) : "analysis failed"
      }`
    );
    return null;
  }
  const updated = await storage.putCanonicalRunSource(runId, {
    ...run.originalVideo,
    syncBaseline: metrics,
  });
  if (!updated) {
    throw new Error("Run disappeared while persisting the source sync baseline.");
  }
  return updated.originalVideo.syncBaseline ?? metrics;
}

/** Preserve Gemini's candidate before measuring or potentially replacing V2. */
export async function analyzeV2Candidate(
  runId: string
): Promise<V2CandidateSyncCheck> {
  const storage = getStorage();
  try {
    const candidatePath = await ensureCandidate(storage, runId);
    const videoUrl = await storage.publicMediaUrl(runId, CANONICAL_NAME);
    if (!(await storage.mediaExists(runId, SOURCE_AUDIO_NAME))) {
      const run = await storage.getRun(runId);
      if (!run) {
        throw new Error("Run disappeared during candidate sync analysis.");
      }
      if (run.originalVideo.hasAudio !== false) {
        throw new Error(
          "Candidate sync analysis cannot skip an audio-bearing source whose canonical audio is missing."
        );
      }
      return { skipped: true, videoUrl, skipReason: "silent_source" };
    }
    // Candidate first: it proves the analyzer is reachable before the
    // baseline's failure-tolerant fallback could misread an outage as "this
    // source cannot be analyzed".
    const metrics = await analyzeVideoSync(candidatePath);
    return {
      skipped: false,
      videoUrl,
      metrics,
      sourceSync: await ensureSourceSyncBaseline(runId),
    };
  } finally {
    await cleanupRemoteScratch(storage, runId).catch(() => undefined);
  }
}

const INITIAL_NAME = "relit-v1.mp4";

export type InitialCandidateSyncCheck =
  | { silent: true }
  | {
      silent: false;
      metrics: SyncNetMetrics;
      sourceSync: SyncNetMetrics | null;
    };

/**
 * Free SyncNet analysis of the Initial take for Lamp Iris best-of-two: an
 * Initial may only be DELIVERED when it clears the same source-relative gate
 * the Final cleared. Fail-open by contract — any analyzer or storage failure
 * returns null and the caller ships the already-gated Final instead. This
 * path never bills and never repairs; the paid Lipsync repair remains
 * Final-only.
 */
export async function analyzeInitialCandidateSync(
  runId: string
): Promise<InitialCandidateSyncCheck | null> {
  const storage = getStorage();
  try {
    if (!(await storage.mediaExists(runId, INITIAL_NAME))) return null;
    if (!(await storage.mediaExists(runId, SOURCE_AUDIO_NAME))) {
      // A silent source has no lip-sync dimension; the composite comparison
      // alone is sufficient to deliver the Initial.
      const run = await storage.getRun(runId);
      if (!run || run.originalVideo.hasAudio !== false) {
        throw new Error(
          "Initial sync analysis cannot treat missing canonical source audio as silence."
        );
      }
      return { silent: true };
    }
    const initialPath = await mediaPath(storage, runId, INITIAL_NAME);
    const metrics = await analyzeVideoSync(initialPath);
    return {
      silent: false,
      metrics,
      sourceSync: await ensureSourceSyncBaseline(runId),
    };
  } catch (error) {
    console.warn(
      `[iris best-of-two] Initial sync analysis failed open — delivering Final: ${
        error instanceof Error ? error.message.slice(0, 160) : "unknown error"
      }`
    );
    return null;
  } finally {
    await cleanupRemoteScratch(storage, runId).catch(() => undefined);
  }
}

/** Upload retry-safe Replicate inputs before claiming the billed prediction. */
export async function prepareV2LipsyncInputs(
  runId: string
): Promise<PreparedLipsyncInputs> {
  const storage = getStorage();
  const wavPath = scratchMediaPath(runId, "source-audio-lipsync.wav");
  try {
    const [candidatePath, audioPath] = await Promise.all([
      mediaPath(storage, runId, CANDIDATE_NAME),
      mediaPath(storage, runId, SOURCE_AUDIO_NAME),
    ]);
    await fsp.mkdir(path.dirname(wavPath), { recursive: true });
    await transcodeAudioToWav(audioPath, wavPath);
    return uploadLipsyncInputs(candidatePath, wavPath);
  } finally {
    await fsp.rm(wavPath, { force: true }).catch(() => undefined);
    await cleanupRemoteScratch(storage, runId).catch(() => undefined);
  }
}

/** Response-proven create rejections retry inside the held claim: 30/60/120s. */
const CREATE_RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

async function createWithRejectionRetry(
  prepared: PreparedLipsyncInputs
): Promise<{ id: string }> {
  let lastError: unknown;
  for (const delayMs of [...CREATE_RETRY_DELAYS_MS, null]) {
    try {
      const prediction = await createLipsyncPrediction(prepared);
      if (!prediction.id) {
        throw new Error("Replicate returned no prediction id.");
      }
      return { id: prediction.id };
    } catch (error) {
      // Only response-proven rejections (4xx incl. 429) are retryable here:
      // the server answered, so no prediction exists and no bill occurred.
      // Ambiguous failures (network drop mid-create) must bubble and seal.
      if (!(error instanceof LipsyncCreateRejectedError) || delayMs === null) {
        throw error;
      }
      lastError = error;
      console.warn(
        `[lipsync] create rejected; retrying in ${Math.round(delayMs / 1000)}s — ${error.message.slice(0, 120)}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Replicate Lipsync create failed after retries.");
}

export async function startV2LipsyncPrediction(input: {
  runId: string;
  prepared: PreparedLipsyncInputs;
  preSync: SyncNetMetrics;
}): Promise<string> {
  // Configuration failures must surface BEFORE the exactly-once claim is
  // taken: a claim held for a request that provably cannot be sent would
  // block every later attempt behind manual reconciliation.
  const configIssue = v2SyncConfigIssue();
  if (configIssue) {
    throw new Error(`Lipsync repair is not configured: ${configIssue}`);
  }
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (!run) throw new Error("Run not found for V2 Lipsync repair.");
  const finalGeneration = run.providerOperations?.find(
    (operation) => operation.id === V2_FINAL_GENERATION_OPERATION_ID
  );
  const sourceFinal = v2FinalGenerationProof(finalGeneration);
  if (!sourceFinal) {
    throw new Error(
      "Lipsync repair has no canonical Final operation, prompt, and artifact identity to bind."
    );
  }
  // Billing guard on the EFFECTIVE gate, not the absolute bar: when the
  // source's own baseline already admits this candidate, a repair cannot
  // improve the verdict — Lipsync-2-Pro cannot make a quiet speaker score
  // like a loud one, so that spend is unwinnable by construction.
  if (
    v2SyncVerdict(input.preSync, run.originalVideo.syncBaseline ?? null).pass
  ) {
    throw new Error("A passing V2 must not start a Lipsync repair.");
  }
  const claim = await beginPaidOperation({
    run,
    id: LIPSYNC_OPERATION_ID,
    provider: "replicate",
    kind: "lipsync",
    iteration: 2,
    canonicalInput: v2LipsyncCanonicalInput({
      runId: input.runId,
      preSync: input.preSync,
      sourceFinal,
    }),
  });
  if (claim.state === "cached") {
    if (
      !isLipsyncOperationResult(claim.operation.result) ||
      !v2LipsyncProofMatchesFinal({
        runId: input.runId,
        finalGeneration,
        lipsync: claim.operation,
      })
    ) {
      throw new Error("Cached Lipsync repair has an invalid result.");
    }
    return claim.operation.result.predictionId;
  }
  if (claim.state === "blocked") {
    throw new Error(paidOperationBlockedMessage(claim));
  }

  try {
    const prediction = await createWithRejectionRetry(input.prepared);
    await persistPaidOperationProviderId(claim.operation, prediction.id);
    return prediction.id;
  } catch (error) {
    await markPaidOperationReconcileRequired(
      claim.operation,
      error instanceof Error
        ? error.message
        : "Replicate Lipsync prediction returned an ambiguous result."
    );
    throw error;
  }
}

export async function pollV2LipsyncPrediction(input: {
  runId: string;
  predictionId: string;
}): Promise<V2LipsyncPollResult> {
  const prediction = await getLipsyncPrediction(input.predictionId);
  if (prediction.status === "starting" || prediction.status === "processing") {
    return { done: false };
  }
  if (prediction.status === "succeeded" && prediction.outputUrl) {
    return { done: true, outputUrl: prediction.outputUrl };
  }

  const operation = await getStorage().getPaidOperation(
    input.runId,
    LIPSYNC_OPERATION_ID
  );
  if (operation?.status === "in_progress") {
    await markPaidOperationReconcileRequired(
      operation,
      prediction.error ??
        `Replicate Lipsync prediction ended with ${prediction.status}.`
    );
  }
  throw new Error(
    prediction.error ??
      `Replicate Lipsync prediction ended with ${prediction.status}.`
  );
}

async function verifyRemuxedAudio(input: {
  sourceDurationSec: number;
  videoPath: string;
  repairedPath: string;
  audioPath: string;
}): Promise<void> {
  const [video, final, audio] = await Promise.all([
    probe(input.videoPath),
    probe(input.repairedPath),
    probe(input.audioPath),
  ]);
  if (
    !final.hasAudio ||
    !audioIntegrityDurationsAgree({
      sourceVideoDurationSec: input.sourceDurationSec,
      rawVideoDurationSec: video.durationSec,
      finalVideoDurationSec: final.durationSec,
      sourceAudioDurationSec: audio.durationSec,
    })
  ) {
    throw new Error("Lipsync output does not preserve the source timeline.");
  }
  const [sourceHash, finalHash] = await Promise.all([
    audioStreamMd5(input.audioPath),
    audioStreamMd5(input.repairedPath),
  ]);
  if (!sourceHash || sourceHash !== finalHash) {
    throw new Error("Lipsync output failed original-audio verification.");
  }
}

export async function finalizeV2Lipsync(input: {
  runId: string;
  predictionId: string;
  outputUrl: string;
  preSync: SyncNetMetrics;
}): Promise<LipsyncOperationResult> {
  const storage = getStorage();
  const [operation, run] = await Promise.all([
    storage.getPaidOperation(input.runId, LIPSYNC_OPERATION_ID),
    storage.getRun(input.runId),
  ]);
  if (!operation || !run) {
    throw new Error("Lipsync operation or run journal is missing.");
  }
  const finalGeneration = run.providerOperations?.find(
    (candidate) => candidate.id === V2_FINAL_GENERATION_OPERATION_ID
  );
  const sourceFinal = v2FinalGenerationProof(finalGeneration);
  if (
    !sourceFinal ||
    operation.inputHash !==
      v2LipsyncOperationInputHash({
        runId: input.runId,
        preSync: input.preSync,
        sourceFinal,
      })
  ) {
    if (operation.status === "in_progress") {
      await markPaidOperationReconcileRequired(
        operation,
        "Lipsync repair no longer matches the canonical Final operation, prompt, artifact, or pre-sync input."
      );
    }
    throw new Error(
      "Lipsync operation is not bound to the current canonical Final."
    );
  }
  if (operation.status === "completed") {
    if (
      !isLipsyncOperationResult(operation.result) ||
      !v2LipsyncProofMatchesFinal({
        runId: input.runId,
        finalGeneration,
        lipsync: operation,
      })
    ) {
      throw new Error("Completed Lipsync result is invalid.");
    }
    return operation.result;
  }
  if (
    operation.status !== "in_progress" ||
    operation.providerOperationId !== input.predictionId
  ) {
    throw new Error("Lipsync operation cannot be finalized safely.");
  }

  try {
    let rawPath: string;
    if (await storage.mediaExists(input.runId, RAW_LIPSYNC_NAME)) {
      rawPath = await mediaPath(storage, input.runId, RAW_LIPSYNC_NAME);
    } else {
      rawPath = await storage.mediaWritePath(input.runId, RAW_LIPSYNC_NAME);
      await downloadReplicateOutput(input.outputUrl, rawPath);
      await storage.putMediaFromFile(input.runId, RAW_LIPSYNC_NAME, rawPath);
    }

    const rawProbe = await probe(rawPath);
    // Billing ceiling, mirroring the generation path: the model may only
    // bill for the authorized source duration plus container padding. A
    // gross overrun (model looping/padding) seals as billing evidence
    // instead of silently journaling an unbounded charge.
    const billedCeilingSec =
      run.originalVideo.durationSec + RAW_VIDEO_TRAILING_PADDING_TOLERANCE_SEC + 1;
    if (rawProbe.durationSec > billedCeilingSec) {
      await markPaidOperationReconcileRequired(
        operation,
        `Lipsync output ran ${rawProbe.durationSec.toFixed(2)}s against an authorized ceiling of ${billedCeilingSec.toFixed(2)}s (~$${lipsync2ProCostFromDuration(rawProbe.durationSec).toFixed(2)} billed).`
      );
      throw new Error(
        "Lipsync output exceeded the authorized billing ceiling and was sealed for reconciliation."
      );
    }
    let conformedPath: string;
    if (await storage.mediaExists(input.runId, CONFORMED_NAME)) {
      conformedPath = await mediaPath(storage, input.runId, CONFORMED_NAME);
    } else {
      conformedPath = await storage.mediaWritePath(input.runId, CONFORMED_NAME);
      await conformVideoDuration(
        rawPath,
        conformedPath,
        run.originalVideo.durationSec
      );
      await storage.putMediaFromFile(input.runId, CONFORMED_NAME, conformedPath);
    }

    const audioPath = await mediaPath(storage, input.runId, SOURCE_AUDIO_NAME);
    let repairedPath: string;
    if (await storage.mediaExists(input.runId, REPAIRED_NAME)) {
      repairedPath = await mediaPath(storage, input.runId, REPAIRED_NAME);
    } else {
      repairedPath = await storage.mediaWritePath(input.runId, REPAIRED_NAME);
      await remuxFullAudio(conformedPath, audioPath, repairedPath);
      await storage.putMediaFromFile(input.runId, REPAIRED_NAME, repairedPath);
    }

    let postSync: SyncNetMetrics;
    try {
      await verifyRemuxedAudio({
        sourceDurationSec: run.originalVideo.durationSec,
        videoPath: conformedPath,
        repairedPath,
        audioPath,
      });
      postSync = await analyzeVideoSync(repairedPath);
    } catch (error) {
      // The repair itself billed; a deterministic verify failure (or a
      // SyncNet outage outlasting its retry ladder) must not leave that
      // charge invisible — seal with the billed amount as evidence.
      await markPaidOperationReconcileRequired(
        operation,
        `${error instanceof Error ? error.message.slice(0, 300) : "V2 Lipsync verification failed."} Billed evidence: ${rawProbe.durationSec.toFixed(2)}s ≈ $${lipsync2ProCostFromDuration(rawProbe.durationSec).toFixed(2)}.`
      );
      throw error;
    }
    const repairedUrl = await storage.publicMediaUrl(input.runId, REPAIRED_NAME);
    const baseResult: Omit<LipsyncOperationResult, "videoUrl"> = {
      predictionId: input.predictionId,
      model: LIPSYNC_MODEL,
      billableDurationSec: rawProbe.durationSec,
      costUsd: lipsync2ProCostFromDuration(rawProbe.durationSec),
      audioVerified: true as const,
      preSync: input.preSync,
      postSync,
      sourceFinal,
    };

    // Judge the repair against the same effective gate that admitted the
    // repair: absolute for sources that pass 4/10, source-relative otherwise.
    // The baseline was persisted before the repair was claimed; the ensure
    // call only covers executions started before baselines existed.
    const verdict = v2SyncVerdict(
      postSync,
      run.originalVideo.syncBaseline ??
        (await ensureSourceSyncBaseline(input.runId))
    );
    if (!verdict.pass) {
      const result: LipsyncOperationResult = {
        ...baseResult,
        videoUrl: repairedUrl,
      };
      await completePaidOperation(operation, result);
      throw new Error(
        `Lipsync-2-Pro output still failed SyncNet (${verdict.reason}).`
      );
    }

    const canonicalPath = await storage.mediaWritePath(
      input.runId,
      CANONICAL_NAME
    );
    await fsp.copyFile(repairedPath, canonicalPath);
    await storage.putMediaFromFile(input.runId, CANONICAL_NAME, canonicalPath);
    const result: LipsyncOperationResult = {
      ...baseResult,
      videoUrl: await storage.publicMediaUrl(input.runId, CANONICAL_NAME),
    };
    return completePaidOperation(operation, result);
  } finally {
    await cleanupRemoteScratch(storage, input.runId).catch(() => undefined);
  }
}
