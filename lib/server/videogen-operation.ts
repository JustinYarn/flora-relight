import fsp from "node:fs/promises";
import path from "node:path";
import {
  OMNI_VIDEO_MODEL,
  downloadTo,
  getGemini,
  resolveSourceUrl,
  uploadVideoCached,
} from "@/lib/server/gemini";
import {
  audioStreamMd5,
  demuxAudio,
  probe,
  remuxAudio,
  stripAudio,
  trimAndStripAudio,
} from "@/lib/server/ffmpeg";
import {
  AUDIO_DURATION_TOLERANCE_SEC,
  audioIntegrityDurationsAgree,
  audioPresenceMatchesSource,
} from "@/lib/server/audio-integrity";
import { getStorage, scratchMediaPath, type StorageDriver } from "@/lib/server/storage";
import { assertAuthorizedRawOutputDuration } from "@/lib/server/video-generation-cost";
import {
  omniCostFromUsage,
  requireOmniUsage,
} from "@/lib/cost";
import { buildFreshVideoGenerationRequest } from "@/lib/video-generation-request";
import {
  automaticVideoGenerationStopReason,
  classifyVideoGenerationPollError,
  permanentPollFailuresExhausted,
  providerLostInteractionError,
  videoGenerationWorkflowErrorMessage,
} from "@/lib/server/run-execution-failure";
import { assertVideoGenerationAuthorized } from "@/lib/server/spend-approval";
import type {
  ProviderOperation,
  Run,
  VideoGenerationOperationResult,
} from "@/lib/types";

const MAX_INPUT_SECONDS = 10.05;
const FINALIZATION_LEASE_MS = 10 * 60 * 1000;
const TERMINAL_FAILURES = new Set([
  "failed",
  "cancelled",
  "incomplete",
  "budget_exceeded",
]);

interface PreparedSource {
  storage: StorageDriver;
  src: string;
  sourceDurationSec: number;
  hasAudio: boolean;
  audioPath: string | null;
}

async function cleanupRemoteScratch(
  storage: StorageDriver,
  runId: string
): Promise<void> {
  if (storage.name !== "blob") return;
  const scratchRunDir = path.dirname(scratchMediaPath(runId, "source.mp4"));
  await fsp.rm(scratchRunDir, { recursive: true, force: true }).catch((error) => {
    console.warn(
      `[videogen] scratch cleanup failed for ${runId}:`,
      error instanceof Error ? error.message : error
    );
  });
}

function safeStatus(status: string | undefined): ProviderOperation["status"] {
  if (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "incomplete" ||
    status === "budget_exceeded"
  ) {
    return status;
  }
  return "in_progress";
}

export function videoGenerationOperationId(iteration: number): string {
  return `video-generation:${iteration}`;
}

/**
 * Merge one server-owned operation journal entry into the latest Run. Keeping
 * a stable application id means route retries and Workflow replays cannot
 * accidentally create a second provider operation for the same iteration.
 */
export async function writeVideoGenerationOperation(
  runId: string,
  operation: ProviderOperation
): Promise<Run> {
  const updated = await getStorage().putProviderOperation(runId, operation);
  if (!updated) throw new Error("Run state is missing for this generation.");
  return updated;
}

export async function setVideoGenerationWorkflowState(
  runId: string,
  iteration: number,
  workflowRunId: string,
  workflowStatus: NonNullable<ProviderOperation["workflowStatus"]>
): Promise<void> {
  const storage = getStorage();
  const run = await storage.getRun(runId);
  if (!run) throw new Error("Run state is missing for this generation.");
  const operationId = videoGenerationOperationId(iteration);
  const existing = run.providerOperations?.find((item) => item.id === operationId);
  if (!existing) throw new Error("Provider operation claim is missing.");
  // When a duplicate non-billed poll workflow exists, keep the first durable
  // owner as the canonical handle. Both may safely observe the same provider
  // interaction, but the app must expose only one execution id.
  const canonicalWorkflowRunId = existing.workflowRunId ?? workflowRunId;
  await writeVideoGenerationOperation(runId, {
    ...existing,
    workflowRunId: canonicalWorkflowRunId,
    workflowStatus,
    updatedAt: Date.now(),
  });
}

