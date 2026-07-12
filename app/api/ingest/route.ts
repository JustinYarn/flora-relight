/**
 * POST /api/ingest — multipart/form-data { file }
 *
 * Persists an uploaded clip to disk so it survives browser refresh, and
 * enforces the Omni Flash 10-second input cap: anything longer is re-encode
 * trimmed to the first TRIM_TARGET_SECONDS (9.9s) and flagged `trimmed: true`.
 *
 * Response:
 *   {
 *     runId, url, durationSec (post-trim), width, height, fps, hasAudio,
 *     trimmed, originalDurationSec, audioSha256 (null when no audio track)
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import {
  MAX_GEN_SECONDS,
  TRIM_TARGET_SECONDS,
  demuxAudio,
  probe,
  reencodeToMp4,
  remuxToMp4,
  trimTo,
} from "@/lib/server/ffmpeg";
import {
  UPLOADS_ROOT,
  ensureDir,
  newRunId,
  runDir,
  runMediaUrl,
  sourceAudioPath,
  sourcePath,
} from "@/lib/server/runstore";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB
/** Extensions accepted when the browser sends a blank/generic mime type. */
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
/** Container families that are already mp4-compatible (no remux needed). */
const MP4_FAMILY_EXT_RE = /\.(mp4|m4v|mov)$/i;

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function rm(p: string): Promise<void> {
  await fsp.rm(p, { force: true });
}

/** Rename with cross-device copy fallback. */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch {
    await fsp.copyFile(src, dest);
    await rm(src);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "Expected multipart/form-data with a `file` field.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError(400, "Missing `file` field in form data.");
  }

  const originalName = file.name || "upload.mp4";
  const mime = file.type || "";
  const looksLikeVideo =
    mime.startsWith("video/") ||
    ((mime === "" || mime === "application/octet-stream") &&
      VIDEO_EXT_RE.test(originalName));
  if (!looksLikeVideo) {
    return jsonError(
      415,
      `Unsupported file type "${mime || "unknown"}" — upload a video file (mp4/mov/webm).`
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonError(
      413,
      `File is ${(file.size / (1024 * 1024)).toFixed(1)}MB — the limit is 500MB.`
    );
  }
  if (file.size === 0) {
    return jsonError(400, "Uploaded file is empty.");
  }

  const runId = newRunId();
  // Sanitized staging name: keep only the (validated) extension.
  const extMatch = VIDEO_EXT_RE.exec(originalName);
  const ext = extMatch ? extMatch[0].toLowerCase() : ".mp4";
  await ensureDir(UPLOADS_ROOT);
  const tmpPath = path.join(UPLOADS_ROOT, `${runId}${ext}`);

  try {
    // Stream the upload to disk (no 500MB buffer in memory).
    const webStream = file.stream() as unknown as import("stream/web").ReadableStream;
    await pipeline(Readable.fromWeb(webStream), createWriteStream(tmpPath));

    let probed;
    try {
      probed = await probe(tmpPath);
    } catch {
      return jsonError(422, "Could not read that file as a video (probe failed).");
    }
    if (!probed.durationSec || probed.width === 0 || probed.height === 0) {
      return jsonError(422, "File has no decodable video stream.");
    }

    const originalDurationSec = probed.durationSec;
    const needsTrim = originalDurationSec > MAX_GEN_SECONDS;

    await ensureDir(runDir(runId));
    const destPath = sourcePath(runId);

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

    let audioSha256: string | null = null;
    if (finalProbe.hasAudio) {
      const { sha256 } = await demuxAudio(destPath, sourceAudioPath(runId));
      audioSha256 = sha256;
    }

    return NextResponse.json({
      runId,
      url: runMediaUrl(runId, "source.mp4"),
      durationSec: finalProbe.durationSec,
      width: finalProbe.width,
      height: finalProbe.height,
      fps: finalProbe.fps,
      hasAudio: finalProbe.hasAudio,
      trimmed,
      originalDurationSec,
      audioSha256,
    });
  } catch (err) {
    console.error("[ingest] failed:", err);
    return jsonError(500, "Ingest failed on the server — see server logs.");
  } finally {
    await rm(tmpPath).catch(() => {});
  }
}
