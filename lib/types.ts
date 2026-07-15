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
  /**
   * Canonical workflow/storage id reserved before ingest. When present, the
   * Run created for this asset MUST reuse it so source media, run JSON,
   * generated artifacts, review state, and deletion all share one identity.
   * Legacy/browser-only assets may omit it and receive a fresh run id.
   */
  runId?: string;
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

/**
 * User-selected relighting method. Legacy records omit this field and are
 * interpreted as Flora so existing runs and batches keep their original
 * execution semantics after Lamp is introduced.
 */
export type WorkflowMode = "flora" | "lamp";

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
   * Live mode: identity of THIS iteration's video generation. Later
   * iterations are fresh source-based requests and never consume this as
   * provider context.
   */
  interactionId?: string;
  /** Stage A artifact: the approved relit keyframe for this iteration. */
  relitKeyframeDataUrl?: string;
  generatedVideo?: VideoAsset;
  /**
   * Read-model trust marker: the server reconstructed this real video from a
   * completed provider journal entry. It is stripped from browser writes.
   * Such a cut may be graded even if later browser-side judging failed.
   */
  recoveredFromProviderOperation?: true;
  beforeFrames: FrameSample[];
  afterFrames: FrameSample[];
  evalResults: EvalResult[];
  composite?: IterationComposite;
  /** "ungraded" is a canonical generated cut awaiting human evaluation. */
  status: "running" | "ungraded" | "passed" | "failed";
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

/**
 * Compact server-owned execution state for the durable run coordinator.
 *
 * This record deliberately lives outside browser-writable Run JSON. A stale
 * tab may still save presentation state, but it cannot move the durable
 * coordinator backwards or erase evidence that execution is in progress.
 */
export type RunExecutionStatus =
  | "queued"
  | "running"
  | "user_action_required"
  | "awaiting_review"
  | "failed"
  | "reconcile_required";

export type RunExecutionPhase =
  | "queued"
  | "preparing"
  | "video_generation"
  | "evaluating"
  | "finalizing"
  | "complete";

export interface RunExecution {
  runId: string;
  executionId: string;
  /** SHA-256 of the exact immutable first-cut input bound at creation. */
  inputHash: string;
  /** Exact first-cut provider prompt; retained for deployment-safe recovery. */
  renderedPrompt: string;
  source: "single" | "batch";
  batchId?: string;
  status: RunExecutionStatus;
  phase: RunExecutionPhase;
  /** Zero while preparing; one-based once generation begins. */
  iteration: number;
  /** Storage compare-and-swap revision. Creation starts at revision 1. */
  revision: number;
  startedAt: number;
  updatedAt: number;
  workflowRunId?: string;
  error?: string;
}

export interface RunLogEntry {
  at: number; // Date.now()
  nodeId?: string;
  level: "info" | "warn" | "error";
  message: string;
}

/** One human verdict on one check, recorded in the grading flow (/grade). */
export interface HumanCheckGrade {
  /** 5-point scale: 5 perfect · 4 minor issues · 3 noticeable · 2 clear problems · 1 badly wrong. */
  points: 1 | 2 | 3 | 4 | 5;
  /** The point mapped onto the evals' 0–100 scale (95/85/72/55/30) so human and AI scores compare directly. */
  score: number;
  /** Derived from points: 5–4 → pass, 3 → borderline, 2–1 → fail. */
  verdict: Verdict;
  note?: string;
}

/**
 * A human grade of one run's shipped cut across that workflow's applicable
 * rubric rows. Lamp starts with AI evidence hidden so the grader can avoid
 * anchoring, while an explicit reveal remains available. Results compares the
 * saved human grade against Lamp Final's evalResults to calibrate the judges.
 */
export interface HumanGrade {
  gradedAt: number;
  /** Keyed by evalId (EVAL_DEFS ids). */
  scores: Record<string, HumanCheckGrade>;
  /** The gut call: would you ship this cut as-is? */
  shipIt: boolean;
  overallNote?: string;
}

export interface VideoGenerationOperationResult {
  videoUrl: string;
  rawUrl: string;
  durationSec: number;
  audioVerified: boolean;
  /** Exact token counters returned by the completed Interactions response. */
  usage: OmniUsageSnapshot;
  costUsd: number;
}

