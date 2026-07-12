/**
 * lib/cost.ts — cost governance: the single source of price truth.
 *
 * Standing rule: the team lead is never surprised by spend. Every action in
 * the app shows its estimated live cost BEFORE it runs, every run keeps a
 * cost ledger (Run.cost, driven by lib/engine.ts), and batches can carry a
 * hard budget cap (Batch.budgetUsd, enforced by the lib/store.ts worker queue).
 *
 * MOCK MODE: nothing costs money — every figure this module produces is an
 * "est. live cost": what the run/batch WOULD cost against the real APIs.
 * When live adapters land, actuals accrue through the same Run.cost ledger
 * and this table becomes the rate card. Never render a number from this
 * module without an est/actual label.
 *
 * Estimators are driven by the ACTUAL registry/config (EVAL_DEFS,
 * RELIGHT_WORKFLOW.config) — never hardcoded counts — so adding an eval or a
 * judge automatically moves every estimate in the app.
 */

import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { RELIGHT_WORKFLOW } from "@/lib/workflow-def";
import type { JudgeId, VideoAsset } from "@/lib/types";

// ---------------------------------------------------------------------------
// Cost item (lives here, not in lib/types.ts, to keep the core contract stable)
// ---------------------------------------------------------------------------

export interface CostItem {
  label: string;
  provider: "gemini" | "omni" | "claude" | "local";
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
  /** VERIFIED 2026-07-11 — Gemini Omni Flash video-to-video, per output second. */
  omniFlashPerOutputSecond: {
    usd: 0.1,
    provider: "omni",
    unitLabel: "output second",
    verified: true,
  },
  /** VERIFIED 2026-07-11 — gemini-3.1-flash-image edit at 1K output. */
  geminiImageEditPerImage: {
    usd: 0.07,
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
  /** VERIFIED 2026-07-11 — claude-opus-4-8 frame-grid judge call (flat per-call figure). */
  claudeJudgePerCall: {
    usd: 0.04,
    provider: "claude",
    unitLabel: "call",
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
    ...RELIGHT_WORKFLOW.config.judges.map(
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
