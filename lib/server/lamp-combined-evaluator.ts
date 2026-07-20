import "server-only";

import {
  buildLampCombinedEvaluationArtifact,
  buildLampCombinedHolisticEvaluationSchema,
  LAMP_COMBINED_GEMINI_OUTPUT_CONFIG,
  parseLampCombinedEvaluationArtifact,
  type LampCombinedEvaluationArtifact,
  type LampCombinedHolisticEvaluationSchema,
} from "@/lib/lamp-combined-evaluation";
import {
  isLampCombinedLipsyncResult,
  lampCombinedLipsyncOperationId,
  lampCombinedLipsyncProofMatchesGeneration,
  lampCombinedMandatorySyncVerdict,
} from "@/lib/lamp-combined-lipsync";
import {
  LAMP_COMBINED_HOLISTIC_EVAL_ID,
  lampCombinedEvaluationOperationId,
} from "@/lib/lamp-combined-operations";
import {
  assertLampCombinedPlanBinding,
  parseLampCombinedPlan,
  type LampCombinedPlan,
} from "@/lib/lamp-combined";
import {
  LAMP_EVALUATOR_MAX_OUTPUT_TOKENS,
  geminiProCostFromUsage,
  requireGeminiProUsage,
} from "@/lib/cost";
import { lampIrisGazeMeasurementsUsable } from "@/lib/lamp-iris-gaze";
import {
  normalizeRelightIntensity,
  relightIntensityProfile,
  type RelightLumaMeasurements,
} from "@/lib/relight-intensity";
import { measureRelightLuma } from "@/lib/server/ffmpeg";
import { isRetryableGeminiCapacityError } from "@/lib/server/definitive-provider-rejection";
import {
  GEMINI_PRO_MODEL,
  getGemini,
  resolveSourceUrl,
  uploadVideoCached,
} from "@/lib/server/gemini";
import { measureLampIrisGaze } from "@/lib/server/gaze-meter";
import {
  beginPaidOperation,
  completePaidOperation,
  markPaidOperationReconcileRequired,
  paidOperationBlockedMessage,
} from "@/lib/server/paid-operation";
import { getStorage } from "@/lib/server/storage";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import type { LampIrisGazeMeasurements } from "@/lib/lamp-iris-gaze";

export interface LampCombinedEvaluatorMeasurements {
  luma?: RelightLumaMeasurements;
  gaze?: {
    source: LampIrisGazeMeasurements;
    candidate: LampIrisGazeMeasurements;
  };
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}

/** Provider-neutral prompt for the one Combined visual judge call. */
export function renderLampCombinedHolisticEvaluatorPrompt(input: {
  schema: LampCombinedHolisticEvaluationSchema;
  plan: LampCombinedPlan;
  relightIntensity: number;
  measurements?: LampCombinedEvaluatorMeasurements;
}): string {
  const profile = relightIntensityProfile(input.relightIntensity);
  const luma = input.measurements?.luma;
  const gaze = input.measurements?.gaze;
  const checks = input.schema.visualDefinitions
    .map((definition, index) =>
      [
        `CHECK ${index + 1}: ${definition.id} — ${definition.name}`,
        `Contract: ${definition.contract}${definition.disabledControl ? ` (control ${definition.disabledControl} is disabled)` : ""}.`,
        `Hard gate: ${definition.hardGate ? "yes" : "no"}. Pass ≥ ${definition.passThreshold}; borderline ≥ ${definition.borderlineThreshold}.`,
        definition.description,
        definition.rubric,
        `Allowed correction actions: ${definition.allowedCorrectionActions.join(", ") || "none"}.`,
      ].join("\n")
    )
    .join("\n\n---\n\n");
  return [
    `You are the ${input.schema.evaluatorVersion} whole-video critic.`,
    "Compare the complete ORIGINAL source and CANDIDATE exactly once, then return exactly one row for every listed visual check.",
    'The top level must be exactly one JSON object shaped as {"results":[...ten row objects...]}; never return a bare array, a differently named wrapper, or prose.',
    "Judge corresponding moments and the worst frame across the full timeline. The approved aggregate is authorization, not a suggestion: enabled targets must be complete, disabled/unlisted regions are preservation-only.",
    "For motion-lipsync, judge visual performance preservation only: gestures, head pose, blinks, and mouth-shape continuity at corresponding source moments. Do not claim or score audio/video synchronization; trusted post-Lipsync code owns that release gate.",
    "Return only the ten visual rows. Never return audio-integrity; trusted code appends that deterministic result.",
    'For every row, use the flat fields issue, severity, correctionAction, and planItemIds. For a passing row use issue="", severity="none", correctionAction="none", and planItemIds=[]. For any below-pass row, issue must describe the worst concrete failure; correctionAction must be one of that check\'s allowed actions; planItemIds may name only exact approved IDs.',
    "Return one JSON object matching the supplied response schema, with no prose outside JSON.",
    "",
    "EXACT APPROVED AGGREGATE PLAN (authoritative):",
    JSON.stringify(input.plan),
    "",
    "SEPARATELY BOUND RELIGHT TARGET:",
    `Strength ${input.relightIntensity}/100 (${profile.label}); face ${signed(profile.faceLiftStops)} stops; key-to-fill ${profile.keyFillRatio}:1; background ${signed(profile.backgroundStops)} stops; rim ${profile.rim}.`,
    `Intent: ${profile.description}`,
    luma
      ? `Measured candidate-vs-source luma (${luma.sampleCount} samples): whole ${signed(luma.globalStops)} stops, center ${signed(luma.centerStops)} stops, border ${signed(luma.borderStops)} stops.`
      : "Measured candidate-vs-source luma: unavailable; judge magnitude visually with extra care.",
    gaze
      ? `Measured gaze evidence (deterministic, source then candidate): ${JSON.stringify(gaze)}`
      : input.plan.controls.eyeContact
        ? "Measured gaze evidence: unavailable; judge eye-contact magnitude visually with extra care."
        : "Eye contact is disabled; preserve source gaze and eye behavior exactly.",
    "",
    checks,
  ].join("\n");
}

