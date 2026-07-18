/**
 * Provider-free evaluation contracts for Lamp Combined.
 *
 * A single holistic visual response grades every visual concern. Source-audio
 * integrity remains a deterministic server result and is deliberately absent
 * from the visual-call schema. The aggregate plan id and stable plan hash bind
 * every persisted artifact to the exact authorization a human approved.
 */

import {
  hashLampCombinedPlan,
  LAMP_COMBINED_MAX_CORRECTIONS,
  LAMP_COMBINED_PLAN_VERSION,
  parseLampCombinedPlan,
  selectLampCombinedCorrections,
  type LampCombinedCorrectionCandidate,
  type LampCombinedCorrectionConcern,
  type LampCombinedIteration,
  type LampCombinedPlan,
} from "./lamp-combined.ts";
import type { Verdict, ViolationSeverity } from "./types.ts";

export const LAMP_COMBINED_EVALUATOR_VERSION =
  "lamp-combined-holistic-v1" as const;

export const LAMP_COMBINED_EVAL_IDS = [
  "identity",
  "people-appearance-locks",
  "motion-lipsync",
  "camera-framing",
  "background-cleanliness",
  "lighting-target",
  "beautify-target",
  "eye-contact",
  "region-leakage",
  "temporal-hallucination",
  "audio-integrity",
] as const;

export type LampCombinedEvalId = (typeof LAMP_COMBINED_EVAL_IDS)[number];

export const LAMP_COMBINED_VISUAL_EVAL_IDS = LAMP_COMBINED_EVAL_IDS.filter(
  (evalId): evalId is Exclude<LampCombinedEvalId, "audio-integrity"> =>
    evalId !== "audio-integrity"
);

export type LampCombinedVisualEvalId =
  (typeof LAMP_COMBINED_VISUAL_EVAL_IDS)[number];

export const LAMP_COMBINED_CORRECTION_ACTIONS = [
  "restore-source-identity",
  "restore-people-appearance",
  "restore-motion-lipsync",
  "restore-camera-framing",
  "complete-approved-background-removal",
  "restore-protected-background",
  "match-lighting-target",
  "complete-approved-beautify",
  "reduce-approved-beautify",
  "restore-disabled-beautify",
  "complete-approved-eye-contact",
  "reduce-eye-contact-lock",
  "restore-disabled-eye-region",
  "contain-region-leakage",
  "stabilize-approved-edits",
  "remove-hallucination",
] as const;

export type LampCombinedCorrectionAction =
  (typeof LAMP_COMBINED_CORRECTION_ACTIONS)[number];

export type LampCombinedEvalCategory =
  | "identity"
  | "people-appearance"
  | "motion-lipsync"
  | "camera-framing"
  | "background-cleanliness"
  | "lighting"
  | "beautify"
  | "eye-contact"
  | "region-leakage"
  | "temporal-hallucination"
  | "audio";

export type LampCombinedEvalContract =
  | "target"
  | "preservation"
  | "deterministic";

export interface LampCombinedDisabledEvalContract {
  control: "beautify" | "iris";
  contract: "preservation";
  concern: "preservation";
  hardGate: true;
  description: string;
  rubric: string;
  allowedCorrectionActions: readonly LampCombinedCorrectionAction[];
}

/**
 * The registry never changes shape with controls. Beautify and Iris keep the
 * same eval ids when disabled; only their effective contract changes from an
 * enabled target to a source-preservation hard gate.
 */
export interface LampCombinedEvalRegistryEntry {
  id: LampCombinedEvalId;
  name: string;
  category: LampCombinedEvalCategory;
  method: "holistic-judge" | "deterministic";
  contract: LampCombinedEvalContract;
  concern: LampCombinedCorrectionConcern;
  hardGate: boolean;
  weight: number;
  passThreshold: number;
  borderlineThreshold: number;
  description: string;
  rubric: string;
  allowedCorrectionActions: readonly LampCombinedCorrectionAction[];
  disabled?: LampCombinedDisabledEvalContract;
}

export interface LampCombinedEvalDefinition
  extends Omit<LampCombinedEvalRegistryEntry, "disabled"> {
  disabledControl?: "beautify" | "iris";
}

