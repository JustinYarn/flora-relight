import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLampIrisIntensityOverride,
  approveLampIrisPlan,
  buildLampIrisPlan,
  createMockLampIrisPlan,
  hashLampIrisPlan,
  LAMP_IRIS_ACTIVE_CATALOG,
  LAMP_IRIS_PLAN_PROMPT,
  lampIrisPlanRequiresGeneration,
  lampIrisPlansDifferOnlyByIntensity,
  parseLampIrisPlan,
  type LampIrisPlan,
} from "../lib/lamp-iris.ts";
import {
  buildLampIrisEvaluationArtifact,
  collectLampIrisCorrections,
  LAMP_IRIS_EVAL_DEFS,
  LAMP_IRIS_EVAL_IDS,
  LAMP_IRIS_VISUAL_EVAL_DEFS,
  renderLampIrisHolisticEvaluatorPrompt,
} from "../lib/lamp-iris-evaluation.ts";
import {
  compileLampIrisFinalPrompt,
  initialLampIrisMegaPrompt,
  isPersistedInitialLampIrisPrompt,
  renderLampIrisCorrection,
} from "../lib/prompts/lamp-iris.ts";
import { IRIS_WORKFLOW } from "../lib/iris-workflow-def.ts";
import {
  LAMP_IRIS_EXECUTION_PREFIX,
  parseWorkflowMode,
  runWorkflowMode,
  workflowModeFromExecutionId,
  workflowModeLabel,
} from "../lib/workflow-mode.ts";
import type { Run } from "../lib/types.ts";

const CREATED_AT = 1_760_000_000_000;

function correctRaw() {
  return {
    sourceScope: {
      cameraMotion: "static",
      visiblePeople: "single-person",
    },
    decision: "correct",
    subjectSummary:
      "Close-up webcam framing; the resting gaze anchors below the lens on a script with recurring drops toward off-screen notes.",
    correct: [
      {
        id: "camera-axis-anchor",
        intensity: 2,
        rationale:
          "Re-anchoring the resting gaze to the lens restores conversational presence.",
        evidence:
          "The gaze rests a few degrees below the lens for most of the take.",
      },
    ],
    declined: [
      {
        id: "reading-scan-smoothing",
        reason: "No horizontal line-scanning pattern is visible.",
      },
    ],
    uncertain: [
      {
        id: "note-glance-bridging",
        uncertainty:
          "Brief eye drops may be natural thinking looks rather than note checks.",
        safeDefault: "decline",
      },
    ],
  };
}

function noOpRaw() {
  return {
    sourceScope: {
      cameraMotion: "static",
      visiblePeople: "single-person",
    },
    decision: "exceptional-no-op",
    subjectSummary:
      "Static single-person webcam framing whose subject already speaks straight into the lens.",
    correct: [],
    declined: [
      {
        id: "camera-axis-anchor",
        reason: "The resting gaze already sits on the lens.",
      },
    ],
    uncertain: [],
    noOpJustification: {
      reasonCode: "already-holds-contact",
      confidence: 0.97,
      summary:
        "The subject already holds natural, alive camera contact for essentially the whole take, with a relaxed blink cadence and no reading anchor, so no catalog correction at any intensity would lift presence.",
      regionEvidence: [
        {
          region: "camera-axis",
          finding: "The resting gaze sits centered on the lens throughout.",
        },
        {
          region: "reading-pattern",
          finding: "No line-scanning saccades appear during any spoken passage.",
        },
        {
          region: "glances",
          finding: "Only rare natural thinking glances that read as conversation.",
        },
        {
          region: "blinks",
          finding: "A natural relaxed blink cadence continues across the timeline.",
        },
        {
          region: "overall-contact",
          finding: "The subject already reads as speaking directly to the viewer.",
        },
      ],
      whyCorrectionWouldNotImproveContact:
        "Contact is already the steady state of the take and any correction would only risk a frozen stare.",
    },
  };
}