const RATE_LIMIT_RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

function isRetryableProviderRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('"code":429') ||
    (message.includes("429") && message.toLowerCase().includes("rate limit")) ||
    message.includes("RESOURCE_EXHAUSTED") ||
    isRetryableGeminiCapacityError(error)
  );
}

async function generateWithRateLimitRetry<T>(call: () => Promise<T>): Promise<T> {
  for (const delayMs of RATE_LIMIT_RETRY_DELAYS_MS) {
    try {
      return await call();
    } catch (error) {
      if (!isRetryableProviderRejection(error)) throw error;
      console.warn(
        `[lamp-combined-evaluator] provider temporarily rejected the judge call; retrying in ${Math.round(
          delayMs / 1000
        )}s`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return call();
}

async function measureLuma(
  sourcePath: string,
  candidatePath: string
): Promise<RelightLumaMeasurements | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await measureRelightLuma(sourcePath, candidatePath);
    } catch (error) {
      console.warn(
        `[lamp-combined-evaluator] luma measurement failed (attempt ${attempt + 1}): ${
          error instanceof Error ? error.message.slice(0, 180) : "unknown"
        }`
      );
    }
  }
  return undefined;
}

async function collectMeasurements(input: {
  sourcePath: string;
  candidatePath: string;
  eyeContact: boolean;
}): Promise<LampCombinedEvaluatorMeasurements> {
  const lumaPromise = measureLuma(input.sourcePath, input.candidatePath);
  if (!input.eyeContact) return { luma: await lumaPromise };
  const [luma, sourceGaze, candidateGaze] = await Promise.all([
    lumaPromise,
    measureLampIrisGaze(input.sourcePath),
    measureLampIrisGaze(input.candidatePath),
  ]);
  const gaze =
    sourceGaze &&
    candidateGaze &&
    lampIrisGazeMeasurementsUsable(sourceGaze) &&
    lampIrisGazeMeasurementsUsable(candidateGaze)
      ? { source: sourceGaze, candidate: candidateGaze }
      : undefined;
  return {
    ...(luma ? { luma } : {}),
    ...(gaze ? { gaze } : {}),
  };
}

