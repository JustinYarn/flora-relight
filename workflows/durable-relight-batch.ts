import { getWorkflowMetadata, sleep } from "workflow";
import {
  DURABLE_BATCH_CONCURRENCY,
  usdToMicros,
} from "@/lib/server/batch-budget";
import {
  enqueueRunExecution,
  repairCompletedRunExecution,
} from "@/lib/server/run-execution-coordinator";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import {
  BATCH_APPROVAL_LIFETIME_MS,
  assertVideoGenerationAuthorized,
} from "@/lib/server/spend-approval";
import { getStorage, type StorageDriver } from "@/lib/server/storage";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import type {
  BatchExecution,
  BatchExecutionMember,
  ProviderOperation,
  Run,
  RunExecution,
} from "@/lib/types";

export interface DurableRelightBatchInput {
  batchId: string;
  executionId: string;
}

export interface DurableRelightBatchResult {
  batchId: string;
  executionId: string;
  status: "not_owner" | "done" | "failed";
}

interface BindResult {
  status: "owner" | "not_owner" | "done" | "failed";
  skippedRunIds: string[];
}

interface DispatchSnapshot {
  owner: boolean;
  runningRunIds: string[];
}

interface BatchProgress {
  owner: boolean;
  allTerminal: boolean;
  stalledOnReconciliation: boolean;
}

const BATCH_BUDGET_SKIPPED = "BATCH_BUDGET_SKIPPED";
const BATCH_PRE_PROVIDER_FAILED = "BATCH_PRE_PROVIDER_FAILED";
const BATCH_DISPATCH_ABORTED = "BATCH_DISPATCH_ABORTED";
const FAST_BATCH_POLLS = 60 * 2; // First hour at 30 seconds.
const SLOW_BATCH_POLLS = 7 * 24 * 12 - 12; // Remaining 167 hours at five minutes.
const MAX_BATCH_POLLS = FAST_BATCH_POLLS + SLOW_BATCH_POLLS;
const MAX_CAS_ATTEMPTS = 20;

function expectedBatchExecutionId(batchId: string): string {
  return `first-cuts:${batchId}`;
}

function expectedMemberExecutionId(batchId: string, runId: string): string {
  return `batch:${batchId}:${runId}`;
}

function safeError(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : fallback).slice(0, 1_900);
}

function ownsBatchExecution(
  execution: BatchExecution | null,
  input: DurableRelightBatchInput,
  workflowRunId: string
): execution is BatchExecution {
  return Boolean(
    execution &&
      execution.batchId === input.batchId &&
      execution.executionId === input.executionId &&
      execution.executionId === expectedBatchExecutionId(input.batchId) &&
      execution.concurrency === DURABLE_BATCH_CONCURRENCY &&
      execution.workflowRunId === workflowRunId
  );
}

function operationForFirstCut(run: Run | null): ProviderOperation | undefined {
  return run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(1)
  );
}

function memberExecutionMatches(
  execution: RunExecution | null,
  batchId: string,
  runId: string
): execution is RunExecution {
  return Boolean(
    execution &&
      execution.runId === runId &&
      execution.executionId === expectedMemberExecutionId(batchId, runId) &&
      execution.source === "batch" &&
      execution.batchId === batchId
  );
}

function withMemberError(
  member: BatchExecutionMember,
  state: BatchExecutionMember["state"],
  error?: string,
  actualMicros?: number
): BatchExecutionMember {
  const next: BatchExecutionMember = { ...member, state };
  delete next.actualMicros;
  delete next.error;
  if (actualMicros !== undefined) next.actualMicros = actualMicros;
  if (error) next.error = error.slice(0, 2_000);
  return next;
}

function sameMember(
  left: BatchExecutionMember,
  right: BatchExecutionMember
): boolean {
  return (
    left.state === right.state &&
    left.actualMicros === right.actualMicros &&
    left.error === right.error
  );
}

