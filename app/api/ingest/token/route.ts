/**
 * POST /api/ingest/token — client-upload token route (step 1 of the cloud
 * ingest flow).
 *
 * Deployed Vercel functions cap request bodies at 4.5MB, so in blob-driver
 * deployments the browser uploads the video DIRECTLY to Vercel Blob:
 * `upload()` from @vercel/blob/client POSTs here, `handleUpload()` mints a
 * short-lived client token scoped to what onBeforeGenerateToken returns
 * (video/* only, 500MB cap, uploads/ prefix with a random suffix), the
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
import { verifyGateCookie } from "@/lib/server/gate";
import { MAX_UPLOAD_BYTES } from "@/lib/server/ingest";
import { getStorage } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (getStorage().name !== "blob") {
    return NextResponse.json(
      {
        error:
          "Client uploads need the blob storage driver (BLOB_READ_WRITE_TOKEN + DATABASE_URL). Local ingest uses multipart POST /api/ingest.",
      },
      { status: 501 }
    );
  }

  if (!(await verifyGateCookie(req))) {
    return NextResponse.json(
      { error: "Access gate: authentication required." },
      { status: 401 }
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // The client controls the requested pathname — pin raw uploads to
        // their own prefix so a token can never target runs/ media keys.
        if (!pathname.startsWith("uploads/")) {
          throw new Error("Uploads must use the uploads/ pathname prefix.");
        }
        return {
          allowedContentTypes: ["video/*"],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
        };
      },
      // No onUploadCompleted: the client drives POST /api/ingest/finalize
      // itself (the store's completion webhook can't reach localhost and
      // would add nothing here — finalize deletes the raw blob either way).
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    // handleUpload throws for unknown event types, bad tokens, and our
    // onBeforeGenerateToken rejections — all client-fixable.
    const message = err instanceof Error ? err.message : "Token generation failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
