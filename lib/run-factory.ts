import type { NodeRunState, Run, VideoAsset } from "@/lib/types";
import { RELIGHT_WORKFLOW } from "@/lib/workflow-def";
import { uid } from "@/lib/util";

export function freshNodeStates(): Record<string, NodeRunState> {
  const states: Record<string, NodeRunState> = {};
  for (const node of RELIGHT_WORKFLOW.nodes) {
    states[node.id] = { nodeId: node.id, status: "idle" };
  }
  return states;
}

/** Pure run construction shared by the browser and server start endpoints. */
export function buildRun(video: VideoAsset, now = Date.now()): Run {
  return {
    // Server-ingested assets reserve their run id before bytes move. Reusing
    // it keeps source media, workflow state, outputs, and deletion together.
    id: video.runId ?? uid("run"),
    workflowId: RELIGHT_WORKFLOW.id,
    createdAt: now,
    originalVideo: video,
    status: "running",
    iterations: [],
    nodeStates: freshNodeStates(),
    log: [
      {
        at: now,
        level: "info",
        message: `Run created for "${video.label}" — ${RELIGHT_WORKFLOW.name}`,
      },
    ],
  };
}

export function buildQueuedRun(video: VideoAsset, now = Date.now()): Run {
  const run = buildRun(video, now);
  run.log.push({
    at: now,
    level: "info",
    message: "queued — waiting for a worker slot",
  });
  return run;
}
