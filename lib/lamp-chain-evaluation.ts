/**
 * Provider-free evaluation contracts for Lamp Chain — Combined Version 2.
 *
 * Chain evaluation is DETACHED measurement: it never steers a correction pass
 * and never gates delivery. After the chain settles, one holistic visual call
 * per completed stage judges that stage's output against the ORIGINAL clip.
 *
 * The registry is Combined's registry — same eval ids, weights, and
 * thresholds — so a chain's final-stage artifact is rubric-identical to a
 * Combined run's holistic eval and the two products can be compared directly.
 * The one chain-specific rule: a concern that is enabled but has NOT yet
 * executed at this stage judges as a hard preservation gate ("pending"). A
 * pending-gate failure is eager leakage — a stage doing a later stage's job —
 * which is one of the compounding-noise mechanisms this experiment measures.
 */

import {
  lampChainConcernsAfterStage,
  parseLampChainPlan,
  hashLampChainPlan,
  LAMP_CHAIN_PLAN_VERSION,
  LAMP_CHAIN_MAX_STAGES,
  type LampChainPlan,
} from "./lamp-chain.ts";
import {
  lampCombinedEvalDefinitions,
  LAMP_COMBINED_EVAL_IDS,
  LAMP_COMBINED_EVAL_REGISTRY,
  LAMP_COMBINED_HOLISTIC_RESULT_SCHEMA,
  LAMP_COMBINED_VISUAL_EVAL_IDS,
  type LampCombinedEvalDefinition,
  type LampCombinedEvalId,
  type LampCombinedVisualEvalId,
} from "./lamp-combined-evaluation.ts";
import type { LampCombinedEditConcern } from "./lamp-combined.ts";
import type {
  GeminiProUsageSnapshot,
  Verdict,
  ViolationSeverity,
} from "./types.ts";

export const LAMP_CHAIN_EVALUATOR_VERSION = "lamp-chain-holistic-v1" as const;

/** Identical id set to Combined by design — see module doc. */
export const LAMP_CHAIN_EVAL_IDS = LAMP_COMBINED_EVAL_IDS;
export type LampChainEvalId = LampCombinedEvalId;
export const LAMP_CHAIN_VISUAL_EVAL_IDS = LAMP_COMBINED_VISUAL_EVAL_IDS;
export type LampChainVisualEvalId = LampCombinedVisualEvalId;

/** The judge response schema is Combined's; correction fields are ignored on ingest. */
export const LAMP_CHAIN_HOLISTIC_RESULT_SCHEMA =
  LAMP_COMBINED_HOLISTIC_RESULT_SCHEMA;

const PENDING_CONTRACTS: Partial<
  Record<
    LampCombinedEvalId,
    { description: string; rubric: string }
  >
> = {
  "background-cleanliness": {
    description:
      "Background cleanup has not executed yet at this stage; the room must still read as source.",
    rubric:
      "Background cleanup is scheduled for a LATER stage of this chain and must not have started. Compare the full room inventory to the source: every object, surface, and decor item — including the approved future removal targets — must still be present and source-faithful. Any removal, tidying, or redesign at this stage is an unauthorized early edit and fails this preservation gate.",
  },
  "lighting-target": {
    description:
      "Relighting has not executed yet at this stage; illumination must still read as source.",
    rubric:
      "Relighting is scheduled for a LATER stage of this chain and must not have started. Compare overall exposure, light direction, shadow placement, and color temperature to the source at corresponding moments. Small re-render variation is tolerable; any deliberate lift, added light source, dramatic grade, or relight-like change at this stage is an unauthorized early edit and fails this preservation gate.",
  },
  "beautify-target": {
    description:
      "Beautify has not executed yet at this stage; the subject's appearance must still read as source.",
    rubric:
      "Beautify is enabled for a LATER stage of this chain and must not have started. Compare skin texture and tone, under-eyes, teeth, eyes, and grooming to the source. Any smoothing, brightening, or enhancement at this stage is an unauthorized early edit and fails this preservation gate.",
  },
  "eye-contact": {
    description:
      "Eye contact has not executed yet at this stage; gaze behavior must still match the source.",
    rubric:
      "Eye-contact correction is enabled for a LATER stage of this chain and must not have started. Preserve the source gaze trajectory, blinks, eyelid motion, and eye appearance at corresponding moments. Any gaze redirection or synthetic contact at this stage is an unauthorized early edit and fails this preservation gate.",
  },
};

