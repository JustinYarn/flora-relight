import assert from "node:assert/strict";
import test from "node:test";

import {
  approveLampBackgroundCleanupPlan,
  buildLampBackgroundCleanupPlan,
  hashLampBackgroundCleanupPlan,
  LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT,
  type LampBackgroundCleanupPlan,
} from "../lib/lamp-background.ts";
import {
  buildLampBackgroundEvaluationArtifact,
  LAMP_BACKGROUND_VISUAL_EVAL_DEFS,
  type LampBackgroundCorrection,
} from "../lib/lamp-background-evaluation.ts";
import {
  compileLampBackgroundFinalPrompt,
  initialLampBackgroundMegaPrompt,
  isPersistedInitialLampBackgroundPrompt,
  LEGACY_V1_BASE_PROMPT,
  renderLampBackgroundCorrection,
  renderLampBackgroundMegaPrompt,
  renderLampBackgroundPlanBlock,
  renderLegacyLampBackgroundPlanBlockV1,
} from "../lib/prompts/lamp-background.ts";

const CREATED_AT = 1_750_000_000_000;

/**
 * Regression fixture for the 2026-07-16 ring-light incident: the planner
 * mislabeled a rectangular panel light as a "ring light" in a PRESERVE item,
 * and the generator rendered a literal ring light to match the words. The
 * generation prompt must therefore never assert what a protected region
 * contains — only where it is.
 */
function incidentPlan(): LampBackgroundCleanupPlan {
  return approveLampBackgroundCleanupPlan(
    buildLampBackgroundCleanupPlan({
      planId: "plan-neutrality-1",
      runId: "run-neutrality-1",
      createdAt: CREATED_AT,
      raw: {
        sourceScope: {
          cameraMotion: "static",
          visiblePeople: "single-person",
        },
        decision: "cleanup",
        sceneSummary:
          "Static single-person webcam frame with a cluttered desk camera-left and decorated shelving camera-right.",
        remove: [
          {
            id: "desk-snack-clutter",
            label: "snacks and loose packaging",
            location: "camera-left desk surface",
            rationale:
              "Temporary snack clutter distracts from the speaker and is safe to clear.",
            temporalVisibility: "persistent",
            subjectInteraction: "none-observed",
          },
        ],
        preserve: [
          {
            id: "monitor-and-ring-light",
            label: "monitor and ring light",
            location: "camera-left desk, behind the clutter",
            rationale:
              "Fixed office and lighting equipment are intentional parts of the workspace.",
            temporalVisibility: "persistent",
          },
        ],
        uncertain: [
          {
            id: "small-white-desk-object",
            label: "small white object that may be a stray cup",
            location: "camera-left desk next to the monitor",
            rationale: "It could be temporary clutter or functional equipment.",
            temporalVisibility: "persistent",
            uncertainty:
              "Unclear whether this is a stray cup or a functional item.",
            safeDefault: "preserve",
          },
        ],
      },
    }),
    CREATED_AT + 1_000
  );
}

test("generation prompt never asserts what a protected region contains", () => {
  const plan = incidentPlan();
  const rendered = initialLampBackgroundMegaPrompt(plan).rendered;

  // Removal targets keep their labels — the model must know what to erase.
  assert.match(rendered, /\[desk-snack-clutter\] snacks and loose packaging/);

  // Preserve and uncertain entries keep their ids and locations but drop the
  // object nouns the generator could materialize.
  assert.match(
    rendered,
    /\[monitor-and-ring-light\] protected source region — camera-left desk, behind the clutter/
  );
  assert.match(
    rendered,
    /\[small-white-desk-object\] protected source region — camera-left desk next to the monitor/
  );
  assert.doesNotMatch(rendered, /monitor and ring light/);
  assert.doesNotMatch(rendered, /ring light\b/i);
  assert.doesNotMatch(rendered, /stray cup/);

  // The protection semantics stay explicit.
  assert.match(rendered, /keep exactly what the source shows here/);
  assert.match(
    rendered,
    /Not a removal target under any interpretation\. Safe default: PRESERVE\./
  );
});