export const LAMP_COMBINED_EVAL_REGISTRY = [
  {
    id: "identity",
    name: "Identity locked",
    category: "identity",
    method: "holistic-judge",
    contract: "preservation",
    concern: "preservation",
    hardGate: true,
    weight: 0.14,
    passThreshold: 90,
    borderlineThreshold: 75,
    description:
      "Every visible person remains recognizably the same human at every corresponding moment.",
    rubric:
      "Compare facial geometry, distinctive features, apparent age, and recognizability across the complete timelines. Relighting, cleanup, approved grooming, and gaze direction never authorize a different or reconstructed identity. Any person who changes identity, disappears, or is added fails this gate.",
    allowedCorrectionActions: ["restore-source-identity"],
  },
  {
    id: "people-appearance-locks",
    name: "People and appearance locks",
    category: "people-appearance",
    method: "holistic-judge",
    contract: "preservation",
    concern: "preservation",
    hardGate: true,
    weight: 0.1,
    passThreshold: 88,
    borderlineThreshold: 74,
    description:
      "People, hair, clothing, accessories, held objects, and protected appearance regions stay source-faithful.",
    rubric:
      "Inventory every visible person, garment layer, accessory, hairstyle, held object, and actively used object. Only exact human-approved Beautify items on the primary subject may differ. Other people are wholesale locked. Hair, wardrobe, permanent features, age structure, and all declined, uncertain, or unlisted appearance categories remain source-faithful.",
    allowedCorrectionActions: ["restore-people-appearance"],
  },
  {
    id: "motion-lipsync",
    name: "Motion and lips locked",
    category: "motion-lipsync",
    method: "holistic-judge",
    contract: "preservation",
    concern: "preservation",
    hardGate: true,
    weight: 0.12,
    passThreshold: 90,
    borderlineThreshold: 76,
    description:
      "Performance timing, gestures, head movement, blinks, speech articulation, and lip sync match the source.",
    rubric:
      "Compare complete timelines at corresponding moments. Preserve every gesture, posture shift, head pose, blink timestamp, and spoken mouth shape. Approved gaze changes only eye direction and its minimally implied eyelid pose; approved Beautify work cannot retime phonemes or body motion. Any obvious motion discontinuity or lip-sync drift fails.",
    allowedCorrectionActions: ["restore-motion-lipsync"],
  },
  {
    id: "camera-framing",
    name: "Camera and framing locked",
    category: "camera-framing",
    method: "holistic-judge",
    contract: "preservation",
    concern: "preservation",
    hardGate: true,
    weight: 0.08,
    passThreshold: 88,
    borderlineThreshold: 74,
    description:
      "Crop, scale, perspective, focus, depth of field, lens character, and camera behavior match the source.",
    rubric:
      "The camera is static and fully locked. Reframing, zoom, stabilization, altered perspective, portrait blur, focus drift, or a changed lens feel fails. Compare frame edges and subject scale throughout, not only the opening frame.",
    allowedCorrectionActions: ["restore-camera-framing"],
  },
  {
    id: "background-cleanliness",
    name: "Approved cleanliness target",
    category: "background-cleanliness",
    method: "holistic-judge",
    contract: "target",
    concern: "background",
    hardGate: false,
    weight: 0.12,
    passThreshold: 86,
    borderlineThreshold: 72,
    description:
      "The approved removal targets are completed at the selected cleanliness amplitude without broadening scope.",
    rubric:
      "Treat the human-approved background remove list as the complete target set. Apply the selected cleanliness level only as execution thoroughness inside those same footprints. Every preserve, uncertain, and unlisted item remains. Do not create a new removal target, empty the room, substitute decor, or redesign any surface.",
    allowedCorrectionActions: [
      "complete-approved-background-removal",
      "restore-protected-background",
    ],
  },
  {
    id: "lighting-target",
    name: "Lighting target",
    category: "lighting",
    method: "holistic-judge",
    contract: "target",
    concern: "lighting",
    hardGate: false,
    weight: 0.12,
    passThreshold: 85,
    borderlineThreshold: 70,
    description:
      "The result clearly reaches the run-bound lighting target while preserving plausible scene geometry and color identity.",
    rubric:
      "Judge the candidate against the exact run-bound relight directive supplied with the evaluation. Require a clear, coherent target match without changing scene layout, object identity, wardrobe color identity, or physical light geometry. A near-copy undershoots; a dramatic unrelated grade or invented light source overshoots.",
    allowedCorrectionActions: ["match-lighting-target"],
  },
  {
    id: "beautify-target",
    name: "Beautify target",
    category: "beautify",
    method: "holistic-judge",
    contract: "target",
    concern: "beautify",
    hardGate: false,
    weight: 0.08,
    passThreshold: 85,
    borderlineThreshold: 70,
    description:
      "Enabled, approved Beautify items reach their shared control level without adding categories.",
    rubric:
      "Apply exactly the enabled human-approved Beautify items at the plan-bound global level. Judge both undershoot and unnatural overshoot. Declined, uncertain, and unlisted appearance categories are protected, and approved enhancement cannot change identity, hair, wardrobe, other people, or the room.",
    allowedCorrectionActions: [
      "complete-approved-beautify",
      "reduce-approved-beautify",
    ],
    disabled: {
      control: "beautify",
      contract: "preservation",
      concern: "preservation",
      hardGate: true,
      description:
        "Beautify is off, so the primary subject's appearance must remain source-faithful.",
      rubric:
        "Beautify is explicitly disabled. Compare expression, skin texture and tone, under-eyes, teeth, eyes, hair, permanent features, and apparent age to the source. Any grooming, smoothing, brightening, expression rewrite, or other appearance enhancement is unauthorized and fails this preservation gate.",
      allowedCorrectionActions: ["restore-disabled-beautify"],
    },
  },
  {
    id: "eye-contact",
    name: "Eye-contact target",
    category: "eye-contact",
    method: "holistic-judge",
    contract: "target",
    concern: "iris",
    hardGate: false,
    weight: 0.07,
    passThreshold: 85,
    borderlineThreshold: 70,
    description:
      "Enabled eye contact reaches fixed Presenter intensity 2 and remains natural through speech.",
    rubric:
      "Judge the enabled human-approved Iris plan at fixed Presenter intensity 2. Literal viewer contact should be the steady state through speech while source blinks and natural micro-breaks survive. Penalize both an unchanged reading anchor and an unblinking locked stare. Eye identity, color, shape, lashes, brows, and catchlight character remain source-faithful except for plausible direction response.",
    allowedCorrectionActions: [
      "complete-approved-eye-contact",
      "reduce-eye-contact-lock",
    ],
    disabled: {
      control: "iris",
      contract: "preservation",
      concern: "preservation",
      hardGate: true,
      description:
        "Eye contact is off, so gaze behavior and the complete eye region must match the source.",
      rubric:
        "Eye contact is explicitly disabled. Preserve the source gaze trajectory, reading pattern, blinks, eyelid motion, iris and sclera appearance, catchlights, and eye geometry at corresponding moments. Any gaze redirection, eye brightening, enlargement, or synthetic contact fails this preservation gate.",
      allowedCorrectionActions: ["restore-disabled-eye-region"],
    },
  },
  {
    id: "region-leakage",
    name: "No edit leakage",
    category: "region-leakage",
    method: "holistic-judge",
    contract: "preservation",
    concern: "preservation",
    hardGate: true,
    weight: 0.07,
    passThreshold: 88,
    borderlineThreshold: 74,
    description:
      "Every authorized edit stays inside its approved semantic and spatial region.",
    rubric:
      "Inspect boundaries between concerns. Cleanup stays inside approved removal footprints and never touches a person. Beautify stays on approved primary-subject regions. Iris stays in the immediate eye region. Relighting must not become geometry, decor, wardrobe, or identity change. Halos, spill, neighboring-object edits, and cross-concern side effects fail.",
    allowedCorrectionActions: ["contain-region-leakage"],
  },
  {
    id: "temporal-hallucination",
    name: "Temporal stability and no hallucination",
    category: "temporal-hallucination",
    method: "holistic-judge",
    contract: "preservation",
    concern: "preservation",
    hardGate: true,
    weight: 0.08,
    passThreshold: 88,
    borderlineThreshold: 74,
    description:
      "Approved changes remain stable and no object, feature, texture, or event is invented across time.",
    rubric:
      "Sweep the complete clip for flicker, popping, reappearance, crawling texture, morphing, warping, double edges, unstable intensity, broken occlusion, or invented objects and features. Approved changes must read as one continuous physical reality. A transient hallucination or source object appearing or disappearing outside authorization fails.",
    allowedCorrectionActions: [
      "stabilize-approved-edits",
      "remove-hallucination",
    ],
  },
  {
    id: "audio-integrity",
    name: "Source audio integrity",
    category: "audio",
    method: "deterministic",
    contract: "deterministic",
    concern: "audio-sync",
    hardGate: true,
    weight: 0.02,
    passThreshold: 100,
    borderlineThreshold: 100,
    description:
      "The finalized cut carries the aligned canonical source track or preserves source silence.",
    rubric:
      "Trusted code discards provider sound, remuxes the canonical source track or preserves source silence, and verifies presence and aligned duration. This row is never sent to a visual model and scores only 100 or 0.",
    allowedCorrectionActions: [],
  },
] as const satisfies readonly LampCombinedEvalRegistryEntry[];

