import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  applyLampBeautifyIntensityOverride,
  approveLampBeautifyPlan,
  buildLampBeautifyPlan,
  createMockLampBeautifyPlan,
  hashLampBeautifyPlan,
  LAMP_BEAUTIFY_ACTIVE_CATALOG,
  LAMP_BEAUTIFY_PLAN_PROMPT,
  lampBeautifyPlanRequiresGeneration,
  lampBeautifyPlansDifferOnlyByIntensity,
  lampBeautifyPlanUsesActiveCatalog,
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
  compileLampBeautifyFinalPromptCandidates,
  initialLampBeautifyMegaPrompt,
  isPersistedInitialLampBeautifyPrompt,
  LEGACY_V1_BEAUTIFY_BASE_PROMPT,
  LEGACY_V2_BEAUTIFY_BASE_PROMPT,
  LEGACY_V3_BEAUTIFY_BASE_PROMPT,
  LEGACY_V4_BEAUTIFY_BASE_PROMPT,
  LEGACY_V5_BEAUTIFY_BASE_PROMPT,
  LEGACY_V6_BEAUTIFY_BASE_PROMPT,
  renderLampBeautifyCorrection,
  renderLampBeautifyMegaPrompt,
  renderLegacyLampBeautifyCorrectionV1,
  renderLegacyLampBeautifyCorrectionV2,
  renderLampBeautifyPlanBlock,
  renderLegacyLampBeautifyPlanBlockV1,
  renderLegacyLampBeautifyPlanBlockV2,
  renderLegacyLampBeautifyPlanBlockV3,
  renderLegacyLampBeautifyPlanBlockV5,
  renderLegacyLampBeautifyPlanBlockV6,
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

