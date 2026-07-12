/**
 * Provider registry — the ONLY seam that changes between mock and live.
 *
 * Live mode returns thin fetch() clients of the /api/live routes
 * (lib/providers/live-*.ts). They share one LiveRunContext per run: the
 * engine creates it, the providers maintain the interaction-id chains
 * (anchor and videogen separately) and report every billed response's
 * actual cost through ctx.onCost.
 */

import type { ProviderBundle } from "@/lib/types";
import { MockOmniProvider } from "./mock-omni";
import { MockGeminiImageProvider, MockGeminiJudge } from "./mock-gemini";
import { MockClaudeJudge } from "./mock-claude";
import { LiveOmniProvider } from "./live-omni";
import { LiveGeminiImageProvider, LiveGeminiJudge } from "./live-gemini";
import { LiveClaudeJudge } from "./live-claude";
import type { LiveRunContext } from "./live-gemini";

export type { LiveRunContext, LiveVideogenOutcome } from "./live-gemini";

export interface ProviderOptions {
  /** Mock-only: zero out all simulated latencies (demo-run seeding). */
  instant?: boolean;
  /** Live-only: the per-run shared context (required when mode === "live"). */
  live?: LiveRunContext;
}

export function getProviders(
  mode: "mock" | "live",
  opts: ProviderOptions = {}
): ProviderBundle {
  if (mode === "live") {
    const ctx = opts.live;
    if (!ctx) {
      throw new Error('getProviders("live") requires a LiveRunContext in opts.live');
    }
    return {
      videoGen: new LiveOmniProvider(ctx),
      imageGen: new LiveGeminiImageProvider(ctx),
      judges: {
        claude: new LiveClaudeJudge(ctx),
        gemini: new LiveGeminiJudge(ctx),
      },
    };
  }
  return {
    videoGen: new MockOmniProvider(opts),
    imageGen: new MockGeminiImageProvider(opts),
    judges: {
      claude: new MockClaudeJudge(opts),
      gemini: new MockGeminiJudge(opts),
    },
  };
}
