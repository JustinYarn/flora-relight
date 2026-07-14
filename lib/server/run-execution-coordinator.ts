import "server-only";

import { start } from "workflow/api";
import { initialMegaPrompt } from "@/lib/prompts/mega-prompt";
import {
  compileLampFinalPrompt,
  isLampEvaluationArtifact,
  lampEvaluationOperationId,
} from "@/lib/lamp-evaluation";
import { getStorage } from "@/lib/server/storage";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import { requeueLampExecutionAfterApproval } from "@/lib/server/run-execution-resume";
import { isGradeableVideoGeneration } from "@/lib/server/run-execution-failure";
import {
  hasReusableFirstCutApproval,
  hasReusableLampApproval,
} from "@/lib/server/spend-approval";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import { durableRelightRun } from "@/workflows/durable-relight-run";
import type { RunExecution } from "@/lib/types";

const MAX_SETTLEMENT_REPAIR_ATTEMPTS = 12;

export interface EnqueueRunExecutionInput {
  runId: string;
  executionId: string;
  source: RunExecution["source"];
  batchId?: string;
  /** Batch coordinators bind one exact prompt for every member. */
  renderedPrompt?: string;
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
      execution.inputHash !== runExecutionInputHash(input.renderedPrompt)
    ) {
      return execution;
    }

    const lamp = execution.executionId.startsWith("lamp:");
    const targetIteration = lamp ? 2 : 1;
    const operation = run.providerOperations?.find(
      (item) => item.id === videoGenerationOperationId(targetIteration)
    );
    let expectedPrompt = input.renderedPrompt;
    let finalEvaluationComplete = true;
    if (lamp) {
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
    }
    if (
      operation?.status !== "completed" ||
      !operation.result ||
      operation.renderedPrompt !== expectedPrompt ||
      !isGradeableVideoGeneration(operation) ||
      !finalEvaluationComplete
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

  let current = await storage.getRunExecution(input.runId);
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
    if (current.status === "user_action_required") {
      if (
        !input.executionId.startsWith("lamp:") ||
        !hasReusableLampApproval(run, input.source, input.batchId)
      ) {
        throw new Error(
          "Lamp is paused until a fresh exact two-pass approval is confirmed."
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
    input.executionId.startsWith("lamp:")
      ? hasReusableLampApproval(run, input.source, input.batchId)
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
    initialMegaPrompt(
      input.executionId.startsWith("lamp:") ? "lamp" : "flora"
    ).rendered;
  const created = current
    ? { created: false as const, execution: current }
    : await storage.createRunExecution({
        runId: input.runId,
        executionId: input.executionId,
        source: input.source,
        ...(input.batchId ? { batchId: input.batchId } : {}),
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
    created.execution.batchId !== input.batchId
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
