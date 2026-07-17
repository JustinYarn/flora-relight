/** Stable paid-operation identities for Lamp Beautify journals. */

export function lampBeautifyPlanOperationId(): string {
  return "plan:lamp-beautify:gemini";
}

export function lampBeautifyEvaluationOperationId(iteration: number): string {
  return `judge:${iteration}:lamp-beautify-holistic:gemini`;
}

export const LAMP_BEAUTIFY_HOLISTIC_EVAL_ID = "lamp-beautify-holistic" as const;
