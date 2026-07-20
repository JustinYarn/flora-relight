import assert from "node:assert/strict";
import test from "node:test";

import {
  approveLampChainPlan,
  assertLampChainPlanBinding,
  buildLampChainPlan,
  defaultLampChainStageOrder,
  hashLampChainPlan,
  lampChainConcernsAfterStage,
  lampChainDeliveryIneligibility,
  lampChainEnabledStages,
  parseLampChainControls,
  parseLampChainPlan,
  parseLampChainStageOrder,
  LAMP_CHAIN_DEFAULT_STAGE_ORDER,
  type LampChainControls,
  type LampChainPlan,
  type LampChainStage,
} from "../lib/lamp-chain.ts";
import {
  lampChainEvaluationOperationId,
  lampChainPlanOperationIds,
} from "../lib/lamp-chain-operations.ts";
import {
  buildLampChainEvaluationArtifact,
  lampChainEvalDefinitions,
  lampChainStageComposite,
  parseLampChainEvaluationArtifact,
  LAMP_CHAIN_VISUAL_EVAL_IDS,
} from "../lib/lamp-chain-evaluation.ts";
import {
  buildLampChainPromptEnvelope,
  compileLampChainStagePrompts,
  isPersistedLampChainStagePrompt,
  parseLampChainPromptEnvelope,
  LAMP_CHAIN_CLEANLINESS_HEADING,
} from "../lib/prompts/lamp-chain.ts";
import { initialMegaPrompt } from "../lib/prompts/mega-prompt.ts";
import { initialLampBeautifyMegaPrompt } from "../lib/prompts/lamp-beautify.ts";
import { initialLampIrisMegaPrompt } from "../lib/prompts/lamp-iris.ts";
import { createMockLampBackgroundCleanupPlan } from "../lib/lamp-background.ts";
import { createMockLampBeautifyPlan } from "../lib/lamp-beautify.ts";
import { createMockLampIrisPlan } from "../lib/lamp-iris.ts";

const CREATED_AT = 1_790_000_000_000;
const APPROVED_AT = CREATED_AT + 60_000;
const RUN_ID = "run-chain-1";

const ALL_CONTROLS: LampChainControls = {
  beautifyLevel: 2,
  cleanlinessLevel: 3,
  eyeContact: true,
  stageOrder: ["background", "lamp", "beautify", "iris"],
};

const MINIMAL_CONTROLS: LampChainControls = {
  beautifyLevel: 0,
  cleanlinessLevel: 2,
  eyeContact: false,
  stageOrder: ["background", "lamp"],
};

