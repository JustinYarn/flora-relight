import assert from "node:assert/strict";
import test from "node:test";

import {
  approveLampBackgroundCleanupPlan,
  buildLampBackgroundCleanupPlan,
  createMockLampBackgroundCleanupPlan,
  hashLampBackgroundCleanupPlan,
  lampBackgroundPlanRequiresGeneration,
  LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT,
  LAMP_BACKGROUND_NO_OP_REGIONS,
  type LampBackgroundCleanupPlan,
} from "../lib/lamp-background.ts";
import {
  buildLampBackgroundEvaluationArtifact,
  LAMP_BACKGROUND_EVAL_DEFS,
  LAMP_BACKGROUND_EVAL_IDS,
  LAMP_BACKGROUND_VISUAL_EVAL_DEFS,
  renderLampBackgroundHolisticEvaluatorPrompt,
  type LampBackgroundEvalId,
} from "../lib/lamp-background-evaluation.ts";
import {
  compileLampBackgroundFinalPrompt,
  initialLampBackgroundMegaPrompt,
  LAMP_BACKGROUND_BASE_PROMPT,
} from "../lib/prompts/lamp-background.ts";
import {
  lampBackgroundNoOpPromptForRun,
  projectLampBackgroundEvaluationForRead,
} from "../lib/lamp-background-read.ts";
import {
  evalDefForId,
  evalDefForRun,
  evalDefsForRun,
} from "../lib/lamp-evaluation.ts";
import { deriveStageChips } from "../components/canvas/derive.ts";
import {
  evalDefsForRuns,
  isGradeable,
  needsLampHumanGrade,
} from "../components/grade/derive.ts";
import type { Run, RunConfig } from "../lib/types.ts";

const CREATED_AT = 1_750_000_000_000;

function cleanupRaw() {
  return {
    sourceScope: {
      cameraMotion: "static",
      visiblePeople: "single-person",
    },
    decision: "cleanup",
    sceneSummary:
      "Static single-person interview frame with a desk, shelving, and ordinary temporary visual clutter.",
    remove: [
      {
        id: "desk-cables",
        label: "loose cable bundle",
        location: "desk foreground camera-left",
        rationale:
          "The loose cable bundle reads as temporary visual clutter and can be removed without redesigning the room.",
        temporalVisibility: "persistent",
        subjectInteraction: "none-observed",
      },
      {
        id: "paper-packaging-cluster",
        label: "papers and packaging cluster",
        location: "back corner of desk camera-right",
        rationale:
          "The scattered temporary cluster distracts from the speaker and makes the background feel unfinished.",
        temporalVisibility: "intermittent",
        subjectInteraction: "none-observed",
      },
    ],
    preserve: [
      {
        id: "wall-shelf",
        label: "fixed wall shelf and its meaningful display objects",
        location: "upper background camera-left",
        rationale:
          "The shelf is a stable part of the room and establishes the source scene.",
        temporalVisibility: "persistent",
      },
    ],
    uncertain: [
      {
        id: "dark-desk-item",
        label: "partially hidden dark desk item",
        location: "behind the subject's right arm",
        rationale:
          "It could read as clutter, but its purpose and interaction are not fully visible.",
        temporalVisibility: "partially-occluded",
        uncertainty:
          "The subject may touch it during an occluded portion of the clip.",
        safeDefault: "preserve",
      },
    ],
  };
}

function draftCleanupPlan(
  overrides: Partial<{
    raw: ReturnType<typeof cleanupRaw>;
    planId: string;
    runId: string;
    createdAt: number;
  }> = {}
): LampBackgroundCleanupPlan {
  return buildLampBackgroundCleanupPlan({
    raw: overrides.raw ?? cleanupRaw(),
    planId: overrides.planId ?? "plan-background-1",
    runId: overrides.runId ?? "run-background-1",
    createdAt: overrides.createdAt ?? CREATED_AT,
  });
}

function approvedCleanupPlan(): LampBackgroundCleanupPlan {
  return approveLampBackgroundCleanupPlan(
    draftCleanupPlan(),
    CREATED_AT + 1_000
  );
}

