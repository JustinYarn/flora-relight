/**
 * lib/cost.ts — cost governance: the single source of price truth.
 *
 * Standing rule: the team lead is never surprised by spend. Every action in
 * the app shows its estimated live cost BEFORE it runs, every run keeps a
 * cost ledger, and live batches carry a server-owned integer reservation.
 *
 * MOCK MODE: nothing costs money — every figure this module produces is an
 * "est. live cost": what the run/batch WOULD cost against the real APIs.
 * Live actuals accrue from server provider journals; mock estimates use the
 * browser ledger. Never render a number from this module without an
 * est/actual label.
 *
 * Legacy Flora estimators are driven by Flora's immutable registry/config
 * (EVAL_DEFS, FLORA_WORKFLOW.config), never by the app's mutable default
 * workflow. Adding a new default product must not silently reprice historical
 * Flora approvals, batches, or saved estimates.
 */

import { EVAL_DEFS } from "./prompts/eval-defs.ts";
import { FLORA_WORKFLOW } from "./flora-workflow-def.ts";
import type {
  GeminiProUsageSnapshot,
  JudgeId,
  OmniUsageSnapshot,
  VideoAsset,
} from "@/lib/types";

/**
 * Absolute billable output ceiling reserved by generation approvals.
 *
 * The model's requested timeline is capped at 10s, but provider MP4s can probe
 * a few hundredths longer because of container timebases. Reserving 50ms
 * covers that bounded bookkeeping variance without hiding the actual duration
 * or opening a meaningful spend overrun.
 */
export const FIRST_CUT_MAX_OUTPUT_SECONDS = 10.05;
/** Lamp always performs two generations and two one-shot holistic evaluations. */
export const LAMP_GENERATION_COUNT = 2;
export const LAMP_EVALUATION_COUNT = 2;
/** Gemini 3.1 Pro's documented output ceiling, including its thinking room. */
export const LAMP_EVALUATOR_MAX_OUTPUT_TOKENS = 65_536;
/** Planning is a distinct paid step, then cleanup uses the same fixed two-pass shape. */
export const LAMP_BACKGROUND_PLAN_COUNT = 1;
export const LAMP_BACKGROUND_GENERATION_COUNT = 2;
export const LAMP_BACKGROUND_EVALUATION_COUNT = 2;
export const LAMP_BACKGROUND_GEMINI_MAX_OUTPUT_TOKENS = 65_536;

// These figures drive the estimate shown before a call. Settled spend always
// comes from the provider usage snapshots below.
const ESTIMATED_OMNI_INPUT_TOKENS = 16_000;
const ESTIMATED_LAMP_EVALUATOR_INPUT_TOKENS = 16_000;
const ESTIMATED_LAMP_EVALUATOR_OUTPUT_AND_THINKING_TOKENS = 8_192;
const ESTIMATED_LAMP_BACKGROUND_PLAN_INPUT_TOKENS = 16_000;
const ESTIMATED_LAMP_BACKGROUND_PLAN_OUTPUT_AND_THINKING_TOKENS = 8_192;
const ESTIMATED_LAMP_BACKGROUND_EVALUATOR_INPUT_TOKENS = 16_000;
const ESTIMATED_LAMP_BACKGROUND_EVALUATOR_OUTPUT_AND_THINKING_TOKENS = 8_192;

// Batch admission reserves more than the UI estimate so normal usage variance
// does not strand a completed call in reconciliation. These are intentionally
// simple app policy ceilings, not invented provider usage measurements.
export const OMNI_INPUT_RESERVATION_TOKENS = 128_000;
export const OMNI_TEXT_AND_THINKING_RESERVATION_TOKENS = 65_536;
export const LAMP_EVALUATOR_INPUT_RESERVATION_TOKENS = 32_000;
export const LAMP_EVALUATOR_OUTPUT_AND_THINKING_RESERVATION_TOKENS =
  LAMP_EVALUATOR_MAX_OUTPUT_TOKENS;
export const LAMP_BACKGROUND_PLAN_INPUT_RESERVATION_TOKENS = 32_000;
export const LAMP_BACKGROUND_PLAN_OUTPUT_AND_THINKING_RESERVATION_TOKENS =
  LAMP_BACKGROUND_GEMINI_MAX_OUTPUT_TOKENS;
