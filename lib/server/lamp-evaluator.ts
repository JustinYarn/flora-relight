import "server-only";

import {
  GEMINI_PRO_MODEL,
  getGemini,
  resolveSourceUrl,
  uploadVideoCached,
} from "@/lib/server/gemini";
import {
  LAMP_EVALUATOR_MAX_OUTPUT_TOKENS,
  geminiProCostFromUsage,
  requireGeminiProUsage,
} from "@/lib/cost";
import {
  LAMP_EVALUATOR_VERSION,
  LAMP_VISUAL_EVAL_DEFS,
  buildLampEvaluationArtifact,
  isLampEvaluationArtifact,
  lampWholeVideoRubric,
  lampEvaluationOperationId,
  type LampEvaluationArtifact,
} from "@/lib/lamp-evaluation";
import {
  beginPaidOperation,
  completePaidOperation,
  markPaidOperationReconcileRequired,
  paidOperationBlockedMessage,
} from "@/lib/server/paid-operation";
import { getStorage } from "@/lib/server/storage";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import type { EvalResult } from "@/lib/types";

const VIOLATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "aspect",
    "severity",
    "description",
    "correction",
    "frameTimestampSec",
  ],
  properties: {
    aspect: { type: "string" },
    severity: { type: "string", enum: ["critical", "major", "minor"] },
    description: { type: "string" },
    correction: { type: "string" },
    frameTimestampSec: { type: ["number", "null"] },
  },
} as const;

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "evalId",
    "score",
    "confidence",
    "violations",
    "reasoning",
  ],
  properties: {
    evalId: {
      type: "string",
      enum: LAMP_VISUAL_EVAL_DEFS.map((definition) => definition.id),
    },
    score: { type: "number" },
    confidence: { type: "number" },
    violations: { type: "array", items: VIOLATION_SCHEMA },
    reasoning: { type: "string" },
  },
} as const;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: { type: "array", items: RESULT_SCHEMA },
  },
} as const;

function evaluatorPrompt(): string {
  const rubrics = LAMP_VISUAL_EVAL_DEFS.map((definition, index) => {
    // The canonical library is also used by Flora's sampled-frame loop. Lamp
    // keeps its criteria while removing that loop's input/output envelope.
    const rubric = lampWholeVideoRubric(definition);
    return [
      `CHECK ${index + 1}: ${definition.id} — ${definition.name}`,
      definition.description,
      `Pass threshold: ${definition.passThreshold}; borderline threshold: ${definition.borderlineThreshold}.`,
      rubric,
    ].join("\n");
  }).join("\n\n---\n\n");

  return [
    `You are the ${LAMP_EVALUATOR_VERSION} whole-video critic.`,
    "Compare the complete original and candidate videos once, then return exactly one result for every listed check.",
    "Judge source fidelity over the entire timeline, including the worst frame. Do not infer a Look Anchor; Lamp has none.",
    "For every violation, write a concise imperative correction that can be inserted directly into the next video-generation prompt.",
    "Any check you score below its pass threshold must include at least one violation naming what failed, with a concrete correction; do not return a below-pass score with an empty violations array.",
    "confidence is 0 to 1 and must describe how strongly the attached evidence supports this single-judge result. Do not treat it as multi-judge agreement.",
    "Return only the listed visual checks. Do not include audio-integrity; the server verifies audio separately.",
    "Return one JSON object with a results array matching the supplied response schema. Do not emit a separate JSON object for each check.",
    "",
    rubrics,
  ].join("\n");
}

/**
 * Retry the evaluation call only on a spend/rate 429 rejection. A 429 never
 * bills and returns no content, so re-asking under the same durable claim
 * cannot double-charge or fork the journal — unlike other provider errors,
 * which still seal the operation for reconciliation on the first failure.
 * Observed live 2026-07-15: a batch's generation cadence tripped the
 * account's spend-based rate limit on a judge call and stranded an otherwise
 * healthy run in reconcile_required over a $0.02 call.
 */
const RATE_LIMIT_RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

function isRateLimitRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('"code":429') ||
    (message.includes("429") && message.toLowerCase().includes("rate limit")) ||
    message.includes("RESOURCE_EXHAUSTED")
  );
}

async function generateEvaluationWithRateLimitRetry<T>(
  call: () => Promise<T>
): Promise<T> {
  for (const delayMs of RATE_LIMIT_RETRY_DELAYS_MS) {
    try {
      return await call();
    } catch (error) {
      if (!isRateLimitRejection(error)) throw error;
      console.warn(
        `[lamp-evaluator] provider rate limit rejected the judge call; retrying in ${Math.round(delayMs / 1000)}s`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return call();
}

export async function runLampHolisticEvaluation(input: {
  runId: string;
  iteration: 1 | 2;
  previousResults?: EvalResult[];
}): Promise<LampEvaluationArtifact> {
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (!run) throw new Error("Run not found for Lamp evaluation.");
  const generation = run.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(input.iteration)
  );
  if (
    generation?.status !== "completed" ||
    !generation.result ||
    !generation.renderedPrompt ||
    !generation.result.audioVerified
  ) {
    throw new Error(
      "Lamp evaluation requires a completed, prompt-bound generation with verified original audio."
    );
  }

  const prompt = evaluatorPrompt();
  const operationId = lampEvaluationOperationId(input.iteration);
  const claim = await beginPaidOperation({
    run,
    id: operationId,
    provider: "gemini",
    kind: "judge",
    iteration: input.iteration,
    evalId: "lamp-holistic",
    canonicalInput: {
      version: LAMP_EVALUATOR_VERSION,
      iteration: input.iteration,
      sourceUrl: run.originalVideo.url,
      candidateUrl: generation.result.videoUrl,
      generationPrompt: generation.renderedPrompt,
      audioVerified: generation.result.audioVerified,
      prompt,
    },
  });
  if (claim.state === "cached") {
    if (!isLampEvaluationArtifact(claim.operation.result, input.iteration)) {
      throw new Error("Cached Lamp evaluation has an invalid result shape.");
    }
    return claim.operation.result;
  }
  if (claim.state === "blocked") {
    throw new Error(paidOperationBlockedMessage(claim));
  }

  try {
    // Spend authorization and the durable exactly-once claim above must happen
    // before either private clip is uploaded to a provider.
    const [sourcePath, candidatePath] = await Promise.all([
      resolveSourceUrl(run.originalVideo.url),
      resolveSourceUrl(generation.result.videoUrl),
    ]);
    const [source, candidate] = await Promise.all([
      uploadVideoCached(sourcePath),
      uploadVideoCached(candidatePath),
    ]);
    const response = await generateEvaluationWithRateLimitRetry(() =>
      getGemini().models.generateContent({
        model: GEMINI_PRO_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { text: "ORIGINAL video:" },
              { fileData: { fileUri: source.uri, mimeType: "video/mp4" } },
              { text: "CANDIDATE video:" },
              { fileData: { fileUri: candidate.uri, mimeType: "video/mp4" } },
            ],
          },
        ],
        config: {
          httpOptions: { retryOptions: { attempts: 1 } },
          maxOutputTokens: LAMP_EVALUATOR_MAX_OUTPUT_TOKENS,
          responseMimeType: "application/json",
          responseJsonSchema: RESPONSE_SCHEMA,
        },
      })
    );
    if (!response.text) {
      throw new Error("Lamp evaluator returned no content.");
    }
    const usage = requireGeminiProUsage(response.usageMetadata);
    const artifact = buildLampEvaluationArtifact({
      raw: JSON.parse(response.text),
      iteration: input.iteration,
      audioVerified: generation.result.audioVerified,
      previousResults: input.previousResults,
      usage,
      costUsd: geminiProCostFromUsage(usage),
    });
    return completePaidOperation(claim.operation, artifact);
  } catch (error) {
    await markPaidOperationReconcileRequired(
      claim.operation,
      error instanceof Error
        ? error.message
        : "Lamp evaluation returned an ambiguous result."
    );
    throw error;
  }
}