export const LAMP_COMBINED_VISUAL_EVAL_DEFS =
  LAMP_COMBINED_EVAL_REGISTRY.filter(
    (definition) => definition.method === "holistic-judge"
  );

/** Stable provider-neutral JSON shape for the one holistic visual response. */
export const LAMP_COMBINED_HOLISTIC_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      minItems: LAMP_COMBINED_VISUAL_EVAL_IDS.length,
      maxItems: LAMP_COMBINED_VISUAL_EVAL_IDS.length,
      items: {
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
          evalId: { enum: LAMP_COMBINED_VISUAL_EVAL_IDS },
          score: { type: "number", minimum: 0, maximum: 100 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          violations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "aspect",
                "severity",
                "description",
                "correctionAction",
                "planItemIds",
              ],
              properties: {
                aspect: { type: "string", minLength: 1 },
                severity: { enum: ["critical", "major", "minor"] },
                description: { type: "string" },
                frameTimestampSec: { type: "number", minimum: 0 },
                correctionAction: {
                  anyOf: [
                    { enum: LAMP_COMBINED_CORRECTION_ACTIONS },
                    { type: "null" },
                  ],
                },
                planItemIds: {
                  type: "array",
                  uniqueItems: true,
                  items: { type: "string", minLength: 1 },
                },
              },
            },
          },
          reasoning: { type: "string" },
        },
      },
    },
  },
} as const;

export interface LampCombinedViolationCorrection {
  action: LampCombinedCorrectionAction;
  /** Exact ids from an enabled approved subplan; global restores use []. */
  planItemIds: string[];
}

export interface LampCombinedViolation {
  aspect: string;
  severity: ViolationSeverity;
  description: string;
  frameTimestampSec?: number;
  correction?: LampCombinedViolationCorrection;
}

export interface LampCombinedEvalResult {
  evalId: LampCombinedEvalId;
  iteration: LampCombinedIteration;
  score: number;
  confidence: number;
  verdict: Verdict;
  violations: LampCombinedViolation[];
  reasoning: string;
  deltaFromPrevious?: number;
}

