/** Stable provider-operation identities for Lamp Chain journals. */

import {
  lampChainRequiredPlanners,
  LAMP_CHAIN_MAX_STAGES,
  type LampChainControls,
} from "./lamp-chain.ts";
import type {
  LampCombinedControls,
  LampCombinedPlannerConcern,
} from "./lamp-combined.ts";

export const LAMP_CHAIN_BACKGROUND_PLAN_OPERATION_ID =
  "plan:lamp-chain:background:gemini" as const;
export const LAMP_CHAIN_BEAUTIFY_PLAN_OPERATION_ID =
  "plan:lamp-chain:beautify:gemini" as const;
export const LAMP_CHAIN_IRIS_PLAN_OPERATION_ID =
  "plan:lamp-chain:iris:gemini" as const;
export const LAMP_CHAIN_HOLISTIC_EVAL_ID = "lamp-chain-holistic" as const;

const PLAN_OPERATION_IDS: Record<LampCombinedPlannerConcern, string> = {
  background: LAMP_CHAIN_BACKGROUND_PLAN_OPERATION_ID,
  beautify: LAMP_CHAIN_BEAUTIFY_PLAN_OPERATION_ID,
  iris: LAMP_CHAIN_IRIS_PLAN_OPERATION_ID,
};

export function lampChainPlanOperationId(
  concern: LampCombinedPlannerConcern
): string {
  return PLAN_OPERATION_IDS[concern];
}

/** Disabled Beautify and Iris controls produce no paid planner operation. */
export function lampChainPlanOperationIds(
  controls: LampChainControls | LampCombinedControls
): string[] {
  return lampChainRequiredPlanners(controls).map(
    (concern) => PLAN_OPERATION_IDS[concern]
  );
}

/**
 * One detached holistic evaluation per completed stage, always judged against
 * the ORIGINAL clip. The stage number doubles as the generation iteration.
 */
export function lampChainEvaluationOperationId(stage: number): string {
  if (!Number.isInteger(stage) || stage < 1 || stage > LAMP_CHAIN_MAX_STAGES) {
    throw new Error(
      `Lamp Chain evaluation stage must be 1 through ${LAMP_CHAIN_MAX_STAGES}.`
    );
  }
  return `judge:${stage}:${LAMP_CHAIN_HOLISTIC_EVAL_ID}:gemini`;
}
