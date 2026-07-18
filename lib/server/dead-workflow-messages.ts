/**
 * lib/server/dead-workflow-messages.ts — pure message builders for the
 * dead-workflow adopter (lib/server/dead-workflow-recovery.ts). Kept free of
 * path aliases and runtime imports so the node test runner can load them
 * directly, mirroring run-execution-failure.ts / lost-interaction.ts.
 */

import { PROVIDER_LOST_INTERACTION_MARKER } from "../lost-interaction.ts";

export type DeadWorkflowState = "missing" | "failed" | "cancelled";

export type WorkflowRunLiveness =
  | DeadWorkflowState
  | "alive"
  | "completed"
  | "unknown";

export type ObservedWorkflowRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Keep terminal completion distinct from a Workflow that may still write. */
export function classifyWorkflowRunLiveness(
  exists: boolean,
  status: ObservedWorkflowRunStatus
): Exclude<WorkflowRunLiveness, "unknown"> {
  if (!exists) return "missing";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "alive";
}

function describeState(state: DeadWorkflowState): string {
  return state === "missing" ? "no longer exists" : `was ${state}`;
}

/**
 * Marker-prefixed seal for a loss confirmed by a direct provider read after
 * the workflow died. Must keep the shared lost-interaction marker as its
 * prefix so the acknowledge-and-re-run recovery flow accepts it.
 */
export function deadWorkflowSealMessage(
  state: DeadWorkflowState,
  detail: string
): string {
  return (
    `${PROVIDER_LOST_INTERACTION_MARKER} (confirmed by a direct provider ` +
    `read after its durable workflow ${describeState(state)}: ${detail}). ` +
    `The generation was lost upstream and its charge outcome is unknown. ` +
    `Re-running it needs a fresh interaction under a new spend approval.`
  ).slice(0, 500);
}

/**
 * Execution stop reason when the loss is NOT provider-confirmed. Deliberately
 * does not carry the lost-interaction marker: unconfirmed outcomes stay
 * operator-owned read-only evidence and never unlock the browser re-run.
 */
export function deadWorkflowExecutionError(
  state: DeadWorkflowState,
  detail?: string
): string {
  const base =
    `The durable workflow backing this run ${describeState(state)} before ` +
    `its provider work resolved. No automatic retry will run.`;
  return (detail ? `${base} ${detail}` : base).slice(0, 2_000);
}
