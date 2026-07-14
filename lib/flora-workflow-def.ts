/**
 * The legacy Flora pipeline graph. It remains available beside Lamp so saved
 * Flora runs and new user-selected Flora rehearsals retain their original
 * multi-stage method instead of being relabeled as Lamp.
 */

import type { PipelineEdge, PipelineNode, WorkflowDefinition } from "@/lib/types";

const COL = 230;
const MID = 320;

const nodes: PipelineNode[] = [
  {
    id: "src",
    kind: "input",
    label: "Source Video",
    description:
      "10s webcam clip — the immutable source of truth. Every iteration regenerates from these pixels, never from a previous generation.",
    position: { x: 0, y: MID },
  },
  {
    id: "ingest",
    kind: "process",
    label: "Ingest & split audio",
    description:
      "Audio is split off and SHA-256-hashed before anything generative runs — it never enters the model path.",
    position: { x: COL, y: MID },
  },
  {
    id: "manifest",
    kind: "process",
    label: "Scene inventory",
    description:
      "Structured inventory (person, wardrobe, background, camera) extracted once. Ground truth for evals — never prompt filler.",
    position: { x: COL * 2, y: MID },
  },
  {
    id: "anchor",
    kind: "generate",
    label: "Look Anchor",
    description:
      "Stage A: relight one reference frame with the image model — cheap still-tier iteration before any video spend.",
    providerId: "gemini",
    position: { x: COL * 3, y: MID },
  },
  {
    id: "anchor-gate",
    kind: "gate",
    label: "Approve the look",
    description:
      "Still-tier checks (identity, wardrobe, lighting drama) must approve the anchor before video generation is unlocked.",
    position: { x: COL * 4, y: MID },
  },
  {
    id: "compile",
    kind: "process",
    label: "Generation brief",
    description:
      "Deterministic compiler: immutable locks + lighting directive + active corrections from the constraint ledger. Same state → same bytes.",
    position: { x: COL * 5, y: MID },
  },
  {
    id: "videogen",
    kind: "generate",
    label: "Video Generation",
    description:
      "The video model as lighting propagator: original video (structure) + approved anchor (look) + compiled prompt + pinned seed.",
    providerId: "omni",
    position: { x: COL * 6, y: MID },
  },
  {
    id: "conform",
    kind: "process",
    label: "Normalize output",
    description:
      "Normalize the returned stream (fps, timebase, dimensions) so frame indices line up for every comparison downstream.",
    position: { x: COL * 7, y: MID },
  },
  {
    id: "sample",
    kind: "process",
    label: "Sample frames",
    description:
      "Matched before/after frames at fixed percentiles (plus event-picked frames in real mode — drift hides in the hardest frames).",
    position: { x: COL * 8, y: MID },
  },
  {
    id: "eval-align",
    kind: "evaluate",
    label: "Timing matches",
    description:
      "Deterministic pre-gate: frame correlation must peak at offset 0, else every index-locked comparison silently lies.",
    evalId: "temporal-alignment",
    position: { x: COL * 9, y: -60 },
  },
  {
    id: "eval-identity",
    kind: "evaluate",
    label: "Same person",
    description: "Hard gate — same person on the WORST frame, not just on average.",
    evalId: "identity-preservation",
    position: { x: COL * 9, y: 18 },
  },
  {
    id: "eval-skin",
    kind: "evaluate",
    label: "Natural skin (no airbrushing)",
    description:
      "Hard gate — detects beautification, smoothing, waxiness, and apparent-age shift; skin structure must ship at original strength once illumination is factored out.",
    evalId: "skin-texture-age",
    position: { x: COL * 9, y: 96 },
  },
  {
    id: "eval-appearance",
    kind: "evaluate",
    label: "Hair & clothing unchanged",
    description:
      "Hard gate — blind-inventory diff: each judge lists garments/accessories independently, code diffs the lists.",
    evalId: "appearance-fidelity",
    position: { x: COL * 9, y: 174 },
  },
  {
    id: "eval-background",
    kind: "evaluate",
    label: "Room unchanged",
    description:
      "Person-masked comparison; suspicious tiles adjudicated as lighting-explainable vs object change.",
    evalId: "background-fidelity",
    position: { x: COL * 9, y: 252 },
  },
  {
    id: "eval-lighting-delta",
    kind: "evaluate",
    label: "Lighting clearly better",
    description:
      "Anti-degenerate hard gate: the relight must measurably beat the original, blocking near-copy outputs.",
    evalId: "lighting-quality-delta",
    position: { x: COL * 9, y: 330 },
  },
  {
    id: "eval-lighting-anchor",
    kind: "evaluate",
    label: "Matches approved look",
    description:
      "Does the video hold the approved Look Anchor's key direction, intensity, and mood?",
    evalId: "lighting-match-to-anchor",
    position: { x: COL * 9, y: 408 },
  },
  {
    id: "eval-motion",
    kind: "evaluate",
    label: "Movement & lips in sync",
    description:
      "Hard gate — mouth and gesture timing vs source; valid precisely because the delivered audio IS the original.",
    evalId: "motion-lipsync",
    position: { x: COL * 9, y: 486 },
  },
  {
    id: "eval-temporal",
    kind: "evaluate",
    label: "No flicker",
    description:
      "Flicker and drift across frames — illumination must hold steady, not pulse.",
    evalId: "temporal-stability",
    position: { x: COL * 9, y: 564 },
  },
  {
    id: "eval-halluc",
    kind: "evaluate",
    label: "Nothing invented",
    description:
      "Hard gate — scans for invented objects, openings, light fixtures, warped geometry, or melted texture.",
    evalId: "hallucination-artifacts",
    position: { x: COL * 9, y: 642 },
  },
  {
    id: "ledger",
    kind: "aggregate",
    label: "Fix list",
    description:
      "Merges judge verdicts, dedupes violations into canonical corrective clauses, tracks resolution across iterations.",
    position: { x: COL * 10, y: MID },
  },
  {
    id: "gate",
    kind: "gate",
    label: "Pass / retry decision",
    description:
      "Composite ≥ threshold AND every hard gate green. Fail feeds corrections back to the compiler; exhaustion routes to fallback.",
    position: { x: COL * 11, y: MID },
  },
  {
    id: "fallback",
    kind: "process",
    label: "Safe fallback",
    description:
      "Terminal safety net: temporally smoothed color transfer from the best generation applied to ORIGINAL pixels. Exact identity, lower drama ceiling — always labeled.",
    position: { x: COL * 11, y: 560 },
  },
  {
    id: "remux",
    kind: "process",
    label: "Original audio restored",
    description:
      "Stream-copy the original audio onto the winning video, re-hash, and verify against the ingest hash.",
    position: { x: COL * 12, y: MID },
  },
  {
    id: "eval-audio",
    kind: "evaluate",
    label: "Audio Integrity",
    description:
      "Deterministic post-remux gate: the delivered audio hash must equal the ingest hash bit-for-bit.",
    evalId: "audio-integrity",
    position: { x: COL * 13, y: MID },
  },
  {
    id: "review",
    kind: "output",
    label: "Human Review",
    description:
      "Reviewer sees the best iteration, eval evidence, confidence flags, and any fallback label before sign-off.",
    position: { x: COL * 14, y: MID },
  },
];