const CONCERN_BY_EVAL_ID: Partial<
  Record<LampCombinedEvalId, LampCombinedEditConcern>
> = {
  "background-cleanliness": "background",
  "lighting-target": "lighting",
  "beautify-target": "beautify",
  "eye-contact": "iris",
};

function canonicalStage(value: unknown, stageCount: number): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > stageCount ||
    stageCount > LAMP_CHAIN_MAX_STAGES
  ) {
    throw new Error(
      `Lamp Chain evaluation stage must be 1 through ${stageCount}.`
    );
  }
  return value as number;
}

/**
 * Per-stage definitions: Combined's dynamic registry (control-off concerns are
 * already preservation gates there), with enabled-but-not-yet-executed target
 * concerns re-contracted as pending preservation hard gates.
 */
export function lampChainEvalDefinitions(
  plan: LampChainPlan,
  stage: number
): LampCombinedEvalDefinition[] {
  const canonical = parseLampChainPlan(plan);
  canonicalStage(stage, canonical.stageOrder.length);
  const completed = new Set(
    lampChainConcernsAfterStage(canonical.stageOrder, stage - 1)
  );
  return lampCombinedEvalDefinitions(canonical.aggregate).map((definition) => {
    if (definition.contract !== "target") return definition;
    const concern = CONCERN_BY_EVAL_ID[definition.id];
    if (!concern || completed.has(concern)) return definition;
    const pending = PENDING_CONTRACTS[definition.id];
    if (!pending) return definition;
    return {
      ...definition,
      contract: "preservation" as const,
      concern: "preservation" as const,
      hardGate: true,
      description: pending.description,
      rubric: pending.rubric,
      allowedCorrectionActions: [],
    };
  });
}

/**
 * Detached measurement result. No corrections: there is no pass to steer.
 * `stage` replaces Combined's iteration and matches the generation iteration.
 */
export interface LampChainViolation {
  aspect: string;
  severity: ViolationSeverity;
  description: string;
  frameTimestampSec?: number;
}

export interface LampChainEvalResult {
  evalId: LampChainEvalId;
  stage: number;
  score: number;
  confidence: number;
  verdict: Verdict;
  violations: LampChainViolation[];
  reasoning: string;
  /** Score movement vs the previous stage's artifact — the drift trajectory. */
  deltaFromPrevious?: number;
}

export interface LampChainEvaluationArtifact {
  version: typeof LAMP_CHAIN_EVALUATOR_VERSION;
  planVersion: typeof LAMP_CHAIN_PLAN_VERSION;
  planId: string;
  /** The CHAIN plan hash — order-bearing, unlike the embedded aggregate hash. */
  planHash: string;
  stage: number;
  stageCount: number;
  /** Concerns the chain had executed when this stage's output was produced. */
  completedConcerns: LampCombinedEditConcern[];
  evalResults: LampChainEvalResult[];
  usage: GeminiProUsageSnapshot;
  costUsd: number;
}

const SEVERITIES = ["critical", "major", "minor"] as const;

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

function approvedChainPlan(value: LampChainPlan): LampChainPlan {
  const plan = parseLampChainPlan(value);
  if (plan.aggregate.approval.status !== "approved") {
    throw new Error("Lamp Chain evaluation requires the human-approved plan.");
  }
  return plan;
}

