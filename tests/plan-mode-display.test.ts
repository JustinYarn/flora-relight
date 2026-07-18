import assert from "node:assert/strict";
import test from "node:test";

import {
  lampBeautifyDisplayPrompt,
  lampIrisDisplayPrompt,
  planModeDisplayPrompt,
} from "../lib/plan-mode-display.ts";
import type { Run } from "../lib/types.ts";

test("definition-only plan-mode views always use dedicated approved-plan renderers", () => {
  const background = planModeDisplayPrompt("background");
  const beautify = lampBeautifyDisplayPrompt();
  const iris = lampIrisDisplayPrompt();

  assert.equal(background.sample, true);
  assert.equal(beautify.sample, true);
  assert.equal(iris.sample, true);
  assert.match(
    background.prompt.rendered,
    /^=== LAMP BACKGROUND CLEANUP MEGA PROMPT v1 ===/
  );
  assert.match(
    beautify.prompt.rendered,
    /^=== LAMP BEAUTIFY TOUCH-UP MEGA PROMPT v1 ===/
  );
  assert.match(
    iris.prompt.rendered,
    /^=== LAMP IRIS EYE-CONTACT MEGA PROMPT v1 ===/
  );
  for (const view of [background, beautify, iris]) {
    assert.doesNotMatch(view.prompt.rendered, /RELIGHT MEGA PROMPT/);
    assert.equal(view.runBound, false);
  }
});

test("saved plan-mode iteration bytes win over definition samples", () => {
  const definition = lampBeautifyDisplayPrompt();
  const savedPrompt = {
    ...definition.prompt,
    rendered: "saved beautify provider bytes",
  };
  const run = {
    workflowId: "lamp-beautify-v1",
    workflowMode: "beautify",
    iterations: [{ index: 1, megaPrompt: savedPrompt }],
  } as Run;

  const selected = lampBeautifyDisplayPrompt(run);
  assert.equal(selected.sample, false);
  assert.equal(selected.runBound, true);
  assert.equal(selected.prompt, savedPrompt);
  assert.equal(selected.prompt.rendered, "saved beautify provider bytes");
});

test("a run from another mode cannot contaminate a plan-mode definition view", () => {
  const irisDefinition = lampIrisDisplayPrompt();
  const wrongModeRun = {
    workflowId: "lamp-iris-v1",
    workflowMode: "iris",
    iterations: [
      {
        index: 1,
        megaPrompt: {
          ...irisDefinition.prompt,
          rendered: "wrong-mode saved bytes",
        },
      },
    ],
  } as Run;

  const beautify = lampBeautifyDisplayPrompt(wrongModeRun);
  assert.equal(beautify.sample, true);
  assert.doesNotMatch(beautify.prompt.rendered, /wrong-mode saved bytes/);
  assert.match(
    beautify.prompt.rendered,
    /^=== LAMP BEAUTIFY TOUCH-UP MEGA PROMPT v1 ===/
  );
});
