import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WORKFLOW_MODE,
  floraRetiredForNewWork,
  isApprovedPlanNoOp,
  isPlanWorkflowMode,
  isTwoPassWorkflowMode,
  parseSelectableWorkflowMode,
  parseWorkflowMode,
  runHasStartedWork,
  runWorkflowMode,
  workflowModeFromExecutionId,
  workflowModeLabel,
  workflowOutputLabel,
} from "../lib/workflow-mode.ts";
import {
  initialMegaPrompt,
  nextMegaPrompt,
  renderMegaPrompt,
} from "../lib/prompts/mega-prompt.ts";
import { mergeBatch } from "../lib/server/storage/batch-merge.ts";
import type { Batch, Run } from "../lib/types.ts";
import {
  RELIGHT_WORKFLOW,
  workflowForMode,
} from "../lib/workflow-def.ts";
import { buildRun } from "../lib/run-factory.ts";
import type { VideoAsset } from "../lib/types.ts";

test("workflow mode accepts the current mode plus both historical product modes", () => {
  assert.equal(parseWorkflowMode("flora"), "flora");
  assert.equal(parseWorkflowMode("lamp"), "lamp");
  assert.equal(parseWorkflowMode("background"), "background");
  assert.equal(parseWorkflowMode("iris"), "iris");
  assert.equal(parseWorkflowMode("combined"), "combined");
  assert.equal(parseWorkflowMode("live"), null);
  assert.equal(parseWorkflowMode(undefined), null);
});

test("new browser selections default to Lamp and retain historical labels", () => {
  assert.equal(DEFAULT_WORKFLOW_MODE, "lamp");
  assert.equal(RELIGHT_WORKFLOW.id, workflowForMode("lamp").id);
  assert.equal(workflowModeLabel("flora"), "Flora");
  assert.equal(workflowModeLabel("lamp"), "Lamp");
  assert.equal(workflowModeLabel("background"), "Lamp Background");
  assert.equal(workflowModeLabel("beautify"), "Lamp Beautify");
  assert.equal(workflowModeLabel("iris"), "Lamp Iris");
  assert.equal(workflowModeLabel("combined"), "Lamp Combined");
  assert.equal(workflowOutputLabel("lamp"), "RELIT");
  assert.equal(workflowOutputLabel("background"), "CLEANED");
  assert.equal(workflowOutputLabel("beautify"), "ENHANCED");
  assert.equal(workflowOutputLabel("iris"), "GAZE-CORRECTED");
  assert.equal(workflowOutputLabel("combined"), "FINISHED");
});

test("Combined run construction freezes the exact selected relight strength", () => {
  const video = {
    id: "video-combined",
    runId: "run-combined",
    kind: "original",
    url: "/api/media/run-combined/original.mp4",
    label: "combined-source.mp4",
    durationSec: 10,
    width: 1920,
    height: 1080,
    hasAudio: true,
  } satisfies VideoAsset;

  assert.equal(buildRun(video, 1, "combined", 25).relightIntensity, 25);
  assert.equal(buildRun(video, 1, "combined", 100).relightIntensity, 100);
  assert.equal(buildRun(video, 1, "background", 25).relightIntensity, undefined);
});

test("the saved new-run preference can never resurrect legacy Flora", () => {
  assert.equal(parseSelectableWorkflowMode("lamp"), "lamp");
  assert.equal(parseSelectableWorkflowMode("background"), "background");
  assert.equal(parseSelectableWorkflowMode("beautify"), "beautify");
  assert.equal(parseSelectableWorkflowMode("iris"), "iris");
  assert.equal(parseSelectableWorkflowMode("combined"), "combined");
  assert.equal(parseSelectableWorkflowMode("flora"), null);
  assert.equal(parseSelectableWorkflowMode("combo"), null);
});

