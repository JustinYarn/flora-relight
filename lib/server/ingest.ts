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

import { createHash, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  MAX_GEN_SECONDS,
  TRIM_TARGET_SECONDS,
  demuxAudio,
  needsIngestDownscale,
  probe,
  reencodeToMp4,
  remuxToMp4,
  trimTo,
  type ProbeResult,
} from "@/lib/server/ffmpeg";
import { buildRun } from "@/lib/run-factory";
import { getStorage, scratchMediaPath } from "@/lib/server/storage";
import type { Run, VideoAsset } from "@/lib/types";

// Vercel exposes 500MB of scratch space. Finalization may briefly hold the raw
// input, normalized source, and demuxed audio together, so the upload itself
// must stay comfortably below that ceiling.
export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024; // 150MB

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

interface CloudIngestReceipt {
  schema: "flora.cloud-ingest.v1";
  uploadFingerprint: string;
  result: IngestResult;
}

const CLOUD_INGEST_RECEIPT_FILE = "ingest-result.json";

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

export function cloudUploadFingerprint(uploadUrl: string): string {
  return createHash("sha256").update(uploadUrl).digest("hex");
}

function isIngestResult(value: unknown, runId: string): value is IngestResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<IngestResult>;
  return (
    result.runId === runId &&
    typeof result.url === "string" &&
    typeof result.durationSec === "number" &&
    Number.isFinite(result.durationSec) &&
    result.durationSec > 0 &&
    result.durationSec <= MAX_GEN_SECONDS + 0.05 &&
    typeof result.width === "number" &&
    Number.isFinite(result.width) &&
    result.width > 0 &&
    typeof result.height === "number" &&
    Number.isFinite(result.height) &&
    result.height > 0 &&
    typeof result.fps === "number" &&
    Number.isFinite(result.fps) &&
    result.fps > 0 &&
    typeof result.hasAudio === "boolean" &&
    typeof result.trimmed === "boolean" &&
    typeof result.originalDurationSec === "number" &&
    Number.isFinite(result.originalDurationSec) &&
    result.originalDurationSec > 0 &&
    (result.audioSha256 === null || typeof result.audioSha256 === "string")
  );
}

async function cleanBlobScratch(paths: Array<string | undefined>): Promise<void> {
  const storage = getStorage();
  if (storage.name !== "blob") return;

  const files = Array.from(new Set(paths.filter((item): item is string => Boolean(item))));
  await Promise.all(
    files.map((filePath) =>
      fsp.rm(filePath, { force: true }).catch((err) => {
        console.warn(`[ingest] scratch cleanup failed for ${path.basename(filePath)}:`, err);
      })
    )
  );

  // Remove now-empty per-run directories without touching files another
  // operation may have legitimately placed beside these ingest artifacts.
  const dirs = Array.from(new Set(files.map((filePath) => path.dirname(filePath))));
  await Promise.all(dirs.map((dir) => fsp.rmdir(dir).catch(() => {})));
}

/**
 * Return a previously committed cloud ingest. The upload fingerprint binds the
 * receipt to the raw Blob that created it, preventing one upload URL from being
 * deleted while replaying another run's finalize request.
 */
export async function readCommittedCloudIngest(
  runId: string,
  uploadUrl: string
): Promise<IngestResult | null> {
  const receipt = await readCloudIngestReceipt(runId);
  if (!receipt) return null;
  if (receipt.uploadFingerprint !== cloudUploadFingerprint(uploadUrl)) {
    throw new IngestError(409, "That run id belongs to a different or invalid upload.");
  }
  return receipt.result;
}

/**
 * Recover a committed cloud ingest by its reserved run id. This is used when
 * media finalization succeeded but the browser closed before it could mark
 * the corresponding batch item ready. The gate protects the API caller; the
 * receipt itself contains no raw upload URL or secret material.
 */
