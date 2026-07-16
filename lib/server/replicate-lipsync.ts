import "server-only";

import fsp from "node:fs/promises";
import Replicate, { type Prediction } from "replicate";
import { LIPSYNC_MODEL } from "@/lib/v2-sync";

/**
 * The create call was REJECTED before any prediction existed (4xx response,
 * or local configuration failure) — retrying cannot double-bill, so callers
 * must not seal the paid-operation claim for these. Anything without a
 * definitive rejection (network drop, timeout) stays ambiguous and seals.
 */
export class LipsyncCreateRejectedError extends Error {
  readonly definitelyNotCreated = true as const;
}

export interface PreparedLipsyncInputs {
  videoUrl: string;
  audioUrl: string;
}

export interface LipsyncPrediction {
  id: string;
  status: Prediction["status"];
  outputUrl?: string;
  error?: string;
}

let client: Replicate | null = null;

function getReplicate(): Replicate {
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  if (!token) throw new Error("REPLICATE_API_TOKEN is not configured.");
  client ??= new Replicate({ auth: token, useFileOutput: false });
  return client;
}

function projectPrediction(prediction: Prediction): LipsyncPrediction {
  // Replicate delivers single-output models as a string, but SDK/API shape
  // drift has produced one-element arrays — a billed success must never be
  // dropped over the wrapper shape.
  const output =
    typeof prediction.output === "string"
      ? prediction.output
      : Array.isArray(prediction.output) &&
          typeof prediction.output[0] === "string"
        ? prediction.output[0]
        : undefined;
  return {
    id: prediction.id,
    status: prediction.status,
    ...(output ? { outputUrl: output } : {}),
    ...(prediction.error === undefined || prediction.error === null
      ? {}
      : { error: String(prediction.error).slice(0, 500) }),
  };
}

export async function uploadLipsyncInputs(
  videoPath: string,
  audioWavPath: string
): Promise<PreparedLipsyncInputs> {
  const replicate = getReplicate();
  const [videoBytes, audioBytes] = await Promise.all([
    fsp.readFile(videoPath),
    fsp.readFile(audioWavPath),
  ]);
  const [video, audio] = await Promise.all([
    replicate.files.create(
      new Blob([new Uint8Array(videoBytes)], { type: "video/mp4" })
    ),
    replicate.files.create(
      new Blob([new Uint8Array(audioBytes)], { type: "audio/wav" })
    ),
  ]);
  return { videoUrl: video.urls.get, audioUrl: audio.urls.get };
}

export async function createLipsyncPrediction(
  inputs: PreparedLipsyncInputs
): Promise<LipsyncPrediction> {
  let replicate: Replicate;
  try {
    replicate = getReplicate();
  } catch (error) {
    throw new LipsyncCreateRejectedError(
      error instanceof Error ? error.message : "Replicate is not configured."
    );
  }
  try {
    const prediction = await replicate.predictions.create({
      model: LIPSYNC_MODEL,
      input: {
        video: inputs.videoUrl,
        audio: inputs.audioUrl,
        sync_mode: "cut_off",
        temperature: 0.5,
        active_speaker: false,
      },
    });
    return projectPrediction(prediction);
  } catch (error) {
    // replicate's ApiError is type-only at the package root; detect it
    // structurally. A 4xx response proves the server REJECTED the create —
    // no prediction exists and nothing billed.
    const status =
      error instanceof Error
        ? (error as { response?: { status?: unknown } }).response?.status
        : undefined;
    if (typeof status === "number" && status >= 400 && status < 500) {
      throw new LipsyncCreateRejectedError(
        `Replicate rejected the Lipsync create (HTTP ${status}): ${(error as Error).message.slice(0, 300)}`
      );
    }
    throw error;
  }
}

export async function getLipsyncPrediction(
  predictionId: string
): Promise<LipsyncPrediction> {
  return projectPrediction(
    await getReplicate().predictions.get(predictionId)
  );
}
