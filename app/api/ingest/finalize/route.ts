/**
 * POST /api/ingest/finalize — { uploadUrl, fileName } (step 2 of the cloud
 * ingest flow).
 *
 * After the browser uploads the raw video DIRECTLY to Vercel Blob (client
 * token from /api/ingest/token), it posts the resulting blob URL here. This
 * route downloads the blob to a local staging file (ffmpeg needs real
 * paths), runs the exact same pipeline as multipart /api/ingest
 * (lib/server/ingest.ts: probe → auto-trim >10s → persist source.mp4 →
 * audio demux + sha256), DELETES the now-redundant raw uploads/ blob, and
 * responds with the identical ingest response shape.
 *
 * Only meaningful when the blob driver is active — 501 otherwise. Access is
 * enforced by the middleware gate like every other API route; the accepted
 * uploadUrl is pinned to our store's public host + uploads/ prefix so the
 * server can't be pointed at arbitrary origins.
 */

import { NextRequest, NextResponse } from "next/server";
import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { del } from "@vercel/blob";
import { IngestError, runIngestPipeline, videoExtFor } from "@/lib/server/ingest";
import { newRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";

export const runtime = "nodejs";
// Download + potential re-encode trim of a large clip takes real time.
export const maxDuration = 300;

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Accept only URLs that plausibly point at OUR store's raw upload area.
 * VERIFY(vercel): public blob URLs are https://<store-id>.public.blob.
 * vercel-storage.com/<pathname> — confirm the host shape against a live
 * store; the uploads/ prefix is enforced by /api/ingest/token either way.
 */
function isRawUploadBlobUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    /\.public\.blob\.vercel-storage\.com$/.test(url.hostname) &&
    url.pathname.startsWith("/uploads/")
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const storage = getStorage();
  if (storage.name !== "blob") {
    return jsonError(
      501,
      "Finalize needs the blob storage driver (BLOB_READ_WRITE_TOKEN + DATABASE_URL). Local ingest uses multipart POST /api/ingest."
    );
  }

  let body: { uploadUrl?: unknown; fileName?: unknown };
  try {
    body = (await req.json()) as { uploadUrl?: unknown; fileName?: unknown };
  } catch {
    return jsonError(400, "Expected a JSON body: { uploadUrl, fileName }.");
  }

  const { uploadUrl, fileName } = body;
  if (typeof uploadUrl !== "string" || !isRawUploadBlobUrl(uploadUrl)) {
    return jsonError(400, "`uploadUrl` must be an uploads/ URL from this app's blob store.");
  }
  if (typeof fileName !== "string" || fileName.length === 0) {
    return jsonError(400, "`fileName` is required.");
  }

  const runId = newRunId();
  const ext = videoExtFor(fileName);
  const tmpPath = path.join(await storage.stagingDir(), `${runId}${ext}`);

  try {
    // Download the raw upload to local staging (public blob URL, so a plain
    // fetch — no token needed).
    const res = await fetch(uploadUrl);
    if (!res.ok || !res.body) {
      return jsonError(502, `Could not download the uploaded blob (HTTP ${res.status}).`);
    }
    await pipeline(
      Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream),
      createWriteStream(tmpPath)
    );

    const result = await runIngestPipeline(runId, tmpPath, ext);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof IngestError) return jsonError(err.status, err.message);
    console.error("[ingest/finalize] failed:", err);
    return jsonError(500, "Ingest failed on the server — see server logs.");
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    // The raw uploads/ blob is single-use: once staged (or failed), nothing
    // can retry from it, so release it regardless of outcome. Best-effort —
    // a stale blob is preferable to a failed ingest response.
    await del(uploadUrl).catch((delErr) =>
      console.warn("[ingest/finalize] raw upload deletion failed (continuing):", delErr)
    );
  }
}
