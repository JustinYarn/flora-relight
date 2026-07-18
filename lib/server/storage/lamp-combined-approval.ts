import { canonicalInputHash } from "../../canonical-input-hash.ts";
import {
  hashLampCombinedPlan,
  parseLampCombinedControls,
  parseLampCombinedPlan,
  type LampCombinedPlan,
} from "../../lamp-combined.ts";
import type { Run, SpendApproval } from "../../types.ts";
import { runWorkflowMode } from "../../workflow-mode.ts";

const SHA256_RE = /^[a-f0-9]{64}$/;

export interface LampCombinedApprovalMutationInput {
  expectedPlanHash: string;
  expectedDraftPlan: LampCombinedPlan;
  approvedPlan: LampCombinedPlan;
  spendApproval: SpendApproval;
}

export interface ValidatedLampCombinedApprovalMutation {
  expectedPlanHash: string;
  expectedDraftPlan: LampCombinedPlan;
  approvedPlan: LampCombinedPlan;
  spendApproval: SpendApproval;
}

function controlsEqual(left: unknown, right: unknown): boolean {
  try {
    return (
      canonicalInputHash(parseLampCombinedControls(left)) ===
      canonicalInputHash(parseLampCombinedControls(right))
    );
  } catch {
    return false;
  }
}

function approvalCoversExactRun(
  run: Run,
  approval: SpendApproval,
  controls: unknown
): boolean {
  return (
    approval.scope === "combined_two_pass" &&
    approval.source === "single" &&
    approval.batchId === undefined &&
    approval.runId === run.id &&
    approval.sourceUrl === run.originalVideo.url &&
    approval.durationSec === run.originalVideo.durationSec &&
    approval.maxIterations === 2 &&
    controlsEqual(approval.combinedControls, controls)
  );
}

/** Validate caller-supplied draft/approved copies before entering a lock/SQL CAS. */
export async function validateLampCombinedApprovalMutation(
  runId: string,
  input: LampCombinedApprovalMutationInput
): Promise<ValidatedLampCombinedApprovalMutation> {
  if (!SHA256_RE.test(input.expectedPlanHash)) {
    throw new Error("Lamp Combined approval expectedPlanHash is invalid.");
  }
  const expectedDraftPlan = parseLampCombinedPlan(input.expectedDraftPlan);
  const approvedPlan = parseLampCombinedPlan(input.approvedPlan);
  if (
    expectedDraftPlan.runId !== runId ||
    approvedPlan.runId !== runId ||
    expectedDraftPlan.approval.status !== "draft" ||
    approvedPlan.approval.status !== "approved" ||
    input.spendApproval.runId !== runId ||
    input.spendApproval.scope !== "combined_two_pass" ||
    input.spendApproval.source !== "single" ||
    input.spendApproval.batchId !== undefined ||
    input.spendApproval.maxIterations !== 2 ||
    !controlsEqual(expectedDraftPlan.controls, approvedPlan.controls) ||
    !controlsEqual(approvedPlan.controls, input.spendApproval.combinedControls)
  ) {
    throw new Error("Lamp Combined atomic approval inputs do not share one exact binding.");
  }
  const [draftHash, approvedHash] = await Promise.all([
    hashLampCombinedPlan(expectedDraftPlan),
    hashLampCombinedPlan(approvedPlan),
  ]);
  if (
    draftHash !== input.expectedPlanHash ||
    approvedHash !== input.expectedPlanHash
  ) {
    throw new Error(
      "Lamp Combined atomic approval copies do not match expectedPlanHash."
    );
  }
  return {
    expectedPlanHash: input.expectedPlanHash,
    expectedDraftPlan,
    approvedPlan,
    spendApproval: input.spendApproval,
  };
}

export type LampCombinedApprovalDisposition =
  | "approve_draft"
  | "renew_approval"
  | "already_approved"
  | "conflict";

/** Re-check canonical source, controls, content, and approval under the lock. */
export async function lampCombinedApprovalDisposition(
  run: Run,
  input: ValidatedLampCombinedApprovalMutation
): Promise<LampCombinedApprovalDisposition> {
  if (
    runWorkflowMode(run) !== "combined" ||
    !approvalCoversExactRun(
      run,
      input.spendApproval,
      input.approvedPlan.controls
    ) ||
    !controlsEqual(run.combinedControls, input.approvedPlan.controls)
  ) {
    return "conflict";
  }
  let currentPlan: LampCombinedPlan;
  try {
    currentPlan = parseLampCombinedPlan(run.combinedPlan);
  } catch {
    return "conflict";
  }
  if ((await hashLampCombinedPlan(currentPlan)) !== input.expectedPlanHash) {
    return "conflict";
  }
  if (currentPlan.approval.status === "draft") {
    return canonicalInputHash(currentPlan) ===
      canonicalInputHash(input.expectedDraftPlan)
      ? "approve_draft"
      : "conflict";
  }
  if (
    canonicalInputHash(currentPlan) !== canonicalInputHash(input.approvedPlan)
  ) {
    return "conflict";
  }
  if (!run.spendApproval) return "renew_approval";
  if (
    !approvalCoversExactRun(
      run,
      run.spendApproval,
      input.approvedPlan.controls
    )
  ) {
    return "conflict";
  }
  if (run.spendApproval.expiresAt <= Date.now()) return "renew_approval";
  return "already_approved";
}
