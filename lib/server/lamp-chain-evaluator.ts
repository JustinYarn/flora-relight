import "server-only";

import {
  buildLampChainEvaluationArtifact,
  lampChainEvalDefinitions,
  parseLampChainEvaluationArtifact,
  LAMP_CHAIN_EVALUATOR_VERSION,
  LAMP_CHAIN_HOLISTIC_RESULT_SCHEMA,
  type LampChainEvaluationArtifact,
} from "@/lib/lamp-chain-evaluation";
import {
  LAMP_CHAIN_HOLISTIC_EVAL_ID,
  lampChainEvaluationOperationId,
} from "@/lib/lamp-chain-operations";
import {
  assertLampChainPlanBinding,
  hashLampChainPlan,
  lampChainConcernsAfterStage,
  parseLampChainPlan,
  LAMP_CHAIN_PLAN_VERSION,
  LAMP_CHAIN_STAGE_CONCERN,
  type LampChainPlan,
} from "@/lib/lamp-chain";
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
import { analyzeVideoSync } from "@/lib/server/syncnet";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import type { LampIrisGazeMeasurements } from "@/lib/lamp-iris-gaze";
import type { SyncNetMetrics } from "@/lib/v2-sync";

export interface LampChainEvaluatorMeasurements {
  luma?: RelightLumaMeasurements;
  gaze?: {
    source: LampIrisGazeMeasurements;
    candidate: LampIrisGazeMeasurements;
  };
  /** Detached SyncNet context (candidate vs source baseline); never a gate. */
  sync?: {
    candidate: SyncNetMetrics;
    source: SyncNetMetrics | null;
  };
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}

/** Provider-neutral prompt for one detached chain-stage judge call. */
export function renderLampChainStageEvaluatorPrompt(input: {
  plan: LampChainPlan;
  stage: number;
  relightIntensity: number;
  measurements?: LampChainEvaluatorMeasurements;
}): string {
  const stageCount = input.plan.stageOrder.length;
  const completedConcerns = lampChainConcernsAfterStage(
    input.plan.stageOrder,
    input.stage - 1
  );
  const pendingConcerns = input.plan.stageOrder
    .slice(input.stage)
    .map((stage) => LAMP_CHAIN_STAGE_CONCERN[stage]);
  const lightingExecuted = completedConcerns.includes("lighting");
  const profile = relightIntensityProfile(input.relightIntensity);
  const luma = input.measurements?.luma;
  const gaze = input.measurements?.gaze;
  const sync = input.measurements?.sync;
  const checks = lampChainEvalDefinitions(input.plan, input.stage)
    .filter((definition) => definition.method === "holistic-judge")
    .map((definition, index) =>
      [
        `CHECK ${index + 1}: ${definition.id} — ${definition.name}`,
        `Contract: ${definition.contract}${definition.disabledControl ? ` (control ${definition.disabledControl} is disabled)` : ""}.`,
        `Hard gate: ${definition.hardGate ? "yes" : "no"}. Pass ≥ ${definition.passThreshold}; borderline ≥ ${definition.borderlineThreshold}.`,
        definition.description,
        definition.rubric,
      ].join("\n")
    )
    .join("\n\n---\n\n");
  return [
    `You are the ${LAMP_CHAIN_EVALUATOR_VERSION} whole-video critic for stage ${input.stage} of ${stageCount} of a sequential chain.`,
    "Compare the complete ORIGINAL source and CANDIDATE exactly once, then return exactly one row for every listed visual check.",
    `Executed concerns so far (${completedConcerns.join(", ")}) are targets and MUST be complete in the candidate.`,
    pendingConcerns.length > 0
      ? `Pending concerns (${pendingConcerns.join(", ")}) are hard preservation gates: not yet executed — any early edit fails.`
      : "No concerns remain pending: every enabled concern has executed by this stage.",
    "Judge corresponding moments and the worst frame across the full timeline. The approved aggregate is authorization, not a suggestion: executed targets must be complete; pending, disabled, and unlisted regions are preservation-only.",
    "Return only the ten visual rows. Never return audio-integrity; trusted code appends that deterministic result.",
    "For any below-pass row, include at least one concrete violation. This evaluation is a detached journal with no correction pass: set correctionAction to null and planItemIds to [].",
    "Return one JSON object matching the supplied response schema, with no prose outside JSON.",
    "",
    "EXACT APPROVED CHAIN PLAN (authoritative; stageOrder is execution order):",
    JSON.stringify(input.plan),
    "",
    ...(lightingExecuted
      ? [
          "SEPARATELY BOUND RELIGHT TARGET:",
          `Strength ${input.relightIntensity}/100 (${profile.label}); face ${signed(profile.faceLiftStops)} stops; key-to-fill ${profile.keyFillRatio}:1; background ${signed(profile.backgroundStops)} stops; rim ${profile.rim}.`,
          `Intent: ${profile.description}`,
        ]
      : [
          "SEPARATELY BOUND RELIGHT TARGET: PENDING. Relighting has not executed at this stage; illumination must still read as source.",
        ]),
    luma
      ? `Measured candidate-vs-source luma (${luma.sampleCount} samples): whole ${signed(luma.globalStops)} stops, center ${signed(luma.centerStops)} stops, border ${signed(luma.borderStops)} stops.`
      : "Measured candidate-vs-source luma: unavailable; judge magnitude visually with extra care.",
    gaze
      ? `Measured gaze evidence (deterministic, source then candidate): ${JSON.stringify(gaze)}`
      : input.plan.aggregate.controls.eyeContact
        ? "Measured gaze evidence: unavailable; judge eye-contact magnitude visually with extra care."
        : "Eye contact is disabled; preserve source gaze and eye behavior exactly.",
    ...(sync
      ? [
          `Measured lip-sync (deterministic SyncNet, candidate vs source-audio): candidate ${JSON.stringify(sync.candidate)}; source baseline ${sync.source ? JSON.stringify(sync.source) : "unmeasured"}. Detached measurement context only.`,
        ]
      : []),
    "",
    checks,
  ].join("\n");
}

