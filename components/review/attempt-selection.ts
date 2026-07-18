import type { Iteration, Run, VideoAsset } from "../../lib/types.ts";
import {
  deliveredInitialBestOfTwo,
  finalLampIteration,
  finalLampVideo,
} from "../grade/derive.ts";
import {
  isApprovedPlanNoOp,
  isTwoPassWorkflowMode,
  runWorkflowMode,
} from "../../lib/workflow-mode.ts";

export const DELIVERED_ATTEMPT_KEY = "final";

/**
 * Bind the delivered key to the iteration the server actually selected. Iris
 * best-of-two can deliver Initial, so iteration 2 must remain a normal,
 * independently inspectable `iter-2` entry in that case.
 */
export function reviewAttemptKey(run: Run, iteration: Iteration): string {
  const twoPass = isTwoPassWorkflowMode(runWorkflowMode(run));
  if (!twoPass) return `iter-${iteration.index}`;

  // Durable two-pass reads normally expose the delivered artifact through the
  // selected iteration rather than `run.finalVideo`. Iris's settlement marker
  // is therefore sufficient to bind v1 to the delivered key.
  if (deliveredInitialBestOfTwo(run)) {
    return iteration.index === 1
      ? DELIVERED_ATTEMPT_KEY
      : `iter-${iteration.index}`;
  }
  if (!run.finalVideo) return `iter-${iteration.index}`;

  const singleDelivered = run.iterations.length === 1;
  const deliveredIndex = finalLampIteration(run)?.index;
  return singleDelivered || deliveredIndex === iteration.index
    ? DELIVERED_ATTEMPT_KEY
    : `iter-${iteration.index}`;
}

export function reviewAttemptLabel(run: Run, iteration: Iteration): string {
  if (isApprovedPlanNoOp(run)) return "Exact source";
  if (!isTwoPassWorkflowMode(runWorkflowMode(run))) return `v${iteration.index}`;
  if (deliveredInitialBestOfTwo(run) && iteration.index === 1) {
    return "Delivered";
  }
  if (run.iterations.length === 1 && run.finalVideo) return "Final";
  if (iteration.index === 1) return "Initial";
  if (iteration.index === 2) return "Final";
  return `v${iteration.index}`;
}

export interface ReviewAttemptSelection {
  delivered: boolean;
  iteration: Iteration | undefined;
  video: VideoAsset | undefined;
}

/** Resolve one review key to a matching iteration and media artifact. */
export function reviewAttemptSelection(
  run: Run,
  activeKey: string | null
): ReviewAttemptSelection {
  const latest = run.iterations.at(-1);
  const delivered =
    activeKey === DELIVERED_ATTEMPT_KEY &&
    (run.finalVideo !== undefined || deliveredInitialBestOfTwo(run));
  const iteration = delivered
    ? finalLampIteration(run)
    : run.iterations.find(
        (candidate) => `iter-${candidate.index}` === activeKey
      ) ?? latest;
  return {
    delivered,
    iteration,
    video: delivered ? finalLampVideo(run) : iteration?.generatedVideo,
  };
}
