/** Stable paid-operation identities for Lamp Iris journals. */

export function lampIrisPlanOperationId(): string {
  return "plan:lamp-iris:gemini";
}

export function lampIrisEvaluationOperationId(iteration: number): string {
  return `judge:${iteration}:lamp-iris-holistic:gemini`;
}

export const LAMP_IRIS_HOLISTIC_EVAL_ID = "lamp-iris-holistic" as const;