export interface LampCombinedEvaluationArtifact {
  version: typeof LAMP_COMBINED_EVALUATOR_VERSION;
  planVersion: typeof LAMP_COMBINED_PLAN_VERSION;
  planId: string;
  planHash: string;
  iteration: LampCombinedIteration;
  evalResults: LampCombinedEvalResult[];
}

export interface LampCombinedHolisticEvaluationSchema {
  evaluatorVersion: typeof LAMP_COMBINED_EVALUATOR_VERSION;
  planVersion: typeof LAMP_COMBINED_PLAN_VERSION;
  planId: string;
  planHash: string;
  visualEvalIds: readonly LampCombinedVisualEvalId[];
  visualDefinitions: LampCombinedEvalDefinition[];
  resultSchema: typeof LAMP_COMBINED_HOLISTIC_RESULT_SCHEMA;
  deterministicChecks: Array<{
    definition: LampCombinedEvalDefinition;
    excludedFromVisualModelCall: true;
  }>;
}

export interface LampCombinedCompiledCorrection
  extends LampCombinedCorrectionCandidate {
  sourceEvalId: LampCombinedVisualEvalId;
  aspect: string;
  action: LampCombinedCorrectionAction;
  planItemIds: string[];
}

const SEVERITIES = ["critical", "major", "minor"] as const;
const SEVERITY_RANK: Record<ViolationSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function canonicalIteration(value: unknown): LampCombinedIteration {
  if (value !== 1 && value !== 2) {
    throw new Error("Lamp Combined evaluation iteration must be 1 or 2.");
  }
  return value;
}

function numberInRange(
  value: unknown,
  min: number,
  max: number,
  path: string
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  if (value < min || value > max) {
    throw new Error(`${path} must be between ${min} and ${max}.`);
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function canonicalPlanHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Lamp Combined evaluation planHash must be lowercase SHA-256.");
  }
  return value;
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

function approvedPlan(value: LampCombinedPlan): LampCombinedPlan {
  const plan = parseLampCombinedPlan(value);
  if (plan.approval.status !== "approved") {
    throw new Error(
      "Lamp Combined evaluation requires the human-approved aggregate plan."
    );
  }
  return plan;
}

function registryEntry(evalId: LampCombinedEvalId): LampCombinedEvalRegistryEntry {
  const definition = LAMP_COMBINED_EVAL_REGISTRY.find(
    (candidate) => candidate.id === evalId
  );
  if (!definition) {
    throw new Error(`Unknown Lamp Combined eval id "${evalId}".`);
  }
  return definition;
}

function isControlDisabled(
  entry: LampCombinedEvalRegistryEntry,
  plan: LampCombinedPlan
): entry is LampCombinedEvalRegistryEntry & {
  disabled: LampCombinedDisabledEvalContract;
} {
  if (!entry.disabled) return false;
  return entry.disabled.control === "beautify"
    ? plan.beautify.state === "disabled"
    : plan.iris.state === "disabled";
}

/** Resolve dynamic preservation contracts without changing registry ids. */
export function lampCombinedEvalDefinitions(
  value: LampCombinedPlan
): LampCombinedEvalDefinition[] {
  const plan = parseLampCombinedPlan(value);
  return LAMP_COMBINED_EVAL_REGISTRY.map((entry) => {
    if (isControlDisabled(entry, plan)) {
      return {
        id: entry.id,
        name: entry.name,
        category: entry.category,
        method: entry.method,
        contract: entry.disabled.contract,
        concern: entry.disabled.concern,
        hardGate: entry.disabled.hardGate,
        weight: entry.weight,
        passThreshold: entry.passThreshold,
        borderlineThreshold: entry.borderlineThreshold,
        description: entry.disabled.description,
        rubric: entry.disabled.rubric,
        allowedCorrectionActions: entry.disabled.allowedCorrectionActions,
        disabledControl: entry.disabled.control,
      };
    }
    return {
      id: entry.id,
      name: entry.name,
      category: entry.category,
      method: entry.method,
      contract: entry.contract,
      concern: entry.concern,
      hardGate: entry.hardGate,
      weight: entry.weight,
      passThreshold: entry.passThreshold,
      borderlineThreshold: entry.borderlineThreshold,
      description: entry.description,
      rubric: entry.rubric,
      allowedCorrectionActions: entry.allowedCorrectionActions,
    };
  });
}

function evalDefinition(
  plan: LampCombinedPlan,
  evalId: LampCombinedEvalId
): LampCombinedEvalDefinition {
  const definition = lampCombinedEvalDefinitions(plan).find(
    (candidate) => candidate.id === evalId
  );
  if (!definition) {
    throw new Error(`Unknown Lamp Combined eval id "${evalId}".`);
  }
  return definition;
}

function canonicalPlanItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((itemId) =>
        typeof itemId === "string" && itemId.trim().length > 0
          ? [itemId.trim()]
          : []
      )
    ),
  ].sort();
}

