/**
 * lib/server/dead-workflow-recovery.ts — adopt a single run whose durable
 * Workflow died WITHOUT writing its own failure record.
 *
 * recordExecutionFailure covers every failure the workflow can catch itself.
 * What it cannot cover is the workflow run being killed from outside — an
 * operator `workflow cancel`, an engine loss, a deleted deployment. The
 * RunExecution then says "running" forever while nothing will ever advance
 * it, and the detail page polls /api/runs/recover indefinitely.
 *
 * This module is that recover path's dead-workflow adopter. It never starts
 * provider work and never re-bills: its only writes are the same sealed
 * reconcile_required records the workflow itself would have written.
 * Lamp Combined additionally uses it to repair a settlement-only checkpoint
 * after Workflow is terminal `completed`; exact candidate proof is mandatory.
 *
 * When the stopped iteration's journal holds an unresolved provider handle,
 * one direct interactions.get probe classifies the outcome honestly:
 *   - permanent 400/404 → seal the journal with the provider-lost marker,
 *     which unlocks the human acknowledge-and-re-run recovery flow;
 *   - readable or transient → leave the journal untouched and record only
 *     the dead-workflow reason on the execution (operator-owned evidence).
 */

import { getRun as getWorkflowRun } from "workflow/api";
import type { Run, RunExecution } from "@/lib/types";
import { getStorage } from "@/lib/server/storage";
import { getGemini } from "@/lib/server/gemini";
import { hasPermanentPollHttpStatus } from "@/lib/server/run-execution-failure";
import {
  videoGenerationOperationId,
  writeVideoGenerationOperation,
} from "@/lib/server/videogen-operation";
import {
  classifyWorkflowRunLiveness,
  deadWorkflowExecutionError,
  deadWorkflowSealMessage,
  type WorkflowRunLiveness,
} from "./dead-workflow-messages";
import {
  recoverCompletedCombinedEvidence,
  type CompletedCombinedRecoveryDependencies,
  type CompletedCombinedRecoveryResult,
} from "./completed-workflow-recovery";

/**
 * Per-process throttle: the recover route polls every ~4s per open tab, and a
 * HEALTHY running execution would otherwise cost two Workflow API reads per
 * poll. One liveness check per run per lease window is plenty — a dead
 * workflow stays dead.
 */
const LIVENESS_CHECK_LEASE_MS = 60_000;
const livenessCheckedAt = new Map<string, number>();

/**
 * Liveness of one Vercel Workflow run, from the observability API. "unknown"
 * (an API hiccup) must be treated as alive by callers — fail open, never
 * seal or force-drop state that might still have a writer.
 */
export async function workflowRunLiveness(
  workflowRunId: string
): Promise<WorkflowRunLiveness> {
  try {
    const workflowRun = getWorkflowRun(workflowRunId);
    const exists = await workflowRun.exists;
    if (!exists) return "missing";
    const status = await workflowRun.status;
    return classifyWorkflowRunLiveness(exists, status);
  } catch {
    // Observability hiccups must never seal anything. Fail open.
    return "unknown";
  }
}

export interface WorkflowExecutionRecoveryOptions {
  /** Exact-proof, storage-only settlement for terminal Lamp Combined runs. */
  repairCompletedCombined?: CompletedCombinedRecoveryDependencies["repairSettlement"];
}

export type WorkflowExecutionRecoveryResult =
  | CompletedCombinedRecoveryResult
  | {
      outcome: "dead_reconciled";
      execution: RunExecution;
      enqueued: false;
    };

/**
 * Preserve the legacy dead-workflow adopter API for non-Combined callers.
 * A normally completed Workflow remains a no-op here; the richer HTTP path
 * below must explicitly provide the Combined exact-settlement capability.
 */
export async function reconcileDeadWorkflowExecution(
  execution: RunExecution,
  preloadedRun?: Run | null
): Promise<RunExecution | null> {
  const result = await recoverStoppedWorkflowExecution(execution, preloadedRun);
  return result?.execution ?? null;
}

/**
 * Rich recovery result for the HTTP adopter. Non-Combined callers omit the
 * settlement option and retain the prior behavior: a completed Workflow is
 * terminal but does not mutate its execution here.
 */
export async function recoverStoppedWorkflowExecution(
  execution: RunExecution,
  preloadedRun?: Run | null,
  options: WorkflowExecutionRecoveryOptions = {}
): Promise<WorkflowExecutionRecoveryResult | null> {
  if (execution.status !== "running" || !execution.workflowRunId) return null;
  const now = Date.now();
  const lastCheck = livenessCheckedAt.get(execution.runId) ?? 0;
  if (now - lastCheck < LIVENESS_CHECK_LEASE_MS) return null;
  livenessCheckedAt.set(execution.runId, now);
  const state = await workflowRunLiveness(execution.workflowRunId);
  if (state === "alive" || state === "unknown") return null;

  const storage = getStorage();
  if (state === "completed") {
    if (!options.repairCompletedCombined) return null;
    return recoverCompletedCombinedEvidence(execution, {
      repairSettlement: options.repairCompletedCombined,
      sealIncompleteEvidence: async (current, error) => {
        const advanced = await storage.advanceRunExecution(
          {
            ...current,
            status: "reconcile_required",
            revision: current.revision + 1,
            updatedAt: Math.max(Date.now(), current.updatedAt),
            error: error.slice(0, 2_000),
          },
          current.revision
        );
        return advanced.execution ?? null;
      },
    });
  }

  let stopReason = deadWorkflowExecutionError(state);

  const iteration = execution.iteration;
  if (iteration === 1 || iteration === 2) {
    const run = preloadedRun ?? (await storage.getRun(execution.runId));
    const operation = run?.providerOperations?.find(
      (item) => item.id === videoGenerationOperationId(iteration)
    );
    if (operation?.status === "reconcile_required" && operation.error) {
      // The workflow sealed the journal before dying; surface its reason.
      stopReason = operation.error;
    } else if (
      operation?.status === "in_progress" &&
      operation.providerInteractionId
    ) {
      try {
        await getGemini().interactions.get(operation.providerInteractionId);
        stopReason = deadWorkflowExecutionError(
          state,
          "Its provider interaction is still readable upstream; finalize or " +
            "cancel that interaction manually before any re-run."
        );
      } catch (error) {
        // A single probe has no streak or wall-clock bound behind it, so it
        // seals only on the strongest evidence: a NUMERIC 400/404 from the
        // provider. Message-text matches are not enough here — one wrapped
        // proxy error must never invite a re-billing flow.
        if (hasPermanentPollHttpStatus(error)) {
          const sealed = deadWorkflowSealMessage(
            state,
            error instanceof Error
              ? error.message.slice(0, 160)
              : "permanent provider rejection"
          );
          await writeVideoGenerationOperation(execution.runId, {
            ...operation,
            status: "reconcile_required",
            updatedAt: Date.now(),
            error: sealed,
          });
          stopReason = sealed;
        }
        // A transient probe fault keeps the generic dead-workflow reason.
      }
    }
  }

  const advanced = await storage.advanceRunExecution(
    {
      ...execution,
      status: "reconcile_required",
      revision: execution.revision + 1,
      updatedAt: Math.max(Date.now(), execution.updatedAt),
      error: stopReason.slice(0, 2_000),
    },
    execution.revision
  );
  return advanced.advanced && advanced.execution
    ? {
        outcome: "dead_reconciled",
        execution: advanced.execution,
        enqueued: false,
      }
    : null;
}
