import "server-only";

import {
  appendLampCombinedRepairQualification,
  buildLampCombinedCandidateQualificationReceipt,
  lampCombinedCandidateReceiptMatches,
  type LampCombinedCandidateQualificationReceipt,
  type LampCombinedSyncEvidence,
} from "@/lib/lamp-combined-candidate";
import {
  hashLampCombinedPlan,
  type LampCombinedIteration,
} from "@/lib/lamp-combined";
import { lampCombinedEvaluationOperationId } from "@/lib/lamp-combined-operations";
import {
  isLampCombinedLipsyncResult,
  lampCombinedLipsyncOperationId,
  lampCombinedLipsyncProofMatchesGeneration,
  lampCombinedMandatorySyncVerdict,
} from "@/lib/lamp-combined-lipsync";
import { validateLampCombinedExecutionBinding } from "@/lib/server/lamp-combined-execution";
import { getStorage } from "@/lib/server/storage";
import {
  type V2CandidateSyncCheck,
} from "@/lib/server/v2-sync-finalization";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import type { PaidOperation, Run, RunExecution } from "@/lib/types";
import { LIPSYNC_OPERATION_ID } from "@/lib/v2-sync";

export interface LampCombinedCandidateQualificationResult {
  receipt: LampCombinedCandidateQualificationReceipt;
  /** Legacy-only V2 sync projection; current Combined never invokes repair. */
  syncCheck: V2CandidateSyncCheck | null;
}

async function planOperations(
  runId: string,
  execution: RunExecution
): Promise<PaidOperation[]> {
  const storage = getStorage();
  return Promise.all(
    (execution.combinedPlanOperationIds ?? []).map(async (operationId) => {
      const operation = await storage.getPaidOperation(runId, operationId);
      if (!operation) {
        throw new Error(`Lamp Combined planner journal ${operationId} is missing.`);
      }
      return operation;
    })
  );
}

function assertOwner(input: {
  run: Run | null;
  execution: RunExecution | null;
  runId: string;
  executionId: string;
  workflowRunId: string;
}): asserts input is {
  run: Run;
  execution: RunExecution;
  runId: string;
  executionId: string;
  workflowRunId: string;
} {
  if (
    !input.run ||
    !input.execution ||
    input.execution.runId !== input.runId ||
    input.execution.executionId !== input.executionId ||
    input.execution.workflowRunId !== input.workflowRunId ||
    input.execution.executionId !== `lamp-combined:${input.runId}` ||
    (input.execution.status !== "running" &&
      input.execution.status !== "reconcile_required" &&
      input.execution.status !== "awaiting_review")
  ) {
    throw new Error("Lamp Combined qualification lost durable execution ownership.");
  }
}

function existingReceipt(
  execution: RunExecution,
  iteration: LampCombinedIteration
): LampCombinedCandidateQualificationReceipt | undefined {
  return iteration === 1
    ? execution.combinedCandidateReceipts?.initial
    : execution.combinedCandidateReceipts?.final;
}

function syncCheckFromReceipt(
  receipt: LampCombinedCandidateQualificationReceipt,
  videoUrl: string
): V2CandidateSyncCheck | null {
  if (receipt.sync.outcome === "not_required") {
    return { skipped: true, videoUrl, skipReason: "silent_source" };
  }
  if (receipt.sync.outcome === "passed" || receipt.sync.outcome === "failed") {
    return {
      skipped: false,
      videoUrl,
      metrics: receipt.sync.metrics,
      sourceSync: receipt.sync.sourceSync,
    };
  }
  return null;
}

async function analyzeCandidate(input: {
  run: Run;
  iteration: LampCombinedIteration;
}): Promise<{
  evidence: LampCombinedSyncEvidence;
  check: V2CandidateSyncCheck | null;
  lipsyncOperation: PaidOperation | null;
}> {
  const generation = input.run.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(input.iteration)
  );
  if (!generation?.result) {
    throw new Error("Lamp Combined candidate generation is missing.");
  }
  if (input.run.originalVideo.hasAudio === false) {
    return {
      evidence: { outcome: "silent_source" },
      check: {
        skipped: true,
        videoUrl: generation.result.videoUrl,
        skipReason: "silent_source",
      },
      lipsyncOperation: null,
    };
  }
  if (
    input.run.originalVideo.hasAudio !== true ||
    generation.result.audioVerified !== true
  ) {
    return {
      evidence: { outcome: "audio_unverified" },
      check: null,
      lipsyncOperation: null,
    };
  }
  const lipsyncOperation = await getStorage().getPaidOperation(
    input.run.id,
    lampCombinedLipsyncOperationId(input.iteration)
  );
  const result = lipsyncOperation?.result;
  if (
    !lipsyncOperation ||
    !isLampCombinedLipsyncResult(result, input.iteration) ||
    !lampCombinedLipsyncProofMatchesGeneration({
      runId: input.run.id,
      iteration: input.iteration,
      generation,
      operation: lipsyncOperation,
    })
  ) {
    throw new Error(
      `Lamp Combined Take ${input.iteration} has no exact mandatory Lipsync proof.`
    );
  }
  const verdict = lampCombinedMandatorySyncVerdict(result);
  if (!verdict.pass) {
    throw new Error(
      `Lamp Combined Take ${input.iteration} failed mandatory Lipsync verification: ${verdict.reason}`
    );
  }
  return {
    evidence: {
      outcome: "measured",
      metrics: result.postSync,
      sourceSync: result.sourceSync,
    },
    check: {
      skipped: false,
      videoUrl: result.videoUrl,
      metrics: result.postSync,
      sourceSync: result.sourceSync,
    },
    lipsyncOperation,
  };
}

