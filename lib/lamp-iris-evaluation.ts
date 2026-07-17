import { parseLampIrisPlan, type LampIrisPlan } from "./lamp-iris.ts";
import type {
  GeminiProUsageSnapshot,
  Verdict,
  ViolationSeverity,
} from "./types.ts";

export const LAMP_IRIS_EVALUATOR_VERSION = "lamp-iris-holistic-v1" as const;

export const LAMP_IRIS_EVAL_IDS = [
  "identity-preservation",
  "gaze-adherence",
  "gaze-naturalness",
  "eye-region-fidelity",
  "motion-lipsync",
  "outside-eye-fidelity",
  "background-integrity",
  "other-people-untouched",
  "lighting-camera-fidelity",
  "gaze-temporal-stability",
  "audio-integrity",
] as const;

export type LampIrisEvalId = (typeof LAMP_IRIS_EVAL_IDS)[number];

export const LAMP_IRIS_CORRECTION_ACTIONS = [
  "restore-identity",
  "restore-performance-lipsync",
  "complete-approved-gaze-correction",
  "reduce-gaze-lock",
  "restore-blink-pattern",
  "repair-eye-naturalness",
  "remove-unapproved-changes",
  "restore-untouched-surroundings",
] as const;

export type LampIrisCorrectionAction =
  (typeof LAMP_IRIS_CORRECTION_ACTIONS)[number];

export interface LampIrisEvalDefinition {
  id: LampIrisEvalId;
  name: string;
  category:
    | "identity"
    | "gaze"
    | "eyes"
    | "motion"
    | "fidelity"
    | "background"
    | "people"
    | "temporal"
    | "audio";
  description: string;
  method: "holistic-judge" | "deterministic";
  hardGate: boolean;
  weight: number;
  passThreshold: number;
  borderlineThreshold: number;
  rubric: string;
  allowedCorrectionActions: LampIrisCorrectionAction[];
}

