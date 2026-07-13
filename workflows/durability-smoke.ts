import { sleep } from "workflow";
import {
  runSyntheticFfmpegSmoke,
  type SyntheticFfmpegSmokeResult,
} from "@/lib/server/ffmpeg";
import { getAppReadiness } from "@/lib/server/readiness";

export interface DurabilityRuntimeReadiness {
  ready: true;
  durable: boolean;
  ffmpegReady: true;
  storageDriver: "fs" | "blob";
  storageVerification: "not_required" | "verified";
  mediaTransform: SyntheticFfmpegSmokeResult;
}

export interface DurabilitySmokeResult {
  token: string;
  checkpoints: ["started", "completed"];
  runtime: DurabilityRuntimeReadiness;
}

/**
 * Provider-free deployment probe for the Workflow control plane and the
 * runtime reached by its steps. The readiness step exercises private
 * Blob/Postgres plus a generated 64x64 encode, audio demux/remux, and probe in
 * writable scratch; it never calls an AI provider or reads user media.
 */
export async function durabilitySmoke(token: string): Promise<DurabilitySmokeResult> {
  "use workflow";
  await smokeCheckpoint(token, "started");
  const runtime = await verifyRuntimeReadiness();
  await sleep("250ms");
  await smokeCheckpoint(token, "completed");
  return { token, checkpoints: ["started", "completed"], runtime };
}

async function smokeCheckpoint(token: string, checkpoint: "started" | "completed") {
  "use step";
  return { token, checkpoint };
}

smokeCheckpoint.maxRetries = 1;

async function verifyRuntimeReadiness(): Promise<DurabilityRuntimeReadiness> {
  "use step";
  const readiness = await getAppReadiness();
  const verification = readiness.storage.verification.status;
  if (
    !readiness.ready ||
    !readiness.ffmpegReady ||
    !readiness.storage.driver ||
    (verification !== "not_required" && verification !== "verified")
  ) {
    throw new Error("Provider-free Workflow runtime readiness failed.");
  }
  const mediaTransform = await runSyntheticFfmpegSmoke();
  return {
    ready: true,
    durable: readiness.durable,
    ffmpegReady: true,
    storageDriver: readiness.storage.driver,
    storageVerification: verification,
    mediaTransform,
  };
}

verifyRuntimeReadiness.maxRetries = 1;
