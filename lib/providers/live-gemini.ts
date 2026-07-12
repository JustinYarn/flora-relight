/**
 * Live Gemini adapters — thin fetch() clients of the /api/live routes.
 *
 * CLIENT-SAFE: no SDK imports, no keys — all provider traffic goes through
 * the server routes. This module also hosts the shared LiveRunContext and
 * postJson helper used by every live provider (and the engine's manifest
 * call), so the per-run interaction chains and the actual-cost sink live in
 * exactly one object.
 */

import type {
  ImageGenProvider,
  ImageRelightRequest,
  ImageRelightResult,
  JudgeRequest,
  JudgeVerdict,
  ProviderInfo,
  VisionJudgeProvider,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Shared live plumbing
// ---------------------------------------------------------------------------

/** Facts from the last videogen response the engine folds into the run. */
export interface LiveVideogenOutcome {
  interactionId: string;
  audioVerified: boolean;
  rawUrl: string;
  durationSec: number;
  costUsd: number;
}

/**
 * Per-run mutable context shared between the engine and the live providers.
 * The engine creates one per run; providers read/write the interaction
 * chains and report every billed response through onCost.
 */
export interface LiveRunContext {
  runId: string;
  /** URL of the ORIGINAL clip — the before side of every judge call. */
  beforeUrl: string;
  /** URL of the current iteration's relit clip; set by the engine before judging. */
  afterUrl?: string;
  /** Interaction id chain for Stage-A anchor correction turns. */
  anchorInteractionId?: string;
  /** Interaction id chain for videogen turns (previous iteration's id). */
  videoInteractionId?: string;
  /** Set by LiveOmniProvider after each generation. */
  lastVideogen?: LiveVideogenOutcome;
  /** Actual-cost sink: every live response's costUsd lands here. */
  onCost: (label: string, usd: number) => void;
}

/** POST JSON with a hard timeout; throws the route's safe error message. */
export async function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const msg =
        data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : `${url} failed (${res.status})`;
      throw new Error(msg);
    }
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

const ANCHOR_TIMEOUT_MS = 2 * 60_000;
const JUDGE_TIMEOUT_MS = 8 * 60_000; // generous: first judge call per run waits behind the shared video upload

// ---------------------------------------------------------------------------
// Image provider (Stage A Look Anchor)
// ---------------------------------------------------------------------------

interface AnchorResponse {
  imageUrl: string;
  interactionId: string;
  costUsd: number;
}

export class LiveGeminiImageProvider implements ImageGenProvider {
  info: ProviderInfo = { id: "gemini", model: "gemini-3.1-flash-image", mock: false };

  constructor(private readonly ctx: LiveRunContext) {}

  async relight(req: ImageRelightRequest): Promise<ImageRelightResult> {
    const started = Date.now();
    const res = await postJson<AnchorResponse>(
      "/api/live/anchor",
      {
        runId: this.ctx.runId,
        frameDataUrl: req.frameDataUrl,
        instruction: req.prompt,
        previousInteractionId: this.ctx.anchorInteractionId,
        version: req.iteration,
      },
      ANCHOR_TIMEOUT_MS
    );
    this.ctx.anchorInteractionId = res.interactionId;
    this.ctx.onCost(`Look Anchor relight v${req.iteration} (Gemini image edit)`, res.costUsd);
    // A served /api/media url — <img src> renders it exactly like a data URL.
    return { imageDataUrl: res.imageUrl, latencyMs: Date.now() - started };
  }
}

// ---------------------------------------------------------------------------
// Vision judge (video-native)
// ---------------------------------------------------------------------------

interface JudgeResponse {
  verdict: JudgeVerdict;
  costUsd: number;
}

export class LiveGeminiJudge implements VisionJudgeProvider {
  info: ProviderInfo = { id: "gemini", model: "gemini-3.1-pro-preview", mock: false };

  constructor(private readonly ctx: LiveRunContext) {}

  async judge(req: JudgeRequest): Promise<JudgeVerdict> {
    if (!this.ctx.afterUrl) {
      throw new Error("Live Gemini judge called before a generated video was available.");
    }
    const res = await postJson<JudgeResponse>(
      "/api/live/judge",
      {
        evalId: req.evalDef.id,
        judge: "gemini",
        rubric: req.evalDef.promptTemplate,
        beforeUrl: this.ctx.beforeUrl,
        afterUrl: this.ctx.afterUrl,
        // The anchor is a labeled reference input for the anchor-match rubric only.
        anchorDataUrl:
          req.evalDef.id === "lighting-match-to-anchor" ? req.anchorFrameDataUrl : undefined,
      },
      JUDGE_TIMEOUT_MS
    );
    this.ctx.onCost(`${req.evalDef.name} — gemini judge (v${req.iteration})`, res.costUsd);
    return res.verdict;
  }
}
