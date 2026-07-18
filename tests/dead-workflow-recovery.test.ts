import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyWorkflowRunLiveness,
  deadWorkflowExecutionError,
  deadWorkflowSealMessage,
} from "../lib/server/dead-workflow-messages.ts";
import { isProviderLostInteractionError } from "../lib/lost-interaction.ts";

test("completed Workflow status is terminal and never reported as alive", () => {
  assert.equal(classifyWorkflowRunLiveness(true, "pending"), "alive");
  assert.equal(classifyWorkflowRunLiveness(true, "running"), "alive");
  assert.equal(classifyWorkflowRunLiveness(true, "completed"), "completed");
  assert.equal(classifyWorkflowRunLiveness(true, "failed"), "failed");
  assert.equal(classifyWorkflowRunLiveness(false, "running"), "missing");
});

test("a provider-confirmed loss seals with the shared marker prefix", () => {
  const sealed = deadWorkflowSealMessage(
    "cancelled",
    "400 Request contains an invalid argument."
  );
  assert.equal(isProviderLostInteractionError(sealed), true);
  assert.match(sealed, /durable workflow was cancelled/);
  assert.match(sealed, /400 Request contains an invalid argument\./);
  assert.match(sealed, /fresh interaction under a new spend approval/);
  assert.ok(sealed.length <= 500);
});

test("a missing workflow run is described as no longer existing", () => {
  const sealed = deadWorkflowSealMessage("missing", "404 not found");
  assert.match(sealed, /durable workflow no longer exists/);
  assert.equal(isProviderLostInteractionError(sealed), true);
});

test("an unconfirmed dead-workflow reason never carries the marker", () => {
  for (const state of ["missing", "failed", "cancelled"] as const) {
    const reason = deadWorkflowExecutionError(state);
    assert.equal(isProviderLostInteractionError(reason), false);
    assert.match(reason, /No automatic retry will run\./);
  }
});

test("a still-readable interaction is surfaced as operator-owned detail", () => {
  const reason = deadWorkflowExecutionError(
    "cancelled",
    "Its provider interaction is still readable upstream; finalize or cancel that interaction manually before any re-run."
  );
  assert.equal(isProviderLostInteractionError(reason), false);
  assert.match(reason, /still readable upstream/);
  assert.ok(reason.length <= 2_000);
});
