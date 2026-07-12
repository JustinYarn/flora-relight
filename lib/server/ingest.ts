/**
 * lib/server/ingest.ts — the ONE ingest pipeline, shared verbatim by both
 * upload entry points:
 *
 *   - POST /api/ingest           (local/fs: multipart body → staging file)
 *   - POST /api/ingest/finalize  (cloud/blob: client-direct blob upload →
 *                                 downloaded to a staging file)
 *
 * Both routes stage the raw bytes to a local file themselves, then call
 * runIngestPipeline(): probe → auto-trim anything over the 10s Omni cap to
 * TRIM_TARGET_SECONDS (or remux/re-encode non-mp4 containers) → persist
 * source.mp4 via the storage driver → demux + sha256 the audio track →
 * return the response body both routes serve unchanged.
 *
 * User-input failures (unreadable video, no video stream) throw IngestError
 * with an HTTP status; routes map it to a JSON error and treat everything
 * else as a 500.
 */

import fsp from "node:fs/promises";
import {
  MAX_GEN_SECONDS,
  TRIM_TARGET_SECONDS,
  demuxAudio,
  probe,
  reencodeToMp4,
  remuxToMp4,
  trimTo,
  type ProbeResult,
} from "@/lib/server/ffmpeg";
import { getStorage } from "@/lib/server/storage";

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB

/** Extensions accepted when the browser sends a blank/generic mime type. */
export const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
/** Container families that are already mp4-compatible (no remux needed). */
const MP4_FAMILY_EXT_RE = /\.(mp4|m4v|mov)$/i;

/** The response body of a successful ingest (both routes serve this shape). */
export interface IngestResult {
  runId: string;
  url: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  trimmed: boolean;
  originalDurationSec: number;
  audioSha256: string | null;
}

/** A user-input ingest failure the route should surface with this status. */
export class IngestError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "IngestError";
  }
}

/** Lowercased extension (with dot) for a validated video file name; ".mp4" fallback. */
export function videoExtFor(fileName: string): string {
  const match = VIDEO_EXT_RE.exec(fileName);
  return match ? match[0].toLowerCase() : ".mp4";
}

/** Rename with cross-device copy fallback. */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch {
    await fsp.copyFile(src, dest);
    await fsp.rm(src, { force: true });
  }
}

/**
 * Probe/trim/persist/demux a staged local video file as run `runId`.
 * `ext` is the (validated, lowercase) source extension incl. the dot — it
 * picks the move/remux/re-encode path for non-trimmed clips. May consume
 * (rename away) `tmpPath`; callers rm it with force afterwards regardless.
 */
export async function runIngestPipeline(
  runId: string,
  tmpPath: string,
  ext: string
): Promise<IngestResult> {
  const storage = getStorage();

  let probed: ProbeResult;
  try {
    probed = await probe(tmpPath);
  } catch {
    throw new IngestError(422, "Could not read that file as a video (probe failed).");
  }
  if (!probed.durationSec || probed.width === 0 || probed.height === 0) {
    throw new IngestError(422, "File has no decodable video stream.");
  }

  const originalDurationSec = probed.durationSec;
  const needsTrim = originalDurationSec > MAX_GEN_SECONDS;

  // Local write destination (fs driver → canonical data/ path; blob driver
  // → scratch path uploaded by putMediaFromFile below).
  const destPath = await storage.mediaWritePath(runId, "source.mp4");

  let trimmed = false;
  if (needsTrim) {
    // Re-encode trim to just under the Omni cap (frame-accurate).
    await trimTo(tmpPath, destPath, TRIM_TARGET_SECONDS);
    trimmed = true;
  } else if (MP4_FAMILY_EXT_RE.test(ext)) {
    await moveFile(tmpPath, destPath);
  } else {
    // webm/mkv/avi: get the streams into an mp4 container.
    try {
      await remuxToMp4(tmpPath, destPath);
    } catch {
      await reencodeToMp4(tmpPath, destPath); // codecs mp4 can't carry
    }
  }

  const finalProbe = await probe(destPath);
  await storage.putMediaFromFile(runId, "source.mp4", destPath);

  let audioSha256: string | null = null;
  if (finalProbe.hasAudio) {
    const audioPath = await storage.mediaWritePath(runId, "source-audio.m4a");
    const { sha256 } = await demuxAudio(destPath, audioPath);
    await storage.putMediaFromFile(runId, "source-audio.m4a", audioPath);
    audioSha256 = sha256;
  }

  return {
    runId,
    url: await storage.publicMediaUrl(runId, "source.mp4"),
    durationSec: finalProbe.durationSec,
    width: finalProbe.width,
    height: finalProbe.height,
    fps: finalProbe.fps,
    hasAudio: finalProbe.hasAudio,
    trimmed,
    originalDurationSec,
    audioSha256,
  };
}
