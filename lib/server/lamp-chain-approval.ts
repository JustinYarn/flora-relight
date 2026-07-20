import "server-only";

import {
  approveLampChainPlan,
  assertLampChainPlanBinding,
  hashLampChainPlan,
  parseLampChainControls,
  parseLampChainPlan,
  type LampChainControls,
  type LampChainPlan,
} from "../lamp-chain.ts";
import { lampChainPlanOperationIds } from "../lamp-chain-operations.ts";
import { isRelightIntensity } from "../relight-intensity.ts";
import { runWorkflowMode } from "../workflow-mode.ts";
import { getStorage } from "@/lib/server/storage";
import type { Run } from "../types.ts";

export interface LampChainApprovalResult {
  /** Durable run now carrying the approved order-bearing aggregate. */
  run: Run;
  approvedPlan: LampChainPlan;
  /** hashLampChainPlan of the approved plan (approval metadata excluded). */
  approvedPlanHash: string;
  plannerOperationIds: string[];
  relightIntensity: number;
  alreadyApproved: boolean;
}

/** Chain equality is the Combined triple plus the exact stage order. */
function chainControlsEqual(
  left: LampChainControls,
  right: LampChainControls
): boolean {
  return (
    left.beautifyLevel === right.beautifyLevel &&
    left.cleanlinessLevel === right.cleanlinessLevel &&
    left.eyeContact === right.eyeContact &&
    left.stageOrder.length === right.stageOrder.length &&
    left.stageOrder.every((stage, index) => stage === right.stageOrder[index])
  );
}

/**
 * Validate the user's reviewed hash against the exact saved order-bearing
 * draft, flip the aggregate and every enabled subplan to one shared approval
 * timestamp, and persist the result on the run.
 *
 * Persistence is the plan-mode pattern, not Combined's atomic driver method:
 * the compare is the canonical-hash check against the freshly read
 * run.chainPlan, and the swap writes only when the stored aggregate is still
 * a draft. A stored approval with the same hash is reused untouched so a
 * concurrent identical click can never restamp the winner.
 */
export async function approveLampChainPlanForRun(
  runId: string,
  input: {
    presentedPlanHash: string;
    controls: LampChainControls;
    relightIntensity: number;
  }
): Promise<LampChainApprovalResult> {
  const storage = getStorage();
  const run = await storage.getRun(runId);
  if (!run) throw new Error("Run not found for Lamp Chain approval.");
  if (runWorkflowMode(run) !== "chain") {
    throw new Error("This run is not a Lamp Chain run.");
  }
  if (!run.chainPlan) {
    throw new Error(
      "A completed Chain aggregate draft is required before approval."
    );
  }
  const savedControls = parseLampChainControls(run.chainControls);
  const presentedControls = parseLampChainControls(input.controls);
  if (!chainControlsEqual(savedControls, presentedControls)) {
    throw new Error(
      "Lamp Chain controls changed after planning. Reload the reviewed draft."
    );
  }
  if (
    !isRelightIntensity(input.relightIntensity) ||
    !isRelightIntensity(run.relightIntensity) ||
    input.relightIntensity !== run.relightIntensity
  ) {
    throw new Error(
      "Lamp Chain relight intensity changed after planning. Reload the reviewed draft."
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.presentedPlanHash)) {
    throw new Error("planHash must be a lowercase SHA-256 digest.");
  }
  const draft = assertLampChainPlanBinding(
    parseLampChainPlan(run.chainPlan),
    {
      runId: run.id,
      relightIntensity: input.relightIntensity,
      controls: savedControls,
    }
  );
  const canonicalHash = await hashLampChainPlan(draft);
  if (canonicalHash !== input.presentedPlanHash) {
    throw new Error(
      "The Chain plan changed before approval. Reload and review the current aggregate plan."
    );
  }
  const alreadyApproved = draft.aggregate.approval.status === "approved";
  const approvedPlan = alreadyApproved
    ? draft
    : approveLampChainPlan(draft, Date.now());
  const approvedPlanHash = await hashLampChainPlan(approvedPlan);
  if (approvedPlanHash !== canonicalHash) {
    throw new Error(
      "Lamp Chain approval changed the plan's canonical content."
    );
  }
  const updated = alreadyApproved ? run : { ...run, chainPlan: approvedPlan };
  if (!alreadyApproved) {
    await storage.putRun(updated);
  }
  return {
    run: updated,
    approvedPlan,
    approvedPlanHash,
    plannerOperationIds: lampChainPlanOperationIds(savedControls),
    relightIntensity: input.relightIntensity,
    alreadyApproved,
  };
}
