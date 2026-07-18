import "server-only";

import { start } from "workflow/api";
import { workflowRunLiveness } from "@/lib/server/dead-workflow-recovery";
import { initialMegaPrompt } from "@/lib/prompts/mega-prompt";
import { normalizeRelightIntensity } from "@/lib/relight-intensity";
import {
  batchApprovalStartedAt,
  batchApprovalScope,
  batchExecutionId,
  batchExecutionMode,
  batchMemberExecutionId,
  batchMaximumIterations,
  normalizedWorkflowMode,
} from "@/lib/server/batch-contract";
import {
  DURABLE_BATCH_CONCURRENCY,
  firstCutMaximumMicros,
  planBatchBudget,
  planFirstCutBudget,
  usdToMicros,
  type BatchBudgetPlan,
} from "@/lib/server/batch-budget";
import { assertRunId } from "@/lib/server/runstore";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import {
  BATCH_APPROVAL_LIFETIME_MS,
  assertVideoGenerationAuthorized,
  lampMaximumMicros,
} from "@/lib/server/spend-approval";
import { getStorage } from "@/lib/server/storage";
import { durableRelightBatch } from "@/workflows/durable-relight-batch";
import type {
  Batch,
  BatchExecution,
  Run,
  WorkflowMode,
} from "@/lib/types";

export interface EnqueueBatchExecutionResult {
  execution: BatchExecution;
  /** One non-paid parent Workflow contender was submitted by this request. */
  enqueued: boolean;
  contenderWorkflowRunId?: string;
}

export function firstCutsBatchExecutionId(batchId: string): string {
  return batchExecutionId(batchId, "flora");
}

export function firstCutMemberExecutionId(
  batchId: string,
  runId: string
): string {
  return batchMemberExecutionId(batchId, runId, "flora");
}

export function lampBatchExecutionId(batchId: string): string {
  return batchExecutionId(batchId, "lamp");
}

function assertCanonicalBatch(batch: Batch): void {
  assertRunId(batch.id);
  if (batch.runIds.length === 0) {
    throw new Error("A durable batch execution needs at least one run.");
  }
  const uniqueRunIds = new Set(batch.runIds);
  if (uniqueRunIds.size !== batch.runIds.length) {
    throw new Error("A durable batch execution cannot contain duplicate runs.");
  }
  for (const runId of batch.runIds) assertRunId(runId);
}

function assertSelectedRunApproval(
  run: Run,
  execution: BatchExecution,
  maxReservedMicros: number
): void {
  const mode = batchExecutionMode(execution);
  const expectedScope = batchApprovalScope(mode);
  const expectedIterations = batchMaximumIterations(mode);
  const approvalStartedAt = batchApprovalStartedAt(execution);
  const approval = run.spendApproval;
  if (
    !approval ||
    approval.source !== "batch" ||
    approval.scope !== expectedScope ||
    approval.batchId !== execution.batchId ||
    approval.runId !== run.id ||
    run.originalVideo.runId !== run.id ||
    approval.sourceUrl !== run.originalVideo.url ||
    Math.abs(approval.durationSec - run.originalVideo.durationSec) > 0.001 ||
    approval.maxIterations !== expectedIterations ||
    approval.approvedAt !== approvalStartedAt ||
    approval.expiresAt !==
      approvalStartedAt + BATCH_APPROVAL_LIFETIME_MS
  ) {
    throw new Error(
      `Run ${run.id} does not carry the admission-bound ${mode} approval for batch ${execution.batchId}.`
    );
  }
  assertVideoGenerationAuthorized(run, 1);
  if (usdToMicros(approval.maxUsd) !== maxReservedMicros) {
    throw new Error(`Run ${run.id}'s approval does not match its reservation.`);
  }
}

function buildExecution(
  batch: Batch,
  plan: BatchBudgetPlan,
  workflowMode: WorkflowMode,
  now: number
): BatchExecution {
  const selected = new Map(
    plan.selected.map((member) => [member.runId, member.reservedMicros])
  );
  const maximum =
    workflowMode === "lamp" ? lampMaximumMicros() : firstCutMaximumMicros();
  const relightIntensity =
    workflowMode === "lamp"
      ? normalizeRelightIntensity(batch.relightIntensity)
      : undefined;
  const renderedPrompt = initialMegaPrompt(
    workflowMode,
    relightIntensity
  ).rendered;
  return {
    batchId: batch.id,
    executionId: batchExecutionId(batch.id, workflowMode),
    workflowMode,
    ...(relightIntensity !== undefined ? { relightIntensity } : {}),
    renderedPrompt,
    inputHash: runExecutionInputHash(renderedPrompt),
    status: "queued",
    revision: 1,
    concurrency: DURABLE_BATCH_CONCURRENCY,
    budgetLimitMicros: plan.budgetLimitMicros,
    reservedMicros: plan.reservedMicros,
    settledMicros: 0,
    members: batch.runIds.map((runId, position) => ({
      runId,
      position,
      state: selected.has(runId) ? "queued" : "skipped_budget",
      maxReservedMicros: selected.get(runId) ?? maximum,
    })),
    startedAt: now,
    approvalStartedAt: now,
    updatedAt: now,
  };
}

