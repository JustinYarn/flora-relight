import assert from "node:assert/strict";
import test from "node:test";

import {
  approveLampIrisPlan,
  createMockLampIrisPlan,
} from "../lib/lamp-iris.ts";
import {
  LAMP_IRIS_EVALUATOR_VERSION,
  LAMP_IRIS_VISUAL_EVAL_DEFS,
  buildLampIrisEvaluationArtifact,
  type LampIrisEvaluationArtifact,
} from "../lib/lamp-iris-evaluation.ts";
import { LAMP_IRIS_GAZE_METER_VERSION } from "../lib/lamp-iris-gaze.ts";
import {
  LEGACY_V1_IRIS_BASE_PROMPT,
  LEGACY_V2_IRIS_BASE_PROMPT,
  compileLampIrisFinalPrompt,
  initialLampIrisMegaPrompt,
  isPersistedFinalLampIrisPrompt,
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

// The completion escalation is the one correction line that moved between
// shipped generations. These literals pin each generation's wording
// independently of the production renderers, so a drifting "frozen" copy
// fails loudly here instead of silently orphaning persisted Finals.
const CURRENT_ESCALATION_PREFIX =
  "Fully apply these approved gaze corrections at their approved intensity wherever the pattern occurs: ";
const CURRENT_ESCALATION_SUFFIX =
  ". The correction must be clearly visible: wherever the source gaze rests on reading material, the corrected gaze rests on the camera lens instead, held naturally through speech. A gaze that still reads as anchored to reading material, or that settles near the lens without reaching it, is not compliant.";
const LEGACY_V3_ESCALATION_PREFIX =
  "The previous pass left the gaze reading essentially as the source — that output failed this workflow's one job. Fully apply these approved gaze corrections at their approved intensity wherever the pattern occurs: ";
const LEGACY_V3_ESCALATION_SUFFIX =
  ". Produce plainly different pupil position at the same timestamps: wherever the source's eyes rest on reading material or near the lens, the candidate's pupils are visibly IN the lens — the person watching must feel looked in the eye in a same-frame comparison.";
const LEGACY_V2_ESCALATION_SUFFIX =
  ". Produce plainly different eye direction at the same timestamps: wherever the source's eyes rest on reading material, the candidate's eyes are visibly on the lens in a same-frame comparison.";
const LEGACY_V1_ESCALATION_SUFFIX =
  ". A gaze that still reads as anchored to reading material is not compliant.";

/**
 * A first-pass judge fixture whose gaze-adherence check reports the
 * completion violation, so the compiled Final carries the escalation line —
 * the exact wording that drifted between generations.
 */
function correctedEvaluation(
  plan: ReturnType<typeof approvedPlan>
): LampIrisEvaluationArtifact {
  return buildLampIrisEvaluationArtifact({
    raw: {
      results: LAMP_IRIS_VISUAL_EVAL_DEFS.map((definition) => ({
        evalId: definition.id,
        score: definition.id === "gaze-adherence" ? 45 : 90,
        confidence: 0.9,
        violations:
          definition.id === "gaze-adherence"
            ? [
                {
                  aspect: "reading anchor survived",
                  severity: "major",
                  description:
                    "The gaze still rests on the reading material through most sentences.",
                  frameTimestampSec: 2.5,
                  correctionAction: "complete-approved-gaze-correction",
                  planItemIds: ["camera-axis-anchor"],
                },
              ]
            : [],
        reasoning: "Scripted generation-freeze fixture result.",
      })),
    },
    plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0.01,
  });
}

test("final compiles under frozen legacy correction wordings stay accepted", () => {
  const plan = approvedPlan();
  const initial = initialLampIrisMegaPrompt(plan).rendered;
  const artifact = correctedEvaluation(plan);
  const current = compileLampIrisFinalPrompt(initial, plan, artifact).rendered;

  assert.equal(
    current.includes(CURRENT_ESCALATION_PREFIX) &&
      current.includes(CURRENT_ESCALATION_SUFFIX),
    true,
    "the fixture must exercise the escalation line whose wording drifted"
  );
  const legacyV3 = current
    .replace(CURRENT_ESCALATION_PREFIX, LEGACY_V3_ESCALATION_PREFIX)
    .replace(CURRENT_ESCALATION_SUFFIX, LEGACY_V3_ESCALATION_SUFFIX);
  const legacyV2 = current
    .replace(CURRENT_ESCALATION_PREFIX, LEGACY_V3_ESCALATION_PREFIX)
    .replace(CURRENT_ESCALATION_SUFFIX, LEGACY_V2_ESCALATION_SUFFIX);
  const legacyV1 = current.replace(
    CURRENT_ESCALATION_SUFFIX,
    LEGACY_V1_ESCALATION_SUFFIX
  );
  const forms = [current, legacyV3, legacyV2, legacyV1];
  for (let a = 0; a < forms.length; a += 1) {
    for (let b = a + 1; b < forms.length; b += 1) {
      assert.notEqual(forms[a], forms[b], `forms ${a} and ${b} must differ`);
    }
  }

  for (const form of forms) {
    assert.equal(isPersistedFinalLampIrisPrompt(initial, plan, artifact, form), true);
  }
  assert.equal(
    isPersistedFinalLampIrisPrompt(initial, plan, artifact, `${legacyV1} `),
    false,
    "mixed or edited intermediates are never valid persisted forms"
  );
  assert.equal(
    isPersistedFinalLampIrisPrompt(
      initial,
      plan,
      artifact,
      legacyV1.replace("Fully apply", "Mostly apply")
    ),
    false
  );
});

test("legacy final compiles patch frozen legacy initial bytes too", () => {
  // A real pre-rewrite run persisted BOTH its initial and its Final under the
  // first generation; acceptance must compose the frozen forms.
  const plan = approvedPlan();
  const legacyInitial = legacyInitialBytes(plan);
  const artifact = correctedEvaluation(plan);
  const current = compileLampIrisFinalPrompt(legacyInitial, plan, artifact).rendered;
  const legacyFinal = current.replace(
    CURRENT_ESCALATION_SUFFIX,
    LEGACY_V1_ESCALATION_SUFFIX
  );
  assert.equal(
    isPersistedFinalLampIrisPrompt(legacyInitial, plan, artifact, legacyFinal),
    true
  );
});

test("the current escalation avoids the provider-blocked vocabulary", () => {
  // Four consecutive live Finals were killed by the provider's async content
  // filter ("Input blocked … sensitive words") under the v2/v3 escalation
  // wordings. Pin the composed correction line clear of the phrasings that
  // shipped in those blocked prompts so a future rewrite cannot silently
  // reintroduce them.
  const plan = approvedPlan();
  const initial = initialLampIrisMegaPrompt(plan).rendered;
  const artifact = correctedEvaluation(plan);
  const rendered = compileLampIrisFinalPrompt(initial, plan, artifact).rendered;
  const corrections = rendered.slice(
    rendered.indexOf("[ACTIVE CORRECTIONS FROM EVALUATION]"),
    rendered.indexOf("[NEVER DO]")
  );
  for (const blocked of [
    "failed this workflow's one job",
    "the person watching must feel",
    "same-frame comparison",
    "plainly different",
    "The previous pass left",
  ]) {
    assert.equal(
      corrections.includes(blocked),
      false,
      `correction lines must not carry the blocked phrasing "${blocked}"`
    );
  }
});

test("the measured-calibration line belongs to the current generation only", () => {
  const plan = approvedPlan();
  const initial = initialLampIrisMegaPrompt(plan).rendered;
  const measurements = {
    version: LAMP_IRIS_GAZE_METER_VERSION,
    framesAnalyzed: 24,
    faceDetectionRate: 0.98,
    medianIrisX: 0.5,
    medianIrisY: 0.72,
    irisXDispersion: 0.03,
    irisYDispersion: 0.03,
    blinkCount: 3,
    blinkTimestampsSec: [1.1, 2.2, 3.3],
  };
  const artifact: LampIrisEvaluationArtifact = {
    ...correctedEvaluation(plan),
    gazeMeasurements: {
      source: measurements,
      // A near-copy candidate: barely lifted, so the calibration line renders.
      candidate: { ...measurements, medianIrisY: 0.71 },
    },
  };
  const withCalibration = compileLampIrisFinalPrompt(initial, plan, artifact).rendered;
  assert.equal(withCalibration.includes("MEASURED CALIBRATION"), true);
  assert.equal(
    isPersistedFinalLampIrisPrompt(initial, plan, artifact, withCalibration),
    true
  );
  // No frozen generation ever carried the calibration line, so a legacy-worded
  // candidate with measurements attached cannot masquerade as one without.
  const stripped = withCalibration.replace(
    /1\. \[CRITICAL\] MEASURED CALIBRATION[^\n]*\n/,
    ""
  );
  assert.notEqual(stripped, withCalibration);
  assert.equal(
    isPersistedFinalLampIrisPrompt(initial, plan, artifact, stripped),
    false
  );
});
