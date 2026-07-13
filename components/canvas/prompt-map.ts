import type { PipelineNode } from "@/lib/types";
import { getEvalDef } from "@/lib/prompts/eval-defs";

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
export function promptRoleForNode(node: PipelineNode): NodePromptRole | null {
  if (node.kind === "evaluate" && node.evalId) {
    const def = getEvalDef(node.evalId);
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
