/**
 * Live Omni Flash video-generation adapter — thin fetch() client of
 * POST /api/live/videogen/start + /poll.
 *
 * CLIENT-SAFE: no SDK imports, no keys. The route does the heavy lifting
 * (upload, background generation, download, audio remux + verification).
 * Starting returns a durable Workflow id promptly. Workflow owns provider
 * polling/finalization even after the browser closes; this client only watches
 * status so the in-tab engine can continue into judging when the result lands.
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

const START_TIMEOUT_MS = 4 * 60_000;
const POLL_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 8_000;

interface StartResponse {
  workflowRunId: string;
  status: string;
  startedAt: number;
}

interface VideogenResponse {
  done: true;
  status: "completed";
  videoUrl: string;
  rawUrl: string;
  interactionId: string;
  durationSec: number;
  audioVerified: boolean;
  costUsd: number;
}

interface PendingResponse {
  done: false;
  status: string;
}

export class LiveOmniProvider implements VideoGenProvider {
  info: ProviderInfo = { id: "omni", model: "gemini-omni-flash-preview", mock: false };

  constructor(private readonly ctx: LiveRunContext) {}

  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    const started = Date.now();
    const start = await postJson<StartResponse>(
      "/api/live/videogen/start",
      {
        runId: this.ctx.runId,
        iteration: req.iteration,
        prompt: renderMegaPrompt(req.megaPrompt),
      },
      START_TIMEOUT_MS
    );
    let res: VideogenResponse;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const polled = await postJson<VideogenResponse | PendingResponse>(
        "/api/live/videogen/poll",
        {
          runId: this.ctx.runId,
          iteration: req.iteration,
          workflowRunId: start.workflowRunId,
        },
        POLL_TIMEOUT_MS
      );
      if (polled.done) {
        res = polled;
        break;
      }
    }

    // Bookkeeping the engine folds into the run: the interaction id is kept
    // for provenance display only (generations never chain interaction
    // state); audioVerified drives the deterministic audio-integrity gate.
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
