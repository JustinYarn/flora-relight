import "server-only";

import {
  hashLampBackgroundCleanupPlan,
  lampBackgroundPlanRequiresGeneration,
  parseLampBackgroundCleanupPlan,
  type LampBackgroundCleanupPlan,
} from "@/lib/lamp-background";
import { lampBackgroundPlanOperationId } from "@/lib/lamp-background-operations";
import { isPersistedInitialLampBackgroundPrompt } from "@/lib/prompts/lamp-background";
import {
  isLampBackgroundPlanArtifact,
  lampBackgroundPlanCanonicalInput,
} from "@/lib/server/lamp-background-planner";
import { paidOperationInputHash } from "@/lib/server/paid-operation";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import type { PaidOperation, Run, RunExecution } from "@/lib/types";
import { runWorkflowMode } from "@/lib/workflow-mode";

export interface LampBackgroundPlanBindingInput {
  run: Run;
  planOperation: PaidOperation | null;
  planOperationId: string | undefined;
  approvedPlanHash: string | undefined;
  renderedPrompt: string;
}

/**
 * Prove that one Lamp Background execution is bound to the exact planner
 * result the human approved. The planner journal contains the immutable draft;
 * the Run contains its human-approved copy; approval hashing deliberately
 * excludes approval metadata so both must resolve to the same content digest.
 */
export async function validateLampBackgroundPlanBinding(
  input: LampBackgroundPlanBindingInput
): Promise<LampBackgroundCleanupPlan> {
  if (runWorkflowMode(input.run) !== "background") {
    throw new Error("Only Lamp Background runs may use a cleanup-plan binding.");
  }
  if (
    input.planOperationId !== lampBackgroundPlanOperationId() ||
    input.planOperation?.id !== input.planOperationId ||
    input.planOperation.runId !== input.run.id ||
    input.planOperation.status !== "completed" ||
    !isLampBackgroundPlanArtifact(input.planOperation.result) ||
    input.planOperation.result.status !== "ready"
  ) {
    throw new Error(
      "Lamp Background execution requires its completed canonical planner journal."
    );
  }
  const expectedPlanInputHash = paidOperationInputHash({
    operationId: lampBackgroundPlanOperationId(),
    payload: lampBackgroundPlanCanonicalInput(
      input.run.originalVideo.url
    ),
  });
  if (input.planOperation.inputHash !== expectedPlanInputHash) {
    throw new Error(
      "Lamp Background's planner journal does not match the canonical source and planning contract."
    );
  }
  if (
    typeof input.approvedPlanHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.approvedPlanHash)
  ) {
    throw new Error(
      "Lamp Background execution requires a valid approved cleanup-plan hash."
    );
  }

  const approvedPlan = parseLampBackgroundCleanupPlan(
    input.run.backgroundCleanupPlan
  );
  const plannedDraft = parseLampBackgroundCleanupPlan(
    input.planOperation.result.plan
  );
  if (
    approvedPlan.approval.status !== "approved" ||
    approvedPlan.runId !== input.run.id ||
    plannedDraft.runId !== input.run.id ||
    !lampBackgroundPlanRequiresGeneration(approvedPlan) ||
    !lampBackgroundPlanRequiresGeneration(plannedDraft)
  ) {
    throw new Error(
      "Lamp Background generation requires a human-approved cleanup plan for this exact run."
    );
  }

  const [approvedHash, plannedHash] = await Promise.all([
    hashLampBackgroundCleanupPlan(approvedPlan),
    hashLampBackgroundCleanupPlan(plannedDraft),
  ]);
  if (
    approvedHash !== input.approvedPlanHash ||
    plannedHash !== input.approvedPlanHash
  ) {
    throw new Error(
      "Lamp Background's approved plan no longer matches its planner journal."
    );
  }

  // Accepts the current protected-region compile and the frozen legacy form —
  // executions enqueued before the 2026-07-16 prompt change hold legacy bytes.
  if (
    !isPersistedInitialLampBackgroundPrompt(approvedPlan, input.renderedPrompt)
  ) {
    throw new Error(
      "Lamp Background's persisted Initial prompt does not match the approved cleanup plan."
    );
  }
  return approvedPlan;
}

export async function validateLampBackgroundExecutionBinding(input: {
  run: Run;
  execution: RunExecution;
  planOperation: PaidOperation | null;
}): Promise<LampBackgroundCleanupPlan> {
  if (!input.execution.executionId.startsWith("lamp-background:")) {
    throw new Error("This is not a Lamp Background execution.");
  }
  if (
    input.execution.inputHash !==
    runExecutionInputHash(input.execution.renderedPrompt)
  ) {
    throw new Error(
      "Lamp Background execution prompt bytes do not match their immutable input hash."
    );
  }
  return validateLampBackgroundPlanBinding({
    run: input.run,
    planOperation: input.planOperation,
    planOperationId: input.execution.planOperationId,
    approvedPlanHash: input.execution.approvedPlanHash,
    renderedPrompt: input.execution.renderedPrompt,
  });
}
