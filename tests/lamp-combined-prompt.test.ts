import assert from "node:assert/strict";
import test from "node:test";

import {
  approveLampCombinedPlan,
  buildLampCombinedPlan,
  hashLampCombinedPlan,
  LAMP_COMBINED_MAX_CORRECTIONS,
  type LampCombinedControls,
  type LampCombinedPlan,
} from "../lib/lamp-combined.ts";
import { createMockLampBackgroundCleanupPlan } from "../lib/lamp-background.ts";
import { createMockLampBeautifyPlan } from "../lib/lamp-beautify.ts";
import { createMockLampIrisPlan } from "../lib/lamp-iris.ts";
import {
  buildLampCombinedEvaluationArtifact,
  buildLampCombinedHolisticEvaluationSchema,
  collectLampCombinedCorrections,
  lampCombinedEvalDefinitions,
  LAMP_COMBINED_EVAL_IDS,
  LAMP_COMBINED_VISUAL_EVAL_IDS,
  parseLampCombinedEvaluationArtifact,
  type LampCombinedVisualEvalId,
} from "../lib/lamp-combined-evaluation.ts";
import {
  compileLampCombinedFallbackFinalPrompt,
  compileLampCombinedFinalPrompt,
  initialLampCombinedMegaPrompt,
  isPersistedInitialLampCombinedPrompt,
  LAMP_COMBINED_PROMPT_LINEAGE,
  LAMP_COMBINED_V1_CORRECTIONS_HEADING,
  LAMP_COMBINED_V1_HEADER,
  LAMP_COMBINED_V1_NEVER_DO_HEADING,
  LAMP_COMBINED_V1_OWNERSHIP_HEADING,
  resolveLampCombinedFinalPrompt,
} from "../lib/prompts/lamp-combined.ts";

const RUN_ID = "run-combined-prompt-1";
const CREATED_AT = 1_790_100_000_000;
const APPROVED_AT = CREATED_AT + 1_000;

const ALL_CONTROLS: LampCombinedControls = {
  beautifyLevel: 2,
  cleanlinessLevel: 2,
  eyeContact: true,
};

function approvedPlan(
  controls: LampCombinedControls = ALL_CONTROLS,
  options: { planId?: string; runId?: string } = {}
): LampCombinedPlan {
  const runId = options.runId ?? RUN_ID;
  const draft = buildLampCombinedPlan({
    planId: options.planId ?? "aggregate-plan-prompt-1",
    runId,
    createdAt: CREATED_AT,
    controls,
    backgroundPlan: createMockLampBackgroundCleanupPlan(runId, CREATED_AT),
    ...(controls.beautifyLevel === 0
      ? {}
      : { beautifyPlan: createMockLampBeautifyPlan(runId, CREATED_AT) }),
    ...(controls.eyeContact
      ? { irisPlan: createMockLampIrisPlan(runId, CREATED_AT) }
      : {}),
  });
  return approveLampCombinedPlan(draft, APPROVED_AT);
}

function passingHolisticRaw(
  overrides: Partial<Record<LampCombinedVisualEvalId, Record<string, unknown>>> = {}
): { results: Array<Record<string, unknown>> } {
  return {
    results: LAMP_COMBINED_VISUAL_EVAL_IDS.map((evalId) => ({
      evalId,
      score: 95,
      confidence: 0.95,
      violations: [],
      reasoning: `${evalId} passed.`,
      ...overrides[evalId],
    })),
  };
}

test("the Combined evaluator safely normalizes Gemini's bare visual-row array", async () => {
  const plan = approvedPlan();
  const wrapped = passingHolisticRaw();
  const artifact = await buildLampCombinedEvaluationArtifact({
    raw: wrapped.results,
    plan,
    iteration: 1,
    audioVerified: true,
    syncVerified: true,
    syncReason: "test post-Lipsync proof passed",
  });

  assert.deepEqual(
    artifact.evalResults.map((result) => result.evalId),
    LAMP_COMBINED_EVAL_IDS
  );
});