function assertExecutionMatchesBatch(
  execution: BatchExecution,
  batch: Batch,
  workflowMode: WorkflowMode
): void {
  if (
    execution.batchId !== batch.id ||
    execution.executionId !== batchExecutionId(batch.id, workflowMode) ||
    batchExecutionMode(execution) !== workflowMode ||
    (workflowMode === "lamp" &&
      normalizeRelightIntensity(execution.relightIntensity) !==
        normalizeRelightIntensity(batch.relightIntensity)) ||
    execution.concurrency !== DURABLE_BATCH_CONCURRENCY ||
    execution.members.length !== batch.runIds.length
  ) {
    throw new Error("A different immutable execution plan already owns this batch.");
  }
  for (let index = 0; index < batch.runIds.length; index += 1) {
    const member = execution.members[index];
    if (
      member.runId !== batch.runIds[index] ||
      member.position !== index
    ) {
      throw new Error("The durable batch membership no longer matches the batch.");
    }
  }
}

function isOrderPreservingSubset(
  subset: string[],
  canonical: string[]
): boolean {
  let canonicalIndex = 0;
  for (const runId of subset) {
    while (
      canonicalIndex < canonical.length &&
      canonical[canonicalIndex] !== runId
    ) {
      canonicalIndex += 1;
    }
    if (canonicalIndex >= canonical.length) return false;
    canonicalIndex += 1;
  }
  return true;
}

function canonicalReadyUploadIds(batch: Batch): ReadonlySet<string> {
  return new Set(
    (batch.uploads ?? [])
      .filter(
        (item) =>
          item.status === "ready" &&
          item.video !== undefined &&
          item.video.runId === item.runId
      )
      .map((item) => item.runId)
  );
}

/**
 * Freeze the ordered membership and integer reservation plan while the
 * canonical Batch is still ready. A retry always returns the first durable
 * plan; current prices or a stale caller budget can never replace it.
 */
export async function prepareBatchExecution(batch: Batch): Promise<BatchExecution> {
  const id = assertRunId(batch.id);
  const workflowMode = normalizedWorkflowMode(batch.workflowMode);
  const storage = getStorage();
  const existing = await storage.getBatchExecution(id);
  if (existing) {
    if (
      existing.executionId !== batchExecutionId(id, workflowMode) ||
      batchExecutionMode(existing) !== workflowMode ||
      (workflowMode === "lamp" &&
        normalizeRelightIntensity(existing.relightIntensity) !==
          normalizeRelightIntensity(batch.relightIntensity))
    ) {
      throw new Error("A different durable execution already owns this batch.");
    }
    if (existing.concurrency !== DURABLE_BATCH_CONCURRENCY) {
      throw new Error(
        "The existing execution does not use the server-owned concurrency limit."
      );
    }
    return existing;
  }

  const canonical = (await storage.getBatches()).find((item) => item.id === id);
  if (!canonical) throw new Error("Batch not found.");
  assertCanonicalBatch(canonical);
  if (normalizedWorkflowMode(canonical.workflowMode) !== workflowMode) {
    throw new Error("The batch workflow mode changed before admission.");
  }
  if (
    workflowMode === "lamp" &&
    normalizeRelightIntensity(canonical.relightIntensity) !==
      normalizeRelightIntensity(batch.relightIntensity)
  ) {
    throw new Error("The batch relight strength changed before admission.");
  }
  if (canonical.status !== "ready") {
    throw new Error("The batch execution plan must be prepared while ready.");
  }
  assertCanonicalBatch(batch);
  const readyUploadIds = canonicalReadyUploadIds(canonical);
  if (
    batch.status !== "ready" ||
    !isOrderPreservingSubset(batch.runIds, canonical.runIds) ||
    batch.runIds.some((runId) => !readyUploadIds.has(runId))
  ) {
    throw new Error(
      "The selected runs must be an ordered, successfully uploaded subset of the durable ready batch."
    );
  }

  const plannedBatch: Batch = {
    ...canonical,
    runIds: [...batch.runIds],
    budgetUsd: batch.budgetUsd,
  };
  const reservation =
    workflowMode === "lamp" ? lampMaximumMicros() : firstCutMaximumMicros();
  const plan =
    workflowMode === "flora"
      ? planFirstCutBudget(plannedBatch.runIds, plannedBatch.budgetUsd)
      : planBatchBudget(
          plannedBatch.runIds,
          reservation,
          plannedBatch.budgetUsd
        );
  const created = await storage.createBatchExecution(
    buildExecution(plannedBatch, plan, workflowMode, Date.now())
  );
  if (!created.execution) {
    throw new Error("Batch changed before its execution plan was created.");
  }
  // Another ready-state request may have committed a different valid plan
  // between our first read and create CAS. That first immutable plan wins;
  // never compare it to or overwrite it with this contender's current prices.
  if (!created.created) {
    if (
      created.execution.executionId !== batchExecutionId(id, workflowMode) ||
      batchExecutionMode(created.execution) !== workflowMode ||
      (workflowMode === "lamp" &&
        normalizeRelightIntensity(created.execution.relightIntensity) !==
          normalizeRelightIntensity(plannedBatch.relightIntensity)) ||
      created.execution.concurrency !== DURABLE_BATCH_CONCURRENCY
    ) {
      throw new Error("A different durable execution already owns this batch.");
    }
    return created.execution;
  }
  assertExecutionMatchesBatch(created.execution, plannedBatch, workflowMode);
  return created.execution;
}

