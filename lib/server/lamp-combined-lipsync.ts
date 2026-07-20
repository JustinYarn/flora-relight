import "server-only";

import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lipsync2ProCostFromDuration } from "@/lib/cost";
import {
  isLampCombinedLipsyncResult,
  lampCombinedLipsyncCanonicalInput,
  lampCombinedLipsyncGenerationBinding,
  lampCombinedLipsyncInputHash,
  lampCombinedLipsyncOperationId,
  lampCombinedLipsyncProofMatchesGeneration,
  lampCombinedMandatorySyncVerdict,
  LAMP_COMBINED_SYNC_WINDOW_SEC,
  LAMP_COMBINED_SYNC_WINDOW_STRIDE_SEC,
  type LampCombinedLipsyncResult,
  type LampCombinedSyncWindowEvidence,
} from "@/lib/lamp-combined-lipsync";
import type { LampCombinedIteration } from "@/lib/lamp-combined";
import {
  audioIntegrityDurationsAgree,
  RAW_VIDEO_TRAILING_PADDING_TOLERANCE_SEC,
} from "@/lib/server/audio-integrity";
import {
  audioStreamMd5,
  conformVideoDuration,
  extractVideoSegment,
  probe,
  remuxFullAudio,
  sha256File,
  transcodeAudioToWav,
} from "@/lib/server/ffmpeg";
import { resolveSourceUrl } from "@/lib/server/gemini";
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
import { getStorage, scratchMediaPath } from "@/lib/server/storage";
import { analyzeVideoSync, v2SyncConfigIssue } from "@/lib/server/syncnet";
import { ensureSourceSyncBaseline } from "@/lib/server/v2-sync-finalization";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import { LIPSYNC_MODEL, type SyncNetMetrics } from "@/lib/v2-sync";

const SOURCE_AUDIO_NAME = "source-audio.m4a";
const CREATE_RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

export type LampCombinedLipsyncCheckpoint =
  | { state: "unclaimed" }
  | { state: "started"; predictionId: string }
  | { state: "completed"; result: LampCombinedLipsyncResult }
  | { state: "blocked"; reason: string };

export type LampCombinedLipsyncPollResult =
  | { done: false }
  | { done: true; outputUrl: string };

export type LampCombinedPreSyncCheck =
  | { skipped: true; videoUrl: string; skipReason: "silent_source" }
  | {
      skipped: false;
      videoUrl: string;
      metrics: SyncNetMetrics;
      sourceSync: SyncNetMetrics;
    };

function mediaNames(iteration: LampCombinedIteration) {
  return {
    raw: `lipsync-v${iteration}.mp4`,
    conformed: `lipsync-v${iteration}-conformed.mp4`,
    repaired: `lipsync-v${iteration}-remuxed.mp4`,
  } as const;
}

async function mediaPath(
  runId: string,
  fileName: string
): Promise<string> {
  const storage = getStorage();
  return storage.getMediaToFile(
    runId,
    fileName,
    scratchMediaPath(runId, fileName)
  );
}

