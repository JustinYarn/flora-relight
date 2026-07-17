import {
  parseLampBeautifyPlan,
  type LampBeautifyPlan,
} from "./lamp-beautify.ts";
import type {
  GeminiProUsageSnapshot,
  Verdict,
  ViolationSeverity,
} from "./types.ts";

export const LAMP_BEAUTIFY_EVALUATOR_VERSION =
  "lamp-beautify-holistic-v1" as const;

export const LAMP_BEAUTIFY_EVAL_IDS = [
  "identity-preservation",
  "enhancement-adherence",
  "enhancement-quality",
  "natural-skin-texture",
  "permanent-features-integrity",
  "motion-lipsync",
  "background-integrity",
  "other-people-untouched",
  "lighting-camera-fidelity",
  "enhancement-temporal-stability",
  "audio-integrity",
] as const;

export type LampBeautifyEvalId = (typeof LAMP_BEAUTIFY_EVAL_IDS)[number];

export const LAMP_BEAUTIFY_CORRECTION_ACTIONS = [
  "restore-identity",
  "restore-performance-lipsync",
  "complete-approved-enhancement",
  "reduce-enhancement-intensity",
  "remove-unapproved-beautification",
  "repair-skin-texture",
  "restore-untouched-surroundings",
] as const;

export type LampBeautifyCorrectionAction =
  (typeof LAMP_BEAUTIFY_CORRECTION_ACTIONS)[number];

export interface LampBeautifyEvalDefinition {
  id: LampBeautifyEvalId;
  name: string;
  category:
    | "identity"
    | "enhancement"
    | "skin"
    | "motion"
    | "background"
    | "people"
    | "fidelity"
    | "temporal"
    | "audio";
  description: string;
  method: "holistic-judge" | "deterministic";
  hardGate: boolean;
  weight: number;
  passThreshold: number;
  borderlineThreshold: number;
  rubric: string;
  allowedCorrectionActions: LampBeautifyCorrectionAction[];
}