function approvedPlan(): LampIrisPlan {
  return approveLampIrisPlan(
    buildLampIrisPlan({
      raw: correctRaw(),
      planId: "plan-iris-1",
      runId: "run-iris-1",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1_000
  );
}

test("the iris plan enforces the closed catalog and intensity bounds", () => {
  const plan = approvedPlan();
  assert.equal(plan.decision, "correct");
  assert.equal(plan.correct.length, 1);
  assert.equal(plan.correct[0]?.intensity, 2);

  const badCategory = correctRaw();
  badCategory.correct[0]!.id = "eye-widening" as never;
  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: badCategory,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /closed catalog/
  );

  const badIntensity = correctRaw();
  badIntensity.correct[0]!.intensity = 5 as never;
  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: badIntensity,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /intensity must be 1, 2, or 3/
  );

  const duplicated = correctRaw();
  duplicated.declined.push({
    id: "camera-axis-anchor",
    reason: "Also declined, which contradicts the correct entry.",
  });
  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: duplicated,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /more than one classification/
  );

  const empty = correctRaw();
  empty.correct = [];
  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: empty,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /at least one approved gaze correction/
  );
});

test("scope, approval, and hashing follow the house contract", async () => {
  const moving = correctRaw();
  moving.sourceScope.cameraMotion = "moving" as never;
  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: moving,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /static-camera source videos with at least one clearly visible person/
  );

  const multi = correctRaw();
  multi.sourceScope.visiblePeople = "multiple-people" as never;
  const multiPlan = buildLampIrisPlan({
    raw: multi,
    planId: "p-multi",
    runId: "r-multi",
    createdAt: CREATED_AT,
  });
  assert.equal(multiPlan.sourceScope.visiblePeople, "multiple-people");

  const draft = buildLampIrisPlan({
    raw: correctRaw(),
    planId: "plan-iris-1",
    runId: "run-iris-1",
    createdAt: CREATED_AT,
  });
  assert.equal(draft.approval.status, "draft");
  assert.throws(
    () => initialLampIrisMegaPrompt(draft),
    /explicit human approval/
  );

  const approved = approveLampIrisPlan(draft, CREATED_AT + 5);
  const draftHash = await hashLampIrisPlan(draft);
  const approvedHash = await hashLampIrisPlan(approved);
  assert.equal(draftHash, approvedHash);
  assert.match(approvedHash, /^[a-f0-9]{64}$/);

  const mock = createMockLampIrisPlan("run-mock", CREATED_AT);
  assert.equal(mock.approval.status, "draft");
  assert.equal(lampIrisPlanRequiresGeneration(mock), true);
  assert.equal(parseLampIrisPlan(mock).id, mock.id);
});

test("generation prompt renders only approved corrections", () => {
  const plan = approvedPlan();
  const rendered = initialLampIrisMegaPrompt(plan).rendered;

  assert.match(rendered, /LAMP IRIS EYE-CONTACT MEGA PROMPT v1/);
  assert.match(rendered, /\[camera-axis-anchor\] intensity 2 of 3/);
  assert.match(rendered, /Permanent features stay/);
  assert.match(rendered, /every background pixel source-faithful/i);
  assert.match(rendered, /Do not freeze the eyes into a fixed stare/);

  // Declined and uncertain categories never reach generation input — naming
  // them would seed the idea (the ring-light lesson from Lamp Background).
  assert.doesNotMatch(rendered, /reading-scan-smoothing/);
  assert.doesNotMatch(rendered, /note-glance-bridging/);

  // The evaluator, by contrast, must see the full catalog decisions.
  const evaluatorPrompt = renderLampIrisHolisticEvaluatorPrompt({
    plan,
    iteration: 1,
  });
  assert.match(evaluatorPrompt, /reading-scan-smoothing/);
  assert.match(evaluatorPrompt, /note-glance-bridging/);

  assert.equal(isPersistedInitialLampIrisPrompt(plan, rendered), true);
  assert.equal(
    isPersistedInitialLampIrisPrompt(
      plan,
      rendered.replace("Decision: CORRECT", "Decision: REDESIGN")
    ),
    false
  );
});

