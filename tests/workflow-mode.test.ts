import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WORKFLOW_MODE,
  parseWorkflowMode,
  workflowModeLabel,
} from "../lib/workflow-mode.ts";
import {
  initialMegaPrompt,
  nextMegaPrompt,
} from "../lib/prompts/mega-prompt.ts";
import { mergeBatch } from "../lib/server/storage/batch-merge.ts";
import type { Batch } from "../lib/types.ts";

test("workflow mode accepts only the two public product modes", () => {
  assert.equal(parseWorkflowMode("flora"), "flora");
  assert.equal(parseWorkflowMode("lamp"), "lamp");
  assert.equal(parseWorkflowMode("live"), null);
  assert.equal(parseWorkflowMode(undefined), null);
});

test("new browser selections default to Lamp and retain product labels", () => {
  assert.equal(DEFAULT_WORKFLOW_MODE, "lamp");
  assert.equal(workflowModeLabel("flora"), "Flora");
  assert.equal(workflowModeLabel("lamp"), "Lamp");
});

test("Lamp compiles a source-only prompt while Flora keeps its anchor contract", () => {
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
