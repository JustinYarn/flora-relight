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
import { measureRelightLuma } from "@/lib/server/ffmpeg";
import type { EvalResult } from "@/lib/types";
import {
  normalizeRelightIntensity,
  relightIntensityProfile,
  type RelightLumaMeasurements,
} from "@/lib/relight-intensity";

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

function signedStops(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}

function measurementLines(
  measurements: RelightLumaMeasurements | undefined
): string {
  if (!measurements) {
    return "DETERMINISTIC MEASUREMENTS: unavailable for this evaluation — judge magnitude visually with extra care.";
  }
  return [
    `DETERMINISTIC MEASUREMENTS (ffmpeg region luma of candidate vs source, ${measurements.sampleCount} samples — ground truth for MAGNITUDE; judge direction, shaping, believability, and stability yourself):`,
    `- Whole-frame delta: ${signedStops(measurements.globalStops)} stops`,
    `- Center region (subject proxy): ${signedStops(measurements.centerStops)} stops`,
    `- Border region (background proxy): ${signedStops(measurements.borderStops)} stops`,
  ].join("\n");
}

function intensityAwareLightingRubric(
  relightIntensity: number,
  measurements?: RelightLumaMeasurements
): string {
  const profile = relightIntensityProfile(relightIntensity);
  return `ROLE
You are a director of photography reviewing whether a source-faithful relight hit its explicitly requested creative strength.

REQUESTED TARGET — authoritative
- Relight strength: ${relightIntensity}/100
- Profile: ${profile.label}
- Facial-midtone lift target: approximately ${signedStops(profile.faceLiftStops)} stops relative to the source
- Key-to-fill contrast target: approximately ${profile.keyFillRatio}:1
- Background level target: approximately ${signedStops(profile.backgroundStops)} stops relative to the source
- Rim/separation: ${profile.rim}
- Intended look: ${profile.description}

This numeric target is not a quality score. Judge the quality, believability, temporal stability, and accuracy of the candidate AT this requested strength. A faithful subtle daylight lift may earn a passing or excellent score at a low setting; a dramatic studio treatment at that same low setting is a failure. Likewise, a timid near-copy is a failure at a high setting.

${measurementLines(measurements)}

WHAT TO INSPECT ACROSS THE COMPLETE VIDEO
1. Target strength: does the magnitude of the visible lighting change match ${relightIntensity}/100 rather than drifting weaker or stronger? Anchor magnitude on the deterministic measurements when present.
2. Directional shaping: does the candidate create the profile's intended key/fill structure instead of applying only a flat global exposure change? (At Daylight lift and Soft daylight strengths, a gentle ambient lift IS the intended structure.)
3. Face lift: is the facial-midtone lift close to ${signedStops(profile.faceLiftStops)} stops, without clipping or crushed shadows?
4. Contrast and separation: is the key-to-fill relationship close to ${profile.keyFillRatio}:1, with rim/separation matching "${profile.rim}"?
5. Background level: does the room's illumination sit near ${signedStops(profile.backgroundStops)} stops vs source, with the falloff character the profile requests — and does it read as light in a real room, never a vignette filter or matte?
6. Eyes and skin: are catchlights, skin color, texture, and highlight roll-off natural for this profile, with no beauty filtering or glow?
7. Believability AT THIS STRENGTH: at high strengths the look should read as an expensively lit set (dramatic is correct); at low strengths it must read as unproduced daylight. Visible fixtures, halos, matte seams, and costume-drama color washes fail at every strength.
8. Temporal consistency: does the chosen strength, direction, exposure, and white balance hold through motion and speech from first frame to last?

NAMED FAILURE FLAGS
- too_weak_for_target: the overall relight falls materially below ${relightIntensity}/100
- too_strong_for_target: the overall relight materially exceeds ${relightIntensity}/100
- global_exposure_only: brightness changed without the requested shaping (not applicable at Daylight lift / Soft daylight strengths, where ambient lift is requested)
- background_off_target: the background level materially misses ${signedStops(profile.backgroundStops)} stops vs source
- beauty_glow: diffusion or bloom substitutes for lighting
- over_warm: skin or neutrals carry an implausible orange cast
- clipping: facial highlight detail is destroyed
- halo_or_masking: visible matte, glow seam, masking boundary, or vignette-filter falloff

SCORING ANCHORS
- 95: The candidate precisely hits ${relightIntensity}/100 and the ${profile.label} profile across the full timeline, while remaining photorealistic and source-faithful.
- 75: The intended profile is recognizable and better executed than the source, but strength modestly under- or overshoots, or direction, roll-off, separation, background level, or stability is incomplete.
- 40: The candidate substantially misses the requested strength/profile, or introduces harshness, clipping, color cast, glow, or compositing artifacts.

Thresholds for this eval: pass ≥ 80, borderline ≥ 65, else fail.

For every genuine lighting defect, the correction MUST begin "Within the requested ${relightIntensity}/100 relight strength," name the concrete photographic change (including how many stops to move the face or background when magnitude is the defect), and repair execution without asking Final to increase or decrease the overall transformation beyond this target.`;
}

