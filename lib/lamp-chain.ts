/**
 * Pure domain contracts for Lamp Chain — Combined Version 2.
 *
 * Chain is the sequential-execution experiment: the original clip enters the
 * pipeline exactly once, each enabled concern runs as its own single-pass
 * generation, and every stage after the first conditions on the previous
 * stage's audio-remuxed output instead of the source. This deliberately
 * suspends the regenerate-from-original law for measurement purposes; every
 * other structural law (original audio authority, frozen prompts, exact paid
 * journals, one aggregate human approval) still binds.
 *
 * Evaluation is fully detached: delivery settles on generation + audio proof
 * alone, and the per-stage evaluation trail attaches to the run afterwards.
 */

import {
  approveLampCombinedPlan,
  buildLampCombinedPlan,
  lampCombinedBackgroundExecutionScope,
  lampCombinedRequiredPlanners,
  parseLampCombinedControls,
  parseLampCombinedPlan,
  parseLampCombinedRelightIntensity,
  hashLampCombinedPlan,
  type LampCombinedControls,
  type LampCombinedEditConcern,
  type LampCombinedPlan,
  type LampCombinedPlannerConcern,
} from "./lamp-combined.ts";

export const LAMP_CHAIN_LABEL = "Chain" as const;
export const LAMP_CHAIN_PLAN_VERSION = "lamp-chain-plan-v1" as const;
/** Iris strength inside a chain stays pinned to Presenter, matching Combined. */
export const LAMP_CHAIN_PRESENTER_INTENSITY = 2 as const;
export const LAMP_CHAIN_MAX_STAGES = 4 as const;
export const LAMP_CHAIN_MIN_STAGES = 2 as const;

export type LampChainStage = "background" | "lamp" | "beautify" | "iris";

/**
 * Scene → light → face → eyes. Global transforms run while the input is still
 * closest to source pixels; the perceptually fragile signals (skin texture,
 * eye geometry) pass through the fewest downstream re-renders.
 */
export const LAMP_CHAIN_DEFAULT_STAGE_ORDER = [
  "background",
  "lamp",
  "beautify",
  "iris",
] as const satisfies readonly LampChainStage[];

/** Chain controls are the Combined triple plus the execution order. */
export interface LampChainControls extends LampCombinedControls {
  stageOrder: LampChainStage[];
}

export type LampChainPlanApproval =
  | { status: "draft" }
  | { status: "approved"; approvedAt: number; approvedBy: "human" };

/**
 * The chain plan is a thin, order-bearing wrapper around the Combined
 * aggregate. Reusing the aggregate wholesale keeps every subplan invariant
 * (draft coherence, shared approval instant, intensity binding) identical to
 * Combined, so the chain experiment varies execution shape and nothing else.
 */