function accountingForMembers(members: BatchExecutionMember[]): {
  reservedMicros: number;
  settledMicros: number;
} {
  let reservedMicros = 0;
  let settledMicros = 0;
  for (const member of members) {
    if (
      member.state === "queued" ||
      member.state === "running" ||
      member.state === "reconcile_required"
    ) {
      reservedMicros += member.maxReservedMicros;
    } else if (
      (member.state === "awaiting_review" || member.state === "failed") &&
      member.actualMicros !== undefined
    ) {
      settledMicros += member.actualMicros;
    }
  }
  if (
    !Number.isSafeInteger(reservedMicros) ||
    !Number.isSafeInteger(settledMicros)
  ) {
    throw new Error("Batch spend accounting exceeded the safe integer range.");
  }
  return { reservedMicros, settledMicros };
}

function progressForExecution(execution: BatchExecution): BatchProgress {
  const queued = execution.members.filter(
    (member) => member.state === "queued"
  ).length;
  const running = execution.members.filter(
    (member) => member.state === "running"
  ).length;
  const reconcile = execution.members.filter(
    (member) => member.state === "reconcile_required"
  ).length;
  return {
    owner: true,
    allTerminal: queued + running + reconcile === 0,
    stalledOnReconciliation:
      reconcile > 0 &&
      running === 0 &&
      (queued === 0 || reconcile >= DURABLE_BATCH_CONCURRENCY),
  };
}

/**
 * Generation-only parent: it schedules child durable run Workflows but never
 * performs provider work itself. Batch and child CAS records remain the only
 * dispatch/spend authority across replay, retries, and deployments.
 */
export async function durableRelightBatch(
  input: DurableRelightBatchInput
): Promise<DurableRelightBatchResult> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const bound = await bindBatchExecution(input, workflowRunId);
  if (bound.status === "not_owner") {
    return { ...input, status: "not_owner" };
  }
  if (bound.status === "done") {
    await advanceTrustedBatchDone(input);
    return { ...input, status: "done" };
  }
  if (bound.status === "failed") {
    await advanceTrustedBatchDone(input);
    throw new Error("Durable batch execution is already failed.");
  }

  try {
    for (const runId of bound.skippedRunIds) {
      await materializeBudgetSkippedRun(input, workflowRunId, runId);
    }

    for (let poll = 0; poll < MAX_BATCH_POLLS; poll += 1) {
      const dispatch = await claimDispatchSlots(input, workflowRunId);
      if (!dispatch.owner) return { ...input, status: "not_owner" };

      for (const runId of dispatch.runningRunIds) {
        try {
          await ensureMemberEnqueued(input, workflowRunId, runId);
        } catch (error) {
          await recordMemberEnqueueFailure(
            input,
            workflowRunId,
            runId,
            safeError(error, "The child Workflow could not be enqueued.")
          );
        }
      }

      const progress = await reconcileBatchMembers(input, workflowRunId);
      if (!progress.owner) return { ...input, status: "not_owner" };
      if (progress.allTerminal) {
        const status = await finishCompletedBatch(input, workflowRunId);
        if (status === "not_owner") return { ...input, status };
        if (status === "failed") {
          throw new Error("Durable batch execution failed during settlement.");
        }
        await advanceTrustedBatchDone(input);
        return { ...input, status };
      }
      if (progress.stalledOnReconciliation) {
        throw new Error(
          "Unresolved provider work exhausted the safe batch concurrency."
        );
      }

      await sleep(poll < FAST_BATCH_POLLS ? "30s" : "5m");
    }

    throw new Error(
      "Batch execution exceeded its seven-day reconciliation deadline."
    );
  } catch (error) {
    const failure = safeError(error, "Durable batch execution failed.");
    const status = await failUnresolvedBatch(
      input,
      workflowRunId,
      failure
    );
    if (status === "not_owner") return { ...input, status };
    await advanceTrustedBatchDone(input);
    if (status === "done") return { ...input, status };
    throw new Error(failure);
  }
}

