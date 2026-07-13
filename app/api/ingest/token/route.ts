/**
 * POST /api/ingest/token — client-upload token route (step 1 of the cloud
 * ingest flow).
 *
 * Deployed Vercel functions cap request bodies at 4.5MB, so in blob-driver
 * deployments the browser uploads the video DIRECTLY to Vercel Blob:
 * `upload()` from @vercel/blob/client POSTs here, `handleUpload()` mints a
 * short-lived client token scoped to what onBeforeGenerateToken returns
 * (private store, video/* only, 150MB cap, deterministic run-owned path), the
 * browser streams the file to the store, then calls /api/ingest/finalize.
 *
 * AUTH — the token grants WRITE access to the blob store, so this route
 * verifies the FLORA_ACCESS_PASSWORD gate cookie itself (lib/server/gate.ts,
 * same check as middleware.ts) rather than relying on the middleware matcher
 * alone. Password unset → open, exactly like the middleware no-op. The
 * client's upload() fetches same-origin, so the cookie rides along.
 *
 * Only meaningful when the blob driver is active — 501 otherwise (local/fs
 * ingest uses multipart /api/ingest).
 */

import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import {
  hostedGateConfigurationIssue,
  verifyGateCookie,
} from "@/lib/server/gate";
import {
  MAX_UPLOAD_BYTES,
  VIDEO_EXT_RE,
  videoExtFor,
} from "@/lib/server/ingest";
import { isValidRunId } from "@/lib/server/runstore";
import { checkSameOriginRequest } from "@/lib/server/request-security";
import { getStorage } from "@/lib/server/storage";
import type { IngestUploadReservation } from "@/lib/server/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const storage = getStorage();
  if (storage.name !== "blob") {
    return NextResponse.json(
      {
        error:
          "Client uploads need the blob storage driver (BLOB_READ_WRITE_TOKEN + DATABASE_URL). Local ingest uses multipart POST /api/ingest.",
      },
      { status: 501 }
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (
    !parsedBody ||
    typeof parsedBody !== "object" ||
    !("type" in parsedBody) ||
    typeof parsedBody.type !== "string"
  ) {
    return NextResponse.json({ error: "Invalid upload event." }, { status: 400 });
  }
  const body = parsedBody as HandleUploadBody;

  const isSignedCompletion = body.type === "blob.upload-completed";
  if (!isSignedCompletion) {
    if (hostedGateConfigurationIssue(process.env.FLORA_ACCESS_PASSWORD)) {
      return NextResponse.json(
        { error: "Production access protection is not configured securely." },
        { status: 503 }
      );
    }
    const sameOrigin = checkSameOriginRequest(req);
    if (!sameOrigin.ok) {
      return NextResponse.json(
        { error: "Cross-origin request rejected." },
        { status: 403 }
      );
    }
    if (!(await verifyGateCookie(req))) {
      return NextResponse.json(
        { error: "Access gate: authentication required." },
        { status: 401 }
      );
    }
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
        if (!storage.reserveIngestUpload) {
          throw new Error("Durable upload reservations are unavailable.");
        }
        let payload: { runId?: unknown; fileName?: unknown };
        try {
          payload = JSON.parse(clientPayload ?? "") as {
            runId?: unknown;
            fileName?: unknown;
          };
        } catch {
          throw new Error("Upload ownership metadata is missing or invalid.");
        }
        if (!isValidRunId(payload.runId)) {
          throw new Error("Upload runId is invalid.");
        }
        if (
          typeof payload.fileName !== "string" ||
          payload.fileName.length < 1 ||
          payload.fileName.length > 255 ||
          !VIDEO_EXT_RE.test(payload.fileName)
        ) {
          throw new Error("Upload fileName must identify a supported video file.");
        }
        if (!multipart) {
          throw new Error("Hosted video uploads must use multipart transfer.");
        }
        const expectedPath = `uploads/${payload.runId}/raw${videoExtFor(payload.fileName)}`;
        if (pathname !== expectedPath) {
          throw new Error("Upload pathname does not match its reserved run id.");
        }
        if (
          (await storage.getRun(payload.runId)) ||
          (await storage.mediaExists(payload.runId, "source.mp4"))
        ) {
          throw new Error("That run id already belongs to an ingested workflow.");
        }

        const candidate: IngestUploadReservation = {
          schema: "flora.ingest-upload.v1",
          runId: payload.runId,
          pathname,
          fileName: payload.fileName,
          access: "private",
          createdAt: Date.now(),
        };
        const reserved = await storage.reserveIngestUpload(candidate);
        const durable = reserved.reservation;
        if (
          !durable ||
          durable.runId !== candidate.runId ||
          durable.pathname !== candidate.pathname ||
          durable.fileName !== candidate.fileName ||
          durable.access !== "private"
        ) {
          throw new Error("That run id is reserved for a different upload.");
        }
        return {
          allowedContentTypes: ["video/*"],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: false,
          allowOverwrite: false,
          cacheControlMaxAge: 60,
          validUntil: Date.now() + 60 * 60 * 1000,
          tokenPayload: JSON.stringify({
            runId: durable.runId,
            pathname: durable.pathname,
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        if (!storage.completeIngestUpload || !storage.getIngestUpload) {
          throw new Error("Durable upload completion storage is unavailable.");
        }
        let owner: { runId?: unknown; pathname?: unknown };
        try {
          owner = JSON.parse(tokenPayload ?? "") as {
            runId?: unknown;
            pathname?: unknown;
          };
        } catch {
          throw new Error("Upload completion ownership metadata is invalid.");
        }
        if (
          !isValidRunId(owner.runId) ||
          typeof owner.pathname !== "string" ||
          blob.pathname !== owner.pathname
        ) {
          throw new Error("Upload completion does not match its reserved owner.");
        }
        let blobHost: string;
        try {
          blobHost = new URL(blob.url).hostname;
        } catch {
          throw new Error("Upload completion URL is invalid.");
        }
        if (!blobHost.endsWith(".private.blob.vercel-storage.com")) {
          throw new Error("Upload completion did not use private Blob access.");
        }
        const completed = await storage.completeIngestUpload(
          owner.runId,
          owner.pathname,
          {
            pathname: owner.pathname,
            contentType: blob.contentType,
            etag: blob.etag,
            completedAt: Date.now(),
          }
        );
        if (!completed) {
          throw new Error("Upload completion could not be bound to its reservation.");
        }
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    // handleUpload throws for unknown event types, bad tokens, and our
    // onBeforeGenerateToken rejections — all client-fixable.
    console.error("[ingest/token] Blob upload authorization failed:", err);
    return NextResponse.json(
      {
        error: isSignedCompletion
          ? "Upload completion callback was rejected."
          : "Upload authorization failed.",
      },
      { status: 400 }
    );
  }
}
