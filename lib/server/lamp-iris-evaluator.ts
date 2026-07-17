import "server-only";

import {
  GEMINI_PRO_MODEL,
  getGemini,
  resolveSourceUrl,
  uploadVideoCached,
} from "@/lib/server/gemini";
import {
  LAMP_IRIS_GEMINI_MAX_OUTPUT_TOKENS,
  geminiProCostFromUsage,
  requireGeminiProUsage,
} from "@/lib/cost";
import {
  buildLampIrisEvaluationArtifact,
  LAMP_IRIS_CORRECTION_ACTIONS,
  LAMP_IRIS_EVALUATOR_VERSION,
  LAMP_IRIS_VISUAL_EVAL_DEFS,
  renderLampIrisHolisticEvaluatorPrompt,
  type LampIrisEvalResult,
  type LampIrisEvaluationArtifact,
} from "@/lib/lamp-iris-evaluation";
import {
  parseLampIrisPlan,
  type LampIrisPlan,
} from "@/lib/lamp-iris";
import { isLampIrisEvaluationArtifact } from "@/lib/lamp-iris-read";
import {
  LAMP_IRIS_HOLISTIC_EVAL_ID,
  lampIrisEvaluationOperationId,
} from "@/lib/lamp-iris-operations";
import {
  beginPaidOperation,
  completePaidOperation,
  markPaidOperationReconcileRequired,
  paidOperationBlockedMessage,
} from "@/lib/server/paid-operation";
import { getStorage } from "@/lib/server/storage";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";

const VIOLATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "aspect",
    "severity",
    "description",
    "frameTimestampSec",
    "correctionAction",
    "planItemIds",
  ],
  properties: {
    aspect: { type: "string" },
    severity: {
      type: "string",
      enum: ["critical", "major", "minor"],
    },
    description: { type: "string" },
    frameTimestampSec: { type: ["number", "null"] },
    correctionAction: {
      type: ["string", "null"],
      enum: [...LAMP_IRIS_CORRECTION_ACTIONS, null],
    },
    planItemIds: { type: "array", items: { type: "string" } },
  },
} as const;

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["evalId", "score", "confidence", "violations", "reasoning"],
  properties: {
    evalId: {
      type: "string",
      enum: LAMP_IRIS_VISUAL_EVAL_DEFS.map((definition) => definition.id),
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

const RATE_LIMIT_RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

function isRateLimitRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('"code":429') ||
    (message.includes("429") && message.toLowerCase().includes("rate limit")) ||
    message.includes("RESOURCE_EXHAUSTED")
  );
}

async function generateWithRateLimitRetry<T>(
  call: () => Promise<T>
): Promise<T> {
  for (const delayMs of RATE_LIMIT_RETRY_DELAYS_MS) {
    try {
      return await call();
    } catch (error) {
      if (!isRateLimitRejection(error)) throw error;
      console.warn(
        `[lamp-iris-evaluator] rate limit rejected the judge call; retrying in ${Math.round(
          delayMs / 1000
        )}s`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return call();
}

export async function runLampIrisHolisticEvaluation(input: {
  runId: string;
  iteration: 1 | 2;
  plan: LampIrisPlan;
  previousResults?: LampIrisEvalResult[];
}): Promise<LampIrisEvaluationArtifact> {
  const plan = parseLampIrisPlan(input.plan);
  if (plan.approval.status !== "approved") {
    throw new Error(
      "Lamp Iris evaluation requires the approved gaze-correction plan."
    );
  }
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (!run) {
    throw new Error("Run not found for Lamp Iris evaluation.");
  }
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
      "Lamp Iris evaluation requires a completed, prompt-bound generation with verified original audio."
    );
  }

  const prompt = renderLampIrisHolisticEvaluatorPrompt({
    plan,
    iteration: input.iteration,
  });
  const operationId = lampIrisEvaluationOperationId(input.iteration);
  const claim = await beginPaidOperation({
    run,
    id: operationId,
    provider: "gemini",
    kind: "judge",
    iteration: input.iteration,
    evalId: LAMP_IRIS_HOLISTIC_EVAL_ID,
    canonicalInput: {
      version: LAMP_IRIS_EVALUATOR_VERSION,
      iteration: input.iteration,
      sourceUrl: run.originalVideo.url,
      candidateUrl: generation.result.videoUrl,
      generationPrompt: generation.renderedPrompt,
      plan,
      audioVerified: generation.result.audioVerified,
      prompt,
    },
  });
  if (claim.state === "cached") {
    const cached = claim.operation.result;
    if (!isLampIrisEvaluationArtifact(cached, input.iteration)) {
      throw new Error(
        "Cached Lamp Iris evaluation has an invalid artifact."
      );
    }
    return cached;
  }
  if (claim.state === "blocked") {
    throw new Error(paidOperationBlockedMessage(claim));
  }

  try {
    const [sourcePath, candidatePath] = await Promise.all([
      resolveSourceUrl(run.originalVideo.url),
      resolveSourceUrl(generation.result.videoUrl),
    ]);
    const [source, candidate] = await Promise.all([
      uploadVideoCached(sourcePath),
      uploadVideoCached(candidatePath),
    ]);
    const response = await generateWithRateLimitRetry(() =>
      getGemini().models.generateContent({
        model: GEMINI_PRO_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { text: "ORIGINAL source video:" },
              {
                fileData: {
                  fileUri: source.uri,
                  mimeType: "video/mp4",
                },
              },
              { text: "CANDIDATE eye-contact video:" },
              {
                fileData: {
                  fileUri: candidate.uri,
                  mimeType: "video/mp4",
                },
              },
            ],
          },
        ],
        config: {
          httpOptions: { retryOptions: { attempts: 1 } },
          maxOutputTokens: LAMP_IRIS_GEMINI_MAX_OUTPUT_TOKENS,
          responseMimeType: "application/json",
          responseJsonSchema: RESPONSE_SCHEMA,
        },
      })
    );
    if (!response.text) {
      throw new Error("Lamp Iris evaluator returned no content.");
    }
    const usage = requireGeminiProUsage(response.usageMetadata);
    const artifact = buildLampIrisEvaluationArtifact({
      raw: JSON.parse(response.text),
      plan,
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
        : "Lamp Iris evaluation returned an ambiguous result."
    );
    throw error;
  }
}
