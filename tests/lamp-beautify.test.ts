import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLampBeautifyIntensityOverride,
  approveLampBeautifyPlan,
  buildLampBeautifyPlan,
  createMockLampBeautifyPlan,
  hashLampBeautifyPlan,
  LAMP_BEAUTIFY_CATALOG,
  LAMP_BEAUTIFY_PLAN_PROMPT,
  lampBeautifyPlanRequiresGeneration,
  lampBeautifyPlansDifferOnlyByIntensity,
  parseLampBeautifyPlan,
  type LampBeautifyPlan,
} from "../lib/lamp-beautify.ts";
import {
  buildLampBeautifyEvaluationArtifact,
  collectLampBeautifyCorrections,
  LAMP_BEAUTIFY_EVAL_DEFS,
  LAMP_BEAUTIFY_VISUAL_EVAL_DEFS,
  renderLampBeautifyHolisticEvaluatorPrompt,
} from "../lib/lamp-beautify-evaluation.ts";
import {
  compileLampBeautifyFinalPrompt,
  initialLampBeautifyMegaPrompt,
  isPersistedInitialLampBeautifyPrompt,
  renderLampBeautifyCorrection,
} from "../lib/prompts/lamp-beautify.ts";
import { BEAUTIFY_WORKFLOW } from "../lib/beautify-workflow-def.ts";
import {
  LAMP_BEAUTIFY_EXECUTION_PREFIX,
  parseWorkflowMode,
  runWorkflowMode,
  workflowModeFromExecutionId,
  workflowModeLabel,
} from "../lib/workflow-mode.ts";
import type { Run } from "../lib/types.ts";

const CREATED_AT = 1_760_000_000_000;

function enhanceRaw() {
  return {
    sourceScope: {
      cameraMotion: "static",
      visiblePeople: "single-person",
    },
    decision: "enhance",
    subjectSummary:
      "Close-up webcam framing with mild forehead shine, slight under-eye shadows, and a few stray hairs.",
    enhance: [
      {
        id: "skin-evenness",
        intensity: 2,
        rationale:
          "Reducing shine and temporary blemishes reads as better rested on camera.",
        evidence: "Forehead shine is visible under the key light throughout.",
      },
      {
        id: "hair-tidy",
        intensity: 1,
        rationale: "A few flyaways catch the light and distract at the crown.",
        evidence: "Stray strands are visible against the bright wall.",
      },
    ],
    declined: [
      {
        id: "teeth-brightening",
        reason: "Teeth are barely visible while speaking.",
      },
    ],
    uncertain: [
      {
        id: "eye-clarity",
        uncertainty:
          "Slight redness may be the room's warm light rather than the eyes.",
        safeDefault: "decline",
      },
    ],
  };
}

