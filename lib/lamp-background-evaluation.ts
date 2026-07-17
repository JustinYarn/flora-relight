import {
  LAMP_BACKGROUND_CLEANUP_PLAN_VERSION,
  parseLampBackgroundCleanupPlan,
  type LampBackgroundCleanupPlan,
} from "./lamp-background.ts";
import type {
  GeminiProUsageSnapshot,
  Verdict,
  ViolationSeverity,
} from "./types.ts";

export const LAMP_BACKGROUND_EVALUATOR_VERSION =
  "lamp-background-holistic-v1" as const;

export const LAMP_BACKGROUND_EVAL_IDS = [
  "identity-preservation",
  "skin-texture-age",
  "appearance-fidelity",
  "motion-lipsync",
  "cleanup-plan-adherence",
  "background-cleanup-quality",
  "background-temporal-stability",
  "inpainting-artifacts",
  "lighting-camera-fidelity",
  "audio-integrity",
] as const;

export type LampBackgroundEvalId =
  (typeof LAMP_BACKGROUND_EVAL_IDS)[number];

export const LAMP_BACKGROUND_CORRECTION_ACTIONS = [
  "restore-subject-identity",
  "restore-skin",
  "restore-appearance",
  "restore-motion-lipsync",
  "complete-approved-removal",
  "restore-preserved-background",
  "preserve-uncertain-background",
  "restore-unplanned-background-change",
  "stabilize-approved-removal",
  "repair-inpainting",
  "restore-lighting-camera",
] as const;

export type LampBackgroundCorrectionAction =
  (typeof LAMP_BACKGROUND_CORRECTION_ACTIONS)[number];

export interface LampBackgroundEvalDefinition {
  id: LampBackgroundEvalId;
  name: string;
  category:
    | "identity"
    | "skin"
    | "appearance"
    | "motion"
    | "cleanup"
    | "temporal"
    | "artifact"
    | "fidelity"
    | "audio";
  description: string;
  method: "holistic-judge" | "deterministic";
  hardGate: boolean;
  weight: number;
  passThreshold: number;
  borderlineThreshold: number;
  rubric: string;
  allowedCorrectionActions: LampBackgroundCorrectionAction[];
}

