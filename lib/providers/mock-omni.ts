/**
 * Mock Omni video-generation adapter.
 *
 * The real adapter will upload the original video + conditioning frame and
 * poll a generation job. This mock sleeps for the scenario's scripted latency
 * and returns the ORIGINAL url with a `simulatedFilter` — the UI and the
 * frame sampler render that filter to fake the generated look.
 *
 * Structural guarantee carried into the mock: the request type has no audio
 * field and the returned asset reports `hasAudio: false`. Audio only ever
 * re-enters at the remux stage, from the original file.
 */

import { sleep, uid } from "@/lib/util";
import { getScenarioIteration } from "@/lib/mock/scenario";
import type {
  ProviderInfo,
  VideoGenProvider,
  VideoGenRequest,
  VideoGenResult,
} from "@/lib/types";

interface MockOmniOptions {
  /** Zero out latencies (used when seeding the demo run). */
  instant?: boolean;
}

export class MockOmniProvider implements VideoGenProvider {
  info: ProviderInfo = { id: "omni", model: "omni-video-1 (mock)", mock: true };

  private readonly opts: MockOmniOptions;

  constructor(opts: MockOmniOptions = {}) {
    this.opts = opts;
  }

  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    const scenarioIter = getScenarioIteration(req.iteration);
    await sleep(this.opts.instant ? 0 : scenarioIter.videoGenLatencyMs);
    return {
      video: {
        id: uid("video"),
        kind: "generated",
        url: req.originalVideo.url, // mock: same pixels + simulatedFilter
        label: `Omni generation v${req.iteration}`,
        durationSec: req.originalVideo.durationSec,
        width: req.originalVideo.width,
        height: req.originalVideo.height,
        hasAudio: false, // the generative path never carries audio
        simulatedFilter: scenarioIter.simulatedFilter,
      },
      latencyMs: scenarioIter.videoGenLatencyMs,
    };
  }
}
