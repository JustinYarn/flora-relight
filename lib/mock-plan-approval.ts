import {
  hashLampBackgroundCleanupPlan,
  parseLampBackgroundCleanupPlan,
} from "./lamp-background.ts";
import {
  hashLampBeautifyPlan,
  lampBeautifyPlansDifferOnlyByIntensity,
  parseLampBeautifyPlan,
} from "./lamp-beautify.ts";
import {
  hashLampIrisPlan,
  lampIrisPlansDifferOnlyByIntensity,
  parseLampIrisPlan,
} from "./lamp-iris.ts";
import {
  hashLampCombinedPlan,
  parseLampCombinedPlan,
} from "./lamp-combined.ts";
import { hashLampChainPlan, parseLampChainPlan } from "./lamp-chain.ts";

type MockApprovalInput = {
  currentPlan: unknown;
  candidatePlan: unknown;
  hasSpendApproval: boolean;
};

/**
 * Provider-free fixture plans may cross draft -> approved through the normal
 * run PUT. Live/server-owned plans have a spend approval and must use their
 * dedicated atomic approval route instead.
 */
export async function canAcceptMockBackgroundPlanApproval({
  currentPlan,
  candidatePlan,
  hasSpendApproval,
}: MockApprovalInput): Promise<boolean> {
  if (hasSpendApproval) return false;
  try {
    const current = parseLampBackgroundCleanupPlan(currentPlan);
    const candidate = parseLampBackgroundCleanupPlan(candidatePlan);
    return (
      current.approval.status === "draft" &&
      candidate.approval.status === "approved" &&
      (await hashLampBackgroundCleanupPlan(current)) ===
        (await hashLampBackgroundCleanupPlan(candidate))
    );
  } catch {
    return false;
  }
}

export async function canAcceptMockBeautifyPlanApproval({
  currentPlan,
  candidatePlan,
  hasSpendApproval,
}: MockApprovalInput): Promise<boolean> {
  if (hasSpendApproval) return false;
  try {
    const current = parseLampBeautifyPlan(currentPlan);
    const candidate = parseLampBeautifyPlan(candidatePlan);
    if (
      current.approval.status !== "draft" ||
      candidate.approval.status !== "approved" ||
      !lampBeautifyPlansDifferOnlyByIntensity(current, candidate)
    ) {
      return false;
    }
    const exactPlan =
      (await hashLampBeautifyPlan(current)) ===
      (await hashLampBeautifyPlan(candidate));
    const oneGlobalOverride =
      candidate.decision !== "enhance" ||
      new Set(candidate.enhance.map((item) => item.intensity)).size === 1;
    return exactPlan || oneGlobalOverride;
  } catch {
    return false;
  }
}

export async function canAcceptMockIrisPlanApproval({
  currentPlan,
  candidatePlan,
  hasSpendApproval,
}: MockApprovalInput): Promise<boolean> {
  if (hasSpendApproval) return false;
  try {
    const current = parseLampIrisPlan(currentPlan);
    const candidate = parseLampIrisPlan(candidatePlan);
    if (
      current.approval.status !== "draft" ||
      candidate.approval.status !== "approved" ||
      !lampIrisPlansDifferOnlyByIntensity(current, candidate)
    ) {
      return false;
    }
    const exactPlan =
      (await hashLampIrisPlan(current)) ===
      (await hashLampIrisPlan(candidate));
    const oneGlobalOverride =
      candidate.decision !== "correct" ||
      new Set(candidate.correct.map((item) => item.intensity)).size === 1;
    return exactPlan || oneGlobalOverride;
  } catch {
    return false;
  }
}

/** Chain's one click must approve the exact aggregate AND the exact stage order. */
export async function canAcceptMockChainPlanApproval({
  currentPlan,
  candidatePlan,
  hasSpendApproval,
}: MockApprovalInput): Promise<boolean> {
  if (hasSpendApproval) return false;
  try {
    const current = parseLampChainPlan(currentPlan);
    const candidate = parseLampChainPlan(candidatePlan);
    return (
      current.aggregate.approval.status === "draft" &&
      candidate.aggregate.approval.status === "approved" &&
      (await hashLampChainPlan(current)) ===
        (await hashLampChainPlan(candidate))
    );
  } catch {
    return false;
  }
}

/** Combined's one click must approve the exact aggregate and all enabled subplans. */
export async function canAcceptMockCombinedPlanApproval({
  currentPlan,
  candidatePlan,
  hasSpendApproval,
}: MockApprovalInput): Promise<boolean> {
  if (hasSpendApproval) return false;
  try {
    const current = parseLampCombinedPlan(currentPlan);
    const candidate = parseLampCombinedPlan(candidatePlan);
    return (
      current.approval.status === "draft" &&
      candidate.approval.status === "approved" &&
      (await hashLampCombinedPlan(current)) ===
        (await hashLampCombinedPlan(candidate))
    );
  } catch {
    return false;
  }
}
