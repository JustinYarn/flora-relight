import { getWorkflowMetadata, sleep } from "workflow";
import {
  compileLampFinalPrompt,
  isLampEvaluationArtifact,
  lampEvaluationOperationId,
  type LampEvaluationArtifact,
} from "@/lib/lamp-evaluation";
import {
  batchApprovalStartedAt,
  batchApprovalScope,
  batchCompletionIteration,
  batchExecutionId,
  batchExecutionMode,
  batchMemberExecutionId,
  batchMaximumIterations,
} from "@/lib/server/batch-contract";
import { LAMP_BATCH_USER_ACTION_REQUIRED_PREFIX } from "@/lib/server/batch-execution-resume";
import {
  DURABLE_BATCH_CONCURRENCY,
  usdToMicros,
} from "@/lib/server/batch-budget";
import {
  enqueueRunExecution,
  repairCompletedRunExecution,
} from "@/lib/server/run-execution-coordinator";
import { isGradeableVideoGeneration } from "@/lib/server/run-execution-failure";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import {
  BATCH_APPROVAL_LIFETIME_MS,
  assertVideoGenerationAuthorized,
} from "@/lib/server/spend-approval";
import { confirmedLampBatchActualMicros } from "@/lib/server/lamp-batch-accounting";
import { reconcileDeadWorkflowExecution } from "@/lib/server/dead-workflow-recovery";
import { getStorage, type StorageDriver } from "@/lib/server/storage";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import type {
  BatchExecution,
  BatchExecutionMember,
  PaidOperation,
  ProviderOperation,
  Run,
  RunExecution,
} from "@/lib/types";
import {
  isLipsyncOperationResult,
  LIPSYNC_OPERATION_ID,
  v2SyncVerdict,
} from "@/lib/v2-sync";

export interface DurableRelightBatchInput {
  batchId: string;
  executionId: string;
}

export interface DurableRelightBatchResult {
  batchId: string;
  executionId: string;
  status: "not_owner" | "user_action_required" | "done" | "failed";
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
  readyForApproval: boolean;
}

const BATCH_BUDGET_SKIPPED = "BATCH_BUDGET_SKIPPED";
const BATCH_PRE_PROVIDER_FAILED = "BATCH_PRE_PROVIDER_FAILED";
const BATCH_DISPATCH_ABORTED = "BATCH_DISPATCH_ABORTED";
const FAST_BATCH_POLLS = 60 * 2; // First hour at 30 seconds.
const SLOW_BATCH_POLLS = 14 * 24 * 12 - 12; // Recovery window includes one approval renewal.
const MAX_BATCH_POLLS = FAST_BATCH_POLLS + SLOW_BATCH_POLLS;
const MAX_CAS_ATTEMPTS = 20;

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
      execution.executionId ===
        batchExecutionId(input.batchId, batchExecutionMode(execution)) &&
      execution.concurrency === DURABLE_BATCH_CONCURRENCY &&
      execution.workflowRunId === workflowRunId
  );
}

function generationOperation(
  run: Run | null,
  iteration: 1 | 2
): ProviderOperation | undefined {
  return run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(iteration)
  );
}

interface LampPaidOperations {
  first: PaidOperation | null;
  final: PaidOperation | null;
  lipsync: PaidOperation | null;
}

async function readLampPaidOperations(
  storage: StorageDriver,
  runId: string
): Promise<LampPaidOperations> {
  const [first, final, lipsync] = await Promise.all([
    storage.getPaidOperation(runId, lampEvaluationOperationId(1)),
    storage.getPaidOperation(runId, lampEvaluationOperationId(2)),
    storage.getPaidOperation(runId, LIPSYNC_OPERATION_ID),
  ]);
  return { first, final, lipsync };
}

async function paidOperationsForBatch(
  storage: StorageDriver,
  batch: BatchExecution,
  runId: string
): Promise<LampPaidOperations | null> {
  return batchExecutionMode(batch) === "lamp"
    ? readLampPaidOperations(storage, runId)
    : null;
}

