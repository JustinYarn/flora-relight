/**
 * POST /api/ingest — multipart/form-data { file }
 *
 * Persists an uploaded clip (via the storage driver) so it survives browser
 * refresh, and enforces the Omni Flash 10-second input cap: anything longer
 * is re-encode trimmed to the first TRIM_TARGET_SECONDS (9.9s) and flagged
 * `trimmed: true`. The pipeline itself lives in lib/server/ingest.ts.
 *
 * Response (IngestResult):
 *   {
 *     runId, url, durationSec (post-trim), width, height, fps, hasAudio,
 *     trimmed, originalDurationSec, audioSha256 (null when no audio track)
 *   }
 *
 * DEPLOYMENT NOTE — this multipart route is the LOCAL/fs-driver path only.
 * Deployed Vercel functions cap the request body at 4.5MB, so in blob-driver
 * deployments the client instead uploads DIRECTLY to Vercel Blob (token from
 * /api/ingest/token) and then calls /api/ingest/finalize, which runs the
 * exact same pipeline. The client picks per GET /api/storage/info.
 */

import { NextRequest, NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import {
  IngestError,
  MAX_UPLOAD_BYTES,
  VIDEO_EXT_RE,
  persistPreparedRun,
  runIngestPipeline,
  videoExtFor,
} from "@/lib/server/ingest";
import { isValidRunId, newRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";

export const runtime = "nodejs";
export const maxDuration = 120;

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
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
      `File is ${(file.size / (1024 * 1024)).toFixed(1)}MB — the limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`
    );
  }
  if (file.size === 0) {
    return jsonError(400, "Uploaded file is empty.");
  }

  const requestedRunId = form.get("runId");
  if (requestedRunId !== null && !isValidRunId(requestedRunId)) {
    return jsonError(400, "`runId` must match [a-z0-9_-] (1-64 chars).");
  }

  const storage = getStorage();
  if (storage.name !== "fs") {
    return jsonError(
      501,
      "Multipart ingest is local-only. Hosted uploads must use the Blob token + finalize flow."
    );
  }
  const runId = requestedRunId ?? newRunId();
  if (await storage.mediaExists(runId, "source.mp4")) {
    return jsonError(409, "That run id already has an ingested source.");
  }
  // Sanitized staging name: keep only the (validated) extension.
  const ext = videoExtFor(originalName);
  const tmpPath = path.join(await storage.stagingDir(), `${runId}${ext}`);

  try {
    // Stream the upload to disk (no 500MB buffer in memory).
    const webStream = file.stream() as unknown as import("stream/web").ReadableStream;
    await pipeline(Readable.fromWeb(webStream), createWriteStream(tmpPath));

    const result = await runIngestPipeline(runId, tmpPath, ext);
    await persistPreparedRun(result, originalName);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof IngestError) return jsonError(err.status, err.message);
    console.error("[ingest] failed:", err);
    return jsonError(500, "Ingest failed on the server — see server logs.");
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}
