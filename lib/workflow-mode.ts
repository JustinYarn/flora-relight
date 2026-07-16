import type { Run, WorkflowMode } from "@/lib/types";

export const DEFAULT_WORKFLOW_MODE: WorkflowMode = "lamp";

export function parseWorkflowMode(value: unknown): WorkflowMode | null {
  return value === "flora" || value === "lamp" ? value : null;
}

export function workflowModeLabel(mode: WorkflowMode): "Flora" | "Lamp" {
  return mode === "flora" ? "Flora" : "Lamp";
}

/**
 * Missing mode is the immutable legacy rule: only the lamp-v1 workflow id
 * marks Lamp; every other pre-mode record predates Lamp and is Flora.
 */
export function runWorkflowMode(
  run: Pick<Run, "workflowMode" | "workflowId">
): WorkflowMode {
  return run.workflowMode ?? (run.workflowId === "lamp-v1" ? "lamp" : "flora");
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
  "Flora is retired for new runs. Start this clip as a Lamp run; existing Flora runs remain viewable and resumable.";
export const FLORA_RETIRED_BATCH_ERROR =
  "Flora is retired for new batches. Recreate this batch as Lamp; already-started Flora batches can still recover.";