/** Billable Interactions counters. Extra provider fields are persisted too. */
export interface OmniUsageSnapshot {
  total_input_tokens: number;
  total_output_tokens: number;
  output_tokens_by_modality: Array<{ modality: string; tokens: number }>;
  total_thought_tokens?: number;
  [key: string]: unknown;
}

/** Billable GenerateContent counters. Extra provider fields are persisted too. */
export interface GeminiProUsageSnapshot {
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount?: number;
  [key: string]: unknown;
}

/** Server-owned journal entry for one potentially billed background operation. */
export interface ProviderOperation {
  /** Stable application id (for example `video-generation:1`), not a provider id. */
  id: string;
  provider: "gemini";
  kind: "video_generation";
  iteration: number;
  /** Immutable price snapshot captured by the atomic billed-operation claim. */
  maxAuthorizedCostMicros?: number;
  billingUsdPerOutputSecond?: number;
  /** Exact rendered prompt bound to the original billed create claim. */
  renderedPrompt?: string;
  /** Durable Workflow execution that owns start/poll/finalization. */
  workflowRunId?: string;
  workflowStatus?: "pending" | "running" | "completed" | "failed" | "cancelled";
  /** Atomic server claim proving only one request may enqueue the Workflow. */
  workflowClaimToken?: string;
  workflowClaimedAt?: number;
  /** Provider handle persisted immediately after the one billed start call. */
  providerInteractionId?: string;
  status:
    | "in_progress"
    | "completed"
    | "failed"
    | "cancelled"
    | "incomplete"
    | "budget_exceeded"
    | "reconcile_required";
  startedAt: number;
  updatedAt: number;
  result?: VideoGenerationOperationResult;
  error?: string;
}

/**
 * Durable server-only journal entry for a synchronous provider request that
 * may incur spend. This deliberately lives outside Run JSON in the storage
 * layer: a stale browser PUT can replace a Run document, but it can never
 * erase the evidence that a billed request may already have been sent.
 */
export interface PaidOperation {
  /** Stable application id, unique within a run. */
  id: string;
  runId: string;
  provider: "gemini" | "claude";
  kind: "manifest" | "anchor" | "judge";
  /** Anchor version or generated-video iteration, when applicable. */
  iteration?: number;
  /** Canonical eval id for judge operations. */
  evalId?: string;
  /** SHA-256 of the canonical server-validated request. */
  inputHash: string;
  status: "in_progress" | "completed" | "reconcile_required";
  startedAt: number;
  updatedAt: number;
  /** Route response, persisted so a lost response can be replayed for free. */
  result?: unknown;
  /** Safe operational summary only; never provider secrets or raw responses. */
  error?: string;
}

/** Server-issued record of one explicit live-spend confirmation. */
export interface SpendApproval {
  id: string;
  source: "single" | "batch";
  /** Legacy records without this field are treated as full_pipeline. */
  scope?: "full_pipeline" | "first_cut" | "lamp_two_pass";
  batchId?: string;
  /** Canonical durable ingest identity and facts this approval was priced for. */
  runId: string;
  sourceUrl: string;
  durationSec: number;
  approvedAt: number;
  expiresAt: number;
  /** Conservative run reservation authorized by the confirmation, in USD. */
  maxUsd: number;
  maxIterations: number;
}

/** One in-progress answer in the grading workspace. */
export interface GradeDraftAnswer {
  points: HumanCheckGrade["points"];
  /** Kept untrimmed while editing so autosave never changes what was typed. */
  note: string;
}

/** Unsaved work for one clip. Final scores/verdicts are derived on submit. */
export interface GradeClipDraft {
  answers: Record<string, GradeDraftAnswer>;
  shipIt?: boolean;
  overallNote: string;
}

/**
 * Durable working memory for the whole grading workspace.
 *
 * One revisioned document keeps partial clip answers and queue position in a
 * single compare-and-swap write. `revision` and `updatedAt` are server-owned;
 * clients send the last revision they observed so an older tab cannot silently
 * replace newer grading work.
 */
export interface GradeDraft {
  id: string;
  revision: number;
  updatedAt: number;
  clips: Record<string, GradeClipDraft>;
  skippedRunIds: string[];
  currentRunId?: string;
}