const DEFINITIONS: LampBeautifyEvalDefinition[] = [
  {
    id: "identity-preservation",
    name: "Same person",
    category: "identity",
    description:
      "The subject remains unmistakably the same human in every corresponding moment.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.16,
    passThreshold: 90,
    borderlineThreshold: 75,
    allowedCorrectionActions: ["restore-identity"],
    rubric: `Compare facial geometry, bone structure, distinctive features, apparent age, and recognizability throughout the complete source and candidate. Approved enhancement grants no permission to change who the person is: any frame that reads as a different, younger-by-design, or structurally reshaped person fails. An approved expression-warmth entry may read gently warmer and more engaged than the source; that mood shift alone is not an identity violation, but caricature, a pasted grin, or geometry change is. Judge the worst moment, especially under head motion and expression changes.`,
  },
  {
    id: "enhancement-adherence",
    name: "Approved plan followed",
    category: "enhancement",
    description:
      "Exactly the approved catalog items were applied, each at its approved intensity.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.15,
    passThreshold: 85,
    borderlineThreshold: 70,
    allowedCorrectionActions: [
      "complete-approved-enhancement",
      "reduce-enhancement-intensity",
      "remove-unapproved-beautification",
    ],
    rubric: `Treat the approved enhancement plan as the exact edit authorization and judge TARGET MATCHING per item: at intensity 1 the lift may be deniable; at 2 it must be evident at a glance in a side-by-side at normal playback; at 3 it must be unmistakable even without the source. Too weak for the approved intensity is a failure exactly like too strong — report undershoot with correctionAction complete-approved-enhancement and overshoot with reduce-enhancement-intensity. Any beautification outside the approved list — makeup, reshaping, tone shifts, hairstyle changes, or enhancement of unlisted regions — fails regardless of how flattering it looks.`,
  },
  {
    id: "enhancement-quality",
    name: "Reads camera-ready",
    category: "enhancement",
    description:
      "The subject reads as noticeably better prepared for camera, naturally.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.13,
    passThreshold: 80,
    borderlineThreshold: 65,
    allowedCorrectionActions: ["complete-approved-enhancement"],
    rubric: `Judge whether the subject reads as the same person on their best, most enthusiastic day at normal playback size: noticeably brighter, warmer, and fresher than the source. Calibrate expectations to the plan's intensities: with any item approved at 2 or 3, a result that is hard to distinguish from the source is a hard failure of this workflow's one job, scored accordingly. Do not reward maximal retouching or a forced mood: the best result is convincingly transformed while remaining entirely plausible as real footage of a genuinely good day.`,
  },
  {
    id: "natural-skin-texture",
    name: "Real skin survives",
    category: "skin",
    description:
      "Pores, texture, and natural micro-variation survive enhancement at every intensity.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.1,
    passThreshold: 88,
    borderlineThreshold: 74,
    allowedCorrectionActions: ["repair-skin-texture"],
    rubric: `Inspect skin at speech, motion, and lighting extremes. Enhancement may reduce temporary blemishes and shine and may refine the visual appearance of pores at the approved intensity, but real texture, complexion micro-variation, and natural specular response must survive everywhere. Plastic, waxy, blurred, fully poreless, or uniformly matte skin fails, as does invented texture that does not exist in the source.`,
  },
  {
    id: "permanent-features-integrity",
    name: "Permanent features kept",
    category: "identity",
    description:
      "Moles, scars, freckles, birthmarks, age-consistent wrinkles, and facial-hair pattern are untouched.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.08,
    passThreshold: 90,
    borderlineThreshold: 75,
    allowedCorrectionActions: ["restore-identity"],
    rubric: `Build an inventory of permanent identity features — moles, scars, freckles, birthmarks, wrinkles consistent with age, facial-hair pattern — from the source, and verify each survives in the candidate at every corresponding moment. Hair is fully locked in this workflow: any change to hairstyle, hairline, volume, color, or even stray flyaways fails. Fading, shrinking, or removing any permanent feature fails even when the overall result looks natural; these features are identity, not imperfections.`,
  },
  {
    id: "motion-lipsync",
    name: "Motion and lips match",
    category: "motion",
    description:
      "Every gesture and lip movement follows the source trajectory and timing.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.1,
    passThreshold: 88,
    borderlineThreshold: 74,
    allowedCorrectionActions: ["restore-performance-lipsync"],
    rubric: `Compare the complete timelines at corresponding moments. Every gesture, blink, posture shift, head turn, and spoken mouth shape must follow the source trajectory and timing; speech articulation and lip-sync must remain frame-accurate. When the plan approves expression-warmth, a gently warmer resting expression between and around those articulations is authorized and must not be penalized here — but any retiming, changed phoneme shapes, held smile through speech, or motion discontinuity fails.`,
  },
  {
    id: "background-integrity",
    name: "Room untouched",
    category: "background",
    description:
      "Every background pixel remains source-faithful; this workflow never edits the room.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.1,
    passThreshold: 88,
    borderlineThreshold: 74,
    allowedCorrectionActions: ["restore-untouched-surroundings"],
    rubric: `Compare the complete background — architecture, furniture, objects, screens, reflections, clutter, and room content — against the source at corresponding moments. Lamp Beautify authorizes no background edit of any kind: cleanup, decor change, blur, brightening, or object drift all fail. Factor out only unavoidable compression differences.`,
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
    rubric: `When more than one person is visible, verify every additional person — at frame edges, in the background, or partially visible — remains exactly as filmed: no enhancement, removal, alteration, or restyling. For single-person sources, confirm no person was added. Any change to a non-primary person fails.`,
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
    rubric: `Compare exposure, contrast, white balance, saturation, focus, depth of field, noise character, framing, crop, scale, perspective, lens feel, and camera position across the full timeline. No beauty lighting, glow, bloom, relighting, color grade, or reframing is authorized. Localized, plausible skin response inside approved enhancement regions is the only permitted difference.`,
  },
  {
    id: "enhancement-temporal-stability",
    name: "Enhancement stays stable",
    category: "temporal",
    description:
      "Approved enhancements hold steadily across motion, occlusion, and lighting changes.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.06,
    passThreshold: 85,
    borderlineThreshold: 70,
    allowedCorrectionActions: ["complete-approved-enhancement"],
    rubric: `Inspect the complete video for enhancement flicker, pulsing, drifting strength, or regions where an approved item visibly switches on and off across frames, occlusions, or head turns. Each approved enhancement must read as one continuous physical reality, locked to the subject through motion.`,
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

export const LAMP_BEAUTIFY_EVAL_DEFS = DEFINITIONS as readonly LampBeautifyEvalDefinition[];

export const LAMP_BEAUTIFY_VISUAL_EVAL_DEFS = DEFINITIONS.filter(
  (definition) => definition.method === "holistic-judge"
) as readonly LampBeautifyEvalDefinition[];

export interface LampBeautifyViolationCorrection {
  action: LampBeautifyCorrectionAction;
  planItemIds: string[];
}

export interface LampBeautifyViolation {
  aspect: string;
  severity: ViolationSeverity;
  description: string;
  frameTimestampSec?: number;
  correction?: LampBeautifyViolationCorrection;
}

export interface LampBeautifyEvalResult {
  evalId: LampBeautifyEvalId;
  iteration: 1 | 2;
  score: number;
  confidence: number;
  verdict: Verdict;
  violations: LampBeautifyViolation[];
  reasoning: string;
  deltaFromPrevious?: number;
}

export interface LampBeautifyEvaluationArtifact {
  version: typeof LAMP_BEAUTIFY_EVALUATOR_VERSION;
  planVersion: LampBeautifyPlan["version"];
  planId: string;
  iteration: 1 | 2;
  evalResults: LampBeautifyEvalResult[];
  usage: GeminiProUsageSnapshot;
  costUsd: number;
}

export interface LampBeautifyCorrection {
  id: string;
  sourceEvalId: LampBeautifyEvalId;
  aspect: string;
  severity: ViolationSeverity;
  action: LampBeautifyCorrectionAction;
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

function evalDefinition(id: LampBeautifyEvalId): LampBeautifyEvalDefinition {
  const definition = LAMP_BEAUTIFY_EVAL_DEFS.find(
    (candidate) => candidate.id === id
  );
  if (!definition) {
    throw new Error(`Unknown Lamp Beautify eval id "${id}".`);
  }
  return definition;
}

/**
 * Item-scoped actions may reference only approved ENHANCE entries; region and
 * identity restores carry no item ids. A correction can therefore never smuggle
 * a new enhancement into the second pass.
 */
function itemIdsForAction(
  plan: LampBeautifyPlan,
  action: LampBeautifyCorrectionAction
): Set<string> | null {
  switch (action) {
    case "complete-approved-enhancement":
    case "reduce-enhancement-intensity":
      return new Set(plan.enhance.map((item) => item.id));
    default:
      return null;
  }
}

function correctionIsSafe(
  plan: LampBeautifyPlan,
  evalId: LampBeautifyEvalId,
  action: LampBeautifyCorrectionAction,
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
  plan: LampBeautifyPlan,
  evalId: LampBeautifyEvalId
): LampBeautifyViolation | null {
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
  const result: LampBeautifyViolation = {
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
    !LAMP_BEAUTIFY_CORRECTION_ACTIONS.includes(
      action as LampBeautifyCorrectionAction
    )
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
    correctionIsSafe(
      plan,
      evalId,
      action as LampBeautifyCorrectionAction,
      planItemIds
    )
  ) {
    result.correction = {
      action: action as LampBeautifyCorrectionAction,
      planItemIds,
    };
  }
  return result;
}

function coerceVisualResult(
  value: unknown,
  plan: LampBeautifyPlan,
  iteration: 1 | 2,
  previousResults: LampBeautifyEvalResult[]
): LampBeautifyEvalResult | null {
  if (
    !isRecord(value) ||
    typeof value.evalId !== "string" ||
    !LAMP_BEAUTIFY_VISUAL_EVAL_DEFS.some(
      (definition) => definition.id === value.evalId
    )
  ) {
    return null;
  }
  const evalId = value.evalId as LampBeautifyEvalId;
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
  previousResults: LampBeautifyEvalResult[]
): LampBeautifyEvalResult {
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
export function buildLampBeautifyEvaluationArtifact(input: {
  raw: unknown;
  plan: LampBeautifyPlan;
  iteration: 1 | 2;
  audioVerified: boolean;
  costUsd: number;
  usage?: GeminiProUsageSnapshot;
  previousResults?: LampBeautifyEvalResult[];
}): LampBeautifyEvaluationArtifact {
  const plan = parseLampBeautifyPlan(input.plan);
  if (input.iteration !== 1 && input.iteration !== 2) {
    throw new Error("Lamp Beautify evaluation iteration must be 1 or 2.");
  }
  if (!isRecord(input.raw) || !Array.isArray(input.raw.results)) {
    throw new Error(
      "Lamp Beautify evaluator returned an invalid results envelope."
    );
  }
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) {
    throw new Error("Lamp Beautify evaluation cost must be non-negative.");
  }
  const usage = input.usage ?? {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
  };
  if (!usageIsValid(usage)) {
    throw new Error("Lamp Beautify evaluation usage snapshot is invalid.");
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
  const visual: LampBeautifyEvalResult[] = [];
  for (const result of coerced) {
    if (seen.has(result.evalId)) continue;
    seen.add(result.evalId);
    visual.push(result);
  }
  const missing = LAMP_BEAUTIFY_VISUAL_EVAL_DEFS.filter(
    (definition) => !seen.has(definition.id)
  );
  if (missing.length > 0) {
    throw new Error(
      `Lamp Beautify evaluator omitted required checks: ${missing
        .map((definition) => definition.id)
        .join(", ")}.`
    );
  }
  const ordered = LAMP_BEAUTIFY_VISUAL_EVAL_DEFS.map((definition) => {
    const result = visual.find((entry) => entry.evalId === definition.id);
    if (!result) {
      throw new Error(`Missing coerced result for ${definition.id}.`);
    }
    return result;
  });
  return {
    version: LAMP_BEAUTIFY_EVALUATOR_VERSION,
    planVersion: plan.version,
    planId: plan.id,
    iteration: input.iteration,
    evalResults: [
      ...ordered,
      audioIntegrityResult(
        input.iteration,
        input.audioVerified,
        previousResults
      ),
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
export function collectLampBeautifyCorrections(
  artifact: LampBeautifyEvaluationArtifact,
  plan: LampBeautifyPlan
): LampBeautifyCorrection[] {
  const canonical = parseLampBeautifyPlan(plan);
  if (artifact.planId !== canonical.id) {
    throw new Error(
      "Corrections must be bound to the same beautify plan that was evaluated."
    );
  }
  const corrections: LampBeautifyCorrection[] = [];
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
 * so unapproved beautification is checkable. Only the generation prompt keeps
 * declined categories out of sight.
 */
function evaluatorPlanProjection(plan: LampBeautifyPlan): unknown {
  return {
    id: plan.id,
    decision: plan.decision,
    subjectSummary: plan.subjectSummary,
    sourceScope: plan.sourceScope,
    enhance: plan.enhance,
    declined: plan.declined,
    uncertain: plan.uncertain,
  };
}

const INTENSITY_EXPECTATION: Record<1 | 2 | 3, string> = {
  1: "subtle — a real but deniable lift; absence of any visible change is still undershoot",
  2: "noticeable — evident at a glance in a side-by-side at normal playback; if you must hunt for it, it undershot",
  3: "striking — unmistakable even without the source; if a side-by-side is needed to spot it, it undershot badly",
};

export function renderLampBeautifyHolisticEvaluatorPrompt(input: {
  plan: LampBeautifyPlan;
  iteration: 1 | 2;
}): string {
  const plan = parseLampBeautifyPlan(input.plan);
  const intensityContract =
    plan.decision === "enhance"
      ? [
          "INTENSITY CONTRACT — judge target matching in BOTH directions:",
          ...plan.enhance.map(
            (item) =>
              `- [${item.id}] approved at ${item.intensity} of 3: expected ${INTENSITY_EXPECTATION[item.intensity]}. Undershoot => violation with correctionAction complete-approved-enhancement; implausible overshoot => violation with correctionAction reduce-enhancement-intensity.`
          ),
        ].join("\n")
      : "INTENSITY CONTRACT — exceptional no-op: any semantic or aesthetic change from the source is a violation.";
  const rubricBlock = LAMP_BEAUTIFY_VISUAL_EVAL_DEFS.map(
    (definition) =>
      `- ${definition.id} (weight ${definition.weight}): ${definition.rubric}`
  ).join("\n");
  return [
    `You are the holistic evaluator for Lamp Beautify iteration ${input.iteration}.`,
    "You are given the ORIGINAL source video and one CANDIDATE touch-up of its primary subject.",
    "The human-approved enhancement plan below is the exact edit authorization. Judge the candidate against the complete source timeline, not isolated frames.",
    "",
    "APPROVED ENHANCEMENT PLAN (verbatim, includes declined and uncertain categories for your reference):",
    JSON.stringify(evaluatorPlanProjection(plan), null, 2),
    "",
    intensityContract,
    "",
    "Evaluation principles:",
    "- Approved items must be applied at their approved intensity: 1 deniable, 2 noticeable side-by-side, 3 clearly groomed yet plausible.",
    "- Declined and uncertain categories, unlisted regions, other people, the background, lighting, and camera are all protected.",
    "- Identity outranks polish: a flattering result that reads as a different person fails identity-preservation.",
    "- Judge each check independently; report timestamped violations with a correctionAction only when one of the allowed structured actions applies.",
    "",
    "CHECKS:",
    rubricBlock,
    "",
    "Respond with strict JSON: { \"results\": [ { \"evalId\", \"score\" (0-100), \"confidence\" (0-1), \"violations\": [ { \"aspect\", \"severity\" (critical|major|minor), \"description\", \"frameTimestampSec\" (number|null), \"correctionAction\" (allowed action|null), \"planItemIds\": [approved enhance ids] } ], \"reasoning\" } ] } with every visual check present exactly once.",
  ].join("\n");
}