/**
 * Measure and append one candidate receipt. SyncNet analyzer failures remain
 * exceptions, so an outage can never be misread as an eligible take.
 */
export async function qualifyLampCombinedCandidate(input: {
  runId: string;
  executionId: string;
  workflowRunId: string;
  iteration: LampCombinedIteration;
}): Promise<LampCombinedCandidateQualificationResult> {
  const storage = getStorage();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = {
      run: await storage.getRun(input.runId),
      execution: await storage.getRunExecution(input.runId),
      ...input,
    };
    assertOwner(state);
    const plan = await validateLampCombinedExecutionBinding({
      run: state.run,
      execution: state.execution,
      planOperations: await planOperations(input.runId, state.execution),
    });
    const planHash = await hashLampCombinedPlan(plan);
    const generation = state.run.providerOperations?.find(
      (operation) => operation.id === videoGenerationOperationId(input.iteration)
    );
    const evaluation = await storage.getPaidOperation(
      input.runId,
      lampCombinedEvaluationOperationId(input.iteration)
    );
    if (!generation || !evaluation) {
      throw new Error(
        "Lamp Combined qualification requires completed generation and evaluation journals."
      );
    }
    const existing = existingReceipt(state.execution, input.iteration);
    if (existing) {
      const matches = lampCombinedCandidateReceiptMatches({
        receipt: existing,
        generationOperation: generation,
        evaluationOperation: evaluation,
        planId: plan.id,
        planHash,
        sourceHasAudio: state.run.originalVideo.hasAudio,
        canonicalSourceSync: state.run.originalVideo.syncBaseline,
        lipsyncOperation:
          state.run.originalVideo.hasAudio === true
            ? await storage.getPaidOperation(
                input.runId,
                lampCombinedLipsyncOperationId(input.iteration)
              )
            : null,
      });
      if (!matches) {
        throw new Error(
          "Persisted Lamp Combined qualification no longer matches canonical journals."
        );
      }
      return {
        receipt: existing,
        syncCheck: syncCheckFromReceipt(existing, generation.result!.videoUrl),
      };
    }
    if (
      state.execution.status !== "running" ||
      state.execution.iteration !== input.iteration
    ) {
      throw new Error(
        "A new Lamp Combined qualification may only be journaled on its active take."
      );
    }
    const analyzed = await analyzeCandidate({
      run: state.run,
      iteration: input.iteration,
    });
    const updatedAt = Math.max(Date.now(), state.execution.updatedAt);
    const receipt = buildLampCombinedCandidateQualificationReceipt({
      iteration: input.iteration,
      generationOperation: generation,
      evaluationOperation: evaluation,
      planId: plan.id,
      planHash,
      sourceHasAudio: state.run.originalVideo.hasAudio,
      syncEvidence: analyzed.evidence,
      lipsyncOperation: analyzed.lipsyncOperation,
      recordedAt: updatedAt,
    });
    const candidate: RunExecution = {
      ...state.execution,
      combinedCandidateReceipts: {
        ...state.execution.combinedCandidateReceipts,
        ...(input.iteration === 1
          ? { initial: receipt }
          : { final: receipt }),
      },
      revision: state.execution.revision + 1,
      updatedAt,
    };
    const advanced = await storage.advanceRunExecution(
      candidate,
      state.execution.revision
    );
    if (advanced.advanced) {
      return { receipt, syncCheck: analyzed.check };
    }
  }
  throw new Error("Lamp Combined qualification changed too often to journal safely.");
}

/** @deprecated Legacy pre-normalization receipt migration helper. */
export async function appendLampCombinedFinalRepairReceipt(input: {
  runId: string;
  executionId: string;
  workflowRunId: string;
}): Promise<LampCombinedCandidateQualificationReceipt> {
  const storage = getStorage();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = {
      run: await storage.getRun(input.runId),
      execution: await storage.getRunExecution(input.runId),
      ...input,
    };
    assertOwner(state);
    const current = state.execution.combinedCandidateReceipts?.final;
    if (!current) {
      throw new Error("Lamp Combined Final has no base qualification receipt.");
    }
    if (current.repair) return current;
    const [generation, lipsync] = [
      state.run.providerOperations?.find(
        (operation) => operation.id === videoGenerationOperationId(2)
      ),
      await storage.getPaidOperation(input.runId, LIPSYNC_OPERATION_ID),
    ];
    if (!generation || !lipsync || lipsync.status !== "completed") {
      throw new Error("Lamp Combined Final repair is not durably completed.");
    }
    const updatedAt = Math.max(Date.now(), state.execution.updatedAt);
    const receipt = appendLampCombinedRepairQualification({
      receipt: current,
      finalGeneration: generation,
      lipsyncOperation: lipsync,
      canonicalSourceSync: state.run.originalVideo.syncBaseline,
      recordedAt: updatedAt,
    });
    const candidate: RunExecution = {
      ...state.execution,
      combinedCandidateReceipts: {
        ...state.execution.combinedCandidateReceipts,
        final: receipt,
      },
      revision: state.execution.revision + 1,
      updatedAt,
    };
    const advanced = await storage.advanceRunExecution(
      candidate,
      state.execution.revision
    );
    if (advanced.advanced) return receipt;
  }
  throw new Error("Lamp Combined repair proof changed too often to journal safely.");
}
