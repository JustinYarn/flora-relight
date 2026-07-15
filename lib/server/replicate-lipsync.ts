import "server-only";

import fsp from "node:fs/promises";
import Replicate, { type Prediction } from "replicate";
import { LIPSYNC_MODEL } from "@/lib/v2-sync";

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
  return {
    id: prediction.id,
    status: prediction.status,
    ...(typeof prediction.output === "string"
      ? { outputUrl: prediction.output }
      : {}),
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
  const prediction = await getReplicate().predictions.create({
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
}

export async function getLipsyncPrediction(
  predictionId: string
): Promise<LipsyncPrediction> {
  return projectPrediction(
    await getReplicate().predictions.get(predictionId)
  );
}
