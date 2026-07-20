/**
 * Lamp Chain stage prompts — Combined Version 2.
 *
 * Chaining is the experiment's only variable, so each stage sends the exact
 * initial prompt its STANDALONE mode would send for the same approved plan
 * and intensity:
 *
 * - lamp     → initialMegaPrompt("lamp", relightIntensity)   (75 = control)
 * - beautify → initialLampBeautifyMegaPrompt(approved subplan)
 * - iris     → initialLampIrisMegaPrompt(approved subplan)
 * - background → initialLampBackgroundMegaPrompt(approved subplan) plus ONE
 *   appended [CHAIN CLEANLINESS DIRECTIVE] block. Cleanliness is a Combined-
 *   family control with no standalone-background expression; the appended
 *   block reuses Combined's execution-amplitude wording verbatim so the dial
 *   keeps meaning without inventing new prompt language.
 *
 * There is no correction pass and no prompt derived from any evaluation:
 * every stage prompt is compiled once from the approved plan, frozen at
 * enqueue, and byte-validated on read (persisted-format law, day-1 lineage).
 *
 * The model is never told its input may be a prior generation. Each stage's
 * prompt speaks about "the input video" exactly as its standalone mode does —
 * disclosing chain position would invite re-attention to earlier edits
 * (pink-elephant discipline).
 */

import {
  parseLampChainPlan,
  LAMP_CHAIN_MAX_STAGES,
  type LampChainPlan,
  type LampChainStage,
} from "../lamp-chain.ts";
import {
  LAMP_COMBINED_CLEANLINESS_PROFILES,
  parseLampCombinedRelightIntensity,
} from "../lamp-combined.ts";
import { initialMegaPrompt } from "./mega-prompt.ts";
import { initialLampBackgroundMegaPrompt } from "./lamp-background.ts";
import { initialLampBeautifyMegaPrompt } from "./lamp-beautify.ts";
import { initialLampIrisMegaPrompt } from "./lamp-iris.ts";

/** Never edit after a real run has stored a stage prompt. */
export const LAMP_CHAIN_STAGE_PROMPT_LINEAGE =
  "lamp-chain-stage-prompt-v1" as const;

export const LAMP_CHAIN_CLEANLINESS_HEADING =
  "[CHAIN CLEANLINESS DIRECTIVE]" as const;

export interface LampChainStagePrompt {
  lineage: typeof LAMP_CHAIN_STAGE_PROMPT_LINEAGE;
  /** 1-based; equals the generation iteration for this stage. */
  stage: number;
  stageCount: number;
  stageKind: LampChainStage;
  rendered: string;
}

function approvedPlan(value: LampChainPlan): LampChainPlan {
  const plan = parseLampChainPlan(value);
  if (plan.aggregate.approval.status !== "approved") {
    throw new Error("Lamp Chain stage prompts require the human-approved plan.");
  }
  return plan;
}

function renderStage(
  plan: LampChainPlan,
  stageKind: LampChainStage,
  relightIntensity: number
): string {
  const aggregate = plan.aggregate;
  if (stageKind === "lamp") {
    return initialMegaPrompt("lamp", relightIntensity).rendered;
  }
  if (stageKind === "background") {
    const profile =
      LAMP_COMBINED_CLEANLINESS_PROFILES[aggregate.controls.cleanlinessLevel];
    return [
      initialLampBackgroundMegaPrompt(aggregate.backgroundPlan).rendered,
      "",
      LAMP_CHAIN_CLEANLINESS_HEADING,
      profile.executionDirective,
    ].join("\n");
  }
  if (stageKind === "beautify") {
    if (aggregate.beautify.state !== "enabled") {
      throw new Error("Beautify stage requires an enabled approved subplan.");
    }
    return initialLampBeautifyMegaPrompt(aggregate.beautify.plan).rendered;
  }
  if (aggregate.iris.state !== "enabled") {
    throw new Error("Iris stage requires an enabled approved subplan.");
  }
  return initialLampIrisMegaPrompt(aggregate.iris.plan).rendered;
}

/**
 * Compile every stage prompt for the approved chain, in execution order.
 * Deterministic: same plan + intensity → same bytes for every stage.
 */