test("plan-mode helpers cover Background, Beautify, and Iris symmetrically", () => {
  assert.equal(isPlanWorkflowMode("lamp"), false);
  assert.equal(isPlanWorkflowMode("background"), true);
  assert.equal(isPlanWorkflowMode("beautify"), true);
  assert.equal(isPlanWorkflowMode("iris"), true);

  const base = {
    id: "run-plan-noop",
    workflowId: "lamp-v1",
    createdAt: 1,
    originalVideo: {},
    status: "awaiting-review",
    iterations: [],
    nodeStates: {},
    log: [],
  } as unknown as Run;
  const approval = {
    status: "approved" as const,
    approvedAt: 2,
    approvedBy: "human" as const,
  };

  assert.equal(
    isApprovedPlanNoOp({
      ...base,
      workflowMode: "background",
      backgroundCleanupPlan: {
        runId: base.id,
        approval,
        decision: "exceptional-no-op",
      } as never,
    }),
    true
  );
  assert.equal(
    isApprovedPlanNoOp({
      ...base,
      workflowMode: "beautify",
      beautifyPlan: {
        runId: base.id,
        approval,
        decision: "exceptional-no-op",
      } as never,
    }),
    true
  );
  assert.equal(
    isApprovedPlanNoOp({
      ...base,
      workflowMode: "iris",
      irisPlan: {
        runId: base.id,
        approval,
        decision: "exceptional-no-op",
      } as never,
    }),
    true
  );
  assert.equal(
    isApprovedPlanNoOp({
      ...base,
      workflowMode: "iris",
      irisPlan: {
        runId: "another-run",
        approval,
        decision: "exceptional-no-op",
      } as never,
    }),
    false
  );
});

test("Lamp Iris joins the fixed two-pass plumbing end to end", () => {
  assert.equal(isTwoPassWorkflowMode("iris"), true);
  assert.equal(isTwoPassWorkflowMode("combined"), true);
  assert.equal(
    workflowModeFromExecutionId("lamp-combined:run-x"),
    "combined"
  );
  assert.equal(
    runWorkflowMode({ workflowId: "lamp-combined-v1" }),
    "combined"
  );
  assert.equal(workflowForMode("combined").id, "lamp-combined-v1");
  assert.equal(workflowModeFromExecutionId("lamp-iris:run-x"), "iris");
  assert.equal(workflowModeFromExecutionId("lamp-iris-batch:batch-x"), "iris");
  assert.equal(runWorkflowMode({ workflowId: "lamp-iris-v1" }), "iris");
  assert.equal(workflowForMode("iris").id, "lamp-iris-v1");
});

test("Lamp Background graph is the approved plan-to-blind-grade sequence", () => {
  const background = workflowForMode("background");
  assert.equal(background.id, "lamp-background-v1");
  assert.deepEqual(
    background.nodes.map((node) => node.id),
    ["plan", "initial", "critique", "final", "review"]
  );
  assert.deepEqual(
    background.edges.map((edge) => [edge.source, edge.target]),
    [
      ["plan", "initial"],
      ["initial", "critique"],
      ["critique", "final"],
      ["final", "review"],
    ]
  );
  assert.equal(background.config.maxIterations, 2);
});

test("historical Lamp and Flora graphs retain their original evaluation sets", () => {
  const lampEvalIds = workflowForMode("lamp").nodes.flatMap((node) =>
    node.evalId ? [node.evalId] : []
  );
  assert.equal(lampEvalIds.length, 9);
  assert.equal(lampEvalIds.includes("temporal-alignment"), false);
  assert.equal(lampEvalIds.includes("lighting-match-to-anchor"), false);

  const floraEvalIds = workflowForMode("flora").nodes.flatMap((node) =>
    node.evalId ? [node.evalId] : []
  );
  assert.equal(floraEvalIds.includes("temporal-alignment"), true);
  assert.equal(floraEvalIds.includes("lighting-match-to-anchor"), true);
});

test("Flora and Lamp prompts preserve method labels without changing prompt semantics", () => {
  const flora = initialMegaPrompt("flora");
  const lamp = initialMegaPrompt("lamp");

  assert.match(flora.rendered, /^=== FLORA RELIGHT MEGA PROMPT v1 ===/);
  assert.match(lamp.rendered, /^=== LAMP RELIGHT MEGA PROMPT v1 ===/);
  assert.match(flora.rendered, /approved anchor frame/i);
  assert.doesNotMatch(lamp.rendered, /\banchor\b/i);
  assert.match(lamp.rendered, /original video as structural and temporal ground truth/i);
  assert.match(lamp.rendered, /source audio may be used only as timing context/i);
  assert.match(lamp.rendered, /provider-generated audio is discarded/i);
  assert.match(lamp.rendered, /canonical source audio is restored and verified/i);
  assert.match(
    nextMegaPrompt(flora, []).rendered,
    /^=== FLORA RELIGHT MEGA PROMPT v2 ===/
  );
  const nextLamp = nextMegaPrompt(lamp, []).rendered;
  assert.match(nextLamp, /^=== LAMP RELIGHT MEGA PROMPT v2 ===/);
  assert.doesNotMatch(nextLamp, /\banchor\b/i);
  assert.throws(
    () => initialMegaPrompt("background"),
    /human-approved cleanup plan/
  );
  assert.throws(
    () => initialMegaPrompt("beautify"),
    /human-approved enhancement plan/
  );
  assert.throws(
    () => initialMegaPrompt("iris"),
    /human-approved gaze plan/
  );
});