async function prepareSource(runId: string, sourceUrl: string): Promise<PreparedSource> {
  const storage = getStorage();
  const resolvedSource = await resolveSourceUrl(sourceUrl);
  let src: string;
  if (await storage.mediaExists(runId, "source.mp4")) {
    src = await storage.getMediaToFile(
      runId,
      "source.mp4",
      scratchMediaPath(runId, "source.mp4")
    );
  } else {
    const dest = await storage.mediaWritePath(runId, "source.mp4");
    if (resolvedSource === dest) throw new Error("Source file is missing.");
    await fsp.copyFile(resolvedSource, dest);
    await storage.putMediaFromFile(runId, "source.mp4", dest);
    src = dest;
  }

  const srcProbe = await probe(src);
  if (srcProbe.durationSec > MAX_INPUT_SECONDS) {
    throw new Error(
      `Source is ${srcProbe.durationSec.toFixed(2)}s; the video model accepts at most 10s.`
    );
  }

  const hasAudio = srcProbe.hasAudio;
  let audioPath: string | null = null;
  if (hasAudio) {
    if (await storage.mediaExists(runId, "source-audio.m4a")) {
      audioPath = await storage.getMediaToFile(
        runId,
        "source-audio.m4a",
        scratchMediaPath(runId, "source-audio.m4a")
      );
    } else {
      audioPath = await storage.mediaWritePath(runId, "source-audio.m4a");
      await demuxAudio(src, audioPath);
      await storage.putMediaFromFile(runId, "source-audio.m4a", audioPath);
    }
  }
  return {
    storage,
    src,
    sourceDurationSec: srcProbe.durationSec,
    hasAudio,
    audioPath,
  };
}

export interface StartVideoGenerationInput {
  runId: string;
  iteration: number;
  prompt: string;
  /** Prepared before the billed operation claim, so media failures are retryable. */
  preparedUploadUri?: string;
}

export interface StartVideoGenerationResult {
  interactionId: string;
  status: ProviderOperation["status"];
  startedAt: number;
}

/**
 * Finish all retry-safe source work before reserving the billed generation.
 * This can probe/demux media and upload it to Gemini Files, but it does not
 * create a video-generation interaction.
 */
export async function prepareVideoGenerationStart(runId: string): Promise<string> {
  const storage = getStorage();
  const run = await storage.getRun(runId);
  if (!run) throw new Error("Run state is missing for this generation.");
  try {
    const prepared = await prepareSource(runId, run.originalVideo.url);
    return (await uploadVideoCached(prepared.src)).uri;
  } finally {
    // Preparation is its own Workflow step. Without cleanup, a warm worker
    // handling a batch can retain one source/audio pair per run before any
    // poll/finalization step gets a chance to clean its separate scratch disk.
    await cleanupRemoteScratch(storage, runId);
  }
}

/**
 * Starts the billed provider operation once and returns promptly. There is no
 * automatic retry: an ambiguous response must be reconciled, never re-billed.
 */
export async function startVideoGeneration(
  input: StartVideoGenerationInput
): Promise<StartVideoGenerationResult> {
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (!run) throw new Error("Run state is missing for this generation.");
  const operationId = videoGenerationOperationId(input.iteration);
  const existing = run.providerOperations?.find((item) => item.id === operationId);

  // A Workflow replay or a safely retried start route resumes the persisted
  // provider handle; it never issues the billed create call twice.
  if (existing?.providerInteractionId) {
    return {
      interactionId: existing.providerInteractionId,
      status: existing.status,
      startedAt: existing.startedAt,
    };
  }
  assertVideoGenerationAuthorized(run, input.iteration);

  const uploadUri =
    input.preparedUploadUri ?? (await prepareVideoGenerationStart(input.runId));
  const startedAt = existing?.startedAt ?? Date.now();
  // Every generation conditions on the ORIGINAL source only (ARCHITECTURE
  // §3.2): corrections travel inside the compiled prompt, never as chained
  // interaction state. previous_interaction_id must never be combined with a
  // fresh video part — the provider documents them as separate patterns, and
  // the combination produced a provider-lost interaction in production
  // (2026-07-14: every interactions.get on the chained Final returned 400).
  const interaction = await getGemini().interactions.create(
    buildFreshVideoGenerationRequest({
      iteration: input.iteration,
      model: OMNI_VIDEO_MODEL,
      prompt: input.prompt,
      uploadUri,
    }),
    // A transport retry can create a second billed interaction when the first
    // response is ambiguous. The durable application claim owns all retry
    // policy, so the SDK must make exactly one HTTP attempt here.
    { maxRetries: 0 }
  );
  if (!interaction.id) {
    throw new Error(
      "Video generation start returned no interaction id; reconciliation is required before retrying."
    );
  }
  const status = safeStatus(interaction.status);
  await writeVideoGenerationOperation(input.runId, {
    id: operationId,
    provider: "gemini",
    kind: "video_generation",
    iteration: input.iteration,
    providerInteractionId: interaction.id,
    status,
    startedAt,
    updatedAt: Date.now(),
  });
  return { interactionId: interaction.id, status, startedAt };
}

