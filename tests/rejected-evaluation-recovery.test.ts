import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  LAMP_COMBINED_GEMINI_OUTPUT_CONFIG,
  LAMP_COMBINED_HOLISTIC_RESULT_SCHEMA,
} from "../lib/lamp-combined-evaluation.ts";
import {
  isDefinitiveGeminiRequestRejection,
  isReplayableLampCombinedEvaluationFailure,
  isRetryableGeminiCapacityError,
} from "../lib/server/definitive-provider-rejection.ts";
import { rejectedPaidOperationArchiveId } from "../lib/server/rejected-paid-operation-archive.ts";
import {
  acknowledgeRejectedLampCombinedEvaluation,
  isAcknowledgedRejectedEvaluationError,
  isLampApprovalReplayTransition,
  isLampRejectedEvaluationAcknowledgeTransition,
  requeueLampExecutionAfterApproval,
} from "../lib/server/run-execution-resume.ts";
import { assertRunExecutionTransition } from "../lib/server/storage/run-execution.ts";
import type { RunExecution } from "../lib/types.ts";

const INVALID_ARGUMENT =
  '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}';
const UNAVAILABLE =
  '{"error":{"code":503,"message":"This model is currently experiencing high demand. Please try again later.","status":"UNAVAILABLE"}}';
const INPUT_HASH = "b".repeat(64);
const OPERATION_ID = "judge:1:lamp-combined-holistic:gemini";

test("only exact synchronous Gemini no-result responses are replayable", () => {
  assert.equal(isDefinitiveGeminiRequestRejection(INVALID_ARGUMENT), true);
  assert.equal(
    isDefinitiveGeminiRequestRejection(`ApiError: ${INVALID_ARGUMENT}`),
    true
  );
  assert.equal(
    isDefinitiveGeminiRequestRejection(
      '{"error":{"code":429,"message":"Rate limited","status":"RESOURCE_EXHAUSTED"}}'
    ),
    false
  );
  assert.equal(
    isDefinitiveGeminiRequestRejection(
      UNAVAILABLE
    ),
    true
  );
  assert.equal(isRetryableGeminiCapacityError(UNAVAILABLE), true);
  assert.equal(isRetryableGeminiCapacityError(INVALID_ARGUMENT), false);
  assert.equal(
    isDefinitiveGeminiRequestRejection(
      '{"error":{"code":500,"message":"Unknown result","status":"INTERNAL"}}'
    ),
    false
  );
  assert.equal(isDefinitiveGeminiRequestRejection("network timeout"), false);
  assert.equal(
    isReplayableLampCombinedEvaluationFailure(
      "Lamp Combined holistic evaluator returned an invalid result envelope. Received object keys evaluations."
    ),
    true
  );
  assert.equal(
    isReplayableLampCombinedEvaluationFailure(
      "Lamp Combined evaluation artifact hash does not match the approved aggregate plan."
    ),
    false
  );
});

test("the Combined provider schema stays inside Gemini's supported JSON Schema subset", () => {
  const allowed = new Set([
    "type",
    "additionalProperties",
    "required",
    "properties",
    "items",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "enum",
  ]);
  const inspect = (schema: unknown, path = "schema"): void => {
    assert.ok(schema && typeof schema === "object" && !Array.isArray(schema));
    const record = schema as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      assert.ok(allowed.has(key), `${path} uses unsupported keyword ${key}`);
    }
    if (Array.isArray(record.type)) {
      assert.ok(
        record.type.includes("null") && record.type.length === 2,
        `${path} uses an invalid nullable type`
      );
    } else {
      assert.notEqual(
        record.type,
        "null",
        `${path} cannot require only null output`
      );
    }
    if (record.properties && typeof record.properties === "object") {
      for (const [name, child] of Object.entries(
        record.properties as Record<string, unknown>
      )) {
        inspect(child, `${path}.properties.${name}`);
      }
    }
    if (record.items) inspect(record.items, `${path}.items`);
  };

  inspect(LAMP_COMBINED_HOLISTIC_RESULT_SCHEMA);
});

test("the Combined Gemini call uses the flat structured-output schema", () => {
  assert.equal(
    LAMP_COMBINED_GEMINI_OUTPUT_CONFIG.responseMimeType,
    "application/json"
  );
  assert.equal(
    LAMP_COMBINED_GEMINI_OUTPUT_CONFIG.responseJsonSchema,
    LAMP_COMBINED_HOLISTIC_RESULT_SCHEMA
  );
  const item = LAMP_COMBINED_HOLISTIC_RESULT_SCHEMA.properties.results.items;
  assert.ok("issue" in item.properties);
  assert.ok("correctionAction" in item.properties);
  assert.equal("violations" in item.properties, false);
});

function rejectedExecution(): RunExecution {
  const renderedPrompt = "Lamp Combined exact fixture prompt";
  return {
    runId: "run_combined_rejected_eval",
    executionId: "lamp-combined:run_combined_rejected_eval",
    source: "single",
    status: "reconcile_required",
    phase: "evaluating",
    iteration: 1,
    renderedPrompt,
    inputHash: createHash("sha256")
      .update(renderedPrompt, "utf8")
      .digest("hex"),
    combinedPlanOperationIds: [
      "plan:lamp-combined:background:gemini",
    ],
    approvedPlanHash: "a".repeat(64),
    relightIntensity: 100,
    workflowRunId: "wrun_rejected_eval",
    revision: 5,
    startedAt: 1_000,
    updatedAt: 2_000,
    error: "Durable Lamp Combined execution failed.",
  };
}

test("acknowledging an exact rejected Combined evaluation pauses for approval", () => {
  const current = rejectedExecution();
  const acknowledged = acknowledgeRejectedLampCombinedEvaluation(
    current,
    { operationId: OPERATION_ID, inputHash: INPUT_HASH },
    3_000
  );

  assert.equal(acknowledged.status, "user_action_required");
  assert.equal(acknowledged.phase, current.phase);
  assert.equal(acknowledged.iteration, current.iteration);
  assert.equal(acknowledged.workflowRunId, current.workflowRunId);
  assert.equal(isAcknowledgedRejectedEvaluationError(acknowledged.error), true);
  assert.equal(
    isLampRejectedEvaluationAcknowledgeTransition(current, acknowledged),
    true
  );
  assert.equal(
    assertRunExecutionTransition(current, acknowledged, current.revision),
    acknowledged
  );

  const requeued = requeueLampExecutionAfterApproval(acknowledged, 4_000);
  assert.equal(isLampApprovalReplayTransition(acknowledged, requeued), true);
  assert.equal(
    assertRunExecutionTransition(acknowledged, requeued, acknowledged.revision),
    requeued
  );
});

test("rejected paid-operation archive ids are deterministic and id-safe", () => {
  const archive = rejectedPaidOperationArchiveId(
    OPERATION_ID,
    INPUT_HASH,
    1_234
  );
  assert.equal(
    archive,
    rejectedPaidOperationArchiveId(OPERATION_ID, INPUT_HASH, 1_234)
  );
  assert.match(archive, /^[a-z0-9:_-]{1,160}$/);
  assert.notEqual(
    archive,
    rejectedPaidOperationArchiveId(OPERATION_ID, "c".repeat(64), 1_234)
  );
  assert.notEqual(
    archive,
    rejectedPaidOperationArchiveId(OPERATION_ID, INPUT_HASH, 1_235)
  );
});
