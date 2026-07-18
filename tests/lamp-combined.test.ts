import assert from "node:assert/strict";
import test from "node:test";

import { COMBINED_WORKFLOW } from "../lib/combined-workflow-def.ts";
import {
  approveLampCombinedPlan,
  assertLampCombinedGradeTarget,
  assertLampCombinedPlanBinding,
  buildLampCombinedPlan,
  chooseLampCombinedWinner,
  hashLampCombinedPlan,
  lampCombinedBackgroundExecutionScope,
  lampCombinedEnabledConcerns,
  lampCombinedMayAttemptSyncRepair,
  lampCombinedRequiredPlanners,
  LAMP_COMBINED_CLEANLINESS_PROFILES,
  LAMP_COMBINED_MAX_CORRECTIONS,
  LAMP_COMBINED_PRESENTER_INTENSITY,
  parseLampCombinedPlan,
  parseLampCombinedRelightIntensity,
  selectLampCombinedCorrections,
  type LampCombinedCleanlinessLevel,
  type LampCombinedControls,
  type LampCombinedCorrectionCandidate,
  type LampCombinedDeliveryCandidate,
  type LampCombinedPlan,
} from "../lib/lamp-combined.ts";
import {
  lampCombinedEvaluationOperationId,
  lampCombinedPlanOperationIds,
  LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
  LAMP_COMBINED_BEAUTIFY_PLAN_OPERATION_ID,
  LAMP_COMBINED_IRIS_PLAN_OPERATION_ID,
} from "../lib/lamp-combined-operations.ts";
import { createMockLampBackgroundCleanupPlan } from "../lib/lamp-background.ts";
import { createMockLampBeautifyPlan } from "../lib/lamp-beautify.ts";
import { createMockLampIrisPlan } from "../lib/lamp-iris.ts";

const CREATED_AT = 1_790_000_000_000;
const RUN_ID = "run-combined-1";

const allControls: LampCombinedControls = {
  beautifyLevel: 3,
  cleanlinessLevel: 2,
  eyeContact: true,
};