function hasAnyProviderEvidence(
  run: Run | null,
  paid: LampPaidOperations | null
): boolean {
  return Boolean(
    (run?.providerOperations?.length ?? 0) > 0 ||
      paid?.first ||
      paid?.final ||
      paid?.lipsync
  );
}

function completedLampArtifacts(input: {
  batch: BatchExecution;
  run: Run;
  paid: LampPaidOperations;
}): {
  firstEvaluation: LampEvaluationArtifact;
  finalEvaluation: LampEvaluationArtifact;
  finalPrompt: string;
} | null {
  const firstGeneration = generationOperation(input.run, 1);
  const finalGeneration = generationOperation(input.run, 2);
  if (
    firstGeneration?.status !== "completed" ||
    !firstGeneration.result?.audioVerified ||
    firstGeneration.renderedPrompt !== input.batch.renderedPrompt ||
    input.paid.first?.status !== "completed" ||
    !isLampEvaluationArtifact(input.paid.first.result, 1)
  ) {
    return null;
  }
  let finalPrompt: string;
  try {
    finalPrompt = compileLampFinalPrompt(
      input.batch.renderedPrompt,
      input.paid.first.result
    ).rendered;
  } catch {
    return null;
  }
  if (
    finalGeneration?.status !== "completed" ||
    !finalGeneration.result?.audioVerified ||
    finalGeneration.renderedPrompt !== finalPrompt ||
    input.paid.final?.status !== "completed" ||
    !isLampEvaluationArtifact(input.paid.final.result, 2) ||
    (input.paid.lipsync !== null &&
      (input.paid.lipsync.status !== "completed" ||
        !isLipsyncOperationResult(input.paid.lipsync.result) ||
        !v2SyncVerdict(
          input.paid.lipsync.result.postSync,
          input.run.originalVideo.syncBaseline ?? null
        ).pass))
  ) {
    return null;
  }
  return {
    firstEvaluation: input.paid.first.result,
    finalEvaluation: input.paid.final.result,
    finalPrompt,
  };
}

function confirmedLampActualMicros(input: {
  run: Run;
  paid: LampPaidOperations;
}): number {
  const firstGeneration = generationOperation(input.run, 1)?.result;
  const finalGeneration = generationOperation(input.run, 2)?.result;
  if (
    !firstGeneration ||
    !finalGeneration ||
    !isLampEvaluationArtifact(input.paid.first?.result, 1) ||
    !isLampEvaluationArtifact(input.paid.final?.result, 2)
  ) {
    throw new Error("Lamp spend is not completely journaled.");
  }
  const lipsyncRepairUsd = input.paid.lipsync
    ? isLipsyncOperationResult(input.paid.lipsync.result)
      ? input.paid.lipsync.result.costUsd
      : null
    : 0;
  if (lipsyncRepairUsd === null) {
    throw new Error("Lamp Lipsync spend is not completely journaled.");
  }
  return confirmedLampBatchActualMicros({
    initialGenerationUsd: firstGeneration.costUsd,
    initialEvaluationUsd: input.paid.first.result.costUsd,
    finalGenerationUsd: finalGeneration.costUsd,
    finalEvaluationUsd: input.paid.final.result.costUsd,
    lipsyncRepairUsd,
  });
}