export const LAMP_BACKGROUND_EVALUATOR_INPUT_RESERVATION_TOKENS = 32_000;
export const LAMP_BACKGROUND_EVALUATOR_OUTPUT_AND_THINKING_RESERVATION_TOKENS =
  LAMP_BACKGROUND_GEMINI_MAX_OUTPUT_TOKENS;

// ---------------------------------------------------------------------------
// Cost item (lives here, not in lib/types.ts, to keep the core contract stable)
// ---------------------------------------------------------------------------

export interface CostItem {
  label: string;
  provider: "gemini" | "omni" | "claude" | "replicate" | "local";
  units: number;
  unitLabel: string;
  usd: number;
}

/** Items + total for one estimated action (Stage A, iteration, run, batch). */
export interface CostEstimate {
  items: CostItem[];
  totalUsd: number;
}

// ---------------------------------------------------------------------------
// Price table — per-unit USD. Live rates verified 2026-07-11.
// ---------------------------------------------------------------------------

interface PriceEntry {
  /** USD per unit. */
  usd: number;
  provider: CostItem["provider"];
  unitLabel: string;
  /** false until the rate is confirmed against the provider's primary pricing docs. */
  verified: boolean;
}

export const PRICE_TABLE = {
  /** VERIFIED 2026-07-15 — 5,792 video tokens/s at $17.50 per million. */
  omniFlashPerOutputSecond: {
    usd: (5_792 * 17.5) / 1_000_000,
    provider: "omni",
    unitLabel: "output second",
    verified: true,
  },
  omniFlashInputPerMillionTokens: {
    usd: 1.5,
    provider: "omni",
    unitLabel: "million input tokens",
    verified: true,
  },
  omniFlashTextOutputPerMillionTokens: {
    usd: 9,
    provider: "omni",
    unitLabel: "million text/thinking output tokens",
    verified: true,
  },
  omniFlashVideoOutputPerMillionTokens: {
    usd: 17.5,
    provider: "omni",
    unitLabel: "million video output tokens",
    verified: true,
  },
  geminiProInputPerMillionTokens: {
    usd: 2,
    provider: "gemini",
    unitLabel: "million input tokens up to 200k",
    verified: true,
  },
  geminiProLargeInputPerMillionTokens: {
    usd: 4,
    provider: "gemini",
    unitLabel: "million input tokens above 200k",
    verified: true,
  },
  geminiProOutputPerMillionTokens: {
    usd: 12,
    provider: "gemini",
    unitLabel: "million output/thinking tokens up to 200k input",
    verified: true,
  },
  geminiProLargeOutputPerMillionTokens: {
    usd: 18,
    provider: "gemini",
    unitLabel: "million output/thinking tokens above 200k input",
    verified: true,
  },
  /** VERIFIED 2026-07-13 — gemini-3-pro-image (Nano Banana Pro) edit, premium tier. */
  geminiImageEditPerImage: {
    usd: 0.13,
    provider: "gemini",
    unitLabel: "image",
    verified: true,
  },
  /** VERIFIED 2026-07-11 — gemini-3.1-pro-preview video-native judge call (flat per-call figure). */
  geminiJudgePerCall: {
    usd: 0.02,
    provider: "gemini",
    unitLabel: "call",
    verified: true,
  },
  /** VERIFIED 2026-07-11 — gemini-3.1-pro-preview manifest extraction (flat per-call figure). */
  geminiManifestPerCall: {
    usd: 0.02,
    provider: "gemini",
    unitLabel: "call",
    verified: true,
  },
  /** VERIFIED 2026-07-13 — claude-fable-5 frame-grid judge call ($10/$50 per MTok, ~2x Opus; incl. always-on thinking). */
  claudeJudgePerCall: {
    usd: 0.12,
    provider: "claude",
    unitLabel: "call",
    verified: true,
  },
  /** VERIFIED 2026-07-15 — sync/lipsync-2-pro official Replicate model page. */
  lipsync2ProPerOutputSecond: {
    usd: 0.08325,
    provider: "replicate",
    unitLabel: "output second",
    verified: true,
  },
  /** PLACEHOLDER — update from primary docs before live mode. Local ffmpeg: $0 by construction. */
  audioRemuxFfmpeg: {
    usd: 0,
    provider: "local",
    unitLabel: "remux",
    verified: false,
  },
} satisfies Record<string, PriceEntry>;

