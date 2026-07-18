import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLampCombinedPlan,
  hashLampCombinedPlan,
  type LampCombinedControls,
} from "../lib/lamp-combined.ts";
import { createMockLampBackgroundCleanupPlan } from "../lib/lamp-background.ts";
import { createMockLampBeautifyPlan } from "../lib/lamp-beautify.ts";
import { createMockLampIrisPlan } from "../lib/lamp-iris.ts";
import { approveLampCombinedPlanForRun } from "../lib/server/lamp-combined-approval.ts";
import type { Run, VideoAsset } from "../lib/types.ts";

const RUN_ID = "run_combined_approval";
const CREATED_AT = 1_800_200_000_000;
const CONTROLS: LampCombinedControls = {
  beautifyLevel: 2,
  cleanlinessLevel: 3,
  eyeContact: true,
};

function fixture(): Run {
  const source: VideoAsset = {
    id: "video_combined_approval",
    runId: RUN_ID,
    kind: "original",
    url: `/api/media/${RUN_ID}/source.mp4`,
    label: "Combined approval fixture",
    durationSec: 8,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
  const combinedPlan = buildLampCombinedPlan({
    planId: "lamp-combined-plan-approval",
    runId: RUN_ID,
    createdAt: CREATED_AT,
    controls: CONTROLS,
    backgroundPlan: createMockLampBackgroundCleanupPlan(RUN_ID, CREATED_AT),
    beautifyPlan: createMockLampBeautifyPlan(RUN_ID, CREATED_AT),
    irisPlan: createMockLampIrisPlan(RUN_ID, CREATED_AT),
  });
  return {
    id: RUN_ID,
    workflowId: "lamp-combined-v1",
    workflowMode: "combined",
    combinedControls: CONTROLS,
    combinedPlan,
    relightIntensity: 75,
    createdAt: CREATED_AT,
    originalVideo: source,
    status: "running",
    iterations: [],
    nodeStates: {},
    log: [],
  };
}

test("one Combined approval atomically stamps the aggregate and every enabled subplan", async () => {
  const run = fixture();
  const planHash = await hashLampCombinedPlan(run.combinedPlan!);
  const approvedAt = CREATED_AT + 10_000;
  const result = await approveLampCombinedPlanForRun({
    run,
    presentedPlanHash: planHash,
    presentedControls: CONTROLS,
    presentedRelightIntensity: 75,
    approvedAt,
  });

  assert.equal(result.alreadyApproved, false);
  assert.equal(result.approvedPlan.approval.status, "approved");
  assert.equal(result.approvedPlan.approval.approvedAt, approvedAt);
  assert.equal(result.approvedPlan.backgroundPlan.approval.status, "approved");
  assert.equal(result.approvedPlan.backgroundPlan.approval.approvedAt, approvedAt);
  assert.equal(result.approvedPlan.beautify.state, "enabled");
  assert.equal(result.approvedPlan.iris.state, "enabled");
  if (result.approvedPlan.beautify.state === "enabled") {
    assert.equal(result.approvedPlan.beautify.plan.approval.status, "approved");
    assert.equal(
      result.approvedPlan.beautify.plan.approval.approvedAt,
      approvedAt
    );
  }
  if (result.approvedPlan.iris.state === "enabled") {
    assert.equal(result.approvedPlan.iris.plan.approval.status, "approved");
    assert.equal(result.approvedPlan.iris.plan.approval.approvedAt, approvedAt);
  }
  assert.equal(result.relightIntensity, 75);
  assert.equal(result.plannerOperationIds.length, 3);
});

test("retrying the exact approved hash is idempotent and cannot restamp approval time", async () => {
  const original = fixture();
  const planHash = await hashLampCombinedPlan(original.combinedPlan!);
  const first = await approveLampCombinedPlanForRun({
    run: original,
    presentedPlanHash: planHash,
    presentedControls: CONTROLS,
    presentedRelightIntensity: 75,
    approvedAt: CREATED_AT + 10_000,
  });
  const retried = await approveLampCombinedPlanForRun({
    run: { ...original, combinedPlan: first.approvedPlan },
    presentedPlanHash: planHash,
    presentedControls: CONTROLS,
    presentedRelightIntensity: 75,
    approvedAt: CREATED_AT + 20_000,
  });
  assert.equal(retried.alreadyApproved, true);
  assert.deepEqual(retried.approvedPlan, first.approvedPlan);
  assert.equal(retried.approvedPlan.approval.status, "approved");
  assert.equal(
    retried.approvedPlan.approval.approvedAt,
    CREATED_AT + 10_000
  );
});

test("Combined approval rejects plan, control, and relight tampering", async () => {
  const run = fixture();
  const planHash = await hashLampCombinedPlan(run.combinedPlan!);
  await assert.rejects(
    () =>
      approveLampCombinedPlanForRun({
        run,
        presentedPlanHash: "0".repeat(64),
        presentedControls: CONTROLS,
        presentedRelightIntensity: 75,
        approvedAt: CREATED_AT + 1,
      }),
    /plan changed before approval/
  );
  await assert.rejects(
    () =>
      approveLampCombinedPlanForRun({
        run,
        presentedPlanHash: planHash,
        presentedControls: { ...CONTROLS, eyeContact: false },
        presentedRelightIntensity: 75,
        approvedAt: CREATED_AT + 1,
      }),
    /controls changed after planning/
  );
  await assert.rejects(
    () =>
      approveLampCombinedPlanForRun({
        run,
        presentedPlanHash: planHash,
        presentedControls: CONTROLS,
        presentedRelightIntensity: 80,
        approvedAt: CREATED_AT + 1,
      }),
    /relight intensity changed after planning/
  );
});
