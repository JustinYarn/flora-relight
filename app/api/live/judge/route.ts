/**
 * POST /api/live/judge — one judge, one eval, one verdict.
 *
 * Body: { runId, iteration, evalId, judge: "gemini" | "claude", rubric,
 *         beforeUrl, afterUrl, anchorDataUrl? }
 *
 * gemini — VIDEO-NATIVE: both full clips are uploaded (Files API, cached) and
 *   judged with a JudgeVerdict-shaped responseJsonSchema.
 * claude — FRAME-GRID: matched before/after stills extracted from the Run's
 *   canonical stored videos on the server, then judged via structured output
 *   (output_config json_schema —
 *   verified working against claude-opus-4-8 with this exact schema).
 *
 * The raw model JSON is coerced into the app's JudgeVerdict. Canonical run
 * assets/rubrics are checked before a durable exactly-once paid claim; errors
 * come back with a short safe message (no env/key details, ever).
 */

import { NextRequest, NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import {
  GEMINI_PRO_MODEL,
  getGemini,
  hasGeminiKey,
  loadImageRef,
  parseDataUrl,
  resolveSourceUrl,
  uploadVideoCached,
} from "@/lib/server/gemini";
import {
  CLAUDE_JUDGE_MODEL,
  getAnthropic,
  hasAnthropicKey,
} from "@/lib/server/anthropic";
import { getEvalDef } from "@/lib/prompts/eval-defs";
import { PRICE_TABLE } from "@/lib/cost";
import { clamp, verdictFor } from "@/lib/util";
import { RELIGHT_WORKFLOW } from "@/lib/workflow-def";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";
import {
  extractServerFrames,
  type ServerFrameSample,
} from "@/lib/server/frame-extraction";
import {
  PaidOperationAuthorizationError,
  anchorOperationId,
  beginPaidOperation,
  completePaidOperation,
  judgeOperationId,
  markPaidOperationReconcileRequired,
  paidOperationBlockedMessage,
} from "@/lib/server/paid-operation";
import type {
  JudgeId,
  JudgeVerdict,
  Verdict,
  Violation,
  ViolationSeverity,
} from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

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

interface JudgeBody {
  runId?: unknown;
  iteration?: unknown;
  evalId?: unknown;
  judge?: unknown;
  rubric?: unknown;
  beforeUrl?: unknown;
  afterUrl?: unknown;
  anchorDataUrl?: unknown;
}

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

async function judgeWithGemini(
  evalId: string,
  rubric: string,
  beforeAbs: string,
  afterAbs: string,
  anchorRef: string | undefined
): Promise<JudgeVerdict> {
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
  const response = await ai.models.generateContent({
    model: GEMINI_PRO_MODEL,
    contents: [{ role: "user", parts }],
    config: {
      // One HTTP attempt only; the operation journal owns ambiguity.
      httpOptions: { retryOptions: { attempts: 1 } },
      responseMimeType: "application/json",
      responseJsonSchema: JUDGE_VERDICT_SCHEMA,
    },
  });
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
  // One model request, with SDK retries and provider-side model fallback
  // disabled. A refusal/transport ambiguity is reconciled, never re-billed.
  const msg = await anthropic.beta.messages.create(
    {
      model: CLAUDE_JUDGE_MODEL,
      max_tokens: 8000,
      output_config: {
        format: {
          type: "json_schema",
          schema: JUDGE_VERDICT_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      messages: [{ role: "user", content }],
    },
    { maxRetries: 0 }
  );

  if (msg.stop_reason === "refusal") {
    throw new Error("Claude judge declined this content.");
  }
  const textBlock = msg.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude judge returned no text content.");
  }
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

  const {
    runId,
    iteration,
    evalId,
    judge,
    rubric,
    beforeUrl,
    afterUrl,
    anchorDataUrl,
  } = body;
  if (!isValidRunId(runId)) return jsonError(400, "Invalid runId.");
  if (
    typeof iteration !== "number" ||
    !Number.isSafeInteger(iteration) ||
    iteration < 1
  ) {
    return jsonError(400, "iteration must be a positive integer.");
  }
  if (typeof evalId !== "string") return jsonError(400, "Missing evalId.");
  let evalDef: ReturnType<typeof getEvalDef>;
  try {
    evalDef = getEvalDef(evalId);
  } catch {
    return jsonError(400, "Unknown evalId.");
  }
  if (judge !== "gemini" && judge !== "claude") {
    return jsonError(400, 'judge must be "gemini" or "claude".');
  }
  if (evalDef.method === "deterministic") {
    return jsonError(400, "Deterministic evals cannot issue paid judge calls.");
  }
  if (!RELIGHT_WORKFLOW.config.judges.includes(judge)) {
    return jsonError(400, "Judge is not enabled by the canonical workflow.");
  }
  if (typeof rubric !== "string" || rubric.length === 0) {
    return jsonError(400, "Missing rubric.");
  }
  if (rubric !== evalDef.promptTemplate) {
    return jsonError(409, "rubric does not match the canonical eval definition.");
  }
  if (anchorDataUrl !== undefined && typeof anchorDataUrl !== "string") {
    return jsonError(400, "anchorDataUrl must be a string.");
  }

  const storage = getStorage();
  const run = await storage.getRun(runId);
  if (!run) return jsonError(404, "Run not found.");
  const videoOperation = run.providerOperations?.find(
    (operation) =>
      operation.kind === "video_generation" &&
      operation.iteration === iteration &&
      operation.status === "completed" &&
      operation.result
  );
  const canonicalBeforeUrl = run.originalVideo.url;
  const canonicalAfterUrl = videoOperation?.result?.videoUrl;
  if (!canonicalAfterUrl) {
    return jsonError(409, "The canonical generated video is not complete.");
  }
  if (beforeUrl !== canonicalBeforeUrl || afterUrl !== canonicalAfterUrl) {
    return jsonError(409, "Judge media URLs do not match the canonical run assets.");
  }

  let canonicalAnchorUrl: string | undefined;
  if (evalId === "lighting-match-to-anchor") {
    const anchorOperation = await storage.getPaidOperation(runId, anchorOperationId(1));
    const anchorResult = anchorOperation?.result as { imageUrl?: unknown } | undefined;
    canonicalAnchorUrl =
      anchorOperation?.status === "completed" &&
      typeof anchorResult?.imageUrl === "string"
        ? anchorResult.imageUrl
        : undefined;
  }
  if (anchorDataUrl !== canonicalAnchorUrl) {
    return jsonError(409, "anchorDataUrl does not match the canonical anchor.");
  }

  const operationId = judgeOperationId(iteration, evalId, judge);
  const existingOperation = await storage.getPaidOperation(runId, operationId);
  // Preserve safe recovery for operations created before server-side frame
  // extraction changed the canonical input fingerprint.
  if (existingOperation) {
    if (existingOperation.status === "completed" && existingOperation.result !== undefined) {
      return NextResponse.json(existingOperation.result, {
        headers: { "X-Flora-Paid-Operation": "cached" },
      });
    }
    return jsonError(
      409,
      existingOperation.status === "reconcile_required"
        ? "This judge request has an ambiguous outcome and requires reconciliation before any retry."
        : "This judge request may already be in progress. Reconcile it before any retry."
    );
  }
  if (
    (judge === "gemini" && !hasGeminiKey()) ||
    (judge === "claude" && !hasAnthropicKey())
  ) {
    return jsonError(503, `${judge === "gemini" ? "Gemini" : "Claude"} is not configured.`);
  }

  let beforeFrames: ServerFrameSample[] = [];
  let afterFrames: ServerFrameSample[] = [];
  let beforeAbs: string | undefined;
  let afterAbs: string | undefined;
  if (judge === "gemini") {
    try {
      [beforeAbs, afterAbs] = await Promise.all([
        resolveSourceUrl(canonicalBeforeUrl),
        resolveSourceUrl(canonicalAfterUrl),
      ]);
    } catch {
      return jsonError(409, "Canonical judge media could not be resolved.");
    }
  } else {
    try {
      [beforeFrames, afterFrames] = await Promise.all([
        extractServerFrames(
          canonicalBeforeUrl,
          RELIGHT_WORKFLOW.config.frameTimestamps
        ),
        extractServerFrames(
          canonicalAfterUrl,
          RELIGHT_WORKFLOW.config.frameTimestamps
        ),
      ]);
      // Parse every canonical extraction before taking a paid claim. A local
      // codec failure must not strand a reserved billing operation.
      beforeFrames.forEach((frame) => claudeImageBlock(frame.dataUrl));
      afterFrames.forEach((frame) => claudeImageBlock(frame.dataUrl));
    } catch {
      return jsonError(409, "Canonical judge frames could not be extracted.");
    }
  }

  let reservation: Awaited<ReturnType<typeof beginPaidOperation>>;
  try {
    reservation = await beginPaidOperation({
      run,
      id: operationId,
      provider: judge,
      kind: "judge",
      iteration,
      evalId,
      canonicalInput: {
        model: judge === "gemini" ? GEMINI_PRO_MODEL : CLAUDE_JUDGE_MODEL,
        judge,
        evalId,
        rubric: evalDef.promptTemplate,
        beforeUrl: canonicalBeforeUrl,
        afterUrl: canonicalAfterUrl,
        beforeFrames:
          judge === "claude"
            ? beforeFrames.map(({ timestampSec, sha256 }) => ({ timestampSec, sha256 }))
            : undefined,
        afterFrames:
          judge === "claude"
            ? afterFrames.map(({ timestampSec, sha256 }) => ({ timestampSec, sha256 }))
            : undefined,
        anchorDataUrl: canonicalAnchorUrl,
        responseSchema: JUDGE_VERDICT_SCHEMA,
      },
    });
  } catch (error) {
    if (error instanceof PaidOperationAuthorizationError) {
      return jsonError(403, error.message);
    }
    console.error(`[live/judge] ${judge}/${evalId} reservation failed`);
    return jsonError(503, "Could not reserve judge call safely.");
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
    let verdict: JudgeVerdict;
    let costUsd: number;
    if (judge === "gemini") {
      verdict = await judgeWithGemini(
        evalId,
        evalDef.promptTemplate,
        beforeAbs as string,
        afterAbs as string,
        canonicalAnchorUrl
      );
      costUsd = PRICE_TABLE.geminiJudgePerCall.usd;
    } else {
      verdict = await judgeWithClaude(
        evalId,
        evalDef.promptTemplate,
        beforeFrames,
        afterFrames,
        canonicalAnchorUrl
      );
      costUsd = PRICE_TABLE.claudeJudgePerCall.usd;
    }
    const result = await completePaidOperation(reservation.operation, {
      verdict,
      costUsd,
    });
    return NextResponse.json(result, {
      headers: { "X-Flora-Paid-Operation": "completed" },
    });
  } catch (err) {
    try {
      await markPaidOperationReconcileRequired(
        reservation.operation,
        `${judge} judge request failed or returned an ambiguous result.`
      );
    } catch {
      // The in-progress claim still blocks a second billed call.
    }
    console.error(
      `[live/judge] ${judge}/${evalId} failed:`,
      err instanceof Error ? err.message : err
    );
    return jsonError(502, "Judge outcome is uncertain and requires reconciliation.");
  }
}
