import type { Run, VideoAsset } from "../../lib/types.ts";
import {
  isApprovedPlanNoOp,
  isTwoPassWorkflowMode,
  runWorkflowMode,
} from "../../lib/workflow-mode.ts";
import { isLampCombinedRun } from "../../lib/lamp-combined-read.ts";
import {
  finalLampIteration,
  isGradeable,
} from "../grade/derive.ts";

export type SideBySideExportVersion = number | "final" | null;

/** Real generated files live under /api/media; CSS-filter demos do not. */
export function isRealExportVideo(
  video: VideoAsset | undefined
): video is VideoAsset {
  return Boolean(
    video &&
      !video.simulatedFilter &&
      video.url.startsWith("/api/media/")
  );
}

function iterationVersion(
  index: number,
  video: VideoAsset
): number {
  const match = /relit-v(\d+)\.mp4$/.exec(video.url);
  return match ? Number(match[1]) : index;
}

/** Select exactly the artifact the product says was delivered. */
export function sideBySideExportVersion(run: Run): SideBySideExportVersion {
  // A strict no-op has no generated relit file. Disabling the action is more
  // truthful than sending "final" to an endpoint that can only compose relit-vN.
  if (isApprovedPlanNoOp(run)) return null;

  if (isLampCombinedRun(run) && !isGradeable(run)) return null;

  if (isTwoPassWorkflowMode(runWorkflowMode(run))) {
    const delivered = finalLampIteration(run);
    const video = delivered?.generatedVideo;
    return delivered && isRealExportVideo(video)
      ? iterationVersion(delivered.index, video)
      : null;
  }

  if (isRealExportVideo(run.finalVideo)) return "final";
  for (let i = run.iterations.length - 1; i >= 0; i -= 1) {
    const video = run.iterations[i].generatedVideo;
    if (!isRealExportVideo(video)) continue;
    return iterationVersion(run.iterations[i].index, video);
  }
  return null;
}
