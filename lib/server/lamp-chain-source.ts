import "server-only";

import fsp from "node:fs/promises";
import path from "node:path";

import { probe } from "@/lib/server/ffmpeg";
import { uploadVideoCached } from "@/lib/server/gemini";
import {
  getStorage,
  scratchMediaPath,
  type StorageDriver,
} from "@/lib/server/storage";
import { prepareVideoGenerationStart } from "@/lib/server/videogen-operation";

/** Mirrors the videogen boundary; the provider accepts at most ~10s of input. */
const MAX_CHAIN_INPUT_SECONDS = 10.05;

async function cleanupRemoteScratch(
  storage: StorageDriver,
  runId: string,
  fileName: string
): Promise<void> {
  if (storage.name !== "blob") return;
  await fsp
    .rm(path.dirname(scratchMediaPath(runId, fileName)), {
      recursive: true,
      force: true,
    })
    .catch(() => undefined);
}

/**
 * Retry-safe upload preparation for one chain stage.
 *
 * Stage 1 is the canonical original (this also seeds the immutable stored
 * source.mp4/source-audio.m4a pair, so every later stage's finalization keeps
 * remuxing and hash-verifying the ORIGINAL audio — the audio law holds for
 * the whole chain no matter what the generation inputs are).
 *
 * Stage N>1 deliberately uploads the PREVIOUS stage's audio-remuxed delivered
 * cut (`relit-v{N-1}.mp4`) as the generation input. This is the one structural
 * law Chain suspends on purpose — the regenerate-from-original rule — and it
 * is the entire experiment. It never touches the stored canonical source.
 */
export async function prepareLampChainStageStart(
  runId: string,
  stage: number
): Promise<string> {
  if (!Number.isInteger(stage) || stage < 1) {
    throw new Error("Chain stage must be a positive integer.");
  }
  if (stage === 1) {
    return prepareVideoGenerationStart(runId);
  }
  const storage = getStorage();
  const inputName = `relit-v${stage - 1}.mp4`;
  try {
    if (!(await storage.mediaExists(runId, inputName))) {
      throw new Error(
        `Chain stage ${stage} input ${inputName} is missing; the previous stage has not delivered.`
      );
    }
    const inputPath = await storage.getMediaToFile(
      runId,
      inputName,
      scratchMediaPath(runId, inputName)
    );
    const inputProbe = await probe(inputPath);
    if (inputProbe.durationSec > MAX_CHAIN_INPUT_SECONDS) {
      throw new Error(
        `Chain stage ${stage} input is ${inputProbe.durationSec.toFixed(2)}s; the video model accepts at most 10s.`
      );
    }
    return (await uploadVideoCached(inputPath)).uri;
  } finally {
    await cleanupRemoteScratch(storage, runId, inputName);
  }
}