function noOpRaw() {
  return {
    sourceScope: {
      cameraMotion: "static",
      visiblePeople: "single-person",
    },
    decision: "exceptional-no-op",
    sceneSummary:
      "Static single-person interview frame with a deliberately minimal and already presentation-ready background.",
    remove: [],
    preserve: [
      {
        id: "minimal-room",
        label: "minimal room surfaces and one intentional plant",
        location: "throughout the visible background",
        rationale:
          "The sparse arrangement is coherent, intentional, and already professionally presentable.",
        temporalVisibility: "persistent",
      },
    ],
    uncertain: [],
    noOpJustification: {
      reasonCode: "already-presentation-ready",
      confidence: 0.98,
      summary:
        "The complete timeline shows a deliberately minimal room with clear surfaces, balanced negative space, and no temporary visual clutter that would benefit from removal.",
      regionEvidence: LAMP_BACKGROUND_NO_OP_REGIONS.map((region) => ({
        region,
        finding: `The ${region} region remains clean and intentionally composed throughout.`,
      })),
      whyRemovalWouldNotImprovePresentation:
        "Removing the intentional room elements would reduce context without creating a cleaner or more professional result.",
    },
  };
}

function rawVisualResults() {
  return LAMP_BACKGROUND_VISUAL_EVAL_DEFS.map((definition, index) => ({
    evalId: definition.id,
    score: 90 + (index % 5),
    confidence: 0.9,
    violations: [],
    reasoning: `Fixture evidence for ${definition.id}.`,
  }));
}

test("cleanup plans are persisted as drafts and require explicit human approval", async () => {
  const draft = draftCleanupPlan();
  assert.equal(draft.approval.status, "draft");
  assert.equal(draft.remove.length, 2);
  assert.equal(draft.uncertain[0]?.safeDefault, "preserve");
  assert.equal(lampBackgroundPlanRequiresGeneration(draft), true);

  assert.throws(
    () => initialLampBackgroundMegaPrompt(draft),
    /explicit human approval/
  );

  const approved = approveLampBackgroundCleanupPlan(
    draft,
    CREATED_AT + 1_000
  );
  assert.deepEqual(approved.approval, {
    status: "approved",
    approvedBy: "human",
    approvedAt: CREATED_AT + 1_000,
  });

  const draftHash = await hashLampBackgroundCleanupPlan(draft);
  const approvedHash = await hashLampBackgroundCleanupPlan(approved);
  assert.equal(draftHash, approvedHash);
  assert.match(draftHash, /^[a-f0-9]{64}$/);
});

test("the provider-free mock plan remains a draft for the approval pause", () => {
  const mock = createMockLampBackgroundCleanupPlan(
    "run_mock_background",
    CREATED_AT
  );
  assert.equal(mock.approval.status, "draft");
  assert.equal(mock.runId, "run_mock_background");
  assert.equal(mock.decision, "cleanup");
  assert.ok(mock.remove.length > 0);
});

test("unchanged pass-through is allowed only through the strict exceptional no-op contract", () => {
  assert.throws(
    () =>
      buildLampBackgroundCleanupPlan({
        raw: { ...cleanupRaw(), remove: [] },
        planId: "invalid-empty-cleanup",
        runId: "run-empty",
        createdAt: CREATED_AT,
      }),
    /requires at least one approved removal target/
  );

  const missingRegion = noOpRaw();
  missingRegion.noOpJustification.regionEvidence.pop();
  assert.throws(
    () =>
      buildLampBackgroundCleanupPlan({
        raw: missingRegion,
        planId: "invalid-no-op",
        runId: "run-no-op",
        createdAt: CREATED_AT,
      }),
    /cover each required region exactly once/
  );

  const unresolved = {
    ...noOpRaw(),
    uncertain: [cleanupRaw().uncertain[0]],
  };
  assert.throws(
    () =>
      buildLampBackgroundCleanupPlan({
        raw: unresolved,
        planId: "invalid-uncertain-no-op",
        runId: "run-no-op",
        createdAt: CREATED_AT,
      }),
    /cannot rely on unresolved uncertain items/
  );

  const noOp = buildLampBackgroundCleanupPlan({
    raw: noOpRaw(),
    planId: "valid-no-op",
    runId: "run-no-op",
    createdAt: CREATED_AT,
  });
  assert.equal(lampBackgroundPlanRequiresGeneration(noOp), false);
  const approvedNoOp = approveLampBackgroundCleanupPlan(
    noOp,
    CREATED_AT + 1
  );
  assert.throws(
    () => initialLampBackgroundMegaPrompt(approvedNoOp),
    /must bypass generation and deliver the exact source/
  );
});

