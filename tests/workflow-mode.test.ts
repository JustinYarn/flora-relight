import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WORKFLOW_MODE,
  floraRetiredForNewWork,
  isTwoPassWorkflowMode,
  parseWorkflowMode,
  runHasStartedWork,
  runWorkflowMode,
  workflowModeFromExecutionId,
  workflowModeLabel,
} from "../lib/workflow-mode.ts";
import {
  initialMegaPrompt,
  nextMegaPrompt,
} from "../lib/prompts/mega-prompt.ts";
import { mergeBatch } from "../lib/server/storage/batch-merge.ts";
import type { Batch } from "../lib/types.ts";
import {
  RELIGHT_WORKFLOW,
  workflowForMode,
} from "../lib/workflow-def.ts";

test("workflow mode accepts the current mode plus both historical product modes", () => {
  assert.equal(parseWorkflowMode("flora"), "flora");
  assert.equal(parseWorkflowMode("lamp"), "lamp");
  assert.equal(parseWorkflowMode("background"), "background");
  assert.equal(parseWorkflowMode("iris"), "iris");
  assert.equal(parseWorkflowMode("live"), null);
  assert.equal(parseWorkflowMode(undefined), null);
});

test("new browser selections default to Lamp Iris and retain historical labels", () => {
  assert.equal(DEFAULT_WORKFLOW_MODE, "iris");
  assert.equal(RELIGHT_WORKFLOW.id, workflowForMode("beautify").id);
  assert.equal(workflowModeLabel("flora"), "Flora");
  assert.equal(workflowModeLabel("lamp"), "Lamp");
  assert.equal(workflowModeLabel("background"), "Lamp Background");
  assert.equal(workflowModeLabel("beautify"), "Lamp Beautify");
  assert.equal(workflowModeLabel("iris"), "Lamp Iris");
});

test("Lamp Iris joins the fixed two-pass plumbing end to end", () => {
  assert.equal(isTwoPassWorkflowMode("iris"), true);
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
});

test("a later browser batch snapshot cannot change the batch method", () => {
  const current: Batch = {
    id: "batch_mode_lock",
    name: "Lamp batch",
    workflowMode: "lamp",
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
    updatedAt: 20,
  };

  const merged = mergeBatch(current, staleModeFlip);
  assert.equal(merged.workflowMode, "lamp");
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
