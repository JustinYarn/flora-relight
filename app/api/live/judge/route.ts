/**
 * POST /api/live/judge — one judge, one eval, one verdict.
 *
 * Body: { evalId, judge: "gemini" | "claude", rubric, beforeUrl, afterUrl,
 *         beforeFrames?, afterFrames?, anchorDataUrl? }
 *
 * gemini — VIDEO-NATIVE: both full clips are uploaded (Files API, cached) and
 *   judged with a JudgeVerdict-shaped responseJsonSchema.
 * claude — FRAME-GRID: up to 10+10 labeled before/after stills (client-sampled
 *   data URLs) judged via structured output (output_config json_schema —
 *   verified working against claude-opus-4-8 with this exact schema).
 *
 * The raw model JSON is coerced into the app's JudgeVerdict; upstream errors
 * come back as 502 with a short safe message (no env/key details, ever).
 */

import { NextRequest, NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import {
  GEMINI_PRO_MODEL,
  getGemini,
  loadImageRef,
  parseDataUrl,
  resolveSourceUrl,
  uploadVideoCached,
  withRetry,
} from "@/lib/server/gemini";
import { CLAUDE_JUDGE_MODEL, getAnthropic } from "@/lib/server/anthropic";
import { getEvalDef } from "@/lib/prompts/eval-defs";
import { PRICE_TABLE } from "@/lib/cost";
import { clamp, verdictFor } from "@/lib/util";
import type {
  JudgeId,
  JudgeVerdict,
  Verdict,
  Violation,
  ViolationSeverity,
} from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_FRAMES_PER_SIDE = 10;

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

// ---------------------------------------------------------------------------
// Output schemas (JudgeVerdict-shaped; additionalProperties:false everywhere,
// no numeric min/max — required by Claude structured outputs)
// ---------------------------------------------------------------------------

const VIOLATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["aspect", "severity", "description", "correction", "frameTimestampSec"],
  properties: {
    aspect: { type: "string" },
    severity: { type: "string", enum: ["critical", "major", "minor"] },
    description: { type: "string" },
    correction: { type: "string" },
    frameTimestampSec: { type: ["number", "null"] },
  },
} as const;

const JUDGE_VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "verdict", "violations", "reasoning"],
  properties: {
    score: { type: "number" },
    verdict: { type: "string", enum: ["pass", "borderline", "fail"] },
    violations: { type: "array", items: VIOLATION_SCHEMA },
    reasoning: { type: "string" },
  },
} as const;

// ---------------------------------------------------------------------------
// Coercion: raw model JSON → the app's JudgeVerdict
// ---------------------------------------------------------------------------

const SEVERITIES: ViolationSeverity[] = ["critical", "major", "minor"];
const VERDICTS: Verdict[] = ["pass", "borderline", "fail"];

function coerceViolations(raw: unknown): Violation[] {
  if (!Array.isArray(raw)) return [];
  const out: Violation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (typeof v.aspect !== "string" || typeof v.correction !== "string") continue;
    out.push({
      aspect: v.aspect,
      severity: SEVERITIES.includes(v.severity as ViolationSeverity)
        ? (v.severity as ViolationSeverity)
        : "major",
      description: typeof v.description === "string" ? v.description : "",
      correction: v.correction,
      ...(typeof v.frameTimestampSec === "number" && Number.isFinite(v.frameTimestampSec)
        ? { frameTimestampSec: v.frameTimestampSec }
        : {}),
    });
  }
  return out;
}

function coerceVerdict(judge: JudgeId, evalId: string, raw: unknown): JudgeVerdict {
  const def = getEvalDef(evalId);
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const score = clamp(typeof obj.score === "number" ? obj.score : Number(obj.score) || 0, 0, 100);
  const verdict = VERDICTS.includes(obj.verdict as Verdict)
    ? (obj.verdict as Verdict)
    : verdictFor(score, def.passThreshold, def.borderlineThreshold);
  return {
    judge,
    score,
    verdict,
    violations: coerceViolations(obj.violations),
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
  };
}

/**
 * The rubric templates reference {{BEFORE_FRAMES}} / {{AFTER_FRAMES}}
 * placeholders — substitute them for the material each judge actually gets.
 */
function fillRubric(rubric: string, protocol: "video" | "frames"): string {
  const before =
    protocol === "video"
      ? "the ORIGINAL video (the first video attached to this message)"
      : "the BEFORE images attached above (labeled with their timestamps)";
  const after =
    protocol === "video"
      ? "the CANDIDATE relit video (the second video attached to this message)"
      : "the AFTER images attached above (labeled with their timestamps)";
  return rubric.split("{{BEFORE_FRAMES}}").join(before).split("{{AFTER_FRAMES}}").join(after);
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

interface FrameIn {
  timestampSec?: unknown;
  dataUrl?: unknown;
}

interface JudgeBody {
  evalId?: unknown;
  judge?: unknown;
  rubric?: unknown;
  beforeUrl?: unknown;
  afterUrl?: unknown;
  beforeFrames?: unknown;
  afterFrames?: unknown;
  anchorDataUrl?: unknown;
}

function usableFrames(raw: unknown): Array<{ timestampSec: number; dataUrl: string }> {
  if (!Array.isArray(raw)) return [];
  return (raw as FrameIn[])
    .filter((f) => f && typeof f.dataUrl === "string" && f.dataUrl.startsWith("data:"))
    .slice(0, MAX_FRAMES_PER_SIDE)
    .map((f) => ({
      timestampSec: typeof f.timestampSec === "number" ? f.timestampSec : 0,
      dataUrl: f.dataUrl as string,
    }));
}

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

async function judgeWithGemini(
  evalId: string,
  rubric: string,
  beforeUrl: string,
  afterUrl: string,
  anchorRef: string | undefined
): Promise<JudgeVerdict> {
  const [beforeAbs, afterAbs] = await Promise.all([
    resolveSourceUrl(beforeUrl),
    resolveSourceUrl(afterUrl),
  ]);
  const [beforeUp, afterUp] = await Promise.all([
    uploadVideoCached(beforeAbs),
    uploadVideoCached(afterAbs),
  ]);

  const parts: Array<Record<string, unknown>> = [
    { text: fillRubric(rubric, "video") },
    { text: "ORIGINAL (BEFORE) video:" },
    { fileData: { fileUri: beforeUp.uri, mimeType: "video/mp4" } },
    { text: "CANDIDATE relit (AFTER) video:" },
    { fileData: { fileUri: afterUp.uri, mimeType: "video/mp4" } },
  ];
  if (anchorRef) {
    const anchor = await loadImageRef(anchorRef);
    parts.push({ text: "APPROVED LOOK ANCHOR reference image:" });
    parts.push({ inlineData: { mimeType: anchor.mimeType, data: anchor.data } });
  }

  const ai = getGemini();
  const response = await withRetry(() =>
    ai.models.generateContent({
      model: GEMINI_PRO_MODEL,
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: JUDGE_VERDICT_SCHEMA,
      },
    })
  );
  const text = response.text;
  if (!text) throw new Error("Gemini judge returned no content.");
  return coerceVerdict("gemini", evalId, JSON.parse(text));
}

