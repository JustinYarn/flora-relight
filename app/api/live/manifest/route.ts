/**
 * POST /api/live/manifest — { runId, sourceUrl } → { manifest, costUsd }
 *
 * Uploads the clip to the Gemini Files API (cached per path) and runs the
 * MANIFEST_PROMPT against gemini-3.1-pro-preview with a SceneManifest-shaped
 * responseJsonSchema, so the reply parses directly into the app's type. A
 * durable per-run claim is committed before the one potentially billed call.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  GEMINI_PRO_MODEL,
  getGemini,
  hasGeminiKey,
  resolveSourceUrl,
  uploadVideoCached,
} from "@/lib/server/gemini";
import { MANIFEST_PROMPT } from "@/lib/prompts/manifest";
import { PRICE_TABLE } from "@/lib/cost";
import type { SceneManifest } from "@/lib/types";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";
import {
  PaidOperationAuthorizationError,
  beginPaidOperation,
  completePaidOperation,
  manifestOperationId,
  markPaidOperationReconcileRequired,
  paidOperationBlockedMessage,
} from "@/lib/server/paid-operation";

export const runtime = "nodejs";
export const maxDuration = 180;

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Handwritten from SceneManifest (lib/types.ts) — keep the two in lockstep. */
const SCENE_MANIFEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["person", "background", "camera", "lightingDiagnosis"],
  properties: {
    person: {
      type: "object",
      additionalProperties: false,
      required: ["faceDescriptor", "skinTone", "hair", "clothing", "accessories"],
      properties: {
        faceDescriptor: { type: "string" },
        skinTone: { type: "string" },
        hair: { type: "string" },
        clothing: { type: "array", items: { type: "string" } },
        accessories: { type: "array", items: { type: "string" } },
      },
    },
    background: {
      type: "object",
      additionalProperties: false,
      required: ["objects", "surfaces", "layoutNotes"],
      properties: {
        objects: { type: "array", items: { type: "string" } },
        surfaces: { type: "string" },
        layoutNotes: { type: "string" },
      },
    },
    camera: {
      type: "object",
      additionalProperties: false,
      required: ["framing", "angle", "notes"],
      properties: {
        framing: { type: "string" },
        angle: { type: "string" },
        notes: { type: "string" },
      },
    },
    lightingDiagnosis: { type: "string" },
  },
} as const;

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { runId?: unknown; sourceUrl?: unknown };
  try {
    body = (await req.json()) as { runId?: unknown; sourceUrl?: unknown };
  } catch {
    return jsonError(400, "Expected a JSON body.");
  }
  if (!isValidRunId(body.runId)) return jsonError(400, "Invalid runId.");
  if (typeof body.sourceUrl !== "string") {
    return jsonError(400, "Missing sourceUrl.");
  }

  const storage = getStorage();
  const run = await storage.getRun(body.runId);
  if (!run) return jsonError(404, "Run not found.");
  if (body.sourceUrl !== run.originalVideo.url) {
    return jsonError(409, "sourceUrl does not match the run's canonical source.");
  }

  let absPath: string;
  try {
    absPath = await resolveSourceUrl(run.originalVideo.url);
  } catch {
    return jsonError(400, "Unresolvable source url.");
  }
  const operationId = manifestOperationId();
  const existingOperation = await storage.getPaidOperation(run.id, operationId);
  if (!existingOperation && !hasGeminiKey()) {
    return jsonError(503, "Gemini is not configured.");
  }

  let reservation: Awaited<ReturnType<typeof beginPaidOperation>>;
  try {
    reservation = await beginPaidOperation({
      run,
      id: operationId,
      provider: "gemini",
      kind: "manifest",
      canonicalInput: {
        model: GEMINI_PRO_MODEL,
        sourceUrl: run.originalVideo.url,
        prompt: MANIFEST_PROMPT,
        responseSchema: SCENE_MANIFEST_SCHEMA,
      },
    });
  } catch (error) {
    if (error instanceof PaidOperationAuthorizationError) {
      return jsonError(403, error.message);
    }
    console.error("[live/manifest] reservation failed");
    return jsonError(503, "Could not reserve manifest extraction safely.");
  }
  if (reservation.state === "cached") {
    return NextResponse.json(
      reservation.operation.result,
      { headers: { "X-Flora-Paid-Operation": "cached" } }
    );
  }
  if (reservation.state === "blocked") {
    return jsonError(
      reservation.reason === "run_missing" ? 404 : 409,
      paidOperationBlockedMessage(reservation)
    );
  }

  try {
    const upload = await uploadVideoCached(absPath);
    const ai = getGemini();
    // One provider request only. SDK HTTP retries are explicitly disabled;
    // an ambiguous failure is sealed for reconciliation below.
    const response = await ai.models.generateContent({
      model: GEMINI_PRO_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: MANIFEST_PROMPT },
            { fileData: { fileUri: upload.uri, mimeType: "video/mp4" } },
          ],
        },
      ],
      config: {
        httpOptions: { retryOptions: { attempts: 1 } },
        responseMimeType: "application/json",
        responseJsonSchema: SCENE_MANIFEST_SCHEMA,
      },
    });
    const text = response.text;
    if (!text) throw new Error("Manifest extraction returned no content.");
    const manifest = JSON.parse(text) as SceneManifest;
    const result = await completePaidOperation(reservation.operation, {
      manifest,
      costUsd: PRICE_TABLE.geminiManifestPerCall.usd,
    });
    return NextResponse.json(result, {
      headers: { "X-Flora-Paid-Operation": "completed" },
    });
  } catch (err) {
    try {
      await markPaidOperationReconcileRequired(
        reservation.operation,
        "Manifest request failed or returned an ambiguous result."
      );
    } catch {
      // An in-progress durable claim is already fail-safe if sealing cannot
      // be persisted during a storage outage.
    }
    console.error("[live/manifest] failed:", err instanceof Error ? err.message : err);
    return jsonError(
      502,
      "Manifest extraction outcome is uncertain and requires reconciliation."
    );
  }
}
