/**
 * LAMP_WORKFLOW — the fixed two-pass relighting method shown in the Method UI.
 *
 * One source clip is generated from the mega prompt, evaluated holistically,
 * corrected once, and generated one final time from the immutable source. Each
 * generated cut has the original audio restored and verified before its single
 * holistic evaluation; Final is then handed to a human grader. There is no anchor, pass gate, best-of
 * selection, plateau loop, or fallback in Lamp.
 */

import { FLORA_WORKFLOW } from "./flora-workflow-def.ts";
import type {
  PipelineEdge,
  PipelineNode,
  WorkflowDefinition,
  WorkflowMode,
} from "@/lib/types";

const COL = 230;
const MID = 320;

const nodes: PipelineNode[] = [
  {
    id: "src",
    kind: "input",
    label: "Source Video",
    description:
      "The immutable source clip. Both generations start from this same video; Lamp never generates the final from the pixels of the initial result.",
    position: { x: 0, y: MID },
  },
  {
    id: "ingest",
    kind: "process",
    label: "Protect original audio",
    description:
      "The original audio is isolated and fingerprinted before generation so model audio can be discarded and the source track restored unchanged.",
    position: { x: COL, y: MID },
  },
  {
    id: "compile",
    kind: "process",
    label: "Compile mega prompt",
    description:
      "Builds the initial generation brief from the fixed preservation locks. After the first critique, it compiles one final brief containing every actionable correction.",
    position: { x: COL * 2, y: MID },
  },
  {
    id: "videogen",
    kind: "generate",
    label: "Generate Initial, then Final",
    description:
      "Runs exactly twice: Initial from the mega prompt, then Final from the original source plus the single consolidated correction brief.",
    providerId: "omni",
    position: { x: COL * 3, y: MID },
  },
  {
    id: "eval-identity",
    kind: "evaluate",
    label: "Same person",
    description:
      "Checks identity preservation across the complete source and candidate videos.",
    evalId: "identity-preservation",
    position: { x: COL * 4, y: 18 },
  },
  {
    id: "eval-skin",
    kind: "evaluate",
    label: "Natural skin",
    description:
      "Allows only extremely subtle close-inspection softening while rejecting visible beautification, de-aging, and any added wrinkles.",
    evalId: "skin-texture-age",
    position: { x: COL * 4, y: 96 },
  },
  {
    id: "eval-appearance",
    kind: "evaluate",
    label: "Hair & clothing unchanged",
    description:
      "Checks that hair, wardrobe, and accessories remain faithful to the source.",
    evalId: "appearance-fidelity",
    position: { x: COL * 4, y: 174 },
  },
  {
    id: "eval-background",
    kind: "evaluate",
    label: "Room unchanged",
    description:
      "Checks that background objects, geometry, and scene content remain unchanged.",
    evalId: "background-fidelity",
    position: { x: COL * 4, y: 252 },
  },
  {
    id: "eval-lighting-delta",
    kind: "evaluate",
    label: "Lighting clearly better",
    description:
      "Checks that the intended relight is visible and successful rather than a near-copy of the source.",
    evalId: "lighting-quality-delta",
    position: { x: COL * 4, y: 330 },
  },
  {
    id: "eval-motion",
    kind: "evaluate",
    label: "Movement & lips preserved",
    description:
      "Checks the complete performance for altered motion, gesture, expression, or mouth timing.",
    evalId: "motion-lipsync",
    position: { x: COL * 4, y: 408 },
  },
  {
    id: "eval-temporal",
    kind: "evaluate",
    label: "No flicker or drift",
    description:
      "Checks the full candidate for illumination flicker, texture boiling, popping, and temporal drift.",
    evalId: "temporal-stability",
    position: { x: COL * 4, y: 486 },
  },
  {
    id: "eval-halluc",
    kind: "evaluate",
    label: "Nothing invented",
    description:
      "Checks for invented objects, warped geometry, melted texture, and other generative artifacts.",
    evalId: "hallucination-artifacts",
    position: { x: COL * 4, y: 564 },
  },
  {
    id: "ledger",
    kind: "aggregate",
    label: "One consolidated critique",
    description:
      "Collects all eight visual findings from one holistic evaluation call. After Initial it writes one correction set; after Final it stores the AI grades for comparison.",
    position: { x: COL * 5, y: MID },
  },
  {
    id: "remux",
    kind: "process",
    label: "Restore source audio",
    description:
      "Runs after each generation: discards any generated audio and restores the original source track onto Initial and Final.",
    position: { x: COL * 4, y: MID },
  },
  {
    id: "eval-audio",
    kind: "evaluate",
    label: "Verify audio integrity",
    description:
      "Deterministically verifies each finalized cut before any visual evaluation. A duration, content, or silent-source mismatch fails closed.",
    evalId: "audio-integrity",
    position: { x: COL * 5, y: MID },
  },
  {
    id: "review",
    kind: "output",
    label: "Blind human grade",
    description:
      "You grade the Final without seeing the AI scores first, then compare your result with the Final evaluation per video and per rubric.",
    position: { x: COL * 8, y: MID },
  },
];

const visualEvalNodeIds = [
  "eval-identity",
  "eval-skin",
  "eval-appearance",
  "eval-background",
  "eval-lighting-delta",
  "eval-motion",
  "eval-temporal",
  "eval-halluc",
] as const;

const edges: PipelineEdge[] = [
  { id: "e-src-ingest", source: "src", target: "ingest" },
  { id: "e-ingest-compile", source: "ingest", target: "compile" },
  { id: "e-compile-videogen", source: "compile", target: "videogen" },
  { id: "e-videogen-remux", source: "videogen", target: "remux" },
  { id: "e-remux-audio", source: "remux", target: "eval-audio" },
  ...visualEvalNodeIds.map((nodeId) => ({
    id: `e-audio-${nodeId}`,
    source: "eval-audio",
    target: nodeId,
  })),
  ...visualEvalNodeIds.map((nodeId) => ({
    id: `e-${nodeId}-ledger`,
    source: nodeId,
    target: "ledger",
  })),
  {
    id: "e-ledger-compile",
    source: "ledger",
    target: "compile",
    label: "one correction pass",
    isFeedbackLoop: true,
  },
  {
    id: "e-ledger-review",
    source: "ledger",
    target: "review",
    label: "Final AI grades saved",
  },
];

export const LAMP_WORKFLOW: WorkflowDefinition = {
  id: "lamp-v1",
  name: "Lamp two-pass relight",
  description:
    "Generate Initial from the mega prompt, restore and verify its source audio, critique the whole video once, then repeat that fixed finalization and evaluation sequence for Final before per-video human grading.",
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

/** Legacy import kept for components that have not yet selected a mode. */
export const RELIGHT_WORKFLOW = LAMP_WORKFLOW;

export function workflowForMode(mode: WorkflowMode): WorkflowDefinition {
  return mode === "flora" ? FLORA_WORKFLOW : LAMP_WORKFLOW;
}

export { FLORA_WORKFLOW };