const TOKENS_PER_MILLION = 1_000_000;
const GEMINI_PRO_LONG_CONTEXT_THRESHOLD = 200_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Assert the billable Omni counters and retain the provider object unchanged. */
export function requireOmniUsage(value: unknown): OmniUsageSnapshot {
  if (!isRecord(value)) {
    throw new Error("Completed Omni interaction returned no usage metadata.");
  }
  if (
    !isTokenCount(value.total_input_tokens) ||
    !isTokenCount(value.total_output_tokens) ||
    (value.total_thought_tokens !== undefined &&
      !isTokenCount(value.total_thought_tokens)) ||
    !Array.isArray(value.output_tokens_by_modality) ||
    value.output_tokens_by_modality.some(
      (item) =>
        !isRecord(item) ||
        typeof item.modality !== "string" ||
        !isTokenCount(item.tokens)
    )
  ) {
    throw new Error("Completed Omni interaction returned invalid usage metadata.");
  }
  return value as OmniUsageSnapshot;
}

/** Price one completed Omni interaction from usage, including thinking. */
export function omniCostFromUsage(usage: OmniUsageSnapshot): number {
  const videoOutputTokens = usage.output_tokens_by_modality
    .filter((item) => item.modality.toUpperCase() === "VIDEO")
    .reduce((sum, item) => sum + item.tokens, 0);
  if (videoOutputTokens <= 0) {
    throw new Error("Completed Omni interaction reported no video output usage.");
  }
  if (videoOutputTokens > usage.total_output_tokens) {
    throw new Error("Omni video output usage exceeds its total output usage.");
  }
  const textOutputTokens = usage.total_output_tokens - videoOutputTokens;
  const thinkingTokens = usage.total_thought_tokens ?? 0;
  return (
    (usage.total_input_tokens *
      PRICE_TABLE.omniFlashInputPerMillionTokens.usd +
      videoOutputTokens *
        PRICE_TABLE.omniFlashVideoOutputPerMillionTokens.usd +
      (textOutputTokens + thinkingTokens) *
        PRICE_TABLE.omniFlashTextOutputPerMillionTokens.usd) /
    TOKENS_PER_MILLION
  );
}

/** Assert the billable Pro counters and retain the provider object unchanged. */
export function requireGeminiProUsage(
  value: unknown
): GeminiProUsageSnapshot {
  if (!isRecord(value)) {
    throw new Error("Completed Gemini Pro evaluation returned no usage metadata.");
  }
  if (
    !isTokenCount(value.promptTokenCount) ||
    !isTokenCount(value.candidatesTokenCount) ||
    (value.thoughtsTokenCount !== undefined &&
      !isTokenCount(value.thoughtsTokenCount))
  ) {
    throw new Error(
      "Completed Gemini Pro evaluation returned invalid usage metadata."
    );
  }
  return value as GeminiProUsageSnapshot;
}

/** Gemini 3.1 Pro switches both rates when the prompt exceeds 200k tokens. */
export function geminiProCostFromUsage(
  usage: GeminiProUsageSnapshot
): number {
  const longContext =
    usage.promptTokenCount > GEMINI_PRO_LONG_CONTEXT_THRESHOLD;
  const inputRate = longContext
    ? PRICE_TABLE.geminiProLargeInputPerMillionTokens.usd
    : PRICE_TABLE.geminiProInputPerMillionTokens.usd;
  const outputRate = longContext
    ? PRICE_TABLE.geminiProLargeOutputPerMillionTokens.usd
    : PRICE_TABLE.geminiProOutputPerMillionTokens.usd;
  return (
    (usage.promptTokenCount * inputRate +
      (usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0)) *
        outputRate) /
    TOKENS_PER_MILLION
  );
}

/** Conservative pre-call reservation for one Omni generation. */
export function omniGenerationReservationUsd(durationSec: number): number {
  return (
    durationSec * PRICE_TABLE.omniFlashPerOutputSecond.usd +
    (OMNI_INPUT_RESERVATION_TOKENS *
      PRICE_TABLE.omniFlashInputPerMillionTokens.usd) /
      TOKENS_PER_MILLION +
    (OMNI_TEXT_AND_THINKING_RESERVATION_TOKENS *
      PRICE_TABLE.omniFlashTextOutputPerMillionTokens.usd) /
      TOKENS_PER_MILLION
  );
}

