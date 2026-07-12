/**
 * Core contract for the Flora Relight pipeline.
 *
 * Everything in the app — providers, evals, the mega-prompt assembler, the run
 * engine, and the UI — is written against these types. When real API keys are
 * added later, only the provider implementations in `lib/providers/` change;
 * nothing else should need to.
 *
 * MODULE MAP (who exports what):
 *   lib/types.ts              — this file. Types only, no runtime logic.
 *   lib/util.ts               — uid(), sleep(), clamp(), formatting helpers.
 *   lib/cost.ts               — PRICE_TABLE (placeholder rates), CostItem, and
 *                               the est.-live-cost estimators (Stage A /
 *                               iteration / run / batch) + formatUsd().
 *   lib/prompts/base-prompt.ts— RELIGHT_BASE_PROMPT (immutable constraint block).
 *   lib/prompts/eval-defs.ts  — EVAL_DEFS: EvalDefinition[] (the rubric library).
 *   lib/prompts/manifest.ts   — MANIFEST_PROMPT (vision prompt that extracts the SceneManifest at ingest).
 *   lib/prompts/mega-prompt.ts— initialMegaPrompt(), nextMegaPrompt(), renderMegaPrompt().
 *   lib/providers/            — VideoGenProvider / ImageGenProvider / VisionJudgeProvider
 *                               implementations. Mock today, real later.
 *   lib/mock/scenario.ts      — scripted mock trajectories (SCENARIO_VARIANTS,
 *                               per-video via scenarioForVideo()).
 *   lib/workflow-def.ts       — RELIGHT_WORKFLOW: the default pipeline graph.
 *   lib/frames.ts             — client-side frame extraction (canvas).
 *   lib/engine.ts             — runWorkflow(): executes the graph, drives the store.
 *   lib/store.ts              — zustand store: runs, batches (startBatch() +
 *                               bounded worker queue), review actions.
 */

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface VideoAsset {
  id: string;
  kind: "original" | "generated" | "final";
  /** Object URL (uploads) or a /public path (samples). */
  url: string;
  label: string;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /**
   * Mock mode only: a CSS filter string applied on top of the original video
   * to *simulate* what the generated video would look like. Real mode leaves
   * this undefined and `url` points at an actual generated file.
   */
  simulatedFilter?: string;
}

export interface FrameSample {
  timestampSec: number;
  /** Data URL produced by lib/frames.ts, undefined until extracted. */
  dataUrl?: string;
}

// ---------------------------------------------------------------------------
// Scene manifest
// ---------------------------------------------------------------------------

/**
 * One-time structured inventory extracted from the source video before any
 * generation. It is the immutable ground truth that EVALS judge against.
 * Deliberately NOT rendered verbatim into generation prompts ("pink elephant"
 * discipline — naming "the red shirt" invites the model to repaint it);
 * prompts use region-scoped locks instead.
 */
