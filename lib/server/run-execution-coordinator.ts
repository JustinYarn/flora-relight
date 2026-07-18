import "server-only";

import { start } from "workflow/api";
import { initialMegaPrompt } from "@/lib/prompts/mega-prompt";
import { normalizeRelightIntensity } from "@/lib/relight-intensity";
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
import {
  isLampBeautifyEvaluationArtifact,
} from "@/lib/lamp-beautify-read";
import {
  lampBeautifyEvaluationOperationId,
} from "@/lib/lamp-beautify-operations";
import { compileLampBeautifyFinalPrompt } from "@/lib/prompts/lamp-beautify";
import {
  validateLampBeautifyPlanBinding,
} from "@/lib/server/lamp-beautify-execution";
import {
  isLampIrisEvaluationArtifact,
} from "@/lib/lamp-iris-read";
import {
  lampIrisEvaluationOperationId,
} from "@/lib/lamp-iris-operations";
import { compileLampIrisFinalPrompt } from "@/lib/prompts/lamp-iris";
import {
  hashLampCombinedPlan,
  type LampCombinedPlan,
} from "@/lib/lamp-combined";
import { lampCombinedCandidateReceiptMatches } from "@/lib/lamp-combined-candidate";
import { parseLampCombinedEvaluationArtifact } from "@/lib/lamp-combined-evaluation";
import { lampCombinedEvaluationOperationId } from "@/lib/lamp-combined-operations";
import { compileLampCombinedFinalPrompt } from "@/lib/prompts/lamp-combined";
import {
  validateLampCombinedExecutionBinding,
  validateLampCombinedPlanBinding,
} from "@/lib/server/lamp-combined-execution";
import { readCompletedCombinedPlannerEvidence } from "@/lib/server/completed-workflow-recovery";
import {
  validateLampIrisPlanBinding,
} from "@/lib/server/lamp-iris-execution";
import { getStorage } from "@/lib/server/storage";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import { requeueLampExecutionAfterApproval } from "@/lib/server/run-execution-resume";
import { isGradeableVideoGeneration } from "@/lib/server/run-execution-failure";
import {
  hasReusableFirstCutApproval,
  hasReusableLampBackgroundApproval,
  hasReusableLampBeautifyApproval,
  hasReusableLampIrisApproval,
  hasReusableLampApproval,
  hasReusableLampCombinedApproval,
} from "@/lib/server/spend-approval";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import {
  LIPSYNC_OPERATION_ID,
  v2CompletedRunRecoveryDecision,
  v2SyncSettlementVerified,
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
  /** Plan-first modes bind the exact approved planning journal and plan hash. */
  planOperationId?: string;
  /** Combined binds every enabled planner journal in canonical order. */
  combinedPlanOperationIds?: string[];
  approvedPlanHash?: string;
  /** Auditable Lamp target represented by renderedPrompt. */
  relightIntensity?: number;
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
  combinedPlanOperationIds?: string[];
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
      JSON.stringify(execution.combinedPlanOperationIds) !==
        JSON.stringify(input.combinedPlanOperationIds) ||
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
    let combinedSyncVerified: boolean | undefined;
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
    } else if (workflowMode === "beautify") {
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
            lampBeautifyEvaluationOperationId(1)
          ),
          storage.getPaidOperation(
            input.runId,
            lampBeautifyEvaluationOperationId(2)
          ),
        ]);
      let beautifyPlan;
      try {
        beautifyPlan = await validateLampBeautifyPlanBinding({
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
        !isLampBeautifyEvaluationArtifact(firstEvaluation.result, 1) ||
        firstEvaluation.result.planId !== beautifyPlan.id
      ) {
        return execution;
      }
      try {
        expectedPrompt = compileLampBeautifyFinalPrompt(
          input.renderedPrompt,
          beautifyPlan,
          firstEvaluation.result
        ).rendered;
      } catch {
        return execution;
      }
      finalEvaluationComplete =
        finalEvaluation?.status === "completed" &&
        isLampBeautifyEvaluationArtifact(finalEvaluation.result, 2) &&
        finalEvaluation.result.planId === beautifyPlan.id;
    } else if (workflowMode === "iris") {
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
            lampIrisEvaluationOperationId(1)
          ),
          storage.getPaidOperation(
            input.runId,
            lampIrisEvaluationOperationId(2)
          ),
        ]);
      let irisPlan;
      try {
        irisPlan = await validateLampIrisPlanBinding({
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
        !isLampIrisEvaluationArtifact(firstEvaluation.result, 1) ||
        firstEvaluation.result.planId !== irisPlan.id
      ) {
        return execution;
      }
      try {
        expectedPrompt = compileLampIrisFinalPrompt(
          input.renderedPrompt,
          irisPlan,
          firstEvaluation.result
        ).rendered;
      } catch {
        return execution;
      }
      finalEvaluationComplete =
        finalEvaluation?.status === "completed" &&
        isLampIrisEvaluationArtifact(finalEvaluation.result, 2) &&
        finalEvaluation.result.planId === irisPlan.id;
    } else if (workflowMode === "combined") {
      const [plannerOperations, firstEvaluation, finalEvaluation, lipsync] =
        await Promise.all([
          readCompletedCombinedPlannerEvidence(
            execution.combinedPlanOperationIds,
            (operationId) =>
              storage.getPaidOperation(input.runId, operationId)
          ),
          storage.getPaidOperation(
            input.runId,
            lampCombinedEvaluationOperationId(1)
          ),
          storage.getPaidOperation(
            input.runId,
            lampCombinedEvaluationOperationId(2)
          ),
          storage.getPaidOperation(input.runId, LIPSYNC_OPERATION_ID),
        ]);
      if (!plannerOperations) return execution;
      let combinedPlan: LampCombinedPlan;
      try {
        combinedPlan = await validateLampCombinedExecutionBinding({
          run,
          execution,
          planOperations: plannerOperations,
        });
      } catch {
        return execution;
      }
      if (
        firstEvaluation?.status !== "completed" ||
        finalEvaluation?.status !== "completed"
      ) {
        return execution;
      }
      try {
        const [planHash, firstArtifact, finalArtifact] = await Promise.all([
          hashLampCombinedPlan(combinedPlan),
          parseLampCombinedEvaluationArtifact(firstEvaluation.result, {
            plan: combinedPlan,
            iteration: 1,
          }),
          parseLampCombinedEvaluationArtifact(finalEvaluation.result, {
            plan: combinedPlan,
            iteration: 2,
          }),
        ]);
        expectedPrompt = (
          await compileLampCombinedFinalPrompt(
            input.renderedPrompt,
            combinedPlan,
            execution.relightIntensity,
            firstArtifact
          )
        ).rendered;
        const initialGeneration = run.providerOperations?.find(
          (item) => item.id === videoGenerationOperationId(1)
        );
        const finalGeneration = run.providerOperations?.find(
          (item) => item.id === videoGenerationOperationId(2)
        );
        const initialReceipt = execution.combinedCandidateReceipts?.initial;
        const finalReceipt = execution.combinedCandidateReceipts?.final;
        finalEvaluationComplete = finalArtifact.planHash === planHash;
        combinedSyncVerified = Boolean(
          initialGeneration &&
            finalGeneration &&
            initialReceipt &&
            finalReceipt &&
            lampCombinedCandidateReceiptMatches({
              receipt: initialReceipt,
              generationOperation: initialGeneration,
              evaluationOperation: firstEvaluation,
              planId: combinedPlan.id,
              planHash,
              sourceHasAudio: run.originalVideo.hasAudio,
              canonicalSourceSync: run.originalVideo.syncBaseline,
              lipsyncOperation: null,
            }) &&
            lampCombinedCandidateReceiptMatches({
              receipt: finalReceipt,
              generationOperation: finalGeneration,
              evaluationOperation: finalEvaluation,
              planId: combinedPlan.id,
              planHash,
              sourceHasAudio: run.originalVideo.hasAudio,
              canonicalSourceSync: run.originalVideo.syncBaseline,
              lipsyncOperation: lipsync,
            })
        );
      } catch {
        return execution;
      }
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
      !finalEvaluationComplete
    ) {
      return execution;
    }
    const syncVerified =
      workflowMode === "combined"
        ? combinedSyncVerified === true
        : v2SyncSettlementVerified({
            runId: input.runId,
            candidateVerdict: execution.candidateSyncVerdict,
            finalGeneration: operation,
            lipsync,
            canonicalSourceSync: run.originalVideo.syncBaseline,
            sourceHasAudio: run.originalVideo.hasAudio,
          });
    if (
      v2CompletedRunRecoveryDecision(syncVerified) ===
      "hold_for_live_sync_gate"
    ) {
      // This repair helper is called by ordinary enqueue/status reads while a
      // healthy Workflow may be between free SyncNet analysis and its receipt
      // CAS. Holding the running record is fail-closed and leaves the live
      // owner free to journal proof; only the Workflow's actual failure path
      // may move a missing-proof execution to reconcile_required.
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
  const lamp = workflowMode === "lamp";
  const relightBound = lamp || workflowMode === "combined";
  if (
    workflowMode === "combined" &&
    (input.executionId !== `lamp-combined:${input.runId}` ||
      input.source !== "single" ||
      input.batchId !== undefined)
  ) {
    throw new Error("Lamp Combined execution is single-run only.");
  }
  const relightIntensity = relightBound
    ? normalizeRelightIntensity(
        input.relightIntensity ?? run.relightIntensity
      )
    : undefined;
  if (
    relightBound &&
    input.relightIntensity !== undefined &&
    relightIntensity !== normalizeRelightIntensity(run.relightIntensity)
  ) {
    throw new Error("The requested relight strength does not match this run.");
  }
  let current = await storage.getRunExecution(input.runId);
  const boundRenderedPrompt =
    input.renderedPrompt ?? current?.renderedPrompt;
  const boundPlanOperationId =
    input.planOperationId ?? current?.planOperationId;
  const boundCombinedPlanOperationIds =
    input.combinedPlanOperationIds ?? current?.combinedPlanOperationIds;
  const boundApprovedPlanHash =
    input.approvedPlanHash ?? current?.approvedPlanHash;
  const planMode =
    workflowMode === "background" ||
    workflowMode === "beautify" ||
    workflowMode === "iris";
  const combinedMode = workflowMode === "combined";
  if (
    planMode &&
    (!boundRenderedPrompt ||
      !boundPlanOperationId ||
      !boundApprovedPlanHash)
  ) {
    throw new Error(
      "Plan-based Lamp execution requires the server-compiled prompt and exact approved-plan binding."
    );
  }
  if (
    combinedMode &&
    (!boundRenderedPrompt ||
      !boundCombinedPlanOperationIds ||
      !boundApprovedPlanHash)
  ) {
    throw new Error(
      "Lamp Combined execution requires the compiled prompt and exact aggregate planner binding."
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
  } else if (workflowMode === "beautify") {
    const planOperation = await storage.getPaidOperation(
      input.runId,
      boundPlanOperationId!
    );
    await validateLampBeautifyPlanBinding({
      run,
      planOperation,
      planOperationId: boundPlanOperationId,
      approvedPlanHash: boundApprovedPlanHash,
      renderedPrompt: boundRenderedPrompt!,
    });
  } else if (workflowMode === "iris") {
    const planOperation = await storage.getPaidOperation(
      input.runId,
      boundPlanOperationId!
    );
    await validateLampIrisPlanBinding({
      run,
      planOperation,
      planOperationId: boundPlanOperationId,
      approvedPlanHash: boundApprovedPlanHash,
      renderedPrompt: boundRenderedPrompt!,
    });
  } else if (workflowMode === "combined") {
    const operations = await Promise.all(
      boundCombinedPlanOperationIds!.map(async (operationId) => {
        const operation = await storage.getPaidOperation(
          input.runId,
          operationId
        );
        if (!operation) throw new Error(`Missing Combined planner ${operationId}.`);
        return operation;
      })
    );
    await validateLampCombinedPlanBinding({
      run,
      renderedPrompt: boundRenderedPrompt!,
      approvedPlanHash: boundApprovedPlanHash,
      combinedPlanOperationIds: boundCombinedPlanOperationIds,
      planOperations: operations,
      relightIntensity,
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
      JSON.stringify(current.combinedPlanOperationIds) !==
      JSON.stringify(boundCombinedPlanOperationIds)
    ) {
      throw new Error(
        "A different aggregate planner set is already bound to this execution."
      );
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
        "A different approved plan is already bound to this execution."
      );
    }
    if (
      relightBound &&
      normalizeRelightIntensity(current.relightIntensity) !== relightIntensity
    ) {
      throw new Error(
        "A different relight strength is already bound to this run."
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
        (workflowMode === "beautify" &&
          !hasReusableLampBeautifyApproval(
            run,
            input.source,
            input.batchId
          )) ||
        (workflowMode === "iris" &&
          !hasReusableLampIrisApproval(
            run,
            input.source,
            input.batchId
          )) ||
        (workflowMode === "combined" &&
          !hasReusableLampCombinedApproval(
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
          ...(current.combinedPlanOperationIds
            ? {
                combinedPlanOperationIds:
                  current.combinedPlanOperationIds,
              }
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
        : workflowMode === "beautify"
          ? hasReusableLampBeautifyApproval(
              run,
              input.source,
              input.batchId
            )
          : workflowMode === "iris"
            ? hasReusableLampIrisApproval(
                run,
                input.source,
                input.batchId
              )
            : workflowMode === "combined"
              ? hasReusableLampCombinedApproval(
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
    initialMegaPrompt(
      lamp ? "lamp" : "flora",
      relightIntensity
    ).rendered;
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
        ...(boundCombinedPlanOperationIds
          ? { combinedPlanOperationIds: boundCombinedPlanOperationIds }
          : {}),
        ...(boundApprovedPlanHash
          ? { approvedPlanHash: boundApprovedPlanHash }
          : {}),
        status: "queued",
        phase: "queued",
        iteration: 0,
        renderedPrompt: canonicalPrompt,
        inputHash: runExecutionInputHash(canonicalPrompt),
        ...(relightIntensity !== undefined ? { relightIntensity } : {}),
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
    JSON.stringify(created.execution.combinedPlanOperationIds) !==
      JSON.stringify(boundCombinedPlanOperationIds) ||
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
