import type {
  BatchExecution,
  SpendApproval,
  WorkflowMode,
} from "../types.ts";
import {
  isTwoPassWorkflowMode,
  LAMP_BACKGROUND_BATCH_EXECUTION_PREFIX,
  LAMP_BACKGROUND_EXECUTION_PREFIX,
} from "../workflow-mode.ts";
import { assertRunId } from "./runstore.ts";

/** Missing mode is the immutable compatibility rule for pre-Lamp records. */
export function normalizedWorkflowMode(
  mode: WorkflowMode | undefined
): WorkflowMode {
  if (mode === "background") return "background";
  return mode === "lamp" ? "lamp" : "flora";
}

export function batchExecutionMode(
  execution: Pick<BatchExecution, "workflowMode">
): WorkflowMode {
  return normalizedWorkflowMode(execution.workflowMode);
}

export function batchApprovalStartedAt(
  execution: Pick<BatchExecution, "approvalStartedAt" | "startedAt">
): number {
  return execution.approvalStartedAt ?? execution.startedAt;
}

export function batchExecutionId(
  batchId: string,
  mode: WorkflowMode
): string {
  const id = assertRunId(batchId);
  if (mode === "background") {
    return `${LAMP_BACKGROUND_BATCH_EXECUTION_PREFIX}${id}`;
  }
  return mode === "lamp" ? `lamp-batch:${id}` : `first-cuts:${id}`;
}

export function batchMemberExecutionId(
  batchId: string,
  runId: string,
  mode: WorkflowMode
): string {
  assertRunId(batchId);
  const id = assertRunId(runId);
  // A canonical run can belong to at most one durable execution. Keeping the
  // Lamp id independent of the batch avoids exceeding the execution-id limit
  // while source + batchId still bind ownership in RunExecution.
  if (mode === "background") {
    return `${LAMP_BACKGROUND_EXECUTION_PREFIX}${id}`;
  }
  return mode === "lamp" ? `lamp:${id}` : `batch:${batchId}:${id}`;
}

export function batchCompletionIteration(mode: WorkflowMode): 1 | 2 {
  return isTwoPassWorkflowMode(mode) ? 2 : 1;
}

export function batchApprovalScope(
  mode: WorkflowMode
): NonNullable<SpendApproval["scope"]> {
  if (mode === "background") return "background_two_pass";
  if (mode === "beautify") return "beautify_two_pass";
  return mode === "lamp" ? "lamp_two_pass" : "first_cut";
}

export function batchMaximumIterations(mode: WorkflowMode): 1 | 2 {
  return isTwoPassWorkflowMode(mode) ? 2 : 1;
}
