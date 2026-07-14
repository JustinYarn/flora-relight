import type { RunExecution } from "../types.ts";

export const LAMP_USER_ACTION_REQUIRED_PREFIX =
  "LAMP_USER_ACTION_REQUIRED:";

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
    current.executionId.startsWith("lamp:") &&
    candidate.source === current.source &&
    candidate.batchId === current.batchId &&
    candidate.phase === "queued" &&
    candidate.iteration === 0 &&
    candidate.workflowRunId === undefined
  );
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
    !execution.executionId.startsWith("lamp:") ||
    execution.status !== "user_action_required" ||
    !execution.error?.startsWith(LAMP_USER_ACTION_REQUIRED_PREFIX)
  ) {
    throw new Error(
      "Only a Lamp execution paused for approval can be resumed this way."
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
