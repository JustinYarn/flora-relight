import type { LampCombinedControls } from "./lamp-combined.ts";
import { parseLampCombinedControls } from "./lamp-combined.ts";
import { normalizeRelightIntensity } from "./relight-intensity.ts";
import { freshNodeStates } from "./run-factory.ts";
import type { Run, RunExecution, WorkflowMode } from "./types.ts";
import { workflowForMode } from "./workflow-def.ts";

/**
 * A no-spend preparation may retarget only the ingest skeleton. Once any
 * planner, approval, provider, evaluation, or human decision exists, the run
 * has crossed a product boundary and must keep its original method/settings.
 */
export function isPristinePreparedRun(
  run: Run,
  execution: RunExecution | null
): boolean {
  return (
    execution === null &&
    run.serverExecution === undefined &&
    run.status === "running" &&
    run.spendApproval === undefined &&
    (run.providerOperations?.length ?? 0) === 0 &&
    run.iterations.length === 0 &&
    run.humanGrade === undefined &&
    run.review === undefined &&
    run.finalVideo === undefined &&
    run.bestIterationIndex === undefined &&
    run.fallback === undefined &&
    Object.values(run.nodeStates).every((state) => state.status === "idle") &&
    run.backgroundCleanupPlan === undefined &&
    run.beautifyPlan === undefined &&
    run.irisPlan === undefined &&
    run.combinedPlan === undefined &&
    run.chainPlan === undefined
  );
}

/**
 * Freeze the user's pre-confirmation method and controls without creating any
 * plan, spend grant, execution, or provider journal.
 */
export function prepareRunForConfirmation(
  run: Run,
  workflowMode: WorkflowMode,
  relightIntensity?: number,
  combinedControls?: LampCombinedControls
): Run {
  const prepared = { ...run };
  delete prepared.relightIntensity;
  delete prepared.combinedControls;
  delete prepared.backgroundCleanupPlan;
  delete prepared.beautifyPlan;
  delete prepared.irisPlan;
  delete prepared.combinedPlan;

  const workflow = workflowForMode(workflowMode);
  prepared.workflowId = workflow.id;
  prepared.workflowMode = workflowMode;
  prepared.nodeStates = freshNodeStates(workflowMode);

  if (workflowMode === "lamp" || workflowMode === "combined") {
    prepared.relightIntensity = normalizeRelightIntensity(relightIntensity);
  }
  if (workflowMode === "combined") {
    prepared.combinedControls = parseLampCombinedControls(combinedControls);
  }
  return prepared;
}