function allowedItemIdsForAction(
  plan: LampCombinedPlan,
  action: LampCombinedCorrectionAction
): Set<string> | null {
  switch (action) {
    case "complete-approved-background-removal":
      return new Set(plan.backgroundPlan.remove.map((item) => item.id));
    case "complete-approved-beautify":
    case "reduce-approved-beautify":
      return plan.beautify.state === "enabled"
        ? new Set(plan.beautify.plan.enhance.map((item) => item.id))
        : new Set();
    case "complete-approved-eye-contact":
    case "reduce-eye-contact-lock":
      return plan.iris.state === "enabled"
        ? new Set(plan.iris.plan.correct.map((item) => item.id))
        : new Set();
    default:
      return null;
  }
}

function correctionIsSafe(
  plan: LampCombinedPlan,
  definition: LampCombinedEvalDefinition,
  action: LampCombinedCorrectionAction,
  planItemIds: readonly string[]
): boolean {
  if (
    !definition.allowedCorrectionActions.includes(
      action as (typeof definition.allowedCorrectionActions)[number]
    )
  ) {
    return false;
  }
  const allowedIds = allowedItemIdsForAction(plan, action);
  if (allowedIds === null) return planItemIds.length === 0;
  return (
    planItemIds.length > 0 &&
    planItemIds.every((itemId) => allowedIds.has(itemId))
  );
}

function canonicalArtifactViolation(
  value: unknown,
  plan: LampCombinedPlan,
  definition: LampCombinedEvalDefinition,
  path: string
): LampCombinedViolation {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const severity = value.severity;
  if (!SEVERITIES.includes(severity as ViolationSeverity)) {
    throw new Error(`${path}.severity is invalid.`);
  }
  const violation: LampCombinedViolation = {
    aspect: requiredString(value.aspect, `${path}.aspect`),
    severity: severity as ViolationSeverity,
    description:
      typeof value.description === "string" ? value.description.trim() : "",
  };
  if (value.frameTimestampSec !== undefined) {
    violation.frameTimestampSec = numberInRange(
      value.frameTimestampSec,
      0,
      Number.MAX_SAFE_INTEGER,
      `${path}.frameTimestampSec`
    );
  }
  if (value.correction !== undefined) {
    if (!isRecord(value.correction)) {
      throw new Error(`${path}.correction must be an object when present.`);
    }
    const action = value.correction.action;
    if (
      !LAMP_COMBINED_CORRECTION_ACTIONS.includes(
        action as LampCombinedCorrectionAction
      )
    ) {
      throw new Error(`${path}.correction.action is invalid.`);
    }
    const planItemIds = canonicalPlanItemIds(value.correction.planItemIds);
    if (
      !correctionIsSafe(
        plan,
        definition,
        action as LampCombinedCorrectionAction,
        planItemIds
      )
    ) {
      throw new Error(`${path}.correction exceeds the approved plan scope.`);
    }
    violation.correction = {
      action: action as LampCombinedCorrectionAction,
      planItemIds,
    };
  }
  return violation;
}

function coerceModelViolation(
  value: unknown,
  plan: LampCombinedPlan,
  definition: LampCombinedEvalDefinition
): LampCombinedViolation | null {
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
  const violation: LampCombinedViolation = {
    aspect: value.aspect.trim(),
    severity,
    description:
      typeof value.description === "string" ? value.description.trim() : "",
    ...(typeof value.frameTimestampSec === "number" &&
    Number.isFinite(value.frameTimestampSec) &&
    value.frameTimestampSec >= 0
      ? { frameTimestampSec: value.frameTimestampSec }
      : {}),
  };
  const action = value.correctionAction;
  if (
    LAMP_COMBINED_CORRECTION_ACTIONS.includes(
      action as LampCombinedCorrectionAction
    )
  ) {
    const planItemIds = canonicalPlanItemIds(value.planItemIds);
    if (
      correctionIsSafe(
        plan,
        definition,
        action as LampCombinedCorrectionAction,
        planItemIds
      )
    ) {
      violation.correction = {
        action: action as LampCombinedCorrectionAction,
        planItemIds,
      };
    }
  }
  return violation;
}

function canonicalArtifactResult(
  value: unknown,
  plan: LampCombinedPlan,
  iteration: LampCombinedIteration,
  path: string
): LampCombinedEvalResult {
  if (
    !isRecord(value) ||
    typeof value.evalId !== "string" ||
    !LAMP_COMBINED_EVAL_IDS.includes(value.evalId as LampCombinedEvalId)
  ) {
    throw new Error(`${path}.evalId is invalid.`);
  }
  if (value.iteration !== iteration) {
    throw new Error(`${path}.iteration does not match its artifact.`);
  }
  const evalId = value.evalId as LampCombinedEvalId;
  const definition = evalDefinition(plan, evalId);
  const score = numberInRange(value.score, 0, 100, `${path}.score`);
  const confidence = numberInRange(
    value.confidence,
    0,
    1,
    `${path}.confidence`
  );
  const verdict = verdictFor(
    score,
    definition.passThreshold,
    definition.borderlineThreshold
  );
  if (value.verdict !== verdict) {
    throw new Error(`${path}.verdict does not match its score.`);
  }
  if (!Array.isArray(value.violations)) {
    throw new Error(`${path}.violations must be an array.`);
  }
  if (
    definition.method === "deterministic" &&
    (confidence !== 1 || (score !== 0 && score !== 100))
  ) {
    throw new Error(
      `${path} deterministic audio must have confidence 1 and score 0 or 100.`
    );
  }
  const result: LampCombinedEvalResult = {
    evalId,
    iteration,
    score,
    confidence,
    verdict,
    violations: value.violations.map((violation, index) =>
      canonicalArtifactViolation(
        violation,
        plan,
        definition,
        `${path}.violations[${index}]`
      )
    ),
    reasoning:
      typeof value.reasoning === "string" ? value.reasoning.trim() : "",
  };
  if (value.deltaFromPrevious !== undefined) {
    if (
      typeof value.deltaFromPrevious !== "number" ||
      !Number.isFinite(value.deltaFromPrevious)
    ) {
      throw new Error(`${path}.deltaFromPrevious must be finite.`);
    }
    result.deltaFromPrevious = value.deltaFromPrevious;
  }
  return result;
}