/**
 * Validate approvals against the already-frozen plan, then enqueue a non-paid
 * parent Workflow contender. Parent contenders self-elect through CAS.
 */
export async function enqueueBatchExecution(
  batchId: string
): Promise<EnqueueBatchExecutionResult> {
  const id = assertRunId(batchId);
  const storage = getStorage();
  const batch = (await storage.getBatches()).find((item) => item.id === id);
  if (!batch) throw new Error("Batch not found.");
  assertCanonicalBatch(batch);

  const execution = await storage.getBatchExecution(id);
  if (!execution) {
    throw new Error("Prepare the immutable batch execution plan before enqueueing it.");
  }
  if (
    execution.batchId !== id ||
    execution.executionId !==
      batchExecutionId(id, normalizedWorkflowMode(batch.workflowMode)) ||
    batchExecutionMode(execution) !== normalizedWorkflowMode(batch.workflowMode) ||
    (batchExecutionMode(execution) === "lamp" &&
      normalizeRelightIntensity(execution.relightIntensity) !==
        normalizeRelightIntensity(batch.relightIntensity)) ||
    execution.concurrency !== DURABLE_BATCH_CONCURRENCY
  ) {
    throw new Error("A different durable execution already owns this batch.");
  }
  if (execution.status === "done" || execution.status === "failed") {
    if (batch.status === "running") {
      const repaired = await storage.advanceBatch(
        {
          ...batch,
          status: "done",
          updatedAt: Math.max(Date.now(), batch.updatedAt ?? batch.createdAt),
        },
        "running"
      );
      if (!repaired.advanced && repaired.batch?.status !== "done") {
        throw new Error(
          "The trusted batch changed before terminal recovery completed."
        );
      }
    } else if (batch.status !== "done") {
      throw new Error(
        "A terminal execution cannot repair the trusted batch from its current state."
      );
    }
    return { execution, enqueued: false };
  }
  if (execution.status === "running") {
    // Dead-workflow adoption, step 2 of 2: when the bound parent workflow is
    // provably dead (external cancel, engine loss, a local dev server that
    // died with the process), release the binding and start a fresh
    // contender that resumes dispatch from the durable member states.
    // "alive" and "unknown" both fail open — a workflow that might still be
    // writing keeps its binding.
    if (execution.workflowRunId !== undefined) {
      const liveness = await workflowRunLiveness(execution.workflowRunId);
      if (
        liveness === "alive" ||
        liveness === "completed" ||
        liveness === "unknown"
      ) {
        return { execution, enqueued: false };
      }
      const released = await storage.advanceBatchExecution(
        {
          ...execution,
          workflowRunId: undefined,
          revision: execution.revision + 1,
          updatedAt: Math.max(Date.now(), execution.updatedAt),
        },
        execution.revision
      );
      if (!released.advanced || !released.execution) {
        return { execution: released.execution ?? execution, enqueued: false };
      }
      const adopted = await start(durableRelightBatch, [
        { batchId: id, executionId: execution.executionId },
      ]);
      return {
        execution: released.execution,
        enqueued: true,
        contenderWorkflowRunId: adopted.runId,
      };
    }
    // Released (or never bound after a crash) — submit a contender directly.
    const contender = await start(durableRelightBatch, [
      { batchId: id, executionId: execution.executionId },
    ]);
    return { execution, enqueued: true, contenderWorkflowRunId: contender.runId };
  }
  if (execution.status !== "queued") {
    return { execution, enqueued: false };
  }
  if (batch.status !== "running") {
    throw new Error("The trusted batch must be running before dispatch begins.");
  }

  await Promise.all(
    execution.members
      .filter((member) => member.state === "queued")
      .map(async (member) => {
      const run = await storage.getRun(member.runId);
      if (!run) throw new Error(`Run ${member.runId} was not found.`);
      assertSelectedRunApproval(run, execution, member.maxReservedMicros);
    })
  );

  const contender = await start(durableRelightBatch, [
    {
      batchId: id,
      executionId: execution.executionId,
    },
  ]);
  return {
    execution,
    enqueued: true,
    contenderWorkflowRunId: contender.runId,
  };
}
