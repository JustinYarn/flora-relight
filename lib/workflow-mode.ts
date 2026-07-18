import type { Run, WorkflowMode } from "@/lib/types";

/** Flora remains readable for history, but only these methods may start new work. */
export type SelectableWorkflowMode = Exclude<WorkflowMode, "flora">;
export type PlanWorkflowMode = Extract<
  WorkflowMode,
  "background" | "beautify" | "iris"
>;

/** Lamp is the familiar, source-faithful default for a new browser. */
export const DEFAULT_WORKFLOW_MODE: SelectableWorkflowMode = "lamp";
export const LAMP_BACKGROUND_EXECUTION_PREFIX = "lamp-background:";
export const LAMP_BACKGROUND_BATCH_EXECUTION_PREFIX =
  "lamp-background-batch:";
export const LAMP_BEAUTIFY_EXECUTION_PREFIX = "lamp-beautify:";
export const LAMP_BEAUTIFY_BATCH_EXECUTION_PREFIX = "lamp-beautify-batch:";
export const LAMP_IRIS_EXECUTION_PREFIX = "lamp-iris:";
export const LAMP_IRIS_BATCH_EXECUTION_PREFIX = "lamp-iris-batch:";
export const LAMP_COMBINED_EXECUTION_PREFIX = "lamp-combined:";

export function parseWorkflowMode(value: unknown): WorkflowMode | null {
  return value === "flora" ||
    value === "lamp" ||
    value === "background" ||
    value === "beautify" ||
    value === "iris" ||
    value === "combined"
    ? value
    : null;
}

export function parseSelectableWorkflowMode(
  value: unknown
): SelectableWorkflowMode | null {
  const mode = parseWorkflowMode(value);
  return mode && mode !== "flora" ? mode : null;
}

export function isPlanWorkflowMode(
  mode: WorkflowMode
): mode is PlanWorkflowMode {
  return mode === "background" || mode === "beautify" || mode === "iris";
}

/** True only for the strict, human-approved exact-source delivery contract. */
export function isApprovedPlanNoOp(run: Run): boolean {
  const mode = runWorkflowMode(run);
  if (mode === "background") {
    return (
      run.backgroundCleanupPlan?.approval.status === "approved" &&
      run.backgroundCleanupPlan.runId === run.id &&
      run.backgroundCleanupPlan.decision === "exceptional-no-op"
    );
  }
  if (mode === "beautify") {
    return (
      run.beautifyPlan?.approval.status === "approved" &&
      run.beautifyPlan.runId === run.id &&
      run.beautifyPlan.decision === "exceptional-no-op"
    );
  }
  if (mode === "iris") {
    return (
      run.irisPlan?.approval.status === "approved" &&
      run.irisPlan.runId === run.id &&
      run.irisPlan.decision === "exceptional-no-op"
    );
  }
  return false;
}

export function workflowModeLabel(
  mode: WorkflowMode
):
  | "Flora"
  | "Lamp"
  | "Lamp Background"
  | "Lamp Beautify"
  | "Lamp Iris"
  | "Lamp Combined" {
  if (mode === "flora") return "Flora";
  if (mode === "lamp") return "Lamp";
  if (mode === "background") return "Lamp Background";
  if (mode === "iris") return "Lamp Iris";
  if (mode === "combined") return "Lamp Combined";
  return "Lamp Beautify";
}

/** Short artifact verb for compact players and library thumbnails. */
export function workflowOutputLabel(mode: WorkflowMode): string {
  if (mode === "background") return "CLEANED";
  if (mode === "beautify") return "ENHANCED";
  if (mode === "iris") return "GAZE-CORRECTED";
  if (mode === "combined") return "FINISHED";
  return "RELIT";
}

/**
 * Missing mode is the immutable legacy rule: known workflow ids recover their
 * product identity; every other pre-mode record predates Lamp and is Flora.
 */
export function runWorkflowMode(
  run: Pick<Run, "workflowMode" | "workflowId">
): WorkflowMode {
  if (run.workflowMode) return run.workflowMode;
  if (run.workflowId === "lamp-iris-v1") return "iris";
  if (run.workflowId === "lamp-beautify-v1") return "beautify";
  if (run.workflowId === "lamp-background-v1") return "background";
  if (run.workflowId === "lamp-combined-v1") return "combined";
  return run.workflowId === "lamp-v1" ? "lamp" : "flora";
}

/** Every Lamp method produces at most two source-rooted generation attempts. */
export function isTwoPassWorkflowMode(
  mode: WorkflowMode
): mode is Extract<
  WorkflowMode,
  "lamp" | "background" | "beautify" | "iris" | "combined"
> {
  return (
    mode === "lamp" ||
    mode === "background" ||
    mode === "beautify" ||
    mode === "iris" ||
    mode === "combined"
  );
}

/**
 * Recover the immutable product method from a durable execution identity.
 * Unknown and pre-Lamp ids retain the historical Flora interpretation.
 */
export function workflowModeFromExecutionId(
  executionId: string
): WorkflowMode {
  if (executionId.startsWith(LAMP_COMBINED_EXECUTION_PREFIX)) {
    return "combined";
  }
  if (
    executionId.startsWith(LAMP_IRIS_EXECUTION_PREFIX) ||
    executionId.startsWith(LAMP_IRIS_BATCH_EXECUTION_PREFIX)
  ) {
    return "iris";
  }
  if (
    executionId.startsWith(LAMP_BEAUTIFY_EXECUTION_PREFIX) ||
    executionId.startsWith(LAMP_BEAUTIFY_BATCH_EXECUTION_PREFIX)
  ) {
    return "beautify";
  }
  if (
    executionId.startsWith(LAMP_BACKGROUND_EXECUTION_PREFIX) ||
    executionId.startsWith(LAMP_BACKGROUND_BATCH_EXECUTION_PREFIX)
  ) {
    return "background";
  }
  if (
    executionId.startsWith("lamp:") ||
    executionId.startsWith("lamp-batch:")
  ) {
    return "lamp";
  }
  return "flora";
}

export function isTwoPassExecutionId(executionId: string): boolean {
  return isTwoPassWorkflowMode(workflowModeFromExecutionId(executionId));
}

/** True once the run holds any spend, provider, judged, or graded state. */
export function runHasStartedWork(
  run: Pick<
    Run,
    "spendApproval" | "providerOperations" | "iterations" | "humanGrade"
  >
): boolean {
  return (
    run.spendApproval !== undefined ||
    (run.providerOperations?.length ?? 0) > 0 ||
    run.iterations.length > 0 ||
    run.humanGrade !== undefined
  );
}

/**
 * Flora is retired for new work. A Flora request is admitted only when the
 * targeted record already carries real Flora work — resumes and recoveries
 * keep working, but nothing new may start as Flora.
 */
export function floraRetiredForNewWork(
  requested: WorkflowMode,
  persisted: WorkflowMode | null
): boolean {
  return requested === "flora" && persisted !== "flora";
}

export const FLORA_RETIRED_RUN_ERROR =
  "Flora is retired for new runs. Start this clip with a current Lamp method; existing Flora runs remain viewable and resumable.";
export const FLORA_RETIRED_BATCH_ERROR =
  "Flora is retired for new batches. Recreate this batch as Lamp; already-started Flora batches can still recover.";