function activeRaw() {
  return {
    sourceScope: {
      cameraMotion: "static",
      visiblePeople: "single-person",
    },
    decision: "enhance",
    subjectSummary:
      "Close-up webcam framing with a flat resting expression and mild forehead shine.",
    enhance: [
      {
        id: "expression-warmth",
        intensity: 2,
        rationale:
          "An expressive lift reads as clearly more engaged and enthusiastic on camera.",
        evidence: "The resting expression sits flatter than the tone of voice.",
      },
      {
        id: "skin-evenness",
        intensity: 2,
        rationale:
          "Healthier, fresher skin reads as better rested without changing the person.",
        evidence: "Forehead shine is visible under the key light throughout.",
      },
    ],
    declined: [
      {
        id: "under-eye-softening",
        reason: "The under-eye area already reads rested.",
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

function activePlan(): LampBeautifyPlan {
  return approveLampBeautifyPlan(
    buildLampBeautifyPlan({
      raw: activeRaw(),
      planId: "plan-beautify-active-1",
      runId: "run-beautify-active-1",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1_000
  );
}

test("generation prompt renders only approved enhancements", () => {
  const plan = activePlan();
  const rendered = initialLampBeautifyMegaPrompt(plan).rendered;

  assert.match(rendered, /LAMP BEAUTIFY TOUCH-UP MEGA PROMPT v1/);
  assert.match(rendered, /\[expression-warmth\] intensity 2 of 3/);
  assert.match(rendered, /\[skin-evenness\] intensity 2 of 3/);
  assert.match(rendered, /Permanent features stay/);
  assert.match(rendered, /every background pixel source-faithful/i);
  assert.match(rendered, /Do not produce plastic, waxy, over-smoothed/);

  // Declined and uncertain categories never reach generation input — naming
  // them would seed the idea (the ring-light lesson from Lamp Background).
  assert.doesNotMatch(rendered, /under-eye-softening/);
  assert.doesNotMatch(rendered, /eye-clarity/);

  // The evaluator, by contrast, must see the full catalog decisions.
  const evaluatorPrompt = renderLampBeautifyHolisticEvaluatorPrompt({
    plan,
    iteration: 1,
  });
  assert.match(evaluatorPrompt, /under-eye-softening/);
  assert.match(evaluatorPrompt, /eye-clarity/);

  assert.equal(isPersistedInitialLampBeautifyPrompt(plan, rendered), true);
  assert.equal(
    isPersistedInitialLampBeautifyPrompt(
      plan,
      rendered.replace("Decision: ENHANCE", "Decision: REDESIGN")
    ),
    false
  );

  // Retired categories have no current-generation form: a legacy plan can
  // never compile into a NEW prompt, only replay through frozen renderers.
  assert.throws(
    () => initialLampBeautifyMegaPrompt(approvedPlan()),
    /no longer offered/
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
  const plan = activePlan();
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
        const raw = activeRaw();
        raw.enhance[0]!.intensity = 3;
        return raw;
      })(),
      planId: "plan-beautify-2",
      runId: "run-beautify-active-1",
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
  // The planner offers only the active catalog; hair is locked out entirely.
  for (const category of LAMP_BEAUTIFY_ACTIVE_CATALOG) {
    assert.match(LAMP_BEAUTIFY_PLAN_PROMPT, new RegExp(category));
  }
  assert.doesNotMatch(LAMP_BEAUTIFY_PLAN_PROMPT, /hair-tidy/);
  assert.doesNotMatch(LAMP_BEAUTIFY_PLAN_PROMPT, /teeth-brightening/);
  assert.match(LAMP_BEAUTIFY_PLAN_PROMPT, /HAIR IS LOCKED/);
  assert.match(LAMP_BEAUTIFY_PLAN_PROMPT, /expression-warmth: the headline trait/);
});

test("persisted plan versions parse forever and keep their binding hash", async () => {
  // The version rides inside the binding hash: parse must carry a persisted
  // version through unchanged, never restamp it with the current one.
  const v1Plan = {
    ...activePlan(),
    version: "lamp-beautify-plan-v1",
  } as LampBeautifyPlan;
  const parsed = parseLampBeautifyPlan(v1Plan);
  assert.equal(parsed.version, "lamp-beautify-plan-v1");
  assert.equal(
    await hashLampBeautifyPlan(v1Plan),
    await hashLampBeautifyPlan(parsed)
  );
  assert.notEqual(
    await hashLampBeautifyPlan(v1Plan),
    await hashLampBeautifyPlan(activePlan())
  );
  assert.equal(activePlan().version, "lamp-beautify-plan-v2");
  assert.throws(
    () =>
      parseLampBeautifyPlan({
        ...activePlan(),
        version: "lamp-beautify-plan-v99",
      }),
    /Unknown Lamp Beautify plan version/
  );
});

test("only active-catalog plans may start a new execution", () => {
  assert.deepEqual(
    [...LAMP_BEAUTIFY_ACTIVE_CATALOG],
    ["expression-warmth", "skin-evenness", "under-eye-softening", "eye-clarity"]
  );
  assert.equal(lampBeautifyPlanUsesActiveCatalog(activePlan()), true);
  // The hair-tidy-era fixture predates the catalog — readable, not runnable.
  assert.equal(lampBeautifyPlanUsesActiveCatalog(approvedPlan()), false);
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
    raw: activeRaw(),
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
      const raw = activeRaw();
      raw.enhance[0]!.id = "teeth-brightening" as never;
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
  assert.match(rendered, /\[expression-warmth\] intensity 3 of 3/);
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
          {
            region: "expression",
            finding: "Already reads warm and engaged throughout.",
          },
          { region: "skin", finding: "Even tone with no shine or blemishes." },
          { region: "under-eyes", finding: "No visible shadows or puffiness." },
          { region: "eyes", finding: "Clear sclera without redness." },
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

test("the warmth rewrite: hair locked, expression-warmth is the headline", () => {
  const warm = approveLampBeautifyPlan(
    buildLampBeautifyPlan({
      raw: (() => {
        const raw = enhanceRaw();
        raw.enhance = [
          {
            id: "expression-warmth",
            intensity: 2,
            rationale:
              "A gentle warmth lift reads as more engaged and enthusiastic.",
            evidence: "The resting expression sits flatter than the tone of voice.",
          },
          raw.enhance[0]!,
        ];
        return raw;
      })(),
      planId: "plan-warmth-1",
      runId: "run-warmth-1",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1_000
  );
  const rendered = initialLampBeautifyMegaPrompt(warm).rendered;

  assert.match(rendered, /\[expression-warmth\] intensity 2 of 3/);
  assert.match(rendered, /dramatically more expressive, enthusiastic, and healthy/);
  assert.match(rendered, /strong and unmistakable on its own/);
  assert.match(rendered, /Do not touch the hair in any way/);
  assert.match(rendered, /Hair is fully locked/);
  assert.match(rendered, /pores refined/);
  assert.match(rendered, /Do not break lip-sync/);
  assert.match(rendered, /never a held grin through speech/i);
  // Elevation is constant with amplified response — the anti-snap-back
  // contract survives the expressiveness rewrite.
  assert.match(rendered, /constant ELEVATION/);
  assert.match(rendered, /amplified response to the source's own expressive beats/);
  assert.match(rendered, /One constant elevation for the entire duration/);
  assert.match(rendered, /no smile bursts, no mood swings, no snap-backs/);
  assert.match(rendered, /smile bursts, expression snap-backs, warmth pulsing, mood oscillation/);

  // A post-freeze plan has no first-generation form — cleanly rejected.
  assert.equal(
    isPersistedInitialLampBeautifyPrompt(
      warm,
      rendered.replace("Decision: ENHANCE", "Decision: REDESIGN")
    ),
    false
  );
});

test("hair-tidy era runs stay valid through the frozen first generation", () => {
  // approvedPlan() is the pre-rewrite fixture: skin-evenness + hair-tidy.
  // Retired categories render ONLY through their frozen generation — the
  // current renderer refuses them, so the frame takes the legacy block.
  const plan = approvedPlan();
  const legacyV1 = renderLampBeautifyMegaPrompt(
    {
      version: 1,
      base: LEGACY_V1_BEAUTIFY_BASE_PROMPT,
      plan,
      corrections: [],
    },
    renderLegacyLampBeautifyPlanBlockV1
  );

  // No fresh compile exists for this plan anymore — yet the frozen bytes
  // still prove the binding.
  assert.throws(() => initialLampBeautifyMegaPrompt(plan), /no longer offered/);
  assert.equal(isPersistedInitialLampBeautifyPrompt(plan, legacyV1), true);

  // The v2 compiler — replayed on every read of an old run — accepts them.
  const artifact = buildLampBeautifyEvaluationArtifact({
    raw: allPassRaw(),
    plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0,
  });
  const final = compileLampBeautifyFinalPrompt(legacyV1, plan, artifact);
  assert.equal(final.version, 2);
  assert.match(final.rendered, /LAMP BEAUTIFY TOUCH-UP MEGA PROMPT v2/);
});

test("ladder-v3 and clean-generation era runs stay valid through their frozen forms", () => {
  const plan = approveLampBeautifyPlan(
    buildLampBeautifyPlan({
      raw: (() => {
        const raw = enhanceRaw();
        raw.enhance = [
          {
            id: "expression-warmth",
            intensity: 3,
            rationale:
              "A gentle warmth lift reads as more engaged and enthusiastic.",
            evidence: "The resting expression sits flatter than the tone of voice.",
          },
          raw.enhance[0]!,
        ];
        return raw;
      })(),
      planId: "plan-ladder-era-1",
      runId: "run-ladder-era-1",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1_000
  );
  const artifact = buildLampBeautifyEvaluationArtifact({
    raw: allPassRaw(),
    plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0,
  });

  // Both eras share the V3 plan block — the clean-generation commit changed
  // only the base — so each era is that base plus the V3 block.
  const eraForms: string[] = [];
  for (const base of [
    LEGACY_V3_BEAUTIFY_BASE_PROMPT,
    LEGACY_V4_BEAUTIFY_BASE_PROMPT,
  ]) {
    const persisted = renderLampBeautifyMegaPrompt({
      version: 1,
      base,
      plan,
      corrections: [],
    }).replace(
      renderLampBeautifyPlanBlock(plan),
      renderLegacyLampBeautifyPlanBlockV3(plan)
    );
    assert.notEqual(persisted, initialLampBeautifyMegaPrompt(plan).rendered);
    assert.equal(isPersistedInitialLampBeautifyPrompt(plan, persisted), true);

    const final = compileLampBeautifyFinalPrompt(persisted, plan, artifact);
    assert.equal(final.version, 2);
    assert.match(final.rendered, /LAMP BEAUTIFY TOUCH-UP MEGA PROMPT v2/);
    eraForms.push(persisted);
  }
  assert.notEqual(eraForms[0], eraForms[1]);
});

test("frozen generations are byte-pinned — an in-place edit fails here first", () => {
  const pin = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");

  // Bases, hashed as canonical JSON. These hashes were taken from the exact
  // git-history bytes each generation shipped with (2b5daec, f93e52c,
  // d6ba601, d6ab069). If one of these assertions fails, a frozen constant
  // was edited in place: revert the constant — never update the pin.
  assert.equal(
    pin(LEGACY_V1_BEAUTIFY_BASE_PROMPT),
    "e7f26bcd2c4955293ac51e81ce40a17dd38946e0400cc2810f3d8c3cbf4f3083"
  );
  assert.equal(
    pin(LEGACY_V2_BEAUTIFY_BASE_PROMPT),
    "e0a157dd93a561c2765ca7c93bdf4d434b4101ec6fc17144391c6b05f76afd8f"
  );
  assert.equal(
    pin(LEGACY_V3_BEAUTIFY_BASE_PROMPT),
    "a300e7244c99f943fa0e74be508d719dcad154e7a7d7daf105671dcb145cedbf"
  );
  assert.equal(
    pin(LEGACY_V4_BEAUTIFY_BASE_PROMPT),
    "746c1d89fedbf1dcc9f3041b71fd6211a15d89e7762630331f1f5041420fa2b8"
  );
  assert.equal(
    pin(LEGACY_V5_BEAUTIFY_BASE_PROMPT),
    "44cd85ade6dbb334a3b12126fca9ec55c845759d051c3e1cc04babee77d02bc4"
  );
  assert.equal(
    pin(LEGACY_V6_BEAUTIFY_BASE_PROMPT),
    "b3604976a58f06801ce7f0a7f9453ace07cbd913be2c85c95badf7a9060be0e9"
  );

  // The sixth generation carries only the active catalog, so its block pin
  // uses an active-only fixture.
  const pinPlanV6 = approveLampBeautifyPlan(
    buildLampBeautifyPlan({
      raw: {
        sourceScope: { cameraMotion: "static", visiblePeople: "single-person" },
        decision: "enhance",
        subjectSummary: "Byte-pin fixture subject.",
        enhance: [
          { id: "expression-warmth", intensity: 1, rationale: "Deterministic byte pin fixture rationale.", evidence: "Deterministic byte pin fixture evidence." },
          { id: "skin-evenness", intensity: 2, rationale: "Deterministic byte pin fixture rationale.", evidence: "Deterministic byte pin fixture evidence." },
          { id: "under-eye-softening", intensity: 3, rationale: "Deterministic byte pin fixture rationale.", evidence: "Deterministic byte pin fixture evidence." },
          { id: "eye-clarity", intensity: 2, rationale: "Deterministic byte pin fixture rationale.", evidence: "Deterministic byte pin fixture evidence." },
        ],
        declined: [],
        uncertain: [],
      },
      planId: "plan-pin-v6",
      runId: "run-pin-v6",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1_000
  );
  assert.equal(
    pin(renderLegacyLampBeautifyPlanBlockV6(pinPlanV6)),
    "e6647e44ecd6770f3d754e2b3747b7ce0e8189db46d9091c76b134cdb6dc7cb5"
  );
  const v2Vocabulary = (
    [
      { action: "restore-identity", planItemIds: [] },
      { action: "restore-performance-lipsync", planItemIds: [] },
      { action: "complete-approved-enhancement", planItemIds: ["skin-evenness"] },
      { action: "reduce-enhancement-intensity", planItemIds: ["skin-evenness"] },
      { action: "remove-unapproved-beautification", planItemIds: [] },
      { action: "repair-skin-texture", planItemIds: [] },
      { action: "restore-untouched-surroundings", planItemIds: [] },
    ] as const
  ).map((correction) =>
    renderLegacyLampBeautifyCorrectionV2(pinPlanV6, {
      id: `pin-${correction.action}`,
      sourceEvalId: "enhancement-adherence",
      aspect: "byte-pin-fixture",
      action: correction.action,
      severity: "critical",
      planItemIds: [...correction.planItemIds],
    })
  );
  assert.equal(
    pin(v2Vocabulary),
    "ac4ee857d4331ae2e01eb86c0eb54c77e6d225f469e1408460735d23458684ca"
  );

  // Block renderers, pinned through a fixed fixture that exercises every
  // active category and all three intensity lines. The fixture is literal on
  // purpose: its bytes are part of the pin.
  const pinPlan = approveLampBeautifyPlan(
    buildLampBeautifyPlan({
      raw: {
        sourceScope: { cameraMotion: "static", visiblePeople: "single-person" },
        decision: "enhance",
        subjectSummary: "Byte-pin fixture subject.",
        enhance: [
          { id: "expression-warmth", intensity: 1, rationale: "Deterministic byte pin fixture rationale.", evidence: "Deterministic byte pin fixture evidence." },
          { id: "skin-evenness", intensity: 2, rationale: "Deterministic byte pin fixture rationale.", evidence: "Deterministic byte pin fixture evidence." },
          { id: "under-eye-softening", intensity: 3, rationale: "Deterministic byte pin fixture rationale.", evidence: "Deterministic byte pin fixture evidence." },
          { id: "teeth-brightening", intensity: 1, rationale: "Deterministic byte pin fixture rationale.", evidence: "Deterministic byte pin fixture evidence." },
          { id: "eye-clarity", intensity: 2, rationale: "Deterministic byte pin fixture rationale.", evidence: "Deterministic byte pin fixture evidence." },
        ],
        declined: [],
        uncertain: [],
      },
      planId: "plan-pin-active",
      runId: "run-pin-active",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1_000
  );
  assert.equal(
    pin(renderLegacyLampBeautifyPlanBlockV5(pinPlan)),
    "c3afababb8b249bcc2825e57bf9533b9593514a926862513e5942f4a0213ed38"
  );
  assert.equal(
    pin(renderLegacyLampBeautifyPlanBlockV3(pinPlan)),
    "2a0dc756f6e0b35182654cd4d7f626c6417c3b5d15b20031b78f85c530b7fd68"
  );
  assert.equal(
    pin(renderLegacyLampBeautifyPlanBlockV2(pinPlan)),
    "ad9ff66bc359bde6679c92de305e4fa69f9678a3f48e2709857592f966822720"
  );

  const pinPlanV1Era = approveLampBeautifyPlan(
    buildLampBeautifyPlan({
      raw: {
        sourceScope: { cameraMotion: "static", visiblePeople: "single-person" },
        decision: "enhance",
        subjectSummary: "Byte-pin fixture subject.",
        enhance: [
          { id: "skin-evenness", intensity: 2, rationale: "Deterministic byte pin fixture rationale.", evidence: "Deterministic byte pin fixture evidence." },
          { id: "hair-tidy", intensity: 1, rationale: "Deterministic byte pin fixture rationale.", evidence: "Deterministic byte pin fixture evidence." },
        ],
        declined: [],
        uncertain: [],
      },
      planId: "plan-pin-v1",
      runId: "run-pin-v1",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1_000
  );
  assert.equal(
    pin(renderLegacyLampBeautifyPlanBlockV1(pinPlanV1Era)),
    "251bb951086286163eb92d50375c6c08427bf1adc73fb1ec40af506608e40ffa"
  );

  // The frozen correction vocabulary — the final pass of every run billed
  // before the steady-state rewrite embedded these exact sentences.
  const vocabulary = (
    [
      { action: "restore-identity", planItemIds: [] },
      { action: "restore-performance-lipsync", planItemIds: [] },
      { action: "complete-approved-enhancement", planItemIds: ["skin-evenness"] },
      { action: "reduce-enhancement-intensity", planItemIds: ["skin-evenness"] },
      { action: "remove-unapproved-beautification", planItemIds: [] },
      { action: "repair-skin-texture", planItemIds: [] },
      { action: "restore-untouched-surroundings", planItemIds: [] },
    ] as const
  ).map((correction) =>
    renderLegacyLampBeautifyCorrectionV1(pinPlan, {
      id: `pin-${correction.action}`,
      sourceEvalId: "enhancement-adherence",
      aspect: "byte-pin-fixture",
      action: correction.action,
      severity: "critical",
      planItemIds: [...correction.planItemIds],
    })
  );
  assert.equal(
    pin(vocabulary),
    "6877fe5637380107b9d27def13fc5e05fe1873c6cfe1b67551b4628a8ff9ca2c"
  );
});

test("legacy-billed final prompts stay valid through the frozen correction vocabulary", () => {
  const plan = activePlan();
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
  const persisted = initialLampBeautifyMegaPrompt(plan).rendered;

  const candidates = compileLampBeautifyFinalPromptCandidates(
    persisted,
    plan,
    flawed
  );
  assert.equal(candidates.length, 3);
  // Index 0 is the only form new executions may bill with.
  assert.equal(
    candidates[0]!.rendered,
    compileLampBeautifyFinalPrompt(persisted, plan, flawed).rendered
  );
  assert.match(candidates[1]!.rendered, /Fully and UNIFORMLY apply/);
  assert.match(
    candidates[2]!.rendered,
    /Fully apply these approved enhancements at their approved intensity wherever the region is visible:/
  );
  assert.notEqual(candidates[1]!.rendered, candidates[2]!.rendered);
  // The vocabularies differ only inside the corrections body: everything
  // through the locks section is byte-identical.
  const boundary = candidates[0]!.rendered.indexOf(
    "[ACTIVE CORRECTIONS FROM EVALUATION]"
  );
  assert.ok(boundary > 0);
  assert.equal(
    candidates[0]!.rendered.slice(0, boundary),
    candidates[1]!.rendered.slice(0, boundary)
  );
  assert.equal(
    candidates[0]!.rendered.slice(0, boundary),
    candidates[2]!.rendered.slice(0, boundary)
  );
});

test("the clean-generation layer anchors source noise and names the artifacts", () => {
  const plan = activePlan();
  const rendered = initialLampBeautifyMegaPrompt(plan).rendered;

  // Positive fidelity anchors — preserving the source's own imperfection is
  // the realism lever; its absence is what reads as artificial.
  assert.match(rendered, /grain structure, sensor-noise character, and compression fingerprint/);
  assert.match(rendered, /sits under the source noise floor/);
  assert.match(rendered, /decided once, then tracked, never re-invented frame to frame/);

  // The artifact taxonomy rides in noun form (the Veo-guidance shape).
  assert.match(rendered, /Generation artifacts to exclude entirely: temporal flicker/);
  assert.match(rendered, /boiling or crawling texture/);
  assert.match(rendered, /edge halos, over-sharpening ringing, banding/);
  assert.match(rendered, /denoised or waxy patches, AI smoothness/);
});