export interface LampChainPlan {
  version: typeof LAMP_CHAIN_PLAN_VERSION;
  stageOrder: LampChainStage[];
  aggregate: LampCombinedPlan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALL_STAGES: readonly LampChainStage[] = LAMP_CHAIN_DEFAULT_STAGE_ORDER;

function isLampChainStage(value: unknown): value is LampChainStage {
  return (
    value === "background" ||
    value === "lamp" ||
    value === "beautify" ||
    value === "iris"
  );
}

/**
 * The stage set is derived from the Combined triple: background and lamp are
 * always part of the product; beautify and iris join when their controls are
 * on. Returned in default order — this is a set, order comes from stageOrder.
 */
export function lampChainEnabledStages(
  controls: LampCombinedControls
): LampChainStage[] {
  const canonical = parseLampCombinedControls(controls);
  return ALL_STAGES.filter((stage) => {
    if (stage === "beautify") return canonical.beautifyLevel !== 0;
    if (stage === "iris") return canonical.eyeContact;
    return true;
  });
}

export function defaultLampChainStageOrder(
  controls: LampCombinedControls
): LampChainStage[] {
  return lampChainEnabledStages(controls);
}

export function parseLampChainStageOrder(
  value: unknown,
  controls: LampCombinedControls
): LampChainStage[] {
  if (!Array.isArray(value)) {
    throw new Error("Lamp Chain stage order must be an array of stages.");
  }
  const order = value.map((stage, index) => {
    if (!isLampChainStage(stage)) {
      throw new Error(`Lamp Chain stage order entry ${index} is not a stage.`);
    }
    return stage;
  });
  const enabled = lampChainEnabledStages(controls);
  if (order.length !== enabled.length) {
    throw new Error(
      "Lamp Chain stage order must list every enabled stage exactly once."
    );
  }
  const seen = new Set<LampChainStage>();
  for (const stage of order) {
    if (seen.has(stage)) {
      throw new Error(`Lamp Chain stage order repeats "${stage}".`);
    }
    if (!enabled.includes(stage)) {
      throw new Error(
        `Lamp Chain stage "${stage}" is not enabled by the current controls.`
      );
    }
    seen.add(stage);
  }
  if (order.length < LAMP_CHAIN_MIN_STAGES || order.length > LAMP_CHAIN_MAX_STAGES) {
    throw new Error(
      `Lamp Chain must run between ${LAMP_CHAIN_MIN_STAGES} and ${LAMP_CHAIN_MAX_STAGES} stages.`
    );
  }
  return order;
}

export function parseLampChainControls(value: unknown): LampChainControls {
  if (!isRecord(value)) {
    throw new Error("Lamp Chain controls must be an object.");
  }
  const combined = parseLampCombinedControls({
    beautifyLevel: value.beautifyLevel,
    cleanlinessLevel: value.cleanlinessLevel,
    eyeContact: value.eyeContact,
  });
  return {
    ...combined,
    stageOrder: parseLampChainStageOrder(value.stageOrder, combined),
  };
}

export function lampChainCombinedControls(
  controls: LampChainControls
): LampCombinedControls {
  const canonical = parseLampChainControls(controls);
  return {
    beautifyLevel: canonical.beautifyLevel,
    cleanlinessLevel: canonical.cleanlinessLevel,
    eyeContact: canonical.eyeContact,
  };
}

/** Chain reuses Combined's planner set: background always, face concerns opt-in. */
export function lampChainRequiredPlanners(
  controls: LampChainControls | LampCombinedControls
): LampCombinedPlannerConcern[] {
  return lampCombinedRequiredPlanners({
    beautifyLevel: controls.beautifyLevel,
    cleanlinessLevel: controls.cleanlinessLevel,
    eyeContact: controls.eyeContact,
  });
}

export function buildLampChainPlan(input: {
  planId: string;
  runId: string;
  createdAt: number;
  controls: unknown;
  backgroundPlan: unknown;
  beautifyPlan?: unknown;
  irisPlan?: unknown;
}): LampChainPlan {
  const controls = parseLampChainControls(input.controls);
  const aggregate = buildLampCombinedPlan({
    planId: input.planId,
    runId: input.runId,
    createdAt: input.createdAt,
    controls: lampChainCombinedControls(controls),
    backgroundPlan: input.backgroundPlan,
    beautifyPlan: input.beautifyPlan,
    irisPlan: input.irisPlan,
  });
  return parseLampChainPlan({
    version: LAMP_CHAIN_PLAN_VERSION,
    stageOrder: controls.stageOrder,
    aggregate,
  });
}

/** Re-validate persisted chain JSON before it is trusted. */
export function parseLampChainPlan(value: unknown): LampChainPlan {
  if (!isRecord(value) || value.version !== LAMP_CHAIN_PLAN_VERSION) {
    throw new Error("Unknown Lamp Chain plan version.");
  }
  const aggregate = parseLampCombinedPlan(value.aggregate);
  const stageOrder = parseLampChainStageOrder(
    value.stageOrder,
    aggregate.controls
  );
  return { version: LAMP_CHAIN_PLAN_VERSION, stageOrder, aggregate };
}

/** One click approves the aggregate and every enabled subplan at one instant. */
export function approveLampChainPlan(
  plan: LampChainPlan,
  approvedAt: number
): LampChainPlan {
  const canonical = parseLampChainPlan(plan);
  return parseLampChainPlan({
    version: LAMP_CHAIN_PLAN_VERSION,
    stageOrder: canonical.stageOrder,
    aggregate: approveLampCombinedPlan(canonical.aggregate, approvedAt),
  });
}

export function lampChainPlanApproval(plan: LampChainPlan): LampChainPlanApproval {
  return parseLampChainPlan(plan).aggregate.approval;
}

/**
 * Stable SHA-256 approval binding. Stage order is part of the projection on
 * purpose: reordering the chain changes what will be generated, so it must
 * invalidate the presented hash exactly like editing a subplan would.
 */
export async function hashLampChainPlan(plan: LampChainPlan): Promise<string> {
  const canonical = parseLampChainPlan(plan);
  const aggregateHash = await hashLampCombinedPlan(canonical.aggregate);
  const projection = {
    version: canonical.version,
    stageOrder: canonical.stageOrder,
    aggregateHash,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(projection));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Validate the run id, mutable run controls, and separately stored relight
 * intensity against the immutable chain plan before execution.
 */
export function assertLampChainPlanBinding(
  plan: LampChainPlan,
  binding: {
    runId: unknown;
    relightIntensity: unknown;
    controls: unknown;
  }
): LampChainPlan {
  const canonical = parseLampChainPlan(plan);
  const controls = parseLampChainControls(binding.controls);
  parseLampCombinedRelightIntensity(binding.relightIntensity);
  if (typeof binding.runId !== "string" || canonical.aggregate.runId !== binding.runId) {
    throw new Error("Lamp Chain plan is bound to a different run.");
  }
  const aggregateControls = canonical.aggregate.controls;
  if (
    aggregateControls.beautifyLevel !== controls.beautifyLevel ||
    aggregateControls.cleanlinessLevel !== controls.cleanlinessLevel ||
    aggregateControls.eyeContact !== controls.eyeContact
  ) {
    throw new Error("Lamp Chain run controls no longer match the approved plan.");
  }
  if (
    canonical.stageOrder.length !== controls.stageOrder.length ||
    canonical.stageOrder.some((stage, i) => stage !== controls.stageOrder[i])
  ) {
    throw new Error("Lamp Chain stage order no longer matches the approved plan.");
  }
  return canonical;
}

export function lampChainBackgroundExecutionScope(plan: LampChainPlan) {
  return lampCombinedBackgroundExecutionScope(parseLampChainPlan(plan).aggregate);
}

/** Each stage owns exactly one edit concern. */
export const LAMP_CHAIN_STAGE_CONCERN = {
  background: "background",
  lamp: "lighting",
  beautify: "beautify",
  iris: "iris",
} as const satisfies Record<LampChainStage, LampCombinedEditConcern>;

/**
 * Concerns already executed once stages[0..stageIndex] have run — the
 * cumulative contract a detached stage evaluation judges against the ORIGINAL:
 * completed concerns are targets, everything else must still read as source.
 */
export function lampChainConcernsAfterStage(
  stageOrder: readonly LampChainStage[],
  stageIndex: number
): LampCombinedEditConcern[] {
  if (
    !Number.isInteger(stageIndex) ||
    stageIndex < 0 ||
    stageIndex >= stageOrder.length
  ) {
    throw new Error("Lamp Chain stage index is out of range.");
  }
  return stageOrder
    .slice(0, stageIndex + 1)
    .map((stage) => LAMP_CHAIN_STAGE_CONCERN[stage]);
}

/** 1-based generation iteration for a 0-based stage index. */
export function lampChainIterationForStage(stageIndex: number): number {
  if (!Number.isInteger(stageIndex) || stageIndex < 0) {
    throw new Error("Lamp Chain stage index must be a non-negative integer.");
  }
  return stageIndex + 1;
}

/**
 * Delivery is settled on structural proof only: every stage generated and the
 * final artifact carries verified (or explicitly silent) original audio.
 * Perceptual measurements — judges, SyncNet, meters — are deliberately absent
 * here; they attach after delivery and can never hold the artifact back.
 */
export interface LampChainStageProofSummary {
  stage: LampChainStage;
  iteration: number;
  generationComplete: boolean;
  audioStatus: "verified" | "silent-source" | "failed" | "unverified";
}

export type LampChainDeliveryIneligibility =
  | { kind: "stage-generation-incomplete"; stage: LampChainStage; iteration: number }
  | { kind: "stage-audio-unverified"; stage: LampChainStage; iteration: number };

export function lampChainDeliveryIneligibility(
  stages: readonly LampChainStageProofSummary[],
  stageOrder: readonly LampChainStage[]
): LampChainDeliveryIneligibility | null {
  if (stages.length !== stageOrder.length) {
    return {
      kind: "stage-generation-incomplete",
      stage: stageOrder[stages.length] ?? stageOrder[stageOrder.length - 1]!,
      iteration: stages.length + 1,
    };
  }
  for (const [index, proof] of stages.entries()) {
    if (proof.stage !== stageOrder[index] || proof.iteration !== index + 1) {
      return {
        kind: "stage-generation-incomplete",
        stage: stageOrder[index]!,
        iteration: index + 1,
      };
    }
    if (!proof.generationComplete) {
      return {
        kind: "stage-generation-incomplete",
        stage: proof.stage,
        iteration: proof.iteration,
      };
    }
    if (proof.audioStatus !== "verified" && proof.audioStatus !== "silent-source") {
      return {
        kind: "stage-audio-unverified",
        stage: proof.stage,
        iteration: proof.iteration,
      };
    }
  }
  return null;
}

export type { LampCombinedControls } from "./lamp-combined.ts";
