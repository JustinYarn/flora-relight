import "server-only";

import {
  hashLampBeautifyPlan,
  lampBeautifyPlanRequiresGeneration,
  parseLampBeautifyPlan,
  type LampBeautifyPlan,
} from "@/lib/lamp-beautify";
import { lampBeautifyPlanOperationId } from "@/lib/lamp-beautify-operations";
import { isPersistedInitialLampBeautifyPrompt } from "@/lib/prompts/lamp-beautify";
import {
  isLampBeautifyPlanArtifact,
  lampBeautifyPlanCanonicalInput,
} from "@/lib/server/lamp-beautify-planner";
import { paidOperationInputHash } from "@/lib/server/paid-operation";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import type { PaidOperation, Run, RunExecution } from "@/lib/types";
import { runWorkflowMode } from "@/lib/workflow-mode";

export interface LampBeautifyPlanBindingInput {
  run: Run;
  planOperation: PaidOperation | null;
  planOperationId: string | undefined;
  approvedPlanHash: string | undefined;
  renderedPrompt: string;
}

/**
 * Prove that one Lamp Beautify execution is bound to the exact planner result
 * the human approved. The planner journal contains the immutable draft; the
 * Run contains its human-approved copy; approval hashing deliberately excludes
 * approval metadata so both must resolve to the same content digest.
 */
export async function validateLampBeautifyPlanBinding(
  input: LampBeautifyPlanBindingInput
): Promise<LampBeautifyPlan> {
  if (runWorkflowMode(input.run) !== "beautify") {
    throw new Error("Only Lamp Beautify runs may use an enhancement-plan binding.");
  }
  if (
    input.planOperationId !== lampBeautifyPlanOperationId() ||
    input.planOperation?.id !== input.planOperationId ||
    input.planOperation.runId !== input.run.id ||
    input.planOperation.status !== "completed" ||
    !isLampBeautifyPlanArtifact(input.planOperation.result) ||
    input.planOperation.result.status !== "ready"
  ) {
    throw new Error(
      "Lamp Beautify execution requires its completed canonical planner journal."
    );
  }
  const expectedPlanInputHash = paidOperationInputHash({
    operationId: lampBeautifyPlanOperationId(),
    payload: lampBeautifyPlanCanonicalInput(input.run.originalVideo.url),
  });
  if (input.planOperation.inputHash !== expectedPlanInputHash) {
    throw new Error(
      "Lamp Beautify's planner journal does not match the canonical source and planning contract."
    );
  }
  if (
    typeof input.approvedPlanHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.approvedPlanHash)
  ) {
    throw new Error(
      "Lamp Beautify execution requires a valid approved enhancement-plan hash."
    );
  }

  const approvedPlan = parseLampBeautifyPlan(input.run.beautifyPlan);
  const plannedDraft = parseLampBeautifyPlan(input.planOperation.result.plan);
  if (
    approvedPlan.approval.status !== "approved" ||
    approvedPlan.runId !== input.run.id ||
    plannedDraft.runId !== input.run.id ||
    !lampBeautifyPlanRequiresGeneration(approvedPlan) ||
    !lampBeautifyPlanRequiresGeneration(plannedDraft)
  ) {
    throw new Error(
      "Lamp Beautify generation requires a human-approved enhancement plan for this exact run."
    );
  }

  const [approvedHash, plannedHash] = await Promise.all([
    hashLampBeautifyPlan(approvedPlan),
    hashLampBeautifyPlan(plannedDraft),
  ]);
  if (
    approvedHash !== input.approvedPlanHash ||
    plannedHash !== input.approvedPlanHash
  ) {
    throw new Error(
      "Lamp Beautify's approved plan no longer matches its planner journal."
    );
  }

  if (
    !isPersistedInitialLampBeautifyPrompt(approvedPlan, input.renderedPrompt)
  ) {
    throw new Error(
      "Lamp Beautify's persisted Initial prompt does not match the approved enhancement plan."
    );
  }
  return approvedPlan;
}

export async function validateLampBeautifyExecutionBinding(input: {
  run: Run;
  execution: RunExecution;
  planOperation: PaidOperation | null;
}): Promise<LampBeautifyPlan> {
  if (!input.execution.executionId.startsWith("lamp-beautify:")) {
    throw new Error("This is not a Lamp Beautify execution.");
  }
  if (
    input.execution.inputHash !==
    runExecutionInputHash(input.execution.renderedPrompt)
  ) {
    throw new Error(
      "Lamp Beautify execution prompt bytes do not match their immutable input hash."
    );
  }
  return validateLampBeautifyPlanBinding({
    run: input.run,
    planOperation: input.planOperation,
    planOperationId: input.execution.planOperationId,
    approvedPlanHash: input.execution.approvedPlanHash,
    renderedPrompt: input.execution.renderedPrompt,
  });
}