test("the Combined evaluator safely unwraps rows keyed by known check ids", async () => {
  const plan = approvedPlan();
  const wrapped = passingHolisticRaw();
  const raw = {
    evaluations: wrapped.results.map((row) => ({
      [String(row.evalId)]: Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== "evalId")
      ),
    })),
  };
  const artifact = await buildLampCombinedEvaluationArtifact({
    raw,
    plan,
    iteration: 1,
    audioVerified: true,
    syncVerified: true,
    syncReason: "test post-Lipsync proof passed",
  });

  assert.deepEqual(
    artifact.evalResults.map((result) => result.evalId),
    LAMP_COMBINED_EVAL_IDS
  );
});

test("the Combined evaluator converts the flat provider row into a scoped violation", async () => {
  const plan = approvedPlan();
  const raw = {
    results: LAMP_COMBINED_VISUAL_EVAL_IDS.map((evalId) => ({
      evalId,
      score: evalId === "lighting-target" ? 40 : 95,
      confidence: 0.9,
      issue:
        evalId === "lighting-target"
          ? "The candidate is flatter than the approved lighting target."
          : "",
      severity: evalId === "lighting-target" ? "major" : "none",
      correctionAction:
        evalId === "lighting-target" ? "match-lighting-target" : "none",
      planItemIds: [],
      reasoning: `${evalId} checked.`,
    })),
  };
  const artifact = await buildLampCombinedEvaluationArtifact({
    raw,
    plan,
    iteration: 1,
    audioVerified: true,
    syncVerified: true,
    syncReason: "test post-Lipsync proof passed",
  });
  const lighting = artifact.evalResults.find(
    (result) => result.evalId === "lighting-target"
  )!;

  assert.equal(lighting.violations.length, 1);
  assert.equal(
    lighting.violations[0].correction?.action,
    "match-lighting-target"
  );
});

async function passingArtifact(
  plan: LampCombinedPlan,
  overrides: Partial<Record<LampCombinedVisualEvalId, Record<string, unknown>>> = {}
) {
  return buildLampCombinedEvaluationArtifact({
    raw: passingHolisticRaw(overrides),
    plan,
    iteration: 1,
    audioVerified: true,
    syncVerified: true,
    syncReason: "test post-Lipsync proof passed",
  });
}

test("v1 Initial bytes are deterministic and bind one exact approved aggregate plan plus separate relight intensity", async () => {
  const plan = approvedPlan();
  const [first, second, hash] = await Promise.all([
    initialLampCombinedMegaPrompt(plan, 75),
    initialLampCombinedMegaPrompt(plan, 75),
    hashLampCombinedPlan(plan),
  ]);

  assert.equal(first.rendered, second.rendered);
  assert.equal(first.lineage, LAMP_COMBINED_PROMPT_LINEAGE);
  assert.equal(first.iteration, 1);
  assert.equal(first.aggregatePlanHash, hash);
  assert.match(first.rendered, new RegExp(`Aggregate plan SHA-256: ${hash}`));
  assert.match(first.rendered, /Requested relight strength: 75\/100\./);
  assert.match(first.rendered, /Aggregate plan ID: aggregate-plan-prompt-1/);
  assert.match(first.rendered, /One human approval timestamp: 1790100001000/);
  assert.match(first.rendered, /\[loose-desk-clutter\]/);
  assert.match(first.rendered, /\[expression-warmth\] intensity 2\/3/);
  assert.match(first.rendered, /\[camera-axis-anchor\] Presenter intensity 2\/3/);
  assert.match(first.rendered, new RegExp(LAMP_COMBINED_V1_OWNERSHIP_HEADING));
  assert.match(first.rendered, /OVERLAP PRECEDENCE/);
  assert.equal(
    await isPersistedInitialLampCombinedPrompt(first.rendered, plan, 75),
    true
  );
  assert.equal(
    await isPersistedInitialLampCombinedPrompt(`${first.rendered} `, plan, 75),
    false
  );
  assert.rejects(
    () => initialLampCombinedMegaPrompt(plan, 73),
    /canonical 5-point relight slider step/
  );
});

