import {
  approveLampCombinedPlan,
  assertLampCombinedPlanBinding,
  hashLampCombinedPlan,
  parseLampCombinedControls,
  parseLampCombinedPlan,
  type LampCombinedControls,
  type LampCombinedPlan,
} from "../lamp-combined.ts";
import { lampCombinedPlanOperationIds } from "../lamp-combined-operations.ts";
import { isRelightIntensity } from "../relight-intensity.ts";
import type { Run } from "../types.ts";

export interface LampCombinedApprovalResult {
  approvedPlan: LampCombinedPlan;
  approvedPlanHash: string;
  plannerOperationIds: string[];
  relightIntensity: number;
  alreadyApproved: boolean;
}

function controlsEqual(
  left: LampCombinedControls,
  right: LampCombinedControls
): boolean {
  return (
    left.beautifyLevel === right.beautifyLevel &&
    left.cleanlinessLevel === right.cleanlinessLevel &&
    left.eyeContact === right.eyeContact
  );
}

/**
 * Validate the user's reviewed hash against the exact saved draft, then flip
 * the aggregate and every enabled subplan to one shared approval timestamp.
 */
export async function approveLampCombinedPlanForRun(input: {
  run: Run;
  presentedPlanHash: string;
  presentedControls: LampCombinedControls;
  presentedRelightIntensity: number;
  approvedAt: number;
}): Promise<LampCombinedApprovalResult> {
  if (input.run.workflowMode !== "combined") {
    throw new Error("This run is not a Lamp Combined run.");
  }
  if (!input.run.combinedPlan) {
    throw new Error(
      "A completed Combined aggregate draft is required before approval."
    );
  }
  const savedControls = parseLampCombinedControls(input.run.combinedControls);
  const presentedControls = parseLampCombinedControls(input.presentedControls);
  if (!controlsEqual(savedControls, presentedControls)) {
    throw new Error(
      "Lamp Combined controls changed after planning. Reload the reviewed draft."
    );
  }
  if (
    !isRelightIntensity(input.presentedRelightIntensity) ||
    !isRelightIntensity(input.run.relightIntensity) ||
    input.presentedRelightIntensity !== input.run.relightIntensity
  ) {
    throw new Error(
      "Lamp Combined relight intensity changed after planning. Reload the reviewed draft."
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.presentedPlanHash)) {
    throw new Error("planHash must be a lowercase SHA-256 digest.");
  }
  if (!Number.isSafeInteger(input.approvedAt) || input.approvedAt < 0) {
    throw new Error("approvedAt must be a non-negative integer timestamp.");
  }
  const draft = assertLampCombinedPlanBinding(
    parseLampCombinedPlan(input.run.combinedPlan),
    {
      runId: input.run.id,
      relightIntensity: input.presentedRelightIntensity,
      controls: savedControls,
    }
  );
  const canonicalHash = await hashLampCombinedPlan(draft);
  if (canonicalHash !== input.presentedPlanHash) {
    throw new Error(
      "The Combined plan changed before approval. Reload and review the current aggregate plan."
    );
  }
  const alreadyApproved = draft.approval.status === "approved";
  const approvedPlan = alreadyApproved
    ? draft
    : approveLampCombinedPlan(draft, input.approvedAt);
  return {
    approvedPlan,
    approvedPlanHash: canonicalHash,
    plannerOperationIds: lampCombinedPlanOperationIds(savedControls),
    relightIntensity: input.presentedRelightIntensity,
    alreadyApproved,
  };
}
