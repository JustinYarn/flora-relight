/**
 * COMBINED_WORKFLOW — one region-owned prompt, two generations, one choice.
 *
 * Take 1 and Take 2 both condition on the immutable source. Take 2 is never a
 * generation from Take 1's pixels; only the consolidated critique carries
 * forward.
 */

import type {
  PipelineEdge,
  PipelineNode,
  WorkflowDefinition,
} from "./types.ts";

const STEP = 260;
const MID = 260;

const nodes: PipelineNode[] = [
  {
    id: "plan",
    kind: "process",
    label: "Plan + approve once",
    description:
      "Runs only the enabled Background, Beautify, and Iris planners, binds them to the controls, and presents one consolidated human approval before any generation spend.",
    position: { x: 0, y: MID },
  },
  {
    id: "initial",
    kind: "generate",
    label: "Generate Take 1",
    description:
      "Creates the first combined take directly from the immutable source using the unified region-ownership prompt and separately stored relight intensity.",
    providerId: "omni",
    position: { x: STEP, y: MID },
  },
  {
    id: "critique",
    kind: "evaluate",
    label: "Holistic critique",
    description:
      "Evaluates the complete v1 across every enabled concern and hard preservation gate, then selects at most 12 deterministic corrections for one final pass.",
    position: { x: STEP * 2, y: MID },
  },
  {
    id: "final",
    kind: "generate",
    label: "Generate Take 2",
    description:
      "Creates v2 directly from the same immutable source plus the approved combined plan and consolidated correction ledger; it never chains from v1 pixels.",
    providerId: "omni",
    position: { x: STEP * 3, y: MID },
  },
  {
    id: "review",
    kind: "output",
    label: "Pick winner + blind grade",
    description:
      "Shows both candidates and their qualification status, records one eligible human winner, and grades only that chosen take before revealing its saved AI evaluation.",
    position: { x: STEP * 4, y: MID },
  },
];

const edges: PipelineEdge[] = [
  { id: "e-plan-initial", source: "plan", target: "initial" },
  { id: "e-initial-critique", source: "initial", target: "critique" },
  {
    id: "e-critique-final",
    source: "critique",
    target: "final",
    label: "one correction pass",
  },
  {
    id: "e-final-review",
    source: "final",
    target: "review",
    label: "v1 + v2 eligibility",
  },
];

export const COMBINED_WORKFLOW: WorkflowDefinition = {
  id: "lamp-combined-v1",
  name: "Lamp Combined",
  description:
    "Approve one Combined plan, generate Take 1 from the source, critique it once, generate Take 2 from the source plus capped corrections, then choose among eligible takes and grade only that winner.",
  nodes,
  edges,
  config: {
    maxIterations: 2,
    compositePassThreshold: 75,
    judges: ["gemini"],
    frameTimestamps: [],
    keyframeFirst: false,
    plateauMinDelta: 0,
  },
};