test("plan modes cannot fall back to the generic correction or render paths", () => {
  const lamp = initialMegaPrompt("lamp");
  const cases = [
    {
      mode: "background" as const,
      header: "=== LAMP BACKGROUND CLEANUP MEGA PROMPT v1 ===",
      expected: /Lamp Background/,
    },
    {
      mode: "beautify" as const,
      header: "=== LAMP BEAUTIFY TOUCH-UP MEGA PROMPT v1 ===",
      expected: /Lamp Beautify/,
    },
    {
      mode: "iris" as const,
      header: "=== LAMP IRIS EYE-CONTACT MEGA PROMPT v1 ===",
      expected: /Lamp Iris/,
    },
  ];

  for (const { mode, header, expected } of cases) {
    assert.throws(() => nextMegaPrompt(lamp, [], mode), expected);
    assert.throws(() => renderMegaPrompt(lamp, mode), expected);

    const persistedPlanPrompt = { ...lamp, rendered: header };
    assert.throws(() => nextMegaPrompt(persistedPlanPrompt, []), expected);
    assert.throws(() => renderMegaPrompt(persistedPlanPrompt), expected);
  }
});

test("a later browser batch snapshot cannot change the batch method", () => {
  const current: Batch = {
    id: "batch_mode_lock",
    name: "Lamp batch",
    workflowMode: "lamp",
    relightIntensity: 25,
    createdAt: 1,
    updatedAt: 10,
    runIds: ["run_mode_lock"],
    concurrency: 2,
    status: "running",
    budgetUsd: 2.05,
  };
  const staleModeFlip: Batch = {
    ...current,
    name: "stale browser snapshot",
    workflowMode: "flora",
    relightIntensity: 95,
    updatedAt: 20,
  };

  const merged = mergeBatch(current, staleModeFlip);
  assert.equal(merged.workflowMode, "lamp");
  assert.equal(merged.relightIntensity, 25);
  assert.equal(merged.status, "running");
});

test("Flora is retired for new work but persisted Flora records may continue", () => {
  assert.equal(floraRetiredForNewWork("flora", null), true);
  assert.equal(floraRetiredForNewWork("flora", "lamp"), true);
  assert.equal(floraRetiredForNewWork("flora", "flora"), false);
  assert.equal(floraRetiredForNewWork("lamp", null), false);
  assert.equal(floraRetiredForNewWork("lamp", "flora"), false);
  assert.equal(floraRetiredForNewWork("lamp", "lamp"), false);
  assert.equal(floraRetiredForNewWork("background", null), false);
  assert.equal(floraRetiredForNewWork("background", "flora"), false);
  assert.equal(floraRetiredForNewWork("background", "lamp"), false);
});

test("legacy records without a saved mode resolve it from the workflow id", () => {
  assert.equal(runWorkflowMode({ workflowId: workflowForMode("lamp").id }), "lamp");
  assert.equal(
    runWorkflowMode({ workflowId: workflowForMode("background").id }),
    "background"
  );
  assert.equal(
    runWorkflowMode({ workflowId: workflowForMode("flora").id }),
    "flora"
  );
  assert.equal(runWorkflowMode({ workflowId: "relight-v0" }), "flora");
  assert.equal(
    runWorkflowMode({ workflowMode: "flora", workflowId: "lamp-v1" }),
    "flora"
  );
  assert.equal(
    runWorkflowMode({
      workflowMode: "lamp",
      workflowId: "lamp-background-v1",
    }),
    "lamp"
  );
});

test("a run counts as started once any spend, provider, judged, or graded state exists", () => {
  const pristine = {
    spendApproval: undefined,
    providerOperations: [],
    iterations: [],
    humanGrade: undefined,
  };
  assert.equal(runHasStartedWork(pristine), false);
  assert.equal(
    runHasStartedWork({ ...pristine, spendApproval: {} as never }),
    true
  );
  assert.equal(
    runHasStartedWork({ ...pristine, providerOperations: [{} as never] }),
    true
  );
  assert.equal(
    runHasStartedWork({ ...pristine, iterations: [{} as never] }),
    true
  );
  assert.equal(
    runHasStartedWork({ ...pristine, humanGrade: {} as never }),
    true
  );
});