async function bindBatchExecution(
  input: DurableRelightBatchInput,
  workflowRunId: string
): Promise<BindResult> {
  "use step";
  const storage = getStorage();
  const current = await storage.getBatchExecution(input.batchId);
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.executionId !== expectedBatchExecutionId(input.batchId)
  ) {
    return { status: "not_owner", skippedRunIds: [] };
  }
  const skippedRunIds = current.members
    .filter((member) => member.state === "skipped_budget")
    .map((member) => member.runId);
  if (current.workflowRunId) {
    if (current.workflowRunId !== workflowRunId) {
      return { status: "not_owner", skippedRunIds: [] };
    }
    if (current.status === "done" || current.status === "failed") {
      return { status: current.status, skippedRunIds };
    }
    return {
      status: current.status === "running" ? "owner" : "not_owner",
      skippedRunIds,
    };
  }
  if (current.status !== "queued") {
    return { status: "not_owner", skippedRunIds: [] };
  }
  const candidate: BatchExecution = {
    ...current,
    status: "running",
    workflowRunId,
    revision: current.revision + 1,
    updatedAt: Math.max(Date.now(), current.updatedAt),
  };
  const advanced = await storage.advanceBatchExecution(
    candidate,
    current.revision
  );
  const durable = advanced.execution;
  if (!ownsBatchExecution(durable, input, workflowRunId)) {
    return { status: "not_owner", skippedRunIds: [] };
  }
  return {
    status:
      durable.status === "done" || durable.status === "failed"
        ? durable.status
        : durable.status === "running"
          ? "owner"
          : "not_owner",
    skippedRunIds: durable.members
      .filter((member) => member.state === "skipped_budget")
      .map((member) => member.runId),
  };
}

bindBatchExecution.maxRetries = 2;

async function materializeBudgetSkippedRun(
  input: DurableRelightBatchInput,
  workflowRunId: string,
  runId: string
): Promise<void> {
  "use step";
  const storage = getStorage();
  const execution = await storage.getBatchExecution(input.batchId);
  const member = execution?.members.find((item) => item.runId === runId);
  if (
    !ownsBatchExecution(execution, input, workflowRunId) ||
    execution.status !== "running" ||
    member?.state !== "skipped_budget"
  ) {
    return;
  }
  const run = await storage.getRun(runId);
  if (!run) throw new Error(`Budget-skipped run ${runId} was not found.`);
  if (operationForFirstCut(run)) {
    throw new Error(
      `Budget-skipped run ${runId} already has provider work and cannot be labeled zero-spend.`
    );
  }
  const failed = await failUnstartedRunExecution(
    storage,
    execution,
    runId,
    `${BATCH_BUDGET_SKIPPED}: no reservation was available under the confirmed batch cap.`
  );
  if (
    !failed ||
    failed.status !== "failed" ||
    !failed.error?.startsWith(BATCH_BUDGET_SKIPPED)
  ) {
    throw new Error(`Budget-skipped run ${runId} could not be materialized safely.`);
  }
}

materializeBudgetSkippedRun.maxRetries = 2;

async function claimDispatchSlots(
  input: DurableRelightBatchInput,
  workflowRunId: string
): Promise<DispatchSnapshot> {
  "use step";
  const storage = getStorage();
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await storage.getBatchExecution(input.batchId);
    if (!ownsBatchExecution(current, input, workflowRunId)) {
      return { owner: false, runningRunIds: [] };
    }
    if (current.status !== "running") {
      return { owner: true, runningRunIds: [] };
    }
    const activeCount = current.members.filter(
      (member) =>
        member.state === "running" || member.state === "reconcile_required"
    ).length;
    // The persisted value is an invariant check, not an input. Keep this
    // runtime clamp so a browser or legacy Batch record can never widen paid
    // provider dispatch.
    let capacity = Math.max(0, DURABLE_BATCH_CONCURRENCY - activeCount);
    const members = current.members.map((member) => {
      if (capacity > 0 && member.state === "queued") {
        capacity -= 1;
        return { ...member, state: "running" as const };
      }
      return member;
    });
    const changed = members.some(
      (member, index) => member.state !== current.members[index].state
    );
    if (!changed) {
      return {
        owner: true,
        runningRunIds: current.members
          .filter((member) => member.state === "running")
          .map((member) => member.runId),
      };
    }
    const candidate: BatchExecution = {
      ...current,
      members,
      revision: current.revision + 1,
      updatedAt: Math.max(Date.now(), current.updatedAt),
    };
    const advanced = await storage.advanceBatchExecution(
      candidate,
      current.revision
    );
    if (advanced.advanced && advanced.execution) {
      return {
        owner: true,
        runningRunIds: advanced.execution.members
          .filter((member) => member.state === "running")
          .map((member) => member.runId),
      };
    }
  }
  throw new Error("Batch dispatch state changed too often to claim a safe slot.");
}