const DEFINITIONS: LampBackgroundEvalDefinition[] = [
  {
    id: "identity-preservation",
    name: "Same person",
    category: "identity",
    description:
      "The person remains unmistakably the same human in every corresponding moment.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.13,
    passThreshold: 90,
    borderlineThreshold: 75,
    allowedCorrectionActions: ["restore-subject-identity"],
    rubric: `Compare facial geometry, distinctive marks, facial hair, apparent age, and recognizability throughout the complete source and candidate. Background cleanup grants no permission to alter the subject. Every additional visible person is equally protected: a person removed, added, or materially changed anywhere in frame — including at frame edges or partially visible — fails. Judge the worst moment, especially occlusion boundaries and head motion. Any frame that reads as a different or materially reconstructed person fails.`,
  },
  {
    id: "skin-texture-age",
    name: "Natural skin preserved",
    category: "skin",
    description:
      "Skin texture, marks, complexion variation, and apparent age remain source-faithful.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.08,
    passThreshold: 88,
    borderlineThreshold: 74,
    allowedCorrectionActions: ["restore-skin"],
    rubric: `Inspect pores, fine lines, moles, freckles, blemishes, facial hair, complexion variation, and apparent age across speech and head motion. No relighting or beautification was requested, so visible smoothing, invented texture, removed marks, plastic skin, or added/removed wrinkles are violations. Compression differences alone are not.`,
  },
  {
    id: "appearance-fidelity",
    name: "Hair and clothing unchanged",
    category: "appearance",
    description:
      "Hair, garments, accessories, held objects, and actively used objects remain unchanged.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.1,
    passThreshold: 88,
    borderlineThreshold: 74,
    allowedCorrectionActions: ["restore-appearance"],
    rubric: `Build independent inventories of hair, every garment layer, accessories, and anything held, touched, or actively used — for the subject and for every other visible person. Diff those inventories across the full timeline. No item on or interacting with any person may disappear, transform, simplify, or drift. Pay special attention where a person overlaps an approved background removal.`,
  },
  {
    id: "motion-lipsync",
    name: "Motion and lips match",
    category: "motion",
    description:
      "Performance timing, gestures, blinks, head motion, and lip motion remain aligned to the source.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.1,
    passThreshold: 90,
    borderlineThreshold: 78,
    allowedCorrectionActions: ["restore-motion-lipsync"],
    rubric: `Compare the complete timelines at corresponding moments. Every gesture, blink, posture shift, head turn, and mouth shape must follow the source trajectory and timing. Background cleanup must not retime, smooth, reanimate, stabilize, or reinterpret the performance. One obvious lip-sync or motion discontinuity fails.`,
  },
  {
    id: "cleanup-plan-adherence",
    name: "Approved plan followed",
    category: "cleanup",
    description:
      "Every approved target is removed and nothing outside the approved plan is removed or redesigned.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.17,
    passThreshold: 90,
    borderlineThreshold: 75,
    allowedCorrectionActions: [
      "complete-approved-removal",
      "restore-preserved-background",
      "preserve-uncertain-background",
      "restore-unplanned-background-change",
    ],
    rubric: `Treat the approved cleanup plan as the exact edit authorization. For a cleanup plan, every item in remove should be absent wherever it appears, including intermittent moments and partial occlusions. Every item in preserve must remain. Every uncertain item is preserve-by-default. All unlisted background content is also preserved unless it is inseparable low-level reconstruction immediately behind an approved target. No plan can authorize touching a person: removing or altering any visible person fails regardless of what the plan says. Added decor, substitutions, broad redesign, extra removals, and an unchanged result with planned targets still present all fail. For an exceptional no-op, any semantic or aesthetic change fails.`,
  },
  {
    id: "background-cleanup-quality",
    name: "Background meaningfully tidier",
    category: "cleanup",
    description:
      "The approved cleanup creates a clear, restrained improvement without emptying or redesigning the scene.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.16,
    passThreshold: 85,
    borderlineThreshold: 70,
    allowedCorrectionActions: [
      "complete-approved-removal",
      "repair-inpainting",
    ],
    rubric: `Judge whether the result reads as intentionally tidier and more professionally presentable at normal playback size. A cleanup plan should produce a visible but source-faithful improvement; returning a near-copy because the changes were difficult is a failure. Do not reward maximal emptiness: the best result removes the approved visual clutter while preserving the room's identity and lived-in credibility. An exceptional no-op may pass only when the source truly supports its strict justification and the candidate is effectively the exact source.`,
  },
  {
    id: "background-temporal-stability",
    name: "Cleanup stays stable",
    category: "temporal",
    description:
      "Removed areas and reconstructed surfaces remain coherent from first frame to last.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.1,
    passThreshold: 86,
    borderlineThreshold: 72,
    allowedCorrectionActions: ["stabilize-approved-removal"],
    rubric: `Inspect the complete video for object popping, reappearance, flicker, crawling texture, edge chatter, shifting reconstruction, and inconsistent occlusion handling. An approved target must stay removed whenever its source location is visible. Reconstructed surfaces must remain locked to the static camera and existing scene geometry through subject motion.`,
  },
  {
    id: "inpainting-artifacts",
    name: "Invisible reconstruction",
    category: "artifact",
    description:
      "Pixels revealed behind removed clutter look natural and match the real surrounding surfaces.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.08,
    passThreshold: 88,
    borderlineThreshold: 74,
    allowedCorrectionActions: ["repair-inpainting"],
    rubric: `Inspect each approved removal footprint and the subject boundary around it. Look for smears, repeated texture, warped lines, melting geometry, halos, cutout edges, impossible reflections, invented seams, over-sharpening, or blurry patches. Reconstruction should extend only the most plausible existing wall, desk, floor, shelf, or other source surface; it must not invent a new object or design.`,
  },
  {
    id: "lighting-camera-fidelity",
    name: "Lighting and camera unchanged",
    category: "fidelity",
    description:
      "Exposure, color, focus, depth of field, framing, perspective, and camera motion remain source-faithful.",
    method: "holistic-judge",
    hardGate: true,
    weight: 0.04,
    passThreshold: 90,
    borderlineThreshold: 78,
    allowedCorrectionActions: ["restore-lighting-camera"],
    rubric: `Factor out only unavoidable local pixel reconstruction inside approved removal footprints. Everywhere else compare exposure, contrast, white balance, saturation, focus, depth of field, noise character, framing, crop, scale, perspective, lens feel, and camera position. No relighting, background blur, color grade, reframing, stabilization, or subject-separation effect is authorized in v1.`,
  },
  {
    id: "audio-integrity",
    name: "Source audio preserved",
    category: "audio",
    description:
      "The delivered cut carries the canonical source audio unchanged, or remains silent when the source is silent.",
    method: "deterministic",
    hardGate: true,
    weight: 0.04,
    passThreshold: 99,
    borderlineThreshold: 99,
    allowedCorrectionActions: [],
    rubric:
      "Server-only deterministic check: discard provider sound, remux the canonical source track or preserve source silence, verify aligned duration, audio presence, and complete-timeline bitstream integrity. Score is 100 or 0; no model judges this row.",
  },
];