test("protected-region corrections are location-anchored, removal corrections keep labels", () => {
  const plan = incidentPlan();
  const restorePreserved: LampBackgroundCorrection = {
    id: "correction-1",
    sourceEvalId: "cleanup-plan-adherence",
    aspect: "preserved equipment was altered",
    severity: "critical",
    action: "restore-preserved-background",
    planItemIds: ["monitor-and-ring-light"],
  };
  const preserveUncertain: LampBackgroundCorrection = {
    id: "correction-2",
    sourceEvalId: "cleanup-plan-adherence",
    aspect: "uncertain item was removed",
    severity: "major",
    action: "preserve-uncertain-background",
    planItemIds: ["small-white-desk-object"],
  };
  const completeRemoval: LampBackgroundCorrection = {
    id: "correction-3",
    sourceEvalId: "cleanup-plan-adherence",
    aspect: "approved removal incomplete",
    severity: "critical",
    action: "complete-approved-removal",
    planItemIds: ["desk-snack-clutter"],
  };

  const restoredText = renderLampBackgroundCorrection(plan, restorePreserved);
  assert.match(
    restoredText,
    /\[monitor-and-ring-light\] the exact source content at camera-left desk, behind the clutter/
  );
  assert.doesNotMatch(restoredText, /ring light\b/i);

  const uncertainText = renderLampBackgroundCorrection(plan, preserveUncertain);
  assert.match(
    uncertainText,
    /\[small-white-desk-object\] the exact source content at camera-left desk next to the monitor/
  );
  assert.doesNotMatch(uncertainText, /stray cup/);

  // Removal corrections still identify their targets by name.
  assert.match(
    renderLampBackgroundCorrection(plan, completeRemoval),
    /\[desk-snack-clutter\] snacks and loose packaging at camera-left desk surface/
  );
});

/**
 * True first-generation bytes: the frozen legacy base contract with the
 * label-based plan block — exactly what pre-2026-07-16 executions persisted.
 */
function legacyInitialRendered(plan: LampBackgroundCleanupPlan): string {
  const legacyBase = renderLampBackgroundMegaPrompt({
    version: 1,
    base: LEGACY_V1_BASE_PROMPT,
    cleanupPlan: plan,
    corrections: [],
  });
  return legacyBase.replace(
    renderLampBackgroundPlanBlock(plan),
    renderLegacyLampBackgroundPlanBlockV1(plan)
  );
}

function allPassArtifact(plan: LampBackgroundCleanupPlan) {
  return buildLampBackgroundEvaluationArtifact({
    raw: {
      results: LAMP_BACKGROUND_VISUAL_EVAL_DEFS.map((definition) => ({
        evalId: definition.id,
        score: 92,
        confidence: 0.9,
        violations: [],
        reasoning: "No violations observed for this check.",
      })),
    },
    cleanupPlan: plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0,
  });
}

test("runs persisted before the protected-region change stay valid", () => {
  const plan = incidentPlan();
  const legacyV1 = legacyInitialRendered(plan);
  const neutralV1 = initialLampBackgroundMegaPrompt(plan).rendered;

  // The frozen legacy bytes still name the preserve label; the fresh compile
  // must not, and the two must genuinely differ for this fixture.
  assert.match(legacyV1, /monitor and ring light/);
  assert.notEqual(legacyV1, neutralV1);

  // Both forms prove the plan binding; foreign bytes never do.
  assert.equal(isPersistedInitialLampBackgroundPrompt(plan, neutralV1), true);
  assert.equal(isPersistedInitialLampBackgroundPrompt(plan, legacyV1), true);
  assert.equal(
    isPersistedInitialLampBackgroundPrompt(
      plan,
      legacyV1.replace("Decision: CLEANUP", "Decision: REDESIGN")
    ),
    false
  );

  // The v2 compiler — which the run read path replays — accepts legacy v1
  // bytes and preserves them outside the header and corrections block.
  const artifact = allPassArtifact(plan);
  const final = compileLampBackgroundFinalPrompt(legacyV1, plan, artifact);
  assert.equal(final.version, 2);
  assert.match(final.rendered, /LAMP BACKGROUND CLEANUP MEGA PROMPT v2/);
  assert.match(final.rendered, /monitor and ring light/);

  // Mixed variants never shipped, so the matcher rejects them.
  const mixedCurrentBaseLegacyBlock = initialLampBackgroundMegaPrompt(plan)
    .rendered.replace(
      renderLampBackgroundPlanBlock(plan),
      renderLegacyLampBackgroundPlanBlockV1(plan)
    );
  assert.equal(
    isPersistedInitialLampBackgroundPrompt(plan, mixedCurrentBaseLegacyBlock),
    false
  );
});

