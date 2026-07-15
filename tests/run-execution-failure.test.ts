import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CONSECUTIVE_PERMANENT_POLL_FAILURES,
  MIN_PERMANENT_POLL_FAILURE_WINDOW_MS,
  automaticVideoGenerationStopReason,
  classifyVideoGenerationPollError,
  isGradeableVideoGeneration,
  isProviderLostInteraction,
  permanentPollFailuresExhausted,
  providerLostInteractionError,
  runExecutionFailureStatus,
  videoGenerationPollErrorDisposition,
  videoGenerationWorkflowErrorMessage,
} from "../lib/server/run-execution-failure.ts";
import type { ProviderOperation } from "../lib/types.ts";

function operation(
  status: ProviderOperation["status"],
  overrides: Partial<ProviderOperation> = {}
): ProviderOperation {
  return {
    id: "video-generation:1",
    provider: "gemini",
    kind: "video_generation",
    iteration: 1,
    providerInteractionId: "provider-interaction-fixture",
    status,
    startedAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

test("a deterministic finalization reconciliation stops automatic polling", () => {
  const persisted = operation("reconcile_required", {
    error: "The raw provider output exceeds the immutable per-generation authorization.",
  });

  assert.equal(videoGenerationPollErrorDisposition(persisted), "terminal");
  assert.equal(
    automaticVideoGenerationStopReason(persisted),
    persisted.error
  );
  assert.equal(
    runExecutionFailureStatus({
      evaluationAmbiguous: false,
      generation: persisted,
    }),
    "reconcile_required"
  );
});

test("an in-progress provider journal remains eligible for non-billed polling", () => {
  assert.equal(
    automaticVideoGenerationStopReason(operation("in_progress")),
    null
  );
});

test("parent bookkeeping preserves the original reconciliation reason", () => {
  const persisted = operation("reconcile_required", {
    error: "The raw artifact exceeded its authorized duration.",
  });

  assert.equal(
    videoGenerationWorkflowErrorMessage(
      persisted,
      "Workflow wrapped and replaced this useful provider reason."
    ),
    persisted.error
  );
});

test("a reconciliation journal with an empty legacy error still stops", () => {
  const persisted = operation("reconcile_required", { error: "" });

  assert.equal(
    automaticVideoGenerationStopReason(persisted),
    "Video generation requires provider reconciliation."
  );
  assert.equal(videoGenerationPollErrorDisposition(persisted), "terminal");
});

test("an unresolved provider interaction remains safe to poll", () => {
  assert.equal(
    videoGenerationPollErrorDisposition(operation("in_progress")),
    "retryable"
  );
});

test("a completed durable artifact is recovered after a poll error", () => {
  assert.equal(
    videoGenerationPollErrorDisposition(
      operation("completed", {
        result: {
          videoUrl: "/api/media/run_fixture/relit-v1.mp4",
          rawUrl: "/api/media/run_fixture/gen-v1.mp4",
          durationSec: 8,
          audioVerified: true,
          costUsd: 0.6,
        },
      })
    ),
    "completed"
  );
});

test("a definitive provider failure fails the parent without reconciliation", () => {
  const persisted = operation("failed");

  assert.equal(videoGenerationPollErrorDisposition(persisted), "terminal");
  assert.equal(
    runExecutionFailureStatus({
      evaluationAmbiguous: false,
      generation: persisted,
    }),
    "failed"
  );
});

test("provider completion without a materialized artifact requires reconciliation", () => {
  const providerCompleted = operation("completed", { result: undefined });

  assert.equal(
    runExecutionFailureStatus({
      evaluationAmbiguous: false,
      generation: providerCompleted,
    }),
    "reconcile_required"
  );
});

test("provider 400/404 read failures classify as permanent", () => {
  const badRequest = Object.assign(
    new Error("got status: 400 Bad Request"),
    { status: 400 }
  );
  const notFound = Object.assign(new Error("not found"), { status: 404 });

  assert.equal(classifyVideoGenerationPollError(badRequest), "permanent");
  assert.equal(classifyVideoGenerationPollError(notFound), "permanent");
});

test("rate limits, server faults, and network errors stay transient", () => {
  assert.equal(
    classifyVideoGenerationPollError(
      Object.assign(new Error("quota"), { status: 429 })
    ),
    "transient"
  );
  assert.equal(
    classifyVideoGenerationPollError(
      Object.assign(new Error("internal"), { status: 500 })
    ),
    "transient"
  );
  assert.equal(
    classifyVideoGenerationPollError(new Error("fetch failed")),
    "transient"
  );
  assert.equal(classifyVideoGenerationPollError(undefined), "transient");
  assert.equal(classifyVideoGenerationPollError("400"), "transient");
});

test("a wrapped permanent rejection is recognized from its message", () => {
  assert.equal(
    classifyVideoGenerationPollError(
      new Error("400 Request contains an invalid argument.")
    ),
    "permanent"
  );
  assert.equal(
    classifyVideoGenerationPollError(
      new Error("upstream said INVALID_ARGUMENT for this interaction")
    ),
    "permanent"
  );
});

test("a numeric provider status outranks a scary-looking message", () => {
  assert.equal(
    classifyVideoGenerationPollError(
      Object.assign(new Error("NOT_FOUND while proxying"), { status: 503 })
    ),
    "transient"
  );
});

test("the lost-interaction seal needs both a streak and elapsed time", () => {
  const firstAt = 1_000_000;
  const window = MIN_PERMANENT_POLL_FAILURE_WINDOW_MS;
  const count = MAX_CONSECUTIVE_PERMANENT_POLL_FAILURES;

  assert.equal(
    permanentPollFailuresExhausted(count - 1, firstAt, firstAt + window * 10),
    false
  );
  assert.equal(
    permanentPollFailuresExhausted(count * 10, firstAt, firstAt + window - 1),
    false
  );
  assert.equal(
    permanentPollFailuresExhausted(count, firstAt, firstAt + window),
    true
  );
});

test("a sealed lost interaction is terminal and reconciles the parent", () => {
  const reason = providerLostInteractionError("interactions/lost-fixture", 16, 128_000);
  const sealed = operation("reconcile_required", { error: reason });

  assert.equal(isProviderLostInteraction(sealed), true);
  assert.equal(videoGenerationPollErrorDisposition(sealed), "terminal");
  assert.equal(automaticVideoGenerationStopReason(sealed), reason);
  assert.equal(
    runExecutionFailureStatus({
      evaluationAmbiguous: false,
      generation: sealed,
    }),
    "reconcile_required"
  );
});

test("the lost-interaction marker never matches other journal states", () => {
  const reason = providerLostInteractionError("interactions/lost-fixture", 6, 130_000);

  assert.equal(
    isProviderLostInteraction(operation("in_progress", { error: reason })),
    false
  );
  assert.equal(
    isProviderLostInteraction(
      operation("reconcile_required", {
        error: "The raw provider output exceeds the immutable per-generation authorization.",
      })
    ),
    false
  );
});

test("only an audio-verified completed generation is gradeable", () => {
  const verified = operation("completed", {
    result: {
      videoUrl: "/api/media/run_fixture/relit-v1.mp4",
      rawUrl: "/api/media/run_fixture/gen-v1.mp4",
      durationSec: 9.9,
      audioVerified: true,
      costUsd: 1,
    },
  });

  assert.equal(isGradeableVideoGeneration(verified), true);
  assert.equal(
    isGradeableVideoGeneration({
      ...verified,
      result: { ...verified.result!, audioVerified: false },
    }),
    false
  );
});