/** Conservative pre-call reservation for Lamp's fixed two-pass workflow. */
export function lampRunReservationUsd(durationSec: number): number {
  const evaluatorInputUsd = geminiProCostFromUsage({
    promptTokenCount: LAMP_EVALUATOR_INPUT_RESERVATION_TOKENS,
    candidatesTokenCount: 0,
  });
  const evaluatorOutputUsd = geminiProCostFromUsage({
    promptTokenCount: 0,
    candidatesTokenCount:
      LAMP_EVALUATOR_OUTPUT_AND_THINKING_RESERVATION_TOKENS,
  });
  return (
    omniGenerationReservationUsd(durationSec) * LAMP_GENERATION_COUNT +
    (evaluatorInputUsd + evaluatorOutputUsd) * LAMP_EVALUATION_COUNT +
    durationSec * PRICE_TABLE.lipsync2ProPerOutputSecond.usd
  );
}

/** Conservative reservation for exactly one Gemini Pro cleanup-plan call. */
export function lampBackgroundPlanReservationUsd(): number {
  return geminiProCostFromUsage({
    promptTokenCount: LAMP_BACKGROUND_PLAN_INPUT_RESERVATION_TOKENS,
    candidatesTokenCount:
      LAMP_BACKGROUND_PLAN_OUTPUT_AND_THINKING_RESERVATION_TOKENS,
  });
}

/**
 * Conservative reservation for cleanup execution after plan approval.
 * The already-completed planner call is deliberately excluded.
 */
export function lampBackgroundTwoPassReservationUsd(
  durationSec: number
): number {
  const evaluatorReservationUsd = geminiProCostFromUsage({
    promptTokenCount: LAMP_BACKGROUND_EVALUATOR_INPUT_RESERVATION_TOKENS,
    candidatesTokenCount:
      LAMP_BACKGROUND_EVALUATOR_OUTPUT_AND_THINKING_RESERVATION_TOKENS,
  });
  return (
    omniGenerationReservationUsd(durationSec) *
      LAMP_BACKGROUND_GENERATION_COUNT +
    evaluatorReservationUsd * LAMP_BACKGROUND_EVALUATION_COUNT +
    durationSec * PRICE_TABLE.lipsync2ProPerOutputSecond.usd
  );
}

/** Price a completed Lipsync-2-Pro repair from its actual output duration. */
export function lipsync2ProCostFromDuration(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("Lipsync output duration must be positive and finite.");
  }
  return durationSec * PRICE_TABLE.lipsync2ProPerOutputSecond.usd;
}

// ---------------------------------------------------------------------------
// Registry-driven counts — the estimate must move with the config, never drift
// ---------------------------------------------------------------------------

/** Evals the judges are paid to look at: everything that is not purely deterministic. */
function judgedEvalCount(): number {
  return EVAL_DEFS.filter((d) => d.method !== "deterministic").length;
}

/** Deterministic checks: local code, no model call, $0 forever. */
function deterministicEvalCount(): number {
  return EVAL_DEFS.filter((d) => d.method === "deterministic").length;
}

/** Rate for one judge call, keyed off the configured judge id. */
export function judgeCallUsd(judge: JudgeId): number {
  return judge === "claude"
    ? PRICE_TABLE.claudeJudgePerCall.usd
    : PRICE_TABLE.geminiJudgePerCall.usd;
}

function total(items: CostItem[]): CostEstimate {
  return { items, totalUsd: items.reduce((sum, it) => sum + it.usd, 0) };
}

// ---------------------------------------------------------------------------
// Estimators
// ---------------------------------------------------------------------------