const DEFINITIONS: LampIrisEvalDefinition[] = [
  {
    id: "identity-preservation",
    name: "Same person",
    category: "identity",
    description:
      "The subject remains unmistakably the same human in every corresponding moment.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.14,
    passThreshold: 90,
    borderlineThreshold: 75,
    allowedCorrectionActions: ["restore-identity"],
    rubric: `Compare facial geometry, bone structure, distinctive features, apparent age, and recognizability throughout the complete source and candidate. Gaze correction grants no permission to change who the person is: any frame that reads as a different or structurally reshaped person fails. The eyes looking at the camera instead of at reading material is the authorized change and is not an identity violation on its own; changed eye shape, size, spacing, or a face that reads differently is. Judge the worst moment, especially under head motion and expression changes.`,
  },
  {
    id: "gaze-adherence",
    name: "Approved plan followed",
    category: "gaze",
    description:
      "Exactly the approved catalog items were applied, each at its approved intensity.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.15,
    passThreshold: 85,
    borderlineThreshold: 70,
    allowedCorrectionActions: [
      "complete-approved-gaze-correction",
      "reduce-gaze-lock",
      "remove-unapproved-changes",
    ],
    rubric: `Treat the approved gaze-correction plan as the exact edit authorization and judge TARGET MATCHING per item in BOTH directions. At intensity 1 the reading pattern is visibly calmed while natural glance-aways survive; at 2 contact is the steady state through all speech; at 3 contact is near-continuous except blinks and momentary micro-breaks. A candidate whose gaze still reads as anchored to reading material, still scanning text, or still dropping to notes at the approved item's level has undershot — report correctionAction complete-approved-gaze-correction. A candidate locked beyond its approved level — natural breaks erased at intensity 1 or 2, or a stare that never varies — has overshot — report reduce-gaze-lock. Any change outside the approved list fails regardless of how it looks.`,
  },
  {
    id: "gaze-naturalness",
    name: "Contact reads alive",
    category: "gaze",
    description:
      "Corrected gaze reads as a living person looking at the viewer, never a fixed stare.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.13,
    passThreshold: 85,
    borderlineThreshold: 70,
    allowedCorrectionActions: [
      "reduce-gaze-lock",
      "restore-blink-pattern",
      "repair-eye-naturalness",
    ],
    rubric: `This is the workflow's characteristic failure mode and it is judged strictly. Verify: every source blink lands at its source timestamp with natural lid travel — a missing, added, shortened, or stretched blink fails; corrected gaze keeps living micro-texture (tiny saccades, natural settling) rather than pixel-frozen fixation; eyelid aperture is consistent with the corrected direction (looking at the lens does not keep lids posed for looking down); both eyes converge naturally on the lens with no cross-eyed, wall-eyed, or asymmetric drift; the overall impression is a person speaking TO someone, not a portrait with painted eyes. A dead, glassy, unblinking, or hypnotic stare fails even when contact is technically continuous.`,
  },
  {
    id: "eye-region-fidelity",
    name: "Eyes stay the same eyes",
    category: "eyes",
    description:
      "Iris, sclera, eye shape, lashes, brows, and catchlight character are unchanged except direction.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.1,
    passThreshold: 88,
    borderlineThreshold: 74,
    allowedCorrectionActions: ["repair-eye-naturalness", "remove-unapproved-changes"],
    rubric: `Compare the eye region closely between source and candidate at corresponding moments. Iris color and texture, sclera tone (including any natural redness), eye shape and size, lash and brow appearance, and the character of catchlights must match the source; only gaze direction and the eyelid pose that direction implies may differ. Eye enlargement, brightening, whitening, recoloring, added sparkle, or beautification of any kind fails — those belong to a different workflow and were not authorized. Catchlights may move consistently with the new direction but must keep their source character.`,
  },
  {
    id: "motion-lipsync",
    name: "Performance and lips match",
    category: "motion",
    description:
      "Head pose, gestures, and speech articulation follow the source exactly; only the eyes differ.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.12,
    passThreshold: 90,
    borderlineThreshold: 76,
    allowedCorrectionActions: ["restore-performance-lipsync"],
    rubric: `The subject is reading a script, so this gate is product-critical: the delivered audio is the untouched source track, and the face must keep speaking it perfectly. Compare complete timelines at corresponding moments. Speech articulation is sacred — mouth shapes must form the same phonemes at the same timestamps with frame-accurate lip-sync; any retimed, softened, or altered mouth movement fails. The head is never re-aimed: head position, rotation, and every gesture, posture shift, and body trajectory must follow the source exactly. A candidate that achieves "eye contact" by turning or tilting the head toward the camera fails here regardless of how natural it looks.`,
  },
  {
    id: "outside-eye-fidelity",
    name: "Face beyond the eyes untouched",
    category: "fidelity",
    description:
      "Skin, expression, permanent features, hair, and wardrobe are pixel-faithful outside the eye region.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.08,
    passThreshold: 88,
    borderlineThreshold: 74,
    allowedCorrectionActions: ["remove-unapproved-changes"],
    rubric: `Everything outside the immediate eye region must match the source: skin texture and tone, temporary blemishes and shine exactly as filmed, permanent features (moles, scars, freckles, wrinkles, facial-hair pattern), the resting expression and its changes, mouth and smile behavior, hair in every detail, and wardrobe. Lamp Iris authorizes no touch-up, warmth shift, or grooming of any kind — a candidate that also smoothed skin or warmed the expression fails even if the gaze work is perfect.`,
  },
  {
    id: "background-integrity",
    name: "Room untouched",
    category: "background",
    description:
      "Every background pixel remains source-faithful; this workflow never edits the room.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.08,
    passThreshold: 88,
    borderlineThreshold: 74,
    allowedCorrectionActions: ["restore-untouched-surroundings"],
    rubric: `Compare the complete background — architecture, furniture, objects, screens, reflections, clutter, and room content — against the source at corresponding moments. Lamp Iris authorizes no background edit of any kind: cleanup, decor change, blur, brightening, or object drift all fail. Factor out only unavoidable compression differences.`,
  },
  {
    id: "other-people-untouched",
    name: "Other people untouched",
    category: "people",
    description:
      "Every person other than the primary subject remains exactly as filmed.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.04,
    passThreshold: 90,
    borderlineThreshold: 75,
    allowedCorrectionActions: ["restore-untouched-surroundings"],
    rubric: `When more than one person is visible, verify every additional person — at frame edges, in the background, or partially visible — remains exactly as filmed: no gaze correction, enhancement, removal, or alteration. Their eyes look wherever they looked in the source. For single-person sources, confirm no person was added. Any change to a non-primary person fails.`,
  },
  {
    id: "lighting-camera-fidelity",
    name: "Lighting and camera unchanged",
    category: "fidelity",
    description:
      "Exposure, color, focus, framing, and camera behavior match the source.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.04,
    passThreshold: 85,
    borderlineThreshold: 70,
    allowedCorrectionActions: ["restore-untouched-surroundings"],
    rubric: `Compare exposure, contrast, white balance, saturation, focus, depth of field, noise character, framing, crop, scale, perspective, lens feel, and camera position across the full timeline. No relighting, glow, color grade, reframing, stabilization, or zoom is authorized. The only permitted difference is the plausible local light response of the eye region to its corrected direction.`,
  },
  {
    id: "gaze-temporal-stability",
    name: "Correction stays stable",
    category: "temporal",
    description:
      "Corrected gaze holds steadily across motion, occlusion, and expression changes.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.08,
    passThreshold: 85,
    borderlineThreshold: 70,
    allowedCorrectionActions: [
      "complete-approved-gaze-correction",
      "repair-eye-naturalness",
    ],
    rubric: `Inspect the complete video for correction flicker: moments where the eyes visibly snap between corrected and uncorrected directions, pop or teleport rather than travel with natural saccade motion, or lose the correction during head motion, occlusion, hand gestures, or expression changes and regain it a beat later. The corrected gaze must read as one continuous physical reality. Deliberate approved survivals (a natural glance-away retained at intensity 1 or 2) are not flicker; involuntary oscillation is.`,
  },
  {
    id: "audio-integrity",
    name: "Source audio preserved",
    category: "audio",
    description:
      "The delivered cut carries the untouched original audio track.",
    method: "deterministic",
    hardGate: true,
    weight: 0.04,
    passThreshold: 100,
    borderlineThreshold: 100,
    allowedCorrectionActions: [],
    rubric:
      "Server-only deterministic check: discard provider sound, remux the canonical source track or preserve source silence, verify aligned duration, audio presence, and complete-timeline bitstream integrity. Score is 100 or 0; no model judges this row.",
  },
];

