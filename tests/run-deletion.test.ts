import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  hasDeletionBlockingBatchWork,
  hasDeletionBlockingRunWork,
} from "../lib/server/storage/run-deletion.ts";
import type {
  BatchExecution,
  BatchExecutionMemberState,
  BatchExecutionStatus,
} from "../lib/types.ts";

const renderedPrompt = "provider-free deletion policy fixture";
const inputHash = createHash("sha256")
  .update(renderedPrompt, "utf8")
  .digest("hex");

function execution(
  status: BatchExecutionStatus,
  memberState: BatchExecutionMemberState,
  runId = "run_target"
): BatchExecution {
  return {
    batchId: "batch_guard",
    executionId: "first-cuts:batch_guard",
    renderedPrompt,
    inputHash,
    status,
    revision: 1,
    concurrency: 2,
    budgetLimitMicros: 1,
    reservedMicros: 0,
    settledMicros: 0,
    members: [
      {
        runId,
        position: 0,
        state: memberState,
        maxReservedMicros: 0,
      },
    ],
    startedAt: 1,
    updatedAt: 1,
  };
}

test("every member is protected while its parent Batch is active", () => {
  const states: BatchExecutionMemberState[] = [
    "queued",
    "running",
    "awaiting_review",
    "failed",
    "reconcile_required",
    "skipped_budget",
  ];
  for (const parent of ["queued", "running"] as const) {
    for (const member of states) {
      assert.equal(
        hasDeletionBlockingBatchWork("run_target", [
          execution(parent, member),
        ]),
        true,
        `${parent}/${member}`
      );
    }
  }
});

test("reconciliation remains protected after its parent Batch stops", () => {
  for (const parent of ["done", "failed"] as const) {
    assert.equal(
      hasDeletionBlockingBatchWork("run_target", [
        execution(parent, "reconcile_required"),
      ]),
      true,
      parent
    );
  }
});

test("settled terminal Batch members and unrelated runs are deletable", () => {
  assert.equal(
    hasDeletionBlockingBatchWork("run_target", [
      execution("done", "awaiting_review"),
      execution("failed", "failed", "run_other"),
    ]),
    false
  );
});

test("a Lamp paused for approval remains protected from deletion", () => {
  assert.equal(
    hasDeletionBlockingRunWork(null, { status: "user_action_required" }),
    true
  );
});