test("plan hash and relight intensity are independent bindings and Final rejects either mismatch", async () => {
  const cleanPlan = approvedPlan(ALL_CONTROLS, { planId: "same-id" });
  const studioPlan = approvedPlan(
    { ...ALL_CONTROLS, cleanlinessLevel: 3 },
    { planId: "same-id" }
  );
  const initial75 = await initialLampCombinedMegaPrompt(cleanPlan, 75);
  const initial80 = await initialLampCombinedMegaPrompt(cleanPlan, 80);
  const evaluation = await passingArtifact(cleanPlan);

  assert.equal(initial75.aggregatePlanHash, initial80.aggregatePlanHash);
  assert.notEqual(initial75.rendered, initial80.rendered);
  assert.notEqual(
    await hashLampCombinedPlan(cleanPlan),
    await hashLampCombinedPlan(studioPlan)
  );
  await assert.rejects(
    () =>
      compileLampCombinedFinalPrompt(
        initial75.rendered,
        studioPlan,
        75,
        evaluation
      ),
    /exact persisted v1 Initial bytes/
  );
  await assert.rejects(
    () =>
      compileLampCombinedFinalPrompt(
        initial75.rendered,
        cleanPlan,
        80,
        evaluation
      ),
    /exact persisted v1 Initial bytes/
  );
});

test("Take 2 has a deterministic fallback when the bounded critic is unavailable", async () => {
  const plan = approvedPlan();
  const initial = await initialLampCombinedMegaPrompt(plan, 75);
  const fallback = await compileLampCombinedFallbackFinalPrompt(
    initial.rendered,
    plan,
    75
  );
  assert.equal(fallback.iteration, 2);
  assert.deepEqual(fallback.corrections, []);
  assert.match(fallback.rendered, /do not invent a new target/);
  assert.equal(
    (
      await resolveLampCombinedFinalPrompt({
        persistedInitialRendered: initial.rendered,
        plan,
        relightIntensity: 75,
      })
    ).rendered,
    fallback.rendered
  );

  const evaluated = await compileLampCombinedFinalPrompt(
    initial.rendered,
    plan,
    75,
    await passingArtifact(plan)
  );
  assert.equal(
    (
      await resolveLampCombinedFinalPrompt({
        persistedInitialRendered: initial.rendered,
        plan,
        relightIntensity: 75,
        firstEvaluation: await passingArtifact(plan),
        persistedFinalRendered: fallback.rendered,
      })
    ).rendered,
    fallback.rendered
  );
  assert.equal(evaluated.rendered, fallback.rendered);
  await assert.rejects(
    () =>
      resolveLampCombinedFinalPrompt({
        persistedInitialRendered: initial.rendered,
        plan,
        relightIntensity: 75,
        persistedFinalRendered: "unbound prompt",
      }),
    /neither the bounded-critic prompt nor the deterministic fallback/
  );
});

test("disabled Beautify and eye contact compile as explicit preservation hard gates without target recipes", async () => {
  const plan = approvedPlan({
    beautifyLevel: 0,
    cleanlinessLevel: 1,
    eyeContact: false,
  });
  const prompt = await initialLampCombinedMegaPrompt(plan, 25);

  assert.match(prompt.rendered, /BEAUTIFY: DISABLED/);
  assert.match(prompt.rendered, /facial presentation zones are preservation-only hard gates/);
  assert.match(prompt.rendered, /EYE CONTACT: DISABLED/);
  assert.match(prompt.rendered, /Gaze direction, pupils, irises, eyelid pose, blinks, and eye motion are preservation-only hard gates/);
  assert.doesNotMatch(prompt.rendered, /\[expression-warmth\]/);
  assert.doesNotMatch(prompt.rendered, /\[skin-evenness\]/);
  assert.doesNotMatch(prompt.rendered, /\[camera-axis-anchor\]/);
  assert.doesNotMatch(prompt.rendered, /\[note-glance-bridging\]/);
});

test("cleanliness changes thoroughness only and corrections cannot expand the approved target set", async () => {
  const tidyPlan = approvedPlan(
    { beautifyLevel: 0, cleanlinessLevel: 1, eyeContact: false },
    { planId: "tidy-plan" }
  );
  const studioPlan = approvedPlan(
    { beautifyLevel: 0, cleanlinessLevel: 3, eyeContact: false },
    { planId: "studio-plan" }
  );
  const tidy = await initialLampCombinedMegaPrompt(tidyPlan, 50);
  const studio = await initialLampCombinedMegaPrompt(studioPlan, 50);

  assert.match(tidy.rendered, /smallest practical edit footprint/);
  assert.match(studio.rendered, /maximum temporal and inpainting thoroughness/i);
  assert.equal((tidy.rendered.match(/\[loose-desk-clutter\]/g) ?? []).length, 1);
  assert.equal(
    (studio.rendered.match(/\[loose-desk-clutter\]/g) ?? []).length,
    1
  );
  assert.doesNotMatch(
    tidy.rendered,
    /architecture, fixed furniture, and meaningful room elements/
  );
  assert.match(tidy.rendered, /Cleanliness may never add a target/);
});

