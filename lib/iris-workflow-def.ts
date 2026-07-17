/**
 * IRIS_WORKFLOW — Lamp Iris's fixed eye-contact method.
 *
 * The user first approves an explicit correct / declined / uncertain gaze
 * plan. Initial and Final are each generated from the immutable source video.
 * The whole Initial is critiqued once against that approved plan, then one
 * consolidated correction brief drives Final. Human grading stays blind to
 * the saved AI evaluation until the grade is submitted.
 */

import type {
  PipelineEdge,
  PipelineNode,
  WorkflowDefinition,
} from "@/lib/types";

const STEP = 260;
const MID = 260;

const nodes: PipelineNode[] = [
  {
    id: "plan",
    kind: "process",
    label: "Approve gaze plan",
    description:
      "Classifies the closed gaze-correction catalog as correct, declined, or uncertain before generation. The approved plan is the contract for both model passes and human grading.",
    position: { x: 0, y: MID },
  },
  {
    id: "initial",
    kind: "generate",
    label: "Generate Initial",
    description:
      "Creates the first eye-contact candidate from the immutable source while preserving identity, blinks, head pose, lip-sync, background, lighting, camera, and audio.",
    providerId: "omni",
    position: { x: STEP, y: MID },
  },
  {
    id: "critique",
    kind: "evaluate",
    label: "Critique the contact",
    description:
      "Evaluates the complete Initial against the approved gaze plan, including target matching in both directions, blink preservation, gaze naturalness, lip-sync, and untouched surroundings.",
    position: { x: STEP * 2, y: MID },
  },
  {
    id: "final",
    kind: "generate",
    label: "Generate Final",
    description:
      "Regenerates once from the immutable source using the approved plan plus every actionable finding from the Initial critique.",
    providerId: "omni",
    position: { x: STEP * 3, y: MID },
  },
  {
    id: "review",
    kind: "output",
    label: "Blind human grade",
    description:
      "Shows the approved gaze plan while hiding AI scores until the Final has been graded, then reveals the saved Final evaluation for comparison.",
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
    label: "Final AI grades saved",
  },
];

export const IRIS_WORKFLOW: WorkflowDefinition = {
  id: "lamp-iris-v1",
  name: "Lamp Iris eye contact",
  description:
    "Approve a gaze-correction plan, generate Initial from the source, critique the whole video once, generate Final from the source plus consolidated corrections, then grade Final blind before comparing with AI.",
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