test("an exceptional no-op demands complete region evidence", () => {
  const plan = buildLampIrisPlan({
    raw: noOpRaw(),
    planId: "plan-iris-noop",
    runId: "run-iris-noop",
    createdAt: CREATED_AT,
  });
  assert.equal(plan.decision, "exceptional-no-op");
  assert.equal(plan.noOpJustification?.reasonCode, "already-holds-contact");
  assert.equal(plan.noOpJustification?.regionEvidence.length, 5);
  assert.equal(lampIrisPlanRequiresGeneration(plan), false);

  // An approved no-op still may never enter generation.
  const approved = approveLampIrisPlan(plan, CREATED_AT + 5);
  assert.throws(() => initialLampIrisMegaPrompt(approved), /bypass generation/);

  const missingRegion = noOpRaw();
  missingRegion.noOpJustification.regionEvidence.pop();
  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: missingRegion,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /each required region exactly once/
  );

  const duplicatedRegion = noOpRaw();
  duplicatedRegion.noOpJustification.regionEvidence.push({
    region: "blinks",
    finding: "A second duplicate blink entry for the guard.",
  });
  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: duplicatedRegion,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /each required region exactly once/
  );

  const wrongReason = noOpRaw();
  wrongReason.noOpJustification.reasonCode = "looks-fine" as never;
  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: wrongReason,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /already-holds-contact/
  );

  const thinWhy = noOpRaw();
  thinWhy.noOpJustification.whyCorrectionWouldNotImproveContact = "Too short.";
  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: thinWhy,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /whyCorrectionWouldNotImproveContact/
  );

  const lowConfidence = noOpRaw();
  lowConfidence.noOpJustification.confidence = 0.5;
  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: lowConfidence,
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /between 0\.95 and 1/
  );

  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: {
          ...noOpRaw(),
          correct: [
            {
              id: "reading-scan-smoothing",
              intensity: 1,
              rationale: "A correction inside a no-op must be rejected.",
              evidence: "This entry exists only to violate the contract.",
            },
          ],
        },
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /cannot contain corrections/
  );

  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: {
          ...noOpRaw(),
          uncertain: [
            {
              id: "note-glance-bridging",
              uncertainty: "Possibly natural thinking looks.",
              safeDefault: "decline",
            },
          ],
        },
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /cannot rely on unresolved uncertain items/
  );

  assert.throws(
    () =>
      buildLampIrisPlan({
        raw: {
          ...correctRaw(),
          noOpJustification: noOpRaw().noOpJustification,
        },
        planId: "p",
        runId: "r",
        createdAt: CREATED_AT,
      }),
    /cannot carry an exceptional no-op justification/
  );
});

