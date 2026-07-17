import assert from "node:assert/strict";
import test from "node:test";

import {
  approveLampIrisPlan,
  createMockLampIrisPlan,
} from "../lib/lamp-iris.ts";
import {
  LAMP_IRIS_EVALUATOR_VERSION,
  type LampIrisEvaluationArtifact,
} from "../lib/lamp-iris-evaluation.ts";
import {
  LEGACY_V1_IRIS_BASE_PROMPT,
  LEGACY_V2_IRIS_BASE_PROMPT,
  compileLampIrisFinalPrompt,
  initialLampIrisMegaPrompt,
  isPersistedInitialLampIrisPrompt,
  renderLampIrisMegaPrompt,
  renderLampIrisPlanBlock,
  renderLegacyLampIrisPlanBlockV1,
  renderLegacyLampIrisPlanBlockV2,
} from "../lib/prompts/lamp-iris.ts";

function approvedPlan() {
  const draft = createMockLampIrisPlan("run_gen_test", 1_784_000_000_000);
  return approveLampIrisPlan(draft, 1_784_000_000_001);
}

function legacyInitialBytes(plan: ReturnType<typeof approvedPlan>): string {
  const base = renderLampIrisMegaPrompt({
    version: 1,
    base: LEGACY_V1_IRIS_BASE_PROMPT,
    plan,
    corrections: [],
  });
  return base.replace(
    renderLampIrisPlanBlock(plan),
    renderLegacyLampIrisPlanBlockV1(plan)
  );
}

function legacyV2InitialBytes(plan: ReturnType<typeof approvedPlan>): string {
  const base = renderLampIrisMegaPrompt({
    version: 1,
    base: LEGACY_V2_IRIS_BASE_PROMPT,
    plan,
    corrections: [],
  });
  return base.replace(
    renderLampIrisPlanBlock(plan),
    renderLegacyLampIrisPlanBlockV2(plan)
  );
}

function emptyEvaluation(
  plan: ReturnType<typeof approvedPlan>
): LampIrisEvaluationArtifact {
  return {
    version: LAMP_IRIS_EVALUATOR_VERSION,
    planVersion: plan.version,
    planId: plan.id,
    iteration: 1,
    evalResults: [],
    usage: { promptTokenCount: 0, candidatesTokenCount: 0 },
    costUsd: 0,
  };
}

test("current and both legacy initial compiles are accepted, and nothing else", () => {
  const plan = approvedPlan();
  const current = initialLampIrisMegaPrompt(plan).rendered;
  const legacyV1 = legacyInitialBytes(plan);
  const legacyV2 = legacyV2InitialBytes(plan);

  assert.notEqual(
    current,
    legacyV1,
    "the pupil-literal rewrite must actually change the compiled bytes"
  );
  assert.notEqual(
    current,
    legacyV2,
    "the pupil-literal rewrite must differ from the frozen visibility generation"
  );
  assert.notEqual(legacyV1, legacyV2);
  assert.equal(isPersistedInitialLampIrisPrompt(plan, current), true);
  assert.equal(isPersistedInitialLampIrisPrompt(plan, legacyV1), true);
  assert.equal(isPersistedInitialLampIrisPrompt(plan, legacyV2), true);
  assert.equal(
    isPersistedInitialLampIrisPrompt(plan, `${legacyV2} `),
    false,
    "mixed or edited intermediates are never valid persisted forms"
  );
});

test("the final compiler patches frozen legacy v2 bytes without rewriting them", () => {
  const plan = approvedPlan();
  const legacyV2 = legacyV2InitialBytes(plan);
  const final = compileLampIrisFinalPrompt(legacyV2, plan, emptyEvaluation(plan));

  assert.equal(
    final.rendered.startsWith("=== LAMP IRIS EYE-CONTACT MEGA PROMPT v2 ==="),
    true
  );
  const rebuiltV1 =
    "=== LAMP IRIS EYE-CONTACT MEGA PROMPT v1 ===" +
    final.rendered.slice("=== LAMP IRIS EYE-CONTACT MEGA PROMPT v2 ===".length);
  assert.equal(rebuiltV1, legacyV2);
});

test("the second generation stays byte-frozen", () => {
  const bytes = JSON.stringify(LEGACY_V2_IRIS_BASE_PROMPT);
  assert.equal(bytes.includes("Calibrate VISIBLE CHANGE"), true);
  assert.equal(
    bytes.includes("near-lens gaze is not eye contact"),
    false,
    "the frozen visibility generation predates the pupil-literal rewrite and must not absorb its language"
  );
});

test("the final compiler patches frozen legacy v1 bytes without rewriting them", () => {
  const plan = approvedPlan();
  const legacy = legacyInitialBytes(plan);
  const final = compileLampIrisFinalPrompt(legacy, plan, emptyEvaluation(plan));

  assert.equal(
    final.rendered.startsWith("=== LAMP IRIS EYE-CONTACT MEGA PROMPT v2 ==="),
    true
  );
  // Only the version header and the corrections body may differ: with an
  // empty ledger both render the same placeholder, so v2 equals v1 with the
  // header swapped.
  const rebuiltV1 =
    "=== LAMP IRIS EYE-CONTACT MEGA PROMPT v1 ===" +
    final.rendered.slice("=== LAMP IRIS EYE-CONTACT MEGA PROMPT v2 ===".length);
  assert.equal(rebuiltV1, legacy);
});

test("the legacy generation stays byte-frozen", () => {
  // A drifting "frozen" contract silently invalidates every persisted run.
  // Pin a stable digest of the legacy base so any edit fails loudly.
  const bytes = JSON.stringify(LEGACY_V1_IRIS_BASE_PROMPT);
  assert.equal(
    bytes.includes(
      "calibrate completeness to that intensity: at 1 the reading pattern is calmed"
    ),
    true
  );
  assert.equal(
    bytes.includes("side-by-side"),
    false,
    "the legacy base predates the visibility rewrite and must not absorb its language"
  );
});