function approvedPlan(): LampBeautifyPlan {
  return approveLampBeautifyPlan(
    buildLampBeautifyPlan({
      raw: enhanceRaw(),
      planId: "plan-beautify-1",
      runId: "run-beautify-1",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1_000
  );
}

test("the beautify plan enforces the closed catalog and intensity bounds", () => {
  const plan = approvedPlan();
  assert.equal(plan.decision, "enhance");
  assert.equal(plan.enhance.length, 2);
  assert.equal(plan.enhance[0]?.intensity, 2);

  const badCategory = enhanceRaw();
  badCategory.enhance[0]!.id = "jawline-sculpting" as never;
  assert.throws(
    () =>
      buildLampBeautifyPlan({
        raw: badCategory,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /closed catalog/
  );

  const badIntensity = enhanceRaw();
  badIntensity.enhance[0]!.intensity = 5 as never;
  assert.throws(
    () =>
      buildLampBeautifyPlan({
        raw: badIntensity,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /intensity must be 1, 2, or 3/
  );

  const duplicated = enhanceRaw();
  duplicated.declined.push({
    id: "skin-evenness",
    reason: "Also declined, which contradicts the enhance entry.",
  });
  assert.throws(
    () =>
      buildLampBeautifyPlan({
        raw: duplicated,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /more than one classification/
  );

  const empty = enhanceRaw();
  empty.enhance = [];
  assert.throws(
    () =>
      buildLampBeautifyPlan({
        raw: empty,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /at least one approved enhancement/
  );
});

test("scope, approval, and hashing follow the house contract", async () => {
  const moving = enhanceRaw();
  moving.sourceScope.cameraMotion = "moving" as never;
  assert.throws(
    () =>
      buildLampBeautifyPlan({
        raw: moving,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /static-camera source videos with at least one clearly visible person/
  );

  const multi = enhanceRaw();
  multi.sourceScope.visiblePeople = "multiple-people" as never;
  const multiPlan = buildLampBeautifyPlan({
    raw: multi,
    planId: "p-multi",
    runId: "r-multi",
    createdAt: CREATED_AT,
  });
  assert.equal(multiPlan.sourceScope.visiblePeople, "multiple-people");

  const draft = buildLampBeautifyPlan({
    raw: enhanceRaw(),
    planId: "plan-beautify-1",
    runId: "run-beautify-1",
    createdAt: CREATED_AT,
  });
  assert.equal(draft.approval.status, "draft");
  assert.throws(
    () => initialLampBeautifyMegaPrompt(draft),
    /explicit human approval/
  );

  const approved = approveLampBeautifyPlan(draft, CREATED_AT + 5);
  const draftHash = await hashLampBeautifyPlan(draft);
  const approvedHash = await hashLampBeautifyPlan(approved);
  assert.equal(draftHash, approvedHash);
  assert.match(approvedHash, /^[a-f0-9]{64}$/);

  const mock = createMockLampBeautifyPlan("run-mock", CREATED_AT);
  assert.equal(mock.approval.status, "draft");
  assert.equal(lampBeautifyPlanRequiresGeneration(mock), true);
  assert.equal(parseLampBeautifyPlan(mock).id, mock.id);
});

test("generation prompt renders only approved enhancements", () => {
  const plan = approvedPlan();
  const rendered = initialLampBeautifyMegaPrompt(plan).rendered;

  assert.match(rendered, /LAMP BEAUTIFY TOUCH-UP MEGA PROMPT v1/);
  assert.match(rendered, /\[skin-evenness\] intensity 2 of 3/);
  assert.match(rendered, /\[hair-tidy\] intensity 1 of 3/);
  assert.match(rendered, /Permanent features stay/);
  assert.match(rendered, /every background pixel source-faithful/i);
  assert.match(rendered, /Do not produce plastic, waxy, over-smoothed/);

  // Declined and uncertain categories never reach generation input — naming
  // them would seed the idea (the ring-light lesson from Lamp Background).
  assert.doesNotMatch(rendered, /teeth-brightening/);
  assert.doesNotMatch(rendered, /teeth/i);
  assert.doesNotMatch(rendered, /eye-clarity/);

  // The evaluator, by contrast, must see the full catalog decisions.
  const evaluatorPrompt = renderLampBeautifyHolisticEvaluatorPrompt({
    plan,
    iteration: 1,
  });
  assert.match(evaluatorPrompt, /teeth-brightening/);
  assert.match(evaluatorPrompt, /eye-clarity/);

  assert.equal(isPersistedInitialLampBeautifyPrompt(plan, rendered), true);
  assert.equal(
    isPersistedInitialLampBeautifyPrompt(
      plan,
      rendered.replace("Decision: ENHANCE", "Decision: REDESIGN")
    ),
    false
  );
});

function allPassRaw(): { results: Array<Record<string, unknown>> } {
  return {
    results: LAMP_BEAUTIFY_VISUAL_EVAL_DEFS.map(
      (definition): Record<string, unknown> => ({
        evalId: definition.id,
        score: 92,
        confidence: 0.9,
        violations: [] as unknown[],
        reasoning: "No violations observed for this check.",
      })
    ),
  };
}

test("evaluation artifact enforces completeness and safe corrections", () => {
  const plan = approvedPlan();
  const artifact = buildLampBeautifyEvaluationArtifact({
    raw: allPassRaw(),
    plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0.01,
  });
  assert.equal(artifact.evalResults.length, LAMP_BEAUTIFY_EVAL_DEFS.length);
  assert.equal(
    artifact.evalResults.at(-1)?.evalId,
    "audio-integrity"
  );

  const incomplete = allPassRaw();
  incomplete.results.pop();
  assert.throws(
    () =>
      buildLampBeautifyEvaluationArtifact({
        raw: incomplete,
        plan,
        iteration: 1,
        audioVerified: true,
        costUsd: 0,
      }),
    /omitted required checks/
  );

  const withViolations = allPassRaw();
  withViolations.results = withViolations.results.map((result) =>
    result.evalId === "enhancement-adherence"
      ? {
          ...result,
          score: 40,
          violations: [
            {
              aspect: "shine-still-present",
              severity: "critical",
              description: "Approved skin-evenness was left unapplied.",
              frameTimestampSec: 2.5,
              correctionAction: "complete-approved-enhancement",
              planItemIds: ["skin-evenness"],
            },
            {
              aspect: "invented-makeup",
              severity: "major",
              description: "Unapproved lip color was introduced.",
              frameTimestampSec: 4,
              correctionAction: "remove-unapproved-beautification",
              planItemIds: [],
            },
            {
              aspect: "smuggled-category",
              severity: "major",
              description:
                "References a declined category and must not compile.",
              frameTimestampSec: 5,
              correctionAction: "complete-approved-enhancement",
              planItemIds: ["teeth-brightening"],
            },
          ],
          reasoning: "Adherence failures observed.",
        }
      : result
  );
  const flawed = buildLampBeautifyEvaluationArtifact({
    raw: withViolations,
    plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0.01,
  });
  const corrections = collectLampBeautifyCorrections(flawed, plan);
  assert.equal(corrections.length, 2);
  assert.equal(corrections[0]?.action, "complete-approved-enhancement");
  assert.deepEqual(corrections[0]?.planItemIds, ["skin-evenness"]);
  // The declined-category reference was dropped as unsafe.
  assert.equal(
    corrections.some((correction) =>
      correction.planItemIds.includes("teeth-brightening")
    ),
    false
  );

  const rendered = renderLampBeautifyCorrection(plan, corrections[0]!);
  assert.match(rendered, /\[skin-evenness\] at intensity 2/);
});

test("the final compiler preserves v1 bytes outside the header and corrections", () => {
  const plan = approvedPlan();
  const initial = initialLampBeautifyMegaPrompt(plan);
  const artifact = buildLampBeautifyEvaluationArtifact({
    raw: allPassRaw(),
    plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0,
  });
  const final = compileLampBeautifyFinalPrompt(
    initial.rendered,
    plan,
    artifact
  );
  assert.equal(final.version, 2);
  assert.equal(final.corrections.length, 0);
  const restored = final.rendered.replace(
    "=== LAMP BEAUTIFY TOUCH-UP MEGA PROMPT v2 ===",
    "=== LAMP BEAUTIFY TOUCH-UP MEGA PROMPT v1 ==="
  );
  assert.equal(restored, initial.rendered);

  // A swapped plan cannot ride an existing persisted prompt.
  const otherPlan = approveLampBeautifyPlan(
    buildLampBeautifyPlan({
      raw: (() => {
        const raw = enhanceRaw();
        raw.enhance[0]!.intensity = 3;
        return raw;
      })(),
      planId: "plan-beautify-2",
      runId: "run-beautify-1",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 2_000
  );
  assert.throws(
    () =>
      compileLampBeautifyFinalPrompt(
        initial.rendered,
        otherPlan,
        buildLampBeautifyEvaluationArtifact({
          raw: allPassRaw(),
          plan: otherPlan,
          iteration: 1,
          audioVerified: true,
          costUsd: 0,
        })
      ),
    /no longer matches the plan bound into the persisted v1 prompt/
  );
});

test("beautify eval weights, gates, and prompt wiring hold", () => {
  const total = LAMP_BEAUTIFY_EVAL_DEFS.reduce(
    (sum, definition) => sum + definition.weight,
    0
  );
  assert.equal(Math.round(total * 100) / 100, 1);
  assert.equal(
    LAMP_BEAUTIFY_EVAL_DEFS.find((d) => d.id === "audio-integrity")?.method,
    "deterministic"
  );
  assert.equal(LAMP_BEAUTIFY_VISUAL_EVAL_DEFS.length, 10);
  assert.match(LAMP_BEAUTIFY_PLAN_PROMPT, /NO-OP IS EXCEPTIONAL/);
  assert.match(
    LAMP_BEAUTIFY_PLAN_PROMPT,
    /single-person and multiple-people scenes are both supported/
  );
  for (const category of LAMP_BEAUTIFY_CATALOG) {
    assert.match(LAMP_BEAUTIFY_PLAN_PROMPT, new RegExp(category));
  }
});

test("workflow mode plumbing recognizes beautify", () => {
  assert.equal(parseWorkflowMode("beautify"), "beautify");
  assert.equal(workflowModeLabel("beautify"), "Lamp Beautify");
  assert.equal(
    workflowModeFromExecutionId(`${LAMP_BEAUTIFY_EXECUTION_PREFIX}run-x`),
    "beautify"
  );
  const run = {
    workflowMode: undefined,
    workflowId: BEAUTIFY_WORKFLOW.id,
  } as Pick<Run, "workflowMode" | "workflowId">;
  assert.equal(runWorkflowMode(run), "beautify");
  assert.equal(BEAUTIFY_WORKFLOW.id, "lamp-beautify-v1");
  assert.equal(BEAUTIFY_WORKFLOW.nodes.length, 5);
});

test("the intensity slider overrides levels and nothing else", async () => {
  const draft = buildLampBeautifyPlan({
    raw: enhanceRaw(),
    planId: "plan-slider-1",
    runId: "run-slider-1",
    createdAt: CREATED_AT,
  });

  const polished = applyLampBeautifyIntensityOverride(draft, 3);
  assert.deepEqual(
    polished.enhance.map((item) => item.intensity),
    draft.enhance.map(() => 3)
  );
  // Only intensity moved: ids, rationales, declined, and uncertain are intact.
  assert.deepEqual(
    polished.enhance.map((item) => item.id),
    draft.enhance.map((item) => item.id)
  );
  assert.deepEqual(polished.declined, draft.declined);
  assert.deepEqual(polished.uncertain, draft.uncertain);
  assert.equal(polished.approval.status, "draft");

  // The dial changes the binding hash — executions bind the plan as approved.
  assert.notEqual(
    await hashLampBeautifyPlan(polished),
    await hashLampBeautifyPlan(draft)
  );

  // The binding predicate accepts exactly the slider's degree of freedom.
  assert.equal(lampBeautifyPlansDifferOnlyByIntensity(draft, polished), true);
  assert.equal(lampBeautifyPlansDifferOnlyByIntensity(draft, draft), true);
  const tampered = buildLampBeautifyPlan({
    raw: (() => {
      const raw = enhanceRaw();
      raw.enhance[0]!.id = "teeth-brightening" as never;
      raw.declined = raw.declined.filter(
        (item) => item.id !== "teeth-brightening"
      );
      return raw;
    })(),
    planId: "plan-slider-1",
    runId: "run-slider-1",
    createdAt: CREATED_AT,
  });
  assert.equal(lampBeautifyPlansDifferOnlyByIntensity(draft, tampered), false);

  // The generation prompt renders the dialed level.
  const approvedPolished = approveLampBeautifyPlan(polished, CREATED_AT + 10);
  const rendered = initialLampBeautifyMegaPrompt(approvedPolished).rendered;
  assert.match(rendered, /\[skin-evenness\] intensity 3 of 3/);
  assert.doesNotMatch(rendered, /intensity 2 of 3/);

  // No-op plans have nothing to dial.
  const noOp = buildLampBeautifyPlan({
    raw: {
      sourceScope: {
        cameraMotion: "static",
        visiblePeople: "single-person",
      },
      decision: "exceptional-no-op",
      subjectSummary:
        "Static single-person webcam framing that is already fully camera-ready.",
      enhance: [],
      declined: [
        { id: "skin-evenness", reason: "Skin is already even on camera." },
      ],
      uncertain: [],
      noOpJustification: {
        reasonCode: "already-camera-ready",
        confidence: 0.97,
        summary:
          "Every catalog region is already presentation ready and no enhancement at any intensity would make the subject read as better prepared for camera.",
        regionEvidence: [
          { region: "skin", finding: "Even tone with no shine or blemishes." },
          { region: "under-eyes", finding: "No visible shadows or puffiness." },
          { region: "teeth", finding: "Natural tone during brief visibility." },
          { region: "eyes", finding: "Clear sclera without redness." },
          { region: "hair", finding: "No flyaways around the silhouette." },
        ],
        whyEnhancementWouldNotImprovePresentation:
          "The subject already reads as fully camera ready in every catalog region today.",
      },
    },
    planId: "plan-slider-noop",
    runId: "run-slider-noop",
    createdAt: CREATED_AT,
  });
  assert.throws(
    () => applyLampBeautifyIntensityOverride(noOp, 2),
    /applies only to an enhance decision/
  );
});