const CLAUDE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ClaudeImageType = (typeof CLAUDE_IMAGE_TYPES)[number];

function claudeImageBlock(dataUrl: string): Anthropic.Messages.ImageBlockParam {
  const { mimeType, data } = parseDataUrl(dataUrl);
  if (!CLAUDE_IMAGE_TYPES.includes(mimeType as ClaudeImageType)) {
    throw new Error("Unsupported frame image type.");
  }
  return {
    type: "image",
    source: { type: "base64", media_type: mimeType as ClaudeImageType, data },
  };
}

async function judgeWithClaude(
  evalId: string,
  rubric: string,
  beforeFrames: Array<{ timestampSec: number; dataUrl: string }>,
  afterFrames: Array<{ timestampSec: number; dataUrl: string }>,
  anchorRef: string | undefined
): Promise<JudgeVerdict> {
  if (beforeFrames.length === 0 || afterFrames.length === 0) {
    throw new Error("Claude judge requires before/after frame data URLs.");
  }

  const content: Anthropic.Messages.ContentBlockParam[] = [];
  beforeFrames.forEach((f, i) => {
    content.push({ type: "text", text: `Image ${i + 1} (before, t=${f.timestampSec}s)` });
    content.push(claudeImageBlock(f.dataUrl));
  });
  afterFrames.forEach((f, i) => {
    content.push({ type: "text", text: `Image ${i + 1} (after, t=${f.timestampSec}s)` });
    content.push(claudeImageBlock(f.dataUrl));
  });
  if (anchorRef) {
    const anchor = await loadImageRef(anchorRef);
    if (CLAUDE_IMAGE_TYPES.includes(anchor.mimeType as ClaudeImageType)) {
      content.push({ type: "text", text: "APPROVED LOOK ANCHOR reference image:" });
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: anchor.mimeType as ClaudeImageType,
          data: anchor.data,
        },
      });
    }
  }
  content.push({ type: "text", text: fillRubric(rubric, "frames") });

  const anthropic = getAnthropic();
  const msg = await anthropic.messages.create({
    model: CLAUDE_JUDGE_MODEL,
    max_tokens: 2048,
    output_config: {
      format: {
        type: "json_schema",
        schema: JUDGE_VERDICT_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    messages: [{ role: "user", content }],
  });

  const textBlock = msg.content.find(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text"
  );
  if (!textBlock) throw new Error("Claude judge returned no text content.");
  return coerceVerdict("claude", evalId, JSON.parse(textBlock.text));
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: JudgeBody;
  try {
    body = (await req.json()) as JudgeBody;
  } catch {
    return jsonError(400, "Expected a JSON body.");
  }

  const { evalId, judge, rubric, beforeUrl, afterUrl, anchorDataUrl } = body;
  if (typeof evalId !== "string") return jsonError(400, "Missing evalId.");
  try {
    getEvalDef(evalId);
  } catch {
    return jsonError(400, "Unknown evalId.");
  }
  if (judge !== "gemini" && judge !== "claude") {
    return jsonError(400, 'judge must be "gemini" or "claude".');
  }
  if (typeof rubric !== "string" || rubric.length === 0) {
    return jsonError(400, "Missing rubric.");
  }
  if (anchorDataUrl !== undefined && typeof anchorDataUrl !== "string") {
    return jsonError(400, "anchorDataUrl must be a string.");
  }

  try {
    if (judge === "gemini") {
      if (typeof beforeUrl !== "string" || typeof afterUrl !== "string") {
        return jsonError(400, "Gemini judge requires beforeUrl and afterUrl.");
      }
      const verdict = await judgeWithGemini(evalId, rubric, beforeUrl, afterUrl, anchorDataUrl);
      return NextResponse.json({ verdict, costUsd: PRICE_TABLE.geminiJudgePerCall.usd });
    }
    const verdict = await judgeWithClaude(
      evalId,
      rubric,
      usableFrames(body.beforeFrames),
      usableFrames(body.afterFrames),
      anchorDataUrl
    );
    return NextResponse.json({ verdict, costUsd: PRICE_TABLE.claudeJudgePerCall.usd });
  } catch (err) {
    console.error(
      `[live/judge] ${judge}/${evalId} failed:`,
      err instanceof Error ? err.message : err
    );
    return jsonError(502, "Judge call failed upstream.");
  }
}
