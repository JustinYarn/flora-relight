import type {
  BatchExecution,
  PaidOperation,
  Run,
  RunExecution,
} from "../../types";

const ACTIVE_EXECUTION_STATUSES = new Set<RunExecution["status"]>([
  "queued",
  "running",
  "reconcile_required",
]);

function isActiveProviderStatus(status: string): boolean {
  return status === "in_progress" || status === "reconcile_required";
}

/**
 * A normal user deletion must never erase the only durable handle for work
 * that may already have incurred spend. Reconciliation/force-delete is a
 * separate operator concern; the ordinary route stays fail-closed.
 */
export class ActiveRunDeletionError extends Error {
  constructor() {
    super("Run work is still active or requires reconciliation.");
    this.name = "ActiveRunDeletionError";
  }
}

export function hasDeletionBlockingRunWork(
  run: Pick<Run, "providerOperations"> | null,
  execution: Pick<RunExecution, "status"> | null,
  paidOperations: Array<Pick<PaidOperation, "status">> = []
): boolean {
  const providerOperations = run?.providerOperations;
  return Boolean(
    (execution && ACTIVE_EXECUTION_STATUSES.has(execution.status)) ||
      (providerOperations !== undefined &&
        (!Array.isArray(providerOperations) ||
          providerOperations.some((operation) =>
            isActiveProviderStatus(operation.status)
          ))) ||
      paidOperations.some((operation) =>
        isActiveProviderStatus(operation.status)
      )
  );
}

export function hasDeletionBlockingBatchWork(
  runId: string,
  executions: BatchExecution[]
): boolean {
  return executions.some((execution) => {
    const member = execution.members.find(
      (candidate) => candidate.runId === runId
    );
    if (!member) return false;
    if (member.state === "reconcile_required") return true;
    return execution.status === "queued" || execution.status === "running";
  });
}
