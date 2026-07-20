import assert from "node:assert/strict";
import test from "node:test";

import {
  approveLampBackgroundCleanupPlan,
  createMockLampBackgroundCleanupPlan,
} from "../lib/lamp-background.ts";
import {
  applyLampBeautifyIntensityOverride,
  approveLampBeautifyPlan,
  createMockLampBeautifyPlan,
} from "../lib/lamp-beautify.ts";
import {
  applyLampIrisIntensityOverride,
  approveLampIrisPlan,
  createMockLampIrisPlan,
} from "../lib/lamp-iris.ts";
import {
  approveLampCombinedPlan,
  buildLampCombinedPlan,
} from "../lib/lamp-combined.ts";
import {
  approveLampChainPlan,
  buildLampChainPlan,
} from "../lib/lamp-chain.ts";
import {
  canAcceptMockBackgroundPlanApproval,
  canAcceptMockBeautifyPlanApproval,
  canAcceptMockChainPlanApproval,
  canAcceptMockCombinedPlanApproval,
  canAcceptMockIrisPlanApproval,
} from "../lib/mock-plan-approval.ts";

const CREATED_AT = 1_760_000_000_000;
const APPROVED_AT = CREATED_AT + 1_000;

test("mock Background approval accepts only the exact draft contract", async () => {
  const draft = createMockLampBackgroundCleanupPlan("run-bg", CREATED_AT);
  const approved = approveLampBackgroundCleanupPlan(draft, APPROVED_AT);
  assert.equal(
    await canAcceptMockBackgroundPlanApproval({
      currentPlan: draft,
      candidatePlan: approved,
      hasSpendApproval: false,
    }),
    true
  );
  assert.equal(
    await canAcceptMockBackgroundPlanApproval({
      currentPlan: draft,
      candidatePlan: { ...approved, sceneSummary: "browser tampering" },
      hasSpendApproval: false,
    }),
    false
  );
});

test("mock Beautify approval accepts its exact draft and one global intensity", async () => {
  const draft = createMockLampBeautifyPlan("run-beautify", CREATED_AT);
  const exact = approveLampBeautifyPlan(draft, APPROVED_AT);
  const globallyAdjusted = approveLampBeautifyPlan(
    applyLampBeautifyIntensityOverride(draft, 3),
    APPROVED_AT
  );
  for (const candidatePlan of [exact, globallyAdjusted]) {
    assert.equal(
      await canAcceptMockBeautifyPlanApproval({
        currentPlan: draft,
        candidatePlan,
        hasSpendApproval: false,
      }),
      true
    );
  }
});

test("mock Beautify approval rejects mixed sliders and changed plan content", async () => {
  const draft = createMockLampBeautifyPlan("run-beautify", CREATED_AT);
  const mixed = approveLampBeautifyPlan(
    {
      ...draft,
      enhance: draft.enhance.map((item, index) => ({
        ...item,
        intensity: (index === 0 ? 1 : 3) as 1 | 3,
      })),
    },
    APPROVED_AT
  );
  const changed = approveLampBeautifyPlan(
    { ...draft, subjectSummary: `${draft.subjectSummary} Browser rewrite.` },
    APPROVED_AT
  );
  for (const candidatePlan of [mixed, changed]) {
    assert.equal(
      await canAcceptMockBeautifyPlanApproval({
        currentPlan: draft,
        candidatePlan,
        hasSpendApproval: false,
      }),
      false
    );
  }
});

test("mock Iris approval accepts its exact draft and fixed global intensity", async () => {
  const draft = createMockLampIrisPlan("run-iris", CREATED_AT);
  const exact = approveLampIrisPlan(draft, APPROVED_AT);
  const presenterTwo = approveLampIrisPlan(
    applyLampIrisIntensityOverride(draft, 2),
    APPROVED_AT
  );
  for (const candidatePlan of [exact, presenterTwo]) {
    assert.equal(
      await canAcceptMockIrisPlanApproval({
        currentPlan: draft,
        candidatePlan,
        hasSpendApproval: false,
      }),
      true
    );
  }
});

test("mock Combined approval accepts only one exact aggregate approval", async () => {
  const runId = "run-combined";
  const draft = buildLampCombinedPlan({
    planId: "lamp-combined-plan-run-combined",
    runId,
    createdAt: CREATED_AT,
    controls: {
      beautifyLevel: 2,
      cleanlinessLevel: 3,
      eyeContact: true,
    },
    backgroundPlan: createMockLampBackgroundCleanupPlan(runId, CREATED_AT),
    beautifyPlan: createMockLampBeautifyPlan(runId, CREATED_AT),
    irisPlan: createMockLampIrisPlan(runId, CREATED_AT),
  });
  const approved = approveLampCombinedPlan(draft, APPROVED_AT);
  assert.equal(
    await canAcceptMockCombinedPlanApproval({
      currentPlan: draft,
      candidatePlan: approved,
      hasSpendApproval: false,
    }),
    true
  );
  assert.equal(
    await canAcceptMockCombinedPlanApproval({
      currentPlan: draft,
      candidatePlan: {
        ...approved,
        controls: { ...approved.controls, cleanlinessLevel: 1 },
      },
      hasSpendApproval: false,
    }),
    false
  );
});

