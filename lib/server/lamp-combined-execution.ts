import "server-only";

import {
  assertLampCombinedPlanBinding,
  buildLampCombinedPlan,
  hashLampCombinedPlan,
  parseLampCombinedControls,
  parseLampCombinedPlan,
  type LampCombinedPlan,
} from "@/lib/lamp-combined";
import {
  lampCombinedPlanOperationIds,
  LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
  LAMP_COMBINED_BEAUTIFY_PLAN_OPERATION_ID,
  LAMP_COMBINED_IRIS_PLAN_OPERATION_ID,
} from "@/lib/lamp-combined-operations";
import { isPersistedInitialLampCombinedPrompt } from "@/lib/prompts/lamp-combined";
import {
  isLampBackgroundPlanArtifact,
  lampBackgroundPlanCanonicalInput,
} from "@/lib/server/lamp-background-planner";
import {
  isLampBeautifyPlanArtifact,
  lampBeautifyPlanCanonicalInput,
} from "@/lib/server/lamp-beautify-planner";
import {
  isLampIrisPlanArtifact,
  lampIrisPlanCanonicalInput,
} from "@/lib/server/lamp-iris-planner";
import { paidOperationInputHash } from "@/lib/server/paid-operation";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import type { PaidOperation, Run, RunExecution } from "@/lib/types";
import { runWorkflowMode } from "@/lib/workflow-mode";

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function completedPlanner(
  run: Run,
  operations: Map<string, PaidOperation>,
  operationId: string
): PaidOperation {
  const operation = operations.get(operationId);
  if (
    !operation ||
    operation.id !== operationId ||
    operation.runId !== run.id ||
    operation.provider !== "gemini" ||
    operation.kind !== "plan" ||
    operation.status !== "completed"
  ) {
    throw new Error(
      `Lamp Combined execution requires completed planner journal ${operationId}.`
    );
  }
  return operation;
}

/**
 * Prove the aggregate approval against every exact enabled planner journal,
 * the canonical source, the separate relight control, and the persisted v1
 * prompt bytes. Disabled planner calls are not part of the execution identity.
 */
