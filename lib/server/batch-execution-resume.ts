import { batchExecutionMode } from "./batch-contract.ts";
import type { BatchExecution } from "../types.ts";

export const LAMP_BATCH_USER_ACTION_REQUIRED_PREFIX =
  "LAMP_BATCH_USER_ACTION_REQUIRED:";

/** The only transition allowed to replace a batch parent Workflow owner. */
export function isLampBatchApprovalReplayTransition(
  current: BatchExecution,
  candidate: BatchExecution
): boolean {
  return (
    batchExecutionMode(current) === "lamp" &&
    current.status === "user_action_required" &&
    current.error?.startsWith(LAMP_BATCH_USER_ACTION_REQUIRED_PREFIX) === true &&
    current.members.some((member) => member.state === "user_action_required") &&
    candidate.status === "queued" &&
    candidate.workflowRunId === undefined &&
    candidate.error === undefined &&
    candidate.approvalStartedAt !== undefined &&
    candidate.approvalStartedAt >
      (current.approvalStartedAt ?? current.startedAt) &&
    candidate.members.every((member, index) => {
      const prior = current.members[index];
      return prior.state === "user_action_required"
        ? member.state === "queued"
        : member.state === prior.state;
    })
  );
}

/**
 * Re-arm the immutable Lamp batch plan under one fresh approval epoch.
 * Completed members remain terminal; only approval-paused members re-enter
 * the queue. Their child workflows replay stable provider journal ids, so
 * completed Initial work is read rather than billed again.
 */
export function requeueLampBatchExecutionAfterApproval(
  execution: BatchExecution,
  now = Date.now()
): BatchExecution {
  const previousApproval = execution.approvalStartedAt ?? execution.startedAt;
  if (
    batchExecutionMode(execution) !== "lamp" ||
    execution.status !== "user_action_required" ||
    !execution.workflowRunId ||
    !execution.error?.startsWith(LAMP_BATCH_USER_ACTION_REQUIRED_PREFIX) ||
    !execution.members.some(
      (member) => member.state === "user_action_required"
    ) ||
    !Number.isSafeInteger(now) ||
    now <= previousApproval
  ) {
    throw new Error(
      "Only an approval-paused Lamp batch can be resumed with a newer grant."
    );
  }
  return {
    ...execution,
    status: "queued",
    members: execution.members.map((member) =>
      member.state === "user_action_required"
        ? { ...member, state: "queued" as const, error: undefined }
        : member
    ),
    approvalStartedAt: now,
    revision: execution.revision + 1,
    updatedAt: Math.max(now, execution.updatedAt),
    workflowRunId: undefined,
    error: undefined,
  };
}