/** Stage A: scene manifest + one anchor relight + one still-tier anchor check. */
export function estimateStageA(): CostEstimate {
  return total([
    {
      label: "Scene manifest extraction",
      provider: PRICE_TABLE.geminiManifestPerCall.provider,
      units: 1,
      unitLabel: PRICE_TABLE.geminiManifestPerCall.unitLabel,
      usd: PRICE_TABLE.geminiManifestPerCall.usd,
    },
    {
      label: "Look Anchor relight (still tier)",
      provider: PRICE_TABLE.geminiImageEditPerImage.provider,
      units: 1,
      unitLabel: PRICE_TABLE.geminiImageEditPerImage.unitLabel,
      usd: PRICE_TABLE.geminiImageEditPerImage.usd,
    },
    {
      label: "Anchor check (still-tier judge)",
      provider: PRICE_TABLE.geminiJudgePerCall.provider,
      units: 1,
      unitLabel: PRICE_TABLE.geminiJudgePerCall.unitLabel,
      usd: PRICE_TABLE.geminiJudgePerCall.usd,
    },
  ]);
}

/**
 * One loop iteration: 1 video generation of durationSec, every judged eval
 * scored by every configured judge, deterministic checks at $0.
 */
export function estimateIteration(durationSec: number): CostEstimate {
  const judged = judgedEvalCount();
  return total([
    {
      label: `Video generation (${durationSec.toFixed(0)}s)`,
      provider: PRICE_TABLE.omniFlashPerOutputSecond.provider,
      units: durationSec,
      unitLabel: "output seconds",
      usd: durationSec * PRICE_TABLE.omniFlashPerOutputSecond.usd,
    },
    ...FLORA_WORKFLOW.config.judges.map(
      (judge): CostItem => ({
        label: `${judged} judged evals — ${judge}`,
        provider: judge,
        units: judged,
        unitLabel: "calls",
        usd: judged * judgeCallUsd(judge),
      })
    ),
    {
      label: `${deterministicEvalCount()} deterministic checks (local code)`,
      provider: "local",
      units: deterministicEvalCount(),
      unitLabel: "checks",
      usd: 0,
    },
  ]);
}

/**
 * Durable production milestone: one generated cut plus local audio remux,
 * with no manifest, anchor, paid judges, or automatic correction attempts.
 */
export function estimateFirstCut(durationSec: number): CostEstimate {
  return total([
    {
      label: `First-cut video generation (${durationSec.toFixed(1)}s)`,
      provider: PRICE_TABLE.omniFlashPerOutputSecond.provider,
      units: durationSec,
      unitLabel: PRICE_TABLE.omniFlashPerOutputSecond.unitLabel,
      usd: durationSec * PRICE_TABLE.omniFlashPerOutputSecond.usd,
    },
    {
      label: "First-cut source and prompt input (estimated)",
      provider: PRICE_TABLE.omniFlashInputPerMillionTokens.provider,
      units: ESTIMATED_OMNI_INPUT_TOKENS,
      unitLabel: "input tokens",
      usd:
        (ESTIMATED_OMNI_INPUT_TOKENS *
          PRICE_TABLE.omniFlashInputPerMillionTokens.usd) /
        TOKENS_PER_MILLION,
    },
    {
      label: "Original-audio remux and verification",
      provider: "local",
      units: 1,
      unitLabel: "cut",
      usd: 0,
    },
  ]);
}

/**
 * Lamp's exact fixed workflow: initial generation, one whole-video critique,
 * one final regeneration, and one final whole-video evaluation. The original
 * audio is remuxed and verified after each generation at no provider cost.
 */