export async function validateLampCombinedPlanBinding(input: {
  run: Run;
  renderedPrompt: string;
  approvedPlanHash: string | undefined;
  combinedPlanOperationIds: readonly string[] | undefined;
  planOperations: readonly PaidOperation[];
  relightIntensity: number | undefined;
}): Promise<LampCombinedPlan> {
  if (runWorkflowMode(input.run) !== "combined") {
    throw new Error("Only Lamp Combined runs may use an aggregate-plan binding.");
  }
  const controls = parseLampCombinedControls(input.run.combinedControls);
  const approvedPlan = assertLampCombinedPlanBinding(
    parseLampCombinedPlan(input.run.combinedPlan),
    {
      runId: input.run.id,
      relightIntensity: input.relightIntensity,
      controls,
    }
  );
  if (approvedPlan.approval.status !== "approved") {
    throw new Error(
      "Lamp Combined generation requires one human-approved aggregate plan."
    );
  }
  const expectedOperationIds = lampCombinedPlanOperationIds(controls);
  if (
    !input.combinedPlanOperationIds ||
    !arraysEqual(input.combinedPlanOperationIds, expectedOperationIds)
  ) {
    throw new Error(
      "Lamp Combined execution does not bind the exact enabled planner set."
    );
  }
  if (
    typeof input.approvedPlanHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.approvedPlanHash)
  ) {
    throw new Error("Lamp Combined execution requires an approved plan hash.");
  }
  const operations = new Map(input.planOperations.map((item) => [item.id, item]));
  if (operations.size !== expectedOperationIds.length) {
    throw new Error("Lamp Combined planner journal set is incomplete or duplicated.");
  }

  const backgroundOperation = completedPlanner(
    input.run,
    operations,
    LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID
  );
  if (
    backgroundOperation.inputHash !==
      paidOperationInputHash({
        operationId: LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
        payload: lampBackgroundPlanCanonicalInput(input.run.originalVideo.url),
      }) ||
    !isLampBackgroundPlanArtifact(backgroundOperation.result) ||
    backgroundOperation.result.status !== "ready"
  ) {
    throw new Error(
      "Lamp Combined Background planner journal does not match the canonical source."
    );
  }

  let beautifyPlan: unknown;
  if (controls.beautifyLevel > 0) {
    const operation = completedPlanner(
      input.run,
      operations,
      LAMP_COMBINED_BEAUTIFY_PLAN_OPERATION_ID
    );
    if (
      operation.inputHash !==
        paidOperationInputHash({
          operationId: LAMP_COMBINED_BEAUTIFY_PLAN_OPERATION_ID,
          payload: lampBeautifyPlanCanonicalInput(input.run.originalVideo.url),
        }) ||
      !isLampBeautifyPlanArtifact(operation.result) ||
      operation.result.status !== "ready"
    ) {
      throw new Error(
        "Lamp Combined Beautify planner journal does not match the canonical source."
      );
    }
    beautifyPlan = operation.result.plan;
  }

  let irisPlan: unknown;
  if (controls.eyeContact) {
    const operation = completedPlanner(
      input.run,
      operations,
      LAMP_COMBINED_IRIS_PLAN_OPERATION_ID
    );
    if (
      operation.inputHash !==
        paidOperationInputHash({
          operationId: LAMP_COMBINED_IRIS_PLAN_OPERATION_ID,
          payload: lampIrisPlanCanonicalInput(input.run.originalVideo.url),
        }) ||
      !isLampIrisPlanArtifact(operation.result) ||
      operation.result.status !== "ready"
    ) {
      throw new Error(
        "Lamp Combined Iris planner journal does not match the canonical source."
      );
    }
    irisPlan = operation.result.plan;
  }

  const plannedDraft = buildLampCombinedPlan({
    planId: approvedPlan.id,
    runId: input.run.id,
    createdAt: approvedPlan.createdAt,
    controls,
    backgroundPlan: backgroundOperation.result.plan,
    ...(beautifyPlan ? { beautifyPlan } : {}),
    ...(irisPlan ? { irisPlan } : {}),
  });
  const [approvedHash, plannedHash] = await Promise.all([
    hashLampCombinedPlan(approvedPlan),
    hashLampCombinedPlan(plannedDraft),
  ]);
  if (
    approvedHash !== input.approvedPlanHash ||
    plannedHash !== input.approvedPlanHash
  ) {
    throw new Error(
      "Lamp Combined's approved aggregate no longer matches its planner journals."
    );
  }
  if (
    !(await isPersistedInitialLampCombinedPrompt(
      input.renderedPrompt,
      approvedPlan,
      input.relightIntensity
    ))
  ) {
    throw new Error(
      "Lamp Combined's persisted Initial prompt does not match its approved aggregate and relight strength."
    );
  }
  return approvedPlan;
}

export async function validateLampCombinedExecutionBinding(input: {
  run: Run;
  execution: RunExecution;
  planOperations: readonly PaidOperation[];
}): Promise<LampCombinedPlan> {
  if (
    input.execution.executionId !== `lamp-combined:${input.run.id}` ||
    input.execution.source !== "single" ||
    input.execution.batchId !== undefined ||
    input.execution.planOperationId !== undefined ||
    input.execution.candidateSyncVerdict !== undefined ||
    input.execution.deliveredIteration !== undefined
  ) {
    throw new Error("This is not a canonical single-run Lamp Combined execution.");
  }
  if (
    input.execution.inputHash !==
    runExecutionInputHash(input.execution.renderedPrompt)
  ) {
    throw new Error(
      "Lamp Combined execution prompt bytes do not match their immutable input hash."
    );
  }
  return validateLampCombinedPlanBinding({
    run: input.run,
    renderedPrompt: input.execution.renderedPrompt,
    approvedPlanHash: input.execution.approvedPlanHash,
    combinedPlanOperationIds: input.execution.combinedPlanOperationIds,
    planOperations: input.planOperations,
    relightIntensity: input.execution.relightIntensity,
  });
}