function definitionFor(
  definitions: readonly LampCombinedEvalDefinition[],
  evalId: LampChainEvalId
): LampCombinedEvalDefinition {
  const definition = definitions.find((candidate) => candidate.id === evalId);
  if (!definition) {
    throw new Error(`Unknown Lamp Chain eval id "${evalId}".`);
  }
  return definition;
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

function coerceViolation(value: unknown): LampChainViolation | null {
  if (
    !isRecord(value) ||
    typeof value.aspect !== "string" ||
    value.aspect.trim().length === 0
  ) {
    return null;
  }
  return {
    aspect: value.aspect.trim(),
    severity: SEVERITIES.includes(value.severity as ViolationSeverity)
      ? (value.severity as ViolationSeverity)
      : "major",
    description:
      typeof value.description === "string" ? value.description.trim() : "",
    ...(typeof value.frameTimestampSec === "number" &&
    Number.isFinite(value.frameTimestampSec) &&
    value.frameTimestampSec >= 0
      ? { frameTimestampSec: value.frameTimestampSec }
      : {}),
  };
}

function audioIntegrityResult(
  stage: number,
  audioVerified: boolean,
  previousResults: readonly LampChainEvalResult[]
): LampChainEvalResult {
  const score = audioVerified ? 100 : 0;
  const previous = previousResults.find(
    (result) => result.evalId === "audio-integrity"
  );
  return {
    evalId: "audio-integrity",
    stage,
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
              "This stage's finalized cut did not pass deterministic canonical source-audio verification.",
          },
        ],
    reasoning: audioVerified
      ? "Canonical source audio or source silence passed deterministic verification for this stage."
      : "Canonical source-audio verification failed for this stage.",
    ...(previous ? { deltaFromPrevious: score - previous.score } : {}),
  };
}

/**
 * Convert one holistic visual response for stage N into the chain-hash-bound
 * persisted artifact. Correction fields in the raw response are ignored.
 */
export async function buildLampChainEvaluationArtifact(input: {
  raw: unknown;
  plan: LampChainPlan;
  stage: number;
  audioVerified: boolean;
  previousArtifact?: LampChainEvaluationArtifact;
  usage?: GeminiProUsageSnapshot;
  costUsd?: number;
}): Promise<LampChainEvaluationArtifact> {
  const plan = approvedChainPlan(input.plan);
  const stageCount = plan.stageOrder.length;
  const stage = canonicalStage(input.stage, stageCount);
  if (typeof input.audioVerified !== "boolean") {
    throw new Error("Lamp Chain deterministic audio result must be boolean.");
  }
  const previousResults = input.previousArtifact?.evalResults ?? [];
  if (input.previousArtifact && input.previousArtifact.stage !== stage - 1) {
    throw new Error(
      "Lamp Chain evaluation previousArtifact must be the immediately prior stage."
    );
  }
  const definitions = lampChainEvalDefinitions(plan, stage);
  if (!isRecord(input.raw) || !Array.isArray(input.raw.results)) {
    throw new Error("Lamp Chain holistic response must carry a results array.");
  }
  const byId = new Map<LampChainEvalId, LampChainEvalResult>();
  for (const value of input.raw.results) {
    if (
      !isRecord(value) ||
      typeof value.evalId !== "string" ||
      !LAMP_CHAIN_VISUAL_EVAL_IDS.includes(
        value.evalId as LampChainVisualEvalId
      )
    ) {
      continue;
    }
    const evalId = value.evalId as LampChainVisualEvalId;
    if (byId.has(evalId)) {
      throw new Error(`Lamp Chain holistic response repeats ${evalId}.`);
    }
    const rawScore =
      typeof value.score === "number" ? value.score : Number(value.score);
    const rawConfidence =
      typeof value.confidence === "number"
        ? value.confidence
        : Number(value.confidence);
    if (!Number.isFinite(rawScore) || !Number.isFinite(rawConfidence)) {
      continue;
    }
    const definition = definitionFor(definitions, evalId);
    const score = clamp(rawScore, 0, 100);
    const previous = previousResults.find(
      (result) => result.evalId === evalId
    );
    byId.set(evalId, {
      evalId,
      stage,
      score,
      confidence: clamp(rawConfidence, 0, 1),
      verdict: verdictFor(
        score,
        definition.passThreshold,
        definition.borderlineThreshold
      ),
      violations: Array.isArray(value.violations)
        ? value.violations.flatMap((violation) => {
            const canonical = coerceViolation(violation);
            return canonical ? [canonical] : [];
          })
        : [],
      reasoning:
        typeof value.reasoning === "string" ? value.reasoning.trim() : "",
      ...(previous ? { deltaFromPrevious: score - previous.score } : {}),
    });
  }
  const missing = LAMP_CHAIN_VISUAL_EVAL_IDS.filter(
    (evalId) => !byId.has(evalId)
  );
  if (missing.length > 0) {
    throw new Error(
      `Lamp Chain holistic response omitted required checks: ${missing.join(", ")}.`
    );
  }
  byId.set(
    "audio-integrity",
    audioIntegrityResult(stage, input.audioVerified, previousResults)
  );
  const usage = input.usage ?? { promptTokenCount: 0, candidatesTokenCount: 0 };
  if (!usageIsValid(usage)) {
    throw new Error("Lamp Chain evaluation usage snapshot is invalid.");
  }
  const costUsd = input.costUsd ?? 0;
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error("Lamp Chain evaluation cost must be non-negative.");
  }
  return {
    version: LAMP_CHAIN_EVALUATOR_VERSION,
    planVersion: LAMP_CHAIN_PLAN_VERSION,
    planId: plan.aggregate.id,
    planHash: await hashLampChainPlan(plan),
    stage,
    stageCount,
    completedConcerns: lampChainConcernsAfterStage(plan.stageOrder, stage - 1),
    evalResults: LAMP_CHAIN_EVAL_IDS.map((evalId) => byId.get(evalId)!),
    usage,
    costUsd,
  };
}