export async function readCommittedCloudIngestByRunId(
  runId: string
): Promise<IngestResult | null> {
  return (await readCloudIngestReceipt(runId))?.result ?? null;
}

/**
 * Server-authoritative source facts for run creation and spend approval.
 * Cloud ingests use their committed receipt; legacy/local ingests are probed
 * from the durable normalized `source.mp4`. Browser-supplied duration or URLs
 * are never trusted for an approval ceiling.
 */
export async function readCanonicalIngestByRunId(
  runId: string
): Promise<IngestResult | null> {
  const receipt = await readCloudIngestReceipt(runId);
  if (receipt) return receipt.result;

  const storage = getStorage();
  if (!(await storage.mediaExists(runId, "source.mp4"))) return null;
  const requestedPath = `${scratchMediaPath(runId, "source.mp4")}.${randomBytes(6).toString("hex")}`;
  let localPath: string | undefined;
  try {
    localPath = await storage.getMediaToFile(
      runId,
      "source.mp4",
      requestedPath
    );
    const canonical = await probe(localPath);
    if (
      !Number.isFinite(canonical.durationSec) ||
      canonical.durationSec <= 0 ||
      canonical.durationSec > MAX_GEN_SECONDS + 0.05 ||
      canonical.width <= 0 ||
      canonical.height <= 0 ||
      !Number.isFinite(canonical.fps) ||
      canonical.fps <= 0
    ) {
      throw new IngestError(409, "The stored source video is invalid.");
    }
    return {
      runId,
      url: await storage.publicMediaUrl(runId, "source.mp4"),
      durationSec: canonical.durationSec,
      width: canonical.width,
      height: canonical.height,
      fps: canonical.fps,
      hasAudio: canonical.hasAudio,
      trimmed: false,
      originalDurationSec: canonical.durationSec,
      audioSha256: null,
    };
  } finally {
    await cleanBlobScratch([localPath ?? requestedPath]);
  }
}

async function readCloudIngestReceipt(
  runId: string
): Promise<CloudIngestReceipt | null> {
  const storage = getStorage();
  if (!(await storage.mediaExists(runId, CLOUD_INGEST_RECEIPT_FILE))) return null;

  const requestedPath = `${scratchMediaPath(runId, CLOUD_INGEST_RECEIPT_FILE)}.${randomBytes(6).toString("hex")}`;
  let localPath: string | undefined;
  try {
    localPath = await storage.getMediaToFile(
      runId,
      CLOUD_INGEST_RECEIPT_FILE,
      requestedPath
    );
    const value = JSON.parse(await fsp.readFile(localPath, "utf8")) as Partial<CloudIngestReceipt>;
    if (
      value.schema !== "flora.cloud-ingest.v1" ||
      typeof value.uploadFingerprint !== "string" ||
      !isIngestResult(value.result, runId)
    ) {
      throw new IngestError(409, "That run id belongs to a different or invalid upload.");
    }
    const receipt = value as CloudIngestReceipt;
    // Older cloud receipts persisted the Blob CDN URL. Keep that handle
    // server-only after migration; all browser-visible source references are
    // re-materialized through the authenticated same-origin media route.
    receipt.result = {
      ...receipt.result,
      url: await storage.publicMediaUrl(runId, "source.mp4"),
    };
    return receipt;
  } finally {
    await cleanBlobScratch([localPath ?? requestedPath]);
  }
}

/**
 * Persist the final commit marker only after source video and audio are safely
 * stored. Once this succeeds, finalize is idempotent even if its HTTP response
 * is lost or raw-Blob cleanup happens before the client retries.
 */