test("Final patches only the persisted v1 corrections body with stable capped ordering", async () => {
  const plan = approvedPlan();
  const initial = await initialLampCombinedMegaPrompt(plan, 75);
  const violation = (
    aspect: string,
    correctionAction: string,
    severity: "critical" | "major" | "minor",
    planItemIds: string[] = []
  ) => ({
    aspect,
    severity,
    description: `${aspect} failed.`,
    correctionAction,
    planItemIds,
  });
  const evaluation = await passingArtifact(plan, {
    identity: {
      score: 20,
      violations: [violation("identity", "restore-source-identity", "critical")],
    },
    "people-appearance-locks": {
      score: 30,
      violations: [
        violation("appearance", "restore-people-appearance", "major"),
      ],
    },
    "motion-lipsync": {
      score: 25,
      violations: [
        violation("motion", "restore-motion-lipsync", "critical"),
      ],
    },
    "camera-framing": {
      score: 35,
      violations: [
        violation("camera", "restore-camera-framing", "major"),
      ],
    },
    "background-cleanliness": {
      score: 25,
      violations: [
        violation(
          "background-incomplete",
          "complete-approved-background-removal",
          "major",
          ["loose-desk-clutter"]
        ),
        violation("background-leak", "restore-protected-background", "minor"),
      ],
    },
    "lighting-target": {
      score: 20,
      violations: [violation("lighting", "match-lighting-target", "major")],
    },
    "beautify-target": {
      score: 30,
      violations: [
        violation(
          "beautify-low",
          "complete-approved-beautify",
          "major",
          ["expression-warmth"]
        ),
        violation(
          "beautify-high",
          "reduce-approved-beautify",
          "minor",
          ["skin-evenness"]
        ),
      ],
    },
    "eye-contact": {
      score: 30,
      violations: [
        violation(
          "gaze-low",
          "complete-approved-eye-contact",
          "major",
          ["camera-axis-anchor"]
        ),
        violation(
          "gaze-high",
          "reduce-eye-contact-lock",
          "minor",
          ["note-glance-bridging"]
        ),
      ],
    },
    "region-leakage": {
      score: 20,
      violations: [
        violation("region-leak", "contain-region-leakage", "critical"),
      ],
    },
    "temporal-hallucination": {
      score: 20,
      violations: [
        violation("flicker", "stabilize-approved-edits", "major"),
        violation("invented-object", "remove-hallucination", "major"),
      ],
    },
  });

  const [firstFinal, secondFinal] = await Promise.all([
    compileLampCombinedFinalPrompt(initial.rendered, plan, 75, evaluation),
    compileLampCombinedFinalPrompt(initial.rendered, plan, 75, evaluation),
  ]);
  assert.equal(firstFinal.rendered, secondFinal.rendered);
  assert.equal(firstFinal.iteration, 2);
  assert.equal(firstFinal.corrections.length, LAMP_COMBINED_MAX_CORRECTIONS);
  assert.ok(firstFinal.corrections.every((correction) => correction.hardGate));
  assert.deepEqual(
    firstFinal.corrections.map((correction) => correction.concern),
    ["preservation", "preservation", "preservation"]
  );

  const initialBodyStart =
    initial.rendered.indexOf(LAMP_COMBINED_V1_CORRECTIONS_HEADING) +
    LAMP_COMBINED_V1_CORRECTIONS_HEADING.length +
    1;
  const initialBodyEnd = initial.rendered.indexOf(
    `\n\n${LAMP_COMBINED_V1_NEVER_DO_HEADING}`,
    initialBodyStart
  );
  const finalBodyStart =
    firstFinal.rendered.indexOf(LAMP_COMBINED_V1_CORRECTIONS_HEADING) +
    LAMP_COMBINED_V1_CORRECTIONS_HEADING.length +
    1;
  const finalBodyEnd = firstFinal.rendered.indexOf(
    `\n\n${LAMP_COMBINED_V1_NEVER_DO_HEADING}`,
    finalBodyStart
  );
  assert.equal(
    firstFinal.rendered.slice(0, finalBodyStart),
    initial.rendered.slice(0, initialBodyStart)
  );
  assert.equal(
    firstFinal.rendered.slice(finalBodyEnd),
    initial.rendered.slice(initialBodyEnd)
  );
  assert.notEqual(
    firstFinal.rendered.slice(finalBodyStart, finalBodyEnd),
    initial.rendered.slice(initialBodyStart, initialBodyEnd)
  );
  assert.ok(firstFinal.rendered.startsWith(LAMP_COMBINED_V1_HEADER));
  assert.equal(initial.rendered.includes("INITIAL PASS"), true);
});

