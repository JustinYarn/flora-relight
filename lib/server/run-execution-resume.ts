import type { RunExecution } from "../types.ts";
import { isProviderLostInteractionError } from "../lost-interaction.ts";
import { isTwoPassExecutionId } from "../workflow-mode.ts";

export const LAMP_USER_ACTION_REQUIRED_PREFIX =
  "LAMP_USER_ACTION_REQUIRED:";
export const LAMP_REJECTED_EVALUATION_ACKNOWLEDGED_PREFIX =
  "LAMP_REJECTED_EVALUATION_ACKNOWLEDGED:";

export function isLampUserActionRequiredError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(LAMP_USER_ACTION_REQUIRED_PREFIX)
  );
}

/** The one lifecycle transition allowed to reset coordinator replay state. */
export function isLampApprovalReplayTransition(
  current: RunExecution,
  candidate: RunExecution
): boolean {
  return (
    current.status === "user_action_required" &&
    current.error?.startsWith(LAMP_USER_ACTION_REQUIRED_PREFIX) === true &&
    candidate.status === "queued" &&
    isTwoPassExecutionId(current.executionId) &&
    candidate.source === current.source &&
    candidate.batchId === current.batchId &&
    candidate.phase === "queued" &&
    candidate.iteration === 0 &&
    candidate.workflowRunId === undefined
  );
}

/** True when a paused-for-approval error wraps an acknowledged lost generation. */
export function isAcknowledgedLostGenerationError(
  error: string | undefined
): boolean {
  return (
    error?.startsWith(LAMP_USER_ACTION_REQUIRED_PREFIX) === true &&
    isProviderLostInteractionError(
      error.slice(LAMP_USER_ACTION_REQUIRED_PREFIX.length)
    )
  );
}

/**
 * The one transition allowed to leave reconcile_required without an operator:
 * a human explicitly acknowledging that the provider lost the generation
 * interaction. It only converts the execution into the existing paused-for-
 * approval state; actually re-running still requires a fresh exact spend
 * approval through the normal renewal flow, so nothing is ever re-billed
 * silently. Gated on the exact lost-interaction marker that only the poll
 * seal writes — any other reconcile_required reason stays operator-owned.
 */
export function isLampLostGenerationAcknowledgeTransition(
  current: RunExecution,
  candidate: RunExecution
): boolean {
  return (
    isTwoPassExecutionId(current.executionId) &&
    current.status === "reconcile_required" &&
    isProviderLostInteractionError(current.error) &&
    candidate.status === "user_action_required" &&
    candidate.error?.startsWith(LAMP_USER_ACTION_REQUIRED_PREFIX) === true &&
    candidate.executionId === current.executionId &&
    candidate.source === current.source &&
    candidate.batchId === current.batchId &&
    candidate.phase === current.phase &&
    candidate.iteration === current.iteration &&
    candidate.workflowRunId === current.workflowRunId
  );
}

/**
 * Guarded reconcile_required exit for a definitively rejected Combined judge
 * request. The HTTP route proves and archives the exact rejected journal
 * before constructing this transition. Like lost-generation recovery, this
 * pauses for a fresh exact approval; it never authorizes provider spend.
 */
export function isLampRejectedEvaluationAcknowledgeTransition(
  current: RunExecution,
  candidate: RunExecution
): boolean {
  return (
    current.executionId.startsWith("lamp-combined:") &&
    current.status === "reconcile_required" &&
    current.phase === "evaluating" &&
    (current.iteration === 1 || current.iteration === 2) &&
    candidate.status === "user_action_required" &&
    candidate.error?.startsWith(
      `${LAMP_USER_ACTION_REQUIRED_PREFIX}${LAMP_REJECTED_EVALUATION_ACKNOWLEDGED_PREFIX}`
    ) === true &&
    candidate.executionId === current.executionId &&
    candidate.source === current.source &&
    candidate.batchId === current.batchId &&
    candidate.phase === current.phase &&
    candidate.iteration === current.iteration &&
    candidate.workflowRunId === current.workflowRunId
  );
}

export function isAcknowledgedRejectedEvaluationError(
  error: string | undefined
): boolean {
  return error?.startsWith(
    `${LAMP_USER_ACTION_REQUIRED_PREFIX}${LAMP_REJECTED_EVALUATION_ACKNOWLEDGED_PREFIX}`
  ) === true;
}

export function acknowledgeRejectedLampCombinedEvaluation(
  execution: RunExecution,
  input: { operationId: string; inputHash: string },
  now = Date.now()
): RunExecution {
  if (
    !execution.executionId.startsWith("lamp-combined:") ||
    execution.status !== "reconcile_required" ||
    execution.phase !== "evaluating" ||
    (execution.iteration !== 1 && execution.iteration !== 2) ||
    !/^[a-z0-9:_-]{1,160}$/.test(input.operationId) ||
    !/^[a-f0-9]{64}$/.test(input.inputHash)
  ) {
    throw new Error(
      "Only a Combined execution stopped on a definitively rejected evaluation can be acknowledged this way."
    );
  }
  return {
    ...execution,
    status: "user_action_required",
    revision: execution.revision + 1,
    updatedAt: Math.max(now, execution.updatedAt),
    error: `${LAMP_USER_ACTION_REQUIRED_PREFIX}${LAMP_REJECTED_EVALUATION_ACKNOWLEDGED_PREFIX}${input.operationId}:${input.inputHash}`.slice(
      0,
      2_000
    ),
  };
}

/**
 * Build the acknowledged record for a provider-lost Lamp generation. The
 * original lost-interaction reason stays visible inside the paused error so
 * the renewal confirmation can explain exactly why a new approval is needed.
 */
export function acknowledgeLostLampGeneration(
  execution: RunExecution,
  now = Date.now()
): RunExecution {
  if (
    !isTwoPassExecutionId(execution.executionId) ||
    execution.status !== "reconcile_required" ||
    !isProviderLostInteractionError(execution.error)
  ) {
    throw new Error(
      "Only a two-pass execution stopped by a provider-lost generation can be acknowledged this way."
    );
  }
  return {
    ...execution,
    status: "user_action_required",
    revision: execution.revision + 1,
    updatedAt: Math.max(now, execution.updatedAt),
    error: `${LAMP_USER_ACTION_REQUIRED_PREFIX}${execution.error}`.slice(
      0,
      2_000
    ),
  };
}

/**
 * Re-arm the same Lamp execution after a fresh exact approval is persisted.
 *
 * Coordinator progress intentionally restarts at zero so a replacement
 * Workflow can replay the deterministic orchestration from the beginning.
 * Stable generation/evaluation operation ids remain the billing authority:
 * completed journals are cache reads and can never be claimed a second time.
 */
export function requeueLampExecutionAfterApproval(
  execution: RunExecution,
  now = Date.now()
): RunExecution {
  if (
    !isTwoPassExecutionId(execution.executionId) ||
    execution.status !== "user_action_required" ||
    !execution.error?.startsWith(LAMP_USER_ACTION_REQUIRED_PREFIX)
  ) {
    throw new Error(
      "Only a Lamp execution paused for approval or a Lamp Background execution paused for approval can be resumed this way."
    );
  }
  return {
    ...execution,
    status: "queued",
    phase: "queued",
    iteration: 0,
    revision: execution.revision + 1,
    updatedAt: Math.max(now, execution.updatedAt),
    workflowRunId: undefined,
    error: undefined,
  };
}
