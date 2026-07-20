import type { LampCombinedIteration } from "./lamp-combined.ts";
import {
  v2SyncVerdict,
  type SyncNetMetrics,
} from "./v2-sync-verdict.ts";

export const LAMP_COMBINED_MIN_SPEECH_WINDOW = 0.2;

export interface WorkflowSafeCombinedSyncWindow {
  startSec: number;
  durationSec: number;
  source: SyncNetMetrics;
  candidate: SyncNetMetrics;
}

export interface WorkflowSafeCombinedLipsyncResult {
  iteration: LampCombinedIteration;
  videoUrl: string;
  postSync: SyncNetMetrics;
  sourceSync: SyncNetMetrics;
  windows: WorkflowSafeCombinedSyncWindow[];
}

export interface LampCombinedMandatorySyncVerdict {
  pass: boolean;
  reason: string;
  failedWindowStartSec?: number;
}

export function lampCombinedLipsyncOperationId(
  iteration: LampCombinedIteration
): `lipsync:${LampCombinedIteration}` {
  return `lipsync:${iteration}`;
}

/** Workflow-isolate-safe release policy; never import hashing or Node modules. */
export function lampCombinedMandatorySyncVerdict(input: {
  postSync: SyncNetMetrics;
  sourceSync: SyncNetMetrics;
  windows: readonly WorkflowSafeCombinedSyncWindow[];
}): LampCombinedMandatorySyncVerdict {
  const wholeClip = v2SyncVerdict(input.postSync, input.sourceSync);
  if (!wholeClip.pass) {
    return { pass: false, reason: `Whole-clip check failed: ${wholeClip.reason}` };
  }
  const speechWindows = input.windows.filter(
    (window) => window.source.speechPercentage >= LAMP_COMBINED_MIN_SPEECH_WINDOW
  );
  if (
    input.sourceSync.speechPercentage >= LAMP_COMBINED_MIN_SPEECH_WINDOW &&
    speechWindows.length === 0
  ) {
    return {
      pass: false,
      reason: "No speech-bearing window was available for the mandatory local sync gate.",
    };
  }
  for (const window of speechWindows) {
    const verdict = v2SyncVerdict(window.candidate, window.source);
    if (!verdict.pass) {
      return {
        pass: false,
        failedWindowStartSec: window.startSec,
        reason: `Window ${window.startSec.toFixed(2)}-${(
          window.startSec + window.durationSec
        ).toFixed(2)}s failed: ${verdict.reason}`,
      };
    }
  }
  return {
    pass: true,
    reason: `Whole clip and ${speechWindows.length} speech-bearing windows passed the source-relative gate.`,
  };
}
