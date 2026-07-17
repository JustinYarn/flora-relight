import "server-only";

import { start } from "workflow/api";
import { initialMegaPrompt } from "@/lib/prompts/mega-prompt";
import {
  compileLampFinalPrompt,
  isLampEvaluationArtifact,
  lampEvaluationOperationId,
} from "@/lib/lamp-evaluation";
import {
  isLampBackgroundEvaluationArtifact,
} from "@/lib/lamp-background-read";
import {
  lampBackgroundEvaluationOperationId,
} from "@/lib/lamp-background-operations";
import { compileLampBackgroundFinalPrompt } from "@/lib/prompts/lamp-background";
import {
  validateLampBackgroundPlanBinding,
} from "@/lib/server/lamp-background-execution";
import { getStorage } from "@/lib/server/storage";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import { requeueLampExecutionAfterApproval } from "@/lib/server/run-execution-resume";
import { isGradeableVideoGeneration } from "@/lib/server/run-execution-failure";
import {
  hasReusableFirstCutApproval,
  hasReusableLampBackgroundApproval,
  hasReusableLampApproval,
} from "@/lib/server/spend-approval";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import {
  isLipsyncOperationResult,
  LIPSYNC_OPERATION_ID,
  v2SyncVerdict,
} from "@/lib/v2-sync";
import { durableRelightRun } from "@/workflows/durable-relight-run";
import type { RunExecution } from "@/lib/types";
import { workflowModeFromExecutionId } from "@/lib/workflow-mode";

const MAX_SETTLEMENT_REPAIR_ATTEMPTS = 12;

export interface EnqueueRunExecutionInput {
  runId: string;
  executionId: string;
  source: RunExecution["source"];
  batchId?: string;
  /** Batch coordinators bind one exact prompt for every member. */
  renderedPrompt?: string;
  /** Lamp Background binds the exact approved planning journal and plan hash. */
  planOperationId?: string;
  approvedPlanHash?: string;
}

export interface EnqueueRunExecutionResult {
  execution: RunExecution;
  /** One non-paid contender was submitted to Workflow in this request. */
  enqueued: boolean;
  contenderWorkflowRunId?: string;
}

export interface RepairCompletedRunExecutionInput {
  runId: string;
  executionId: string;
  source: RunExecution["source"];
  batchId?: string;
  renderedPrompt: string;
  planOperationId?: string;
  approvedPlanHash?: string;
}

/**
 * Repair the non-billed settlement checkpoint when the exact provider
 * artifact was committed but the child Workflow died before moving its
 * RunExecution to awaiting_review. This never creates or retries provider
 * work; every immutable identity and prompt binding must already match.
 */