export const LAMP_IRIS_EVAL_DEFS =
  DEFINITIONS as readonly LampIrisEvalDefinition[];

export const LAMP_IRIS_VISUAL_EVAL_DEFS = DEFINITIONS.filter(
  (definition) => definition.method === "holistic-judge"
) as readonly LampIrisEvalDefinition[];

export interface LampIrisViolationCorrection {
  action: LampIrisCorrectionAction;
  planItemIds: string[];
}

export interface LampIrisViolation {
  aspect: string;
  severity: ViolationSeverity;
  description: string;
  frameTimestampSec?: number;
  correction?: LampIrisViolationCorrection;
}

export interface LampIrisEvalResult {
  evalId: LampIrisEvalId;
  iteration: 1 | 2;
  score: number;
  confidence: number;
  verdict: Verdict;
  violations: LampIrisViolation[];
  reasoning: string;
  deltaFromPrevious?: number;
}

export interface LampIrisEvaluationArtifact {
  version: typeof LAMP_IRIS_EVALUATOR_VERSION;
  planVersion: LampIrisPlan["version"];
  planId: string;
  iteration: 1 | 2;
  evalResults: LampIrisEvalResult[];
  usage: GeminiProUsageSnapshot;
  costUsd: number;
}

export interface LampIrisCorrection {
  id: string;
  sourceEvalId: LampIrisEvalId;
  aspect: string;
  severity: ViolationSeverity;
  action: LampIrisCorrectionAction;
  planItemIds: string[];
}

const SEVERITIES: ViolationSeverity[] = ["critical", "major", "minor"];
const SEVERITY_RANK: Record<ViolationSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
};
const MAX_ACTIVE_CORRECTIONS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function verdictFor(
  score: number,
  passThreshold: number,
  borderlineThreshold: number
): Verdict {
  if (score >= passThreshold) return "pass";
  if (score >= borderlineThreshold) return "borderline";
  return "fail";
}

function evalDefinition(id: LampIrisEvalId): LampIrisEvalDefinition {
  const definition = LAMP_IRIS_EVAL_DEFS.find(
    (candidate) => candidate.id === id
  );
  if (!definition) {
    throw new Error(`Unknown Lamp Iris eval id "${id}".`);
  }
  return definition;
}

/**
 * Item-scoped actions may reference only approved CORRECT entries; blink,
 * identity, and region restores carry no item ids. A correction can therefore
 * never smuggle a new gaze edit into the second pass.
 */
