import type { ProviderOperation } from "../types.ts";

const DEFINITIVE_PROVIDER_FAILURES = new Set<ProviderOperation["status"]>([
  "failed",
  "cancelled",
  "incomplete",
  "budget_exceeded",
]);

export type VideoGenerationPollErrorDisposition =
  | "completed"
  | "retryable"
  | "terminal"
  | "unrecoverable";

/** Only an artifact with deterministic audio integrity may enter grading. */
export function isGradeableVideoGeneration(
  operation:
    | Pick<ProviderOperation, "status" | "result">
    | null
    | undefined
): boolean {
  return (
    operation?.status === "completed" &&
    operation.result?.audioVerified === true
  );
}

/**
 * A sealed reconciliation or definitive provider failure must never trigger
 * another provider read/finalization attempt on Workflow replay. Preserve the
 * journaled explanation when one exists so the parent run exposes the real
 * stop reason.
 */
export function automaticVideoGenerationStopReason(
  operation: Pick<ProviderOperation, "status" | "error">
): string | null {
  if (
    operation.status !== "reconcile_required" &&
    !DEFINITIVE_PROVIDER_FAILURES.has(operation.status)
  ) {
    return null;
  }
  return operation.error?.trim()
    ? operation.error
    : operation.status === "reconcile_required"
      ? "Video generation requires provider reconciliation."
      : `Video generation ended with status ${operation.status}.`;
}

/** Keep the first deterministic reconciliation reason when parent bookkeeping
 * later adds its generic Workflow failure wrapper. */
export function videoGenerationWorkflowErrorMessage(
  operation: Pick<ProviderOperation, "status" | "error"> | undefined,
  workflowError: string
): string {
  const message =
    operation?.status === "reconcile_required" && operation.error
      ? operation.error
      : workflowError;
  return message.slice(0, 500);
}

/**
 * Classify the durable provider journal after a polling/finalization step
 * throws. A saved `reconcile_required` result is terminal for automatic
 * orchestration even when the billed provider interaction id is known: the
 * journal is explicitly saying that a person must reconcile the outcome.
 */
export function videoGenerationPollErrorDisposition(
  operation: Pick<
    ProviderOperation,
    "status" | "result" | "providerInteractionId"
  >
): VideoGenerationPollErrorDisposition {
  if (operation.status === "completed" && operation.result) return "completed";
  if (automaticVideoGenerationStopReason(operation) !== null) {
    return "terminal";
  }
  return operation.providerInteractionId ? "retryable" : "unrecoverable";
}

/**
 * Choose the parent RunExecution terminal state after recovery is exhausted or
 * a provider journal says automatic orchestration must stop.
 */
export function runExecutionFailureStatus(input: {
  evaluationAmbiguous: boolean;
  generation?: Pick<ProviderOperation, "status" | "result"> | null;
}): "failed" | "reconcile_required" {
  const generationAmbiguous = Boolean(
    input.generation &&
      !DEFINITIVE_PROVIDER_FAILURES.has(input.generation.status) &&
      (input.generation.status !== "completed" || !input.generation.result)
  );
  return input.evaluationAmbiguous || generationAmbiguous
    ? "reconcile_required"
    : "failed";
}