export interface Run {
  id: string;
  /**
   * Transport-only marker: list hydration omitted embedded frame pixels. The
   * server removes this before storage and preserves archived pixels on PUT.
   */
  _compact?: true;
  workflowId: string;
  /** Persisted method discriminator; absent on legacy Flora records. */
  workflowMode?: WorkflowMode;
  createdAt: number;
  originalVideo: VideoAsset;
  status: RunStatus;
  /** True when this run executed against LIVE providers (real spend accrued). */
  live?: boolean;
  /** Server-owned background provider operations, preserved across client PUTs. */
  providerOperations?: ProviderOperation[];
  /** Read-model projection; durable truth lives outside browser-writable Run JSON. */
  serverExecution?: RunExecution;
  /** Server-owned live-spend authorization; never accepted from a Run PUT. */
  spendApproval?: SpendApproval;
  /** Extracted once at ingest; ground truth for all evals. */
  manifest?: SceneManifest;
  iterations: Iteration[];
  /** Legacy best-of tracking. Lamp leaves this unset because v2 is always Final. */
  bestIterationIndex?: number;
  nodeStates: Record<string, NodeRunState>;
  log: RunLogEntry[];
  /** Original audio remuxed onto the delivered generated video. */
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
   * Human grade from /grade (see HumanGrade). Persists automatically
   * through the normal run sync — fs and cloud drivers alike — because it
   * rides inside run.json like every other Run field.
   */
  humanGrade?: HumanGrade;
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

export type BatchUploadStatus = "pending" | "uploading" | "ready" | "failed";

/**
 * Durable preparation state for one selected file. The browser reserves the
 * canonical run id before upload, then persists each transition so a refresh
 * never turns already-uploaded media into an invisible orphan.
 */
export interface BatchUploadItem {
  runId: string;
  label: string;
  status: BatchUploadStatus;
  /** Present after ingest/finalize succeeds; enough to resume batch launch. */
  video?: VideoAsset;
  error?: string;
  updatedAt: number;
}

/** Server-owned lifecycle for the durable generation-only batch dispatcher. */
export type BatchExecutionStatus =
  | "queued"
  | "running"
  | "user_action_required"
  | "done"
  | "failed";

export type BatchExecutionMemberState =
  | "queued"
  | "running"
  | "user_action_required"
  | "awaiting_review"
  | "failed"
  | "reconcile_required"
  | "skipped_budget";

export interface BatchExecutionMember {
  runId: string;
  position: number;
  state: BatchExecutionMemberState;
  /** Conservative approved reservation for this member, in millionths of USD. */
  maxReservedMicros: number;
  /** Confirmed terminal spend, in millionths of USD. */
  actualMicros?: number;
  error?: string;
}

/**
 * Durable batch dispatch/accounting state. It is stored separately from the
 * browser-writable Batch document so stale tabs cannot redispatch work or
 * release reservations.
 */
export interface BatchExecution {
  batchId: string;
  executionId: string;
  /** Persisted method discriminator; absent on legacy Flora executions. */
  workflowMode?: WorkflowMode;
  /** Exact first-cut prompt shared by every admitted member. */
  renderedPrompt: string;
  /** Lowercase sha256 of renderedPrompt. */
  inputHash: string;
  status: BatchExecutionStatus;
  revision: number;
  concurrency: number;
  budgetLimitMicros: number;
  reservedMicros: number;
  settledMicros: number;
  members: BatchExecutionMember[];
  startedAt: number;
  /**
   * Approval epoch for the currently authorized dispatch window. Missing on
   * legacy records, where startedAt remains the approval epoch.
   */
  approvalStartedAt?: number;
  updatedAt: number;
  workflowRunId?: string;
  error?: string;
}

/** Browser-safe batch progress; exact prompt bytes remain server-only. */
export type BatchExecutionSummary = Omit<BatchExecution, "renderedPrompt">;

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
  /** Persisted method discriminator; absent on legacy Flora batches. */
  workflowMode?: WorkflowMode;
  createdAt: number;
  runIds: string[];
  concurrency: number;
  status: "uploading" | "ready" | "running" | "done" | "failed";
  /** Incremental upload preparation; absent on legacy batches. */
  uploads?: BatchUploadItem[];
  updatedAt?: number;
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