function buildDraft(
  controls: LampCombinedControls = allControls,
  options: { planId?: string; runId?: string } = {}
): LampCombinedPlan {
  const runId = options.runId ?? RUN_ID;
  return buildLampCombinedPlan({
    planId: options.planId ?? "plan-combined-1",
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
}

test("disabled controls are explicit and skip their planners and paid operations", () => {
  const controls: LampCombinedControls = {
    beautifyLevel: 0,
    cleanlinessLevel: 1,
    eyeContact: false,
  };
  const plan = buildDraft(controls);

  assert.deepEqual(plan.beautify, {
    state: "disabled",
    reason: "control-off",
  });
  assert.deepEqual(plan.iris, {
    state: "disabled",
    reason: "control-off",
  });
  assert.deepEqual(lampCombinedRequiredPlanners(controls), ["background"]);
  assert.deepEqual(lampCombinedPlanOperationIds(controls), [
    LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
  ]);

  assert.throws(
    () =>
      buildLampCombinedPlan({
        planId: "invalid-extra-planner",
        runId: RUN_ID,
        createdAt: CREATED_AT,
        controls,
        backgroundPlan: createMockLampBackgroundCleanupPlan(
          RUN_ID,
          CREATED_AT
        ),
        beautifyPlan: createMockLampBeautifyPlan(RUN_ID, CREATED_AT),
      }),
    /planner must be skipped/
  );
});

test("enabled controls bind global Beautify level and fixed Presenter eye contact", () => {
  const plan = buildDraft();
  assert.equal(plan.beautify.state, "enabled");
  if (plan.beautify.state === "enabled") {
    assert.ok(plan.beautify.plan.enhance.length > 0);
    assert.ok(plan.beautify.plan.enhance.every((item) => item.intensity === 3));
  }
  assert.equal(plan.iris.state, "enabled");
  if (plan.iris.state === "enabled") {
    assert.equal(plan.iris.intensity, LAMP_COMBINED_PRESENTER_INTENSITY);
    assert.ok(
      plan.iris.plan.correct.every(
        (item) => item.intensity === LAMP_COMBINED_PRESENTER_INTENSITY
      )
    );
  }
  assert.deepEqual(lampCombinedPlanOperationIds(allControls), [
    LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
    LAMP_COMBINED_BEAUTIFY_PLAN_OPERATION_ID,
    LAMP_COMBINED_IRIS_PLAN_OPERATION_ID,
  ]);
  assert.deepEqual(lampCombinedEnabledConcerns(allControls), [
    "lighting",
    "background",
    "beautify",
    "iris",
  ]);
});

test("one approval timestamp covers the aggregate and every enabled subplan", async () => {
  const draft = buildDraft();
  const approvedAt = CREATED_AT + 1_000;
  const approved = approveLampCombinedPlan(draft, approvedAt);

  assert.deepEqual(approved.approval, {
    status: "approved",
    approvedBy: "human",
    approvedAt,
  });
  assert.equal(approved.backgroundPlan.approval.status, "approved");
  assert.equal(approved.backgroundPlan.approval.approvedAt, approvedAt);
  assert.equal(approved.beautify.state, "enabled");
  if (approved.beautify.state === "enabled") {
    assert.equal(approved.beautify.plan.approval.status, "approved");
    assert.equal(approved.beautify.plan.approval.approvedAt, approvedAt);
  }
  assert.equal(approved.iris.state, "enabled");
  if (approved.iris.state === "enabled") {
    assert.equal(approved.iris.plan.approval.status, "approved");
    assert.equal(approved.iris.plan.approval.approvedAt, approvedAt);
  }

  assert.equal(await hashLampCombinedPlan(draft), await hashLampCombinedPlan(approved));
  assert.match(await hashLampCombinedPlan(approved), /^[a-f0-9]{64}$/);

  const incoherent = structuredClone(approved);
  if (incoherent.beautify.state === "enabled") {
    incoherent.beautify.plan.approval = {
      status: "approved",
      approvedBy: "human",
      approvedAt: approvedAt + 1,
    };
  }
  assert.throws(
    () => parseLampCombinedPlan(incoherent),
    /share one human approval timestamp/
  );
});

test("aggregate binding rejects a different run or changed controls while relight stays separate", async () => {
  const plan = buildDraft();
  assert.equal("relightIntensity" in plan, false);

  assert.equal(parseLampCombinedRelightIntensity(0), 0);
  assert.equal(parseLampCombinedRelightIntensity(100), 100);
  assert.throws(() => parseLampCombinedRelightIntensity(101), /0 through 100/);

  assert.equal(
    assertLampCombinedPlanBinding(plan, {
      runId: RUN_ID,
      relightIntensity: 75,
      controls: allControls,
    }).id,
    plan.id
  );
  assert.throws(
    () =>
      assertLampCombinedPlanBinding(plan, {
        runId: "run-other",
        relightIntensity: 75,
        controls: allControls,
      }),
    /different run/
  );
  assert.throws(
    () =>
      assertLampCombinedPlanBinding(plan, {
        runId: RUN_ID,
        relightIntensity: 75,
        controls: { ...allControls, cleanlinessLevel: 3 },
      }),
    /controls no longer match/
  );

  const samePlanDifferentCleanliness = buildDraft(
    { ...allControls, cleanlinessLevel: 3 },
    { planId: plan.id }
  );
  assert.notEqual(
    await hashLampCombinedPlan(plan),
    await hashLampCombinedPlan(samePlanDifferentCleanliness)
  );
});

test("cleanliness changes execution amplitude without changing approved targets", () => {
  const scopes = ([1, 2, 3] as LampCombinedCleanlinessLevel[]).map((level) => {
    const approved = approveLampCombinedPlan(
      buildDraft(
        { beautifyLevel: 0, cleanlinessLevel: level, eyeContact: false },
        { planId: `plan-cleanliness-${level}` }
      ),
      CREATED_AT + 1_000
    );
    return lampCombinedBackgroundExecutionScope(approved);
  });

  assert.deepEqual(scopes[0]?.targetFootprints, scopes[1]?.targetFootprints);
  assert.deepEqual(scopes[1]?.targetFootprints, scopes[2]?.targetFootprints);
  assert.equal(scopes[0]?.mayAddRemovalTargets, false);
  assert.equal(scopes[2]?.mayRedecorate, false);
  assert.notEqual(scopes[0]?.executionDirective, scopes[1]?.executionDirective);
  assert.notEqual(scopes[1]?.executionDirective, scopes[2]?.executionDirective);
  assert.match(LAMP_COMBINED_CLEANLINESS_PROFILES[1].scopeRule, /same human-approved/);
  assert.match(LAMP_COMBINED_CLEANLINESS_PROFILES[3].scopeRule, /same human-approved/);
});

test("corrections prioritize hard gates, enabled-concern coverage, then stable severity with a 12 cap", () => {
  const candidates: LampCombinedCorrectionCandidate[] = [
    {
      id: "background-minor",
      concern: "background",
      severity: "minor",
      hardGate: false,
      instruction: "Finish the approved desk target.",
    },
    {
      id: "lighting-major",
      concern: "lighting",
      severity: "major",
      hardGate: false,
      instruction: "Restore the requested lighting amplitude.",
    },
    {
      id: "beautify-critical",
      concern: "beautify",
      severity: "critical",
      hardGate: false,
      instruction: "Restore the approved facial-zone treatment.",
    },
    {
      id: "iris-major",
      concern: "iris",
      severity: "major",
      hardGate: false,
      instruction: "Hold Presenter eye contact naturally.",
    },
    {
      id: "hard-minor",
      concern: "preservation",
      severity: "minor",
      hardGate: true,
      instruction: "Restore the source wardrobe.",
    },
    {
      id: "hard-critical",
      concern: "audio-sync",
      severity: "critical",
      hardGate: true,
      instruction: "Restore source-synchronous mouth timing.",
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `filler-${index}`,
      concern: "preservation" as const,
      severity: (index < 4 ? "critical" : index < 8 ? "major" : "minor") as
        | "critical"
        | "major"
        | "minor",
      hardGate: false,
      instruction: `Stable filler correction ${index}.`,
    })),
  ];

  const selected = selectLampCombinedCorrections(candidates, allControls);
  assert.equal(selected.length, LAMP_COMBINED_MAX_CORRECTIONS);
  assert.deepEqual(
    selected.slice(0, 6).map((candidate) => candidate.id),
    [
      "hard-critical",
      "hard-minor",
      "lighting-major",
      "background-minor",
      "beautify-critical",
      "iris-major",
    ]
  );
  assert.deepEqual(
    selected.slice(6, 10).map((candidate) => candidate.id),
    ["filler-0", "filler-1", "filler-2", "filler-3"]
  );

  const withDuplicate = selectLampCombinedCorrections(
    [...candidates, candidates[0]!],
    allControls
  );
  assert.equal(
    withDuplicate.filter((candidate) => candidate.id === "background-minor")
      .length,
    1
  );
});