test("Combined never chains prompts or generated pixels between passes", async () => {
  const plan = approvedPlan();
  const initial = await initialLampCombinedMegaPrompt(plan, 75);
  const evaluation = await passingArtifact(plan);
  const final = await compileLampCombinedFinalPrompt(
    initial.rendered,
    plan,
    75,
    evaluation
  );

  assert.equal(compileLampCombinedFinalPrompt.length, 4);
  assert.match(initial.rendered, /one Combined generation product, not a chain/i);
  assert.match(final.rendered, /start again from the ORIGINAL source/i);
  assert.match(final.rendered, /never use Initial pixels, audio, frames/i);
  assert.doesNotMatch(final.rendered, /previous_interaction_id/);
  assert.doesNotMatch(final.rendered, /generated video URL/);
});

test("holistic schema excludes deterministic audio and turns disabled concerns into preservation hard gates", async () => {
  const plan = approvedPlan({
    beautifyLevel: 0,
    cleanlinessLevel: 1,
    eyeContact: false,
  });
  const definitions = lampCombinedEvalDefinitions(plan);
  const beautify = definitions.find(
    (definition) => definition.id === "beautify-target"
  )!;
  const iris = definitions.find((definition) => definition.id === "eye-contact")!;
  assert.deepEqual(
    {
      contract: beautify.contract,
      concern: beautify.concern,
      hardGate: beautify.hardGate,
      disabledControl: beautify.disabledControl,
      actions: beautify.allowedCorrectionActions,
    },
    {
      contract: "preservation",
      concern: "preservation",
      hardGate: true,
      disabledControl: "beautify",
      actions: ["restore-disabled-beautify"],
    }
  );
  assert.equal(iris.contract, "preservation");
  assert.equal(iris.concern, "preservation");
  assert.equal(iris.hardGate, true);
  assert.deepEqual(iris.allowedCorrectionActions, [
    "restore-disabled-eye-region",
  ]);

  const schema = await buildLampCombinedHolisticEvaluationSchema(plan);
  assert.equal(schema.visualEvalIds.includes("audio-integrity" as never), false);
  assert.equal(
    schema.visualDefinitions.some(
      (definition) => definition.id === "audio-integrity"
    ),
    false
  );
  assert.deepEqual(
    schema.deterministicChecks.map((check) => [
      check.definition.id,
      check.excludedFromVisualModelCall,
    ]),
    [["audio-integrity", true]]
  );

  const artifact = await buildLampCombinedEvaluationArtifact({
    plan,
    iteration: 1,
    audioVerified: true,
    syncVerified: true,
    syncReason: "test post-Lipsync proof passed",
    raw: passingHolisticRaw({
      "beautify-target": {
        score: 20,
        violations: [
          {
            aspect: "unsafe-edit-attempt",
            severity: "critical",
            description: "The judge proposed an edit even though it is off.",
            correctionAction: "complete-approved-beautify",
            planItemIds: ["expression-warmth"],
          },
          {
            aspect: "disabled-beautify-drift",
            severity: "critical",
            description: "Appearance changed while Beautify was off.",
            correctionAction: "restore-disabled-beautify",
            planItemIds: [],
          },
        ],
      },
      "eye-contact": {
        score: 25,
        violations: [
          {
            aspect: "unsafe-gaze-edit-attempt",
            severity: "major",
            description: "The judge proposed an eye-contact edit while off.",
            correctionAction: "complete-approved-eye-contact",
            planItemIds: ["camera-axis-anchor"],
          },
          {
            aspect: "disabled-eye-drift",
            severity: "major",
            description: "Gaze changed while eye contact was off.",
            correctionAction: "restore-disabled-eye-region",
            planItemIds: [],
          },
        ],
      },
    }),
  });
  const corrections = await collectLampCombinedCorrections(artifact, plan);
  assert.deepEqual(
    corrections.map((correction) => ({
      action: correction.action,
      concern: correction.concern,
      hardGate: correction.hardGate,
    })),
    [
      {
        action: "restore-disabled-beautify",
        concern: "preservation",
        hardGate: true,
      },
      {
        action: "restore-disabled-eye-region",
        concern: "preservation",
        hardGate: true,
      },
    ]
  );
  assert.equal(
    corrections.some(
      (correction) =>
        correction.concern === "beautify" || correction.concern === "iris"
    ),
    false
  );

  const initial = await initialLampCombinedMegaPrompt(plan, 25);
  const final = await compileLampCombinedFinalPrompt(
    initial.rendered,
    plan,
    25,
    artifact
  );
  assert.match(final.rendered, /Beautify is disabled: remove every appearance enhancement/);
  assert.match(final.rendered, /Eye contact is disabled: restore the complete source gaze trajectory/);
});

