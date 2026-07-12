"use client";

/**
 * Mock Gemini adapters — two roles, matching how the real integration will
 * split: an image model for the Stage A "Look Anchor" relight, and a vision
 * judge that scores frame pairs against an eval rubric.
 *
 * Judge behavior: Gemini lands `judgeSpread / 2` BELOW the scripted base
 * score (Claude lands the same amount above), and it drops "minor"
 * violations — simulating real judge disagreement so the measured-confidence
 * meter has something honest to measure.
 */

import { clamp, sleep, verdictFor } from "@/lib/util";
import { getScenarioIteration, getScenarioOutcome } from "@/lib/mock/scenario";
import type {
  EvalCategory,
  ImageGenProvider,
  ImageRelightRequest,
  ImageRelightResult,
  JudgeRequest,
  JudgeVerdict,
  ProviderInfo,
  Violation,
  VisionJudgeProvider,
} from "@/lib/types";

interface MockGeminiOptions {
  /** Zero out latencies (used when seeding the demo run). */
  instant?: boolean;
}

// ---------------------------------------------------------------------------
// Image provider (Stage A anchor relight)
// ---------------------------------------------------------------------------

/** Re-render a data-URL image through a CSS filter on a canvas. */
function applyFilterToDataUrl(dataUrl: string, cssFilter: string): Promise<string> {
  if (typeof document === "undefined") return Promise.resolve(dataUrl);
  return new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || 640;
      canvas.height = img.naturalHeight || 360;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.filter = cssFilter;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export class MockGeminiImageProvider implements ImageGenProvider {
  info: ProviderInfo = { id: "gemini", model: "gemini-3.1-pro-image (mock)", mock: true };

  private readonly opts: MockGeminiOptions;

  constructor(opts: MockGeminiOptions = {}) {
    this.opts = opts;
  }

  async relight(req: ImageRelightRequest): Promise<ImageRelightResult> {
    const latencyMs = this.opts.instant ? 0 : Math.round(1100 + Math.random() * 250);
    await sleep(latencyMs);
    const { keyframeFilter } = getScenarioIteration(req.iteration);
    const imageDataUrl = req.frameDataUrl
      ? await applyFilterToDataUrl(req.frameDataUrl, keyframeFilter)
      : req.frameDataUrl;
    return { imageDataUrl, latencyMs };
  }
}

// ---------------------------------------------------------------------------
// Vision judge
// ---------------------------------------------------------------------------

const GEMINI_EVIDENCE: Record<EvalCategory, string> = {
  identity:
    "facial landmark geometry tracks the source on every sampled frame, including the worst one",
  appearance:
    "blind inventories of both clips list the same tee, necklace, and hair state",
  background:
    "the door frame and bookshelf edge hold position; residual tile differences read as lighting",
  lighting: "key direction, fill ratio, and highlight rolloff on the face",
  motion: "mouth-shape trajectory correlates with the source frame-for-frame",
  temporal: "inter-frame illumination variance stays within tolerance",
  hallucination: "object census matches the source scene exactly",
  audio: "bitstream comparison only; no perceptual judgment required",
  framing: "crop, headroom, and subject position match the source",
};

function geminiReasoning(
  req: JudgeRequest,
  score: number,
  kept: Violation[],
  droppedMinor: number
): string {
  const evidence = GEMINI_EVIDENCE[req.evalDef.category];
  if (kept.length === 0 && droppedMinor > 0) {
    return `Sub-threshold deviation only; not flagging it as a violation. Residual softness against the ${req.evalDef.name} rubric keeps the score at ${Math.round(score)}.`;
  }
  if (kept.length === 0) {
    return `No rubric deviations detected across the sampled frame pairs; ${evidence}.`;
  }
  const v = kept[0];
  const where =
    v.frameTimestampSec !== undefined ? `, clearest near ${v.frameTimestampSec}s` : "";
  return `Flagged ${v.aspect} (${v.severity}${where}): ${v.description}. Score ${Math.round(score)} against the ${req.evalDef.name} rubric.`;
}

export class MockGeminiJudge implements VisionJudgeProvider {
  info: ProviderInfo = { id: "gemini", model: "gemini-3.1-pro (mock)", mock: true };

  private readonly opts: MockGeminiOptions;

  constructor(opts: MockGeminiOptions = {}) {
    this.opts = opts;
  }

  async judge(req: JudgeRequest): Promise<JudgeVerdict> {
    await sleep(this.opts.instant ? 0 : 250 + Math.random() * 350);
    const outcome = getScenarioOutcome(req.iteration, req.evalDef.id);
    const base = outcome?.score ?? 90;
    const spread = outcome?.judgeSpread ?? 4;
    const score = clamp(base - spread / 2, 0, 100);
    const all = outcome?.violations ?? [];
    // Gemini misses/dismisses minor findings — deliberate judge disagreement.
    const kept = all.filter((v) => v.severity !== "minor").map((v) => ({ ...v }));
    return {
      judge: "gemini",
      score,
      verdict: verdictFor(score, req.evalDef.passThreshold, req.evalDef.borderlineThreshold),
      violations: kept,
      reasoning: geminiReasoning(req, score, kept, all.length - kept.length),
    };
  }
}
