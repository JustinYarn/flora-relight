import type { PipelineNode, WorkflowMode } from "../../lib/types.ts";
import { evalDefForId } from "../../lib/lamp-evaluation.ts";

export interface NodePromptRole {
  label: string;
  color: string;
  description: string;
}

/**
 * Small presentation-only vocabulary for the Engine canvas. The graph remains
 * canonical in lib/workflow-def.ts; this helper merely says which nodes carry,
 * compile, or write prompt state so those relationships are discoverable.
 */
export function promptRoleForNode(
  node: PipelineNode,
  workflowMode: WorkflowMode = "lamp"
): NodePromptRole | null {
  if (node.kind === "evaluate" && node.evalId) {
    const def = evalDefForId(node.evalId);
    if (!def) {
      return {
        label: "rubric",
        color: "var(--running)",
        description:
          "Uses the workflow's canonical evaluation rubric for this node.",
      };
    }
    return def.promptTemplate
      ? {
          label: "rubric",
          color: "var(--running)",
          description: "Uses the current canonical judge rubric.",
        }
      : {
          label: "code check",
          color: "var(--muted)",
          description: "Specified as a deterministic metric, not a model prompt; selected-run status shows execution.",
        };
  }

  switch (node.id) {
    case "plan":
      return {
        label: "planner prompt",
        color: "var(--running)",
        description:
          workflowMode === "beautify"
            ? "Classifies the closed enhancement catalog as enhance, declined, or uncertain before human approval."
            : workflowMode === "iris"
              ? "Classifies the closed gaze catalog as correct, declined, or uncertain before human approval."
              : "Inventories the complete source as remove, preserve, or uncertain before human approval.",
      };
    case "initial":
      return {
        label: "approved-plan prompt",
        color: "var(--accent)",
        description:
          workflowMode === "beautify"
            ? "Consumes the exact approved enhancement plan with every out-of-scope region locked."
            : workflowMode === "iris"
              ? "Consumes the exact approved gaze plan with expression, identity, scene, and audio locked."
              : "Consumes the exact approved cleanup plan with person, lighting, camera, and audio locks.",
      };
    case "critique":
      return {
        label: "whole-video rubric",
        color: "var(--running)",
        description:
          "Scores Initial against the approved plan and emits only structured, plan-bound corrections.",
      };
    case "final":
      return {
        label: "corrected mega prompt",
        color: "var(--accent)",
        description:
          "Consumes the immutable source, approved plan, and one consolidated correction set.",
      };
    case "manifest":
      return {
        label: "extractor prompt",
        color: "var(--running)",
        description: "Carries the current scene-inventory extraction prompt.",
      };
    case "anchor":
      return {
        label: "model prompt",
        color: "var(--accent)",
        description: "Carries the still-image relighting instruction when the full-loop anchor stage runs.",
      };
    case "compile":
      return {
        label: "prompt compiler",
        color: "var(--accent)",
        description: "Builds the generation brief from structured state.",
      };
    case "videogen":
      return {
        label: "mega prompt",
        color: "var(--accent)",
        description: "Consumes the compiled generation brief.",
      };
    case "ledger":
      return {
        label: "writes fixes",
        color: "var(--borderline)",
        description: "Turns eval findings into the next brief's corrections.",
      };
    default:
      return null;
  }
}