export const LAMP_BACKGROUND_EVAL_DEFS =
  DEFINITIONS satisfies LampBackgroundEvalDefinition[];

export const LAMP_BACKGROUND_VISUAL_EVAL_DEFS =
  LAMP_BACKGROUND_EVAL_DEFS.filter(
    (definition) => definition.method !== "deterministic"
  );

export interface LampBackgroundViolationCorrection {
  action: LampBackgroundCorrectionAction;
  /**
   * IDs are plan references, never free-form targets. The action determines
   * which plan classification the ids are allowed to reference.
   */
  planItemIds: string[];
}

export interface LampBackgroundViolation {
  aspect: string;
  severity: ViolationSeverity;
  description: string;
  frameTimestampSec?: number;
  correction?: LampBackgroundViolationCorrection;
}

export interface LampBackgroundEvalResult {
  evalId: LampBackgroundEvalId;
  iteration: 1 | 2;
  score: number;
  confidence: number;
  verdict: Verdict;
  violations: LampBackgroundViolation[];
  reasoning: string;
  deltaFromPrevious?: number;
}

export interface LampBackgroundEvaluationArtifact {
  version: typeof LAMP_BACKGROUND_EVALUATOR_VERSION;
  cleanupPlanVersion: typeof LAMP_BACKGROUND_CLEANUP_PLAN_VERSION;
  cleanupPlanId: string;
  iteration: 1 | 2;
  evalResults: LampBackgroundEvalResult[];
  usage?: GeminiProUsageSnapshot;
  costUsd: number;
}

