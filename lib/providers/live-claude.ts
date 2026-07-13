/**
 * Live Claude vision judge — thin fetch() client of POST /api/live/judge.
 *
 * CLIENT-SAFE: no SDK imports, no keys. The route extracts Claude's frame
 * grids from canonical stored videos server-side, builds labeled image blocks,
 * and runs claude-opus-4-8 with structured output (json_schema).
 */

import type {
  JudgeRequest,
  JudgeVerdict,
  ProviderInfo,
  VisionJudgeProvider,
} from "@/lib/types";
import { postJson, type LiveRunContext } from "./live-gemini";

const JUDGE_TIMEOUT_MS = 5 * 60_000;

interface JudgeResponse {
  verdict: JudgeVerdict;
  costUsd: number;
}

export class LiveClaudeJudge implements VisionJudgeProvider {
  info: ProviderInfo = { id: "claude", model: "claude-opus-4-8", mock: false };

  constructor(private readonly ctx: LiveRunContext) {}

  async judge(req: JudgeRequest): Promise<JudgeVerdict> {
    const res = await postJson<JudgeResponse>(
      "/api/live/judge",
      {
        runId: this.ctx.runId,
        iteration: req.iteration,
        evalId: req.evalDef.id,
        judge: "claude",
        rubric: req.evalDef.promptTemplate,
        beforeUrl: this.ctx.beforeUrl,
        afterUrl: this.ctx.afterUrl ?? "",
        // The anchor is a labeled reference input for the anchor-match rubric only.
        anchorDataUrl:
          req.evalDef.id === "lighting-match-to-anchor" ? req.anchorFrameDataUrl : undefined,
      },
      JUDGE_TIMEOUT_MS
    );
    this.ctx.onCost(`${req.evalDef.name} — claude judge (v${req.iteration})`, res.costUsd);
    return res.verdict;
  }
}