test("evaluation artifacts bind exact plan hashes and discard model attempts to expand target scope", async () => {
  const plan = approvedPlan();
  const raw = passingHolisticRaw({
    "background-cleanliness": {
      score: 30,
      violations: [
        {
          aspect: "unknown-target",
          severity: "critical",
          description: "An unapproved target was proposed.",
          correctionAction: "complete-approved-background-removal",
          planItemIds: ["new-vase"],
        },
        {
          aspect: "approved-target-incomplete",
          severity: "major",
          description: "The approved target remains visible.",
          correctionAction: "complete-approved-background-removal",
          planItemIds: ["loose-desk-clutter"],
        },
      ],
    },
  });
  const artifact = await buildLampCombinedEvaluationArtifact({
    raw,
    plan,
    iteration: 1,
    audioVerified: true,
    syncVerified: true,
    syncReason: "test post-Lipsync proof passed",
  });
  assert.deepEqual(
    artifact.evalResults.find(
      (result) => result.evalId === "background-cleanliness"
    )!.violations.map((violation) => violation.correction?.planItemIds ?? []),
    [[], ["loose-desk-clutter"]]
  );
  assert.equal(
    (await parseLampCombinedEvaluationArtifact(artifact, { plan, iteration: 1 }))
      .planHash,
    await hashLampCombinedPlan(plan)
  );

  const corrections = await collectLampCombinedCorrections(artifact, plan);
  assert.deepEqual(
    corrections
      .filter((correction) => correction.concern === "background")
      .map((correction) => correction.planItemIds),
    [["loose-desk-clutter"]]
  );
  assert.equal(
    corrections.some((correction) => correction.instruction.includes("new-vase")),
    false
  );

  const wrongHash = structuredClone(artifact);
  wrongHash.planHash = "0".repeat(64);
  await assert.rejects(
    () => parseLampCombinedEvaluationArtifact(wrongHash, { plan }),
    /hash does not match/
  );

  const expandedArtifact = structuredClone(artifact);
  const result = expandedArtifact.evalResults.find(
    (candidate) => candidate.evalId === "background-cleanliness"
  )!;
  const safeCorrection = result.violations.find(
    (violation) => violation.correction !== undefined
  )!.correction!;
  safeCorrection.planItemIds = ["new-vase"];
  await assert.rejects(
    () => parseLampCombinedEvaluationArtifact(expandedArtifact, { plan }),
    /exceeds the approved plan scope/
  );

  const initial = await initialLampCombinedMegaPrompt(plan, 75);
  const final = await compileLampCombinedFinalPrompt(
    initial.rendered,
    plan,
    75,
    artifact
  );
  assert.match(final.rendered, /\[loose-desk-clutter\]/);
  assert.doesNotMatch(final.rendered, /new-vase/);
  assert.equal(artifact.evalResults.length, LAMP_COMBINED_EVAL_IDS.length);
});