export function estimateLampRun(durationSec: number): CostEstimate {
  const evaluatorOutputEstimate = geminiProCostFromUsage({
    promptTokenCount: 0,
    candidatesTokenCount:
      ESTIMATED_LAMP_EVALUATOR_OUTPUT_AND_THINKING_TOKENS,
  });
  const evaluatorInputEstimate = geminiProCostFromUsage({
    promptTokenCount: ESTIMATED_LAMP_EVALUATOR_INPUT_TOKENS,
    candidatesTokenCount: 0,
  });
  return total([
    {
      label: `Two video generations (${durationSec.toFixed(1)}s each)`,
      provider: PRICE_TABLE.omniFlashPerOutputSecond.provider,
      units: durationSec * LAMP_GENERATION_COUNT,
      unitLabel: PRICE_TABLE.omniFlashPerOutputSecond.unitLabel,
      usd:
        durationSec *
        LAMP_GENERATION_COUNT *
        PRICE_TABLE.omniFlashPerOutputSecond.usd,
    },
    {
      label: "Two source-and-prompt generation inputs (estimated)",
      provider: PRICE_TABLE.omniFlashInputPerMillionTokens.provider,
      units: ESTIMATED_OMNI_INPUT_TOKENS * LAMP_GENERATION_COUNT,
      unitLabel: "input tokens",
      usd:
        (ESTIMATED_OMNI_INPUT_TOKENS *
          LAMP_GENERATION_COUNT *
          PRICE_TABLE.omniFlashInputPerMillionTokens.usd) /
        TOKENS_PER_MILLION,
    },
    {
      label: "Two whole-video evaluation inputs (estimated)",
      provider: PRICE_TABLE.geminiProInputPerMillionTokens.provider,
      units: ESTIMATED_LAMP_EVALUATOR_INPUT_TOKENS * LAMP_EVALUATION_COUNT,
      unitLabel: "input tokens",
      usd: evaluatorInputEstimate * LAMP_EVALUATION_COUNT,
    },
    {
      label: "Two whole-video evaluation outputs (estimated)",
      provider: PRICE_TABLE.geminiProOutputPerMillionTokens.provider,
      units:
        ESTIMATED_LAMP_EVALUATOR_OUTPUT_AND_THINKING_TOKENS *
        LAMP_EVALUATION_COUNT,
      unitLabel: "output/thinking tokens",
      usd: evaluatorOutputEstimate * LAMP_EVALUATION_COUNT,
    },
    {
      label: "One possible Lipsync-2-Pro repair",
      provider: PRICE_TABLE.lipsync2ProPerOutputSecond.provider,
      units: durationSec,
      unitLabel: PRICE_TABLE.lipsync2ProPerOutputSecond.unitLabel,
      usd: durationSec * PRICE_TABLE.lipsync2ProPerOutputSecond.usd,
    },
    {
      label: "Original-audio remux and verification (both cuts)",
      provider: "local",
      units: LAMP_GENERATION_COUNT,
      unitLabel: "cuts",
      usd: 0,
    },
  ]);
}

/** One Gemini Pro video-native proposal before any background generation. */
export function estimateLampBackgroundPlan(): CostEstimate {
  const inputUsd = geminiProCostFromUsage({
    promptTokenCount: ESTIMATED_LAMP_BACKGROUND_PLAN_INPUT_TOKENS,
    candidatesTokenCount: 0,
  });
  const outputUsd = geminiProCostFromUsage({
    promptTokenCount: 0,
    candidatesTokenCount:
      ESTIMATED_LAMP_BACKGROUND_PLAN_OUTPUT_AND_THINKING_TOKENS,
  });
  return total([
    {
      label: "Cleanup-plan source and instruction input (estimated)",
      provider: PRICE_TABLE.geminiProInputPerMillionTokens.provider,
      units: ESTIMATED_LAMP_BACKGROUND_PLAN_INPUT_TOKENS,
      unitLabel: "input tokens",
      usd: inputUsd,
    },
    {
      label: "Cleanup-plan structured output (estimated)",
      provider: PRICE_TABLE.geminiProOutputPerMillionTokens.provider,
      units:
        ESTIMATED_LAMP_BACKGROUND_PLAN_OUTPUT_AND_THINKING_TOKENS,
      unitLabel: "output/thinking tokens",
      usd: outputUsd,
    },
  ]);
}

/**
 * Lamp Background execution after plan approval: Initial, one holistic
 * critique, Final, one holistic evaluation, and at most one Final lipsync
 * repair. Planning is priced and approved separately.
 */
