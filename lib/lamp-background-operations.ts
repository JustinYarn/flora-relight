/**
 * Stable paid-operation identities for Lamp Background.
 *
 * Planning is a separate approval and journal boundary from the two-pass
 * cleanup. Keeping these ids centralized prevents a route from accidentally
 * claiming a broader legacy Lamp operation under a background approval.
 */

export const LAMP_BACKGROUND_PLAN_OPERATION_ID =
  "plan:lamp-background:gemini" as const;
export const LAMP_BACKGROUND_HOLISTIC_EVAL_ID =
  "lamp-background-holistic" as const;

export function lampBackgroundPlanOperationId(): string {
  return LAMP_BACKGROUND_PLAN_OPERATION_ID;
}

export function lampBackgroundEvaluationOperationId(
  iteration: number
): string {
  return `judge:${iteration}:${LAMP_BACKGROUND_HOLISTIC_EVAL_ID}:gemini`;
}