/**
 * The band contract every check reads before its own rubric. Without this,
 * fidelity checks treat the product working as intended at high strengths
 * (a deliberately darkened room, confident contrast) as violations, and their
 * corrections drag the Final back toward the source — the exact failure the
 * 2026-07-16 25-vs-100 A/B measured.
 */
function intensityContract(
  relightIntensity: number,
  measurements?: RelightLumaMeasurements
): string {
  const profile = relightIntensityProfile(relightIntensity);
  return [
    "INTENSITY CONTRACT — read before every check",
    `The client explicitly requested relight strength ${relightIntensity}/100 (${profile.label}): ${profile.description}`,
    `Requested magnitude targets: face ${signedStops(profile.faceLiftStops)} stops, key-to-fill ${profile.keyFillRatio}:1, background ${signedStops(profile.backgroundStops)} stops vs source, rim: ${profile.rim}.`,
    "Creative permissions in force at this strength (these are REQUESTED behavior, never violations, so long as they arrive purely as illumination and color response):",
    ...profile.allowances.map((line) => `- ${line}`),
    "Prohibitions specific to this strength (violations wherever observed):",
    ...profile.restraints.map((line) => `- ${line}`),
    "The strength contract never relaxes identity, skin-texture, performance, wardrobe, environment-content, framing, timing, or audio protections: those checks judge to their full rubric at every strength. In particular, a background darkened or brightened to the requested level with every object intact is compliant illumination; an object added, removed, moved, or repainted is a violation at any strength.",
    measurementLines(measurements),
  ].join("\n");
}

export function evaluatorPrompt(
  relightIntensity: number,
  measurements?: RelightLumaMeasurements
): string {
  const normalizedIntensity = normalizeRelightIntensity(relightIntensity);
  const rubrics = LAMP_VISUAL_EVAL_DEFS.map((definition, index) => {
    // The canonical library is also used by Flora's sampled-frame loop. Lamp
    // keeps its criteria while removing that loop's input/output envelope.
    const intensityAware = definition.id === "lighting-quality-delta";
    const rubric = intensityAware
      ? intensityAwareLightingRubric(normalizedIntensity, measurements)
      : lampWholeVideoRubric(definition);
    const description = intensityAware
      ? `Checks whether the relight is professionally executed at the requested ${normalizedIntensity}/100 strength, without under- or overshooting it.`
      : definition.description;
    return [
      `CHECK ${index + 1}: ${definition.id} — ${definition.name}`,
      description,
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
    intensityContract(normalizedIntensity, measurements),
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

/**
 * Advisory-only measurement: one retry, then proceed without numbers rather
 * than block a billed evaluation. The rare asymmetric case (measurement fails
 * on the first attempt, succeeds on a later retry of the same claim) would
 * change the canonical prompt bytes and surface as a normal input-mismatch
 * reconciliation — acceptable for an advisory signal that ffmpeg, already a
 * hard dependency of every remux, almost never fails to produce.
 */
async function measureRelightLumaAdvisory(
  sourcePath: string,
  candidatePath: string
): Promise<RelightLumaMeasurements | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await measureRelightLuma(sourcePath, candidatePath);
    } catch (error) {
      console.warn(
        `[lamp-evaluator] relight luma measurement failed (attempt ${attempt + 1}):`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return undefined;
}

export async function runLampHolisticEvaluation(input: {
  runId: string;
  iteration: 1 | 2;
  previousResults?: EvalResult[];
}): Promise<LampEvaluationArtifact> {
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (!run) throw new Error("Run not found for Lamp evaluation.");
  const relightIntensity = normalizeRelightIntensity(run.relightIntensity);
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

  // Resolve both clips locally and measure region luma BEFORE the claim: the
  // measurements render into the judge prompt, and the prompt is part of the
  // operation's canonical input. Resolution and measurement are free and
  // deterministic (fixed sampling over immutable files), so retries reproduce
  // the same bytes; nothing reaches a provider until after the claim below.
  const [sourcePath, candidatePath] = await Promise.all([
    resolveSourceUrl(run.originalVideo.url),
    resolveSourceUrl(generation.result.videoUrl),
  ]);
  const measurements = await measureRelightLumaAdvisory(
    sourcePath,
    candidatePath
  );
  const prompt = evaluatorPrompt(relightIntensity, measurements);
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
      relightIntensity,
      audioVerified: generation.result.audioVerified,
      prompt,
      ...(measurements ? { measurements } : {}),
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
      ...(measurements ? { measurements } : {}),
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