export interface PollVideoGenerationInput {
  runId: string;
  iteration: number;
  interactionId: string;
}

export type PollVideoGenerationResult =
  | { done: false; status: ProviderOperation["status"] }
  | ({ done: true; status: "completed"; interactionId: string } &
      VideoGenerationOperationResult);

/**
 * Journal one failed provider read. Transient faults (429/5xx/network) break
 * any streak and keep the existing free retry path. Positively identified
 * permanent rejections (400/404) accumulate on the durable journal; once the
 * bounded streak is exhausted the journal seals itself as reconcile_required
 * so a provider-lost interaction stops the run instead of spinning for seven
 * days. Streak bookkeeping is best-effort — a storage hiccup must surface the
 * provider error, not replace it — but the seal write is authoritative and
 * throws the sealed reason.
 */
async function recordVideoGenerationPollFailure(
  input: PollVideoGenerationInput,
  existing: Pick<
    ProviderOperation,
    "startedAt" | "permanentPollFailureCount" | "permanentPollFailureFirstAt"
  >,
  pollError: unknown
): Promise<void> {
  const now = Date.now();
  const base = {
    id: videoGenerationOperationId(input.iteration),
    provider: "gemini" as const,
    kind: "video_generation" as const,
    iteration: input.iteration,
    providerInteractionId: input.interactionId,
    startedAt: existing.startedAt ?? now,
    updatedAt: now,
  };
  if (classifyVideoGenerationPollError(pollError) === "transient") {
    if ((existing.permanentPollFailureCount ?? 0) > 0) {
      await writeVideoGenerationOperation(input.runId, {
        ...base,
        status: "in_progress",
        permanentPollFailureCount: 0,
        permanentPollFailureFirstAt: 0,
      }).catch(() => undefined);
    }
    return;
  }
  const count = (existing.permanentPollFailureCount ?? 0) + 1;
  const firstAt = existing.permanentPollFailureFirstAt || now;
  if (!permanentPollFailuresExhausted(count, firstAt, now)) {
    await writeVideoGenerationOperation(input.runId, {
      ...base,
      status: "in_progress",
      permanentPollFailureCount: count,
      permanentPollFailureFirstAt: firstAt,
    }).catch(() => undefined);
    return;
  }
  const sealedReason = providerLostInteractionError(
    input.interactionId,
    count,
    now - firstAt
  );
  await writeVideoGenerationOperation(input.runId, {
    ...base,
    status: "reconcile_required",
    permanentPollFailureCount: count,
    permanentPollFailureFirstAt: firstAt,
    error: sealedReason,
  });
  throw new Error(sealedReason);
}