claimDispatchSlots.maxRetries = 2;

async function ensureMemberEnqueued(
  input: DurableRelightBatchInput,
  workflowRunId: string,
  runId: string
): Promise<void> {
  "use step";
  const storage = getStorage();
  const execution = await storage.getBatchExecution(input.batchId);
  const member = execution?.members.find((item) => item.runId === runId);
  if (
    !ownsBatchExecution(execution, input, workflowRunId) ||
    execution.status !== "running" ||
    member?.state !== "running"
  ) {
    return;
  }
  const run = await storage.getRun(runId);
  if (!run) throw new Error(`Run ${runId} was not found before dispatch.`);
  assertBatchMemberApproval(run, execution, member);
  const launch = await enqueueRunExecution({
    runId,
    executionId: expectedMemberExecutionId(input.batchId, runId),
    source: "batch",
    batchId: input.batchId,
    renderedPrompt: execution.renderedPrompt,
  });
  if (!memberExecutionMatches(launch.execution, input.batchId, runId)) {
    throw new Error(`A different child execution already owns run ${runId}.`);
  }
}

ensureMemberEnqueued.maxRetries = 2;

function assertBatchMemberApproval(
  run: Run,
  execution: BatchExecution,
  member: BatchExecutionMember
): void {
  const approval = run.spendApproval;
  if (
    !approval ||
    approval.source !== "batch" ||
    approval.scope !== "first_cut" ||
    approval.batchId !== execution.batchId ||
    approval.runId !== run.id ||
    run.originalVideo.runId !== run.id ||
    approval.sourceUrl !== run.originalVideo.url ||
    Math.abs(approval.durationSec - run.originalVideo.durationSec) > 0.001 ||
    approval.maxIterations !== 1 ||
    approval.approvedAt !== execution.startedAt ||
    approval.expiresAt !==
      execution.startedAt + BATCH_APPROVAL_LIFETIME_MS
  ) {
    throw new Error(`Run ${run.id} lost its canonical batch approval.`);
  }
  assertVideoGenerationAuthorized(run, 1);
  if (usdToMicros(approval.maxUsd) !== member.maxReservedMicros) {
    throw new Error(`Run ${run.id}'s approval no longer matches its reservation.`);
  }
}

async function recordMemberEnqueueFailure(
  input: DurableRelightBatchInput,
  workflowRunId: string,
  runId: string,
  error: string
): Promise<void> {
  "use step";
  const storage = getStorage();
  const [batch, child, run] = await Promise.all([
    storage.getBatchExecution(input.batchId),
    storage.getRunExecution(runId),
    storage.getRun(runId),
  ]);
  const member = batch?.members.find((item) => item.runId === runId);
  if (
    !ownsBatchExecution(batch, input, workflowRunId) ||
    batch.status !== "running" ||
    member?.state !== "running"
  ) {
    return;
  }
  // A transient start() failure can happen after the child CAS record was
  // created. Preserve it so the next parent poll can submit another harmless
  // contender. Provider evidence or any conflicting child is also never safe
  // to rewrite as a zero-spend failure.
  if (child || operationForFirstCut(run)) return;
  if (!run) return;
  try {
    assertBatchMemberApproval(run, batch, member);
    // Approval and canonical source still validate, so the enqueue error may
    // have been transient storage or Workflow transport. Keep the slot and
    // retry rather than manufacturing a deterministic zero-cost failure.
    return;
  } catch {
    // A freshly revalidated approval/source failure is deterministic and no
    // child or provider journal exists, so zero-spend settlement is safe.
  }
  await failUnstartedRunExecution(
    storage,
    batch,
    runId,
    `${BATCH_PRE_PROVIDER_FAILED}: ${error}`
  );
}