function buildDraft(
  controls: LampChainControls = ALL_CONTROLS,
  options: { planId?: string; runId?: string } = {}
): LampChainPlan {
  const runId = options.runId ?? RUN_ID;
  return buildLampChainPlan({
    planId: options.planId ?? "plan-chain-1",
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

function approved(controls: LampChainControls = ALL_CONTROLS): LampChainPlan {
  return approveLampChainPlan(buildDraft(controls), APPROVED_AT);
}

test("stage order must be an exact permutation of the enabled stages", () => {
  assert.deepEqual(lampChainEnabledStages(MINIMAL_CONTROLS), [
    "background",
    "lamp",
  ]);
  assert.deepEqual(defaultLampChainStageOrder(ALL_CONTROLS), [
    ...LAMP_CHAIN_DEFAULT_STAGE_ORDER,
  ]);
  // Reordering is legal.
  assert.deepEqual(
    parseLampChainStageOrder(["lamp", "background"], MINIMAL_CONTROLS),
    ["lamp", "background"]
  );
  // A disabled stage cannot appear.
  assert.throws(() =>
    parseLampChainStageOrder(["background", "lamp", "iris"], MINIMAL_CONTROLS)
  );
  // An enabled stage cannot be missing or repeated.
  assert.throws(() =>
    parseLampChainStageOrder(["background"], MINIMAL_CONTROLS)
  );
  assert.throws(() =>
    parseLampChainStageOrder(["lamp", "lamp"], MINIMAL_CONTROLS)
  );
  assert.throws(() =>
    parseLampChainControls({ ...ALL_CONTROLS, stageOrder: ["background"] })
  );
});

test("chain planners mirror Combined and stage order changes the plan hash", async () => {
  assert.deepEqual(lampChainPlanOperationIds(MINIMAL_CONTROLS), [
    "plan:lamp-chain:background:gemini",
  ]);
  assert.deepEqual(lampChainPlanOperationIds(ALL_CONTROLS), [
    "plan:lamp-chain:background:gemini",
    "plan:lamp-chain:beautify:gemini",
    "plan:lamp-chain:iris:gemini",
  ]);

  const forward = approved();
  const reversed = approveLampChainPlan(
    parseLampChainPlan({
      ...buildDraft(),
      stageOrder: ["iris", "beautify", "lamp", "background"],
    }),
    APPROVED_AT
  );
  const forwardHash = await hashLampChainPlan(forward);
  const reversedHash = await hashLampChainPlan(reversed);
  assert.notEqual(
    forwardHash,
    reversedHash,
    "a reordered chain must present a different approval hash"
  );
});

test("binding validates run id, controls triple, and exact stage order", () => {
  const plan = approved();
  assertLampChainPlanBinding(plan, {
    runId: RUN_ID,
    relightIntensity: 75,
    controls: ALL_CONTROLS,
  });
  assert.throws(() =>
    assertLampChainPlanBinding(plan, {
      runId: "other-run",
      relightIntensity: 75,
      controls: ALL_CONTROLS,
    })
  );
  assert.throws(() =>
    assertLampChainPlanBinding(plan, {
      runId: RUN_ID,
      relightIntensity: 75,
      controls: {
        ...ALL_CONTROLS,
        stageOrder: ["lamp", "background", "beautify", "iris"],
      },
    })
  );
});

test("cumulative concerns follow the approved order", () => {
  const order: LampChainStage[] = ["lamp", "background", "iris", "beautify"];
  assert.deepEqual(lampChainConcernsAfterStage(order, 0), ["lighting"]);
  assert.deepEqual(lampChainConcernsAfterStage(order, 2), [
    "lighting",
    "background",
    "iris",
  ]);
  assert.throws(() => lampChainConcernsAfterStage(order, 4));
});

test("delivery needs contiguous structural proof and verified audio only", () => {
  const order: LampChainStage[] = ["background", "lamp"];
  const proof = (stage: number, ok = true) => ({
    stage: order[stage - 1]!,
    iteration: stage,
    generationComplete: ok,
    audioStatus: "verified" as const,
  });
  assert.equal(
    lampChainDeliveryIneligibility([proof(1), proof(2)], order),
    null
  );
  assert.deepEqual(lampChainDeliveryIneligibility([proof(1)], order), {
    kind: "stage-generation-incomplete",
    stage: "lamp",
    iteration: 2,
  });
  assert.deepEqual(
    lampChainDeliveryIneligibility(
      [proof(1), { ...proof(2), audioStatus: "unverified" as const }],
      order
    ),
    { kind: "stage-audio-unverified", stage: "lamp", iteration: 2 }
  );
});

test("stage prompts are byte-identical to their standalone modes", () => {
  const plan = approved();
  const prompts = compileLampChainStagePrompts(plan, 75);
  assert.equal(prompts.length, 4);

  const lampStage = prompts.find((prompt) => prompt.stageKind === "lamp")!;
  assert.equal(lampStage.rendered, initialMegaPrompt("lamp", 75).rendered);

  const beautifyStage = prompts.find(
    (prompt) => prompt.stageKind === "beautify"
  )!;
  assert.equal(
    beautifyStage.rendered,
    plan.aggregate.beautify.state === "enabled"
      ? initialLampBeautifyMegaPrompt(plan.aggregate.beautify.plan).rendered
      : "unreachable"
  );

  const irisStage = prompts.find((prompt) => prompt.stageKind === "iris")!;
  assert.equal(
    irisStage.rendered,
    plan.aggregate.iris.state === "enabled"
      ? initialLampIrisMegaPrompt(plan.aggregate.iris.plan).rendered
      : "unreachable"
  );

  // Background is standalone plus exactly one appended cleanliness block.
  const backgroundStage = prompts.find(
    (prompt) => prompt.stageKind === "background"
  )!;
  assert.ok(backgroundStage.rendered.includes(LAMP_CHAIN_CLEANLINESS_HEADING));
  assert.ok(
    isPersistedLampChainStagePrompt(plan, 75, backgroundStage.stage, backgroundStage.rendered)
  );
  assert.ok(
    !isPersistedLampChainStagePrompt(
      plan,
      75,
      backgroundStage.stage,
      backgroundStage.rendered + " tampered"
    )
  );
});

test("the prompt envelope freezes every stage and rejects drift", () => {
  const plan = approved();
  const envelope = buildLampChainPromptEnvelope(plan, 75);
  const restored = parseLampChainPromptEnvelope(
    JSON.parse(JSON.stringify(envelope)),
    { plan, relightIntensity: 75 }
  );
  assert.equal(restored.stagePrompts.length, 4);
  const tampered = JSON.parse(JSON.stringify(envelope)) as {
    stagePrompts: Array<{ rendered: string }>;
  };
  tampered.stagePrompts[1]!.rendered += "\nEXTRA";
  assert.throws(() =>
    parseLampChainPromptEnvelope(tampered, { plan, relightIntensity: 75 })
  );
  assert.throws(() =>
    parseLampChainPromptEnvelope(envelope, { plan, relightIntensity: 80 })
  );
});

test("pending concerns judge as hard preservation gates until their stage runs", () => {
  const plan = approved(); // background → lamp → beautify → iris
  const stage1 = lampChainEvalDefinitions(plan, 1);
  const lightingAtStage1 = stage1.find((d) => d.id === "lighting-target")!;
  assert.equal(lightingAtStage1.contract, "preservation");
  assert.equal(lightingAtStage1.hardGate, true);
  const backgroundAtStage1 = stage1.find(
    (d) => d.id === "background-cleanliness"
  )!;
  assert.equal(backgroundAtStage1.contract, "target");

  const stage2 = lampChainEvalDefinitions(plan, 2);
  assert.equal(stage2.find((d) => d.id === "lighting-target")!.contract, "target");
  assert.equal(
    stage2.find((d) => d.id === "beautify-target")!.contract,
    "preservation"
  );

  const finalStage = lampChainEvalDefinitions(plan, 4);
  for (const id of [
    "background-cleanliness",
    "lighting-target",
    "beautify-target",
    "eye-contact",
  ] as const) {
    assert.equal(finalStage.find((d) => d.id === id)!.contract, "target");
  }
});

test("evaluation artifacts bind the order-bearing hash and carry the drift trajectory", async () => {
  const plan = approved(MINIMAL_CONTROLS);
  const raw = (base: number) => ({
    results: LAMP_CHAIN_VISUAL_EVAL_IDS.map((evalId) => ({
      evalId,
      score: base,
      confidence: 0.9,
      violations: [],
      reasoning: "test",
    })),
  });
  const first = await buildLampChainEvaluationArtifact({
    raw: raw(90),
    plan,
    stage: 1,
    audioVerified: true,
  });
  assert.equal(first.stageCount, 2);
  assert.deepEqual(first.completedConcerns, ["background"]);
  const second = await buildLampChainEvaluationArtifact({
    raw: raw(86),
    plan,
    stage: 2,
    audioVerified: true,
    previousArtifact: first,
  });
  const identity = second.evalResults.find((r) => r.evalId === "identity")!;
  assert.equal(identity.deltaFromPrevious, -4);

  const restored = await parseLampChainEvaluationArtifact(
    JSON.parse(JSON.stringify(second)),
    { plan, stage: 2 }
  );
  assert.equal(restored.stage, 2);
  const composite = lampChainStageComposite(restored);
  assert.ok(composite.composite > 0);

  // The artifact must not replay against a reordered plan.
  const reordered = approveLampChainPlan(
    parseLampChainPlan({
      ...buildDraft(MINIMAL_CONTROLS),
      stageOrder: ["lamp", "background"],
    }),
    APPROVED_AT
  );
  await assert.rejects(
    parseLampChainEvaluationArtifact(JSON.parse(JSON.stringify(second)), {
      plan: reordered,
      stage: 2,
    })
  );
});

test("evaluation operation ids are stage-scoped", () => {
  assert.equal(
    lampChainEvaluationOperationId(3),
    "judge:3:lamp-chain-holistic:gemini"
  );
  assert.throws(() => lampChainEvaluationOperationId(5));
  assert.throws(() => lampChainEvaluationOperationId(0));
});