const edges: PipelineEdge[] = [
  { id: "e-src-ingest", source: "src", target: "ingest" },
  { id: "e-ingest-manifest", source: "ingest", target: "manifest" },
  { id: "e-manifest-anchor", source: "manifest", target: "anchor" },
  { id: "e-anchor-anchorgate", source: "anchor", target: "anchor-gate" },
  { id: "e-anchorgate-compile", source: "anchor-gate", target: "compile" },
  { id: "e-compile-videogen", source: "compile", target: "videogen" },
  { id: "e-videogen-conform", source: "videogen", target: "conform" },
  { id: "e-conform-align", source: "conform", target: "eval-align" },
  { id: "e-align-ledger", source: "eval-align", target: "ledger" },
  { id: "e-conform-sample", source: "conform", target: "sample" },
  { id: "e-sample-identity", source: "sample", target: "eval-identity" },
  { id: "e-sample-skin", source: "sample", target: "eval-skin" },
  { id: "e-sample-appearance", source: "sample", target: "eval-appearance" },
  { id: "e-sample-background", source: "sample", target: "eval-background" },
  { id: "e-sample-lighting-delta", source: "sample", target: "eval-lighting-delta" },
  { id: "e-sample-lighting-anchor", source: "sample", target: "eval-lighting-anchor" },
  { id: "e-sample-motion", source: "sample", target: "eval-motion" },
  { id: "e-sample-temporal", source: "sample", target: "eval-temporal" },
  { id: "e-sample-halluc", source: "sample", target: "eval-halluc" },
  { id: "e-identity-ledger", source: "eval-identity", target: "ledger" },
  { id: "e-skin-ledger", source: "eval-skin", target: "ledger" },
  { id: "e-appearance-ledger", source: "eval-appearance", target: "ledger" },
  { id: "e-background-ledger", source: "eval-background", target: "ledger" },
  { id: "e-lighting-delta-ledger", source: "eval-lighting-delta", target: "ledger" },
  { id: "e-lighting-anchor-ledger", source: "eval-lighting-anchor", target: "ledger" },
  { id: "e-motion-ledger", source: "eval-motion", target: "ledger" },
  { id: "e-temporal-ledger", source: "eval-temporal", target: "ledger" },
  { id: "e-halluc-ledger", source: "eval-halluc", target: "ledger" },
  { id: "e-ledger-gate", source: "ledger", target: "gate" },
  { id: "e-gate-remux", source: "gate", target: "remux", label: "all checks pass" },
  {
    id: "e-gate-compile",
    source: "gate",
    target: "compile",
    label: "fixes",
    isFeedbackLoop: true,
  },
  {
    id: "e-gate-fallback",
    source: "gate",
    target: "fallback",
    label: "loop exhausted",
    isFeedbackLoop: true,
  },
  { id: "e-fallback-review", source: "fallback", target: "review" },
  { id: "e-remux-audio", source: "remux", target: "eval-audio" },
  { id: "e-audio-review", source: "eval-audio", target: "review" },
];

export const FLORA_WORKFLOW: WorkflowDefinition = {
  id: "relight-v1",
  name: "Flora Relight Pipeline",
  description:
    "Two-tier relighting loop: still-tier Look Anchor, video-tier lighting propagation, dual-judge evals with measured confidence, constraint-ledger corrections, terminal color-transfer fallback, and audio that never touches the generative path.",
  nodes,
  edges,
  config: {
    maxIterations: 4,
    compositePassThreshold: 75,
    judges: ["claude", "gemini"],
    frameTimestamps: [0.5, 2.5, 5, 7.5, 9.5],
    keyframeFirst: true,
    plateauMinDelta: 3,
  },
};
