import assert from "node:assert/strict";
import test from "node:test";

import {
  COMBINED_COMPLETED_EVIDENCE_INCOMPLETE,
  readCompletedCombinedPlannerEvidence,
  recoverCompletedCombinedEvidence,
} from "../lib/server/completed-workflow-recovery.ts";
import type { RunExecution } from "../lib/types.ts";

const RUN_ID = "combined_completed_recovery";

function runningCombinedExecution(hasBothReceipts: boolean): RunExecution {
  return {
    runId: RUN_ID,
    executionId: `lamp-combined:${RUN_ID}`,
    inputHash: "a".repeat(64),
    renderedPrompt: "exact persisted Combined prompt",
    combinedPlanOperationIds: [
      "plan:lamp-combined:background:gemini",
    ],
    approvedPlanHash: "b".repeat(64),
    relightIntensity: 50,
    combinedCandidateReceipts: {
      initial: { iteration: 1 } as never,
      ...(hasBothReceipts ? { final: { iteration: 2 } as never } : {}),
    },
    source: "single",
    status: "running",
    phase: "finalizing",
    iteration: 2,
    revision: 7,
    startedAt: 10,
    updatedAt: 20,
    workflowRunId: "workflow-completed",
  };
}

test("a completed Workflow with exact Combined evidence performs settlement only", async () => {
  const observed = runningCombinedExecution(true);
  let repairCalls = 0;
  let sealCalls = 0;

  const result = await recoverCompletedCombinedEvidence(observed, {
    repairSettlement: async () => {
      repairCalls += 1;
      // Production wires this callback to repairCompletedRunExecution, whose
      // exact validator requires both candidate receipts and all journals.
      assert.ok(observed.combinedCandidateReceipts?.initial);
      assert.ok(observed.combinedCandidateReceipts?.final);
      return {
        ...observed,
        status: "awaiting_review",
        phase: "complete",
        revision: observed.revision + 1,
        updatedAt: 30,
      };
    },
    sealIncompleteEvidence: async () => {
      sealCalls += 1;
      return null;
    },
  });

  assert.equal(result.outcome, "settled");
  assert.equal(result.execution?.status, "awaiting_review");
  assert.equal(result.enqueued, false);
  assert.equal(repairCalls, 1);
  assert.equal(sealCalls, 0);
});

test("a completed Workflow with missing Combined evidence seals without replay", async () => {
  const observed = runningCombinedExecution(false);
  let repairCalls = 0;
  let sealCalls = 0;

  const result = await recoverCompletedCombinedEvidence(observed, {
    repairSettlement: async () => {
      repairCalls += 1;
      // Exact settlement declines because Final's receipt is absent.
      assert.equal(observed.combinedCandidateReceipts?.final, undefined);
      return observed;
    },
    sealIncompleteEvidence: async (current, error) => {
      sealCalls += 1;
      assert.equal(error, COMBINED_COMPLETED_EVIDENCE_INCOMPLETE);
      return {
        ...current,
        status: "reconcile_required",
        revision: current.revision + 1,
        updatedAt: 30,
        error,
      };
    },
  });

  assert.equal(result.outcome, "evidence_incomplete");
  assert.equal(result.execution?.status, "reconcile_required");
  assert.match(result.execution?.error ?? "", /No provider work was restarted/);
  assert.equal(result.enqueued, false);
  assert.equal(repairCalls, 1);
  assert.equal(sealCalls, 1);
});

test("a missing production planner proof CAS-seals instead of escaping as a retryable error", async () => {
  const observed = runningCombinedExecution(true);
  let durable = observed;
  let plannerReads = 0;
  let sealCalls = 0;

  const result = await recoverCompletedCombinedEvidence(observed, {
    repairSettlement: async () => {
      // repairCompletedRunExecution uses this exact reader. A durable null is
      // proof absence, not an exception; rejected reads still propagate as
      // transient infrastructure failures and therefore are not sealed.
      const planners = await readCompletedCombinedPlannerEvidence(
        observed.combinedPlanOperationIds,
        async () => {
          plannerReads += 1;
          return null;
        }
      );
      assert.equal(planners, null);
      return observed;
    },
    sealIncompleteEvidence: async (current, error) => {
      sealCalls += 1;
      assert.equal(current.revision, durable.revision);
      durable = {
        ...current,
        status: "reconcile_required",
        revision: current.revision + 1,
        updatedAt: 30,
        error,
      };
      return durable;
    },
  });

  assert.equal(result.outcome, "evidence_incomplete");
  assert.equal(result.execution?.status, "reconcile_required");
  assert.equal(result.execution?.revision, observed.revision + 1);
  assert.equal(result.enqueued, false);
  assert.equal(plannerReads, 1);
  assert.equal(sealCalls, 1);
});

test("a rejected planner read remains retryable and is never sealed as missing proof", async () => {
  const observed = runningCombinedExecution(true);
  let sealCalls = 0;

  await assert.rejects(
    recoverCompletedCombinedEvidence(observed, {
      repairSettlement: async () => {
        await readCompletedCombinedPlannerEvidence(
          observed.combinedPlanOperationIds,
          async () => {
            throw new Error("temporary storage outage");
          }
        );
        return observed;
      },
      sealIncompleteEvidence: async () => {
        sealCalls += 1;
        return null;
      },
    }),
    /temporary storage outage/
  );
  assert.equal(sealCalls, 0);
});

test("a declined orphan Final repair proof CAS-seals fail-closed", async () => {
  const observed = runningCombinedExecution(true);
  let durable = observed;
  let sealCalls = 0;

  const result = await recoverCompletedCombinedEvidence(observed, {
    // The runtime receipt regression proves that in-progress, completed, and
    // reconcile-required repair journals all decline when the receipt is absent.
    repairSettlement: async () => durable,
    sealIncompleteEvidence: async (current, error) => {
      sealCalls += 1;
      assert.equal(current.revision, durable.revision);
      durable = {
        ...current,
        status: "reconcile_required",
        revision: current.revision + 1,
        updatedAt: 30,
        error,
      };
      return durable;
    },
  });

  assert.equal(result.outcome, "evidence_incomplete");
  assert.equal(result.execution?.status, "reconcile_required");
  assert.equal(result.enqueued, false);
  assert.equal(sealCalls, 1);
});