function itemIdsForAction(
  plan: LampIrisPlan,
  action: LampIrisCorrectionAction
): Set<string> | null {
  switch (action) {
    case "complete-approved-gaze-correction":
    case "reduce-gaze-lock":
      return new Set(plan.correct.map((item) => item.id));
    default:
      return null;
  }
}

function correctionIsSafe(
  plan: LampIrisPlan,
  evalId: LampIrisEvalId,
  action: LampIrisCorrectionAction,
  planItemIds: string[]
): boolean {
  const definition = evalDefinition(evalId);
  if (!definition.allowedCorrectionActions.includes(action)) return false;
  const allowedIds = itemIdsForAction(plan, action);
  if (allowedIds === null) return planItemIds.length === 0;
  return (
    planItemIds.length > 0 &&
    planItemIds.every((itemId) => allowedIds.has(itemId))
  );
}

function coerceViolation(
  value: unknown,
  plan: LampIrisPlan,
  evalId: LampIrisEvalId
): LampIrisViolation | null {
  if (
    !isRecord(value) ||
    typeof value.aspect !== "string" ||
    value.aspect.trim().length === 0
  ) {
    return null;
  }
  const severity = SEVERITIES.includes(value.severity as ViolationSeverity)
    ? (value.severity as ViolationSeverity)
    : "major";
  const result: LampIrisViolation = {
    aspect: value.aspect.trim(),
    severity,
    description:
      typeof value.description === "string" ? value.description.trim() : "",
    ...(typeof value.frameTimestampSec === "number" &&
    Number.isFinite(value.frameTimestampSec)
      ? { frameTimestampSec: value.frameTimestampSec }
      : {}),
  };
  const action = value.correctionAction;
  if (
    !LAMP_IRIS_CORRECTION_ACTIONS.includes(action as LampIrisCorrectionAction)
  ) {
    return result;
  }
  const rawIds = Array.isArray(value.planItemIds)
    ? value.planItemIds.filter(
        (itemId): itemId is string =>
          typeof itemId === "string" && itemId.trim().length > 0
      )
    : [];
  const planItemIds = [...new Set(rawIds.map((itemId) => itemId.trim()))].sort();
  if (
    correctionIsSafe(plan, evalId, action as LampIrisCorrectionAction, planItemIds)
  ) {
    result.correction = {
      action: action as LampIrisCorrectionAction,
      planItemIds,
    };
  }
  return result;
}

function coerceVisualResult(
  value: unknown,
  plan: LampIrisPlan,
  iteration: 1 | 2,
  previousResults: LampIrisEvalResult[]
): LampIrisEvalResult | null {
  if (
    !isRecord(value) ||
    typeof value.evalId !== "string" ||
    !LAMP_IRIS_VISUAL_EVAL_DEFS.some(
      (definition) => definition.id === value.evalId
    )
  ) {
    return null;
  }
  const evalId = value.evalId as LampIrisEvalId;
  const rawScore =
    typeof value.score === "number" ? value.score : Number(value.score);
  const rawConfidence =
    typeof value.confidence === "number"
      ? value.confidence
      : Number(value.confidence);
  if (!Number.isFinite(rawScore) || !Number.isFinite(rawConfidence)) {
    return null;
  }
  const definition = evalDefinition(evalId);
  const score = clamp(rawScore, 0, 100);
  const confidence = clamp(rawConfidence, 0, 1);
  const previous = previousResults.find((result) => result.evalId === evalId);
  return {
    evalId,
    iteration,
    score,
    confidence,
    verdict: verdictFor(
      score,
      definition.passThreshold,
      definition.borderlineThreshold
    ),
    violations: Array.isArray(value.violations)
      ? value.violations.flatMap((violation) => {
          const canonical = coerceViolation(violation, plan, evalId);
          return canonical ? [canonical] : [];
        })
      : [],
    reasoning:
      typeof value.reasoning === "string" ? value.reasoning.trim() : "",
    ...(previous ? { deltaFromPrevious: score - previous.score } : {}),
  };
}

