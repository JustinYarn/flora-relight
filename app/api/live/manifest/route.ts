/**
 * POST /api/live/manifest — { sourceUrl } → { manifest, costUsd }
 *
 * Uploads the clip to the Gemini Files API (cached per path) and runs the
 * MANIFEST_PROMPT against gemini-3.1-pro-preview with a SceneManifest-shaped
 * responseJsonSchema, so the reply parses directly into the app's type.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  GEMINI_PRO_MODEL,
  getGemini,
  resolveSourceUrl,
  uploadVideoCached,
  withRetry,
} from "@/lib/server/gemini";
import { MANIFEST_PROMPT } from "@/lib/prompts/manifest";
import { PRICE_TABLE } from "@/lib/cost";
import type { SceneManifest } from "@/lib/types";

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
  let body: { sourceUrl?: unknown };
  try {
    body = (await req.json()) as { sourceUrl?: unknown };
  } catch {
    return jsonError(400, "Expected a JSON body.");
  }
  if (typeof body.sourceUrl !== "string") {
    return jsonError(400, "Missing sourceUrl.");
  }

  let absPath: string;
  try {
    absPath = await resolveSourceUrl(body.sourceUrl);
  } catch {
    return jsonError(400, "Unresolvable source url.");
  }

  try {
    const upload = await uploadVideoCached(absPath);
    const ai = getGemini();
    const response = await withRetry(() =>
      ai.models.generateContent({
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
          responseMimeType: "application/json",
          responseJsonSchema: SCENE_MANIFEST_SCHEMA,
        },
      })
    );
    const text = response.text;
    if (!text) return jsonError(502, "Manifest extraction returned no content.");
    const manifest = JSON.parse(text) as SceneManifest;
    return NextResponse.json({
      manifest,
      costUsd: PRICE_TABLE.geminiManifestPerCall.usd,
    });
  } catch (err) {
    console.error("[live/manifest] failed:", err instanceof Error ? err.message : err);
    return jsonError(502, "Manifest extraction failed upstream.");
  }
}