function parseArtifactWithExpectedHash(
  value: unknown,
  plan: LampCombinedPlan,
  expectedHash: string,
  expectedIteration?: LampCombinedIteration
): LampCombinedEvaluationArtifact {
  if (
    !isRecord(value) ||
    value.version !== LAMP_COMBINED_EVALUATOR_VERSION ||
    value.planVersion !== LAMP_COMBINED_PLAN_VERSION
  ) {
    throw new Error("Unknown Lamp Combined evaluation artifact version.");
  }
  if (value.planId !== plan.id) {
    throw new Error(
      "Lamp Combined evaluation artifact belongs to a different aggregate plan."
    );
  }
  const planHash = canonicalPlanHash(value.planHash);
  if (planHash !== expectedHash) {
    throw new Error(
      "Lamp Combined evaluation artifact hash does not match the approved aggregate plan."
    );
  }
  const iteration = canonicalIteration(value.iteration);
  if (expectedIteration !== undefined && iteration !== expectedIteration) {
    throw new Error(
      `Lamp Combined evaluation artifact must bind iteration ${expectedIteration}.`
    );
  }
  if (!Array.isArray(value.evalResults)) {
    throw new Error("Lamp Combined evaluation artifact results must be an array.");
  }
  const byId = new Map<LampCombinedEvalId, LampCombinedEvalResult>();
  for (let index = 0; index < value.evalResults.length; index += 1) {
    const result = canonicalArtifactResult(
      value.evalResults[index],
      plan,
      iteration,
      `evalResults[${index}]`
    );
    if (byId.has(result.evalId)) {
      throw new Error(
        `Lamp Combined evaluation artifact repeats ${result.evalId}.`
      );
    }
    byId.set(result.evalId, result);
  }
  const missing = LAMP_COMBINED_EVAL_IDS.filter((evalId) => !byId.has(evalId));
  if (missing.length > 0 || byId.size !== LAMP_COMBINED_EVAL_IDS.length) {
    throw new Error(
      `Lamp Combined evaluation artifact omitted required checks: ${
        missing.join(", ") || "unknown"
      }.`
    );
  }
  return {
    version: LAMP_COMBINED_EVALUATOR_VERSION,
    planVersion: LAMP_COMBINED_PLAN_VERSION,
    planId: plan.id,
    planHash,
    iteration,
    evalResults: LAMP_COMBINED_EVAL_IDS.map((evalId) => byId.get(evalId)!),
  };
}

/**
 * Re-validate persisted JSON and recompute the aggregate hash. An artifact
 * cannot be replayed against a same-id plan whose approved content changed.
 */
export async function parseLampCombinedEvaluationArtifact(
  value: unknown,
  binding: {
    plan: LampCombinedPlan;
    iteration?: LampCombinedIteration;
  }
): Promise<LampCombinedEvaluationArtifact> {
  const plan = approvedPlan(binding.plan);
  const expectedHash = await hashLampCombinedPlan(plan);
  return parseArtifactWithExpectedHash(
    value,
    plan,
    expectedHash,
    binding.iteration
  );
}

function coerceVisualResult(
  value: unknown,
  plan: LampCombinedPlan,
  iteration: LampCombinedIteration,
  previousResults: readonly LampCombinedEvalResult[]
): LampCombinedEvalResult | null {
  if (
    !isRecord(value) ||
    typeof value.evalId !== "string" ||
    !LAMP_COMBINED_VISUAL_EVAL_IDS.includes(
      value.evalId as LampCombinedVisualEvalId
    )
  ) {
    return null;
  }
  const rawScore =
    typeof value.score === "number" ? value.score : Number(value.score);
  const rawConfidence =
    typeof value.confidence === "number"
      ? value.confidence
      : Number(value.confidence);
  if (!Number.isFinite(rawScore) || !Number.isFinite(rawConfidence)) {
    return null;
  }
  const evalId = value.evalId as LampCombinedVisualEvalId;
  const definition = evalDefinition(plan, evalId);
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
          const canonical = coerceModelViolation(violation, plan, definition);
          return canonical ? [canonical] : [];
        })
      : [],
    reasoning:
      typeof value.reasoning === "string" ? value.reasoning.trim() : "",
    ...(previous ? { deltaFromPrevious: score - previous.score } : {}),
  };
}

