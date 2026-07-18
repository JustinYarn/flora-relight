import type { Run } from "./types.ts";
import { isPlanWorkflowMode, runWorkflowMode } from "./workflow-mode.ts";

/**
 * True when a persisted single-run approval should be adopted into a durable
 * execution. Draft and approved no-op plans intentionally stop in the browser
 * review flow and must never trigger a recovery POST.
 */
export function needsSingleExecutionAdoption(run: Run): boolean {
  const workflowMode = runWorkflowMode(run);
  if (isPlanWorkflowMode(workflowMode)) {
    const plan =
      workflowMode === "background"
        ? run.backgroundCleanupPlan
        : workflowMode === "beautify"
          ? run.beautifyPlan
          : run.irisPlan;
    if (
      !plan ||
      plan.approval.status !== "approved" ||
      plan.decision === "exceptional-no-op"
    ) {
      return false;
    }
  }
  if (
    !run.spendApproval ||
    run.spendApproval.source !== "single" ||
    run.spendApproval.batchId !== undefined
  ) {
    return false;
  }
  const execution = run.serverExecution;
  if (!execution) return true;
  return (
    execution.source === "single" &&
    (execution.status === "queued" ||
      execution.status === "running" ||
      execution.status === "user_action_required" ||
      execution.status === "reconcile_required")
  );
}