export function compileLampChainStagePrompts(
  value: LampChainPlan,
  relightIntensity: unknown
): LampChainStagePrompt[] {
  const plan = approvedPlan(value);
  const intensity = parseLampCombinedRelightIntensity(relightIntensity);
  const stageCount = plan.stageOrder.length;
  if (stageCount > LAMP_CHAIN_MAX_STAGES) {
    throw new Error("Lamp Chain plan exceeds the stage maximum.");
  }
  return plan.stageOrder.map((stageKind, index) => ({
    lineage: LAMP_CHAIN_STAGE_PROMPT_LINEAGE,
    stage: index + 1,
    stageCount,
    stageKind,
    rendered: renderStage(plan, stageKind, intensity),
  }));
}

export function compileLampChainStagePrompt(
  value: LampChainPlan,
  relightIntensity: unknown,
  stage: number
): LampChainStagePrompt {
  const prompts = compileLampChainStagePrompts(value, relightIntensity);
  const prompt = prompts.find((candidate) => candidate.stage === stage);
  if (!prompt) {
    throw new Error(`Lamp Chain has no stage ${stage}.`);
  }
  return prompt;
}

/**
 * True when the persisted bytes are a faithful stage compile of this exact
 * approved plan at this intensity. Only the day-1 lineage exists; a future
 * prompt generation must freeze this form as LEGACY before changing anything.
 */
export function isPersistedLampChainStagePrompt(
  plan: LampChainPlan,
  relightIntensity: unknown,
  stage: number,
  rendered: string
): boolean {
  try {
    return (
      compileLampChainStagePrompt(plan, relightIntensity, stage).rendered ===
      rendered
    );
  } catch {
    return false;
  }
}

/** Serialized envelope persisted on the run execution at enqueue. */
export interface LampChainPromptEnvelope {
  lineage: typeof LAMP_CHAIN_STAGE_PROMPT_LINEAGE;
  relightIntensity: number;
  stagePrompts: LampChainStagePrompt[];
}

export function buildLampChainPromptEnvelope(
  plan: LampChainPlan,
  relightIntensity: unknown
): LampChainPromptEnvelope {
  const intensity = parseLampCombinedRelightIntensity(relightIntensity);
  return {
    lineage: LAMP_CHAIN_STAGE_PROMPT_LINEAGE,
    relightIntensity: intensity,
    stagePrompts: compileLampChainStagePrompts(plan, intensity),
  };
}

export function parseLampChainPromptEnvelope(
  value: unknown,
  binding: { plan: LampChainPlan; relightIntensity: unknown }
): LampChainPromptEnvelope {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).lineage !==
      LAMP_CHAIN_STAGE_PROMPT_LINEAGE
  ) {
    throw new Error("Unknown Lamp Chain prompt envelope lineage.");
  }
  const record = value as Record<string, unknown>;
  const intensity = parseLampCombinedRelightIntensity(record.relightIntensity);
  if (intensity !== parseLampCombinedRelightIntensity(binding.relightIntensity)) {
    throw new Error(
      "Lamp Chain prompt envelope intensity does not match the run binding."
    );
  }
  const expected = compileLampChainStagePrompts(binding.plan, intensity);
  const stagePrompts = record.stagePrompts;
  if (!Array.isArray(stagePrompts) || stagePrompts.length !== expected.length) {
    throw new Error("Lamp Chain prompt envelope stage count is wrong.");
  }
  for (const [index, expectation] of expected.entries()) {
    const persisted = stagePrompts[index] as Record<string, unknown> | undefined;
    if (
      !persisted ||
      persisted.lineage !== LAMP_CHAIN_STAGE_PROMPT_LINEAGE ||
      persisted.stage !== expectation.stage ||
      persisted.stageCount !== expectation.stageCount ||
      persisted.stageKind !== expectation.stageKind ||
      persisted.rendered !== expectation.rendered
    ) {
      throw new Error(
        `Lamp Chain prompt envelope stage ${expectation.stage} does not match its frozen compile.`
      );
    }
  }
  return {
    lineage: LAMP_CHAIN_STAGE_PROMPT_LINEAGE,
    relightIntensity: intensity,
    stagePrompts: expected,
  };
}