export async function runLampCombinedHolisticEvaluation(input: {
  runId: string;
  iteration: 1 | 2;
  plan: LampCombinedPlan;
  previousArtifact?: LampCombinedEvaluationArtifact;
}): Promise<LampCombinedEvaluationArtifact> {
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (!run) throw new Error("Run not found for Lamp Combined evaluation.");
  const relightIntensity = normalizeRelightIntensity(run.relightIntensity);
  const plan = assertLampCombinedPlanBinding(parseLampCombinedPlan(input.plan), {
    runId: run.id,
    relightIntensity,
    controls: run.combinedControls,
  });
  if (plan.approval.status !== "approved") {
    throw new Error("Lamp Combined evaluation requires the approved aggregate.");
  }
  if (input.iteration === 2 && !input.previousArtifact) {
    throw new Error("Lamp Combined Final evaluation requires the Initial artifact.");
  }
  const previousArtifact = input.previousArtifact
    ? await parseLampCombinedEvaluationArtifact(input.previousArtifact, {
        plan,
        iteration: 1,
      })
    : undefined;
  const generation = run.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(input.iteration)
  );
  if (
    generation?.status !== "completed" ||
    !generation.result ||
    !generation.renderedPrompt
  ) {
    throw new Error(
      "Lamp Combined evaluation requires one exact completed generation."
    );
  }

  const lipsyncOperation =
    run.originalVideo.hasAudio === true
      ? await storage.getPaidOperation(
          input.runId,
          lampCombinedLipsyncOperationId(input.iteration)
        )
      : null;
  const lipsyncResult = lipsyncOperation?.result;
  const syncVerdict =
    run.originalVideo.hasAudio === false
      ? { pass: true, reason: "Silent source; lip synchronization is not required." }
      : isLampCombinedLipsyncResult(lipsyncResult, input.iteration) &&
          lipsyncOperation &&
          lampCombinedLipsyncProofMatchesGeneration({
            runId: input.runId,
            iteration: input.iteration,
            generation,
            operation: lipsyncOperation,
          })
        ? lampCombinedMandatorySyncVerdict(lipsyncResult)
        : { pass: false, reason: "Mandatory Lipsync proof is missing or invalid." };
  if (!syncVerdict.pass) {
    throw new Error(
      `Lamp Combined evaluation cannot run before post-Lipsync verification: ${syncVerdict.reason}`
    );
  }
  const candidateUrl =
    run.originalVideo.hasAudio === false
      ? generation.result.videoUrl
      : (lipsyncResult as NonNullable<typeof lipsyncResult> & { videoUrl: string })
          .videoUrl;
  const candidateAudioVerified =
    run.originalVideo.hasAudio === false ||
    (isLampCombinedLipsyncResult(lipsyncResult, input.iteration) &&
      lipsyncResult.audioVerified);

  const [sourcePath, candidatePath] = await Promise.all([
    resolveSourceUrl(run.originalVideo.url),
    resolveSourceUrl(candidateUrl),
  ]);
  const [schema, measurements] = await Promise.all([
    buildLampCombinedHolisticEvaluationSchema(plan),
    collectMeasurements({
      sourcePath,
      candidatePath,
      eyeContact: plan.controls.eyeContact,
    }),
  ]);
  const prompt = renderLampCombinedHolisticEvaluatorPrompt({
    schema,
    plan,
    relightIntensity,
    measurements,
  });
  const operationId = lampCombinedEvaluationOperationId(input.iteration);
  const claim = await beginPaidOperation({
    run,
    id: operationId,
    provider: "gemini",
    kind: "judge",
    iteration: input.iteration,
    evalId: LAMP_COMBINED_HOLISTIC_EVAL_ID,
    canonicalInput: {
      version: schema.evaluatorVersion,
      planVersion: schema.planVersion,
      planId: schema.planId,
      planHash: schema.planHash,
      iteration: input.iteration,
      sourceUrl: run.originalVideo.url,
      candidateUrl,
      lipsyncOperationId: lipsyncOperation?.id ?? null,
      lipsyncInputHash: lipsyncOperation?.inputHash ?? null,
      syncVerdict,
      generationPrompt: generation.renderedPrompt,
      relightIntensity,
      audioVerified: candidateAudioVerified,
      previousArtifact: previousArtifact ?? null,
      measurements,
      prompt,
    },
  });
  if (claim.state === "cached") {
    return parseLampCombinedEvaluationArtifact(claim.operation.result, {
      plan,
      iteration: input.iteration,
    });
  }
  if (claim.state === "blocked") {
    throw new Error(paidOperationBlockedMessage(claim));
  }

  let responseReceipt:
    | {
        version: "lamp-combined-provider-response-v1";
        responseText: string;
        usage: ReturnType<typeof requireGeminiProUsage>;
        costUsd: number;
      }
    | undefined;
  try {
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
              { fileData: { fileUri: source.uri, mimeType: "video/mp4" } },
              { text: "CANDIDATE Combined video:" },
              { fileData: { fileUri: candidate.uri, mimeType: "video/mp4" } },
            ],
          },
        ],
        config: {
          httpOptions: { retryOptions: { attempts: 1 } },
          maxOutputTokens: LAMP_EVALUATOR_MAX_OUTPUT_TOKENS,
          ...LAMP_COMBINED_GEMINI_OUTPUT_CONFIG,
        },
      })
    );
    if (!response.text) {
      throw new Error("Lamp Combined evaluator returned no content.");
    }
    const usage = requireGeminiProUsage(response.usageMetadata);
    const costUsd = geminiProCostFromUsage(usage);
    responseReceipt = {
      version: "lamp-combined-provider-response-v1",
      responseText: response.text,
      usage,
      costUsd,
    };
    const artifact = await buildLampCombinedEvaluationArtifact({
      raw: JSON.parse(response.text),
      plan,
      iteration: input.iteration,
      audioVerified: candidateAudioVerified,
      syncVerified: syncVerdict.pass,
      syncReason: syncVerdict.reason,
      previousArtifact,
      usage,
      costUsd,
    });
    return completePaidOperation(claim.operation, artifact);
  } catch (error) {
    await markPaidOperationReconcileRequired(
      claim.operation,
      error instanceof Error
        ? error.message
        : "Lamp Combined evaluation returned an ambiguous result.",
      responseReceipt
    );
    throw error;
  }
}
