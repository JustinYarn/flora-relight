import assert from "node:assert/strict";
import test from "node:test";

import { promptRoleForNode } from "../components/canvas/prompt-map.ts";
import type { PipelineNode } from "../lib/types.ts";

const planNode = {
  id: "plan",
  kind: "process",
  label: "Plan",
  description: "Plan",
  position: { x: 0, y: 0 },
} as PipelineNode;

test("plan cards use method-specific language instead of leaking cleanup copy", () => {
  const background = promptRoleForNode(planNode, "background");
  const beautify = promptRoleForNode(planNode, "beautify");
  const iris = promptRoleForNode(planNode, "iris");

  assert.match(background?.description ?? "", /remove, preserve, or uncertain/);
  assert.match(beautify?.description ?? "", /enhance, declined, or uncertain/);
  assert.match(iris?.description ?? "", /correct, declined, or uncertain/);
  assert.doesNotMatch(beautify?.description ?? "", /cleanup|remove, preserve/);
  assert.doesNotMatch(iris?.description ?? "", /cleanup|remove, preserve/);
});
