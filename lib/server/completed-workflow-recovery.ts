/**
 * Provider-free policy for repairing a Lamp Combined execution after its
 * durable Workflow has already reached the terminal `completed` state.
 *
 * The caller supplies only two storage/CAS capabilities: verify-and-repair the
 * exact completed evidence, or seal incomplete evidence. There is deliberately
 * no enqueue or provider callback in this contract.
 */

import type { RunExecution } from "../types.ts";

/**
 * Read the exact planner journals needed by completed-workflow settlement.
 * A journal that is durably absent is incomplete evidence, while a rejected
 * read remains an infrastructure error and is deliberately allowed to throw.
 * That distinction lets the caller seal missing proof without mistaking a
 * temporary storage outage for evidence loss.
 */
export async function readCompletedCombinedPlannerEvidence<T>(
  operationIds: readonly string[] | undefined,
  readOperation: (operationId: string) => Promise<T | null>
): Promise<T[] | null> {
  if (!operationIds || operationIds.length === 0) return null;
  const operations = await Promise.all(operationIds.map(readOperation));
  return operations.some((operation) => operation === null)
    ? null
    : (operations as T[]);
}

export const COMBINED_COMPLETED_EVIDENCE_INCOMPLETE =
  "Lamp Combined's durable workflow completed, but its exact generation, evaluation, audio, and SyncNet receipts could not prove both candidates for settlement. No provider work was restarted; operator reconciliation is required.";

export type CompletedCombinedRecoveryOutcome =
  | "settled"
  | "evidence_incomplete"
  | "changed";

export interface CompletedCombinedRecoveryResult {
  outcome: CompletedCombinedRecoveryOutcome;
  execution: RunExecution | null;
  /** This recovery path has no enqueue/provider capability by construction. */
  enqueued: false;
}

export interface CompletedCombinedRecoveryDependencies {
  /** Existing exact-proof settlement verifier; it may only read journals + CAS. */
  repairSettlement: () => Promise<RunExecution | null>;
  /** Fail-closed CAS used only after the exact verifier declines settlement. */
  sealIncompleteEvidence: (
    execution: RunExecution,
    error: string
  ) => Promise<RunExecution | null>;
}

function sameCombinedOwner(
  observed: RunExecution,
  current: RunExecution
): boolean {
  return (
    current.runId === observed.runId &&
    current.executionId === observed.executionId &&
    current.executionId === `lamp-combined:${observed.runId}` &&
    current.source === "single" &&
    current.batchId === undefined &&
    current.workflowRunId === observed.workflowRunId &&
    current.renderedPrompt === observed.renderedPrompt &&
    current.inputHash === observed.inputHash &&
    current.approvedPlanHash === observed.approvedPlanHash &&
    current.relightIntensity === observed.relightIntensity &&
    JSON.stringify(current.combinedPlanOperationIds) ===
      JSON.stringify(observed.combinedPlanOperationIds)
  );
}

function isSettledCombinedExecution(execution: RunExecution): boolean {
  return (
    execution.status === "awaiting_review" &&
    execution.phase === "complete" &&
    execution.iteration === 2
  );
}

/**
 * Attempt settlement once from exact persisted evidence. If that verifier
 * cannot prove the candidates, seal the same immutable owner as
 * reconcile_required. A lost ownership/CAS race is reported without writing.
 */
export async function recoverCompletedCombinedEvidence(
  observed: RunExecution,
  dependencies: CompletedCombinedRecoveryDependencies
): Promise<CompletedCombinedRecoveryResult> {
  const repaired = await dependencies.repairSettlement();
  if (!repaired || !sameCombinedOwner(observed, repaired)) {
    return { outcome: "changed", execution: repaired, enqueued: false };
  }
  if (isSettledCombinedExecution(repaired)) {
    return { outcome: "settled", execution: repaired, enqueued: false };
  }
  if (repaired.status === "reconcile_required") {
    return {
      outcome: "evidence_incomplete",
      execution: repaired,
      enqueued: false,
    };
  }
  if (repaired.status !== "running") {
    return { outcome: "changed", execution: repaired, enqueued: false };
  }

  const sealed = await dependencies.sealIncompleteEvidence(
    repaired,
    COMBINED_COMPLETED_EVIDENCE_INCOMPLETE
  );
  if (!sealed || !sameCombinedOwner(observed, sealed)) {
    return { outcome: "changed", execution: sealed, enqueued: false };
  }
  if (isSettledCombinedExecution(sealed)) {
    // An exact settlement CAS won the race with the fail-closed seal.
    return { outcome: "settled", execution: sealed, enqueued: false };
  }
  if (sealed.status === "reconcile_required") {
    return {
      outcome: "evidence_incomplete",
      execution: sealed,
      enqueued: false,
    };
  }
  return { outcome: "changed", execution: sealed, enqueued: false };
}
