/**
 * Validation and forward-only transition rules for durable batch dispatch.
 * Both storage drivers call this before committing a revision CAS.
 */

import type {
  BatchExecution,
  BatchExecutionMemberState,
  BatchExecutionStatus,
} from "@/lib/types";
import { assertRunId } from "@/lib/server/runstore";
import { createHash } from "node:crypto";

const EXECUTION_ID_RE = /^[a-z0-9:_-]{1,160}$/;
const MAX_OPTIONAL_ID_LENGTH = 256;
const MAX_ERROR_LENGTH = 2_000;
const MAX_RENDERED_PROMPT_LENGTH = 100_000;
const SHA256_RE = /^[a-f0-9]{64}$/;

const STATUS_TRANSITIONS: Record<
  BatchExecutionStatus,
  ReadonlySet<BatchExecutionStatus>
> = {
  queued: new Set(["queued", "running"]),
  running: new Set(["running", "done", "failed"]),
  done: new Set(["done"]),
  failed: new Set(["failed"]),
};

const MEMBER_TRANSITIONS: Record<
  BatchExecutionMemberState,
  ReadonlySet<BatchExecutionMemberState>
> = {
  queued: new Set([
    "queued",
    "running",
    "failed",
    "reconcile_required",
    "skipped_budget",
  ]),
  running: new Set([
    "running",
    "awaiting_review",
    "failed",
    "reconcile_required",
  ]),
  reconcile_required: new Set([
    "reconcile_required",
    "awaiting_review",
    "failed",
  ]),
  awaiting_review: new Set(["awaiting_review"]),
  failed: new Set(["failed"]),
  skipped_budget: new Set(["skipped_budget"]),
};

const RESERVED_MEMBER_STATES = new Set<BatchExecutionMemberState>([
  "queued",
  "running",
  "reconcile_required",
]);

const TERMINAL_MEMBER_STATES = new Set<BatchExecutionMemberState>([
  "awaiting_review",
  "failed",
  "skipped_budget",
]);

function assertSafeNonnegativeInteger(
  value: unknown,
  name: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertOptionalText(
  value: unknown,
  name: string,
  maxLength: number
): asserts value is string | undefined {
  if (
    value !== undefined &&
    (typeof value !== "string" || value.length < 1 || value.length > maxLength)
  ) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function safeAdd(total: number, value: number, name: string): number {
  const sum = total + value;
  if (!Number.isSafeInteger(sum)) {
    throw new Error(`${name} exceeds the safe integer range`);
  }
  return sum;
}

function hasOwn<T extends object>(record: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Validate record shape plus all reservation/settlement invariants. */
export function assertBatchExecution(execution: unknown): BatchExecution {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    throw new Error("Invalid batch execution record");
  }
  const candidate = execution as BatchExecution;
  assertRunId(candidate.batchId);
  if (
    typeof candidate.executionId !== "string" ||
    !EXECUTION_ID_RE.test(candidate.executionId)
  ) {
    throw new Error("Invalid batch execution id");
  }
  if (typeof candidate.inputHash !== "string" || !SHA256_RE.test(candidate.inputHash)) {
    throw new Error("Batch execution inputHash must be a lowercase sha256 digest");
  }
  if (
    typeof candidate.renderedPrompt !== "string" ||
    candidate.renderedPrompt.length < 1 ||
    candidate.renderedPrompt.length > MAX_RENDERED_PROMPT_LENGTH
  ) {
    throw new Error(
      `Batch execution renderedPrompt must contain 1-${MAX_RENDERED_PROMPT_LENGTH} characters`
    );
  }
  if (
    createHash("sha256").update(candidate.renderedPrompt, "utf8").digest("hex") !==
    candidate.inputHash
  ) {
    throw new Error("Batch execution renderedPrompt does not match inputHash");
  }
  if (
    typeof candidate.status !== "string" ||
    !hasOwn(STATUS_TRANSITIONS, candidate.status)
  ) {
    throw new Error("Invalid batch execution status");
  }
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 1) {
    throw new Error("Batch execution revision must be a positive safe integer");
  }
  if (!Number.isSafeInteger(candidate.concurrency) || candidate.concurrency < 1) {
    throw new Error("Batch execution concurrency must be a positive safe integer");
  }
  assertSafeNonnegativeInteger(candidate.budgetLimitMicros, "budgetLimitMicros");
  assertSafeNonnegativeInteger(candidate.reservedMicros, "reservedMicros");
  assertSafeNonnegativeInteger(candidate.settledMicros, "settledMicros");
  assertSafeNonnegativeInteger(candidate.startedAt, "startedAt");
  assertSafeNonnegativeInteger(candidate.updatedAt, "updatedAt");
  if (candidate.updatedAt < candidate.startedAt) {
    throw new Error("Batch execution updatedAt cannot precede startedAt");
  }
  assertOptionalText(
    candidate.workflowRunId,
    "workflowRunId",
    MAX_OPTIONAL_ID_LENGTH
  );
  assertOptionalText(candidate.error, "error", MAX_ERROR_LENGTH);
  if (!Array.isArray(candidate.members) || candidate.members.length === 0) {
    throw new Error("Batch execution members must be a non-empty array");
  }

  const runIds = new Set<string>();
  let expectedReserved = 0;
  let expectedSettled = 0;
  for (const [index, member] of candidate.members.entries()) {
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      throw new Error("Invalid batch execution member");
    }
    assertRunId(member.runId);
    if (runIds.has(member.runId)) {
      throw new Error("Batch execution member run ids must be unique");
    }
    runIds.add(member.runId);
    if (!Number.isSafeInteger(member.position) || member.position !== index) {
      throw new Error("Batch execution member positions must be contiguous and ordered");
    }
    if (typeof member.state !== "string" || !hasOwn(MEMBER_TRANSITIONS, member.state)) {
      throw new Error("Invalid batch execution member state");
    }
    assertSafeNonnegativeInteger(
      member.maxReservedMicros,
      `members[${index}].maxReservedMicros`
    );
    if (member.actualMicros !== undefined) {
      assertSafeNonnegativeInteger(
        member.actualMicros,
        `members[${index}].actualMicros`
      );
      if (member.actualMicros > member.maxReservedMicros) {
        throw new Error("Member actual spend cannot exceed its maximum reservation");
      }
    }
    assertOptionalText(member.error, `members[${index}].error`, MAX_ERROR_LENGTH);

    if (RESERVED_MEMBER_STATES.has(member.state)) {
      if (member.actualMicros !== undefined) {
        throw new Error("A reserved member cannot carry confirmed terminal spend");
      }
      expectedReserved = safeAdd(
        expectedReserved,
        member.maxReservedMicros,
        "reservedMicros"
      );
    } else if (member.state === "skipped_budget") {
      if (member.actualMicros !== undefined && member.actualMicros !== 0) {
        throw new Error("A budget-skipped member cannot have actual spend");
      }
    } else {
      if (member.actualMicros === undefined) {
        throw new Error("A terminal member must carry confirmed actual spend");
      }
      expectedSettled = safeAdd(
        expectedSettled,
        member.actualMicros,
        "settledMicros"
      );
    }
  }

  if (candidate.reservedMicros !== expectedReserved) {
    throw new Error("reservedMicros does not equal active member reservations");
  }
  if (candidate.settledMicros !== expectedSettled) {
    throw new Error("settledMicros does not equal confirmed terminal spend");
  }
  const accounted = safeAdd(
    candidate.reservedMicros,
    candidate.settledMicros,
    "Batch accounted spend"
  );
  if (accounted > candidate.budgetLimitMicros) {
    throw new Error("Batch reservations and settled spend exceed the budget limit");
  }

  if (
    candidate.status === "queued" &&
    candidate.members.some(
      (member) => member.state !== "queued" && member.state !== "skipped_budget"
    )
  ) {
    throw new Error("A queued batch execution cannot contain dispatched members");
  }
  if (
    candidate.status === "done" &&
    candidate.members.some((member) => !TERMINAL_MEMBER_STATES.has(member.state))
  ) {
    throw new Error("A done batch execution must have only terminal members");
  }

  return candidate;
}