function audioIntegrityResult(
  iteration: 1 | 2,
  audioVerified: boolean,
  previousResults: LampIrisEvalResult[]
): LampIrisEvalResult {
  const score = audioVerified ? 100 : 0;
  const previous = previousResults.find(
    (result) => result.evalId === "audio-integrity"
  );
  return {
    evalId: "audio-integrity",
    iteration,
    score,
    confidence: 1,
    verdict: audioVerified ? "pass" : "fail",
    violations: audioVerified
      ? []
      : [
          {
            aspect: "source-audio-integrity",
            severity: "critical",
            description:
              "The finalized cut did not pass deterministic source-audio verification.",
          },
        ],
    reasoning: audioVerified
      ? "Canonical source audio or source silence passed deterministic verification."
      : "Canonical source audio verification failed; the artifact must not be delivered.",
    ...(previous ? { deltaFromPrevious: score - previous.score } : {}),
  };
}

function usageIsValid(value: unknown): value is GeminiProUsageSnapshot {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.promptTokenCount) &&
    (value.promptTokenCount as number) >= 0 &&
    Number.isSafeInteger(value.candidatesTokenCount) &&
    (value.candidatesTokenCount as number) >= 0
  );
}

/**
 * Convert one holistic judge response into the persisted per-check artifact.
 * Every visual check must be present exactly once; deterministic audio is
 * appended by trusted code.
 */
export function buildLampIrisEvaluationArtifact(input: {
  raw: unknown;
  plan: LampIrisPlan;
  iteration: 1 | 2;
  audioVerified: boolean;
  costUsd: number;
  usage?: GeminiProUsageSnapshot;
  previousResults?: LampIrisEvalResult[];
}): LampIrisEvaluationArtifact {
  const plan = parseLampIrisPlan(input.plan);
  if (input.iteration !== 1 && input.iteration !== 2) {
    throw new Error("Lamp Iris evaluation iteration must be 1 or 2.");
  }
  if (!isRecord(input.raw) || !Array.isArray(input.raw.results)) {
    throw new Error("Lamp Iris evaluator returned an invalid results envelope.");
  }
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) {
    throw new Error("Lamp Iris evaluation cost must be non-negative.");
  }
  const usage = input.usage ?? {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
  };
  if (!usageIsValid(usage)) {
    throw new Error("Lamp Iris evaluation usage snapshot is invalid.");
  }
  const previousResults = input.previousResults ?? [];
  const coerced = input.raw.results.flatMap((value) => {
    const result = coerceVisualResult(
      value,
      plan,
      input.iteration as 1 | 2,
      previousResults
    );
    return result ? [result] : [];
  });
  const seen = new Set<string>();
  const visual: LampIrisEvalResult[] = [];
  for (const result of coerced) {
    if (seen.has(result.evalId)) continue;
    seen.add(result.evalId);
    visual.push(result);
  }
  const missing = LAMP_IRIS_VISUAL_EVAL_DEFS.filter(
    (definition) => !seen.has(definition.id)
  );
  if (missing.length > 0) {
    throw new Error(
      `Lamp Iris evaluator omitted required checks: ${missing
        .map((definition) => definition.id)
        .join(", ")}.`
    );
  }
  const ordered = LAMP_IRIS_VISUAL_EVAL_DEFS.map((definition) => {
    const result = visual.find((entry) => entry.evalId === definition.id);
    if (!result) {
      throw new Error(`Missing coerced result for ${definition.id}.`);
    }
    return result;
  });
  return {
    version: LAMP_IRIS_EVALUATOR_VERSION,
    planVersion: plan.version,
    planId: plan.id,
    iteration: input.iteration,
    evalResults: [
      ...ordered,
      audioIntegrityResult(input.iteration, input.audioVerified, previousResults),
    ],
    usage,
    costUsd: input.costUsd,
  };
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "aspect"
  );
}

/**
 * Consolidate the first evaluation's safe, structured corrections for the one
 * Final pass. Severity-ranked, de-duplicated, capped, and item-verified — no
 * judge-authored free text ever reaches the generation prompt.
 */