export async function repairCompletedRunExecution(
  input: RepairCompletedRunExecutionInput
): Promise<RunExecution | null> {
  const storage = getStorage();
  for (let attempt = 0; attempt < MAX_SETTLEMENT_REPAIR_ATTEMPTS; attempt += 1) {
    const [execution, run] = await Promise.all([
      storage.getRunExecution(input.runId),
      storage.getRun(input.runId),
    ]);
    if (!execution || !run) return null;
    if (
      execution.executionId !== input.executionId ||
      execution.source !== input.source ||
      execution.batchId !== input.batchId ||
      execution.renderedPrompt !== input.renderedPrompt ||
      execution.planOperationId !== input.planOperationId ||
      execution.approvedPlanHash !== input.approvedPlanHash ||
      execution.inputHash !== runExecutionInputHash(input.renderedPrompt)
    ) {
      return execution;
    }

    const workflowMode = workflowModeFromExecutionId(execution.executionId);
    const twoPass = workflowMode !== "flora";
    const targetIteration = twoPass ? 2 : 1;
    const operation = run.providerOperations?.find(
      (item) => item.id === videoGenerationOperationId(targetIteration)
    );
    let expectedPrompt = input.renderedPrompt;
    let finalEvaluationComplete = true;
    if (workflowMode === "lamp") {
      const [firstEvaluation, finalEvaluation] = await Promise.all([
        storage.getPaidOperation(input.runId, lampEvaluationOperationId(1)),
        storage.getPaidOperation(input.runId, lampEvaluationOperationId(2)),
      ]);
      if (
        firstEvaluation?.status !== "completed" ||
        !isLampEvaluationArtifact(firstEvaluation.result, 1)
      ) {
        return execution;
      }
      expectedPrompt = compileLampFinalPrompt(
        input.renderedPrompt,
        firstEvaluation.result
      ).rendered;
      finalEvaluationComplete =
        finalEvaluation?.status === "completed" &&
        isLampEvaluationArtifact(finalEvaluation.result, 2);
    } else if (workflowMode === "background") {
      const [planOperation, firstEvaluation, finalEvaluation] =
        await Promise.all([
          execution.planOperationId
            ? storage.getPaidOperation(
                input.runId,
                execution.planOperationId
              )
            : Promise.resolve(null),
          storage.getPaidOperation(
            input.runId,
            lampBackgroundEvaluationOperationId(1)
          ),
          storage.getPaidOperation(
            input.runId,
            lampBackgroundEvaluationOperationId(2)
          ),
        ]);
      let cleanupPlan;
      try {
        cleanupPlan = await validateLampBackgroundPlanBinding({
          run,
          planOperation,
          planOperationId: execution.planOperationId,
          approvedPlanHash: execution.approvedPlanHash,
          renderedPrompt: execution.renderedPrompt,
        });
      } catch {
        return execution;
      }
      if (
        firstEvaluation?.status !== "completed" ||
        !isLampBackgroundEvaluationArtifact(firstEvaluation.result, 1) ||
        firstEvaluation.result.cleanupPlanId !== cleanupPlan.id
      ) {
        return execution;
      }
      try {
        expectedPrompt = compileLampBackgroundFinalPrompt(
          input.renderedPrompt,
          cleanupPlan,
          firstEvaluation.result
        ).rendered;
      } catch {
        return execution;
      }
      finalEvaluationComplete =
        finalEvaluation?.status === "completed" &&
        isLampBackgroundEvaluationArtifact(finalEvaluation.result, 2) &&
        finalEvaluation.result.cleanupPlanId === cleanupPlan.id;
    }
    // The Final holistic evaluation now runs BEFORE the sync gate, so a
    // completed final evaluation no longer implies the gate passed. Any
    // journaled Lipsync repair must itself pass the effective gate (absolute,
    // or source-relative against the persisted baseline) before this repair
    // may present the artifact as reviewable.
    const lipsync = twoPass
      ? await storage.getPaidOperation(input.runId, LIPSYNC_OPERATION_ID)
      : null;
    if (
      operation?.status !== "completed" ||
      !operation.result ||
      operation.renderedPrompt !== expectedPrompt ||
      !isGradeableVideoGeneration(operation) ||
      !finalEvaluationComplete ||
      (lipsync !== null &&
        (lipsync.status !== "completed" ||
          !isLipsyncOperationResult(lipsync.result) ||
          !v2SyncVerdict(
            lipsync.result.postSync,
            run.originalVideo.syncBaseline ?? null
          ).pass))
    ) {
      return execution;
    }
    if (
      execution.status === "awaiting_review" &&
      execution.phase === "complete" &&
      execution.iteration === targetIteration
    ) {
      return execution;
    }
    if (
      execution.status !== "running" &&
      execution.status !== "reconcile_required"
    ) {
      return execution;
    }

    const candidate: RunExecution = {
      ...execution,
      status: "awaiting_review",
      phase: "complete",
      iteration: targetIteration,
      revision: execution.revision + 1,
      updatedAt: Math.max(Date.now(), execution.updatedAt),
      error: undefined,
    };
    const advanced = await storage.advanceRunExecution(
      candidate,
      execution.revision
    );
    if (advanced.advanced && advanced.execution) return advanced.execution;
    if (!advanced.execution) return null;
    if (
      advanced.execution.executionId !== input.executionId ||
      advanced.execution.renderedPrompt !== input.renderedPrompt
    ) {
      return advanced.execution;
    }
    // A same-owner checkpoint won the CAS. Re-read and either observe its
    // settlement or retry the idempotent repair against the newer revision.
  }
  throw new Error("Completed run settlement changed too often to repair safely.");
}

/**
 * Persist execution before enqueue. A response can be lost at any point:
 * retries may submit another non-paid Workflow contender, but the first step
 * inside durableRelightRun atomically self-binds one workflowRunId and every
 * loser exits before media preparation or a provider claim.
 */
