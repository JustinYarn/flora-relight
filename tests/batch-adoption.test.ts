import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { assertBatchExecutionTransition } from "../lib/server/storage/batch-execution.ts";
import { initialMegaPrompt } from "../lib/prompts/mega-prompt.ts";
import { lampMaximumMicros } from "../lib/server/spend-approval.ts";
import type { BatchExecution } from "../lib/types.ts";

function runningExecution(): BatchExecution {
  const renderedPrompt = initialMegaPrompt("lamp").rendered;
  const reservation = lampMaximumMicros();
  return {
    batchId: "batch_adoption_fixture",
    executionId: "lamp-batch:batch_adoption_fixture",
    workflowMode: "lamp",
    renderedPrompt,
    inputHash: createHash("sha256").update(renderedPrompt, "utf8").digest("hex"),
    status: "running",
    revision: 4,
    concurrency: 2,
    budgetLimitMicros: reservation,
    reservedMicros: reservation,
    settledMicros: 0,
    members: [
      {
        runId: "run_adoption_fixture",
        position: 0,
        state: "queued",
        maxReservedMicros: reservation,
      },
    ],
    startedAt: 100,
    approvalStartedAt: 100,
    updatedAt: 200,
    workflowRunId: "workflow-parent-dead",
  };
}

test("a dead-workflow release may clear the binding of a running execution", () => {
  const current = runningExecution();
  const released: BatchExecution = {
    ...current,
    workflowRunId: undefined,
    revision: 5,
    updatedAt: 300,
  };
  assert.equal(assertBatchExecutionTransition(current, released, 4), released);
});

test("a released running execution accepts a fresh contender binding", () => {
  const released: BatchExecution = {
    ...runningExecution(),
    workflowRunId: undefined,
    revision: 5,
    updatedAt: 300,
  };
  const adopted: BatchExecution = {
    ...released,
    workflowRunId: "workflow-parent-adopted",
    revision: 6,
    updatedAt: 400,
  };
  assert.equal(assertBatchExecutionTransition(released, adopted, 5), adopted);
});

test("direct rebinding to a different workflow stays forbidden", () => {
  const current = runningExecution();
  assert.throws(
    () =>
      assertBatchExecutionTransition(
        current,
        {
          ...current,
          workflowRunId: "workflow-parent-hijack",
          revision: 5,
          updatedAt: 300,
        },
        4
      ),
    /workflowRunId is immutable after binding/
  );
});

test("a release cannot smuggle a status change alongside it", () => {
  const current = runningExecution();
  assert.throws(
    () =>
      assertBatchExecutionTransition(
        current,
        {
          ...current,
          workflowRunId: undefined,
          status: "done",
          revision: 5,
          updatedAt: 300,
        },
        4
      )
  );
});