export function collectLampIrisCorrections(
  artifact: LampIrisEvaluationArtifact,
  plan: LampIrisPlan
): LampIrisCorrection[] {
  const canonical = parseLampIrisPlan(plan);
  if (artifact.planId !== canonical.id) {
    throw new Error(
      "Corrections must be bound to the same iris plan that was evaluated."
    );
  }
  const corrections: LampIrisCorrection[] = [];
  const seen = new Set<string>();
  for (const result of artifact.evalResults) {
    for (const violation of result.violations) {
      const correction = violation.correction;
      if (!correction) continue;
      if (
        !correctionIsSafe(
          canonical,
          result.evalId,
          correction.action,
          correction.planItemIds
        )
      ) {
        continue;
      }
      const key = `${correction.action}:${correction.planItemIds.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      corrections.push({
        id: `${result.evalId}-${slug(violation.aspect)}`,
        sourceEvalId: result.evalId,
        aspect: violation.aspect,
        severity: violation.severity,
        action: correction.action,
        planItemIds: correction.planItemIds,
      });
    }
  }
  corrections.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
  return corrections.slice(0, MAX_ACTIVE_CORRECTIONS);
}

/**
 * The judge sees the FULL plan — including declined and uncertain categories —
 * so unapproved correction is checkable. Only the generation prompt keeps
 * declined categories out of sight.
 */
function evaluatorPlanProjection(plan: LampIrisPlan): unknown {
  return {
    id: plan.id,
    decision: plan.decision,
    subjectSummary: plan.subjectSummary,
    sourceScope: plan.sourceScope,
    correct: plan.correct,
    declined: plan.declined,
    uncertain: plan.uncertain,
  };
}

const INTENSITY_EXPECTATION: Record<1 | 2 | 3, string> = {
  1: "natural assist — the clear reading pattern is calmed while every natural glance-away and the full blink pattern survive; a gaze still visibly anchored to reading material is undershoot, and erased natural breaks are overshoot",
  2: "presenter — contact is the steady state through all spoken passages with brief natural breaks surviving at phrase boundaries; residual reading anchor or scanning is undershoot, and a break-free continuous lock is overshoot",
  3: "anchor — near-continuous contact except blinks and momentary natural micro-breaks; any habitual off-lens rest is undershoot, and a frozen unblinking stare is overshoot",
};

export function renderLampIrisHolisticEvaluatorPrompt(input: {
  plan: LampIrisPlan;
  iteration: 1 | 2;
}): string {
  const plan = parseLampIrisPlan(input.plan);
  const gazeContract =
    plan.decision === "correct"
      ? [
          "GAZE CONTRACT — judge target matching in BOTH directions:",
          ...plan.correct.map(
            (item) =>
              `- [${item.id}] approved at ${item.intensity} of 3: expected ${INTENSITY_EXPECTATION[item.intensity]}. Undershoot => violation with correctionAction complete-approved-gaze-correction; overshoot => violation with correctionAction reduce-gaze-lock.`
          ),
        ].join("\n")
      : "GAZE CONTRACT — exceptional no-op: any semantic or aesthetic change from the source is a violation.";
  const rubricBlock = LAMP_IRIS_VISUAL_EVAL_DEFS.map(
    (definition) =>
      `- ${definition.id} (weight ${definition.weight}): ${definition.rubric}`
  ).join("\n");
  return [
    `You are the holistic evaluator for Lamp Iris iteration ${input.iteration}.`,
    "You are given the ORIGINAL source video and one CANDIDATE eye-contact correction of its primary subject.",
    "The human-approved gaze-correction plan below is the exact edit authorization. Judge the candidate against the complete source timeline, not isolated frames.",
    "",
    "APPROVED GAZE-CORRECTION PLAN (verbatim, includes declined and uncertain categories for your reference):",
    JSON.stringify(evaluatorPlanProjection(plan), null, 2),
    "",
    gazeContract,
    "",
    "Evaluation principles:",
    "- The subject is reading a script; the delivered audio is the untouched source track. Lip-sync and speech articulation are product-critical and judged at full strictness.",
    "- Blinks are never currency: no approved intensity buys the removal, addition, or retiming of a single blink.",
    "- The head never re-aims; contact achieved by head pose change instead of eye redirection is a motion-lipsync failure.",
    "- Overshoot is real: a dead, frozen, or hypnotic stare fails gaze-naturalness even at intensity 3.",
    "- Declined and uncertain categories, the rest of the face, other people, the background, lighting, and camera are all protected.",
    "- Judge each check independently; report timestamped violations with a correctionAction only when one of the allowed structured actions applies.",
    "",
    "CHECKS:",
    rubricBlock,
    "",
    'Respond with strict JSON: { "results": [ { "evalId", "score" (0-100), "confidence" (0-1), "violations": [ { "aspect", "severity" (critical|major|minor), "description", "frameTimestampSec" (number|null), "correctionAction" (allowed action|null), "planItemIds": [approved correct ids] } ], "reasoning" } ] } with every visual check present exactly once.',
  ].join("\n");
}
