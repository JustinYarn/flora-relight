import type {
  NodeRunState,
  Run,
  VideoAsset,
  WorkflowMode,
} from "@/lib/types";
import {
  DEFAULT_RELIGHT_INTENSITY,
  normalizeRelightIntensity,
} from "./relight-intensity.ts";
import { workflowForMode } from "./workflow-def.ts";
import { DEFAULT_WORKFLOW_MODE } from "./workflow-mode.ts";
import { uid } from "./util.ts";

export function freshNodeStates(
  workflowMode: WorkflowMode = DEFAULT_WORKFLOW_MODE
): Record<string, NodeRunState> {
  const states: Record<string, NodeRunState> = {};
  for (const node of workflowForMode(workflowMode).nodes) {
    states[node.id] = { nodeId: node.id, status: "idle" };
  }
  return states;
}

/** Pure run construction shared by the browser and server start endpoints. */
export function buildRun(
  video: VideoAsset,
  now = Date.now(),
  workflowMode: WorkflowMode = DEFAULT_WORKFLOW_MODE,
  relightIntensity = DEFAULT_RELIGHT_INTENSITY
): Run {
  const workflow = workflowForMode(workflowMode);
  return {
    // Server-ingested assets reserve their run id before bytes move. Reusing
    // it keeps source media, workflow state, outputs, and deletion together.
    id: video.runId ?? uid("run"),
    workflowId: workflow.id,
    workflowMode,
    ...(workflowMode === "lamp" ||
    workflowMode === "combined" ||
    workflowMode === "chain"
      ? { relightIntensity: normalizeRelightIntensity(relightIntensity) }
      : {}),
    createdAt: now,
    originalVideo: video,
    status: "running",
    iterations: [],
    nodeStates: freshNodeStates(workflowMode),
    log: [
      {
        at: now,
        level: "info",
        message: `Run created for "${video.label}" — ${workflow.name}`,
      },
    ],
  };
}

export function buildQueuedRun(
  video: VideoAsset,
  now = Date.now(),
  workflowMode: WorkflowMode = DEFAULT_WORKFLOW_MODE,
  relightIntensity = DEFAULT_RELIGHT_INTENSITY
): Run {
  const run = buildRun(video, now, workflowMode, relightIntensity);
  run.log.push({
    at: now,
    level: "info",
    message: "queued — waiting for a worker slot",
  });
  return run;
}
