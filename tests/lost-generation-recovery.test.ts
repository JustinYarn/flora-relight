import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { providerLostInteractionError } from "../lib/server/run-execution-failure.ts";
import {
  LAMP_USER_ACTION_REQUIRED_PREFIX,
  acknowledgeLostLampGeneration,
  isAcknowledgedLostGenerationError,
  isLampApprovalReplayTransition,
  isLampLostGenerationAcknowledgeTransition,
  requeueLampExecutionAfterApproval,
} from "../lib/server/run-execution-resume.ts";
import { lostGenerationArchiveId } from "../lib/server/lost-generation-archive.ts";
import type { RunExecution } from "../lib/types.ts";

const PROMPT = "RELIGHT v1 fixture prompt";
const LOST_REASON = providerLostInteractionError(
  "interactions/lost-fixture",
  16,
  130_000
);

function lostExecution(overrides: Partial<RunExecution> = {}): RunExecution {
  return {
    runId: "run_fixture",
    executionId: "lamp:run_fixture",
    source: "single",
    status: "reconcile_required",
    phase: "video_generation",
    iteration: 2,
    renderedPrompt: PROMPT,
    inputHash: createHash("sha256").update(PROMPT, "utf8").digest("hex"),
    workflowRunId: "wrun_fixture",
    revision: 9,
    startedAt: 1_000,
    updatedAt: 2_000,
    error: LOST_REASON,
    ...overrides,
  };
}

test("acknowledging a lost generation pauses the execution for approval", () => {
  const current = lostExecution();
  const acknowledged = acknowledgeLostLampGeneration(current, 3_000);

  assert.equal(acknowledged.status, "user_action_required");
  assert.equal(acknowledged.revision, current.revision + 1);
  assert.equal(acknowledged.iteration, current.iteration);
  assert.equal(acknowledged.workflowRunId, current.workflowRunId);
  assert.equal(
    acknowledged.error,
    `${LAMP_USER_ACTION_REQUIRED_PREFIX}${LOST_REASON}`
  );
  assert.equal(isAcknowledgedLostGenerationError(acknowledged.error), true);
  assert.equal(
    isLampLostGenerationAcknowledgeTransition(current, acknowledged),
    true
  );
});

test("only the provider-lost seal may leave reconcile_required", () => {
  const otherReconcile = lostExecution({
    error: "The raw provider output exceeds the immutable per-generation authorization.",
  });

  assert.throws(() => acknowledgeLostLampGeneration(otherReconcile));
  assert.equal(
    isLampLostGenerationAcknowledgeTransition(
      otherReconcile,
      acknowledgeLostLampGeneration(lostExecution())
    ),
    false
  );
  assert.throws(() =>
    acknowledgeLostLampGeneration(
      lostExecution({ executionId: "first-cut:run_fixture" })
    )
  );
  assert.throws(() =>
    acknowledgeLostLampGeneration(lostExecution({ status: "running" }))
  );
});

test("an acknowledged loss re-arms through the existing approval replay", () => {
  const acknowledged = acknowledgeLostLampGeneration(lostExecution(), 3_000);
  const requeued = requeueLampExecutionAfterApproval(acknowledged, 4_000);

  assert.equal(requeued.status, "queued");
  assert.equal(requeued.phase, "queued");
  assert.equal(requeued.iteration, 0);
  assert.equal(requeued.workflowRunId, undefined);
  assert.equal(requeued.error, undefined);
  assert.equal(
    isLampApprovalReplayTransition(acknowledged, requeued),
    true
  );
});

test("the archived journal id is deterministic and id-charset safe", () => {
  const first = lostGenerationArchiveId(
    "video-generation:2",
    "interactions/Lost+Fixture=="
  );

  assert.equal(
    first,
    lostGenerationArchiveId("video-generation:2", "interactions/Lost+Fixture==")
  );
  assert.notEqual(
    first,
    lostGenerationArchiveId("video-generation:2", "interactions/another")
  );
  assert.match(first, /^video-generation:2:lost:[a-f0-9]{16}$/);
  assert.match(first, /^[a-z0-9:_-]{1,160}$/);
});

test("generic paused-for-approval errors are not lost acknowledgments", () => {
  assert.equal(
    isAcknowledgedLostGenerationError(
      `${LAMP_USER_ACTION_REQUIRED_PREFIX}Lamp spend approval must be renewed.`
    ),
    false
  );
  assert.equal(isAcknowledgedLostGenerationError(undefined), false);
});
