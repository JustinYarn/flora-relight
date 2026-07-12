/**
 * Mock Claude vision-judge adapter.
 *
 * Judge behavior: Claude lands `judgeSpread / 2` ABOVE the scripted base
 * score (Gemini lands the same amount below — the mean recovers the base),
 * and it reports EVERY scripted violation including minor ones. The two
 * judges' distance is what drives the measured confidence meter.
 */

import { clamp, sleep, verdictFor } from "@/lib/util";
import { getScenarioOutcome } from "@/lib/mock/scenario";
import type {
  EvalCategory,
  JudgeRequest,
  JudgeVerdict,
  ProviderInfo,
  Violation,
  VisionJudgeProvider,
} from "@/lib/types";

interface MockClaudeOptions {
  /** Zero out latencies (used when seeding the demo run). */
  instant?: boolean;
}

const CLAUDE_EVIDENCE: Record<EvalCategory, string> = {
  identity:
    "eye spacing, jawline, and nose bridge read identical on the hardest frame, not just on average",
  appearance:
    "the crew-neck collar line, the thin necklace, and the hair part are all present and unaltered",
  background:
    "the door frame and bookshelf edge sit in identical positions and the wall stays unbroken",
  lighting: "key placement, fill ratio, and where the highlights fall on the face",
  motion: "lip shapes and gesture timing track the original frame-for-frame",
  temporal: "illumination holds steady across consecutive samples — no pulsing or drift",
  hallucination: "every object in frame exists in the source; nothing invented, nothing removed",
  audio: "deterministic hash comparison — no perceptual judgment involved",
  framing: "crop, headroom, and lens feel match the source",
};

function capitalize(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function claudeReasoning(
  req: JudgeRequest,
  score: number,
  violations: Violation[]
): string {
  const pairs = Math.max(req.beforeFrames.length, 1);
  if (violations.length === 0) {
    return `Compared ${pairs} matched frame pairs, weighting the hardest ones: ${CLAUDE_EVIDENCE[req.evalDef.category]}. Nothing beyond the lighting change itself moves against the ${req.evalDef.name} rubric.`;
  }
  const v = violations[0];
  const where =
    v.frameTimestampSec !== undefined ? ` — clearest around ${v.frameTimestampSec}s` : "";
  const rest =
    violations.length > 1
      ? ` I also recorded ${violations.length - 1} further issue${violations.length > 2 ? "s" : ""} on this rubric.`
      : "";
  return `${capitalize(v.description)}${where}. That is a ${v.severity} deviation, so I scored this ${Math.round(score)}.${rest}`;
}

export class MockClaudeJudge implements VisionJudgeProvider {
  info: ProviderInfo = { id: "claude", model: "claude-opus-4-8 (mock)", mock: true };

  private readonly opts: MockClaudeOptions;

  constructor(opts: MockClaudeOptions = {}) {
    this.opts = opts;
  }

  async judge(req: JudgeRequest): Promise<JudgeVerdict> {
    await sleep(this.opts.instant ? 0 : 250 + Math.random() * 350);
    const outcome = getScenarioOutcome(req.iteration, req.evalDef.id);
    const base = outcome?.score ?? 90;
    const spread = outcome?.judgeSpread ?? 4;
    const score = clamp(base + spread / 2, 0, 100);
    const violations = (outcome?.violations ?? []).map((v) => ({ ...v }));
    return {
      judge: "claude",
      score,
      verdict: verdictFor(score, req.evalDef.passThreshold, req.evalDef.borderlineThreshold),
      violations,
      reasoning: claudeReasoning(req, score, violations),
    };
  }
}