export interface LampBackgroundCorrection {
  id: string;
  sourceEvalId: LampBackgroundEvalId;
  aspect: string;
  severity: ViolationSeverity;
  action: LampBackgroundCorrectionAction;
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

function evalDefinition(id: LampBackgroundEvalId): LampBackgroundEvalDefinition {
  const definition = LAMP_BACKGROUND_EVAL_DEFS.find(
    (candidate) => candidate.id === id
  );
  if (!definition) {
    throw new Error(`Unknown Lamp Background eval id "${id}".`);
  }
  return definition;
}

function itemIdsForAction(
  plan: LampBackgroundCleanupPlan,
  action: LampBackgroundCorrectionAction
): Set<string> | null {
  switch (action) {
    case "complete-approved-removal":
    case "stabilize-approved-removal":
    case "repair-inpainting":
      return new Set(plan.remove.map((item) => item.id));
    case "restore-preserved-background":
      return new Set(plan.preserve.map((item) => item.id));
    case "preserve-uncertain-background":
      return new Set(plan.uncertain.map((item) => item.id));
    default:
      return null;
  }
}

function correctionIsSafe(
  plan: LampBackgroundCleanupPlan,
  evalId: LampBackgroundEvalId,
  action: LampBackgroundCorrectionAction,
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
  plan: LampBackgroundCleanupPlan,
  evalId: LampBackgroundEvalId
): LampBackgroundViolation | null {
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
  const result: LampBackgroundViolation = {
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
    !LAMP_BACKGROUND_CORRECTION_ACTIONS.includes(
      action as LampBackgroundCorrectionAction
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
      action as LampBackgroundCorrectionAction,
      planItemIds
    )
  ) {
    result.correction = {
      action: action as LampBackgroundCorrectionAction,
      planItemIds,
    };
  }
  return result;
}

function coerceVisualResult(
  value: unknown,
  plan: LampBackgroundCleanupPlan,
  iteration: 1 | 2,
  previousResults: LampBackgroundEvalResult[]
): LampBackgroundEvalResult | null {
  if (
    !isRecord(value) ||
    typeof value.evalId !== "string" ||
    !LAMP_BACKGROUND_VISUAL_EVAL_DEFS.some(
      (definition) => definition.id === value.evalId
    )
  ) {
    return null;
  }
  const evalId = value.evalId as LampBackgroundEvalId;
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
  previousResults: LampBackgroundEvalResult[]
): LampBackgroundEvalResult {
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
export function buildLampBackgroundEvaluationArtifact(input: {
  raw: unknown;
  cleanupPlan: LampBackgroundCleanupPlan;
  iteration: 1 | 2;
  audioVerified: boolean;
  previousResults?: LampBackgroundEvalResult[];
  usage?: GeminiProUsageSnapshot;
  costUsd: number;
}): LampBackgroundEvaluationArtifact {
  const plan = parseLampBackgroundCleanupPlan(input.cleanupPlan);
  if (plan.approval.status !== "approved") {
    throw new Error(
      "Lamp Background evaluation requires the approved cleanup plan."
    );
  }
  if (!isRecord(input.raw) || !Array.isArray(input.raw.results)) {
    throw new Error(
      "Lamp Background evaluator returned an invalid result envelope."
    );
  }
  if (
    !Number.isFinite(input.costUsd) ||
    input.costUsd < 0 ||
    (input.usage !== undefined && !usageIsValid(input.usage))
  ) {
    throw new Error("Lamp Background evaluator usage or cost is invalid.");
  }
  const previousResults = input.previousResults ?? [];
  const byId = new Map<LampBackgroundEvalId, LampBackgroundEvalResult>();
  for (const rawResult of input.raw.results) {
    if (!isRecord(rawResult) || typeof rawResult.evalId !== "string") {
      throw new Error(
        "Lamp Background evaluator returned an invalid result row."
      );
    }
    if (
      !LAMP_BACKGROUND_VISUAL_EVAL_DEFS.some(
        (definition) => definition.id === rawResult.evalId
      )
    ) {
      throw new Error(
        `Lamp Background evaluator returned unexpected check "${rawResult.evalId}".`
      );
    }
    const evalId = rawResult.evalId as LampBackgroundEvalId;
    if (byId.has(evalId)) {
      throw new Error(
        `Lamp Background evaluator returned duplicate result ${evalId}.`
      );
    }
    const result = coerceVisualResult(
      rawResult,
      plan,
      input.iteration,
      previousResults
    );
    if (!result) {
      throw new Error(
        `Lamp Background evaluator returned invalid result ${evalId}.`
      );
    }
    byId.set(evalId, result);
  }
  const missing = LAMP_BACKGROUND_VISUAL_EVAL_DEFS.filter(
    (definition) => !byId.has(definition.id)
  );
  if (missing.length > 0) {
    throw new Error(
      `Lamp Background evaluator omitted required checks: ${missing
        .map((definition) => definition.id)
        .join(", ")}.`
    );
  }
  const evalResults = LAMP_BACKGROUND_VISUAL_EVAL_DEFS.map(
    (definition) => byId.get(definition.id)!
  );
  evalResults.push(
    audioIntegrityResult(
      input.iteration,
      input.audioVerified,
      previousResults
    )
  );
  return {
    version: LAMP_BACKGROUND_EVALUATOR_VERSION,
    cleanupPlanVersion: LAMP_BACKGROUND_CLEANUP_PLAN_VERSION,
    cleanupPlanId: plan.id,
    iteration: input.iteration,
    evalResults,
    ...(input.usage ? { usage: input.usage } : {}),
    costUsd: input.costUsd,
  };
}

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "finding"
  );
}

/**
 * Compile only structured, plan-bound corrections. Judge-authored prose is
 * never copied into a generation prompt, and any unknown or misclassified
 * plan id is ignored. Therefore evaluation cannot create a new removal target.
 */
export function collectLampBackgroundCorrections(
  artifact: LampBackgroundEvaluationArtifact,
  cleanupPlan: LampBackgroundCleanupPlan
): LampBackgroundCorrection[] {
  const plan = parseLampBackgroundCleanupPlan(cleanupPlan);
  if (
    artifact.version !== LAMP_BACKGROUND_EVALUATOR_VERSION ||
    artifact.cleanupPlanVersion !== LAMP_BACKGROUND_CLEANUP_PLAN_VERSION ||
    artifact.cleanupPlanId !== plan.id ||
    artifact.iteration !== 1
  ) {
    throw new Error(
      "Lamp Background corrections require an iteration-1 artifact bound to the same cleanup plan."
    );
  }
  const evalRank = new Map(
    LAMP_BACKGROUND_EVAL_IDS.map((evalId, index) => [evalId, index])
  );
  const byId = new Map<string, LampBackgroundCorrection>();
  for (const result of artifact.evalResults) {
    if (result.evalId === "audio-integrity") continue;
    for (const violation of result.violations) {
      if (!violation.correction) continue;
      const { action, planItemIds } = violation.correction;
      const canonicalIds = [...new Set(planItemIds)].sort();
      if (!correctionIsSafe(plan, result.evalId, action, canonicalIds)) {
        continue;
      }
      const id = [
        "lamp-bg-corr",
        result.evalId,
        slug(violation.aspect),
        action,
        canonicalIds.join("+") || "global",
      ].join(":");
      const candidate: LampBackgroundCorrection = {
        id,
        sourceEvalId: result.evalId,
        aspect: violation.aspect,
        severity: violation.severity,
        action,
        planItemIds: canonicalIds,
      };
      const existing = byId.get(id);
      if (
        !existing ||
        SEVERITY_RANK[candidate.severity] <
          SEVERITY_RANK[existing.severity]
      ) {
        byId.set(id, candidate);
      }
    }
  }
  return [...byId.values()]
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (evalRank.get(a.sourceEvalId) ?? Number.MAX_SAFE_INTEGER) -
          (evalRank.get(b.sourceEvalId) ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, MAX_ACTIVE_CORRECTIONS);
}