export async function pollVideoGeneration(
  input: PollVideoGenerationInput
): Promise<PollVideoGenerationResult> {
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (!run) throw new Error("Run state is missing for this generation.");
  const operationId = videoGenerationOperationId(input.iteration);
  const existing = run.providerOperations?.find(
    (item) =>
      item.iteration === input.iteration &&
      (item.id === operationId ||
        item.id === input.interactionId ||
        item.providerInteractionId === input.interactionId)
  );
  const persistedInteractionId = existing?.providerInteractionId ??
    (existing?.id !== operationId ? existing?.id : undefined);
  if (!existing || persistedInteractionId !== input.interactionId) {
    throw new Error("Provider interaction does not match the persisted operation journal.");
  }
  if (existing?.status === "completed" && existing.result) {
    return {
      done: true,
      status: "completed",
      interactionId: existing.providerInteractionId ?? existing.id,
      ...existing.result,
    };
  }
  const automaticStopReason = automaticVideoGenerationStopReason(existing);
  if (automaticStopReason !== null) throw new Error(automaticStopReason);

  let interaction;
  try {
    interaction = await getGemini().interactions.get(input.interactionId);
  } catch (pollError) {
    await recordVideoGenerationPollFailure(input, existing, pollError);
    throw pollError;
  }
  const status = safeStatus(interaction.status);
  const startedAt = existing?.startedAt ?? Date.now();
  if (TERMINAL_FAILURES.has(status)) {
    await writeVideoGenerationOperation(input.runId, {
      id: operationId,
      provider: "gemini",
      kind: "video_generation",
      iteration: input.iteration,
      providerInteractionId: input.interactionId,
      status,
      startedAt,
      updatedAt: Date.now(),
      error: `Provider interaction ended with status ${status}.`,
    });
    throw new Error(`Video generation ended with status ${status}.`);
  }
  if (status !== "completed") {
    await writeVideoGenerationOperation(input.runId, {
      id: operationId,
      provider: "gemini",
      kind: "video_generation",
      iteration: input.iteration,
      providerInteractionId: input.interactionId,
      status: "in_progress",
      startedAt,
      updatedAt: Date.now(),
      // A successful provider read ends any permanent-failure streak.
      permanentPollFailureCount: 0,
      permanentPollFailureFirstAt: 0,
    });
    return { done: false, status: "in_progress" };
  }

  const outUri = interaction.output_video?.uri;
  if (!outUri) {
    await writeVideoGenerationOperation(input.runId, {
      id: operationId,
      provider: "gemini",
      kind: "video_generation",
      iteration: input.iteration,
      providerInteractionId: input.interactionId,
      status: "reconcile_required",
      startedAt,
      updatedAt: Date.now(),
      error: "Completed provider interaction returned no output video URI.",
    });
    throw new Error("Completed video generation returned no output video URI.");
  }

  let usage: VideoGenerationOperationResult["usage"];
  let costUsd: number;
  try {
    usage = requireOmniUsage(interaction.usage);
    costUsd = omniCostFromUsage(usage);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Completed Omni interaction returned invalid usage metadata.";
    await writeVideoGenerationOperation(input.runId, {
      id: operationId,
      provider: "gemini",
      kind: "video_generation",
      iteration: input.iteration,
      providerInteractionId: input.interactionId,
      status: "reconcile_required",
      startedAt,
      updatedAt: Date.now(),
      error: message,
    });
    throw new Error(message);
  }

  const finalization = await storage.claimVideoFinalization(
    input.runId,
    input.iteration,
    FINALIZATION_LEASE_MS
  );
  if (finalization.status !== "acquired") {
    return { done: false, status: "in_progress" };
  }

  try {
    // A competing poller may have completed while this request waited for the
    // lease. Re-read the atomic journal before touching deterministic paths.
    const latest = await storage.getRun(input.runId);
    const latestOperation = latest?.providerOperations?.find(
      (item) => item.id === operationId
    );
    if (latestOperation?.status === "completed" && latestOperation.result) {
      return {
        done: true,
        status: "completed",
        interactionId:
          latestOperation.providerInteractionId ?? latestOperation.id,
        ...latestOperation.result,
      };
    }

    const prepared = await prepareSource(
      input.runId,
      (latest ?? run).originalVideo.url
    );
    const genName = `gen-v${input.iteration}.mp4`;
    let genPath: string;
    if (await prepared.storage.mediaExists(input.runId, genName)) {
      genPath = await prepared.storage.getMediaToFile(
        input.runId,
        genName,
        scratchMediaPath(input.runId, genName)
      );
    } else {
      genPath = await prepared.storage.mediaWritePath(input.runId, genName);
      await downloadTo(outUri, genPath);
      await prepared.storage.putMediaFromFile(input.runId, genName, genPath);
    }
    const rawProbe = await probe(genPath);
    try {
      // Keep the immutable output-duration authorization as a strict artifact
      // boundary. Actual dollars come only from the provider usage above.
      assertAuthorizedRawOutputDuration(rawProbe.durationSec, {
        maxAuthorizedCostMicros:
          latestOperation?.maxAuthorizedCostMicros ??
          existing.maxAuthorizedCostMicros,
        billingUsdPerOutputSecond:
          latestOperation?.billingUsdPerOutputSecond ??
          existing.billingUsdPerOutputSecond,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The raw provider output could not be authorized.";
      await writeVideoGenerationOperation(input.runId, {
        id: operationId,
        provider: "gemini",
        kind: "video_generation",
        iteration: input.iteration,
        providerInteractionId: input.interactionId,
        status: "reconcile_required",
        startedAt,
        updatedAt: Date.now(),
        error: message,
      });
      throw new Error(message);
    }

    const relitName = `relit-v${input.iteration}.mp4`;
    let relitPath: string;
    if (await prepared.storage.mediaExists(input.runId, relitName)) {
      relitPath = await prepared.storage.getMediaToFile(
        input.runId,
        relitName,
        scratchMediaPath(input.runId, relitName)
      );
    } else {
      relitPath = await prepared.storage.mediaWritePath(input.runId, relitName);
      if (prepared.hasAudio && prepared.audioPath) {
        await remuxAudio(genPath, prepared.audioPath, relitPath);
      } else {
        // A silent source must stay silent even if the provider invents an
        // audio stream. Re-encode only when container padding extends beyond
        // the strict source timeline; aligned raws retain their video bytes.
        if (
          rawProbe.durationSec >
          prepared.sourceDurationSec + AUDIO_DURATION_TOLERANCE_SEC
        ) {
          await trimAndStripAudio(
            genPath,
            relitPath,
            prepared.sourceDurationSec
          );
        } else {
          await stripAudio(genPath, relitPath);
        }
      }
      await prepared.storage.putMediaFromFile(input.runId, relitName, relitPath);
    }

    const finalProbe = await probe(relitPath);
    const baseDurations = {
      sourceVideoDurationSec: prepared.sourceDurationSec,
      rawVideoDurationSec: rawProbe.durationSec,
      finalVideoDurationSec: finalProbe.durationSec,
    };
    let audioVerified =
      !prepared.hasAudio &&
      audioPresenceMatchesSource(prepared.hasAudio, finalProbe.hasAudio) &&
      audioIntegrityDurationsAgree(baseDurations);
    if (
      prepared.hasAudio &&
      prepared.audioPath &&
      audioPresenceMatchesSource(prepared.hasAudio, finalProbe.hasAudio)
    ) {
      const audioProbe = await probe(prepared.audioPath);
      const durationsAgree = audioIntegrityDurationsAgree({
        ...baseDurations,
        sourceAudioDurationSec: audioProbe.durationSec,
      });
      if (durationsAgree) {
        // Compare the shared packet range only after proving all three complete
        // timelines agree within the mux/probe tolerance. This keeps harmless
        // container rounding from changing the digest without letting a hash
        // of a shorter prefix conceal timeline loss or extension.
        const sharedDuration = Math.min(
          rawProbe.durationSec,
          finalProbe.durationSec,
          audioProbe.durationSec
        );
        try {
          const [sourceHash, relitHash] = await Promise.all([
            audioStreamMd5(prepared.audioPath, sharedDuration),
            audioStreamMd5(relitPath, sharedDuration),
          ]);
          audioVerified = sourceHash.length > 0 && sourceHash === relitHash;
        } catch {
          audioVerified = false;
        }
      }
    }

    const result: VideoGenerationOperationResult = {
      videoUrl: await prepared.storage.publicMediaUrl(input.runId, relitName),
      rawUrl: await prepared.storage.publicMediaUrl(input.runId, genName),
      durationSec: finalProbe.durationSec,
      audioVerified,
      usage,
      costUsd,
    };
    await writeVideoGenerationOperation(input.runId, {
      id: operationId,
      provider: "gemini",
      kind: "video_generation",
      iteration: input.iteration,
      providerInteractionId: input.interactionId,
      status: "completed",
      startedAt,
      updatedAt: Date.now(),
      result,
    });
    return {
      done: true,
      status: "completed",
      interactionId: input.interactionId,
      ...result,
    };
  } finally {
    await storage
      .releaseVideoFinalization(
        input.runId,
        input.iteration,
        finalization.token
      )
      .catch(() => undefined);
    // Remote media is copied into deterministic /tmp paths for ffmpeg. A warm
    // batch worker can process many 150MB clips, so retaining every source,
    // generated file, and remux would eventually exhaust the function's
    // scratch disk. The fs driver returns canonical data/ paths and must never
    // be cleaned here; only the blob driver's per-run scratch directory is
    // ephemeral.
    await cleanupRemoteScratch(storage, input.runId);
  }
}

/** Record an ambiguous Workflow failure without ever auto-repeating a charge. */
export async function markVideoGenerationWorkflowError(
  runId: string,
  iteration: number,
  error: string
): Promise<void> {
  const storage = getStorage();
  const run = await storage.getRun(runId);
  if (!run) return;
  const operationId = videoGenerationOperationId(iteration);
  const existing = run.providerOperations?.find((item) => item.id === operationId);
  if (existing?.status === "completed" || TERMINAL_FAILURES.has(existing?.status ?? "")) {
    return;
  }
  await writeVideoGenerationOperation(runId, {
    id: operationId,
    provider: "gemini",
    kind: "video_generation",
    iteration,
    ...(existing?.providerInteractionId
      ? { providerInteractionId: existing.providerInteractionId }
      : {}),
    ...(existing?.workflowRunId ? { workflowRunId: existing.workflowRunId } : {}),
    workflowStatus: "failed",
    status: "reconcile_required",
    startedAt: existing?.startedAt ?? Date.now(),
    updatedAt: Date.now(),
    error: videoGenerationWorkflowErrorMessage(existing, error),
  });
}