function allPassRaw(): { results: Array<Record<string, unknown>> } {
  return {
    results: LAMP_IRIS_VISUAL_EVAL_DEFS.map(
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
  const artifact = buildLampIrisEvaluationArtifact({
    raw: allPassRaw(),
    plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0.01,
  });
  assert.equal(artifact.evalResults.length, LAMP_IRIS_EVAL_DEFS.length);
  assert.equal(
    artifact.evalResults.at(-1)?.evalId,
    "audio-integrity"
  );

  const incomplete = allPassRaw();
  incomplete.results.pop();
  assert.throws(
    () =>
      buildLampIrisEvaluationArtifact({
        raw: incomplete,
        plan,
        iteration: 1,
        audioVerified: true,
        costUsd: 0,
      }),
    /omitted required checks/
  );

  // A duplicated row cannot double-count a check: first result wins and the
  // artifact still carries every check exactly once.
  const duplicated = allPassRaw();
  duplicated.results.push({ ...duplicated.results[0]! });
  const deduped = buildLampIrisEvaluationArtifact({
    raw: duplicated,
    plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0,
  });
  assert.equal(deduped.evalResults.length, LAMP_IRIS_EVAL_IDS.length);
  assert.equal(
    new Set(deduped.evalResults.map((result) => result.evalId)).size,
    LAMP_IRIS_EVAL_IDS.length
  );

  const withViolations = allPassRaw();
  withViolations.results = withViolations.results.map((result) =>
    result.evalId === "gaze-adherence"
      ? {
          ...result,
          score: 40,
          violations: [
            {
              aspect: "still-reading-anchor",
              severity: "critical",
              description: "Approved camera-axis-anchor was left unapplied.",
              frameTimestampSec: 2.5,
              correctionAction: "complete-approved-gaze-correction",
              planItemIds: ["camera-axis-anchor"],
            },
            {
              aspect: "warmed-expression",
              severity: "major",
              description: "An unapproved expression warmth shift was introduced.",
              frameTimestampSec: 4,
              correctionAction: "remove-unapproved-changes",
              planItemIds: [],
            },
            {
              aspect: "smuggled-category",
              severity: "major",
              description:
                "References a declined category and must not compile.",
              frameTimestampSec: 5,
              correctionAction: "complete-approved-gaze-correction",
              planItemIds: ["reading-scan-smoothing"],
            },
            {
              aspect: "invented-action",
              severity: "major",
              description:
                "Uses an action outside the closed vocabulary and must not compile.",
              frameTimestampSec: 6,
              correctionAction: "sharpen-the-eyes",
              planItemIds: [],
            },
          ],
          reasoning: "Adherence failures observed.",
        }
      : result
  );
  const flawed = buildLampIrisEvaluationArtifact({
    raw: withViolations,
    plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0.01,
  });
  const corrections = collectLampIrisCorrections(flawed, plan);
  assert.equal(corrections.length, 2);
  // Severity-ranked: the critical undershoot leads the ledger.
  assert.equal(corrections[0]?.severity, "critical");
  assert.equal(corrections[0]?.action, "complete-approved-gaze-correction");
  assert.deepEqual(corrections[0]?.planItemIds, ["camera-axis-anchor"]);
  // The declined-category reference was dropped as unsafe.
  assert.equal(
    corrections.some((correction) =>
      correction.planItemIds.includes("reading-scan-smoothing")
    ),
    false
  );
  // The invented action never entered the closed correction vocabulary.
  assert.equal(
    corrections.some(
      (correction) => (correction.action as string) === "sharpen-the-eyes"
    ),
    false
  );

  const rendered = renderLampIrisCorrection(plan, corrections[0]!);
  assert.match(rendered, /\[camera-axis-anchor\] at intensity 2/);
});

test("corrections are severity-ordered, plan-bound, and capped at 12", () => {
  const capPlan = approveLampIrisPlan(
    buildLampIrisPlan({
      raw: {
        sourceScope: {
          cameraMotion: "static",
          visiblePeople: "single-person",
        },
        decision: "correct",
        subjectSummary:
          "Static webcam framing with a strong reading pattern across the whole take.",
        correct: [
          {
            id: "camera-axis-anchor",
            intensity: 2,
            rationale:
              "Re-anchoring the resting gaze restores conversational presence.",
            evidence: "The gaze rests below the lens for most of the take.",
          },
          {
            id: "reading-scan-smoothing",
            intensity: 2,
            rationale:
              "Calming the visible line-scanning steadies delivery toward the viewer.",
            evidence:
              "Horizontal scanning saccades track lines during most sentences.",
          },
          {
            id: "note-glance-bridging",
            intensity: 2,
            rationale:
              "Bridging recurring note-drops keeps contact through complete sentences.",
            evidence:
              "The eyes drop toward off-screen notes at several sentence starts.",
          },
        ],
        declined: [],
        uncertain: [],
      },
      planId: "plan-iris-cap",
      runId: "run-iris-cap",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 1_000
  );

  const idSubsets: string[][] = [
    ["camera-axis-anchor"],
    ["note-glance-bridging"],
    ["reading-scan-smoothing"],
    ["camera-axis-anchor", "note-glance-bridging"],
    ["camera-axis-anchor", "reading-scan-smoothing"],
    ["note-glance-bridging", "reading-scan-smoothing"],
    ["camera-axis-anchor", "note-glance-bridging", "reading-scan-smoothing"],
  ];
  const adherenceViolations: Array<Record<string, unknown>> = [
    ...idSubsets.map((planItemIds, index) => ({
      aspect: `undershoot-${index}`,
      severity: "minor",
      description: "Approved correction remains incomplete in this passage.",
      correctionAction: "complete-approved-gaze-correction",
      planItemIds,
    })),
    ...idSubsets.slice(0, 4).map((planItemIds, index) => ({
      aspect: `overshoot-${index}`,
      severity: "minor",
      description: "The pass over-locked the gaze beyond its approved level.",
      correctionAction: "reduce-gaze-lock",
      planItemIds,
    })),
  ];
  const capRaw = allPassRaw();
  capRaw.results = capRaw.results.map((result) => {
    if (result.evalId === "gaze-adherence") {
      return { ...result, score: 55, violations: adherenceViolations };
    }
    if (result.evalId === "identity-preservation") {
      return {
        ...result,
        score: 50,
        violations: [
          {
            aspect: "face-drift",
            severity: "critical",
            description: "The subject reads as a different person mid-take.",
            correctionAction: "restore-identity",
            planItemIds: [],
          },
        ],
      };
    }
    if (result.evalId === "gaze-naturalness") {
      return {
        ...result,
        score: 60,
        violations: [
          {
            aspect: "missing-blink",
            severity: "major",
            description: "A source blink was dropped from the candidate.",
            correctionAction: "restore-blink-pattern",
            planItemIds: [],
          },
        ],
      };
    }
    if (result.evalId === "motion-lipsync") {
      return {
        ...result,
        score: 62,
        violations: [
          {
            aspect: "retimed-mouth",
            severity: "major",
            description: "Mouth shapes drift from the source phonemes.",
            correctionAction: "restore-performance-lipsync",
            planItemIds: [],
          },
        ],
      };
    }
    return result;
  });
  const capArtifact = buildLampIrisEvaluationArtifact({
    raw: capRaw,
    plan: capPlan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0.01,
  });

  // 14 distinct safe candidates exist; the ledger keeps the worst 12.
  const capped = collectLampIrisCorrections(capArtifact, capPlan);
  assert.equal(capped.length, 12);
  assert.equal(capped[0]?.severity, "critical");
  assert.equal(capped[0]?.action, "restore-identity");
  assert.deepEqual(
    capped.slice(1, 3).map((correction) => correction.severity),
    ["major", "major"]
  );
  assert.equal(
    capped.filter((correction) => correction.severity === "minor").length,
    9
  );

  // Corrections bind to the exact evaluated plan, never a look-alike.
  assert.throws(
    () => collectLampIrisCorrections(capArtifact, approvedPlan()),
    /bound to the same iris plan/
  );
});

test("the final compiler preserves v1 bytes outside the header and corrections", () => {
  const plan = approvedPlan();
  const initial = initialLampIrisMegaPrompt(plan);
  const artifact = buildLampIrisEvaluationArtifact({
    raw: allPassRaw(),
    plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0,
  });
  const final = compileLampIrisFinalPrompt(
    initial.rendered,
    plan,
    artifact
  );
  assert.equal(final.version, 2);
  assert.equal(final.corrections.length, 0);
  assert.match(final.rendered, /^=== LAMP IRIS EYE-CONTACT MEGA PROMPT v2 ===/);
  const restored = final.rendered.replace(
    "=== LAMP IRIS EYE-CONTACT MEGA PROMPT v2 ===",
    "=== LAMP IRIS EYE-CONTACT MEGA PROMPT v1 ==="
  );
  assert.equal(restored, initial.rendered);

  // With findings, still only the header and the corrections body change.
  const withViolations = allPassRaw();
  withViolations.results = withViolations.results.map((result) =>
    result.evalId === "gaze-adherence"
      ? {
          ...result,
          score: 40,
          violations: [
            {
              aspect: "still-reading-anchor",
              severity: "critical",
              description: "Approved camera-axis-anchor was left unapplied.",
              correctionAction: "complete-approved-gaze-correction",
              planItemIds: ["camera-axis-anchor"],
            },
          ],
        }
      : result
  );
  const flawed = buildLampIrisEvaluationArtifact({
    raw: withViolations,
    plan,
    iteration: 1,
    audioVerified: true,
    costUsd: 0,
  });
  const corrected = compileLampIrisFinalPrompt(initial.rendered, plan, flawed);
  assert.equal(corrected.corrections.length, 1);
  assert.match(
    corrected.rendered,
    /\[ACTIVE CORRECTIONS FROM EVALUATION\]\n1\. \[CRITICAL\]/
  );
  const restoredCorrected = corrected.rendered
    .replace(
      "=== LAMP IRIS EYE-CONTACT MEGA PROMPT v2 ===",
      "=== LAMP IRIS EYE-CONTACT MEGA PROMPT v1 ==="
    )
    .replace(
      /\[ACTIVE CORRECTIONS FROM EVALUATION\]\n[\s\S]*?\n\n\[NEVER DO\]/,
      "[ACTIVE CORRECTIONS FROM EVALUATION]\n(none — first pass or no safe structured correction was available)\n\n[NEVER DO]"
    );
  assert.equal(restoredCorrected, initial.rendered);

  // The compiler is gated on approval exactly like the initial render.
  const draft = buildLampIrisPlan({
    raw: correctRaw(),
    planId: "plan-iris-1",
    runId: "run-iris-1",
    createdAt: CREATED_AT,
  });
  assert.throws(
    () => compileLampIrisFinalPrompt(initial.rendered, draft, artifact),
    /explicit human approval/
  );

  // A swapped plan cannot ride an existing persisted prompt.
  const otherPlan = approveLampIrisPlan(
    buildLampIrisPlan({
      raw: (() => {
        const raw = correctRaw();
        raw.correct[0]!.intensity = 3;
        return raw;
      })(),
      planId: "plan-iris-2",
      runId: "run-iris-1",
      createdAt: CREATED_AT,
    }),
    CREATED_AT + 2_000
  );
  assert.throws(
    () =>
      compileLampIrisFinalPrompt(
        initial.rendered,
        otherPlan,
        buildLampIrisEvaluationArtifact({
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

test("iris eval weights, gates, and prompt wiring hold", () => {
  const total = LAMP_IRIS_EVAL_DEFS.reduce(
    (sum, definition) => sum + definition.weight,
    0
  );
  assert.ok(
    Math.abs(total - 1) < 1e-9,
    `iris eval weights must sum to 1.0, got ${total}`
  );
  assert.deepEqual(
    LAMP_IRIS_EVAL_DEFS.map((definition) => definition.id),
    [...LAMP_IRIS_EVAL_IDS]
  );
  assert.equal(
    LAMP_IRIS_EVAL_DEFS.find((d) => d.id === "audio-integrity")?.method,
    "deterministic"
  );
  assert.equal(LAMP_IRIS_VISUAL_EVAL_DEFS.length, 10);
  assert.match(LAMP_IRIS_PLAN_PROMPT, /NO-OP IS EXCEPTIONAL/);
  assert.match(
    LAMP_IRIS_PLAN_PROMPT,
    /single-person and multiple-people scenes are both supported/
  );
  // The planner offers the full closed catalog; nothing outside it exists.
  for (const category of LAMP_IRIS_ACTIVE_CATALOG) {
    assert.match(LAMP_IRIS_PLAN_PROMPT, new RegExp(category));
  }
  assert.match(LAMP_IRIS_PLAN_PROMPT, /camera-axis-anchor: the headline correction/);
  assert.match(LAMP_IRIS_PLAN_PROMPT, /Blinks are sacred/);
});

test("workflow mode plumbing recognizes iris", () => {
  assert.equal(parseWorkflowMode("iris"), "iris");
  assert.equal(workflowModeLabel("iris"), "Lamp Iris");
  assert.equal(
    workflowModeFromExecutionId(`${LAMP_IRIS_EXECUTION_PREFIX}run-x`),
    "iris"
  );
  const run = {
    workflowMode: undefined,
    workflowId: IRIS_WORKFLOW.id,
  } as Pick<Run, "workflowMode" | "workflowId">;
  assert.equal(runWorkflowMode(run), "iris");
  assert.equal(IRIS_WORKFLOW.id, "lamp-iris-v1");
  assert.equal(IRIS_WORKFLOW.nodes.length, 5);
});

test("the intensity slider overrides levels and nothing else", async () => {
  const draft = buildLampIrisPlan({
    raw: correctRaw(),
    planId: "plan-slider-1",
    runId: "run-slider-1",
    createdAt: CREATED_AT,
  });

  const anchored = applyLampIrisIntensityOverride(draft, 3);
  assert.deepEqual(
    anchored.correct.map((item) => item.intensity),
    draft.correct.map(() => 3)
  );
  // Only intensity moved: ids, rationales, declined, and uncertain are intact.
  assert.deepEqual(
    anchored.correct.map((item) => item.id),
    draft.correct.map((item) => item.id)
  );
  assert.deepEqual(anchored.declined, draft.declined);
  assert.deepEqual(anchored.uncertain, draft.uncertain);
  assert.equal(anchored.approval.status, "draft");

  // The dial changes the binding hash — executions bind the plan as approved.
  assert.notEqual(
    await hashLampIrisPlan(anchored),
    await hashLampIrisPlan(draft)
  );

  // The binding predicate accepts exactly the slider's degree of freedom.
  assert.equal(lampIrisPlansDifferOnlyByIntensity(draft, anchored), true);
  assert.equal(lampIrisPlansDifferOnlyByIntensity(draft, draft), true);
  const tampered = buildLampIrisPlan({
    raw: (() => {
      const raw = correctRaw();
      raw.correct[0]!.id = "reading-scan-smoothing" as never;
      raw.declined = raw.declined.filter(
        (item) => item.id !== "reading-scan-smoothing"
      );
      return raw;
    })(),
    planId: "plan-slider-1",
    runId: "run-slider-1",
    createdAt: CREATED_AT,
  });
  assert.equal(lampIrisPlansDifferOnlyByIntensity(draft, tampered), false);

  // The generation prompt renders the dialed level.
  const approvedAnchored = approveLampIrisPlan(anchored, CREATED_AT + 10);
  const rendered = initialLampIrisMegaPrompt(approvedAnchored).rendered;
  assert.match(rendered, /\[camera-axis-anchor\] intensity 3 of 3/);
  assert.doesNotMatch(rendered, /intensity 2 of 3/);

  // No-op plans have nothing to dial.
  const noOp = buildLampIrisPlan({
    raw: noOpRaw(),
    planId: "plan-slider-noop",
    runId: "run-slider-noop",
    createdAt: CREATED_AT,
  });
  assert.throws(
    () => applyLampIrisIntensityOverride(noOp, 2),
    /applies only to a correct decision/
  );
});