recordMemberEnqueueFailure.maxRetries = 2;

async function failUnstartedRunExecution(
  storage: StorageDriver,
  batch: BatchExecution,
  runId: string,
  error: string
): Promise<RunExecution | null> {
  const run = await storage.getRun(runId);
  if (!run || operationForFirstCut(run)) return storage.getRunExecution(runId);

  let current = await storage.getRunExecution(runId);
  if (!current) {
    const renderedPrompt = batch.renderedPrompt;
    const now = Date.now();
    const created = await storage.createRunExecution({
      runId,
      executionId: expectedMemberExecutionId(batch.batchId, runId),
      source: "batch",
      batchId: batch.batchId,
      status: "queued",
      phase: "queued",
      iteration: 0,
      renderedPrompt,
      inputHash: runExecutionInputHash(renderedPrompt),
      revision: 1,
      startedAt: now,
      updatedAt: now,
    });
    current = created.execution;
  }
  for (let attempt = 0; current && attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    if (!memberExecutionMatches(current, batch.batchId, runId)) return current;
    if (current.status !== "queued") return current;
    const candidate: RunExecution = {
      ...current,
      status: "failed",
      revision: current.revision + 1,
      updatedAt: Math.max(Date.now(), current.updatedAt),
      error: error.slice(0, 2_000),
    };
    const advanced = await storage.advanceRunExecution(
      candidate,
      current.revision
    );
    if (advanced.advanced) return advanced.execution;
    current = advanced.execution;
  }
  return current;
}

async function isBudgetSkippedMaterialized(
  storage: StorageDriver,
  batch: BatchExecution,
  member: BatchExecutionMember
): Promise<boolean> {
  const [child, run] = await Promise.all([
    storage.getRunExecution(member.runId),
    storage.getRun(member.runId),
  ]);
  return Boolean(
    run &&
      !operationForFirstCut(run) &&
      memberExecutionMatches(child, batch.batchId, member.runId) &&
      child.renderedPrompt === batch.renderedPrompt &&
      child.inputHash === batch.inputHash &&
      child.status === "failed" &&
      child.error?.startsWith(BATCH_BUDGET_SKIPPED)
  );
}

async function reconcileBatchMembers(
  input: DurableRelightBatchInput,
  workflowRunId: string
): Promise<BatchProgress> {
  "use step";
  const storage = getStorage();
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await storage.getBatchExecution(input.batchId);
    if (!ownsBatchExecution(current, input, workflowRunId)) {
      return {
        owner: false,
        allTerminal: false,
        stalledOnReconciliation: false,
      };
    }
    if (current.status !== "running") return progressForExecution(current);

    const members = await Promise.all(
      current.members.map(async (member) => {
        if (
          member.state !== "running" &&
          member.state !== "reconcile_required"
        ) {
          return member;
        }
        let [child, run] = await Promise.all([
          storage.getRunExecution(member.runId),
          storage.getRun(member.runId),
        ]);
        const operation = operationForFirstCut(run);
        if (
          operation?.status === "completed" &&
          operation.result &&
          operation.renderedPrompt === current.renderedPrompt &&
          memberExecutionMatches(child, current.batchId, member.runId) &&
          child.renderedPrompt === current.renderedPrompt &&
          child.inputHash === current.inputHash &&
          (child.status === "running" ||
            child.status === "reconcile_required")
        ) {
          try {
            child = await repairCompletedRunExecution({
              runId: member.runId,
              executionId: child.executionId,
              source: "batch",
              batchId: current.batchId,
              renderedPrompt: current.renderedPrompt,
            });
          } catch {
            // The exact artifact is already committed, so this is a free CAS
            // repair. Keep the slot active and retry on the next parent poll
            // instead of finishing the batch ahead of the grading queue.
            return withMemberError(
              member,
              "running",
              "The completed first cut is waiting for durable settlement."
            );
          }
        }
        return classifyMember(current, member, child, run);
      })
    );
    const changed = members.some(
      (member, index) => !sameMember(member, current.members[index])
    );
    if (!changed) return progressForExecution(current);

    const accounting = accountingForMembers(members);
    const candidate: BatchExecution = {
      ...current,
      ...accounting,
      members,
      revision: current.revision + 1,
      updatedAt: Math.max(Date.now(), current.updatedAt),
    };
    const advanced = await storage.advanceBatchExecution(
      candidate,
      current.revision
    );
    if (advanced.advanced && advanced.execution) {
      return progressForExecution(advanced.execution);
    }
  }
  throw new Error("Batch member state changed too often to reconcile safely.");
}

