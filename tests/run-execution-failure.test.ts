import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticVideoGenerationStopReason,
  isGradeableVideoGeneration,
  runExecutionFailureStatus,
  videoGenerationPollErrorDisposition,
  videoGenerationWorkflowErrorMessage,
} from "../lib/server/run-execution-failure.ts";
import type { ProviderOperation } from "../lib/types.ts";

const OMNI_USAGE = {
  total_input_tokens: 3_000,
  total_output_tokens: 46_000,
  output_tokens_by_modality: [{ modality: "VIDEO", tokens: 46_000 }],
};

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
          usage: OMNI_USAGE,
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

test("only an audio-verified completed generation is gradeable", () => {
  const verified = operation("completed", {
    result: {
      videoUrl: "/api/media/run_fixture/relit-v1.mp4",
      rawUrl: "/api/media/run_fixture/gen-v1.mp4",
      durationSec: 9.9,
      audioVerified: true,
      usage: OMNI_USAGE,
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
