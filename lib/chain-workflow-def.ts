/**
 * CHAIN_WORKFLOW — Combined Version 2: sequential per-concern stages.
 *
 * The clip enters once. Each enabled concern runs as its own single-pass
 * generation, and every stage after the first conditions on the PREVIOUS
 * stage's audio-remuxed cut — the deliberate inversion of Combined's
 * always-from-source law, kept as the experiment's only variable. Delivery
 * settles on structural proof (generation + canonical audio per stage);
 * the evaluation report card is detached and arrives after delivery.
 *
 * The four stage nodes are presentation slots: the actual concern each slot
 * runs, and whether slots 3–4 exist at all, comes from the approved stage
 * order (2–4 enabled stages).
 */

import type {
  PipelineEdge,
  PipelineNode,
  WorkflowDefinition,
} from "./types.ts";

const STEP = 240;
const MID = 260;

const nodes: PipelineNode[] = [
  {
    id: "plan",
    kind: "process",
    label: "Plan + order + approve once",
    description:
      "Runs only the enabled planners, binds them to the controls and the chosen stage order, and presents one consolidated human approval before any generation spend.",
    position: { x: 0, y: MID },
  },
  {
    id: "stage-1",
    kind: "generate",
    label: "Stage 1",
    description:
      "First concern, generated from the immutable source. Seeds the canonical audio that every later stage re-verifies.",
    providerId: "omni",
    position: { x: STEP, y: MID },
  },
  {
    id: "stage-2",
    kind: "generate",
    label: "Stage 2",
    description:
      "Second concern, generated from Stage 1's audio-remuxed cut — the chain experiment's deliberate deviation from the source-only law.",
    providerId: "omni",
    position: { x: STEP * 2, y: MID },
  },
  {
    id: "stage-3",
    kind: "generate",
    label: "Stage 3 (when enabled)",
    description:
      "Third concern, generated from Stage 2's cut. Present only when Beautify or eye contact expands the chain.",
    providerId: "omni",
    position: { x: STEP * 3, y: MID },
  },
  {
    id: "stage-4",
    kind: "generate",
    label: "Stage 4 (when enabled)",
    description:
      "Fourth concern, generated from Stage 3's cut. Present only when all four concerns are enabled.",
    providerId: "omni",
    position: { x: STEP * 4, y: MID },
  },
  {
    id: "deliver",
    kind: "output",
    label: "Deliver final cut",
    description:
      "Settles on structural proof alone — every stage generated with verified canonical audio. No evaluation, SyncNet verdict, or repair can hold the artifact.",
    position: { x: STEP * 5, y: MID },
  },
  {
    id: "report",
    kind: "evaluate",
    label: "Detached report card",
    description:
      "After delivery: one holistic evaluation per stage against the ORIGINAL (completed concerns as targets, pending concerns as hard preservation gates) plus SyncNet, luma, and gaze trajectories. Measurement only; it never revisits delivery.",
    position: { x: STEP * 6, y: MID },
  },
];

const edges: PipelineEdge[] = [
  { id: "e-plan-s1", source: "plan", target: "stage-1" },
  { id: "e-s1-s2", source: "stage-1", target: "stage-2", label: "prior cut in" },
  { id: "e-s2-s3", source: "stage-2", target: "stage-3", label: "prior cut in" },
  { id: "e-s3-s4", source: "stage-3", target: "stage-4", label: "prior cut in" },
  { id: "e-s4-deliver", source: "stage-4", target: "deliver" },
  {
    id: "e-deliver-report",
    source: "deliver",
    target: "report",
    label: "detached — after delivery",
  },
];

export const CHAIN_WORKFLOW: WorkflowDefinition = {
  id: "lamp-chain-v1",
  name: "Lamp Chain",
  description:
    "Approve one ordered chain plan, run each enabled concern as its own single-pass generation over the previous stage's cut, deliver the final cut immediately, then attach the detached per-stage evaluation report card.",
  nodes,
  edges,
  config: {
    maxIterations: 4,
    compositePassThreshold: 75,
    judges: ["gemini"],
    frameTimestamps: [],
    keyframeFirst: false,
    plateauMinDelta: 0,
  },
};