reconcileBatchMembers.maxRetries = 2;

function classifyMember(
  batch: BatchExecution,
  member: BatchExecutionMember,
  child: RunExecution | null,
  run: Run | null
): BatchExecutionMember {
  if (!run) {
    return withMemberError(
      member,
      "reconcile_required",
      "The canonical run disappeared while provider spend may be unresolved."
    );
  }
  if (child && !memberExecutionMatches(child, batch.batchId, member.runId)) {
    return withMemberError(
      member,
      "reconcile_required",
      "A different run execution owns this batch member."
    );
  }
  if (
    child &&
    (child.renderedPrompt !== batch.renderedPrompt ||
      child.inputHash !== batch.inputHash)
  ) {
    return withMemberError(
      member,
      "reconcile_required",
      "The child execution does not match the immutable batch prompt."
    );
  }

  const operation = operationForFirstCut(run);
  if (operation && operation.renderedPrompt !== batch.renderedPrompt) {
    return withMemberError(
      member,
      "reconcile_required",
      "Provider work does not match the immutable batch prompt."
    );
  }
  if (operation && !child) {
    return withMemberError(
      member,
      "reconcile_required",
      "Provider work exists without its matching child execution."
    );
  }
  if (operation?.status === "completed" && operation.result) {
    if (
      child?.status !== "awaiting_review" ||
      child.phase !== "complete" ||
      child.iteration !== 1
    ) {
      if (
        child?.status === "running" ||
        child?.status === "reconcile_required"
      ) {
        return withMemberError(
          member,
          "running",
          "The completed first cut is waiting for durable settlement."
        );
      }
      return withMemberError(
        member,
        "reconcile_required",
        "The completed provider artifact has no gradeable child settlement."
      );
    }
    try {
      const actualMicros = usdToMicros(operation.result.costUsd);
      if (actualMicros > member.maxReservedMicros) {
        return withMemberError(
          member,
          "reconcile_required",
          "Confirmed provider cost exceeded the immutable member reservation."
        );
      }
      return withMemberError(
        member,
        "awaiting_review",
        undefined,
        actualMicros
      );
    } catch {
      return withMemberError(
        member,
        "reconcile_required",
        "Completed provider cost could not be represented safely."
      );
    }
  }

  if (operation) {
    if (child?.status === "running") {
      return member.state === "reconcile_required"
        ? member
        : withMemberError(member, "running");
    }
    return withMemberError(
      member,
      "reconcile_required",
      operation.error ?? "Provider work exists without confirmed terminal cost."
    );
  }

  if (child?.status === "failed") {
    return withMemberError(
      member,
      "failed",
      child.error ?? "The child failed before provider work began.",
      0
    );
  }
  if (
    child?.status === "reconcile_required" ||
    child?.status === "awaiting_review"
  ) {
    return withMemberError(
      member,
      "reconcile_required",
      child.error ?? "Child state and provider journal require reconciliation."
    );
  }
  return member;
}

async function finishCompletedBatch(
  input: DurableRelightBatchInput,
  workflowRunId: string
): Promise<"done" | "failed" | "not_owner"> {
  "use step";
  const storage = getStorage();
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await storage.getBatchExecution(input.batchId);
    if (!ownsBatchExecution(current, input, workflowRunId)) return "not_owner";
    if (current.status === "done" || current.status === "failed") {
      return current.status;
    }
    if (!progressForExecution(current).allTerminal) {
      throw new Error("Batch cannot finish while members remain active.");
    }
    const candidate: BatchExecution = {
      ...current,
      status: "done",
      revision: current.revision + 1,
      updatedAt: Math.max(Date.now(), current.updatedAt),
      error: undefined,
    };
    const advanced = await storage.advanceBatchExecution(
      candidate,
      current.revision
    );
    if (advanced.advanced) return "done";
  }
  throw new Error("Batch changed too often to finalize safely.");
}

