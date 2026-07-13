/**
 * POST /api/ingest/finalize — { runId } (step 2 of the cloud
 * ingest flow).
 *
 * After the browser uploads the raw video DIRECTLY to Vercel Blob (client
 * token from /api/ingest/token), it posts only its reserved run id here. This
 * route resolves the server-owned private pathname and downloads it to a
 * local staging file (ffmpeg needs real
 * paths), runs the exact same pipeline as multipart /api/ingest
 * (lib/server/ingest.ts: probe → auto-trim >10s → persist source.mp4 →
 * audio demux + sha256), commits a durable ingest receipt, then deletes the
 * now-redundant raw uploads/ blob and responds with the identical shape.
 * Failed attempts retain the raw Blob so the same request can be retried.
 *
 * Only meaningful when the blob driver is active — 501 otherwise. Access is
 * enforced by the middleware gate like every other API route. The client
 * cannot choose a download origin or finalize another run's upload.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { del, get } from "@vercel/blob";
import {
  commitCloudIngest,
  cleanCloudIngestScratch,
  cloudUploadFingerprint,
  IngestError,
  MAX_UPLOAD_BYTES,
  persistPreparedRun,
  readCommittedCloudIngest,
  runIngestPipeline,
  videoExtFor,
} from "@/lib/server/ingest";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";

export const runtime = "nodejs";
// Download + potential re-encode trim of a large clip takes real time.
export const maxDuration = 300;

const INGEST_LEASE_MS = 6 * 60 * 1000;

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function uploadLimitMessage(bytes: number): string {
  return `File is ${(bytes / (1024 * 1024)).toFixed(1)}MB — the limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`;
}

async function deleteCommittedRawUpload(pathname: string): Promise<void> {
  await del(pathname).catch((err) =>
    console.warn("[ingest/finalize] committed raw upload deletion failed:", err)
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

  let body: { runId?: unknown };
  try {
    body = (await req.json()) as { runId?: unknown };
  } catch {
    return jsonError(400, "Expected a JSON body: { runId }.");
  }

  const { runId: requestedRunId } = body;
  if (!isValidRunId(requestedRunId)) {
    return jsonError(400, "`runId` is required and must match [a-z0-9_-] (1-64 chars).");
  }
  if (!storage.getIngestUpload) {
    return jsonError(501, "Durable upload ownership storage is unavailable.");
  }
  const reservation = await storage.getIngestUpload(requestedRunId);
  if (!reservation || reservation.access !== "private") {
    return jsonError(409, "No private upload is reserved for that run id.");
  }

  const runId = requestedRunId;
  const uploadIdentity = reservation.pathname;
  const ext = videoExtFor(reservation.fileName);
  let tmpPath: string | undefined;
  let claimToken: string | undefined;

  try {
    // The receipt is the commit marker. It lets an identical retry succeed even
    // when the first response was lost after raw-Blob cleanup.
    const committed = await readCommittedCloudIngest(runId, uploadIdentity);
    if (committed) {
      await persistPreparedRun(committed, reservation.fileName);
      await deleteCommittedRawUpload(reservation.pathname);
      return NextResponse.json(committed);
    }

    if (!storage.claimIngestFinalization || !storage.releaseIngestFinalization) {
      return jsonError(501, "Cloud ingest finalization leasing is unavailable.");
    }
    const claim = await storage.claimIngestFinalization(
      runId,
      cloudUploadFingerprint(uploadIdentity),
      INGEST_LEASE_MS
    );
    if (claim.status !== "acquired") {
      if (claim.status === "conflict") {
        return jsonError(409, "That run id is reserved for a different upload.");
      }
      return NextResponse.json(
        { error: "This upload is already being finalized. Retry shortly." },
        { status: 409, headers: { "Retry-After": "3" } }
      );
    }
    claimToken = claim.token;

    // Close the gap between the pre-claim receipt read and lease acquisition:
    // another request may have committed and released while this one waited.
    const committedAfterClaim = await readCommittedCloudIngest(runId, uploadIdentity);
    if (committedAfterClaim) {
      await persistPreparedRun(committedAfterClaim, reservation.fileName);
      await deleteCommittedRawUpload(reservation.pathname);
      return NextResponse.json(committedAfterClaim);
    }

    // A real Run means this id is no longer an ingest-only reservation. Legacy
    // runs may predate receipts, so never clear their media to satisfy a retry.
    if (await storage.getRun(runId)) {
      return jsonError(409, "That run id already belongs to a workflow run.");
    }

    tmpPath = path.join(
      await storage.stagingDir(),
      `${runId}-${randomBytes(6).toString("hex")}${ext}`
    );
    // Authenticated SDK read: private provider URLs and credentials stay on
    // the server. A missing object means transfer has not completed yet.
    const res = await get(reservation.pathname, {
      access: "private",
      useCache: false,
    });
    if (!res || res.statusCode !== 200) {
      return jsonError(409, "The private upload has not completed yet.");
    }
    const contentLength = res.blob.size;
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
      return jsonError(413, uploadLimitMessage(contentLength));
    }
    let receivedBytes = 0;
    const sizeLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_UPLOAD_BYTES) {
          callback(new IngestError(413, uploadLimitMessage(receivedBytes)));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.stream as unknown as import("stream/web").ReadableStream),
      sizeLimit,
      createWriteStream(tmpPath)
    );

    // A prior attempt may have durably uploaded source.mp4 before failing on
    // audio or receipt commit. Clear only that ingest-only partial state, and
    // only after proving the raw Blob is still downloadable for this retry.
    if ((await storage.listMedia(runId)).length > 0) {
      await storage.deleteMediaDir(runId);
      await cleanCloudIngestScratch(runId);
    }

    const result = await runIngestPipeline(runId, tmpPath, ext);
    await commitCloudIngest(runId, uploadIdentity, result);
    await persistPreparedRun(result, reservation.fileName);
    await deleteCommittedRawUpload(reservation.pathname);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof IngestError) return jsonError(err.status, err.message);
    console.error("[ingest/finalize] failed:", err);
    return jsonError(500, "Ingest failed on the server — see server logs.");
  } finally {
    if (tmpPath) await fsp.rm(tmpPath, { force: true }).catch(() => {});
    if (claimToken && storage.releaseIngestFinalization) {
      await storage.releaseIngestFinalization(runId, claimToken).catch((err) =>
        console.warn("[ingest/finalize] lease release failed:", err)
      );
    }
  }
}
