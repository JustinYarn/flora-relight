import {
  LAMP_COMBINED_EVAL_REGISTRY,
  lampCombinedEvalDefinitions,
  type LampCombinedEvalDefinition,
} from "./lamp-combined-evaluation.ts";
import type { LampCombinedPlan } from "./lamp-combined.ts";
import type {
  EvalCategory,
  EvalDefinition,
  MegaPrompt,
  Run,
} from "./types.ts";
import { initialMegaPrompt } from "./prompts/mega-prompt.ts";
import { DEFAULT_RELIGHT_INTENSITY } from "./relight-intensity.ts";

export const LAMP_COMBINED_DEFINITION_OVERVIEW = [
  "=== LAMP COMBINED DEFINITION OVERVIEW — NOT PROVIDER BYTES ===",
  "The exact provider prompt exists only after one source-specific aggregate plan is approved and frozen.",
  "Both takes start separately from the immutable original.",
  "Region ownership: lighting owns illumination; Background owns only approved removal footprints; Beautify owns only approved presenter face zones; Iris owns gaze direction and direction-implied eyelid pose; everything else is preservation-locked.",
  "Take 2 reuses the exact Take-1 prompt bytes with only a deterministic, severity-ordered correction body changed. The ledger is capped at 12. No generated pixels or provider interaction chain carries forward.",
].join("\n\n");

/** Honest definition-only fallback; it is never labeled as compiled provider bytes. */
export function lampCombinedDefinitionPrompt(
  relightIntensity = DEFAULT_RELIGHT_INTENSITY
): MegaPrompt {
  return {
    ...initialMegaPrompt("lamp", relightIntensity),
    version: 1,
    rendered: LAMP_COMBINED_DEFINITION_OVERVIEW,
  };
}

const CATEGORY_MAP: Record<
  LampCombinedEvalDefinition["category"],
  EvalCategory
> = {
  identity: "identity",
  "people-appearance": "appearance",
  "motion-lipsync": "motion",
  "camera-framing": "framing",
  "background-cleanliness": "background",
  lighting: "lighting",
  beautify: "appearance",
  "eye-contact": "appearance",
  "region-leakage": "hallucination",
  "temporal-hallucination": "temporal",
  audio: "audio",
};

function toUiDefinition(
  definition: LampCombinedEvalDefinition
): EvalDefinition {
  return {
    id: definition.id,
    name: definition.name,
    category: CATEGORY_MAP[definition.category],
    description: definition.description,
    method:
      definition.method === "deterministic"
        ? "deterministic"
        : "dual-llm-judge",
    hardGate: definition.hardGate,
    weight: definition.weight,
    passThreshold: definition.passThreshold,
    borderlineThreshold: definition.borderlineThreshold,
    promptTemplate:
      definition.method === "deterministic" ? "" : definition.rubric,
    ...(definition.method === "deterministic"
      ? { deterministicNote: definition.rubric }
      : {}),
  };
}

/** Run-aware mapping keeps disabled optional concerns visible as hard locks. */
export function lampCombinedUiEvalDefs(
  plan?: LampCombinedPlan
): EvalDefinition[] {
  const definitions = plan
    ? lampCombinedEvalDefinitions(plan)
    : LAMP_COMBINED_EVAL_REGISTRY.map(
        (definition): LampCombinedEvalDefinition => ({
          id: definition.id,
          name: definition.name,
          category: definition.category,
          method: definition.method,
          contract: definition.contract,
          concern: definition.concern,
          hardGate: definition.hardGate,
          weight: definition.weight,
          passThreshold: definition.passThreshold,
          borderlineThreshold: definition.borderlineThreshold,
          description: definition.description,
          rubric: definition.rubric,
          allowedCorrectionActions: definition.allowedCorrectionActions,
        })
      );
  return definitions.map(toUiDefinition);
}

type CombinedRunIdentity = Pick<
  Run,
  "workflowId" | "workflowMode" | "serverExecution"
>;

/** Durable execution identity wins over browser-authored presentation fields. */
export function isLampCombinedRun(run: CombinedRunIdentity): boolean {
  if (run.serverExecution?.executionId) {
    return run.serverExecution.executionId.startsWith("lamp-combined:");
  }
  return (
    run.workflowMode === "combined" || run.workflowId === "lamp-combined-v1"
  );
}