export function estimateLampBackgroundTwoPass(
  durationSec: number
): CostEstimate {
  const evaluatorInputEstimate = geminiProCostFromUsage({
    promptTokenCount: ESTIMATED_LAMP_BACKGROUND_EVALUATOR_INPUT_TOKENS,
    candidatesTokenCount: 0,
  });
  const evaluatorOutputEstimate = geminiProCostFromUsage({
    promptTokenCount: 0,
    candidatesTokenCount:
      ESTIMATED_LAMP_BACKGROUND_EVALUATOR_OUTPUT_AND_THINKING_TOKENS,
  });
  return total([
    {
      label: `Two background-cleanup video generations (${durationSec.toFixed(1)}s each)`,
      provider: PRICE_TABLE.omniFlashPerOutputSecond.provider,
      units: durationSec * LAMP_BACKGROUND_GENERATION_COUNT,
      unitLabel: PRICE_TABLE.omniFlashPerOutputSecond.unitLabel,
      usd:
        durationSec *
        LAMP_BACKGROUND_GENERATION_COUNT *
        PRICE_TABLE.omniFlashPerOutputSecond.usd,
    },
    {
      label: "Two cleanup generation inputs (estimated)",
      provider: PRICE_TABLE.omniFlashInputPerMillionTokens.provider,
      units:
        ESTIMATED_OMNI_INPUT_TOKENS * LAMP_BACKGROUND_GENERATION_COUNT,
      unitLabel: "input tokens",
      usd:
        (ESTIMATED_OMNI_INPUT_TOKENS *
          LAMP_BACKGROUND_GENERATION_COUNT *
          PRICE_TABLE.omniFlashInputPerMillionTokens.usd) /
        TOKENS_PER_MILLION,
    },
    {
      label: "Two cleanup evaluation inputs (estimated)",
      provider: PRICE_TABLE.geminiProInputPerMillionTokens.provider,
      units:
        ESTIMATED_LAMP_BACKGROUND_EVALUATOR_INPUT_TOKENS *
        LAMP_BACKGROUND_EVALUATION_COUNT,
      unitLabel: "input tokens",
      usd:
        evaluatorInputEstimate * LAMP_BACKGROUND_EVALUATION_COUNT,
    },
    {
      label: "Two cleanup evaluation outputs (estimated)",
      provider: PRICE_TABLE.geminiProOutputPerMillionTokens.provider,
      units:
        ESTIMATED_LAMP_BACKGROUND_EVALUATOR_OUTPUT_AND_THINKING_TOKENS *
        LAMP_BACKGROUND_EVALUATION_COUNT,
      unitLabel: "output/thinking tokens",
      usd:
        evaluatorOutputEstimate * LAMP_BACKGROUND_EVALUATION_COUNT,
    },
    {
      label: "One possible Final Lipsync-2-Pro repair",
      provider: PRICE_TABLE.lipsync2ProPerOutputSecond.provider,
      units: durationSec,
      unitLabel: PRICE_TABLE.lipsync2ProPerOutputSecond.unitLabel,
      usd: durationSec * PRICE_TABLE.lipsync2ProPerOutputSecond.usd,
    },
    {
      label: "Original-audio remux and verification (both cleanup cuts)",
      provider: "local",
      units: LAMP_BACKGROUND_GENERATION_COUNT,
      unitLabel: "cuts",
      usd: 0,
    },
  ]);
}

/**
 * Whole run: Stage A once + expectedIterations × one iteration + local remux.
 * 2.5 expected iterations reflects observed loop behavior (most runs settle
 * in 2–3); the run's cost ledger records what each run actually consumed.
 */
export function estimateRun(
  durationSec: number,
  expectedIterations = 2.5
): CostEstimate {
  return total([
    ...estimateStageA().items,
    ...estimateIteration(durationSec).items.map(
      (it): CostItem => ({
        ...it,
        label: `${it.label} × ${expectedIterations} expected iterations`,
        units: it.units * expectedIterations,
        usd: it.usd * expectedIterations,
      })
    ),
    {
      label: "Audio remux (ffmpeg)",
      provider: PRICE_TABLE.audioRemuxFfmpeg.provider,
      units: 1,
      unitLabel: PRICE_TABLE.audioRemuxFfmpeg.unitLabel,
      usd: PRICE_TABLE.audioRemuxFfmpeg.usd,
    },
  ]);
}

/** Batch: the sum of per-clip run estimates; items keep their clip prefix for breakdowns. */
export function estimateBatch(videos: VideoAsset[]): CostEstimate {
  return total(
    videos.flatMap((video) =>
      estimateRun(video.durationSec).items.map((it) => ({
        ...it,
        label: `${video.label} — ${it.label}`,
      }))
    )
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "$0.42" — two decimals; tiny-but-nonzero renders "<$0.01", never "$0.00". */
export function formatUsd(n: number): string {
  // Snap at 4 decimals before rounding to cents so fp accumulation noise
  // (e.g. 11.64499999999999957 for a true 11.645) cannot flip the cent.
  const cents = Math.round(Number((n * 100).toFixed(4)));
  if (n > 0 && cents === 0) return "<$0.01";
  return `$${(cents / 100).toFixed(2)}`;
}
