/**
 * POST /api/live/anchor — Stage A Look Anchor relight (proven shape #1).
 *
 * Body: { runId, instruction, previousInteractionId?, version }
 * Extracts the reference frame from the Run's canonical stored source video, runs
 * the configured Gemini image model on it, writes the returned
 * JPEG to data/runs/<runId>/anchor-v<version>.jpg, and returns its served
 * url plus the interaction id. Exactly one Stage-A anchor is authorized per
 * run because that is the amount included in the confirmed spend estimate.
 *
 * CRITICAL (proven live): the OUTPUT mime_type must be "image/jpeg" —
 * "image/png" is rejected with 400. Input frames may be png or jpeg.
 */

import { NextRequest, NextResponse } from "next/server";
import fsp from "node:fs/promises";
import {
  GEMINI_IMAGE_MODEL,
  getGemini,
  hasGeminiKey,
  parseDataUrl,
} from "@/lib/server/gemini";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";
import { PRICE_TABLE } from "@/lib/cost";
import { canonicalLiveAnchorPrompt } from "@/lib/prompts/anchor";
import { FLORA_WORKFLOW } from "@/lib/workflow-def";
import { extractServerFrames } from "@/lib/server/frame-extraction";
import {
  PaidOperationAuthorizationError,
  anchorOperationId,
  beginPaidOperation,
  completePaidOperation,
  markPaidOperationReconcileRequired,
  paidOperationBlockedMessage,
} from "@/lib/server/paid-operation";

export const runtime = "nodejs";
export const maxDuration = 120;

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

interface AnchorBody {
  runId?: unknown;
  instruction?: unknown;
  previousInteractionId?: unknown;
  version?: unknown;
}

interface AnchorResult {
  imageUrl: string;
  interactionId: string;
  costUsd: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: AnchorBody;
  try {
    body = (await req.json()) as AnchorBody;
  } catch {
    return jsonError(400, "Expected a JSON body.");
  }

  const { runId, instruction, previousInteractionId, version } = body;
  if (!isValidRunId(runId)) return jsonError(400, "Invalid runId.");
  if (typeof instruction !== "string" || instruction.length === 0) {
    return jsonError(400, "Missing instruction.");
  }
  if (instruction !== canonicalLiveAnchorPrompt()) {
    return jsonError(409, "instruction does not match the canonical anchor prompt.");
  }
  if (version !== 1) {
    return jsonError(400, "Only the single approved Stage-A anchor is supported.");
  }
  if (previousInteractionId !== undefined && typeof previousInteractionId !== "string") {
    return jsonError(400, "previousInteractionId must be a string.");
  }

  const storage = getStorage();
  const run = await storage.getRun(runId);
  if (!run) return jsonError(404, "Run not found.");

  if (previousInteractionId !== undefined) {
    return jsonError(409, "The canonical Stage-A anchor has no previous interaction.");
  }

  const operationId = anchorOperationId(version);
  const existingOperation = await storage.getPaidOperation(runId, operationId);
  // Old and new clients must share the same exactly-once boundary. Return an
  // already-committed result without recomputing the newer canonical hash;
  // every ambiguous/in-flight legacy operation remains sealed.
  if (existingOperation) {
    if (existingOperation.status === "completed" && existingOperation.result !== undefined) {
      return NextResponse.json(existingOperation.result, {
        headers: { "X-Flora-Paid-Operation": "cached" },
      });
    }
    return jsonError(
      409,
      existingOperation.status === "reconcile_required"
        ? "This anchor request has an ambiguous outcome and requires reconciliation before any retry."
        : "This anchor request may already be in progress. Reconcile it before any retry."
    );
  }
  if (!hasGeminiKey()) {
    return jsonError(503, "Gemini is not configured.");
  }

  const anchorTimestampSec = FLORA_WORKFLOW.config.frameTimestamps[0] ?? 0.5;
  let frameDataUrl: string;
  let frameSha256: string;
  try {
    const [frame] = await extractServerFrames(
      run.originalVideo.url,
      [anchorTimestampSec]
    );
    frameDataUrl = frame.dataUrl;
    frameSha256 = frame.sha256;
  } catch {
    return jsonError(409, "The canonical source frame could not be extracted.");
  }
  const frame = parseDataUrl(frameDataUrl);

  let reservation: Awaited<ReturnType<typeof beginPaidOperation>>;
  try {
    reservation = await beginPaidOperation({
      run,
      id: operationId,
      provider: "gemini",
      kind: "anchor",
      iteration: version,
      canonicalInput: {
        model: GEMINI_IMAGE_MODEL,
        sourceUrl: run.originalVideo.url,
        frameTimestampSec: anchorTimestampSec,
        frameSha256,
        instruction,
        responseFormat: {
          type: "image",
          aspectRatio: "16:9",
          imageSize: "1K",
          mimeType: "image/jpeg",
        },
      },
    });
  } catch (error) {
    if (error instanceof PaidOperationAuthorizationError) {
      return jsonError(403, error.message);
    }
    console.error("[live/anchor] reservation failed");
    return jsonError(503, "Could not reserve anchor generation safely.");
  }
  if (reservation.state === "cached") {
    return NextResponse.json(reservation.operation.result, {
      headers: { "X-Flora-Paid-Operation": "cached" },
    });
  }
  if (reservation.state === "blocked") {
    return jsonError(
      reservation.reason === "run_missing" ? 404 : 409,
      paidOperationBlockedMessage(reservation)
    );
  }

  try {
    const ai = getGemini();
    const r = await ai.interactions.create(
      {
        model: GEMINI_IMAGE_MODEL,
        input: [
          { type: "text", text: instruction },
          { type: "image", mime_type: frame.mimeType, data: frame.data },
        ],
        response_format: {
          type: "image",
          aspect_ratio: "16:9",
          image_size: "1K",
          mime_type: "image/jpeg", // png output is rejected upstream with 400
        },
      },
      { maxRetries: 0 }
    );

    const outData = r.output_image?.data;
    if (!outData || !r.id) {
      throw new Error("Image relight returned no output image.");
    }

    // Write locally, then persist through the storage driver (fs driver:
    // the local path already IS the canonical destination — put is a no-op).
    const fileName = `anchor-v${version}.jpg`;
    const localPath = await storage.mediaWritePath(runId, fileName);
    await fsp.writeFile(localPath, Buffer.from(outData, "base64"));
    await storage.putMediaFromFile(runId, fileName, localPath);

    const result = await completePaidOperation<AnchorResult>(reservation.operation, {
      imageUrl: await storage.publicMediaUrl(runId, fileName),
      interactionId: r.id,
      costUsd: PRICE_TABLE.geminiImageEditPerImage.usd,
    });
    return NextResponse.json(result, {
      headers: { "X-Flora-Paid-Operation": "completed" },
    });
  } catch (err) {
    try {
      await markPaidOperationReconcileRequired(
        reservation.operation,
        "Anchor request failed or returned an ambiguous result."
      );
    } catch {
      // The existing in-progress claim still prevents duplicate spend.
    }
    console.error("[live/anchor] failed:", err instanceof Error ? err.message : err);
    return jsonError(
      502,
      "Look Anchor outcome is uncertain and requires reconciliation."
    );
  }
}
