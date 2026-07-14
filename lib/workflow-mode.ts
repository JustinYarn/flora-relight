import type { WorkflowMode } from "@/lib/types";

export const WORKFLOW_MODE_STORAGE_KEY = "flora-relight:workflow-mode";
export const DEFAULT_WORKFLOW_MODE: WorkflowMode = "lamp";

export function parseWorkflowMode(value: unknown): WorkflowMode | null {
  return value === "flora" || value === "lamp" ? value : null;
}

export function workflowModeLabel(mode: WorkflowMode): "Flora" | "Lamp" {
  return mode === "flora" ? "Flora" : "Lamp";
}