export async function commitCloudIngest(
  runId: string,
  uploadUrl: string,
  result: IngestResult
): Promise<void> {
  if (!isIngestResult(result, runId)) {
    throw new Error("Cannot commit an invalid cloud ingest result.");
  }
  const storage = getStorage();
  const receiptPath = await storage.mediaWritePath(runId, CLOUD_INGEST_RECEIPT_FILE);
  const receipt: CloudIngestReceipt = {
    schema: "flora.cloud-ingest.v1",
    uploadFingerprint: cloudUploadFingerprint(uploadUrl),
    result,
  };
  try {
    await fsp.writeFile(receiptPath, JSON.stringify(receipt), "utf8");
    await storage.putMediaFromFile(runId, CLOUD_INGEST_RECEIPT_FILE, receiptPath);
  } finally {
    await cleanBlobScratch([receiptPath]);
  }
}

/**
 * Materialize a finalized upload as a normal Run before any paid work is
 * approved. This is the durable hand-off between ingest and generation: a
 * browser may close after this write and the prepared clip will still appear
 * in run history after the next hydration.
 *
 * The write is intentionally idempotent. Cloud finalize retries hit this both
 * when they perform the original receipt commit and when they replay an
 * already-committed receipt after a lost response.
 */
export async function persistPreparedRun(
  result: IngestResult,
  originalFileName: string
): Promise<Run> {
  if (!isIngestResult(result, result.runId)) {
    throw new Error("Cannot prepare a run from an invalid ingest result.");
  }

  const storage = getStorage();
  const existing = await storage.getRun(result.runId);
  if (existing) {
    const source = existing.originalVideo;
    if (
      existing.id !== result.runId ||
      source.runId !== result.runId ||
      source.url !== result.url ||
      Math.abs(source.durationSec - result.durationSec) > 0.001 ||
      source.width !== result.width ||
      source.height !== result.height ||
      source.hasAudio !== result.hasAudio
    ) {
      throw new IngestError(
        409,
        "That run id already belongs to a different workflow run."
      );
    }
    return existing;
  }

  const label =
    originalFileName.length > 0
      ? originalFileName.slice(0, 500)
      : `upload-${result.runId}.mp4`;
  const video: VideoAsset = {
    id: `source-${result.runId}`,
    runId: result.runId,
    kind: "original",
    url: result.url,
    label,
    durationSec: result.durationSec,
    width: result.width,
    height: result.height,
    hasAudio: result.hasAudio,
  };
  const prepared = buildRun(video);
  prepared.log.push({
    at: prepared.createdAt,
    level: "info",
    message: "Upload normalized and saved — ready for generation approval",
  });
  await storage.putRun(prepared);
  return prepared;
}

/** Remove only ingest-owned files from this run's remote-driver scratch dir. */
export async function cleanCloudIngestScratch(runId: string): Promise<void> {
  await cleanBlobScratch([
    scratchMediaPath(runId, "source.mp4"),
    scratchMediaPath(runId, "source-audio.m4a"),
    scratchMediaPath(runId, CLOUD_INGEST_RECEIPT_FILE),
  ]);
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
  let destPath: string | undefined;
  let audioPath: string | undefined;

  try {
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
    const downscale = needsIngestDownscale(probed.width, probed.height);

    // Local write destination (fs driver → canonical data/ path; blob driver
    // → scratch path uploaded by putMediaFromFile below).
    destPath = await storage.mediaWritePath(runId, "source.mp4");

    let trimmed = false;
    if (needsTrim) {
      // Re-encode trim to just under the Omni cap (frame-accurate); oversized
      // sources downscale to the provider-safe resolution in the same pass.
      await trimTo(tmpPath, destPath, TRIM_TARGET_SECONDS, { downscale });
      trimmed = true;
    } else if (downscale) {
      // A byte-copy would keep the provider-rejected 4K frame size, so
      // oversized sources re-encode down even when no trim is needed.
      await reencodeToMp4(tmpPath, destPath, { downscale: true });
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
      audioPath = await storage.mediaWritePath(runId, "source-audio.m4a");
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
  } finally {
    // Remote media is durable after putMediaFromFile. Keeping per-run source
    // copies in a warm function's 500MB /tmp only makes later batch members fail.
    await cleanBlobScratch([audioPath, destPath]);
  }
}