test("multi-person scenes are in scope and every person is protected", async () => {
  const plan = approveLampBackgroundCleanupPlan(
    buildLampBackgroundCleanupPlan({
      planId: "plan-multi-person-1",
      runId: "run-multi-person-1",
      createdAt: CREATED_AT,
      raw: {
        sourceScope: {
          cameraMotion: "static",
          visiblePeople: "multiple-people",
        },
        decision: "cleanup",
        sceneSummary:
          "Static webcam frame with a primary presenter, a second person near the left edge, and desk clutter camera-left.",
        remove: [
          {
            id: "desk-snack-clutter",
            label: "snacks and loose packaging",
            location: "camera-left desk surface",
            rationale:
              "Temporary snack clutter distracts from the speaker and is safe to clear.",
            temporalVisibility: "persistent",
            subjectInteraction: "none-observed",
          },
        ],
        preserve: [
          {
            id: "colleague-frame-left",
            label: "person partially visible at the left frame edge",
            location: "far camera-left edge",
            rationale:
              "Every visible person is fully protected wherever they appear.",
            temporalVisibility: "intermittent",
          },
        ],
        uncertain: [],
      },
    }),
    CREATED_AT + 1_000
  );

  assert.equal(plan.sourceScope.visiblePeople, "multiple-people");
  // The widened scope participates in the approval hash binding.
  assert.match(await hashLampBackgroundCleanupPlan(plan), /^[a-f0-9]{64}$/);

  const rendered = initialLampBackgroundMegaPrompt(plan).rendered;
  assert.match(rendered, /Preserve every visible person wherever they move/);
  assert.match(rendered, /Do not remove, alter, or restyle any person/);
  // The person's preserve entry follows the protected-region rule: location
  // only, no description the generator could materialize.
  assert.match(
    rendered,
    /\[colleague-frame-left\] protected source region — far camera-left edge/
  );
  assert.doesNotMatch(rendered, /partially visible at the left frame edge/);

  assert.match(
    LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT,
    /single-person and multiple-people scenes are both supported/
  );
});

test("moving cameras and person-free scenes stay out of scope", () => {
  const raw = (sourceScope: {
    cameraMotion: string;
    visiblePeople: string;
  }) => ({
    sourceScope,
    decision: "cleanup",
    sceneSummary: "A scene that should be refused before any plan is built.",
    remove: [
      {
        id: "any-target",
        label: "loose clutter",
        location: "camera-left",
        rationale: "Placeholder removal target for scope-rejection coverage.",
        temporalVisibility: "persistent",
        subjectInteraction: "none-observed",
      },
    ],
    preserve: [],
    uncertain: [],
  });
  for (const sourceScope of [
    { cameraMotion: "moving", visiblePeople: "single-person" },
    { cameraMotion: "static", visiblePeople: "none" },
    { cameraMotion: "static", visiblePeople: "uncertain" },
  ]) {
    assert.throws(
      () =>
        buildLampBackgroundCleanupPlan({
          planId: "plan-out-of-scope",
          runId: "run-out-of-scope",
          createdAt: CREATED_AT,
          raw: raw(sourceScope),
        }),
      /static-camera source videos with at least one clearly visible person/
    );
  }
});
