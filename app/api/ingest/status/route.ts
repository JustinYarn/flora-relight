/** Recover a committed cloud-ingest receipt after an interrupted browser tab. */

import { NextRequest, NextResponse } from "next/server";
import { get } from "@vercel/blob";
import {
  IngestError,
  readCommittedCloudIngestByRunId,
  type IngestResult,
} from "@/lib/server/ingest";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const storage = getStorage();
  if (storage.name !== "blob") {
    return NextResponse.json({ error: "Cloud ingest is not active." }, { status: 404 });
  }

  const requestedRunId = req.nextUrl.searchParams.get("runId");
  if (requestedRunId === null) {
    if (!storage.listPendingIngestUploads) {
      return NextResponse.json(
        { error: "Pending upload discovery is unavailable." },
        { status: 501 }
      );
    }
    const uploads = await storage.listPendingIngestUploads(100);
    return NextResponse.json(
      {
        // Never expose the private Blob pathname or completion signature.
        uploads: uploads.map((upload) => ({
          runId: upload.runId,
          fileName: upload.fileName,
          createdAt: upload.createdAt,
          completed: upload.completed !== undefined,
        })),
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } }
    );
  }

  const runId = requestedRunId;
  if (!isValidRunId(runId)) {
    return NextResponse.json({ error: "Invalid runId." }, { status: 400 });
  }

  let result: IngestResult | null;
  try {
    result = await readCommittedCloudIngestByRunId(runId);
  } catch (error) {
    if (error instanceof IngestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      "[ingest/status] receipt recovery failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      { error: "The ingest receipt could not be read safely." },
      { status: 500 }
    );
  }
  if (!result) {
    const reservation = storage.getIngestUpload
      ? await storage.getIngestUpload(runId)
      : null;
    if (reservation?.access === "private") {
      try {
        // One-byte authenticated probe: enough to prove the deterministic raw
        // object exists without returning its provider URL or downloading the
        // entire clip. POST /api/ingest/finalize performs the full read.
        const raw = await get(reservation.pathname, {
          access: "private",
          headers: { Range: "bytes=0-0" },
        });
        if (raw?.statusCode === 200) {
          await raw.stream.cancel().catch(() => {});
          return NextResponse.json(
            { recoverable: true },
            { headers: { "Cache-Control": "private, no-store, max-age=0" } }
          );
        }
      } catch (error) {
        console.error(
          "[ingest/status] private upload recovery probe failed:",
          error instanceof Error ? error.message : error
        );
        return NextResponse.json(
          { error: "The pending private upload could not be checked safely." },
          { status: 500 }
        );
      }
    }
    return NextResponse.json(
      { error: "No committed ingest was found." },
      {
        status: 404,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      }
    );
  }
  return NextResponse.json(
    { result },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } }
  );
}
