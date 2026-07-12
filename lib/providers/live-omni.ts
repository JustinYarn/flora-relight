/**
 * Live Omni Flash video-generation adapter — thin fetch() client of
 * POST /api/live/videogen.
 *
 * CLIENT-SAFE: no SDK imports, no keys. The route does the heavy lifting
 * (upload, generation, download, audio remux + verification); a call blocks
 * 1-7 minutes, so the timeout is a generous 8 minutes.
 *
 * Structural guarantee preserved from the mocks: the request carries no
 * audio, and the returned asset's audio is the ORIGINAL stream remuxed
 * server-side (the model's own audio is discarded by construction).
 */

import { uid } from "@/lib/util";
import { renderMegaPrompt } from "@/lib/prompts/mega-prompt";
import type {
  ProviderInfo,
  VideoGenProvider,
  VideoGenRequest,
  VideoGenResult,
} from "@/lib/types";
import { postJson, type LiveRunContext } from "./live-gemini";

const VIDEOGEN_TIMEOUT_MS = 8 * 60_000;

interface VideogenResponse {
  videoUrl: string;
  rawUrl: string;
  interactionId: string;
  durationSec: number;
  audioVerified: boolean;
  costUsd: number;
}

export class LiveOmniProvider implements VideoGenProvider {
  info: ProviderInfo = { id: "omni", model: "gemini-omni-flash-preview", mock: false };

  constructor(private readonly ctx: LiveRunContext) {}

  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    const started = Date.now();
    const res = await postJson<VideogenResponse>(
      "/api/live/videogen",
      {
        runId: this.ctx.runId,
        iteration: req.iteration,
        prompt: renderMegaPrompt(req.megaPrompt),
        sourceUrl: req.originalVideo.url,
        previousInteractionId: this.ctx.videoInteractionId,
      },
      VIDEOGEN_TIMEOUT_MS
    );

    // Bookkeeping the engine folds into the run: the interaction id chains
    // the NEXT iteration's correction turn; audioVerified drives the
    // deterministic audio-integrity gate.
    this.ctx.videoInteractionId = res.interactionId;
    this.ctx.lastVideogen = {
      interactionId: res.interactionId,
      audioVerified: res.audioVerified,
      rawUrl: res.rawUrl,
      durationSec: res.durationSec,
      costUsd: res.costUsd,
    };
    this.ctx.onCost(
      `Video generation v${req.iteration} (${res.durationSec.toFixed(1)}s, Omni Flash)`,
      res.costUsd
    );

    return {
      video: {
        id: uid("video"),
        kind: "generated",
        url: res.videoUrl,
        label: `Omni Flash v${req.iteration}`,
        durationSec: res.durationSec,
        width: 1280,
        height: 720,
        hasAudio: true, // original audio already remuxed server-side
      },
      latencyMs: Date.now() - started,
    };
  }
}