export interface SceneManifest {
  person: {
    faceDescriptor: string;
    skinTone: string;
    hair: string;
    clothing: string[];
    accessories: string[];
  };
  background: {
    objects: string[];
    surfaces: string;
    layoutNotes: string;
  };
  camera: {
    framing: string;
    angle: string;
    notes: string;
  };
  /** What is wrong with the current lighting — drives the relight directive. */
  lightingDiagnosis: string;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * The immutable constraint block. This NEVER changes between iterations —
 * only the lighting directive and corrections vary. Structured as data so the
 * UI can render it and so a real Omni adapter can serialize it however the
 * API wants (JSON prompt, text, etc.).
 */
export interface RelightBasePrompt {
  task: string;
  /** Locks: things the model must copy exactly from the source video. */
  locks: {
    identity: string;
    performance: string; // motion, gestures, lip movement, timing
    wardrobe: string;
    background: string;
    camera: string; // framing, position, lens, crop
    audio: string; // audio is remuxed from source; model told to ignore it
  };
  /** The one thing that is allowed to change. */
  lighting: {
    style: string; // e.g. "three-point professional studio"
    keyLight: string;
    fillLight: string;
    rimLight: string;
    colorTemperature: string;
    mood: string;
  };
  /** Never-do list, rendered as negative constraints. */
  negative: string[];
}

/** One structured correction distilled from a failed/borderline eval. */
export interface Correction {
  id: string;
  sourceEvalId: string;
  severity: ViolationSeverity;
  /** Imperative, self-contained instruction, e.g. "Restore the plain wall camera-left; remove the added window." */
  instruction: string;
  addedAtIteration: number;
  /** Marked true when a later iteration's evals no longer report the violation. */
  resolved: boolean;
}

/**
 * The Mega Prompt: base (immutable) + lighting directive + live corrections.
 * Corrections are structured deltas, not accumulated prose — resolved ones are
 * dropped from the rendered prompt to prevent drift.
 */
export interface MegaPrompt {
  version: number; // == iteration index it was built for
  base: RelightBasePrompt;
  lightingDirective: string;
  corrections: Correction[];
  /** Final serialized prompt actually sent to the video model. */
  rendered: string;
}

// ---------------------------------------------------------------------------
// Evals
// ---------------------------------------------------------------------------

export type EvalCategory =
  | "identity"
  | "appearance"
  | "background"
  | "lighting"
  | "motion"
  | "temporal"
  | "framing"
  | "hallucination"
  | "audio";

export type EvalMethod = "dual-llm-judge" | "deterministic" | "hybrid";

export type Verdict = "pass" | "borderline" | "fail";

export type ViolationSeverity = "critical" | "major" | "minor";

export interface EvalDefinition {
  id: string;
  name: string;
  category: EvalCategory;
  /** One-liner for cards and node tooltips. */
  description: string;
  method: EvalMethod;
  /** Hard gates must pass regardless of the composite score (identity, hallucination, audio). */
  hardGate: boolean;
  /** Contribution to the composite score. Weights across defs should sum to 1. */
  weight: number;
  passThreshold: number; // score >= passThreshold → pass
  borderlineThreshold: number; // score >= borderline && < pass → borderline
  /**
   * Full rubric prompt sent to each vision judge (Claude + Gemini). Uses
   * {{BEFORE_FRAMES}} / {{AFTER_FRAMES}} placeholders. For deterministic
   * evals this is empty and `deterministicNote` explains the metric.
   */
  promptTemplate: string;
  /** For deterministic/hybrid evals: which metric runs when real APIs land (e.g. ArcFace cosine sim, audio hash). */
  deterministicNote?: string;
}

export interface Violation {
  aspect: string;
  severity: ViolationSeverity;
  description: string;
  frameTimestampSec?: number;
  /** Imperative fix phrased for direct inclusion in the next mega prompt. */
  correction: string;
}

/** What a single judge (Claude or Gemini) returns for one eval. */
export interface JudgeVerdict {
  judge: JudgeId;
  score: number; // 0-100
  verdict: Verdict;
  violations: Violation[];
  reasoning: string;
}

/** Aggregated result of one eval in one iteration (both judges merged). */
export interface EvalResult {
  evalId: string;
  iteration: number;
  verdicts: JudgeVerdict[];
  /** Aggregated score (mean of judges, or the deterministic value). */
  score: number;
  /**
   * 0–1. Derived from judge agreement: high when both judges land close,
   * low when they disagree — low confidence flags the eval for human review.
   */
  confidence: number;
  verdict: Verdict;
  /** Merged, deduped violations across judges. */
  violations: Violation[];
  /** Score delta vs the previous iteration; negative = regression. */
  deltaFromPrevious?: number;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export type JudgeId = "claude" | "gemini";

export interface ProviderInfo {
  id: "omni" | "gemini" | "claude";
  /** Placeholder model ids, swapped when keys land (e.g. "omni-video-1", "gemini-3.1-pro", "claude-opus-4-8"). */
  model: string;
  mock: boolean;
}

export interface VideoGenRequest {
  originalVideo: VideoAsset;
  megaPrompt: MegaPrompt;
  /** Approved relit keyframe from Stage A, used as first-frame conditioning. */
  conditioningFrameDataUrl?: string;
  seed: number;
  iteration: number;
}

export interface VideoGenResult {
  video: VideoAsset;
  latencyMs: number;
}

export interface VideoGenProvider {
  info: ProviderInfo;
  generate(req: VideoGenRequest): Promise<VideoGenResult>;
}

export interface ImageRelightRequest {
  frameDataUrl: string;
  prompt: string;
  iteration: number;
}

export interface ImageRelightResult {
  /** In mock mode: the input frame re-rendered through a CSS filter. */
  imageDataUrl: string;
  latencyMs: number;
}

export interface ImageGenProvider {
  info: ProviderInfo;
  relight(req: ImageRelightRequest): Promise<ImageRelightResult>;
}

export interface JudgeRequest {
  evalDef: EvalDefinition;
  iteration: number;
  beforeFrames: FrameSample[];
  afterFrames: FrameSample[];
  /** Stage-A approved look-anchor still; reference input for lighting-match-to-anchor. */
  anchorFrameDataUrl?: string;
}

export interface VisionJudgeProvider {
  info: ProviderInfo;
  judge(req: JudgeRequest): Promise<JudgeVerdict>;
}

export interface ProviderBundle {
  videoGen: VideoGenProvider;
  imageGen: ImageGenProvider;
  judges: Record<JudgeId, VisionJudgeProvider>;
}

// ---------------------------------------------------------------------------
// Pipeline graph
// ---------------------------------------------------------------------------

export type NodeKind =
  | "input"
  | "process"
  | "generate"
  | "evaluate"
  | "aggregate"
  | "gate"
  | "output";

export interface PipelineNode {
  id: string;
  kind: NodeKind;
  label: string;
  description: string;
  /** Set on evaluate nodes; joins to EVAL_DEFS. */
  evalId?: string;
  /** Set on generate nodes. */
  providerId?: ProviderInfo["id"];
  position: { x: number; y: number };
}

export interface PipelineEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Feedback edges (gate → generate) render dashed/animated. */
  isFeedbackLoop?: boolean;
}

export interface RunConfig {
  maxIterations: number;
  /** Composite must reach this AND all hard gates must pass. */
  compositePassThreshold: number;
  judges: JudgeId[];
  /** Timestamps (sec) sampled from both videos for judging. */
  frameTimestamps: number[];
  /** Stage A: iterate on a relit still before any video generation. */
  keyframeFirst: boolean;
  /**
   * If composite improvement stays below this for 2 consecutive iterations,
   * stop looping and route to human review as "plateaued".
   */
  plateauMinDelta: number;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  config: RunConfig;
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

export type NodeRunStatus =
  | "idle"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface NodeRunState {
  nodeId: string;
  status: NodeRunStatus;
  detail?: string;
}

export interface IterationComposite {
  score: number;
  passed: boolean;
  hardGateFailures: string[]; // evalIds
}

export interface Iteration {
  index: number; // 1-based
  megaPrompt: MegaPrompt;
  /**
   * Live mode: interaction id of THIS iteration's video generation. The next
   * iteration passes it as previous_interaction_id so corrections run as
   * multi-turn refinements (the Stage-A anchor chain is tracked separately).
   */
  interactionId?: string;
  /** Stage A artifact: the approved relit keyframe for this iteration. */
  relitKeyframeDataUrl?: string;
  generatedVideo?: VideoAsset;
  beforeFrames: FrameSample[];
  afterFrames: FrameSample[];
  evalResults: EvalResult[];
  composite?: IterationComposite;
  status: "running" | "passed" | "failed";
}

/**
 * Iteration exhaustion is NOT a terminal status: it routes to the
 * color-transfer fallback and parks at "awaiting-review" by design —
 * reviewers must still see those runs in the review queue.
 */
export type RunStatus =
  | "running"
  | "awaiting-review"
  | "approved"
  | "needs-changes"
  | "failed";

export interface RunLogEntry {
  at: number; // Date.now()
  nodeId?: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface Run {
  id: string;
  workflowId: string;
  createdAt: number;
  originalVideo: VideoAsset;
  status: RunStatus;
  /** True when this run executed against LIVE providers (real spend accrued). */
  live?: boolean;
  /** Extracted once at ingest; ground truth for all evals. */
  manifest?: SceneManifest;
  iterations: Iteration[];
  /** Best-of tracking: the loop returns the best iteration, never the last. */
  bestIterationIndex?: number;
  nodeStates: Record<string, NodeRunState>;
  log: RunLogEntry[];
  /** Original audio remuxed onto the winning generated video. */
  finalVideo?: VideoAsset;
  /**
   * Terminal safety net: when video generation cannot pass the gates, a
   * color-transfer fallback (lighting LUT from the best generation applied to
   * ORIGINAL pixels) ships instead. Guaranteed identity, lower drama ceiling —
   * always labeled in the review UI.
   */
  fallback?: { applied: boolean; reason: string };
  review?: {
    decision: "approved" | "needs-changes";
    notes: string;
    reviewedAt: number;
  };
  /**
   * Cost ledger (rates + estimators in lib/cost.ts). `estimatedUsd` is the
   * pre-flight estimate of what this run would cost against live APIs;
   * `items` accrue one entry per provider call as the engine executes.
   * Mock mode: every item is estimated:true and actualUsd stays 0 — live
   * adapters will flip estimated→false and accrue actualUsd.
   */
  cost?: {
    estimatedUsd: number;
    actualUsd: number;
    items: { label: string; usd: number; estimated: boolean }[];
  };
}

// ---------------------------------------------------------------------------
// Batches (lib/store.ts)
// ---------------------------------------------------------------------------

/**
 * Mass automation: a named group of runs started together — one Run per input
 * clip, executed through the store's bounded worker queue (`concurrency`
 * slots; real Omni calls will be rate-limited, so the queue is load-bearing,
 * not cosmetic). Status flips to "done" when every member run settles at a
 * terminal status (awaiting-review / approved / needs-changes / failed).
 */
export interface Batch {
  id: string;
  name: string;
  createdAt: number;
  runIds: string[];
  concurrency: number;
  status: "running" | "done";
  /**
   * Optional cap on the batch's total ESTIMATED live spend (USD). The worker
   * queue stops dispatching once the next run's estimate would exceed it;
   * skipped runs are failed with a "budget reached" log entry.
   */
  budgetUsd?: number;
}

// ---------------------------------------------------------------------------
// Mock scenario (lib/mock/scenario.ts)
// ---------------------------------------------------------------------------

/** Scripted outcome for one eval in one mock iteration. */
export interface ScenarioEvalOutcome {
  evalId: string;
  /** Base score; each mock judge jitters around it to demo the confidence meter. */
  score: number;
  /** How far apart the two judges land (drives confidence). */
  judgeSpread: number;
  violations: Violation[];
}

export interface ScenarioIteration {
  /** CSS filter simulating this iteration's generated video. */
  simulatedFilter: string;
  /** Filter for the Stage A relit keyframe. */
  keyframeFilter: string;
  outcomes: ScenarioEvalOutcome[];
  /** Rough simulated generation latency (ms) for the video-gen node. */
  videoGenLatencyMs: number;
}

export interface MockScenario {
  name: string;
  description: string;
  iterations: ScenarioIteration[];
}