test("mock Chain approval accepts only the exact order-bearing draft", async () => {
  const runId = "run-chain";
  const draft = buildLampChainPlan({
    planId: "lamp-chain-plan-run-chain",
    runId,
    createdAt: CREATED_AT,
    controls: {
      beautifyLevel: 0,
      cleanlinessLevel: 2,
      eyeContact: false,
      stageOrder: ["background", "lamp"],
    },
    backgroundPlan: createMockLampBackgroundCleanupPlan(runId, CREATED_AT),
  });
  const approved = approveLampChainPlan(draft, APPROVED_AT);
  assert.equal(
    await canAcceptMockChainPlanApproval({
      currentPlan: draft,
      candidatePlan: approved,
      hasSpendApproval: false,
    }),
    true
  );
  // Stage order is approved identity: reordering invalidates the transition.
  assert.equal(
    await canAcceptMockChainPlanApproval({
      currentPlan: draft,
      candidatePlan: { ...approved, stageOrder: ["lamp", "background"] },
      hasSpendApproval: false,
    }),
    false
  );
  // Replaying an already-approved plan is not a draft transition.
  assert.equal(
    await canAcceptMockChainPlanApproval({
      currentPlan: approved,
      candidatePlan: approved,
      hasSpendApproval: false,
    }),
    false
  );
});

test("all browser PUT fixture exceptions close once spend is authorized", async () => {
  const background = createMockLampBackgroundCleanupPlan("run-bg", CREATED_AT);
  const beautify = createMockLampBeautifyPlan("run-beautify", CREATED_AT);
  const iris = createMockLampIrisPlan("run-iris", CREATED_AT);
  const combined = buildLampCombinedPlan({
    planId: "lamp-combined-plan-run-combined-spend",
    runId: "run-combined-spend",
    createdAt: CREATED_AT,
    controls: {
      beautifyLevel: 0,
      cleanlinessLevel: 2,
      eyeContact: false,
    },
    backgroundPlan: createMockLampBackgroundCleanupPlan(
      "run-combined-spend",
      CREATED_AT
    ),
  });
  const chain = buildLampChainPlan({
    planId: "lamp-chain-plan-run-chain-spend",
    runId: "run-chain-spend",
    createdAt: CREATED_AT,
    controls: {
      beautifyLevel: 0,
      cleanlinessLevel: 2,
      eyeContact: false,
      stageOrder: ["background", "lamp"],
    },
    backgroundPlan: createMockLampBackgroundCleanupPlan(
      "run-chain-spend",
      CREATED_AT
    ),
  });
  const inputs = [
    canAcceptMockBackgroundPlanApproval({
      currentPlan: background,
      candidatePlan: approveLampBackgroundCleanupPlan(background, APPROVED_AT),
      hasSpendApproval: true,
    }),
    canAcceptMockBeautifyPlanApproval({
      currentPlan: beautify,
      candidatePlan: approveLampBeautifyPlan(beautify, APPROVED_AT),
      hasSpendApproval: true,
    }),
    canAcceptMockIrisPlanApproval({
      currentPlan: iris,
      candidatePlan: approveLampIrisPlan(iris, APPROVED_AT),
      hasSpendApproval: true,
    }),
    canAcceptMockCombinedPlanApproval({
      currentPlan: combined,
      candidatePlan: approveLampCombinedPlan(combined, APPROVED_AT),
      hasSpendApproval: true,
    }),
    canAcceptMockChainPlanApproval({
      currentPlan: chain,
      candidatePlan: approveLampChainPlan(chain, APPROVED_AT),
      hasSpendApproval: true,
    }),
  ];
  assert.deepEqual(
    await Promise.all(inputs),
    [false, false, false, false, false]
  );
});

test("malformed browser plan data fails closed", async () => {
  assert.deepEqual(
    await Promise.all([
      canAcceptMockBackgroundPlanApproval({
        currentPlan: {},
        candidatePlan: {},
        hasSpendApproval: false,
      }),
      canAcceptMockBeautifyPlanApproval({
        currentPlan: {},
        candidatePlan: {},
        hasSpendApproval: false,
      }),
      canAcceptMockIrisPlanApproval({
        currentPlan: {},
        candidatePlan: {},
        hasSpendApproval: false,
      }),
      canAcceptMockCombinedPlanApproval({
        currentPlan: {},
        candidatePlan: {},
        hasSpendApproval: false,
      }),
      canAcceptMockChainPlanApproval({
        currentPlan: {},
        candidatePlan: {},
        hasSpendApproval: false,
      }),
    ]),
    [false, false, false, false, false]
  );
});