/** Creation fixes membership and all reservation ceilings at revision 1. */
export function assertNewBatchExecution(execution: BatchExecution): BatchExecution {
  assertBatchExecution(execution);
  if (execution.revision !== 1 || execution.status !== "queued") {
    throw new Error("A new batch execution must start queued at revision 1");
  }
  return execution;
}

/** Validate a candidate after the caller's expected revision still owns CAS. */
export function assertBatchExecutionTransition(
  current: BatchExecution,
  candidate: BatchExecution,
  expectedRevision: number
): BatchExecution {
  assertBatchExecution(current);
  assertBatchExecution(candidate);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("expectedRevision must be a positive safe integer");
  }
  if (current.revision !== expectedRevision) {
    throw new Error("Current batch execution revision does not match expectedRevision");
  }
  if (candidate.revision !== expectedRevision + 1) {
    throw new Error("Batch execution candidate must be the next revision");
  }
  if (
    candidate.batchId !== current.batchId ||
    candidate.executionId !== current.executionId ||
    candidate.renderedPrompt !== current.renderedPrompt ||
    candidate.inputHash !== current.inputHash ||
    candidate.startedAt !== current.startedAt ||
    candidate.concurrency !== current.concurrency ||
    candidate.budgetLimitMicros !== current.budgetLimitMicros ||
    candidate.members.length !== current.members.length
  ) {
    throw new Error("Batch execution identity and dispatch limits are immutable");
  }
  if (
    current.workflowRunId !== undefined &&
    candidate.workflowRunId !== current.workflowRunId
  ) {
    throw new Error("Batch execution workflowRunId is immutable after binding");
  }
  if (candidate.updatedAt < current.updatedAt) {
    throw new Error("Batch execution updatedAt cannot move backwards");
  }
  if (!STATUS_TRANSITIONS[current.status].has(candidate.status)) {
    throw new Error(
      `Batch execution status cannot move from ${current.status} to ${candidate.status}`
    );
  }

  for (let index = 0; index < current.members.length; index += 1) {
    const before = current.members[index];
    const after = candidate.members[index];
    if (
      after.runId !== before.runId ||
      after.position !== before.position ||
      after.maxReservedMicros !== before.maxReservedMicros
    ) {
      throw new Error("Batch execution membership, order, and reservations are immutable");
    }
    if (!MEMBER_TRANSITIONS[before.state].has(after.state)) {
      throw new Error(
        `Batch member ${before.runId} cannot move from ${before.state} to ${after.state}`
      );
    }
    if (
      before.actualMicros !== undefined &&
      after.actualMicros !== before.actualMicros
    ) {
      throw new Error("Confirmed member actual spend is immutable");
    }
  }

  return candidate;
}
