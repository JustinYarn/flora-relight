import "server-only";

import type { RunExecution } from "@/lib/types";
import { getStorage } from "@/lib/server/storage";
import { isGradeableVideoGeneration } from "@/lib/server/run-execution-failure";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import {
  v2CandidateSourceSyncMatchesCanonical,
  v2CandidateSyncJournalOwnerMatches,
  v2FinalGenerationProof,
  v2FinalGenerationProofsEqual,
  isV2CandidateSyncVerdict,
  v2SyncVerdict,
  type SyncNetMetrics,
  type V2CandidateSyncVerdict,
} from "@/lib/v2-sync";

const MAX_VERDICT_CAS_ATTEMPTS = 12;

export type CandidateSyncEvidence =
  | {
      outcome: "passed";
      metrics: SyncNetMetrics;
      sourceSync: SyncNetMetrics | null;
    }
  | {
      outcome: "skipped";
      skipReason: "silent_source";
    };

function sameDurableOutcome(
  verdict: V2CandidateSyncVerdict,
  evidence: CandidateSyncEvidence,
  sourceFinal: NonNullable<ReturnType<typeof v2FinalGenerationProof>>
): boolean {
  return (
    v2FinalGenerationProofsEqual(verdict.sourceFinal, sourceFinal) &&
    verdict.outcome === evidence.outcome
  );
}

/**
 * CAS-journal the free candidate gate result on the server-owned execution.
 * Retrying after a lost response observes the first record and returns it;
 * this helper never creates, claims, or retries a paid operation.
 */
export async function recordV2CandidateSyncVerdict(input: {
  runId: string;
  executionId: string;
  workflowRunId: string;
  evidence: CandidateSyncEvidence;
}): Promise<V2CandidateSyncVerdict> {
  const storage = getStorage();
  for (let attempt = 0; attempt < MAX_VERDICT_CAS_ATTEMPTS; attempt += 1) {
    const [execution, run] = await Promise.all([
      storage.getRunExecution(input.runId),
      storage.getRun(input.runId),
    ]);
    if (!execution || !run) {
      throw new Error("Run disappeared before its candidate sync verdict saved.");
    }
    if (
      !v2CandidateSyncJournalOwnerMatches(execution, {
        runId: input.runId,
        executionId: input.executionId,
        workflowRunId: input.workflowRunId,
      })
    ) {
      throw new Error(
        "Durable run execution no longer owns the candidate sync verdict."
      );
    }
    const finalGeneration = run.providerOperations?.find(
      (operation) => operation.id === videoGenerationOperationId(2)
    );
    const sourceFinal = v2FinalGenerationProof(finalGeneration);
    if (!isGradeableVideoGeneration(finalGeneration) || !sourceFinal) {
      throw new Error(
        "Candidate sync verdict has no gradeable Final generation to bind."
      );
    }
    if (
      input.evidence.outcome === "passed" &&
      !v2CandidateSourceSyncMatchesCanonical(
        input.evidence.sourceSync,
        run.originalVideo.syncBaseline
      )
    ) {
      throw new Error(
        "Candidate sync verdict does not match the canonical source baseline."
      );
    }
    if (
      input.evidence.outcome === "skipped" &&
      run.originalVideo.hasAudio !== false
    ) {
      throw new Error(
        "Only a canonically confirmed silent source may skip candidate sync verification."
      );
    }
    if (
      execution.candidateSyncVerdict !== undefined &&
      isV2CandidateSyncVerdict(execution.candidateSyncVerdict)
    ) {
      if (
        execution.candidateSyncVerdict.outcome === "passed" &&
        !v2CandidateSourceSyncMatchesCanonical(
          execution.candidateSyncVerdict.sourceSync,
          run.originalVideo.syncBaseline
        )
      ) {
        throw new Error(
          "The existing candidate receipt no longer matches the canonical source baseline."
        );
      }
      if (
        sameDurableOutcome(
          execution.candidateSyncVerdict,
          input.evidence,
          sourceFinal
        )
      ) {
        return execution.candidateSyncVerdict;
      }
      throw new Error(
        "A different candidate sync verdict is already bound to this execution."
      );
    }
    const recordedAt = Math.max(Date.now(), execution.updatedAt);
    let verdict: V2CandidateSyncVerdict;
    if (input.evidence.outcome === "passed") {
      const effective = v2SyncVerdict(
        input.evidence.metrics,
        input.evidence.sourceSync
      );
      if (!effective.pass) {
        throw new Error("A failing candidate cannot journal a passing verdict.");
      }
      verdict = {
        outcome: "passed",
        iteration: 2,
        sourceFinal,
        recordedAt,
        policy: "v2_source_relative_artifact_v2",
        mode: effective.mode,
        reason: effective.reason.slice(0, 1_000),
        metrics: input.evidence.metrics,
        sourceSync: input.evidence.sourceSync,
      };
    } else {
      verdict = {
        outcome: "skipped",
        iteration: 2,
        sourceFinal,
        recordedAt,
        policy: "v2_source_relative_artifact_v2",
        skipReason: input.evidence.skipReason,
        reason: "Canonical source is silent; lip-sync verification is not applicable.",
      };
    }

    const candidate: RunExecution = {
      ...execution,
      candidateSyncVerdict: verdict,
      revision: execution.revision + 1,
      updatedAt: recordedAt,
    };
    const advanced = await storage.advanceRunExecution(
      candidate,
      execution.revision
    );
    if (advanced.advanced && advanced.execution?.candidateSyncVerdict) {
      return advanced.execution.candidateSyncVerdict;
    }
    if (!advanced.execution) {
      throw new Error("Run disappeared while its candidate sync verdict saved.");
    }
    // A same-owner CAS won. Re-read and either observe the idempotent verdict
    // or retry against the newer revision; no paid work occurs in this loop.
  }
  throw new Error("Candidate sync verdict changed too often to save safely.");
}
