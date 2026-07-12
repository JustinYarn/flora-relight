/**
 * POST /api/live/anchor — Stage A Look Anchor relight (proven shape #1).
 *
 * Body: { runId, frameDataUrl, instruction, previousInteractionId?, version }
 * Runs gemini-3.1-flash-image on the reference frame, writes the returned
 * JPEG to data/runs/<runId>/anchor-v<version>.jpg, and returns its served
 * url plus the interaction id (chained for correction turns).
 *
 * CRITICAL (proven live): the OUTPUT mime_type must be "image/jpeg" —
 * "image/png" is rejected with 400. Input frames may be png or jpeg.
 */

import { NextRequest, NextResponse } from "next/server";
import fsp from "node:fs/promises";
import {
  GEMINI_IMAGE_MODEL,
  getGemini,
  parseDataUrl,
} from "@/lib/server/gemini";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";
import { PRICE_TABLE } from "@/lib/cost";

export const runtime = "nodejs";
export const maxDuration = 120;

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

interface AnchorBody {
  runId?: unknown;
  frameDataUrl?: unknown;
  instruction?: unknown;
  previousInteractionId?: unknown;
  version?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: AnchorBody;
  try {
    body = (await req.json()) as AnchorBody;
  } catch {
    return jsonError(400, "Expected a JSON body.");
  }

  const { runId, frameDataUrl, instruction, previousInteractionId, version } = body;
  if (!isValidRunId(runId)) return jsonError(400, "Invalid runId.");
  if (typeof frameDataUrl !== "string") return jsonError(400, "Missing frameDataUrl.");
  if (typeof instruction !== "string" || instruction.length === 0) {
    return jsonError(400, "Missing instruction.");
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return jsonError(400, "version must be a positive integer.");
  }
  if (previousInteractionId !== undefined && typeof previousInteractionId !== "string") {
    return jsonError(400, "previousInteractionId must be a string.");
  }

  let frame: { mimeType: string; data: string };
  try {
    frame = parseDataUrl(frameDataUrl);
  } catch {
    return jsonError(400, "frameDataUrl must be a base64 image data URL.");
  }

  try {
    const ai = getGemini();
    const r = await ai.interactions.create({
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
      ...(previousInteractionId
        ? { previous_interaction_id: previousInteractionId }
        : {}),
    });

    const outData = r.output_image?.data;
    if (!outData || !r.id) {
      return jsonError(502, "Image relight returned no output image.");
    }

    // Write locally, then persist through the storage driver (fs driver:
    // the local path already IS the canonical destination — put is a no-op).
    const storage = getStorage();
    const fileName = `anchor-v${version}.jpg`;
    const localPath = await storage.mediaWritePath(runId, fileName);
    await fsp.writeFile(localPath, Buffer.from(outData, "base64"));
    await storage.putMediaFromFile(runId, fileName, localPath);

    return NextResponse.json({
      imageUrl: await storage.publicMediaUrl(runId, fileName),
      interactionId: r.id,
      costUsd: PRICE_TABLE.geminiImageEditPerImage.usd,
    });
  } catch (err) {
    console.error("[live/anchor] failed:", err instanceof Error ? err.message : err);
    return jsonError(502, "Look Anchor relight failed upstream.");
  }
}