function audioIntegrityResult(
  iteration: LampCombinedIteration,
  audioVerified: boolean,
  previousResults: readonly LampCombinedEvalResult[]
): LampCombinedEvalResult {
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
              "The finalized cut did not pass deterministic canonical source-audio verification.",
          },
        ],
    reasoning: audioVerified
      ? "Canonical source audio or source silence passed deterministic verification."
      : "Canonical source-audio verification failed; this iteration is ineligible for delivery.",
    ...(previous ? { deltaFromPrevious: score - previous.score } : {}),
  };
}

/**
 * Convert one holistic visual response into the plan-bound persisted artifact.
 * The response must contain every visual row exactly once and no audio row.
 */
export async function buildLampCombinedEvaluationArtifact(input: {
  raw: unknown;
  plan: LampCombinedPlan;
  iteration: LampCombinedIteration;
  audioVerified: boolean;
  previousArtifact?: LampCombinedEvaluationArtifact;
}): Promise<LampCombinedEvaluationArtifact> {
  const plan = approvedPlan(input.plan);
  const iteration = canonicalIteration(input.iteration);
  if (typeof input.audioVerified !== "boolean") {
    throw new Error("Lamp Combined deterministic audio result must be boolean.");
  }
  const planHash = await hashLampCombinedPlan(plan);
  let previousResults: LampCombinedEvalResult[] = [];
  if (input.previousArtifact !== undefined) {
    if (iteration !== 2) {
      throw new Error(
        "A previous Lamp Combined artifact is valid only when building iteration 2."
      );
    }
    previousResults = parseArtifactWithExpectedHash(
      input.previousArtifact,
      plan,
      planHash,
      1
    ).evalResults;
  }
  if (!isRecord(input.raw) || !Array.isArray(input.raw.results)) {
    throw new Error(
      "Lamp Combined holistic evaluator returned an invalid result envelope."
    );
  }
  const byId = new Map<LampCombinedVisualEvalId, LampCombinedEvalResult>();
  for (const rawResult of input.raw.results) {
    if (!isRecord(rawResult) || typeof rawResult.evalId !== "string") {
      throw new Error(
        "Lamp Combined holistic evaluator returned an invalid result row."
      );
    }
    if (
      !LAMP_COMBINED_VISUAL_EVAL_IDS.includes(
        rawResult.evalId as LampCombinedVisualEvalId
      )
    ) {
      throw new Error(
        `Lamp Combined holistic evaluator returned unexpected check "${rawResult.evalId}".`
      );
    }
    const evalId = rawResult.evalId as LampCombinedVisualEvalId;
    if (byId.has(evalId)) {
      throw new Error(
        `Lamp Combined holistic evaluator returned duplicate result ${evalId}.`
      );
    }
    const result = coerceVisualResult(
      rawResult,
      plan,
      iteration,
      previousResults
    );
    if (!result) {
      throw new Error(
        `Lamp Combined holistic evaluator returned invalid result ${evalId}.`
      );
    }
    byId.set(evalId, result);
  }
  const missing = LAMP_COMBINED_VISUAL_EVAL_IDS.filter(
    (evalId) => !byId.has(evalId)
  );
  if (missing.length > 0) {
    throw new Error(
      `Lamp Combined holistic evaluator omitted required checks: ${missing.join(
        ", "
      )}.`
    );
  }
  return parseArtifactWithExpectedHash(
    {
      version: LAMP_COMBINED_EVALUATOR_VERSION,
      planVersion: LAMP_COMBINED_PLAN_VERSION,
      planId: plan.id,
      planHash,
      iteration,
      evalResults: [
        ...LAMP_COMBINED_VISUAL_EVAL_IDS.map((evalId) => byId.get(evalId)!),
        audioIntegrityResult(iteration, input.audioVerified, previousResults),
      ],
    },
    plan,
    planHash,
    iteration
  );
}

/**
 * Build the adapter-facing schema. It contains no provider identifier or
 * billing data, and it makes the deterministic audio exclusion explicit.
 */
export async function buildLampCombinedHolisticEvaluationSchema(
  value: LampCombinedPlan
): Promise<LampCombinedHolisticEvaluationSchema> {
  const plan = approvedPlan(value);
  const planHash = await hashLampCombinedPlan(plan);
  const definitions = lampCombinedEvalDefinitions(plan);
  return {
    evaluatorVersion: LAMP_COMBINED_EVALUATOR_VERSION,
    planVersion: LAMP_COMBINED_PLAN_VERSION,
    planId: plan.id,
    planHash,
    visualEvalIds: LAMP_COMBINED_VISUAL_EVAL_IDS,
    visualDefinitions: definitions.filter(
      (definition) => definition.method === "holistic-judge"
    ),
    resultSchema: LAMP_COMBINED_HOLISTIC_RESULT_SCHEMA,
    deterministicChecks: definitions
      .filter((definition) => definition.method === "deterministic")
      .map((definition) => ({
        definition,
        excludedFromVisualModelCall: true as const,
      })),
  };
}

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "finding"
  );
}