function evaluatorPlanProjection(plan: LampBackgroundCleanupPlan): unknown {
  return {
    id: plan.id,
    decision: plan.decision,
    sceneSummary: plan.sceneSummary,
    remove: plan.remove,
    preserve: plan.preserve,
    uncertain: plan.uncertain,
    ...(plan.noOpJustification
      ? { noOpJustification: plan.noOpJustification }
      : {}),
  };
}

/**
 * One prompt grades all nine visual checks from the two complete videos. Audio
 * is intentionally absent because it is verified deterministically.
 */
export function renderLampBackgroundHolisticEvaluatorPrompt(
  cleanupPlan: LampBackgroundCleanupPlan
): string {
  const plan = parseLampBackgroundCleanupPlan(cleanupPlan);
  if (plan.approval.status !== "approved") {
    throw new Error(
      "Lamp Background evaluator prompt requires an approved cleanup plan."
    );
  }
  const rubrics = LAMP_BACKGROUND_VISUAL_EVAL_DEFS.map(
    (definition, index) => `CHECK ${index + 1}: ${definition.id}
Name: ${definition.name}
Hard gate: ${definition.hardGate ? "yes" : "no"}
Thresholds: pass >= ${definition.passThreshold}; borderline >= ${definition.borderlineThreshold}; otherwise fail.
Rubric: ${definition.rubric}
Allowed correctionAction values for this check: ${
      definition.allowedCorrectionActions.join(", ") || "(none)"
    }.`
  ).join("\n\n");

  return `You are the single holistic evaluator for Lamp Background v1.

INPUTS
1. The complete ORIGINAL source video.
2. The complete CANDIDATE cleanup video at the same timeline.
3. The exact human-approved cleanup plan below.

APPROVED CLEANUP PLAN
${JSON.stringify(evaluatorPlanProjection(plan), null, 2)}

GLOBAL JUDGING RULES
- Compare corresponding moments across both complete timelines, including speech, gestures, occlusions, and every moment an intermittent target is visible.
- The source is ground truth for the person, performance, appearance, lighting, camera, room, and audio timing.
- The approved plan is the only authorization to alter background content.
- Items in uncertain and all unlisted content are preserve-by-default.
- Do not reward broad redesign, relighting, background blur, reframing, beautification, or maximal emptiness.
- Judge each check independently. Do not let excellent cleanup hide an identity failure, or perfect fidelity hide a failure to perform the approved cleanup.
- Use only the structured correction actions listed below. Never write free-form correction instructions. planItemIds must reference exact ids from the approved plan. If no safe structured correction applies, use correctionAction null and an empty planItemIds array.

${rubrics}

OUTPUT
Respond with strict JSON only, with exactly one row for each of the nine visual checks above and no audio-integrity row:
{
  "results": [
    {
      "evalId": "<exact check id>",
      "score": <number 0-100>,
      "confidence": <number 0-1>,
      "violations": [
        {
          "aspect": "<short stable kebab-case finding>",
          "severity": "critical" | "major" | "minor",
          "description": "<factual description of what is wrong and where>",
          "frameTimestampSec": <number, omit only when no single moment is clearest>,
          "correctionAction": ${LAMP_BACKGROUND_CORRECTION_ACTIONS.map(
            (action) => `"${action}"`
          ).join(" | ")} | null,
          "planItemIds": ["<exact approved-plan id; empty for global restore actions>"]
        }
      ],
      "reasoning": "<concise evidence-based explanation>"
    }
  ]
}`;
}