test("a failed v1 sync verdict makes v1 ineligible and only v2 gets one repair chance", () => {
  const candidates: LampCombinedDeliveryCandidate[] = [
    {
      iteration: 1,
      generationComplete: true,
      audioStatus: "verified",
      syncStatus: "fail",
      evaluationComplete: true,
    },
    {
      iteration: 2,
      generationComplete: true,
      audioStatus: "verified",
      syncStatus: "pass",
      evaluationComplete: true,
    },
  ];

  assert.throws(
    () =>
      chooseLampCombinedWinner(candidates, {
        iteration: 1,
        chosenAt: CREATED_AT + 2_000,
        chosenBy: "human",
      }),
    /sync-failed/
  );
  const winner = chooseLampCombinedWinner(candidates, {
    iteration: 2,
    chosenAt: CREATED_AT + 2_000,
    chosenBy: "human",
  });
  assert.deepEqual(winner, {
    iteration: 2,
    chosenAt: CREATED_AT + 2_000,
    chosenBy: "human",
  });
  assert.throws(() => assertLampCombinedGradeTarget(winner, 1), /Only the human-selected/);
  assert.doesNotThrow(() => assertLampCombinedGradeTarget(winner, 2));
  assert.equal(
    lampCombinedMayAttemptSyncRepair({
      iteration: 1,
      previousRepairAttempts: 0,
    }),
    false
  );
  assert.equal(
    lampCombinedMayAttemptSyncRepair({
      iteration: 2,
      previousRepairAttempts: 0,
    }),
    true
  );
  assert.equal(
    lampCombinedMayAttemptSyncRepair({
      iteration: 2,
      previousRepairAttempts: 1,
    }),
    false
  );
});

test("the five-stage workflow keeps both generations rooted in the source", () => {
  assert.equal(COMBINED_WORKFLOW.nodes.length, 5);
  assert.equal(COMBINED_WORKFLOW.edges.length, 4);
  assert.deepEqual(
    COMBINED_WORKFLOW.nodes.map((node) => node.id),
    ["plan", "initial", "critique", "final", "review"]
  );
  assert.equal(COMBINED_WORKFLOW.config.maxIterations, 2);
  assert.match(
    COMBINED_WORKFLOW.nodes.find((node) => node.id === "initial")!.description,
    /immutable source/
  );
  assert.match(
    COMBINED_WORKFLOW.nodes.find((node) => node.id === "final")!.description,
    /same immutable source/
  );
  assert.match(
    COMBINED_WORKFLOW.nodes.find((node) => node.id === "review")!.description,
    /grades only that chosen take/
  );
  assert.equal(
    lampCombinedEvaluationOperationId(1),
    "judge:1:lamp-combined-holistic:gemini"
  );
  assert.equal(
    lampCombinedEvaluationOperationId(2),
    "judge:2:lamp-combined-holistic:gemini"
  );
});