finishCompletedBatch.maxRetries = 2;

async function failUnresolvedBatch(
  input: DurableRelightBatchInput,
  workflowRunId: string,
  error: string
): Promise<"failed" | "done" | "not_owner"> {
  "use step";
  const storage = getStorage();
  let initial = await storage.getBatchExecution(input.batchId);
  if (!ownsBatchExecution(initial, input, workflowRunId)) return "not_owner";
  if (initial.status === "done" || initial.status === "failed") {
    return initial.status;
  }

  for (const member of initial.members) {
    if (member.state !== "queued" && member.state !== "running") continue;
    await failUnstartedRunExecution(
      storage,
      initial,
      member.runId,
      `${BATCH_DISPATCH_ABORTED}: ${error}`
    );
  }

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await storage.getBatchExecution(input.batchId);
    if (!ownsBatchExecution(current, input, workflowRunId)) return "not_owner";
    if (current.status === "done" || current.status === "failed") {
      return current.status;
    }
    const members = await Promise.all(
      current.members.map(async (member) => {
        if (
          member.state === "awaiting_review" ||
          member.state === "failed" ||
          member.state === "skipped_budget"
        ) {
          return member;
        }
        const [child, run] = await Promise.all([
          storage.getRunExecution(member.runId),
          storage.getRun(member.runId),
        ]);
        const classified = classifyMember(current, member, child, run);
        if (
          classified.state === "running" ||
          classified.state === "queued"
        ) {
          return withMemberError(
            classified,
            "reconcile_required",
            "Execution stopped while child provider ownership could still be racing."
          );
        }
        return classified;
      })
    );
    const allSettled = members.every(
      (member) =>
        member.state === "awaiting_review" ||
        member.state === "failed" ||
        member.state === "skipped_budget"
    );
    const skippedMaterialized = allSettled
      ? (
          await Promise.all(
            members
              .filter((member) => member.state === "skipped_budget")
              .map((member) =>
                isBudgetSkippedMaterialized(storage, current, member)
              )
          )
        ).every(Boolean)
      : false;
    const fullySettled = allSettled && skippedMaterialized;
    const terminalStatus: "done" | "failed" = fullySettled ? "done" : "failed";
    const accounting = accountingForMembers(members);
    const candidate: BatchExecution = {
      ...current,
      ...accounting,
      status: terminalStatus,
      members,
      revision: current.revision + 1,
      updatedAt: Math.max(Date.now(), current.updatedAt),
      error: fullySettled ? undefined : error.slice(0, 2_000),
    };
    const advanced = await storage.advanceBatchExecution(
      candidate,
      current.revision
    );
    if (advanced.advanced) return terminalStatus;
  }
  throw new Error("Batch changed too often to fail safely.");
}

failUnresolvedBatch.maxRetries = 2;

async function advanceTrustedBatchDone(
  input: DurableRelightBatchInput
): Promise<void> {
  "use step";
  const storage = getStorage();
  const execution = await storage.getBatchExecution(input.batchId);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    (execution.status !== "done" && execution.status !== "failed")
  ) {
    throw new Error("Batch execution is not terminal.");
  }
  const batch = (await storage.getBatches()).find(
    (item) => item.id === input.batchId
  );
  if (!batch) throw new Error("Trusted Batch record is missing.");
  if (batch.status === "done") return;
  if (batch.status !== "running") {
    throw new Error("Trusted Batch cannot advance to done from its current state.");
  }
  const transition = await storage.advanceBatch(
    {
      ...batch,
      status: "done",
      updatedAt: Math.max(Date.now(), batch.updatedAt ?? batch.createdAt),
    },
    "running"
  );
  if (!transition.advanced && transition.batch?.status !== "done") {
    throw new Error("Trusted Batch changed before terminal settlement.");
  }
}

advanceTrustedBatchDone.maxRetries = 4;
