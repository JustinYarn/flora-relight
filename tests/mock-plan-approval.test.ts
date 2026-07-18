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
  canAcceptMockBackgroundPlanApproval,
  canAcceptMockBeautifyPlanApproval,
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

test("all browser PUT fixture exceptions close once spend is authorized", async () => {
  const background = createMockLampBackgroundCleanupPlan("run-bg", CREATED_AT);
  const beautify = createMockLampBeautifyPlan("run-beautify", CREATED_AT);
  const iris = createMockLampIrisPlan("run-iris", CREATED_AT);
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
  ];
  assert.deepEqual(await Promise.all(inputs), [false, false, false]);
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
    ]),
    [false, false, false]
  );
});