export async function enqueueRunExecution(
  input: EnqueueRunExecutionInput
): Promise<EnqueueRunExecutionResult> {
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (!run) throw new Error("Run not found.");
  const workflowMode = workflowModeFromExecutionId(input.executionId);
  let current = await storage.getRunExecution(input.runId);
  const boundRenderedPrompt =
    input.renderedPrompt ?? current?.renderedPrompt;
  const boundPlanOperationId =
    input.planOperationId ?? current?.planOperationId;
  const boundApprovedPlanHash =
    input.approvedPlanHash ?? current?.approvedPlanHash;
  if (
    workflowMode === "background" &&
    (!boundRenderedPrompt ||
      !boundPlanOperationId ||
      !boundApprovedPlanHash)
  ) {
    throw new Error(
      "Lamp Background execution requires the server-compiled prompt and exact approved-plan binding."
    );
  }
  if (workflowMode === "background") {
    const planOperation = await storage.getPaidOperation(
      input.runId,
      boundPlanOperationId!
    );
    await validateLampBackgroundPlanBinding({
      run,
      planOperation,
      planOperationId: boundPlanOperationId,
      approvedPlanHash: boundApprovedPlanHash,
      renderedPrompt: boundRenderedPrompt!,
    });
  }
  if (current) {
    if (
      current.executionId !== input.executionId ||
      current.source !== input.source ||
      current.batchId !== input.batchId
    ) {
      throw new Error("A different durable execution already owns this run.");
    }
    if (
      input.renderedPrompt !== undefined &&
      current.renderedPrompt !== input.renderedPrompt
    ) {
      throw new Error("A different exact prompt is already bound to this run.");
    }
    if (
      current.planOperationId !== boundPlanOperationId ||
      current.approvedPlanHash !== boundApprovedPlanHash
    ) {
      throw new Error(
        "A different cleanup plan is already bound to this execution."
      );
    }
    if (current.status === "user_action_required") {
      if (
        (workflowMode === "lamp" &&
          !hasReusableLampApproval(run, input.source, input.batchId)) ||
        (workflowMode === "background" &&
          !hasReusableLampBackgroundApproval(
            run,
            input.source,
            input.batchId
          )) ||
        workflowMode === "flora"
      ) {
        throw new Error(
          "This two-pass run is paused until a fresh exact approval is confirmed."
        );
      }
      const rearmed = await storage.advanceRunExecution(
        requeueLampExecutionAfterApproval(current),
        current.revision
      );
      if (!rearmed.execution) {
        throw new Error("Lamp disappeared while its approval was renewed.");
      }
      current = rearmed.execution;
      if (
        current.executionId !== input.executionId ||
        current.source !== input.source ||
        current.batchId !== input.batchId
      ) {
        throw new Error(
          "Lamp changed ownership while its approval was renewed."
        );
      }
      if (current.status !== "queued") {
        if (current.status === "user_action_required") {
          throw new Error(
            "Lamp approval renewal changed concurrently; retry confirmation."
          );
        }
        // A concurrent confirmation already re-armed and dispatched this same
        // execution. Its contender owns progress; this request is a safe no-op.
        return { execution: current, enqueued: false };
      }
    }
    if (current.status !== "queued") {
      current =
        (await repairCompletedRunExecution({
          runId: input.runId,
          executionId: input.executionId,
          source: input.source,
          ...(input.batchId ? { batchId: input.batchId } : {}),
          renderedPrompt: current.renderedPrompt,
          ...(current.planOperationId
            ? { planOperationId: current.planOperationId }
            : {}),
          ...(current.approvedPlanHash
            ? { approvedPlanHash: current.approvedPlanHash }
            : {}),
        })) ?? current;
      return { execution: current, enqueued: false };
    }
  }

  // Only creating/enqueuing a queued execution can reach a new paid start.
  // Free recovery of an existing non-queued execution above remains possible
  // after approval expiry.
  if (!run.spendApproval) {
    throw new Error("Live spend was not approved for this run.");
  }
  const reusableApproval =
    workflowMode === "lamp"
      ? hasReusableLampApproval(run, input.source, input.batchId)
      : workflowMode === "background"
        ? hasReusableLampBackgroundApproval(
            run,
            input.source,
            input.batchId
          )
        : hasReusableFirstCutApproval(
            run,
            input.source === "batch" ? "batch" : "single",
            input.batchId
          );
  if (!reusableApproval) {
    throw new Error(
      "The durable spend approval is expired or does not match this execution and canonical source."
    );
  }

  const now = Date.now();
  const canonicalPrompt =
    input.renderedPrompt ??
    initialMegaPrompt(workflowMode === "lamp" ? "lamp" : "flora").rendered;
  const created = current
    ? { created: false as const, execution: current }
    : await storage.createRunExecution({
        runId: input.runId,
        executionId: input.executionId,
        source: input.source,
        ...(input.batchId ? { batchId: input.batchId } : {}),
        ...(boundPlanOperationId
          ? { planOperationId: boundPlanOperationId }
          : {}),
        ...(boundApprovedPlanHash
          ? { approvedPlanHash: boundApprovedPlanHash }
          : {}),
        status: "queued",
        phase: "queued",
        iteration: 0,
        renderedPrompt: canonicalPrompt,
        inputHash: runExecutionInputHash(canonicalPrompt),
        revision: 1,
        startedAt: now,
        updatedAt: now,
      });
  if (!created.execution) {
    throw new Error("Run disappeared before durable execution was created.");
  }
  if (
    created.execution.executionId !== input.executionId ||
    created.execution.source !== input.source ||
    created.execution.batchId !== input.batchId ||
    created.execution.planOperationId !== boundPlanOperationId ||
    created.execution.approvedPlanHash !== boundApprovedPlanHash
  ) {
    throw new Error("A different durable execution won this run.");
  }
  if (created.execution.status !== "queued") {
    return { execution: created.execution, enqueued: false };
  }

  const contender = await start(durableRelightRun, [
    {
      runId: input.runId,
      executionId: input.executionId,
      renderedPrompt: created.execution.renderedPrompt,
    },
  ]);
  return {
    execution: created.execution,
    enqueued: true,
    contenderWorkflowRunId: contender.runId,
  };
}