test("the planning and generation prompts authorize background cleanup only", () => {
  const plan = approvedCleanupPlan();
  const prompt = initialLampBackgroundMegaPrompt(plan);

  assert.match(LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT, /NO-OP IS EXCEPTIONAL/);
  assert.match(prompt.rendered, /LAMP BACKGROUND CLEANUP MEGA PROMPT v1/);
  assert.match(prompt.rendered, /\[desk-cables\] loose cable bundle/);
  assert.match(prompt.rendered, /\[wall-shelf\]/);
  assert.match(prompt.rendered, /\[dark-desk-item\]/);
  assert.match(prompt.rendered, /UNCERTAIN — preserve by default/);
  assert.match(prompt.rendered, /desks and foreground surfaces/);
  assert.match(prompt.rendered, /No relighting, color grade, background blur/);
  assert.match(
    LAMP_BACKGROUND_BASE_PROMPT.task,
    /visible, presentation-ready improvement/
  );
  assert.doesNotMatch(prompt.rendered, /three-point|key light|fill light/i);
});

test("Lamp Background owns the agreed nine visual checks plus deterministic audio", () => {
  assert.deepEqual(
    LAMP_BACKGROUND_EVAL_DEFS.map((definition) => definition.id),
    LAMP_BACKGROUND_EVAL_IDS
  );
  assert.equal(LAMP_BACKGROUND_VISUAL_EVAL_DEFS.length, 9);
  assert.equal(LAMP_BACKGROUND_EVAL_DEFS.length, 10);
  assert.equal(
    LAMP_BACKGROUND_EVAL_DEFS.find(
      (definition) => definition.id === "audio-integrity"
    )?.method,
    "deterministic"
  );
  assert.equal(
    Math.round(
      LAMP_BACKGROUND_EVAL_DEFS.reduce(
        (sum, definition) => sum + definition.weight,
        0
      ) * 100
    ) / 100,
    1
  );
  for (const id of [
    "cleanup-plan-adherence",
    "background-cleanup-quality",
    "background-temporal-stability",
    "inpainting-artifacts",
    "lighting-camera-fidelity",
  ] satisfies LampBackgroundEvalId[]) {
    assert.equal(
      LAMP_BACKGROUND_EVAL_DEFS.find(
        (definition) => definition.id === id
      )?.hardGate,
      true,
      id
    );
  }
});

test("Lamp Background Final evaluation stays hidden only for an explicit blind read", () => {
  const plan = approvedCleanupPlan();
  const artifact = buildLampBackgroundEvaluationArtifact({
    raw: { results: rawVisualResults() },
    cleanupPlan: plan,
    iteration: 2,
    audioVerified: true,
    costUsd: 0.01,
  });
  assert.equal(
    projectLampBackgroundEvaluationForRead({
      iteration: 2,
      artifact,
      cleanupPlan: plan,
      humanGradeSaved: false,
    }).evalResults.length,
    LAMP_BACKGROUND_EVAL_IDS.length
  );
  assert.deepEqual(
    projectLampBackgroundEvaluationForRead({
      iteration: 2,
      artifact,
      cleanupPlan: plan,
      humanGradeSaved: false,
      hideFinalEvaluation: true,
    }),
    { evalResults: [] }
  );
  assert.equal(
    projectLampBackgroundEvaluationForRead({
      iteration: 2,
      artifact,
      cleanupPlan: plan,
      humanGradeSaved: true,
      hideFinalEvaluation: true,
    }).evalResults.length,
    LAMP_BACKGROUND_EVAL_IDS.length
  );
});