async function downloadReplicateOutput(
  url: string,
  destPath: string
): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Combined Lipsync output download failed: HTTP ${response.status}.`);
  }
  await pipeline(
    Readable.fromWeb(response.body as import("stream/web").ReadableStream),
    createWriteStream(destPath)
  );
}

export async function analyzeLampCombinedPreSync(input: {
  runId: string;
  iteration: LampCombinedIteration;
}): Promise<LampCombinedPreSyncCheck> {
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  const generation = run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(input.iteration)
  );
  if (!run || !generation?.result || generation.status !== "completed") {
    throw new Error("Combined Lipsync requires a completed generated take.");
  }
  if (run.originalVideo.hasAudio === false) {
    return {
      skipped: true,
      videoUrl: generation.result.videoUrl,
      skipReason: "silent_source",
    };
  }
  if (
    run.originalVideo.hasAudio !== true ||
    generation.result.audioVerified !== true ||
    !(await storage.mediaExists(input.runId, SOURCE_AUDIO_NAME))
  ) {
    throw new Error(
      "An audio-bearing Combined take cannot enter Lipsync without verified canonical audio."
    );
  }
  const [metrics, sourceSync] = await Promise.all([
    analyzeVideoSync(await resolveSourceUrl(generation.result.videoUrl)),
    ensureSourceSyncBaseline(input.runId),
  ]);
  if (!sourceSync) {
    throw new Error(
      "Mandatory Combined Lipsync cannot proceed without a measured source sync baseline."
    );
  }
  return {
    skipped: false,
    videoUrl: generation.result.videoUrl,
    metrics,
    sourceSync,
  };
}

export async function readLampCombinedLipsyncCheckpoint(input: {
  runId: string;
  iteration: LampCombinedIteration;
}): Promise<LampCombinedLipsyncCheckpoint> {
  const operation = await getStorage().getPaidOperation(
    input.runId,
    lampCombinedLipsyncOperationId(input.iteration)
  );
  if (!operation) return { state: "unclaimed" };
  if (operation.status === "completed") {
    return isLampCombinedLipsyncResult(operation.result, input.iteration)
      ? { state: "completed", result: operation.result }
      : { state: "blocked", reason: "Completed Combined Lipsync result is invalid." };
  }
  if (operation.status === "in_progress" && operation.providerOperationId) {
    return { state: "started", predictionId: operation.providerOperationId };
  }
  return {
    state: "blocked",
    reason:
      operation.error ??
      "Combined Lipsync may have started without a durable provider id.",
  };
}

export async function prepareLampCombinedLipsyncInputs(input: {
  runId: string;
  iteration: LampCombinedIteration;
}): Promise<PreparedLipsyncInputs> {
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  const generation = run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(input.iteration)
  );
  if (!generation?.result) {
    throw new Error("Combined Lipsync input generation is missing.");
  }
  const wavPath = scratchMediaPath(
    input.runId,
    `source-audio-lipsync-v${input.iteration}.wav`
  );
  try {
    const [candidatePath, audioPath] = await Promise.all([
      resolveSourceUrl(generation.result.videoUrl),
      mediaPath(input.runId, SOURCE_AUDIO_NAME),
    ]);
    await fsp.mkdir(path.dirname(wavPath), { recursive: true });
    await transcodeAudioToWav(audioPath, wavPath);
    return uploadLipsyncInputs(candidatePath, wavPath);
  } finally {
    await fsp.rm(wavPath, { force: true }).catch(() => undefined);
  }
}

async function createWithRejectionRetry(
  prepared: PreparedLipsyncInputs
): Promise<{ id: string }> {
  let lastError: unknown;
  for (const delayMs of [...CREATE_RETRY_DELAYS_MS, null]) {
    try {
      const prediction = await createLipsyncPrediction(prepared);
      if (!prediction.id) throw new Error("Replicate returned no prediction id.");
      return { id: prediction.id };
    } catch (error) {
      if (!(error instanceof LipsyncCreateRejectedError) || delayMs === null) {
        throw error;
      }
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Combined Lipsync create failed after retries.");
}

export async function startLampCombinedLipsyncPrediction(input: {
  runId: string;
  iteration: LampCombinedIteration;
  prepared: PreparedLipsyncInputs;
  preSync: SyncNetMetrics;
}): Promise<string> {
  const configIssue = v2SyncConfigIssue();
  if (configIssue) {
    throw new Error(`Mandatory Combined Lipsync is not configured: ${configIssue}`);
  }
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  const generation = run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(input.iteration)
  );
  const sourceGeneration = lampCombinedLipsyncGenerationBinding(
    generation,
    input.iteration
  );
  if (!run || !generation || !sourceGeneration) {
    throw new Error("Combined Lipsync has no exact generation binding.");
  }
  const claim = await beginPaidOperation({
    run,
    id: lampCombinedLipsyncOperationId(input.iteration),
    provider: "replicate",
    kind: "lipsync",
    iteration: input.iteration,
    canonicalInput: lampCombinedLipsyncCanonicalInput({
      runId: input.runId,
      iteration: input.iteration,
      sourceGeneration,
    }),
  });
  if (claim.state === "cached") {
    if (
      !lampCombinedLipsyncProofMatchesGeneration({
        runId: input.runId,
        iteration: input.iteration,
        generation,
        operation: claim.operation,
      })
    ) {
      throw new Error("Cached Combined Lipsync result is invalid.");
    }
    return (claim.operation.result as LampCombinedLipsyncResult).predictionId;
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
        : "Replicate Combined Lipsync prediction returned an ambiguous result."
    );
    throw error;
  }
}

export async function pollLampCombinedLipsyncPrediction(input: {
  runId: string;
  iteration: LampCombinedIteration;
  predictionId: string;
}): Promise<LampCombinedLipsyncPollResult> {
  const prediction = await getLipsyncPrediction(input.predictionId);
  if (prediction.status === "starting" || prediction.status === "processing") {
    return { done: false };
  }
  if (prediction.status === "succeeded" && prediction.outputUrl) {
    return { done: true, outputUrl: prediction.outputUrl };
  }
  const operation = await getStorage().getPaidOperation(
    input.runId,
    lampCombinedLipsyncOperationId(input.iteration)
  );
  if (operation?.status === "in_progress") {
    await markPaidOperationReconcileRequired(
      operation,
      prediction.error ??
        `Replicate Combined Lipsync ended with ${prediction.status}.`
    );
  }
  throw new Error(
    prediction.error ?? `Replicate Combined Lipsync ended with ${prediction.status}.`
  );
}

function windowStarts(durationSec: number): number[] {
  if (durationSec <= LAMP_COMBINED_SYNC_WINDOW_SEC) return [0];
  const lastStart = durationSec - LAMP_COMBINED_SYNC_WINDOW_SEC;
  const starts: number[] = [];
  for (
    let start = 0;
    start < lastStart;
    start += LAMP_COMBINED_SYNC_WINDOW_STRIDE_SEC
  ) {
    starts.push(Number(start.toFixed(3)));
  }
  if (starts.length === 0 || Math.abs(starts[starts.length - 1] - lastStart) > 0.1) {
    starts.push(Number(lastStart.toFixed(3)));
  }
  return starts;
}

async function analyzeWindows(input: {
  runId: string;
  iteration: LampCombinedIteration;
  sourcePath: string;
  candidatePath: string;
  durationSec: number;
}): Promise<LampCombinedSyncWindowEvidence[]> {
  const windows: LampCombinedSyncWindowEvidence[] = [];
  for (const startSec of windowStarts(input.durationSec)) {
    const durationSec = Math.min(
      LAMP_COMBINED_SYNC_WINDOW_SEC,
      input.durationSec - startSec
    );
    const sourceWindow = scratchMediaPath(
      input.runId,
      `sync-source-v${input.iteration}-${startSec.toFixed(3)}.mp4`
    );
    const candidateWindow = scratchMediaPath(
      input.runId,
      `sync-candidate-v${input.iteration}-${startSec.toFixed(3)}.mp4`
    );
    try {
      await fsp.mkdir(path.dirname(sourceWindow), { recursive: true });
      await Promise.all([
        extractVideoSegment(
          input.sourcePath,
          sourceWindow,
          startSec,
          durationSec
        ),
        extractVideoSegment(
          input.candidatePath,
          candidateWindow,
          startSec,
          durationSec
        ),
      ]);
      const [source, candidate] = await Promise.all([
        analyzeVideoSync(sourceWindow),
        analyzeVideoSync(candidateWindow),
      ]);
      windows.push({ startSec, durationSec, source, candidate });
    } finally {
      await Promise.all([
        fsp.rm(sourceWindow, { force: true }).catch(() => undefined),
        fsp.rm(candidateWindow, { force: true }).catch(() => undefined),
      ]);
    }
  }
  return windows;
}

async function verifyRemuxedAudio(input: {
  sourceDurationSec: number;
  conformedPath: string;
  repairedPath: string;
  audioPath: string;
}): Promise<string> {
  const [video, final, audio] = await Promise.all([
    probe(input.conformedPath),
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
    throw new Error("Combined Lipsync output does not preserve the source timeline.");
  }
  const [sourceHash, finalHash] = await Promise.all([
    audioStreamMd5(input.audioPath),
    audioStreamMd5(input.repairedPath),
  ]);
  if (!sourceHash || sourceHash !== finalHash) {
    throw new Error("Combined Lipsync output failed canonical-audio verification.");
  }
  return sourceHash;
}

export async function finalizeLampCombinedLipsync(input: {
  runId: string;
  iteration: LampCombinedIteration;
  predictionId: string;
  outputUrl: string;
  preSync: SyncNetMetrics;
}): Promise<LampCombinedLipsyncResult> {
  const storage = getStorage();
  const operationId = lampCombinedLipsyncOperationId(input.iteration);
  const [operation, run] = await Promise.all([
    storage.getPaidOperation(input.runId, operationId),
    storage.getRun(input.runId),
  ]);
  const generation = run?.providerOperations?.find(
    (candidate) => candidate.id === videoGenerationOperationId(input.iteration)
  );
  const sourceGeneration = lampCombinedLipsyncGenerationBinding(
    generation,
    input.iteration
  );
  if (!operation || !run || !generation || !sourceGeneration) {
    throw new Error("Combined Lipsync operation, run, or generation is missing.");
  }
  if (
    operation.inputHash !==
    lampCombinedLipsyncInputHash({
      runId: input.runId,
      iteration: input.iteration,
      sourceGeneration,
    })
  ) {
    if (operation.status === "in_progress") {
      await markPaidOperationReconcileRequired(
        operation,
        "Combined Lipsync no longer matches its exact generated take."
      );
    }
    throw new Error("Combined Lipsync is not bound to the current generated take.");
  }
  if (operation.status === "completed") {
    if (
      !lampCombinedLipsyncProofMatchesGeneration({
        runId: input.runId,
        iteration: input.iteration,
        generation,
        operation,
      })
    ) {
      throw new Error("Completed Combined Lipsync result is invalid.");
    }
    return operation.result as LampCombinedLipsyncResult;
  }
  if (
    operation.status !== "in_progress" ||
    operation.providerOperationId !== input.predictionId
  ) {
    throw new Error("Combined Lipsync cannot be finalized safely.");
  }

  const names = mediaNames(input.iteration);
  let rawPath = await storage.mediaWritePath(input.runId, names.raw);
  try {
    if (await storage.mediaExists(input.runId, names.raw)) {
      rawPath = await mediaPath(input.runId, names.raw);
    } else {
      await downloadReplicateOutput(input.outputUrl, rawPath);
      await storage.putMediaFromFile(input.runId, names.raw, rawPath);
    }
    const rawProbe = await probe(rawPath);
    const billedCeilingSec =
      run.originalVideo.durationSec + RAW_VIDEO_TRAILING_PADDING_TOLERANCE_SEC + 1;
    if (rawProbe.durationSec > billedCeilingSec) {
      await markPaidOperationReconcileRequired(
        operation,
        `Combined Lipsync output ran ${rawProbe.durationSec.toFixed(2)}s against an authorized ceiling of ${billedCeilingSec.toFixed(2)}s.`
      );
      throw new Error("Combined Lipsync exceeded its authorized billing ceiling.");
    }

    let conformedPath = await storage.mediaWritePath(input.runId, names.conformed);
    if (await storage.mediaExists(input.runId, names.conformed)) {
      conformedPath = await mediaPath(input.runId, names.conformed);
    } else {
      await conformVideoDuration(
        rawPath,
        conformedPath,
        run.originalVideo.durationSec
      );
      await storage.putMediaFromFile(input.runId, names.conformed, conformedPath);
    }

    const audioPath = await mediaPath(input.runId, SOURCE_AUDIO_NAME);
    let repairedPath = await storage.mediaWritePath(input.runId, names.repaired);
    if (await storage.mediaExists(input.runId, names.repaired)) {
      repairedPath = await mediaPath(input.runId, names.repaired);
    } else {
      await remuxFullAudio(conformedPath, audioPath, repairedPath);
      await storage.putMediaFromFile(input.runId, names.repaired, repairedPath);
    }

    let audioMd5: string;
    let postSync: SyncNetMetrics;
    let sourceSync: SyncNetMetrics | null;
    let windows: LampCombinedSyncWindowEvidence[];
    try {
      audioMd5 = await verifyRemuxedAudio({
        sourceDurationSec: run.originalVideo.durationSec,
        conformedPath,
        repairedPath,
        audioPath,
      });
      const sourcePath = await resolveSourceUrl(run.originalVideo.url);
      [postSync, sourceSync, windows] = await Promise.all([
        analyzeVideoSync(repairedPath),
        ensureSourceSyncBaseline(input.runId),
        analyzeWindows({
          runId: input.runId,
          iteration: input.iteration,
          sourcePath,
          candidatePath: repairedPath,
          durationSec: run.originalVideo.durationSec,
        }),
      ]);
      if (!sourceSync) {
        throw new Error("Combined post-Lipsync verification lost its source baseline.");
      }
    } catch (error) {
      await markPaidOperationReconcileRequired(
        operation,
        `${error instanceof Error ? error.message.slice(0, 300) : "Combined Lipsync verification failed."} Billed evidence: ${rawProbe.durationSec.toFixed(2)}s.`
      );
      throw error;
    }

    const result: LampCombinedLipsyncResult = {
      version: "lamp-combined-lipsync-v1",
      iteration: input.iteration,
      predictionId: input.predictionId,
      model: LIPSYNC_MODEL,
      videoUrl: await storage.publicMediaUrl(input.runId, names.repaired),
      videoSha256: await sha256File(repairedPath),
      audioMd5,
      billableDurationSec: rawProbe.durationSec,
      costUsd: lipsync2ProCostFromDuration(rawProbe.durationSec),
      audioVerified: true,
      preSync: input.preSync,
      postSync,
      sourceSync,
      windows,
      sourceGeneration,
    };
    const completed = await completePaidOperation(operation, result);
    const verdict = lampCombinedMandatorySyncVerdict(result);
    if (!verdict.pass) {
      throw new Error(`Mandatory Combined Lipsync failed verification: ${verdict.reason}`);
    }
    return completed;
  } finally {
    // Blob downloads and local writes use deterministic names and remain safe
    // to resume; window scratch is removed immediately inside analyzeWindows.
  }
}