const RATE_LIMIT_RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

function isRateLimitRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('"code":429') ||
    (message.includes("429") && message.toLowerCase().includes("rate limit")) ||
    message.includes("RESOURCE_EXHAUSTED")
  );
}

async function generateWithRateLimitRetry<T>(call: () => Promise<T>): Promise<T> {
  for (const delayMs of RATE_LIMIT_RETRY_DELAYS_MS) {
    try {
      return await call();
    } catch (error) {
      if (!isRateLimitRejection(error)) throw error;
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
        `[lamp-chain-evaluator] luma measurement failed (attempt ${attempt + 1}): ${
          error instanceof Error ? error.message.slice(0, 180) : "unknown"
        }`
      );
    }
  }
  return undefined;
}

/** SyncNet is a detached measurement here, never a gate: any failure → undefined. */
async function measureCandidateSync(
  candidatePath: string
): Promise<SyncNetMetrics | undefined> {
  try {
    return await analyzeVideoSync(candidatePath);
  } catch (error) {
    console.warn(
      `[lamp-chain-evaluator] SyncNet measurement failed (detached, continuing): ${
        error instanceof Error ? error.message.slice(0, 180) : "unknown"
      }`
    );
    return undefined;
  }
}

async function collectMeasurements(input: {
  sourcePath: string;
  candidatePath: string;
  eyeContact: boolean;
  sourceHasAudio: boolean;
  sourceSync: SyncNetMetrics | null;
}): Promise<LampChainEvaluatorMeasurements> {
  const lumaPromise = measureLuma(input.sourcePath, input.candidatePath);
  // A silent source skips SyncNet entirely; there is no audio to measure.
  const syncPromise = input.sourceHasAudio
    ? measureCandidateSync(input.candidatePath)
    : Promise.resolve<SyncNetMetrics | undefined>(undefined);
  if (!input.eyeContact) {
    const [luma, candidateSync] = await Promise.all([lumaPromise, syncPromise]);
    return {
      ...(luma ? { luma } : {}),
      ...(candidateSync
        ? { sync: { candidate: candidateSync, source: input.sourceSync } }
        : {}),
    };
  }
  const [luma, candidateSync, sourceGaze, candidateGaze] = await Promise.all([
    lumaPromise,
    syncPromise,
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
    ...(candidateSync
      ? { sync: { candidate: candidateSync, source: input.sourceSync } }
      : {}),
  };
}

/**
 * One DETACHED holistic evaluation for chain stage N, judged against the
 * ORIGINAL clip. Post-delivery paid journal only: it never steers a
 * correction pass and never gates delivery.
 */
export async function runLampChainStageEvaluation(input: {
  runId: string;
  stage: number;
  plan: LampChainPlan;
  previousArtifact?: LampChainEvaluationArtifact;
}): Promise<LampChainEvaluationArtifact> {
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (!run) throw new Error("Run not found for Lamp Chain evaluation.");
  const relightIntensity = normalizeRelightIntensity(run.relightIntensity);
  const plan = assertLampChainPlanBinding(parseLampChainPlan(input.plan), {
    runId: run.id,
    relightIntensity,
    controls: run.chainControls,
  });
  if (plan.aggregate.approval.status !== "approved") {
    throw new Error("Lamp Chain evaluation requires the approved aggregate.");
  }
  const stageCount = plan.stageOrder.length;
  const stageKind = Number.isInteger(input.stage)
    ? plan.stageOrder[input.stage - 1]
    : undefined;
  if (!stageKind) {
    throw new Error(
      `Lamp Chain evaluation stage must be 1 through ${stageCount}.`
    );
  }
  const stage = input.stage;
  const completedConcerns = lampChainConcernsAfterStage(
    plan.stageOrder,
    stage - 1
  );
  const previousArtifact = input.previousArtifact
    ? await parseLampChainEvaluationArtifact(input.previousArtifact, {
        plan,
        stage: stage - 1,
      })
    : undefined;
  const generation = run.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(stage)
  );
  if (
    generation?.status !== "completed" ||
    !generation.result ||
    !generation.renderedPrompt
  ) {
    throw new Error(
      "Lamp Chain evaluation requires this stage's exact completed generation."
    );
  }

  // The candidate is ALWAYS judged against the ORIGINAL, never a prior stage.
  const [sourcePath, candidatePath] = await Promise.all([
    resolveSourceUrl(run.originalVideo.url),
    resolveSourceUrl(generation.result.videoUrl),
  ]);
  // Canonical-input law: measurements are collected BEFORE the paid claim.
  const [measurements, planHash] = await Promise.all([
    collectMeasurements({
      sourcePath,
      candidatePath,
      eyeContact: plan.aggregate.controls.eyeContact,
      sourceHasAudio: run.originalVideo.hasAudio,
      sourceSync: run.originalVideo.syncBaseline ?? null,
    }),
    hashLampChainPlan(plan),
  ]);
  const prompt = renderLampChainStageEvaluatorPrompt({
    plan,
    stage,
    relightIntensity,
    measurements,
  });
  const claim = await beginPaidOperation({
    run,
    id: lampChainEvaluationOperationId(stage),
    provider: "gemini",
    kind: "judge",
    iteration: stage,
    evalId: LAMP_CHAIN_HOLISTIC_EVAL_ID,
    canonicalInput: {
      version: LAMP_CHAIN_EVALUATOR_VERSION,
      planVersion: LAMP_CHAIN_PLAN_VERSION,
      planId: plan.aggregate.id,
      planHash,
      stage,
      stageCount,
      stageKind,
      completedConcerns,
      sourceUrl: run.originalVideo.url,
      candidateUrl: generation.result.videoUrl,
      generationPrompt: generation.renderedPrompt,
      relightIntensity,
      audioVerified: generation.result.audioVerified,
      previousArtifact: previousArtifact ?? null,
      measurements,
      prompt,
    },
  });
  if (claim.state === "cached") {
    return parseLampChainEvaluationArtifact(claim.operation.result, {
      plan,
      stage,
    });
  }
  if (claim.state === "blocked") {
    throw new Error(paidOperationBlockedMessage(claim));
  }

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
              { text: "CANDIDATE chain stage video:" },
              { fileData: { fileUri: candidate.uri, mimeType: "video/mp4" } },
            ],
          },
        ],
        config: {
          httpOptions: { retryOptions: { attempts: 1 } },
          maxOutputTokens: LAMP_EVALUATOR_MAX_OUTPUT_TOKENS,
          responseMimeType: "application/json",
          responseJsonSchema: LAMP_CHAIN_HOLISTIC_RESULT_SCHEMA,
        },
      })
    );
    if (!response.text) {
      throw new Error("Lamp Chain evaluator returned no content.");
    }
    const usage = requireGeminiProUsage(response.usageMetadata);
    const artifact = await buildLampChainEvaluationArtifact({
      raw: JSON.parse(response.text),
      plan,
      stage,
      audioVerified: generation.result.audioVerified,
      previousArtifact,
      usage,
      costUsd: geminiProCostFromUsage(usage),
    });
    return completePaidOperation(claim.operation, artifact);
  } catch (error) {
    await markPaidOperationReconcileRequired(
      claim.operation,
      error instanceof Error
        ? error.message
        : "Lamp Chain evaluation returned an ambiguous result."
    );
    throw error;
  }
}