function correctionInstruction(
  action: LampCombinedCorrectionAction,
  planItemIds: readonly string[]
): string {
  const ids = planItemIds.join(", ");
  switch (action) {
    case "restore-source-identity":
      return "Restore every visible person's source identity, facial geometry, distinctive features, and apparent age at every corresponding moment.";
    case "restore-people-appearance":
      return "Restore all people, hair, clothing, accessories, held objects, and protected appearance regions to the source; retain only explicitly approved primary-subject enhancements.";
    case "restore-motion-lipsync":
      return "Restore the source performance timeline exactly, including gestures, head pose, blinks, mouth shapes, speech articulation, and lip sync.";
    case "restore-camera-framing":
      return "Restore the source crop, scale, perspective, focus, depth of field, lens character, and static camera behavior.";
    case "complete-approved-background-removal":
      return `Complete only the human-approved background removal targets [${ids}] inside their existing approved footprints; do not add targets or redecorate.`;
    case "restore-protected-background":
      return "Restore every background area outside the exact human-approved removal footprints to the source, including preserve, uncertain, and unlisted content.";
    case "match-lighting-target":
      return "Match the existing run-bound lighting directive more faithfully while preserving source geometry, content identity, camera, and plausible physical light behavior.";
    case "complete-approved-beautify":
      return `Complete only the human-approved Beautify items [${ids}] at their already approved shared control level; do not add enhancement categories.`;
    case "reduce-approved-beautify":
      return `Reduce only the human-approved Beautify items [${ids}] back to their already approved shared control level while preserving identity and natural texture.`;
    case "restore-disabled-beautify":
      return "Beautify is disabled: remove every appearance enhancement and restore expression, skin, eyes, hair, permanent features, and apparent age to the source.";
    case "complete-approved-eye-contact":
      return `Complete only the human-approved eye-contact items [${ids}] at fixed Presenter intensity 2 while preserving source blinks, eye identity, head pose, and speech.`;
    case "reduce-eye-contact-lock":
      return `Reduce only the human-approved eye-contact items [${ids}] to natural Presenter intensity 2, restoring source blinks and living micro-breaks without returning to the reading anchor.`;
    case "restore-disabled-eye-region":
      return "Eye contact is disabled: restore the complete source gaze trajectory, blinks, eyelid motion, eye geometry, iris and sclera appearance, and catchlights.";
    case "contain-region-leakage":
      return "Contain every edit to its already authorized region: cleanup footprints, approved primary-subject Beautify regions, the immediate eye region, or lighting response only.";
    case "stabilize-approved-edits":
      return "Stabilize only the already approved edits across the complete timeline without changing their scope, target set, intensity, or surrounding source content.";
    case "remove-hallucination":
      return "Remove invented objects, features, textures, and events and restore the corresponding source content without introducing any new edit target.";
  }
}

/**
 * Compile the pass-two ledger from iteration 1 only. Model prose is retained
 * as evidence in the artifact but never copied into generation instructions.
 * Closed actions and exact approved item ids produce every instruction.
 */
export async function collectLampCombinedCorrections(
  artifact: LampCombinedEvaluationArtifact,
  value: LampCombinedPlan
): Promise<LampCombinedCompiledCorrection[]> {
  const plan = approvedPlan(value);
  const canonical = await parseLampCombinedEvaluationArtifact(artifact, {
    plan,
    iteration: 1,
  });
  const definitions = new Map(
    lampCombinedEvalDefinitions(plan).map((definition) => [
      definition.id,
      definition,
    ])
  );
  const candidates: LampCombinedCompiledCorrection[] = [];
  for (const result of canonical.evalResults) {
    if (result.evalId === "audio-integrity") continue;
    const definition = definitions.get(result.evalId)!;
    for (const violation of result.violations) {
      if (!violation.correction) continue;
      const { action, planItemIds } = violation.correction;
      if (!correctionIsSafe(plan, definition, action, planItemIds)) continue;
      candidates.push({
        id: [
          "lamp-combined-corr",
          action,
          planItemIds.join("+") || "global",
          slug(violation.aspect),
        ].join(":"),
        concern: definition.concern,
        severity: violation.severity,
        hardGate: definition.hardGate,
        instruction: correctionInstruction(action, planItemIds),
        sourceEvalId: result.evalId,
        aspect: violation.aspect,
        action,
        planItemIds: [...planItemIds],
      });
    }
  }

  const strongestByScope = new Map<string, LampCombinedCompiledCorrection>();
  for (const candidate of candidates) {
    const scopeKey = `${candidate.action}:${candidate.planItemIds.join("+")}`;
    const existing = strongestByScope.get(scopeKey);
    if (
      !existing ||
      (candidate.hardGate && !existing.hardGate) ||
      (candidate.hardGate === existing.hardGate &&
        SEVERITY_RANK[candidate.severity] < SEVERITY_RANK[existing.severity])
    ) {
      strongestByScope.set(scopeKey, candidate);
    }
  }
  const deduped = [...strongestByScope.values()];
  const byId = new Map(deduped.map((candidate) => [candidate.id, candidate]));
  const selected = selectLampCombinedCorrections(deduped, plan.controls);
  const compiled = selected.map((candidate) => byId.get(candidate.id)!);
  if (compiled.length > LAMP_COMBINED_MAX_CORRECTIONS) {
    throw new Error("Lamp Combined correction selection exceeded its hard cap.");
  }
  return compiled;
}

