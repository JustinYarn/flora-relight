import {
  lampCombinedCandidateIneligibility,
  type LampCombinedDeliveryCandidate,
} from "./lamp-combined.ts";
import type { LampCombinedCandidateQualificationReceipt } from "./lamp-combined-candidate.ts";

const SHA256_RE = /^[a-f0-9]{64}$/;

/** Browser-safe delivery projection; cryptographic journal checks stay server-side. */
export function lampCombinedCandidateReceiptToDeliveryCandidate(
  receipt: LampCombinedCandidateQualificationReceipt
): LampCombinedDeliveryCandidate {
  const audioStatus =
    receipt.audio.outcome === "verified"
      ? "verified"
      : receipt.audio.outcome === "silent_source"
        ? "silent-source"
        : "failed";
  const effectiveSync = receipt.repair?.sync ?? receipt.sync;
  const syncStatus =
    effectiveSync.outcome === "passed"
      ? "pass"
      : effectiveSync.outcome === "not_required"
        ? "not-required"
        : effectiveSync.outcome === "failed"
          ? "fail"
          : "unverified";
  return {
    iteration: receipt.iteration,
    generationComplete: true,
    audioStatus,
    syncStatus,
    evaluationComplete: true,
  };
}

export function lampCombinedCandidateReceiptEligible(
  receipt: LampCombinedCandidateQualificationReceipt
): boolean {
  return (
    lampCombinedCandidateIneligibility(
      lampCombinedCandidateReceiptToDeliveryCandidate(receipt)
    ) === null
  );
}

/**
 * Read the already server-proved candidate identity without importing Node
 * hashing into client bundles. Malformed identities still fail closed.
 */
export function lampCombinedCandidateArtifactIdentityHash(
  receipt: LampCombinedCandidateQualificationReceipt
): string {
  const hash =
    receipt.iteration === 2 && receipt.repair
      ? receipt.repair.artifactIdentityHash
      : receipt.generation.artifactIdentityHash;
  if (
    receipt.version !== "lamp-combined-candidate-v1" ||
    !SHA256_RE.test(hash)
  ) {
    throw new Error("Lamp Combined candidate receipt is invalid.");
  }
  return hash;
}