function memberExecutionMatches(
  execution: RunExecution | null,
  batch: BatchExecution,
  runId: string
): execution is RunExecution {
  const mode = batchExecutionMode(batch);
  return Boolean(
    execution &&
      execution.runId === runId &&
      execution.executionId ===
        batchMemberExecutionId(batch.batchId, runId, mode) &&
      execution.source === "batch" &&
      execution.batchId === batch.batchId
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
      member.state === "user_action_required" ||
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
  const approvalRequired = execution.members.filter(
    (member) => member.state === "user_action_required"
  ).length;
  return {
    owner: true,
    allTerminal: queued + running + reconcile + approvalRequired === 0,
    // Reconciliation stalls the batch only once the queue has fully drained:
    // members needing a human stop the batch from finishing "done", but they
    // must never abort clips that have not yet had their provider call.
    stalledOnReconciliation: reconcile > 0 && running === 0 && queued === 0,
    readyForApproval:
      approvalRequired > 0 && queued + running + reconcile === 0,
  };
}

/**
 * Server-owned parent: it schedules child durable run Workflows but never
 * performs provider work itself. Flora children retain the legacy first-cut
 * path; Lamp children execute the exact two-generation/two-evaluation
 * contract. Batch and child CAS records remain the only dispatch/spend
 * authority across replay, retries, and deployments.
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
      if (progress.readyForApproval) {
        const paused = await pauseBatchForApproval(input, workflowRunId);
        if (paused === "not_owner") return { ...input, status: paused };
        return { ...input, status: "user_action_required" };
      }
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
          "Every remaining member needs provider reconciliation; the batch cannot settle further on its own."
        );
      }

      await sleep(poll < FAST_BATCH_POLLS ? "30s" : "5m");
    }

    throw new Error(
      "Batch execution exceeded its fourteen-day reconciliation deadline."
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
    current.executionId !==
      batchExecutionId(input.batchId, batchExecutionMode(current))
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
  // "queued" is the normal first bind; "running" without a workflowRunId is
  // a dead-workflow adoption — the coordinator proved the old parent dead
  // and released its binding, and this contender resumes from the durable
  // member states exactly where dispatch stopped.
  if (current.status !== "queued" && current.status !== "running") {
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
  const paid = await paidOperationsForBatch(storage, execution, runId);
  if (hasAnyProviderEvidence(run, paid)) {
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
    // Only live children hold dispatch slots. A reconcile_required member is
    // a sealed journal awaiting a human — its child workflow is dead and its
    // reservation stays held in accountingForMembers, so letting it also pin
    // a concurrency slot turned one stuck member into a frozen queue (and,
    // once reconcile members reached the concurrency cap, a dead batch that
    // zero-failed every still-queued clip).
    const activeCount = current.members.filter(
      (member) => member.state === "running"
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
    executionId: batchMemberExecutionId(
      input.batchId,
      runId,
      batchExecutionMode(execution)
    ),
    source: "batch",
    batchId: input.batchId,
    renderedPrompt: execution.renderedPrompt,
  });
  if (!memberExecutionMatches(launch.execution, execution, runId)) {
    throw new Error(`A different child execution already owns run ${runId}.`);
  }
}

ensureMemberEnqueued.maxRetries = 2;

function assertBatchMemberApproval(
  run: Run,
  execution: BatchExecution,
  member: BatchExecutionMember
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
  const paid = await paidOperationsForBatch(storage, batch, runId);
  if (child || hasAnyProviderEvidence(run, paid)) return;
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
  const paid = await paidOperationsForBatch(storage, batch, runId);
  if (!run || hasAnyProviderEvidence(run, paid)) {
    return storage.getRunExecution(runId);
  }

  let current = await storage.getRunExecution(runId);
  if (!current) {
    const renderedPrompt = batch.renderedPrompt;
    const now = Date.now();
    const created = await storage.createRunExecution({
      runId,
      executionId: batchMemberExecutionId(
        batch.batchId,
        runId,
        batchExecutionMode(batch)
      ),
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
    if (!memberExecutionMatches(current, batch, runId)) return current;
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
  const [child, run, paid] = await Promise.all([
    storage.getRunExecution(member.runId),
    storage.getRun(member.runId),
    paidOperationsForBatch(storage, batch, member.runId),
  ]);
  return Boolean(
    run &&
      !hasAnyProviderEvidence(run, paid) &&
      memberExecutionMatches(child, batch, member.runId) &&
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
        readyForApproval: false,
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
        const [initialChild, run, paid] = await Promise.all([
          storage.getRunExecution(member.runId),
          storage.getRun(member.runId),
          paidOperationsForBatch(storage, current, member.runId),
        ]);
        let child = initialChild;
        // A child whose own workflow died (it shares the parent's process
        // locally) would otherwise hold its member "running" forever. The
        // adopter is lease-throttled, probes liveness, fails open on
        // "unknown", and seals with honest provider probing when dead —
        // after which classifyMember routes the member like any other
        // reconciliation case and dispatch continues past it.
        if (
          child &&
          child.status === "running" &&
          child.workflowRunId &&
          memberExecutionMatches(child, current, member.runId)
        ) {
          const adopted = await reconcileDeadWorkflowExecution(child, run);
          if (adopted) child = adopted;
        }
        const mode = batchExecutionMode(current);
        const completionReady =
          mode === "lamp"
            ? Boolean(
                run &&
                  paid &&
                  completedLampArtifacts({ batch: current, run, paid })
              )
            : Boolean(
                isGradeableVideoGeneration(generationOperation(run, 1)) &&
                  generationOperation(run, 1)?.renderedPrompt ===
                    current.renderedPrompt
              );
        if (
          completionReady &&
          memberExecutionMatches(child, current, member.runId) &&
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
              member.state === "reconcile_required"
                ? "reconcile_required"
                : "running",
              mode === "lamp"
                ? "The completed Lamp Final and evaluation are waiting for durable settlement."
                : "The completed first cut is waiting for durable settlement."
            );
          }
        }
        return classifyMember(current, member, child, run, paid);
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
  run: Run | null,
  paid: LampPaidOperations | null
): BatchExecutionMember {
  if (!run) {
    return withMemberError(
      member,
      "reconcile_required",
      "The canonical run disappeared while provider spend may be unresolved."
    );
  }
  if (child && !memberExecutionMatches(child, batch, member.runId)) {
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

  if (batchExecutionMode(batch) === "lamp") {
    return classifyLampMember(batch, member, child, run, paid);
  }

  const operation = generationOperation(run, 1);
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
    let actualMicros: number;
    try {
      actualMicros = usdToMicros(operation.result.costUsd);
    } catch {
      return withMemberError(
        member,
        "reconcile_required",
        "Completed provider cost could not be represented safely."
      );
    }
    if (actualMicros > member.maxReservedMicros) {
      return withMemberError(
        member,
        "reconcile_required",
        "Confirmed provider cost exceeded the immutable member reservation."
      );
    }
    if (!operation.result.audioVerified) {
      return withMemberError(
        member,
        "failed",
        "The completed first cut failed original-audio integrity and cannot enter grading.",
        actualMicros
      );
    }
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
          member.state === "reconcile_required"
            ? "reconcile_required"
            : "running",
          "The completed first cut is waiting for durable settlement."
        );
      }
      return withMemberError(
        member,
        "reconcile_required",
        "The completed provider artifact has no gradeable child settlement."
      );
    }
    return withMemberError(
      member,
      "awaiting_review",
      undefined,
      actualMicros
    );
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

function classifyLampMember(
  batch: BatchExecution,
  member: BatchExecutionMember,
  child: RunExecution | null,
  run: Run,
  paid: LampPaidOperations | null
): BatchExecutionMember {
  if (!paid) {
    return withMemberError(
      member,
      "reconcile_required",
      "Lamp paid-operation journals could not be loaded."
    );
  }
  const firstGeneration = generationOperation(run, 1);
  const finalGeneration = generationOperation(run, 2);
  if (
    firstGeneration &&
    firstGeneration.renderedPrompt !== batch.renderedPrompt
  ) {
    return withMemberError(
      member,
      "reconcile_required",
      "Lamp Initial provider work does not match the immutable batch prompt."
    );
  }
  if (hasAnyProviderEvidence(run, paid) && !child) {
    return withMemberError(
      member,
      "reconcile_required",
      "Lamp provider work exists without its matching child execution."
    );
  }

  if (finalGeneration) {
    if (
      paid.first?.status !== "completed" ||
      !isLampEvaluationArtifact(paid.first.result, 1)
    ) {
      return withMemberError(
        member,
        "reconcile_required",
        "Lamp Final provider work exists without a valid Initial holistic evaluation."
      );
    }
    let expectedFinalPrompt: string;
    try {
      expectedFinalPrompt = compileLampFinalPrompt(
        batch.renderedPrompt,
        paid.first.result
      ).rendered;
    } catch {
      return withMemberError(
        member,
        "reconcile_required",
        "Lamp's persisted Initial prompt cannot reproduce the exact Final prompt."
      );
    }
    if (finalGeneration.renderedPrompt !== expectedFinalPrompt) {
      return withMemberError(
        member,
        "reconcile_required",
        "Lamp Final provider work does not match the critique-corrected prompt."
      );
    }
  }

  const completed = completedLampArtifacts({ batch, run, paid });
  if (completed) {
    if (
      child?.status !== "awaiting_review" ||
      child.phase !== "complete" ||
      child.iteration !== batchCompletionIteration("lamp")
    ) {
      if (
        child?.status === "running" ||
        child?.status === "reconcile_required"
      ) {
        return withMemberError(
          member,
          member.state === "reconcile_required"
            ? "reconcile_required"
            : "running",
          "The completed Lamp Final and evaluation are waiting for durable settlement."
        );
      }
      return withMemberError(
        member,
        "reconcile_required",
        "The exact Lamp two-pass artifacts have no gradeable child settlement."
      );
    }
    try {
      const actualMicros = confirmedLampActualMicros({ run, paid });
      if (actualMicros > member.maxReservedMicros) {
        return withMemberError(
          member,
          "reconcile_required",
          "Confirmed Lamp cost exceeded the immutable member reservation."
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
        "Completed Lamp cost could not be represented safely."
      );
    }
  }

  if (child?.status === "failed") {
    if (!hasAnyProviderEvidence(run, paid)) {
      return withMemberError(
        member,
        "failed",
        child.error ?? "The Lamp child failed before provider work began.",
        0
      );
    }
    return withMemberError(
      member,
      "reconcile_required",
      child.error ?? "Lamp stopped after partial provider work; spend requires reconciliation."
    );
  }
  if (child?.status === "user_action_required") {
    return withMemberError(
      member,
      "user_action_required",
      child.error ?? "Lamp needs a renewed batch approval before pass 2."
    );
  }
  if (
    child?.status === "reconcile_required" ||
    child?.status === "awaiting_review"
  ) {
    return withMemberError(
      member,
      "reconcile_required",
      child.error ?? "Lamp child state and provider journals require reconciliation."
    );
  }
  if (
    firstGeneration ||
    finalGeneration ||
    paid.first ||
    paid.final
  ) {
    if (child?.status === "running") {
      return member.state === "reconcile_required"
        ? member
        : withMemberError(member, "running");
    }
    const providerError =
      finalGeneration?.error ??
      firstGeneration?.error ??
      paid.final?.error ??
      paid.first?.error;
    return withMemberError(
      member,
      "reconcile_required",
      providerError ?? "Lamp provider work exists without confirmed terminal evidence."
    );
  }
  return member;
}

async function pauseBatchForApproval(
  input: DurableRelightBatchInput,
  workflowRunId: string
): Promise<"user_action_required" | "not_owner"> {
  "use step";
  const storage = getStorage();
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await storage.getBatchExecution(input.batchId);
    if (!ownsBatchExecution(current, input, workflowRunId)) return "not_owner";
    if (current.status === "user_action_required") {
      return "user_action_required";
    }
    if (current.status !== "running") return "not_owner";
    const progress = progressForExecution(current);
    if (!progress.readyForApproval) {
      throw new Error("Lamp batch cannot pause while another member is active.");
    }
    const candidate: BatchExecution = {
      ...current,
      status: "user_action_required",
      revision: current.revision + 1,
      updatedAt: Math.max(Date.now(), current.updatedAt),
      error:
        `${LAMP_BATCH_USER_ACTION_REQUIRED_PREFIX} renew the exact Lamp batch approval to continue pass 2 from existing journals.`,
    };
    const advanced = await storage.advanceBatchExecution(
      candidate,
      current.revision
    );
    if (advanced.advanced) return "user_action_required";
  }
  throw new Error("Lamp batch changed too often to pause for approval.");
}

pauseBatchForApproval.maxRetries = 2;

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
  const initial = await storage.getBatchExecution(input.batchId);
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
        const [child, run, paid] = await Promise.all([
          storage.getRunExecution(member.runId),
          storage.getRun(member.runId),
          paidOperationsForBatch(storage, current, member.runId),
        ]);
        const classified = classifyMember(current, member, child, run, paid);
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