test("an approved exceptional no-op enters human grading without pretending AI ran", () => {
  const video = {
    id: "video-no-op",
    runId: "run-no-op-grade",
    kind: "original" as const,
    url: "/source/no-op.mp4",
    label: "already-clean.mp4",
    durationSec: 8,
    width: 1280,
    height: 720,
    hasAudio: true,
  };
  const approvedNoOp = approveLampBackgroundCleanupPlan(
    buildLampBackgroundCleanupPlan({
      raw: noOpRaw(),
      planId: "no-op-grade-plan",
      runId: "run-no-op-grade",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1
  );
  const finalVideo = {
    ...video,
    id: "no-op-final",
    kind: "final" as const,
  };
  const run: Run = {
    id: "run-no-op-grade",
    workflowId: "lamp-background-v1",
    workflowMode: "background",
    createdAt: CREATED_AT,
    originalVideo: video,
    backgroundCleanupPlan: approvedNoOp,
    status: "awaiting-review",
    finalVideo,
    nodeStates: {},
    log: [],
    iterations: [
      {
        index: 2,
        megaPrompt: lampBackgroundNoOpPromptForRun(approvedNoOp),
        generatedVideo: finalVideo,
        beforeFrames: [],
        afterFrames: [],
        evalResults: [],
        status: "ungraded",
      },
    ],
  };
  assert.equal(isGradeable(run), true);
  assert.equal(needsLampHumanGrade(run), true);
  assert.equal(run.iterations[0]?.evalResults.length, 0);

  const foreignPlanRun: Run = {
    ...run,
    backgroundCleanupPlan: {
      ...approvedNoOp,
      runId: "different-source-run",
    },
  };
  assert.equal(isGradeable(foreignPlanRun), false);
  assert.equal(needsLampHumanGrade(foreignPlanRun), false);
});

test("the holistic evaluator is plan-bound and keeps deterministic audio out of the model call", () => {
  const rendered = renderLampBackgroundHolisticEvaluatorPrompt(
    approvedCleanupPlan()
  );
  assert.match(rendered, /exact human-approved cleanup plan/i);
  assert.match(rendered, /"desk-cables"/);
  assert.match(rendered, /uncertain and all unlisted content are preserve-by-default/i);
  assert.match(rendered, /exactly one row for each of the nine visual checks/i);
  assert.match(rendered, /no audio-integrity row/i);
  assert.match(rendered, /complete-approved-removal/);

  const approvedNoOp = approveLampBackgroundCleanupPlan(
    buildLampBackgroundCleanupPlan({
      raw: noOpRaw(),
      planId: "no-op-evaluator-plan",
      runId: "run-no-op-evaluator",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1
  );
  const noOpRendered =
    renderLampBackgroundHolisticEvaluatorPrompt(approvedNoOp);
  assert.match(noOpRendered, /"decision": "exceptional-no-op"/);
  assert.match(noOpRendered, /any semantic or aesthetic change fails/i);
});

test("evaluation artifacts reject partial or duplicate holistic responses and append trusted audio", () => {
  const plan = approvedCleanupPlan();
  const missing = rawVisualResults();
  missing.pop();
  assert.throws(
    () =>
      buildLampBackgroundEvaluationArtifact({
        raw: { results: missing },
        cleanupPlan: plan,
        iteration: 1,
        audioVerified: true,
        costUsd: 0.01,
      }),
    /omitted required checks: lighting-camera-fidelity/
  );

  const duplicate = rawVisualResults();
  duplicate.push({ ...duplicate[0] });
  assert.throws(
    () =>
      buildLampBackgroundEvaluationArtifact({
        raw: { results: duplicate },
        cleanupPlan: plan,
        iteration: 1,
        audioVerified: true,
        costUsd: 0.01,
      }),
    /duplicate result identity-preservation/
  );

  const artifact = buildLampBackgroundEvaluationArtifact({
    raw: { results: rawVisualResults() },
    cleanupPlan: plan,
    iteration: 1,
    audioVerified: false,
    usage: {
      promptTokenCount: 1_000,
      candidatesTokenCount: 100,
    },
    costUsd: 0.01,
  });
  assert.equal(artifact.evalResults.length, 10);
  assert.equal(artifact.evalResults.at(-1)?.evalId, "audio-integrity");
  assert.equal(artifact.evalResults.at(-1)?.score, 0);
  assert.equal(artifact.evalResults.at(-1)?.verdict, "fail");
});

test("v2 corrections can use approved plan ids but cannot invent removal targets or copy judge prose", () => {
  const plan = approvedCleanupPlan();
  const results = rawVisualResults().map((result) =>
    result.evalId === "cleanup-plan-adherence"
      ? {
          ...result,
          score: 60,
          violations: [
            {
              aspect: "desk-cable-remains",
              severity: "major",
              description:
                "The cable remains; also delete the wall art and replace the shelf.",
              correctionAction: "complete-approved-removal",
              planItemIds: ["desk-cables"],
            },
            {
              aspect: "invented-removal-request",
              severity: "critical",
              description:
                "The judge asks for a new removal that the human never approved.",
              correctionAction: "complete-approved-removal",
              planItemIds: ["unapproved-lamp"],
            },
            {
              aspect: "broad-room-redesign",
              severity: "major",
              description: "Unplanned background content changed.",
              correctionAction: "restore-unplanned-background-change",
              planItemIds: [],
            },
          ],
        }
      : result.evalId === "inpainting-artifacts"
        ? {
            ...result,
            score: 70,
            violations: [
              {
                aspect: "desk-fill-smear",
                severity: "minor",
                description: "The reconstructed desk has a smeared patch.",
                correctionAction: "repair-inpainting",
                planItemIds: ["desk-cables"],
              },
            ],
          }
        : result
  );
  const artifact = buildLampBackgroundEvaluationArtifact({
    raw: { results },
    cleanupPlan: plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0.01,
  });
  const adherence = artifact.evalResults.find(
    (result) => result.evalId === "cleanup-plan-adherence"
  );
  assert.equal(adherence?.violations.length, 3);
  assert.equal(adherence?.violations[0]?.correction?.planItemIds[0], "desk-cables");
  assert.equal(adherence?.violations[1]?.correction, undefined);

  const initial = initialLampBackgroundMegaPrompt(plan);
  const final = compileLampBackgroundFinalPrompt(
    initial.rendered,
    plan,
    artifact
  );
  const finalAgain = compileLampBackgroundFinalPrompt(
    initial.rendered,
    plan,
    artifact
  );
  assert.equal(final.rendered, finalAgain.rendered);
  assert.equal(final.version, 2);
  assert.match(final.rendered, /LAMP BACKGROUND CLEANUP MEGA PROMPT v2/);
  assert.match(
    final.rendered,
    /Complete only these already approved removals wherever visible: \[desk-cables\]/
  );
  assert.match(final.rendered, /Repair reconstruction only inside the footprints/);
  assert.match(final.rendered, /Restore every unapproved background change/);
  assert.doesNotMatch(final.rendered, /also delete the wall art/);
  assert.doesNotMatch(final.rendered, /unapproved-lamp/);
  assert.equal(final.corrections.length, 3);
});

test("the final compiler preserves v1 bytes outside the header and corrections block", () => {
  const plan = approvedCleanupPlan();
  const initial = initialLampBackgroundMegaPrompt(plan);
  const artifact = buildLampBackgroundEvaluationArtifact({
    raw: { results: rawVisualResults() },
    cleanupPlan: plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0,
  });
  const final = compileLampBackgroundFinalPrompt(
    initial.rendered,
    plan,
    artifact
  );
  assert.equal(final.corrections.length, 0);
  const restored = final.rendered
    .replace(
      "=== LAMP BACKGROUND CLEANUP MEGA PROMPT v2 ===",
      "=== LAMP BACKGROUND CLEANUP MEGA PROMPT v1 ==="
    )
    .replace(
      "(none — first pass or no safe structured correction was available)",
      "(none — first pass or no safe structured correction was available)"
    );
  assert.equal(restored, initial.rendered);
});

test("persisted v1 plan bytes and evaluation plan identity cannot be swapped", () => {
  const plan = approvedCleanupPlan();
  const initial = initialLampBackgroundMegaPrompt(plan);
  const artifact = buildLampBackgroundEvaluationArtifact({
    raw: { results: rawVisualResults() },
    cleanupPlan: plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0,
  });

  assert.throws(
    () =>
      compileLampBackgroundFinalPrompt(initial.rendered, plan, {
        ...artifact,
        cleanupPlanId: "different-plan",
      }),
    /bound to the same cleanup plan/
  );

  const changedRaw = cleanupRaw();
  changedRaw.remove.push({
    id: "new-unapproved-target",
    label: "new target added after v1",
    location: "camera-right background",
    rationale:
      "This target was deliberately added after the persisted prompt for the mismatch test.",
    temporalVisibility: "persistent",
    subjectInteraction: "none-observed",
  });
  const changedPlan = approveLampBackgroundCleanupPlan(
    draftCleanupPlan({ raw: changedRaw }),
    CREATED_AT + 1_000
  );
  assert.throws(
    () =>
      compileLampBackgroundFinalPrompt(
        initial.rendered,
        changedPlan,
        artifact
      ),
    /no longer matches the plan bound into the persisted v1 prompt/
  );
});

test("run-scoped display definitions never resolve Lamp Background checks through Flora", () => {
  const backgroundRun = {
    workflowId: "lamp-background-v1",
    workflowMode: "background",
  } as Run;
  const definitions = evalDefsForRun(backgroundRun);
  assert.equal(definitions.length, 10);
  assert.equal(
    evalDefForRun(backgroundRun, "background-cleanup-quality")?.name,
    "Background meaningfully tidier"
  );
  assert.equal(
    evalDefForId("cleanup-plan-adherence")?.name,
    "Approved plan followed"
  );
  // An empty Grade set defaults to this branch's method — Lamp Beautify's
  // ten visual rows plus deterministic audio.
  assert.equal(evalDefsForRuns([]).length, 11);
});

test("background stage chips preserve the five-stage method and skip generation for an approved no-op", () => {
  const runId = "run-background-no-op-display";
  const plan = approveLampBackgroundCleanupPlan(
    buildLampBackgroundCleanupPlan({
      raw: noOpRaw(),
      planId: "plan-background-no-op-display",
      runId,
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1_000
  );
  const run = {
    id: runId,
    workflowId: "lamp-background-v1",
    workflowMode: "background",
    createdAt: CREATED_AT,
    originalVideo: {
      id: "video-background-no-op-display",
      kind: "original",
      url: "/source.mp4",
      label: "Background no-op source",
      durationSec: 8,
      width: 1280,
      height: 720,
      hasAudio: true,
    },
    status: "awaiting-review",
    backgroundCleanupPlan: plan,
    iterations: [],
    nodeStates: {
      plan: { nodeId: "plan", status: "succeeded" },
      initial: { nodeId: "initial", status: "skipped" },
      critique: { nodeId: "critique", status: "skipped" },
      final: { nodeId: "final", status: "skipped" },
      review: { nodeId: "review", status: "queued" },
    },
    log: [],
  } satisfies Run;
  const config: RunConfig = {
    maxIterations: 2,
    compositePassThreshold: 75,
    judges: ["gemini"],
    frameTimestamps: [],
    keyframeFirst: false,
    plateauMinDelta: 0,
  };
  const chips = deriveStageChips(run, config, "background");
  assert.deepEqual(
    chips.map((chip) => chip.id),
    ["plan", "initial", "critique", "final", "review"]
  );
  assert.deepEqual(
    chips.map((chip) => chip.state),
    ["pass", "skipped", "skipped", "skipped", "running"]
  );
  assert.equal(chips.find((chip) => chip.id === "final")?.detail, "exact source");
});
