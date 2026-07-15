import type { ProviderOperation } from "../types.ts";
import {
  PROVIDER_LOST_INTERACTION_MARKER,
  isProviderLostInteractionError,
} from "../lost-interaction.ts";

export {
  PROVIDER_LOST_INTERACTION_MARKER,
  isProviderLostInteractionError,
} from "../lost-interaction.ts";

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

export type VideoGenerationPollErrorKind = "permanent" | "transient";

/** HTTP statuses proving the provider itself rejects this exact read. */
const PERMANENT_POLL_HTTP_STATUSES = new Set([400, 404]);
/** Fallback for wrapped errors that lost their numeric status field. */
const PERMANENT_POLL_MESSAGE_RE =
  /^\s*40[04]\b|\bINVALID_ARGUMENT\b|\bNOT_FOUND\b/;

/**
 * Strict single-observation evidence: a NUMERIC provider status of 400/404.
 * Callers that seal on one probe (no consecutive streak, no wall-clock
 * window — e.g. the dead-workflow adopter) must demand this strongest form;
 * the message-regex fallback below is acceptable only under the bounded
 * streak, where a transient proxy error echoing "NOT_FOUND" text cannot
 * persist across many polls.
 */
export function hasPermanentPollHttpStatus(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return (
    typeof status === "number" &&
    Number.isFinite(status) &&
    PERMANENT_POLL_HTTP_STATUSES.has(status)
  );
}

/**
 * Classify one interactions.get failure. Only a positively identified
 * permanent rejection (400 INVALID_ARGUMENT / 404 NOT_FOUND) counts toward
 * the lost-interaction seal; anything ambiguous stays transient so rate
 * limits, 5xx, and network faults keep the existing free retry path.
 */
export function classifyVideoGenerationPollError(
  error: unknown
): VideoGenerationPollErrorKind {
  if (!error || typeof error !== "object") return "transient";
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) {
    return PERMANENT_POLL_HTTP_STATUSES.has(status) ? "permanent" : "transient";
  }
  return error instanceof Error &&
    PERMANENT_POLL_MESSAGE_RE.test(error.message)
    ? "permanent"
    : "transient";
}

/**
 * A lost interaction must fail loudly instead of spinning to the seven-day
 * cap, but a short 400 blip must never seal a journal that could still
 * recover. Both bounds have to hold: enough consecutive permanent rejections
 * AND enough wall-clock since the first one (~16 polls in the 8s loop, 6
 * ticks in the 5-minute reconciliation loop).
 */
export const MAX_CONSECUTIVE_PERMANENT_POLL_FAILURES = 6;
export const MIN_PERMANENT_POLL_FAILURE_WINDOW_MS = 2 * 60 * 1000;

export function permanentPollFailuresExhausted(
  count: number,
  firstFailureAt: number,
  now: number
): boolean {
  return (
    count >= MAX_CONSECUTIVE_PERMANENT_POLL_FAILURES &&
    now - firstFailureAt >= MIN_PERMANENT_POLL_FAILURE_WINDOW_MS
  );
}

/** Human-facing seal reason; must keep the shared marker as its prefix. */
export function providerLostInteractionError(
  interactionId: string,
  count: number,
  spanMs: number
): string {
  const minutes = Math.max(1, Math.round(spanMs / 60_000));
  return (
    `${PROVIDER_LOST_INTERACTION_MARKER} (${count} consecutive permanent ` +
    `read failures over ${minutes}m for ${interactionId}). The generation ` +
    `was lost upstream and its charge outcome is unknown. Re-running it ` +
    `needs a fresh interaction under a new spend approval.`
  );
}

/** True for a journal sealed because the provider lost the interaction. */
export function isProviderLostInteraction(
  operation: Pick<ProviderOperation, "status" | "error">
): boolean {
  return (
    operation.status === "reconcile_required" &&
    isProviderLostInteractionError(operation.error)
  );
}

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