/**
 * Re-validate persisted JSON and recompute the order-bearing chain hash. An
 * artifact cannot be replayed against a reordered or edited plan.
 */
export async function parseLampChainEvaluationArtifact(
  value: unknown,
  binding: { plan: LampChainPlan; stage?: number }
): Promise<LampChainEvaluationArtifact> {
  const plan = approvedChainPlan(binding.plan);
  const stageCount = plan.stageOrder.length;
  if (
    !isRecord(value) ||
    value.version !== LAMP_CHAIN_EVALUATOR_VERSION ||
    value.planVersion !== LAMP_CHAIN_PLAN_VERSION
  ) {
    throw new Error("Unknown Lamp Chain evaluation artifact version.");
  }
  if (value.planId !== plan.aggregate.id) {
    throw new Error(
      "Lamp Chain evaluation artifact belongs to a different plan."
    );
  }
  const expectedHash = await hashLampChainPlan(plan);
  if (value.planHash !== expectedHash) {
    throw new Error(
      "Lamp Chain evaluation artifact hash does not match the approved chain plan."
    );
  }
  const stage = canonicalStage(value.stage, stageCount);
  if (binding.stage !== undefined && stage !== binding.stage) {
    throw new Error(
      `Lamp Chain evaluation artifact must bind stage ${binding.stage}.`
    );
  }
  if (value.stageCount !== stageCount) {
    throw new Error(
      "Lamp Chain evaluation artifact stage count does not match the plan."
    );
  }
  if (!Array.isArray(value.evalResults)) {
    throw new Error("Lamp Chain evaluation artifact results must be an array.");
  }
  if (!usageIsValid(value.usage)) {
    throw new Error("Lamp Chain evaluation usage snapshot is invalid.");
  }
  if (
    typeof value.costUsd !== "number" ||
    !Number.isFinite(value.costUsd) ||
    value.costUsd < 0
  ) {
    throw new Error("Lamp Chain evaluation cost must be non-negative.");
  }
  const definitions = lampChainEvalDefinitions(plan, stage);
  const expectedConcerns = lampChainConcernsAfterStage(
    plan.stageOrder,
    stage - 1
  );
  if (
    !Array.isArray(value.completedConcerns) ||
    value.completedConcerns.length !== expectedConcerns.length ||
    value.completedConcerns.some(
      (concern, index) => concern !== expectedConcerns[index]
    )
  ) {
    throw new Error(
      "Lamp Chain evaluation artifact concerns do not match the stage order."
    );
  }
  const byId = new Map<LampChainEvalId, LampChainEvalResult>();
  for (const [index, raw] of value.evalResults.entries()) {
    if (
      !isRecord(raw) ||
      typeof raw.evalId !== "string" ||
      !LAMP_CHAIN_EVAL_IDS.includes(raw.evalId as LampChainEvalId)
    ) {
      throw new Error(`evalResults[${index}].evalId is invalid.`);
    }
    const evalId = raw.evalId as LampChainEvalId;
    if (byId.has(evalId)) {
      throw new Error(`Lamp Chain evaluation artifact repeats ${evalId}.`);
    }
    if (raw.stage !== stage) {
      throw new Error(`evalResults[${index}].stage does not match its artifact.`);
    }
    if (
      typeof raw.score !== "number" ||
      !Number.isFinite(raw.score) ||
      raw.score < 0 ||
      raw.score > 100
    ) {
      throw new Error(`evalResults[${index}].score is invalid.`);
    }
    if (
      typeof raw.confidence !== "number" ||
      !Number.isFinite(raw.confidence) ||
      raw.confidence < 0 ||
      raw.confidence > 1
    ) {
      throw new Error(`evalResults[${index}].confidence is invalid.`);
    }
    const definition = definitionFor(definitions, evalId);
    const verdict = verdictFor(
      raw.score,
      definition.passThreshold,
      definition.borderlineThreshold
    );
    if (raw.verdict !== verdict) {
      throw new Error(`evalResults[${index}].verdict does not match its score.`);
    }
    if (
      definition.method === "deterministic" &&
      (raw.confidence !== 1 || (raw.score !== 0 && raw.score !== 100))
    ) {
      throw new Error(
        `evalResults[${index}] deterministic audio must have confidence 1 and score 0 or 100.`
      );
    }
    if (!Array.isArray(raw.violations)) {
      throw new Error(`evalResults[${index}].violations must be an array.`);
    }
    const violations = raw.violations.map((violation, vIndex) => {
      const canonical = coerceViolation(violation);
      if (!canonical) {
        throw new Error(
          `evalResults[${index}].violations[${vIndex}] is invalid.`
        );
      }
      return canonical;
    });
    const result: LampChainEvalResult = {
      evalId,
      stage,
      score: raw.score,
      confidence: raw.confidence,
      verdict,
      violations,
      reasoning:
        typeof raw.reasoning === "string" ? raw.reasoning.trim() : "",
    };
    if (raw.deltaFromPrevious !== undefined) {
      if (
        typeof raw.deltaFromPrevious !== "number" ||
        !Number.isFinite(raw.deltaFromPrevious)
      ) {
        throw new Error(`evalResults[${index}].deltaFromPrevious must be finite.`);
      }
      result.deltaFromPrevious = raw.deltaFromPrevious;
    }
    byId.set(evalId, result);
  }
  const missing = LAMP_CHAIN_EVAL_IDS.filter((evalId) => !byId.has(evalId));
  if (missing.length > 0 || byId.size !== LAMP_CHAIN_EVAL_IDS.length) {
    throw new Error(
      `Lamp Chain evaluation artifact omitted required checks: ${
        missing.join(", ") || "unknown"
      }.`
    );
  }
  return {
    version: LAMP_CHAIN_EVALUATOR_VERSION,
    planVersion: LAMP_CHAIN_PLAN_VERSION,
    planId: plan.aggregate.id,
    planHash: expectedHash,
    stage,
    stageCount,
    completedConcerns: expectedConcerns,
    evalResults: LAMP_CHAIN_EVAL_IDS.map((evalId) => byId.get(evalId)!),
    usage: value.usage,
    costUsd: value.costUsd,
  };
}

const WEIGHT_BY_ID = Object.fromEntries(
  LAMP_COMBINED_EVAL_REGISTRY.map((entry) => [entry.id, entry.weight])
) as Record<LampChainEvalId, number>;

const HARD_GATE_BY_ID = Object.fromEntries(
  LAMP_COMBINED_EVAL_REGISTRY.map((entry) => [entry.id, entry.hardGate])
) as Record<LampChainEvalId, boolean>;

/**
 * Registry-weighted composite for one stage artifact (report-card metric).
 * Weights come from the shared Combined registry — the ids are identical.
 */
export function lampChainStageComposite(
  artifact: LampChainEvaluationArtifact
): { composite: number; hardGateFailures: LampChainEvalId[] } {
  let composite = 0;
  const hardGateFailures: LampChainEvalId[] = [];
  for (const result of artifact.evalResults) {
    composite += (WEIGHT_BY_ID[result.evalId] ?? 0) * result.score;
    if (result.verdict === "fail" && HARD_GATE_BY_ID[result.evalId]) {
      hardGateFailures.push(result.evalId);
    }
  }
  return { composite: Math.round(composite * 10) / 10, hardGateFailures };
}
