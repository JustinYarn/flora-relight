/** Stable provider-operation identities for Lamp Combined journals. */

import {
  lampCombinedRequiredPlanners,
  type LampCombinedControls,
  type LampCombinedIteration,
  type LampCombinedPlannerConcern,
} from "./lamp-combined.ts";

export const LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID =
  "plan:lamp-combined:background:gemini" as const;
export const LAMP_COMBINED_BEAUTIFY_PLAN_OPERATION_ID =
  "plan:lamp-combined:beautify:gemini" as const;
export const LAMP_COMBINED_IRIS_PLAN_OPERATION_ID =
  "plan:lamp-combined:iris:gemini" as const;
export const LAMP_COMBINED_HOLISTIC_EVAL_ID =
  "lamp-combined-holistic" as const;

const PLAN_OPERATION_IDS: Record<LampCombinedPlannerConcern, string> = {
  background: LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
  beautify: LAMP_COMBINED_BEAUTIFY_PLAN_OPERATION_ID,
  iris: LAMP_COMBINED_IRIS_PLAN_OPERATION_ID,
};

export function lampCombinedPlanOperationId(
  concern: LampCombinedPlannerConcern
): string {
  return PLAN_OPERATION_IDS[concern];
}

/** Disabled Beautify and Iris controls produce no paid planner operation. */
export function lampCombinedPlanOperationIds(
  controls: LampCombinedControls
): string[] {
  return lampCombinedRequiredPlanners(controls).map(
    (concern) => PLAN_OPERATION_IDS[concern]
  );
}

export function lampCombinedEvaluationOperationId(
  iteration: LampCombinedIteration
): string {
  if (iteration !== 1 && iteration !== 2) {
    throw new Error("Lamp Combined evaluation iteration must be 1 or 2.");
  }
  return `judge:${iteration}:${LAMP_COMBINED_HOLISTIC_EVAL_ID}:gemini`;
}
