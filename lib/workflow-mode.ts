import type { Run, WorkflowMode } from "@/lib/types";

export const DEFAULT_WORKFLOW_MODE: WorkflowMode = "background";
export const LAMP_BACKGROUND_EXECUTION_PREFIX = "lamp-background:";
export const LAMP_BACKGROUND_BATCH_EXECUTION_PREFIX =
  "lamp-background-batch:";

export function parseWorkflowMode(value: unknown): WorkflowMode | null {
  return value === "flora" || value === "lamp" || value === "background"
    ? value
    : null;
}

export function workflowModeLabel(
  mode: WorkflowMode
): "Flora" | "Lamp" | "Lamp Background" {
  if (mode === "flora") return "Flora";
  if (mode === "lamp") return "Lamp";
  return "Lamp Background";
}

/**
 * Missing mode is the immutable legacy rule: known workflow ids recover their
 * product identity; every other pre-mode record predates Lamp and is Flora.
 */
export function runWorkflowMode(
  run: Pick<Run, "workflowMode" | "workflowId">
): WorkflowMode {
  if (run.workflowMode) return run.workflowMode;
  if (run.workflowId === "lamp-background-v1") return "background";
  return run.workflowId === "lamp-v1" ? "lamp" : "flora";
}

/** Both Lamp methods use the fixed Initial → critique → Final contract. */
export function isTwoPassWorkflowMode(
  mode: WorkflowMode
): mode is Extract<WorkflowMode, "lamp" | "background"> {
  return mode === "lamp" || mode === "background";
}

/**
 * Recover the immutable product method from a durable execution identity.
 * Unknown and pre-Lamp ids retain the historical Flora interpretation.
 */
export function workflowModeFromExecutionId(
  executionId: string
): WorkflowMode {
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
  "Flora is retired for new runs. Start this clip as a Lamp Background run; existing Flora runs remain viewable and resumable.";
export const FLORA_RETIRED_BATCH_ERROR =
  "Flora is retired for new batches. Recreate this batch as Lamp Background; already-started Flora batches can still recover.";
