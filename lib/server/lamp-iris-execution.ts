import "server-only";

import {
  hashLampIrisPlan,
  lampIrisPlanRequiresGeneration,
  lampIrisPlansDifferOnlyByIntensity,
  parseLampIrisPlan,
  type LampIrisPlan,
} from "@/lib/lamp-iris";
import { lampIrisPlanOperationId } from "@/lib/lamp-iris-operations";
import { isPersistedInitialLampIrisPrompt } from "@/lib/prompts/lamp-iris";
import {
  isLampIrisPlanArtifact,
  lampIrisPlanCanonicalInput,
} from "@/lib/server/lamp-iris-planner";
import { paidOperationInputHash } from "@/lib/server/paid-operation";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import type { PaidOperation, Run, RunExecution } from "@/lib/types";
import { runWorkflowMode } from "@/lib/workflow-mode";

export interface LampIrisPlanBindingInput {
  run: Run;
  planOperation: PaidOperation | null;
  planOperationId: string | undefined;
  approvedPlanHash: string | undefined;
  renderedPrompt: string;
}

/**
 * Prove that one Lamp Iris execution is bound to the exact planner result
 * the human approved. The planner journal contains the immutable draft; the
 * Run contains its human-approved copy; approval hashing deliberately excludes
 * approval metadata so both must resolve to the same content digest.
 */
export async function validateLampIrisPlanBinding(
  input: LampIrisPlanBindingInput
): Promise<LampIrisPlan> {
  if (runWorkflowMode(input.run) !== "iris") {
    throw new Error("Only Lamp Iris runs may use a gaze-correction-plan binding.");
  }
  if (
    input.planOperationId !== lampIrisPlanOperationId() ||
    input.planOperation?.id !== input.planOperationId ||
    input.planOperation.runId !== input.run.id ||
    input.planOperation.status !== "completed" ||
    !isLampIrisPlanArtifact(input.planOperation.result) ||
    input.planOperation.result.status !== "ready"
  ) {
    throw new Error(
      "Lamp Iris execution requires its completed canonical planner journal."
    );
  }
  const expectedPlanInputHash = paidOperationInputHash({
    operationId: lampIrisPlanOperationId(),
    payload: lampIrisPlanCanonicalInput(input.run.originalVideo.url),
  });
  if (input.planOperation.inputHash !== expectedPlanInputHash) {
    throw new Error(
      "Lamp Iris's planner journal does not match the canonical source and planning contract."
    );
  }
  if (
    typeof input.approvedPlanHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.approvedPlanHash)
  ) {
    throw new Error(
      "Lamp Iris execution requires a valid approved gaze-correction-plan hash."
    );
  }

  const approvedPlan = parseLampIrisPlan(input.run.irisPlan);
  const plannedDraft = parseLampIrisPlan(input.planOperation.result.plan);
  if (
    approvedPlan.approval.status !== "approved" ||
    approvedPlan.runId !== input.run.id ||
    plannedDraft.runId !== input.run.id ||
    !lampIrisPlanRequiresGeneration(approvedPlan) ||
    !lampIrisPlanRequiresGeneration(plannedDraft)
  ) {
    throw new Error(
      "Lamp Iris generation requires a human-approved gaze-correction plan for this exact run."
    );
  }

  // The approved copy may differ from the planner's immutable draft ONLY by
  // the human intensity slider; any other divergence is tampering. The
  // execution binds the hash of the plan as approved (slider included).
  const approvedHash = await hashLampIrisPlan(approvedPlan);
  if (
    approvedHash !== input.approvedPlanHash ||
    !lampIrisPlansDifferOnlyByIntensity(plannedDraft, approvedPlan)
  ) {
    throw new Error(
      "Lamp Iris's approved plan no longer matches its planner journal."
    );
  }

  if (
    !isPersistedInitialLampIrisPrompt(approvedPlan, input.renderedPrompt)
  ) {
    throw new Error(
      "Lamp Iris's persisted Initial prompt does not match the approved gaze-correction plan."
    );
  }
  return approvedPlan;
}

export async function validateLampIrisExecutionBinding(input: {
  run: Run;
  execution: RunExecution;
  planOperation: PaidOperation | null;
}): Promise<LampIrisPlan> {
  if (!input.execution.executionId.startsWith("lamp-iris:")) {
    throw new Error("This is not a Lamp Iris execution.");
  }
  if (
    input.execution.inputHash !==
    runExecutionInputHash(input.execution.renderedPrompt)
  ) {
    throw new Error(
      "Lamp Iris execution prompt bytes do not match their immutable input hash."
    );
  }
  return validateLampIrisPlanBinding({
    run: input.run,
    planOperation: input.planOperation,
    planOperationId: input.execution.planOperationId,
    approvedPlanHash: input.execution.approvedPlanHash,
    renderedPrompt: input.execution.renderedPrompt,
  });
}
