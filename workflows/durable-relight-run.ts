import { getWorkflowMetadata, sleep } from "workflow";
import {
  hashLampChainPlan,
  parseLampChainPlan,
  type LampChainPlan,
  type LampChainStage,
} from "@/lib/lamp-chain";
import {
  parseLampChainPromptEnvelope,
  type LampChainPromptEnvelope,
} from "@/lib/prompts/lamp-chain";
import {
  buildLampChainStageReceipt,
  lampChainStageReceiptMatches,
} from "@/lib/lamp-chain-candidate";
import type { LampChainEvaluationArtifact } from "@/lib/lamp-chain-evaluation";
import { prepareLampChainStageStart } from "@/lib/server/lamp-chain-source";
import { runLampChainStageEvaluation } from "@/lib/server/lamp-chain-evaluator";
import {
  compileLampFinalPrompt,
  isLampEvaluationArtifact,
  lampEvaluationOperationId,
  type LampEvaluationArtifact,
} from "@/lib/lamp-evaluation";
import {
  isLampBackgroundEvaluationArtifact,
} from "@/lib/lamp-background-read";
import {
  lampBackgroundEvaluationOperationId,
} from "@/lib/lamp-background-operations";
import type {
  LampBackgroundEvalResult,
  LampBackgroundEvaluationArtifact,
} from "@/lib/lamp-background-evaluation";
import type { LampBackgroundCleanupPlan } from "@/lib/lamp-background";
import { compileLampBackgroundFinalPrompt } from "@/lib/prompts/lamp-background";
import {
  validateLampBackgroundExecutionBinding,
} from "@/lib/server/lamp-background-execution";
import { runLampBackgroundHolisticEvaluation } from "@/lib/server/lamp-background-evaluator";
import {
  isLampBeautifyEvaluationArtifact,
} from "@/lib/lamp-beautify-read";
import {
  lampBeautifyEvaluationOperationId,
} from "@/lib/lamp-beautify-operations";
import type {
  LampBeautifyEvalResult,
  LampBeautifyEvaluationArtifact,
} from "@/lib/lamp-beautify-evaluation";
import type { LampBeautifyPlan } from "@/lib/lamp-beautify";
import { compileLampBeautifyFinalPrompt } from "@/lib/prompts/lamp-beautify";
import {
  validateLampBeautifyExecutionBinding,
} from "@/lib/server/lamp-beautify-execution";
import { runLampBeautifyHolisticEvaluation } from "@/lib/server/lamp-beautify-evaluator";
import {
  isLampIrisEvaluationArtifact,
} from "@/lib/lamp-iris-read";
import {
  lampIrisEvaluationOperationId,
} from "@/lib/lamp-iris-operations";
import {
  selectLampIrisDeliveredIteration,
  type LampIrisEvalResult,
  type LampIrisEvaluationArtifact,
} from "@/lib/lamp-iris-evaluation";
import type { LampIrisPlan } from "@/lib/lamp-iris";
import { compileLampIrisFinalPrompt } from "@/lib/prompts/lamp-iris";
import {
  validateLampIrisExecutionBinding,
} from "@/lib/server/lamp-iris-execution";
import { runLampIrisHolisticEvaluation } from "@/lib/server/lamp-iris-evaluator";
import { runLampHolisticEvaluation } from "@/lib/server/lamp-evaluator";
import {
  hashLampCombinedPlan,
  type LampCombinedPlan,
} from "@/lib/lamp-combined";
import { lampCombinedCandidateReceiptMatches } from "@/lib/lamp-combined-candidate";
import {
  parseLampCombinedEvaluationArtifact,
  type LampCombinedEvaluationArtifact,
} from "@/lib/lamp-combined-evaluation";
import { lampCombinedEvaluationOperationId } from "@/lib/lamp-combined-operations";
import { compileLampCombinedFinalPrompt } from "@/lib/prompts/lamp-combined";
import {
  appendLampCombinedFinalRepairReceipt,
  qualifyLampCombinedCandidate,
} from "@/lib/server/lamp-combined-candidate-qualification";
import { validateLampCombinedExecutionBinding } from "@/lib/server/lamp-combined-execution";
import { runLampCombinedHolisticEvaluation } from "@/lib/server/lamp-combined-evaluator";
import type { PreparedLipsyncInputs } from "@/lib/server/replicate-lipsync";
import { getStorage } from "@/lib/server/storage";
import { recordV2CandidateSyncVerdict } from "@/lib/server/v2-sync-verdict-journal";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import {
  isLampUserActionRequiredError,
  LAMP_USER_ACTION_REQUIRED_PREFIX,
} from "@/lib/server/run-execution-resume";
import {
  isGradeableVideoGeneration,
  runExecutionFailureStatus,
  videoGenerationPollErrorDisposition,
  type VideoGenerationPollErrorDisposition,
} from "@/lib/server/run-execution-failure";
import {
  claimAndStartVideoGeneration,
  VideoGenerationStartError,
  type ClaimAndStartVideoGenerationResult,
} from "@/lib/server/video-generation-start";
import { PaidOperationAuthorizationError } from "@/lib/server/paid-operation";
import {
  analyzeInitialCandidateSync,
  analyzeV2Candidate,
  ensureSourceSyncBaseline,
  finalizeV2Lipsync,
  pollV2LipsyncPrediction,
  prepareV2LipsyncInputs,
  readV2LipsyncCheckpoint,
  startV2LipsyncPrediction,
  type V2CandidateSyncCheck,
  type V2LipsyncCheckpoint,
  type V2LipsyncPollResult,
} from "@/lib/server/v2-sync-finalization";
import {
  assertVideoGenerationAuthorized,
  hasReusableLampBackgroundApproval,
  hasReusableLampBeautifyApproval,
  hasReusableLampIrisApproval,
  hasReusableLampApproval,
  hasReusableLampCombinedApproval,
  hasReusableLampChainApproval,
} from "@/lib/server/spend-approval";
import {
  markVideoGenerationWorkflowError,
  pollVideoGeneration,
  prepareVideoGenerationStart,
  setVideoGenerationWorkflowState,
  videoGenerationOperationId,
  type PollVideoGenerationResult,
} from "@/lib/server/videogen-operation";
import type { RunExecution, VideoGenerationOperationResult } from "@/lib/types";
import {
  LIPSYNC_OPERATION_ID,
  v2SyncSettlementVerified,
  type LipsyncOperationResult,
  type SyncNetMetrics,
} from "@/lib/v2-sync";
import { v2SyncVerdict } from "@/lib/v2-sync-verdict";
import {
  isTwoPassExecutionId,
  workflowModeFromExecutionId,
} from "@/lib/workflow-mode";

export interface DurableRelightRunInput {
  runId: string;
  executionId: string;
  /** Exact initial mega-prompt bytes hash-bound at RunExecution revision 1. */
  renderedPrompt: string;
}

export interface DurableRelightRunResult {
  runId: string;
  executionId: string;
  status: "not_owner" | "awaiting_review";
  videoUrl?: string;
  audioVerified?: boolean;
}

const MAX_POLLS = 150; // 20 minutes at 8s; expected provider latency is 1-7m.
const MAX_RECONCILIATION_POLLS = 7 * 24 * 12;
const MAX_RETRY_SAFE_GAP_ATTEMPTS = 7 * 24 * 12;

/**
 * Lamp and Lamp Background use the fixed two-pass contract. Lamp Background
 * additionally binds every provider input to one human-approved cleanup plan:
 *
 *   original + mega prompt v1 -> generation 1 -> holistic critique
 *   -> corrected mega prompt v2 -> generation 2 from original
 *   -> final holistic evaluation
 *   -> SyncNet gate (absolute, or source-relative when the source itself
 *      cannot pass the absolute bar) and at most one Lipsync-2-Pro repair
 *   -> blind human grading
 *
 * Existing Flora batch children and pre-Lamp single executions retain their
 * already-authorized one-cut behavior until those records naturally settle.
 */
export async function durableRelightRun(
  input: DurableRelightRunInput
): Promise<DurableRelightRunResult> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const source = await bindExecution(input, workflowRunId);
  if (!source) {
    return { runId: input.runId, executionId: input.executionId, status: "not_owner" };
  }
  const workflowMode = workflowModeFromExecutionId(input.executionId);
  if (workflowMode === "combined") {
    return durableLampCombinedRun(input, workflowRunId);
  }
  if (workflowMode === "chain") {
    return durableLampChainRun(input, workflowRunId);
  }

  try {
    const backgroundPlan =
      workflowMode === "background"
        ? await readBoundBackgroundPlan(input, workflowRunId)
        : undefined;
    const beautifyPlan =
      workflowMode === "beautify"
        ? await readBoundBeautifyPlan(input, workflowRunId)
        : undefined;
    const irisPlan =
      workflowMode === "iris"
        ? await readBoundIrisPlan(input, workflowRunId)
        : undefined;
    const first = await runGenerationAttempt(
      input,
      workflowRunId,
      1,
      input.renderedPrompt
    );

    if (workflowMode === "flora") {
      await settleLegacyFirstCut(input, workflowRunId);
      return {
        runId: input.runId,
        executionId: input.executionId,
        status: "awaiting_review",
        videoUrl: first.videoUrl,
        audioVerified: first.audioVerified,
      };
    }

    await enterEvaluationPhaseWithRecovery(input, workflowRunId, 1);
    let finalRenderedPrompt: string;
    let lampFirstEvaluation: LampEvaluationArtifact | undefined;
    let backgroundFirstEvaluation:
      | LampBackgroundEvaluationArtifact
      | undefined;
    let beautifyFirstEvaluation:
      | LampBeautifyEvaluationArtifact
      | undefined;
    let irisFirstEvaluation:
      | LampIrisEvaluationArtifact
      | undefined;
    if (workflowMode === "iris") {
      if (!irisPlan) {
        throw new Error(
          "Lamp Iris lost its approved gaze-correction plan before evaluation."
        );
      }
      irisFirstEvaluation = await evaluateIrisAttemptWithRecovery(
        input,
        workflowRunId,
        1,
        irisPlan,
        []
      );
      finalRenderedPrompt = compileLampIrisFinalPrompt(
        input.renderedPrompt,
        irisPlan,
        irisFirstEvaluation
      ).rendered;
    } else if (workflowMode === "beautify") {
      if (!beautifyPlan) {
        throw new Error(
          "Lamp Beautify lost its approved enhancement plan before evaluation."
        );
      }
      beautifyFirstEvaluation = await evaluateBeautifyAttemptWithRecovery(
        input,
        workflowRunId,
        1,
        beautifyPlan,
        []
      );
      finalRenderedPrompt = compileLampBeautifyFinalPrompt(
        input.renderedPrompt,
        beautifyPlan,
        beautifyFirstEvaluation
      ).rendered;
    } else if (workflowMode === "background") {
      if (!backgroundPlan) {
        throw new Error(
          "Lamp Background lost its approved cleanup plan before evaluation."
        );
      }
      backgroundFirstEvaluation =
        await evaluateBackgroundAttemptWithRecovery(
          input,
          workflowRunId,
          1,
          backgroundPlan,
          []
        );
      finalRenderedPrompt = compileLampBackgroundFinalPrompt(
        input.renderedPrompt,
        backgroundPlan,
        backgroundFirstEvaluation
      ).rendered;
    } else {
      lampFirstEvaluation = await evaluateAttemptWithRecovery(
        input,
        workflowRunId,
        1,
        []
      );
      finalRenderedPrompt = compileLampFinalPrompt(
        input.renderedPrompt,
        lampFirstEvaluation
      ).rendered;
    }

    await runGenerationAttempt(
      input,
      workflowRunId,
      2,
      finalRenderedPrompt
    );
    // The Final holistic evaluation runs BEFORE the sync gate. The spend
    // dialog promises two judge calls, and a gate kill after a completed
    // Final generation must not erase the second one (live 2026-07-16:
    // run_bg01_049's failed repair sealed the run with no judge:2 journal).
    // The judge therefore sees the Final exactly as generated; a later
    // Lipsync repair only revises the mouth region under the same URL.
    await enterEvaluationPhaseWithRecovery(input, workflowRunId, 2);
    if (workflowMode === "iris") {
      await evaluateIrisAttemptWithRecovery(
        input,
        workflowRunId,
        2,
        irisPlan!,
        irisFirstEvaluation!.evalResults
      );
    } else if (workflowMode === "beautify") {
      await evaluateBeautifyAttemptWithRecovery(
        input,
        workflowRunId,
        2,
        beautifyPlan!,
        beautifyFirstEvaluation!.evalResults
      );
    } else if (workflowMode === "background") {
      await evaluateBackgroundAttemptWithRecovery(
        input,
        workflowRunId,
        2,
        backgroundPlan!,
        backgroundFirstEvaluation!.evalResults
      );
    } else {
      await evaluateAttemptWithRecovery(
        input,
        workflowRunId,
        2,
        lampFirstEvaluation!.evalResults
      );
    }
    const effectiveFinal = await finalizeV2WithSync(input, workflowRunId);
    if (workflowMode === "iris") {
      await settleIrisExecution(
        input,
        workflowRunId,
        finalRenderedPrompt
      );
    } else if (workflowMode === "beautify") {
      await settleBeautifyExecution(
        input,
        workflowRunId,
        finalRenderedPrompt
      );
    } else if (workflowMode === "background") {
      await settleBackgroundExecution(
        input,
        workflowRunId,
        finalRenderedPrompt
      );
    } else {
      await settleLampExecution(
        input,
        workflowRunId,
        finalRenderedPrompt
      );
    }
    return {
      runId: input.runId,
      executionId: input.executionId,
      status: "awaiting_review",
      videoUrl: effectiveFinal.videoUrl,
      audioVerified: effectiveFinal.audioVerified,
    };
  } catch (error) {
    const safeError =
      error instanceof Error
        ? error.message
        : "Durable two-pass execution failed.";
    const failure = await recordExecutionFailure(
      input,
      workflowRunId,
      safeError
    );
    if (failure === "legacy_completed") {
      await settleLegacyFirstCut(input, workflowRunId);
      return { runId: input.runId, executionId: input.executionId, status: "awaiting_review" };
    }
    if (failure === "two_pass_completed") {
      if (workflowMode === "iris") {
        const [plan, firstEvaluation] = await Promise.all([
          readBoundIrisPlan(input, workflowRunId),
          readCompletedIrisEvaluation(input.runId, 1),
        ]);
        const finalPrompt = compileLampIrisFinalPrompt(
          input.renderedPrompt,
          plan,
          firstEvaluation
        );
        await settleIrisExecution(
          input,
          workflowRunId,
          finalPrompt.rendered
        );
      } else if (workflowMode === "beautify") {
        const [plan, firstEvaluation] = await Promise.all([
          readBoundBeautifyPlan(input, workflowRunId),
          readCompletedBeautifyEvaluation(input.runId, 1),
        ]);
        const finalPrompt = compileLampBeautifyFinalPrompt(
          input.renderedPrompt,
          plan,
          firstEvaluation
        );
        await settleBeautifyExecution(
          input,
          workflowRunId,
          finalPrompt.rendered
        );
      } else if (workflowMode === "background") {
        const [cleanupPlan, firstEvaluation] = await Promise.all([
          readBoundBackgroundPlan(input, workflowRunId),
          readCompletedBackgroundEvaluation(input.runId, 1),
        ]);
        const finalPrompt = compileLampBackgroundFinalPrompt(
          input.renderedPrompt,
          cleanupPlan,
          firstEvaluation
        );
        await settleBackgroundExecution(
          input,
          workflowRunId,
          finalPrompt.rendered
        );
      } else {
        const firstEvaluation = await readCompletedEvaluation(
          input.runId,
          1
        );
        const finalPrompt = compileLampFinalPrompt(
          input.renderedPrompt,
          firstEvaluation
        );
        await settleLampExecution(
          input,
          workflowRunId,
          finalPrompt.rendered
        );
      }
      return { runId: input.runId, executionId: input.executionId, status: "awaiting_review" };
    }
    if (failure === "awaiting_review") {
      return { runId: input.runId, executionId: input.executionId, status: "awaiting_review" };
    }
    throw new Error(
      failure === "user_action_required"
        ? "Durable two-pass execution paused until its exact spend approval is renewed."
        : failure === "reconcile_required"
        ? "Durable two-pass execution requires provider reconciliation."
        : "Durable two-pass execution stopped before a gradeable final artifact was confirmed."
    );
  }
}

async function durableLampCombinedRun(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<DurableRelightRunResult> {
  try {
    const plan = await readBoundCombinedPlan(input, workflowRunId);
    await runGenerationAttempt(input, workflowRunId, 1, input.renderedPrompt);
    await enterEvaluationPhaseWithRecovery(input, workflowRunId, 1);
    const firstEvaluation = await evaluateCombinedAttemptWithRecovery(
      input,
      workflowRunId,
      1,
      plan
    );
    await qualifyCombinedCandidateStep(input, workflowRunId, 1);

    const finalRenderedPrompt = await compileCombinedFinalPromptStep(
      input,
      workflowRunId,
      plan,
      firstEvaluation
    );
    const second = await runGenerationAttempt(
      input,
      workflowRunId,
      2,
      finalRenderedPrompt
    );
    await enterEvaluationPhaseWithRecovery(input, workflowRunId, 2);
    await evaluateCombinedAttemptWithRecovery(
      input,
      workflowRunId,
      2,
      plan,
      firstEvaluation
    );
    const finalQualification = await qualifyCombinedCandidateStep(
      input,
      workflowRunId,
      2
    );

    if (finalQualification.needsRepair && finalQualification.syncCheck) {
      const syncCheck = finalQualification.syncCheck;
        try {
          await finalizeV2WithSync(input, workflowRunId, syncCheck);
          await appendCombinedFinalRepairReceiptStep(input, workflowRunId);
        } catch (error) {
          // A completed but definitively failing repair is still durable
          // candidate evidence. Journal it and leave Final ineligible; only an
          // ambiguous/missing repair is allowed to keep execution unsettled.
          try {
            await appendCombinedFinalRepairReceiptStep(input, workflowRunId);
          } catch {
            throw error;
          }
        }
    }

    await settleCombinedExecution(
      input,
      workflowRunId,
      finalRenderedPrompt
    );
    return {
      runId: input.runId,
      executionId: input.executionId,
      status: "awaiting_review",
      // Both takes remain candidates. Returning Final as a winner here would
      // silently violate Combined's blind human-selection contract.
      audioVerified: second.audioVerified || undefined,
    };
  } catch (error) {
    // Free settlement repair first: a response may have vanished after every
    // provider artifact and receipt was already committed.
    try {
      const [plan, firstEvaluation] = await Promise.all([
        readBoundCombinedPlan(input, workflowRunId),
        readCompletedCombinedEvaluation(input.runId, 1),
      ]);
      const finalRenderedPrompt = await compileCombinedFinalPromptStep(
        input,
        workflowRunId,
        plan,
        firstEvaluation
      );
      await settleCombinedExecution(
        input,
        workflowRunId,
        finalRenderedPrompt
      );
      return {
        runId: input.runId,
        executionId: input.executionId,
        status: "awaiting_review",
      };
    } catch {
      // Missing/ambiguous evidence is classified by the shared durable
      // failure recorder below; never infer completion from media alone.
    }

    const safeError =
      error instanceof Error
        ? error.message
        : "Durable Lamp Combined execution failed.";
    const failure = await recordExecutionFailure(
      input,
      workflowRunId,
      safeError
    );
    if (failure === "awaiting_review") {
      return {
        runId: input.runId,
        executionId: input.executionId,
        status: "awaiting_review",
      };
    }
    if (failure === "two_pass_completed") {
      // Exact receipts prove the paid work finished, but that is not the same
      // as a durable settlement. Never let the Workflow become `completed`
      // while RunExecution still says `running`.
      const [plan, firstEvaluation] = await Promise.all([
        readBoundCombinedPlan(input, workflowRunId),
        readCompletedCombinedEvaluation(input.runId, 1),
      ]);
      const finalRenderedPrompt = await compileCombinedFinalPromptStep(
        input,
        workflowRunId,
        plan,
        firstEvaluation
      );
      await settleCombinedExecution(
        input,
        workflowRunId,
        finalRenderedPrompt
      );
      return {
        runId: input.runId,
        executionId: input.executionId,
        status: "awaiting_review",
      };
    }
    throw new Error(
      failure === "user_action_required"
        ? "Lamp Combined paused until its exact spend approval is renewed."
        : failure === "reconcile_required"
          ? "Lamp Combined requires provider reconciliation."
          : "Lamp Combined stopped before both candidate states were durably qualified."
    );
  }
}

async function readBoundCombinedPlan(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<LampCombinedPlan> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.renderedPrompt !== input.renderedPrompt ||
    execution.executionId !== `lamp-combined:${input.runId}`
  ) {
    throw new Error(
      "Durable run execution no longer owns the approved Lamp Combined aggregate."
    );
  }
  const planOperations = await Promise.all(
    (execution.combinedPlanOperationIds ?? []).map(async (operationId) => {
      const operation = await storage.getPaidOperation(input.runId, operationId);
      if (!operation) throw new Error(`Missing Combined planner ${operationId}.`);
      return operation;
    })
  );
  return validateLampCombinedExecutionBinding({
    run,
    execution,
    planOperations,
  });
}

readBoundCombinedPlan.maxRetries = 2;

async function readBoundBackgroundPlan(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<LampBackgroundCleanupPlan> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.renderedPrompt !== input.renderedPrompt ||
    !execution.executionId.startsWith("lamp-background:")
  ) {
    throw new Error(
      "Durable run execution no longer owns the approved Lamp Background plan."
    );
  }
  const planOperation = execution.planOperationId
    ? await storage.getPaidOperation(
        input.runId,
        execution.planOperationId
      )
    : null;
  return validateLampBackgroundExecutionBinding({
    run,
    execution,
    planOperation,
  });
}

readBoundBackgroundPlan.maxRetries = 2;

async function readBoundBeautifyPlan(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<LampBeautifyPlan> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.renderedPrompt !== input.renderedPrompt ||
    !execution.executionId.startsWith("lamp-beautify:")
  ) {
    throw new Error(
      "Durable run execution no longer owns the approved Lamp Beautify plan."
    );
  }
  const planOperation = execution.planOperationId
    ? await storage.getPaidOperation(
        input.runId,
        execution.planOperationId
      )
    : null;
  return validateLampBeautifyExecutionBinding({
    run,
    execution,
    planOperation,
  });
}

readBoundBeautifyPlan.maxRetries = 2;

async function readBoundIrisPlan(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<LampIrisPlan> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.renderedPrompt !== input.renderedPrompt ||
    !execution.executionId.startsWith("lamp-iris:")
  ) {
    throw new Error(
      "Durable run execution no longer owns the approved Lamp Iris plan."
    );
  }
  const planOperation = execution.planOperationId
    ? await storage.getPaidOperation(
        input.runId,
        execution.planOperationId
      )
    : null;
  return validateLampIrisExecutionBinding({
    run,
    execution,
    planOperation,
  });
}

readBoundIrisPlan.maxRetries = 2;

interface EffectiveV2 {
  videoUrl: string;
  audioVerified: true;
}

async function finalizeV2WithSync(
  input: DurableRelightRunInput,
  workflowRunId: string,
  precomputedCandidate?: V2CandidateSyncCheck
): Promise<EffectiveV2> {
  let checkpoint = await readV2SyncCheckpointStep(input, workflowRunId);
  if (checkpoint.state === "blocked") throw new Error(checkpoint.reason);
  if (checkpoint.state === "completed") {
    // Resume/recovery path: the repair already billed and journaled. Fetch
    // the source baseline only when the absolute bar alone would kill the
    // run — a quiet-speaker source must re-admit its within-tolerance repair.
    let verdict = v2SyncVerdict(checkpoint.result.postSync);
    if (!verdict.pass) {
      verdict = v2SyncVerdict(
        checkpoint.result.postSync,
        await readSourceSyncBaselineStep(input, workflowRunId)
      );
    }
    if (!verdict.pass) {
      throw new Error(
        `The completed Lipsync repair still fails SyncNet (${verdict.reason}).`
      );
    }
    return {
      videoUrl: checkpoint.result.videoUrl,
      audioVerified: true,
    };
  }

  if (checkpoint.state === "unclaimed" && !precomputedCandidate) {
    const journaledCandidateUrl = await readAcceptedV2CandidateStep(
      input,
      workflowRunId
    );
    if (journaledCandidateUrl) {
      // A prior step attempt may have saved the free pass/skip before losing
      // its response. Reuse that exact proof instead of re-analyzing into a
      // different noisy verdict or accidentally starting a paid repair.
      return { videoUrl: journaledCandidateUrl, audioVerified: true };
    }
  }

  const candidate =
    precomputedCandidate ??
    (await analyzeV2CandidateStep(input, workflowRunId));
  if (candidate.skipped) {
    if (checkpoint.state === "started") {
      throw new Error("A started Lipsync repair no longer has source audio.");
    }
    return { videoUrl: candidate.videoUrl, audioVerified: true };
  }
  if (checkpoint.state === "unclaimed") {
    // The effective gate admits the candidate outright: the absolute bar, or
    // the source-relative bar for footage that cannot meet it. The relative
    // pass is also the paid-repair skip — when the source is below the
    // absolute bar and the Final already scores within tolerance of it,
    // Lipsync-2-Pro has nothing to win and must not bill.
    if (v2SyncVerdict(candidate.metrics, candidate.sourceSync).pass) {
      return { videoUrl: candidate.videoUrl, audioVerified: true };
    }
    const prepared = await prepareV2LipsyncInputsStep(input, workflowRunId);
    checkpoint = {
      state: "started",
      predictionId: await startV2LipsyncPredictionStep(
        input,
        workflowRunId,
        prepared,
        candidate.metrics
      ),
    };
  }

  if (checkpoint.state !== "started") {
    throw new Error("V2 Lipsync repair has no durable prediction id.");
  }
  // Fast polling for the expected window, then a free 5-minute reconciliation
  // cadence for up to seven days — a billed prediction slower than 20 minutes
  // (model cold start, queue depth) must never be abandoned into manual
  // reconciliation while polling costs nothing.
  for (let poll = 0; poll < MAX_POLLS + MAX_RECONCILIATION_POLLS; poll += 1) {
    await sleep(poll < MAX_POLLS ? "8s" : "5m");
    let result: Awaited<ReturnType<typeof pollV2LipsyncPredictionStep>>;
    try {
      result = await pollV2LipsyncPredictionStep(
        input,
        workflowRunId,
        checkpoint.predictionId
      );
    } catch (error) {
      // A transient read failure must not abandon the billed prediction.
      // Only a sealed journal (terminal provider status recorded by the
      // poll itself) or a completed result ends the wait early.
      const sealed = await readV2SyncCheckpointStep(input, workflowRunId);
      if (sealed.state === "blocked") throw error;
      if (sealed.state === "completed") {
        const verdict = v2SyncVerdict(
          sealed.result.postSync,
          candidate.sourceSync
        );
        if (!verdict.pass) {
          throw new Error(
            `The completed Lipsync repair still fails SyncNet (${verdict.reason}).`
          );
        }
        return { videoUrl: sealed.result.videoUrl, audioVerified: true };
      }
      continue;
    }
    if (!result.done) continue;
    const finalized = await finalizeV2LipsyncStep(
      input,
      workflowRunId,
      checkpoint.predictionId,
      result.outputUrl,
      candidate.metrics
    );
    const verdict = v2SyncVerdict(finalized.postSync, candidate.sourceSync);
    if (!verdict.pass) {
      throw new Error(
        `Lipsync-2-Pro output still fails SyncNet (${verdict.reason}).`
      );
    }
    return { videoUrl: finalized.videoUrl, audioVerified: true };
  }
  throw new Error(
    "Lipsync-2-Pro remained unresolved after the extended reconciliation window."
  );
}

async function runGenerationAttempt(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  renderedPrompt: string
): Promise<VideoGenerationOperationResult> {
  await enterGenerationPhaseWithRecovery(input, workflowRunId, iteration);
  let checkpoint = await readGenerationCheckpointWithRecovery(
    input,
    workflowRunId,
    iteration,
    renderedPrompt
  );
  for (
    let attempt = 0;
    checkpoint.state === "unclaimed" && attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const preparedUploadUri = await prepareAttempt(
        input,
        workflowRunId,
        iteration
      );
      const started = await startAttempt(
        input,
        workflowRunId,
        iteration,
        renderedPrompt,
        preparedUploadUri
      );
      checkpoint = {
        state: "started",
        interactionId: started.interactionId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        isLampUserActionRequiredError(error)
      ) {
        throw error;
      }
      checkpoint = await readGenerationCheckpointWithRecovery(
        input,
        workflowRunId,
        iteration,
        renderedPrompt
      );
      if (checkpoint.state === "ambiguous") throw error;
      if (checkpoint.state === "unclaimed") await sleep("5m");
    }
  }
  if (checkpoint.state === "completed") {
    try {
      await recordProviderWorkflowCompleted(input, workflowRunId, iteration);
    } catch {
      // The completed artifact journal is authoritative; this display-only
      // provider workflow marker can be repaired by later bookkeeping.
    }
    return checkpoint.result;
  }
  if (checkpoint.state !== "started") {
    throw new Error(
      checkpoint.state === "ambiguous"
        ? `Generation ${iteration} has an ambiguous durable start and requires reconciliation.`
        : `Generation ${iteration} could not pass its retry-safe preparation boundary within seven days.`
    );
  }
  try {
    await recordProviderWorkflowRunning(
      input,
      workflowRunId,
      iteration
    );
  } catch {
    // The provider handle is already durable. Settlement replays bookkeeping.
  }

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    await sleep("8s");
    try {
      const result = await pollAttempt({
      runId: input.runId,
      iteration,
      interactionId: checkpoint.interactionId,
      });
      if (result.done) {
        try {
          await recordProviderWorkflowCompleted(input, workflowRunId, iteration);
        } catch {
          // Result commitment, not this secondary marker, is the paid boundary.
        }
        return result;
      }
    } catch (pollError) {
      const disposition = await inspectAttemptAfterPollErrorWithRecovery(
        input,
        workflowRunId,
        iteration,
        renderedPrompt
      );
      if (disposition === "completed") {
        const completed = await readCompletedGenerationWithRecovery(
          input.runId,
          iteration
        );
        try {
          await recordProviderWorkflowCompleted(input, workflowRunId, iteration);
        } catch {
          // The committed provider result remains safe to continue from.
        }
        return completed;
      }
      if (disposition !== "retryable") throw pollError;
    }
  }

  for (let poll = 0; poll < MAX_RECONCILIATION_POLLS; poll += 1) {
    await sleep("5m");
    try {
      const result = await pollAttempt({
        runId: input.runId,
        iteration,
        interactionId: checkpoint.interactionId,
      });
      if (result.done) {
        try {
          await recordProviderWorkflowCompleted(input, workflowRunId, iteration);
        } catch {
          // The committed provider result remains safe to continue from.
        }
        return result;
      }
    } catch (pollError) {
      const disposition = await inspectAttemptAfterPollErrorWithRecovery(
        input,
        workflowRunId,
        iteration,
        renderedPrompt
      );
      if (disposition === "completed") {
        const completed = await readCompletedGenerationWithRecovery(
          input.runId,
          iteration
        );
        try {
          await recordProviderWorkflowCompleted(input, workflowRunId, iteration);
        } catch {
          // The committed provider result remains safe to continue from.
        }
        return completed;
      }
      if (disposition !== "retryable") throw pollError;
    }
  }
  throw new Error(
    `Video generation ${iteration} remained unresolved after seven days of non-billed reconciliation.`
  );
}

type GenerationCheckpoint =
  | { state: "unclaimed" }
  | { state: "started"; interactionId: string }
  | { state: "completed"; result: VideoGenerationOperationResult }
  | { state: "ambiguous" };

async function readGenerationCheckpoint(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: number,
  renderedPrompt: string
): Promise<GenerationCheckpoint> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.phase !== "video_generation" ||
    execution.iteration !== iteration
  ) {
    return { state: "ambiguous" };
  }
  const operation = run?.providerOperations?.find(
    (item) => item.id === videoGenerationOperationId(iteration)
  );
  if (!operation) return { state: "unclaimed" };
  if (operation.renderedPrompt !== renderedPrompt) return { state: "ambiguous" };
  if (operation.status === "completed" && operation.result) {
    return { state: "completed", result: operation.result };
  }
  if (operation.providerInteractionId) {
    return { state: "started", interactionId: operation.providerInteractionId };
  }
  return { state: "ambiguous" };
}

readGenerationCheckpoint.maxRetries = 2;

async function readGenerationCheckpointWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: number,
  renderedPrompt: string
): Promise<GenerationCheckpoint> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS; attempt += 1) {
    try {
      return await readGenerationCheckpoint(
        input,
        workflowRunId,
        iteration,
        renderedPrompt
      );
    } catch (error) {
      lastError = error;
    }
    await sleep("5m");
  }
  throw (lastError instanceof Error
    ? lastError
    : new Error(
        `Generation ${iteration} checkpoint could not be read within seven days.`
      ));
}

async function bindExecution(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<RunExecution["source"] | null> {
  "use step";
  const storage = getStorage();
  const current = await storage.getRunExecution(input.runId);
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.inputHash !== runExecutionInputHash(input.renderedPrompt)
  ) {
    return null;
  }
  if (current.workflowRunId) {
    return current.workflowRunId === workflowRunId && current.status === "running"
      ? current.source
      : null;
  }
  if (current.status !== "queued" || current.phase !== "queued") return null;
  const candidate: RunExecution = {
    ...current,
    status: "running",
    phase: "preparing",
    workflowRunId,
    revision: current.revision + 1,
    updatedAt: Math.max(Date.now(), current.updatedAt),
  };
  const advanced = await storage.advanceRunExecution(candidate, current.revision);
  const durable = advanced.execution;
  return durable?.workflowRunId === workflowRunId && durable.status === "running"
    ? durable.source
    : null;
}

bindExecution.maxRetries = 2;

async function enterGenerationPhase(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2
): Promise<boolean> {
  "use step";
  const storage = getStorage();
  const current = await storage.getRunExecution(input.runId);
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.workflowRunId !== workflowRunId ||
    current.status !== "running"
  ) {
    return false;
  }
  if (
    current.iteration === iteration &&
    current.phase === "video_generation"
  ) {
    return true;
  }
  const validPrior =
    iteration === 1
      ? current.iteration === 0 && current.phase === "preparing"
      : current.iteration === 1 && current.phase === "evaluating";
  if (!validPrior) return false;
  const candidate: RunExecution = {
    ...current,
    iteration,
    phase: "video_generation",
    revision: current.revision + 1,
    updatedAt: Math.max(Date.now(), current.updatedAt),
  };
  const advanced = await storage.advanceRunExecution(candidate, current.revision);
  return Boolean(
    advanced.execution?.workflowRunId === workflowRunId &&
      advanced.execution.status === "running" &&
      advanced.execution.iteration === iteration &&
      advanced.execution.phase === "video_generation"
  );
}

enterGenerationPhase.maxRetries = 2;

type PhaseRecoveryDisposition = "entered" | "retryable" | "terminal";

async function generationPhaseDisposition(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2
): Promise<PhaseRecoveryDisposition> {
  "use step";
  const current = await getStorage().getRunExecution(input.runId);
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.workflowRunId !== workflowRunId ||
    current.status !== "running"
  ) {
    return "terminal";
  }
  if (
    current.iteration === iteration &&
    current.phase === "video_generation"
  ) {
    return "entered";
  }
  const validPrior =
    iteration === 1
      ? current.iteration === 0 && current.phase === "preparing"
      : current.iteration === 1 && current.phase === "evaluating";
  return validPrior ? "retryable" : "terminal";
}

generationPhaseDisposition.maxRetries = 2;

async function enterGenerationPhaseWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS; attempt += 1) {
    try {
      if (await enterGenerationPhase(input, workflowRunId, iteration)) return;
    } catch (error) {
      lastError = error;
    }
    let disposition: PhaseRecoveryDisposition;
    try {
      disposition = await generationPhaseDisposition(
        input,
        workflowRunId,
        iteration
      );
    } catch (error) {
      lastError = error;
      await sleep("5m");
      continue;
    }
    if (disposition === "entered") return;
    if (disposition === "terminal") {
      throw (lastError instanceof Error
        ? lastError
        : new Error("Durable run execution no longer owns generation."));
    }
    await sleep("5m");
  }
  throw new Error(
    `Generation ${iteration} could not cross its retry-safe phase checkpoint within seven days.`
  );
}

async function enterEvaluationPhase(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2
): Promise<void> {
  "use step";
  const storage = getStorage();
  const current = await storage.getRunExecution(input.runId);
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.workflowRunId !== workflowRunId ||
    current.status !== "running" ||
    current.iteration !== iteration
  ) {
    throw new Error("Durable run execution no longer owns evaluation.");
  }
  if (current.phase === "evaluating") return;
  if (current.phase !== "video_generation") {
    throw new Error("Lamp evaluation cannot start from this execution phase.");
  }
  const run = await storage.getRun(input.runId);
  const generation = run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(iteration)
  );
  if (generation?.status !== "completed" || !generation.result) {
    throw new Error("Lamp evaluation cannot start before generation is complete.");
  }
  if (!generation.result.audioVerified) {
    throw new Error(
      `Lamp generation ${iteration} failed original-audio verification; no paid visual evaluation was started.`
    );
  }
  const candidate: RunExecution = {
    ...current,
    phase: "evaluating",
    revision: current.revision + 1,
    updatedAt: Math.max(Date.now(), current.updatedAt),
  };
  const advanced = await storage.advanceRunExecution(candidate, current.revision);
  if (
    advanced.execution?.workflowRunId !== workflowRunId ||
    advanced.execution.status !== "running" ||
    advanced.execution.iteration !== iteration ||
    advanced.execution.phase !== "evaluating"
  ) {
    throw new Error("Lamp evaluation phase lost its durable ownership.");
  }
}

enterEvaluationPhase.maxRetries = 2;

async function evaluationPhaseDisposition(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2
): Promise<PhaseRecoveryDisposition> {
  "use step";
  const storage = getStorage();
  const [current, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.workflowRunId !== workflowRunId ||
    current.status !== "running" ||
    current.iteration !== iteration
  ) {
    return "terminal";
  }
  if (current.phase === "evaluating") return "entered";
  if (current.phase !== "video_generation") return "terminal";
  const generation = run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(iteration)
  );
  if (!generation) return "retryable";
  if (
    generation.status === "completed" &&
    generation.result?.audioVerified
  ) {
    return "retryable";
  }
  return "terminal";
}

evaluationPhaseDisposition.maxRetries = 2;

async function enterEvaluationPhaseWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS; attempt += 1) {
    try {
      await enterEvaluationPhase(input, workflowRunId, iteration);
      return;
    } catch (error) {
      lastError = error;
    }
    let disposition: PhaseRecoveryDisposition;
    try {
      disposition = await evaluationPhaseDisposition(
        input,
        workflowRunId,
        iteration
      );
    } catch (error) {
      lastError = error;
      await sleep("5m");
      continue;
    }
    if (disposition === "entered") return;
    if (disposition === "terminal") {
      throw (lastError instanceof Error
        ? lastError
        : new Error("Durable run execution no longer owns evaluation."));
    }
    await sleep("5m");
  }
  throw new Error(
    `Lamp evaluation ${iteration} could not cross its retry-safe phase checkpoint within seven days.`
  );
}

async function prepareAttempt(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2
): Promise<string> {
  "use step";
  await assertGenerationOwner(input, workflowRunId, iteration);
  const [run, execution] = await Promise.all([
    getStorage().getRun(input.runId),
    getStorage().getRunExecution(input.runId),
  ]);
  if (!run || !execution || execution.executionId !== input.executionId) {
    throw new Error("Run not found during Lamp preparation.");
  }
  const workflowMode = workflowModeFromExecutionId(execution.executionId);
  if (
    workflowMode === "background" ||
    workflowMode === "beautify" ||
    workflowMode === "iris" ||
    workflowMode === "combined"
  ) {
    if (workflowMode === "combined") {
      const planOperations = await Promise.all(
        (execution.combinedPlanOperationIds ?? []).map(async (operationId) => {
          const operation = await getStorage().getPaidOperation(
            input.runId,
            operationId
          );
          if (!operation) throw new Error(`Missing Combined planner ${operationId}.`);
          return operation;
        })
      );
      await validateLampCombinedExecutionBinding({
        run,
        execution,
        planOperations,
      });
    } else {
    const planOperation = execution.planOperationId
      ? await getStorage().getPaidOperation(
          input.runId,
          execution.planOperationId
        )
      : null;
    if (workflowMode === "iris") {
      await validateLampIrisExecutionBinding({
        run,
        execution,
        planOperation,
      });
    } else if (workflowMode === "beautify") {
      await validateLampBeautifyExecutionBinding({
        run,
        execution,
        planOperation,
      });
    } else {
      await validateLampBackgroundExecutionBinding({
        run,
        execution,
        planOperation,
      });
    }
    }
  }
  try {
    assertVideoGenerationAuthorized(run, iteration);
  } catch (error) {
    // A valid exact Lamp grant means this is an orchestration invariant (for
    // example, a missing prior completion), not something another user click
    // can repair. Only an absent/expired/mismatched Lamp grant is resumable.
    const reusableApproval =
      workflowMode === "combined"
        ? hasReusableLampCombinedApproval(
            run,
            execution.source,
            execution.batchId
          )
      : workflowMode === "iris"
        ? hasReusableLampIrisApproval(
            run,
            execution.source,
            execution.batchId
          )
        : workflowMode === "beautify"
        ? hasReusableLampBeautifyApproval(
            run,
            execution.source,
            execution.batchId
          )
        : workflowMode === "background"
        ? hasReusableLampBackgroundApproval(
            run,
            execution.source,
            execution.batchId
          )
        : workflowMode === "lamp"
          ? hasReusableLampApproval(
              run,
              execution.source,
              execution.batchId
            )
          : false;
    if (reusableApproval) {
      throw error;
    }
    throw new Error(
      `${LAMP_USER_ACTION_REQUIRED_PREFIX}${error instanceof Error ? error.message : "Two-pass spend approval must be renewed."}`
    );
  }
  return prepareVideoGenerationStart(input.runId);
}

prepareAttempt.maxRetries = 2;

async function startAttempt(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: number,
  renderedPrompt: string,
  preparedUploadUri: string
): Promise<ClaimAndStartVideoGenerationResult> {
  "use step";
  await assertGenerationOwner(input, workflowRunId, iteration);
  try {
    return await claimAndStartVideoGeneration({
      runId: input.runId,
      iteration,
      renderedPrompt,
      preparedUploadUri,
      requireExactPrompt: true,
    });
  } catch (error) {
    if (
      error instanceof VideoGenerationStartError &&
      error.code === "not_authorized"
    ) {
      throw new Error(`${LAMP_USER_ACTION_REQUIRED_PREFIX}${error.message}`);
    }
    throw error;
  }
}

startAttempt.maxRetries = 0;

async function assertGenerationOwner(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: number
): Promise<void> {
  const current = await getStorage().getRunExecution(input.runId);
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.inputHash !== runExecutionInputHash(input.renderedPrompt) ||
    current.workflowRunId !== workflowRunId ||
    current.status !== "running" ||
    current.phase !== "video_generation" ||
    current.iteration !== iteration
  ) {
    throw new Error("Durable run execution no longer owns generation.");
  }
}

/**
 * Ownership assert for every V2 sync-gate step. The gate historically ran
 * inside the video_generation phase; since the Final holistic evaluation
 * moved ahead of it, the gate normally executes inside the evaluating phase.
 * Accept both so pre-reorder executions resumed mid-flight keep their
 * ownership guarantees instead of dying on a phase mismatch.
 */
async function assertV2FinalizeOwner(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<void> {
  const current = await getStorage().getRunExecution(input.runId);
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.inputHash !== runExecutionInputHash(input.renderedPrompt) ||
    current.workflowRunId !== workflowRunId ||
    current.status !== "running" ||
    (current.phase !== "video_generation" && current.phase !== "evaluating") ||
    current.iteration !== 2
  ) {
    throw new Error("Durable run execution no longer owns the V2 sync gate.");
  }
}

async function readV2SyncCheckpointStep(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<V2LipsyncCheckpoint> {
  "use step";
  await assertV2FinalizeOwner(input, workflowRunId);
  return readV2LipsyncCheckpoint(input.runId);
}

readV2SyncCheckpointStep.maxRetries = 2;

async function readSourceSyncBaselineStep(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<SyncNetMetrics | null> {
  "use step";
  await assertV2FinalizeOwner(input, workflowRunId);
  return ensureSourceSyncBaseline(input.runId);
}

readSourceSyncBaselineStep.maxRetries = 2;

async function readAcceptedV2CandidateStep(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<string | null> {
  "use step";
  await assertV2FinalizeOwner(input, workflowRunId);
  return (await readAcceptedV2Candidate(input, workflowRunId))?.videoUrl ?? null;
}

async function readAcceptedV2Candidate(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<V2CandidateSyncCheck | null> {
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  const finalGeneration = run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(2)
  );
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.renderedPrompt !== input.renderedPrompt ||
    !run ||
    !isGradeableVideoGeneration(finalGeneration) ||
    typeof finalGeneration?.renderedPrompt !== "string" ||
    !finalGeneration.result
  ) {
    return null;
  }
  if (!v2SyncSettlementVerified({
    runId: input.runId,
    candidateVerdict: execution.candidateSyncVerdict,
    finalGeneration,
    lipsync: null,
    canonicalSourceSync: run.originalVideo.syncBaseline,
    sourceHasAudio: run.originalVideo.hasAudio,
  })) {
    return null;
  }
  const verdict = execution.candidateSyncVerdict;
  if (!verdict) return null;
  return verdict.outcome === "skipped"
    ? {
        skipped: true,
        videoUrl: finalGeneration.result.videoUrl,
        skipReason: verdict.skipReason,
      }
    : {
        skipped: false,
        videoUrl: finalGeneration.result.videoUrl,
        metrics: verdict.metrics,
        sourceSync: verdict.sourceSync,
      };
}

readAcceptedV2CandidateStep.maxRetries = 2;

async function analyzeV2CandidateStep(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<V2CandidateSyncCheck> {
  "use step";
  await assertV2FinalizeOwner(input, workflowRunId);
  // Step retries restart this function. Re-read the server-owned receipt
  // before calling SyncNet so a response lost after the CAS cannot produce a
  // different noisy analysis and accidentally authorize a paid repair.
  const journaled = await readAcceptedV2Candidate(input, workflowRunId);
  if (journaled) return journaled;
  const candidate = await analyzeV2Candidate(input.runId);
  if (candidate.skipped) {
    await recordV2CandidateSyncVerdict({
      runId: input.runId,
      executionId: input.executionId,
      workflowRunId,
      evidence: {
        outcome: "skipped",
        skipReason: candidate.skipReason,
      },
    });
    return candidate;
  }
  if (v2SyncVerdict(candidate.metrics, candidate.sourceSync).pass) {
    await recordV2CandidateSyncVerdict({
      runId: input.runId,
      executionId: input.executionId,
      workflowRunId,
      evidence: {
        outcome: "passed",
        metrics: candidate.metrics,
        sourceSync: candidate.sourceSync,
      },
    });
  }
  return candidate;
}

analyzeV2CandidateStep.maxRetries = 2;

async function prepareV2LipsyncInputsStep(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<PreparedLipsyncInputs> {
  "use step";
  await assertV2FinalizeOwner(input, workflowRunId);
  return prepareV2LipsyncInputs(input.runId);
}

prepareV2LipsyncInputsStep.maxRetries = 2;

async function startV2LipsyncPredictionStep(
  input: DurableRelightRunInput,
  workflowRunId: string,
  prepared: PreparedLipsyncInputs,
  preSync: SyncNetMetrics
): Promise<string> {
  "use step";
  await assertV2FinalizeOwner(input, workflowRunId);
  try {
    return await startV2LipsyncPrediction({
      runId: input.runId,
      prepared,
      preSync,
    });
  } catch (error) {
    if (error instanceof PaidOperationAuthorizationError) {
      throw new Error(`${LAMP_USER_ACTION_REQUIRED_PREFIX}${error.message}`);
    }
    throw error;
  }
}

startV2LipsyncPredictionStep.maxRetries = 0;

async function pollV2LipsyncPredictionStep(
  input: DurableRelightRunInput,
  workflowRunId: string,
  predictionId: string
): Promise<V2LipsyncPollResult> {
  "use step";
  await assertV2FinalizeOwner(input, workflowRunId);
  return pollV2LipsyncPrediction({ runId: input.runId, predictionId });
}

pollV2LipsyncPredictionStep.maxRetries = 2;

async function finalizeV2LipsyncStep(
  input: DurableRelightRunInput,
  workflowRunId: string,
  predictionId: string,
  outputUrl: string,
  preSync: SyncNetMetrics
): Promise<LipsyncOperationResult> {
  "use step";
  await assertV2FinalizeOwner(input, workflowRunId);
  return finalizeV2Lipsync({
    runId: input.runId,
    predictionId,
    outputUrl,
    preSync,
  });
}

finalizeV2LipsyncStep.maxRetries = 2;

async function evaluateAttempt(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  previousResults: LampEvaluationArtifact["evalResults"]
): Promise<LampEvaluationArtifact> {
  "use step";
  const execution = await getStorage().getRunExecution(input.runId);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.phase !== "evaluating" ||
    execution.iteration !== iteration ||
    !execution.executionId.startsWith("lamp:")
  ) {
    throw new Error("Durable run execution no longer owns Lamp evaluation.");
  }
  try {
    return await runLampHolisticEvaluation({
      runId: input.runId,
      iteration,
      previousResults,
    });
  } catch (error) {
    if (error instanceof PaidOperationAuthorizationError) {
      throw new Error(`${LAMP_USER_ACTION_REQUIRED_PREFIX}${error.message}`);
    }
    throw error;
  }
}

// A provider call may bill. The paid-operation journal, not Workflow retries,
// is the only authority allowed to replay its result.
evaluateAttempt.maxRetries = 0;

type EvaluationCheckpoint =
  | { state: "unclaimed" }
  | { state: "completed"; result: LampEvaluationArtifact }
  | { state: "ambiguous" };

async function readEvaluationCheckpoint(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2
): Promise<EvaluationCheckpoint> {
  "use step";
  const storage = getStorage();
  const [execution, operation] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getPaidOperation(
      input.runId,
      lampEvaluationOperationId(iteration)
    ),
  ]);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.phase !== "evaluating" ||
    execution.iteration !== iteration
  ) {
    return { state: "ambiguous" };
  }
  if (!operation) return { state: "unclaimed" };
  if (
    operation.status === "completed" &&
    isLampEvaluationArtifact(operation.result, iteration)
  ) {
    return { state: "completed", result: operation.result };
  }
  return { state: "ambiguous" };
}

readEvaluationCheckpoint.maxRetries = 2;

async function readEvaluationCheckpointWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2
): Promise<EvaluationCheckpoint> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS; attempt += 1) {
    try {
      return await readEvaluationCheckpoint(input, workflowRunId, iteration);
    } catch (error) {
      lastError = error;
    }
    await sleep("5m");
  }
  throw (lastError instanceof Error
    ? lastError
    : new Error(
        `Lamp evaluation ${iteration} checkpoint could not be read within seven days.`
      ));
}

async function evaluateAttemptWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  previousResults: LampEvaluationArtifact["evalResults"]
): Promise<LampEvaluationArtifact> {
  let checkpoint = await readEvaluationCheckpointWithRecovery(
    input,
    workflowRunId,
    iteration
  );
  for (
    let attempt = 0;
    checkpoint.state === "unclaimed" && attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await evaluateAttempt(
        input,
        workflowRunId,
        iteration,
        previousResults
      );
    } catch (error) {
      if (
        error instanceof Error &&
        isLampUserActionRequiredError(error)
      ) {
        throw error;
      }
      checkpoint = await readEvaluationCheckpointWithRecovery(
        input,
        workflowRunId,
        iteration
      );
      if (checkpoint.state === "completed") return checkpoint.result;
      if (checkpoint.state === "ambiguous") throw error;
      await sleep("5m");
    }
  }
  if (checkpoint.state === "completed") return checkpoint.result;
  throw new Error(
    checkpoint.state === "ambiguous"
      ? `Lamp evaluation ${iteration} has an ambiguous paid operation and requires reconciliation.`
      : `Lamp evaluation ${iteration} could not cross its pre-claim boundary within seven days.`
  );
}

async function evaluateBackgroundAttempt(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  cleanupPlan: LampBackgroundCleanupPlan,
  previousResults: LampBackgroundEvalResult[]
): Promise<LampBackgroundEvaluationArtifact> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.phase !== "evaluating" ||
    execution.iteration !== iteration ||
    !execution.executionId.startsWith("lamp-background:")
  ) {
    throw new Error(
      "Durable run execution no longer owns Lamp Background evaluation."
    );
  }
  const planOperation = execution.planOperationId
    ? await storage.getPaidOperation(
        input.runId,
        execution.planOperationId
      )
    : null;
  const boundPlan = await validateLampBackgroundExecutionBinding({
    run,
    execution,
    planOperation,
  });
  if (boundPlan.id !== cleanupPlan.id) {
    throw new Error(
      "Lamp Background evaluation plan changed after Workflow binding."
    );
  }
  try {
    return await runLampBackgroundHolisticEvaluation({
      runId: input.runId,
      iteration,
      cleanupPlan: boundPlan,
      previousResults,
    });
  } catch (error) {
    if (error instanceof PaidOperationAuthorizationError) {
      throw new Error(`${LAMP_USER_ACTION_REQUIRED_PREFIX}${error.message}`);
    }
    throw error;
  }
}

evaluateBackgroundAttempt.maxRetries = 0;

type BackgroundEvaluationCheckpoint =
  | { state: "unclaimed" }
  | { state: "completed"; result: LampBackgroundEvaluationArtifact }
  | { state: "ambiguous" };

async function readBackgroundEvaluationCheckpoint(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  cleanupPlanId: string
): Promise<BackgroundEvaluationCheckpoint> {
  "use step";
  const storage = getStorage();
  const [execution, operation] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getPaidOperation(
      input.runId,
      lampBackgroundEvaluationOperationId(iteration)
    ),
  ]);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.phase !== "evaluating" ||
    execution.iteration !== iteration ||
    !execution.executionId.startsWith("lamp-background:")
  ) {
    return { state: "ambiguous" };
  }
  if (!operation) return { state: "unclaimed" };
  if (
    operation.status === "completed" &&
    isLampBackgroundEvaluationArtifact(operation.result, iteration) &&
    operation.result.cleanupPlanId === cleanupPlanId
  ) {
    return { state: "completed", result: operation.result };
  }
  return { state: "ambiguous" };
}

readBackgroundEvaluationCheckpoint.maxRetries = 2;

async function readBackgroundEvaluationCheckpointWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  cleanupPlanId: string
): Promise<BackgroundEvaluationCheckpoint> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS; attempt += 1) {
    try {
      return await readBackgroundEvaluationCheckpoint(
        input,
        workflowRunId,
        iteration,
        cleanupPlanId
      );
    } catch (error) {
      lastError = error;
    }
    await sleep("5m");
  }
  throw (lastError instanceof Error
    ? lastError
    : new Error(
        `Lamp Background evaluation ${iteration} checkpoint could not be read within seven days.`
      ));
}

async function evaluateBackgroundAttemptWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  cleanupPlan: LampBackgroundCleanupPlan,
  previousResults: LampBackgroundEvalResult[]
): Promise<LampBackgroundEvaluationArtifact> {
  let checkpoint =
    await readBackgroundEvaluationCheckpointWithRecovery(
      input,
      workflowRunId,
      iteration,
      cleanupPlan.id
    );
  for (
    let attempt = 0;
    checkpoint.state === "unclaimed" &&
    attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await evaluateBackgroundAttempt(
        input,
        workflowRunId,
        iteration,
        cleanupPlan,
        previousResults
      );
    } catch (error) {
      if (
        error instanceof Error &&
        isLampUserActionRequiredError(error)
      ) {
        throw error;
      }
      checkpoint =
        await readBackgroundEvaluationCheckpointWithRecovery(
          input,
          workflowRunId,
          iteration,
          cleanupPlan.id
        );
      if (checkpoint.state === "completed") return checkpoint.result;
      if (checkpoint.state === "ambiguous") throw error;
      await sleep("5m");
    }
  }
  if (checkpoint.state === "completed") return checkpoint.result;
  throw new Error(
    checkpoint.state === "ambiguous"
      ? `Lamp Background evaluation ${iteration} has an ambiguous paid operation and requires reconciliation.`
      : `Lamp Background evaluation ${iteration} could not cross its pre-claim boundary within seven days.`
  );
}

async function evaluateBeautifyAttempt(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  plan: LampBeautifyPlan,
  previousResults: LampBeautifyEvalResult[]
): Promise<LampBeautifyEvaluationArtifact> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.phase !== "evaluating" ||
    execution.iteration !== iteration ||
    !execution.executionId.startsWith("lamp-beautify:")
  ) {
    throw new Error(
      "Durable run execution no longer owns Lamp Beautify evaluation."
    );
  }
  const planOperation = execution.planOperationId
    ? await storage.getPaidOperation(
        input.runId,
        execution.planOperationId
      )
    : null;
  const boundPlan = await validateLampBeautifyExecutionBinding({
    run,
    execution,
    planOperation,
  });
  if (boundPlan.id !== plan.id) {
    throw new Error(
      "Lamp Beautify evaluation plan changed after Workflow binding."
    );
  }
  try {
    return await runLampBeautifyHolisticEvaluation({
      runId: input.runId,
      iteration,
      plan: boundPlan,
      previousResults,
    });
  } catch (error) {
    if (error instanceof PaidOperationAuthorizationError) {
      throw new Error(`${LAMP_USER_ACTION_REQUIRED_PREFIX}${error.message}`);
    }
    throw error;
  }
}

evaluateBeautifyAttempt.maxRetries = 0;

type BeautifyEvaluationCheckpoint =
  | { state: "unclaimed" }
  | { state: "completed"; result: LampBeautifyEvaluationArtifact }
  | { state: "ambiguous" };

async function readBeautifyEvaluationCheckpoint(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  planId: string
): Promise<BeautifyEvaluationCheckpoint> {
  "use step";
  const storage = getStorage();
  const [execution, operation] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getPaidOperation(
      input.runId,
      lampBeautifyEvaluationOperationId(iteration)
    ),
  ]);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.phase !== "evaluating" ||
    execution.iteration !== iteration ||
    !execution.executionId.startsWith("lamp-beautify:")
  ) {
    return { state: "ambiguous" };
  }
  if (!operation) return { state: "unclaimed" };
  if (
    operation.status === "completed" &&
    isLampBeautifyEvaluationArtifact(operation.result, iteration) &&
    operation.result.planId === planId
  ) {
    return { state: "completed", result: operation.result };
  }
  return { state: "ambiguous" };
}

readBeautifyEvaluationCheckpoint.maxRetries = 2;

async function readBeautifyEvaluationCheckpointWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  planId: string
): Promise<BeautifyEvaluationCheckpoint> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS; attempt += 1) {
    try {
      return await readBeautifyEvaluationCheckpoint(
        input,
        workflowRunId,
        iteration,
        planId
      );
    } catch (error) {
      lastError = error;
    }
    await sleep("5m");
  }
  throw (lastError instanceof Error
    ? lastError
    : new Error(
        `Lamp Beautify evaluation ${iteration} checkpoint could not be read within seven days.`
      ));
}

async function evaluateBeautifyAttemptWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  plan: LampBeautifyPlan,
  previousResults: LampBeautifyEvalResult[]
): Promise<LampBeautifyEvaluationArtifact> {
  let checkpoint = await readBeautifyEvaluationCheckpointWithRecovery(
    input,
    workflowRunId,
    iteration,
    plan.id
  );
  for (
    let attempt = 0;
    checkpoint.state === "unclaimed" &&
    attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await evaluateBeautifyAttempt(
        input,
        workflowRunId,
        iteration,
        plan,
        previousResults
      );
    } catch (error) {
      if (
        error instanceof Error &&
        isLampUserActionRequiredError(error)
      ) {
        throw error;
      }
      checkpoint = await readBeautifyEvaluationCheckpointWithRecovery(
        input,
        workflowRunId,
        iteration,
        plan.id
      );
      if (checkpoint.state === "completed") return checkpoint.result;
      if (checkpoint.state === "ambiguous") throw error;
      await sleep("5m");
    }
  }
  if (checkpoint.state === "completed") return checkpoint.result;
  throw new Error(
    checkpoint.state === "ambiguous"
      ? `Lamp Beautify evaluation ${iteration} has an ambiguous paid operation and requires reconciliation.`
      : `Lamp Beautify evaluation ${iteration} could not cross its pre-claim boundary within seven days.`
  );
}

async function evaluateIrisAttempt(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  plan: LampIrisPlan,
  previousResults: LampIrisEvalResult[]
): Promise<LampIrisEvaluationArtifact> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.phase !== "evaluating" ||
    execution.iteration !== iteration ||
    !execution.executionId.startsWith("lamp-iris:")
  ) {
    throw new Error(
      "Durable run execution no longer owns Lamp Iris evaluation."
    );
  }
  const planOperation = execution.planOperationId
    ? await storage.getPaidOperation(
        input.runId,
        execution.planOperationId
      )
    : null;
  const boundPlan = await validateLampIrisExecutionBinding({
    run,
    execution,
    planOperation,
  });
  if (boundPlan.id !== plan.id) {
    throw new Error(
      "Lamp Iris evaluation plan changed after Workflow binding."
    );
  }
  try {
    return await runLampIrisHolisticEvaluation({
      runId: input.runId,
      iteration,
      plan: boundPlan,
      previousResults,
    });
  } catch (error) {
    if (error instanceof PaidOperationAuthorizationError) {
      throw new Error(`${LAMP_USER_ACTION_REQUIRED_PREFIX}${error.message}`);
    }
    throw error;
  }
}

evaluateIrisAttempt.maxRetries = 0;

type IrisEvaluationCheckpoint =
  | { state: "unclaimed" }
  | { state: "completed"; result: LampIrisEvaluationArtifact }
  | { state: "ambiguous" };

async function readIrisEvaluationCheckpoint(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  planId: string
): Promise<IrisEvaluationCheckpoint> {
  "use step";
  const storage = getStorage();
  const [execution, operation] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getPaidOperation(
      input.runId,
      lampIrisEvaluationOperationId(iteration)
    ),
  ]);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.phase !== "evaluating" ||
    execution.iteration !== iteration ||
    !execution.executionId.startsWith("lamp-iris:")
  ) {
    return { state: "ambiguous" };
  }
  if (!operation) return { state: "unclaimed" };
  if (
    operation.status === "completed" &&
    isLampIrisEvaluationArtifact(operation.result, iteration) &&
    operation.result.planId === planId
  ) {
    return { state: "completed", result: operation.result };
  }
  return { state: "ambiguous" };
}

readIrisEvaluationCheckpoint.maxRetries = 2;

async function readIrisEvaluationCheckpointWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  planId: string
): Promise<IrisEvaluationCheckpoint> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS; attempt += 1) {
    try {
      return await readIrisEvaluationCheckpoint(
        input,
        workflowRunId,
        iteration,
        planId
      );
    } catch (error) {
      lastError = error;
    }
    await sleep("5m");
  }
  throw (lastError instanceof Error
    ? lastError
    : new Error(
        `Lamp Iris evaluation ${iteration} checkpoint could not be read within seven days.`
      ));
}

async function evaluateIrisAttemptWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  plan: LampIrisPlan,
  previousResults: LampIrisEvalResult[]
): Promise<LampIrisEvaluationArtifact> {
  let checkpoint = await readIrisEvaluationCheckpointWithRecovery(
    input,
    workflowRunId,
    iteration,
    plan.id
  );
  for (
    let attempt = 0;
    checkpoint.state === "unclaimed" &&
    attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await evaluateIrisAttempt(
        input,
        workflowRunId,
        iteration,
        plan,
        previousResults
      );
    } catch (error) {
      if (
        error instanceof Error &&
        isLampUserActionRequiredError(error)
      ) {
        throw error;
      }
      checkpoint = await readIrisEvaluationCheckpointWithRecovery(
        input,
        workflowRunId,
        iteration,
        plan.id
      );
      if (checkpoint.state === "completed") return checkpoint.result;
      if (checkpoint.state === "ambiguous") throw error;
      await sleep("5m");
    }
  }
  if (checkpoint.state === "completed") return checkpoint.result;
  throw new Error(
    checkpoint.state === "ambiguous"
      ? `Lamp Iris evaluation ${iteration} has an ambiguous paid operation and requires reconciliation.`
      : `Lamp Iris evaluation ${iteration} could not cross its pre-claim boundary within seven days.`
  );
}

async function evaluateCombinedAttempt(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  plan: LampCombinedPlan,
  previousArtifact?: LampCombinedEvaluationArtifact
): Promise<LampCombinedEvaluationArtifact> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.phase !== "evaluating" ||
    execution.iteration !== iteration ||
    execution.executionId !== `lamp-combined:${input.runId}`
  ) {
    throw new Error(
      "Durable run execution no longer owns Lamp Combined evaluation."
    );
  }
  const operations = await Promise.all(
    (execution.combinedPlanOperationIds ?? []).map(async (operationId) => {
      const operation = await storage.getPaidOperation(input.runId, operationId);
      if (!operation) throw new Error(`Missing Combined planner ${operationId}.`);
      return operation;
    })
  );
  const boundPlan = await validateLampCombinedExecutionBinding({
    run,
    execution,
    planOperations: operations,
  });
  if (
    boundPlan.id !== plan.id ||
    (await hashLampCombinedPlan(boundPlan)) !==
      (await hashLampCombinedPlan(plan))
  ) {
    throw new Error(
      "Lamp Combined evaluation aggregate changed after Workflow binding."
    );
  }
  try {
    return await runLampCombinedHolisticEvaluation({
      runId: input.runId,
      iteration,
      plan: boundPlan,
      previousArtifact,
    });
  } catch (error) {
    if (error instanceof PaidOperationAuthorizationError) {
      throw new Error(`${LAMP_USER_ACTION_REQUIRED_PREFIX}${error.message}`);
    }
    throw error;
  }
}

evaluateCombinedAttempt.maxRetries = 0;

type CombinedEvaluationCheckpoint =
  | { state: "unclaimed" }
  | { state: "completed"; result: LampCombinedEvaluationArtifact }
  | { state: "ambiguous" };

async function readCombinedEvaluationCheckpoint(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  plan: LampCombinedPlan
): Promise<CombinedEvaluationCheckpoint> {
  "use step";
  const storage = getStorage();
  const [execution, operation] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getPaidOperation(
      input.runId,
      lampCombinedEvaluationOperationId(iteration)
    ),
  ]);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.phase !== "evaluating" ||
    execution.iteration !== iteration ||
    execution.executionId !== `lamp-combined:${input.runId}`
  ) {
    return { state: "ambiguous" };
  }
  if (!operation) return { state: "unclaimed" };
  if (operation.status !== "completed") return { state: "ambiguous" };
  try {
    return {
      state: "completed",
      result: await parseLampCombinedEvaluationArtifact(operation.result, {
        plan,
        iteration,
      }),
    };
  } catch {
    return { state: "ambiguous" };
  }
}

readCombinedEvaluationCheckpoint.maxRetries = 2;

async function readCombinedEvaluationCheckpointWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  plan: LampCombinedPlan
): Promise<CombinedEvaluationCheckpoint> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS; attempt += 1) {
    try {
      return await readCombinedEvaluationCheckpoint(
        input,
        workflowRunId,
        iteration,
        plan
      );
    } catch (error) {
      lastError = error;
    }
    await sleep("5m");
  }
  throw (lastError instanceof Error
    ? lastError
    : new Error(
        `Lamp Combined evaluation ${iteration} checkpoint could not be read within seven days.`
      ));
}

async function evaluateCombinedAttemptWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  plan: LampCombinedPlan,
  previousArtifact?: LampCombinedEvaluationArtifact
): Promise<LampCombinedEvaluationArtifact> {
  let checkpoint = await readCombinedEvaluationCheckpointWithRecovery(
    input,
    workflowRunId,
    iteration,
    plan
  );
  for (
    let attempt = 0;
    checkpoint.state === "unclaimed" &&
    attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await evaluateCombinedAttempt(
        input,
        workflowRunId,
        iteration,
        plan,
        previousArtifact
      );
    } catch (error) {
      if (error instanceof Error && isLampUserActionRequiredError(error)) {
        throw error;
      }
      checkpoint = await readCombinedEvaluationCheckpointWithRecovery(
        input,
        workflowRunId,
        iteration,
        plan
      );
      if (checkpoint.state === "completed") return checkpoint.result;
      if (checkpoint.state === "ambiguous") throw error;
      await sleep("5m");
    }
  }
  if (checkpoint.state === "completed") return checkpoint.result;
  throw new Error(
    checkpoint.state === "ambiguous"
      ? `Lamp Combined evaluation ${iteration} has an ambiguous paid operation and requires reconciliation.`
      : `Lamp Combined evaluation ${iteration} could not cross its pre-claim boundary within seven days.`
  );
}

async function qualifyCombinedCandidateStep(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2
) {
  "use step";
  const qualified = await qualifyLampCombinedCandidate({
    runId: input.runId,
    executionId: input.executionId,
    workflowRunId,
    iteration,
  });
  const needsRepair = Boolean(
    iteration === 2 &&
      qualified.syncCheck &&
      !qualified.syncCheck.skipped &&
      !v2SyncVerdict(
        qualified.syncCheck.metrics,
        qualified.syncCheck.sourceSync
      ).pass
  );
  return {
    needsRepair,
    ...(needsRepair && qualified.syncCheck
      ? { syncCheck: qualified.syncCheck }
      : {}),
  };
}

qualifyCombinedCandidateStep.maxRetries = 2;

async function appendCombinedFinalRepairReceiptStep(
  input: DurableRelightRunInput,
  workflowRunId: string
) {
  "use step";
  return appendLampCombinedFinalRepairReceipt({
    runId: input.runId,
    executionId: input.executionId,
    workflowRunId,
  });
}

appendCombinedFinalRepairReceiptStep.maxRetries = 2;

async function compileCombinedFinalPromptStep(
  input: DurableRelightRunInput,
  workflowRunId: string,
  plan: LampCombinedPlan,
  firstEvaluation: LampCombinedEvaluationArtifact
): Promise<string> {
  "use step";
  const execution = await getStorage().getRunExecution(input.runId);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.executionId !== `lamp-combined:${input.runId}` ||
    execution.renderedPrompt !== input.renderedPrompt ||
    execution.relightIntensity === undefined
  ) {
    throw new Error("Lamp Combined execution binding disappeared.");
  }
  return (
    await compileLampCombinedFinalPrompt(
      input.renderedPrompt,
      plan,
      execution.relightIntensity,
      firstEvaluation
    )
  ).rendered;
}

compileCombinedFinalPromptStep.maxRetries = 2;

async function recordProviderWorkflowRunning(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: number
): Promise<void> {
  "use step";
  await setVideoGenerationWorkflowState(
    input.runId,
    iteration,
    workflowRunId,
    "running"
  );
}

recordProviderWorkflowRunning.maxRetries = 4;

async function recordProviderWorkflowCompleted(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: number
): Promise<void> {
  "use step";
  await setVideoGenerationWorkflowState(
    input.runId,
    iteration,
    workflowRunId,
    "completed"
  );
}

recordProviderWorkflowCompleted.maxRetries = 4;

async function pollAttempt(input: {
  runId: string;
  iteration: number;
  interactionId: string;
}): Promise<PollVideoGenerationResult> {
  "use step";
  return pollVideoGeneration(input);
}

// The outer loop classifies the durable journal after every error. Retrying the
// step first would repeat deterministic artifact finalization even after that
// journal has already been sealed as reconcile_required.
pollAttempt.maxRetries = 0;

async function inspectAttemptAfterPollError(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: number,
  renderedPrompt: string
): Promise<VideoGenerationPollErrorDisposition> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.inputHash !== runExecutionInputHash(input.renderedPrompt)
  ) {
    return "unrecoverable";
  }
  const operation = run?.providerOperations?.find(
    (item) => item.id === videoGenerationOperationId(iteration)
  );
  if (!operation || operation.renderedPrompt !== renderedPrompt) {
    return "unrecoverable";
  }
  return videoGenerationPollErrorDisposition(operation);
}

inspectAttemptAfterPollError.maxRetries = 2;

async function inspectAttemptAfterPollErrorWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: number,
  renderedPrompt: string
): Promise<VideoGenerationPollErrorDisposition> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS; attempt += 1) {
    try {
      return await inspectAttemptAfterPollError(
        input,
        workflowRunId,
        iteration,
        renderedPrompt
      );
    } catch (error) {
      lastError = error;
    }
    await sleep("5m");
  }
  throw (lastError instanceof Error
    ? lastError
    : new Error(
        `Generation ${iteration} reconciliation could not be inspected within seven days.`
      ));
}

async function readCompletedGeneration(
  runId: string,
  iteration: number
): Promise<VideoGenerationOperationResult> {
  "use step";
  const run = await getStorage().getRun(runId);
  const operation = run?.providerOperations?.find(
    (item) => item.id === videoGenerationOperationId(iteration)
  );
  if (operation?.status !== "completed" || !operation.result) {
    throw new Error(`Completed generation ${iteration} could not be recovered.`);
  }
  return operation.result;
}

readCompletedGeneration.maxRetries = 2;

async function readCompletedGenerationWithRecovery(
  runId: string,
  iteration: number
): Promise<VideoGenerationOperationResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS; attempt += 1) {
    try {
      return await readCompletedGeneration(runId, iteration);
    } catch (error) {
      lastError = error;
    }
    await sleep("5m");
  }
  throw (lastError instanceof Error
    ? lastError
    : new Error(
        `Completed generation ${iteration} could not be recovered within seven days.`
      ));
}

async function readCompletedEvaluation(
  runId: string,
  iteration: 1 | 2
): Promise<LampEvaluationArtifact> {
  "use step";
  const operation = await getStorage().getPaidOperation(
    runId,
    lampEvaluationOperationId(iteration)
  );
  if (
    operation?.status !== "completed" ||
    !isLampEvaluationArtifact(operation.result, iteration)
  ) {
    throw new Error(`Completed Lamp evaluation ${iteration} could not be recovered.`);
  }
  return operation.result;
}

readCompletedEvaluation.maxRetries = 2;

async function readCompletedBackgroundEvaluation(
  runId: string,
  iteration: 1 | 2
): Promise<LampBackgroundEvaluationArtifact> {
  "use step";
  const operation = await getStorage().getPaidOperation(
    runId,
    lampBackgroundEvaluationOperationId(iteration)
  );
  if (
    operation?.status !== "completed" ||
    !isLampBackgroundEvaluationArtifact(operation.result, iteration)
  ) {
    throw new Error(
      `Completed Lamp Background evaluation ${iteration} could not be recovered.`
    );
  }
  return operation.result;
}

readCompletedBackgroundEvaluation.maxRetries = 2;

async function readCompletedBeautifyEvaluation(
  runId: string,
  iteration: 1 | 2
): Promise<LampBeautifyEvaluationArtifact> {
  "use step";
  const operation = await getStorage().getPaidOperation(
    runId,
    lampBeautifyEvaluationOperationId(iteration)
  );
  if (
    operation?.status !== "completed" ||
    !isLampBeautifyEvaluationArtifact(operation.result, iteration)
  ) {
    throw new Error(
      `Completed Lamp Beautify evaluation ${iteration} could not be recovered.`
    );
  }
  return operation.result;
}

readCompletedBeautifyEvaluation.maxRetries = 2;

async function readCompletedIrisEvaluation(
  runId: string,
  iteration: 1 | 2
): Promise<LampIrisEvaluationArtifact> {
  "use step";
  const operation = await getStorage().getPaidOperation(
    runId,
    lampIrisEvaluationOperationId(iteration)
  );
  if (
    operation?.status !== "completed" ||
    !isLampIrisEvaluationArtifact(operation.result, iteration)
  ) {
    throw new Error(
      `Completed Lamp Iris evaluation ${iteration} could not be recovered.`
    );
  }
  return operation.result;
}

readCompletedIrisEvaluation.maxRetries = 2;

async function readCompletedCombinedEvaluation(
  runId: string,
  iteration: 1 | 2
): Promise<LampCombinedEvaluationArtifact> {
  "use step";
  const storage = getStorage();
  const [run, operation] = await Promise.all([
    storage.getRun(runId),
    storage.getPaidOperation(
      runId,
      lampCombinedEvaluationOperationId(iteration)
    ),
  ]);
  if (!run?.combinedPlan || operation?.status !== "completed") {
    throw new Error(
      `Completed Lamp Combined evaluation ${iteration} could not be recovered.`
    );
  }
  return parseLampCombinedEvaluationArtifact(operation.result, {
    plan: run.combinedPlan,
    iteration,
  });
}

readCompletedCombinedEvaluation.maxRetries = 2;

async function settleLegacyFirstCut(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<void> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  const operation = run?.providerOperations?.find(
    (item) => item.id === videoGenerationOperationId(1)
  );
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    isTwoPassExecutionId(execution.executionId) ||
    execution.renderedPrompt !== input.renderedPrompt ||
    operation?.status !== "completed" ||
    !operation.result ||
    !operation.result.audioVerified ||
    operation.renderedPrompt !== input.renderedPrompt
  ) {
    throw new Error("Completed batch first cut is not bound to this execution.");
  }
  await settleExecutionRecord(execution, workflowRunId, 1, input.executionId);
  await setVideoGenerationWorkflowState(input.runId, 1, workflowRunId, "completed");
}

settleLegacyFirstCut.maxRetries = 4;

async function settleCombinedExecution(
  input: DurableRelightRunInput,
  workflowRunId: string,
  finalRenderedPrompt: string
): Promise<void> {
  "use step";
  const storage = getStorage();
  const [execution, run, firstEvaluation, finalEvaluation, lipsync] =
    await Promise.all([
      storage.getRunExecution(input.runId),
      storage.getRun(input.runId),
      storage.getPaidOperation(
        input.runId,
        lampCombinedEvaluationOperationId(1)
      ),
      storage.getPaidOperation(
        input.runId,
        lampCombinedEvaluationOperationId(2)
      ),
      storage.getPaidOperation(input.runId, LIPSYNC_OPERATION_ID),
    ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.executionId !== `lamp-combined:${input.runId}` ||
    execution.renderedPrompt !== input.renderedPrompt ||
    execution.inputHash !== runExecutionInputHash(input.renderedPrompt) ||
    execution.deliveredIteration !== undefined
  ) {
    throw new Error(
      "Lamp Combined settlement no longer owns its durable execution."
    );
  }
  const plannerOperations = await Promise.all(
    (execution.combinedPlanOperationIds ?? []).map(async (operationId) => {
      const operation = await storage.getPaidOperation(input.runId, operationId);
      if (!operation) throw new Error(`Missing Combined planner ${operationId}.`);
      return operation;
    })
  );
  const plan = await validateLampCombinedExecutionBinding({
    run,
    execution,
    planOperations: plannerOperations,
  });
  const planHash = await hashLampCombinedPlan(plan);
  const [firstArtifact, finalArtifact] = await Promise.all([
    parseLampCombinedEvaluationArtifact(firstEvaluation?.result, {
      plan,
      iteration: 1,
    }),
    parseLampCombinedEvaluationArtifact(finalEvaluation?.result, {
      plan,
      iteration: 2,
    }),
  ]);
  const expectedFinal = await compileLampCombinedFinalPrompt(
    input.renderedPrompt,
    plan,
    execution.relightIntensity,
    firstArtifact
  );
  if (expectedFinal.rendered !== finalRenderedPrompt) {
    throw new Error(
      "Lamp Combined Final prompt no longer reproduces from persisted v1 and Initial evaluation."
    );
  }
  const initialGeneration = run.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(1)
  );
  const finalGeneration = run.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(2)
  );
  const initialReceipt = execution.combinedCandidateReceipts?.initial;
  const finalReceipt = execution.combinedCandidateReceipts?.final;
  if (
    !initialGeneration ||
    !finalGeneration ||
    initialGeneration.renderedPrompt !== input.renderedPrompt ||
    finalGeneration.renderedPrompt !== finalRenderedPrompt ||
    firstEvaluation?.status !== "completed" ||
    finalEvaluation?.status !== "completed" ||
    firstArtifact.planHash !== planHash ||
    finalArtifact.planHash !== planHash ||
    !initialReceipt ||
    !finalReceipt ||
    !lampCombinedCandidateReceiptMatches({
      receipt: initialReceipt,
      generationOperation: initialGeneration,
      evaluationOperation: firstEvaluation,
      planId: plan.id,
      planHash,
      sourceHasAudio: run.originalVideo.hasAudio,
      canonicalSourceSync: run.originalVideo.syncBaseline,
      lipsyncOperation: null,
    }) ||
    !lampCombinedCandidateReceiptMatches({
      receipt: finalReceipt,
      generationOperation: finalGeneration,
      evaluationOperation: finalEvaluation,
      planId: plan.id,
      planHash,
      sourceHasAudio: run.originalVideo.hasAudio,
      canonicalSourceSync: run.originalVideo.syncBaseline,
      lipsyncOperation: lipsync,
    })
  ) {
    throw new Error(
      "Lamp Combined requires exact generation, evaluation, audio, and SyncNet receipts for both candidates."
    );
  }
  await settleExecutionRecord(execution, workflowRunId, 2, input.executionId);
  await setVideoGenerationWorkflowState(
    input.runId,
    2,
    workflowRunId,
    "completed"
  );
}

settleCombinedExecution.maxRetries = 4;

async function settleLampExecution(
  input: DurableRelightRunInput,
  workflowRunId: string,
  finalRenderedPrompt: string
): Promise<void> {
  "use step";
  const storage = getStorage();
  const [execution, run, finalEvaluation, lipsync] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
    storage.getPaidOperation(input.runId, lampEvaluationOperationId(2)),
    storage.getPaidOperation(input.runId, LIPSYNC_OPERATION_ID),
  ]);
  const operation = run?.providerOperations?.find(
    (item) => item.id === videoGenerationOperationId(2)
  );
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    !execution.executionId.startsWith("lamp:") ||
    execution.renderedPrompt !== input.renderedPrompt ||
    execution.inputHash !== runExecutionInputHash(input.renderedPrompt) ||
    operation?.status !== "completed" ||
    !operation.result ||
    !operation.result.audioVerified ||
    operation.renderedPrompt !== finalRenderedPrompt ||
    finalEvaluation?.status !== "completed" ||
    !isLampEvaluationArtifact(finalEvaluation.result, 2) ||
    !v2SyncSettlementVerified({
      runId: input.runId,
      candidateVerdict: execution.candidateSyncVerdict,
      finalGeneration: operation,
      lipsync,
      canonicalSourceSync: run?.originalVideo.syncBaseline,
      sourceHasAudio: run?.originalVideo.hasAudio,
    })
  ) {
    throw new Error(
      "Lamp's final artifact and final evaluation are not durably journaled against this execution."
    );
  }
  await settleExecutionRecord(execution, workflowRunId, 2, input.executionId);
  await setVideoGenerationWorkflowState(input.runId, 2, workflowRunId, "completed");
}

settleLampExecution.maxRetries = 4;

async function settleBackgroundExecution(
  input: DurableRelightRunInput,
  workflowRunId: string,
  finalRenderedPrompt: string
): Promise<void> {
  "use step";
  const storage = getStorage();
  const [execution, run, firstEvaluation, finalEvaluation, lipsync] =
    await Promise.all([
      storage.getRunExecution(input.runId),
      storage.getRun(input.runId),
      storage.getPaidOperation(
        input.runId,
        lampBackgroundEvaluationOperationId(1)
      ),
      storage.getPaidOperation(
        input.runId,
        lampBackgroundEvaluationOperationId(2)
      ),
      storage.getPaidOperation(input.runId, LIPSYNC_OPERATION_ID),
    ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    !execution.executionId.startsWith("lamp-background:") ||
    execution.renderedPrompt !== input.renderedPrompt ||
    execution.inputHash !== runExecutionInputHash(input.renderedPrompt)
  ) {
    throw new Error(
      "Lamp Background settlement no longer owns its durable execution."
    );
  }
  const planOperation = execution.planOperationId
    ? await storage.getPaidOperation(
        input.runId,
        execution.planOperationId
      )
    : null;
  const cleanupPlan = await validateLampBackgroundExecutionBinding({
    run,
    execution,
    planOperation,
  });
  const operation = run.providerOperations?.find(
    (item) => item.id === videoGenerationOperationId(2)
  );
  if (
    operation?.status !== "completed" ||
    !operation.result ||
    !operation.result.audioVerified ||
    operation.renderedPrompt !== finalRenderedPrompt ||
    firstEvaluation?.status !== "completed" ||
    !isLampBackgroundEvaluationArtifact(firstEvaluation.result, 1) ||
    firstEvaluation.result.cleanupPlanId !== cleanupPlan.id ||
    finalEvaluation?.status !== "completed" ||
    !isLampBackgroundEvaluationArtifact(finalEvaluation.result, 2) ||
    finalEvaluation.result.cleanupPlanId !== cleanupPlan.id ||
    !v2SyncSettlementVerified({
      runId: input.runId,
      candidateVerdict: execution.candidateSyncVerdict,
      finalGeneration: operation,
      lipsync,
      canonicalSourceSync: run.originalVideo.syncBaseline,
      sourceHasAudio: run.originalVideo.hasAudio,
    })
  ) {
    throw new Error(
      "Lamp Background's Final artifact and both plan-bound evaluations are not durably journaled against this execution."
    );
  }
  const expectedFinalPrompt = compileLampBackgroundFinalPrompt(
    input.renderedPrompt,
    cleanupPlan,
    firstEvaluation.result
  ).rendered;
  if (expectedFinalPrompt !== finalRenderedPrompt) {
    throw new Error(
      "Lamp Background's Final prompt no longer reproduces from its approved plan and Initial evaluation."
    );
  }
  await settleExecutionRecord(execution, workflowRunId, 2, input.executionId);
  await setVideoGenerationWorkflowState(
    input.runId,
    2,
    workflowRunId,
    "completed"
  );
}

settleBackgroundExecution.maxRetries = 4;

async function settleBeautifyExecution(
  input: DurableRelightRunInput,
  workflowRunId: string,
  finalRenderedPrompt: string
): Promise<void> {
  "use step";
  const storage = getStorage();
  const [execution, run, firstEvaluation, finalEvaluation, lipsync] =
    await Promise.all([
      storage.getRunExecution(input.runId),
      storage.getRun(input.runId),
      storage.getPaidOperation(
        input.runId,
        lampBeautifyEvaluationOperationId(1)
      ),
      storage.getPaidOperation(
        input.runId,
        lampBeautifyEvaluationOperationId(2)
      ),
      storage.getPaidOperation(input.runId, LIPSYNC_OPERATION_ID),
    ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    !execution.executionId.startsWith("lamp-beautify:") ||
    execution.renderedPrompt !== input.renderedPrompt ||
    execution.inputHash !== runExecutionInputHash(input.renderedPrompt)
  ) {
    throw new Error(
      "Lamp Beautify settlement no longer owns its durable execution."
    );
  }
  const planOperation = execution.planOperationId
    ? await storage.getPaidOperation(
        input.runId,
        execution.planOperationId
      )
    : null;
  const plan = await validateLampBeautifyExecutionBinding({
    run,
    execution,
    planOperation,
  });
  const operation = run.providerOperations?.find(
    (item) => item.id === videoGenerationOperationId(2)
  );
  if (
    operation?.status !== "completed" ||
    !operation.result ||
    !operation.result.audioVerified ||
    operation.renderedPrompt !== finalRenderedPrompt ||
    firstEvaluation?.status !== "completed" ||
    !isLampBeautifyEvaluationArtifact(firstEvaluation.result, 1) ||
    firstEvaluation.result.planId !== plan.id ||
    finalEvaluation?.status !== "completed" ||
    !isLampBeautifyEvaluationArtifact(finalEvaluation.result, 2) ||
    finalEvaluation.result.planId !== plan.id ||
    !v2SyncSettlementVerified({
      runId: input.runId,
      candidateVerdict: execution.candidateSyncVerdict,
      finalGeneration: operation,
      lipsync,
      canonicalSourceSync: run.originalVideo.syncBaseline,
      sourceHasAudio: run.originalVideo.hasAudio,
    })
  ) {
    throw new Error(
      "Lamp Beautify's Final artifact and both plan-bound evaluations are not durably journaled against this execution."
    );
  }
  const expectedFinalPrompt = compileLampBeautifyFinalPrompt(
    input.renderedPrompt,
    plan,
    firstEvaluation.result
  ).rendered;
  if (expectedFinalPrompt !== finalRenderedPrompt) {
    throw new Error(
      "Lamp Beautify's Final prompt no longer reproduces from its approved plan and Initial evaluation."
    );
  }
  await settleExecutionRecord(execution, workflowRunId, 2, input.executionId);
  await setVideoGenerationWorkflowState(
    input.runId,
    2,
    workflowRunId,
    "completed"
  );
}

settleBeautifyExecution.maxRetries = 4;

async function settleIrisExecution(
  input: DurableRelightRunInput,
  workflowRunId: string,
  finalRenderedPrompt: string
): Promise<void> {
  "use step";
  const storage = getStorage();
  const [execution, run, firstEvaluation, finalEvaluation, lipsync] =
    await Promise.all([
      storage.getRunExecution(input.runId),
      storage.getRun(input.runId),
      storage.getPaidOperation(
        input.runId,
        lampIrisEvaluationOperationId(1)
      ),
      storage.getPaidOperation(
        input.runId,
        lampIrisEvaluationOperationId(2)
      ),
      storage.getPaidOperation(input.runId, LIPSYNC_OPERATION_ID),
    ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    !execution.executionId.startsWith("lamp-iris:") ||
    execution.renderedPrompt !== input.renderedPrompt ||
    execution.inputHash !== runExecutionInputHash(input.renderedPrompt)
  ) {
    throw new Error(
      "Lamp Iris settlement no longer owns its durable execution."
    );
  }
  const planOperation = execution.planOperationId
    ? await storage.getPaidOperation(
        input.runId,
        execution.planOperationId
      )
    : null;
  const plan = await validateLampIrisExecutionBinding({
    run,
    execution,
    planOperation,
  });
  const operation = run.providerOperations?.find(
    (item) => item.id === videoGenerationOperationId(2)
  );
  if (
    operation?.status !== "completed" ||
    !operation.result ||
    !operation.result.audioVerified ||
    operation.renderedPrompt !== finalRenderedPrompt ||
    firstEvaluation?.status !== "completed" ||
    !isLampIrisEvaluationArtifact(firstEvaluation.result, 1) ||
    firstEvaluation.result.planId !== plan.id ||
    finalEvaluation?.status !== "completed" ||
    !isLampIrisEvaluationArtifact(finalEvaluation.result, 2) ||
    finalEvaluation.result.planId !== plan.id ||
    !v2SyncSettlementVerified({
      runId: input.runId,
      candidateVerdict: execution.candidateSyncVerdict,
      finalGeneration: operation,
      lipsync,
      canonicalSourceSync: run.originalVideo.syncBaseline,
      sourceHasAudio: run.originalVideo.hasAudio,
    })
  ) {
    throw new Error(
      "Lamp Iris's Final artifact and both plan-bound evaluations are not durably journaled against this execution."
    );
  }
  const expectedFinalPrompt = compileLampIrisFinalPrompt(
    input.renderedPrompt,
    plan,
    firstEvaluation.result
  ).rendered;
  if (expectedFinalPrompt !== finalRenderedPrompt) {
    throw new Error(
      "Lamp Iris's Final prompt no longer reproduces from its approved plan and Initial evaluation."
    );
  }
  // Best-of-two: generation variance dominates prompt steering, so deliver
  // the better-judged take. An Initial may only win delivery after clearing
  // the same source-relative SyncNet verdict the Final cleared; the analysis
  // is free and fails open to delivering the already-gated Final.
  const selection = selectLampIrisDeliveredIteration(
    firstEvaluation.result,
    finalEvaluation.result
  );
  let deliveredIteration: 1 | 2 = selection.iteration;
  if (deliveredIteration === 1) {
    const initialSync = await analyzeInitialCandidateSync(input.runId);
    if (
      !initialSync ||
      (!initialSync.silent &&
        !v2SyncVerdict(initialSync.metrics, initialSync.sourceSync).pass)
    ) {
      deliveredIteration = 2;
    }
  }
  await settleExecutionRecord(
    execution,
    workflowRunId,
    2,
    input.executionId,
    deliveredIteration
  );
  await setVideoGenerationWorkflowState(
    input.runId,
    2,
    workflowRunId,
    "completed"
  );
}

settleIrisExecution.maxRetries = 4;

async function settleExecutionRecord(
  execution: RunExecution,
  workflowRunId: string,
  iteration: number,
  executionId: string,
  deliveredIteration?: 1 | 2
): Promise<void> {
  const storage = getStorage();
  if (execution.status === "awaiting_review" && execution.phase === "complete") {
    return;
  }
  if (execution.status !== "running" && execution.status !== "reconcile_required") {
    throw new Error("Run execution cannot settle from its current state.");
  }
  const candidate: RunExecution = {
    ...execution,
    status: "awaiting_review",
    phase: "complete",
    iteration,
    revision: execution.revision + 1,
    updatedAt: Math.max(Date.now(), execution.updatedAt),
    error: undefined,
    ...(deliveredIteration !== undefined ? { deliveredIteration } : {}),
  };
  const advanced = await storage.advanceRunExecution(candidate, execution.revision);
  const durable = advanced.execution;
  if (
    !durable ||
    durable.executionId !== executionId ||
    durable.workflowRunId !== workflowRunId ||
    durable.status !== "awaiting_review" ||
    durable.phase !== "complete" ||
    durable.iteration !== iteration
  ) {
    throw new Error("Run execution settlement lost durable ownership.");
  }
}

type FailureRecord =
  | "legacy_completed"
  | "two_pass_completed"
  | "awaiting_review"
  | "user_action_required"
  | "failed"
  | "reconcile_required"
  | "not_owner";

async function recordExecutionFailure(
  input: DurableRelightRunInput,
  workflowRunId: string,
  error: string
): Promise<FailureRecord> {
  "use step";
  const storage = getStorage();
  let execution = await storage.getRunExecution(input.runId);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId
  ) {
    return "not_owner";
  }
  if (execution.status === "awaiting_review") return "awaiting_review";
  if (execution.status === "user_action_required") {
    return "user_action_required";
  }
  if (execution.status === "failed") return "failed";
  if (execution.status === "reconcile_required") return "reconcile_required";

  if (
    isTwoPassExecutionId(input.executionId) &&
    error.startsWith(LAMP_USER_ACTION_REQUIRED_PREFIX)
  ) {
    const candidate: RunExecution = {
      ...execution,
      status: "user_action_required",
      revision: execution.revision + 1,
      updatedAt: Math.max(Date.now(), execution.updatedAt),
      error: error.slice(0, 2_000),
    };
    const advanced = await storage.advanceRunExecution(
      candidate,
      execution.revision
    );
    const durable = advanced.execution;
    if (
      durable?.executionId === input.executionId &&
      durable.workflowRunId === workflowRunId &&
      durable.status === "user_action_required"
    ) {
      return "user_action_required";
    }
    if (durable?.status === "awaiting_review") return "awaiting_review";
    if (durable?.status === "reconcile_required") return "reconcile_required";
    if (durable?.status === "failed") return "failed";
    return "not_owner";
  }

  let run = await storage.getRun(input.runId);
  let currentGeneration = run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(execution!.iteration)
  );
  if (
    execution.phase === "video_generation" &&
    (currentGeneration?.status === "in_progress" ||
      currentGeneration?.status === "reconcile_required")
  ) {
    await markVideoGenerationWorkflowError(
      input.runId,
      execution.iteration,
      error
    );
    run = await storage.getRun(input.runId);
    currentGeneration = run?.providerOperations?.find(
      (operation) => operation.id === videoGenerationOperationId(execution!.iteration)
    );
  }

  const first = run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(1)
  );
  const workflowMode = workflowModeFromExecutionId(input.executionId);
  const twoPass = workflowMode !== "flora";
  if (!twoPass && isGradeableVideoGeneration(first)) {
    return "legacy_completed";
  }
  const final = run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(2)
  );
  const [firstPlanEvaluation, finalEvaluation, lipsync] =
    await Promise.all([
      workflowMode === "background"
        ? storage.getPaidOperation(
            input.runId,
            lampBackgroundEvaluationOperationId(1)
          )
        : workflowMode === "beautify"
          ? storage.getPaidOperation(
              input.runId,
              lampBeautifyEvaluationOperationId(1)
            )
          : workflowMode === "iris"
            ? storage.getPaidOperation(
                input.runId,
                lampIrisEvaluationOperationId(1)
              )
            : workflowMode === "combined"
              ? storage.getPaidOperation(
                  input.runId,
                  lampCombinedEvaluationOperationId(1)
                )
            : Promise.resolve(null),
      workflowMode === "background"
        ? storage.getPaidOperation(
            input.runId,
            lampBackgroundEvaluationOperationId(2)
          )
        : workflowMode === "beautify"
          ? storage.getPaidOperation(
              input.runId,
              lampBeautifyEvaluationOperationId(2)
            )
          : workflowMode === "iris"
            ? storage.getPaidOperation(
                input.runId,
                lampIrisEvaluationOperationId(2)
              )
            : workflowMode === "combined"
              ? storage.getPaidOperation(
                  input.runId,
                  lampCombinedEvaluationOperationId(2)
                )
            : storage.getPaidOperation(
                input.runId,
                lampEvaluationOperationId(2)
              ),
      storage.getPaidOperation(input.runId, LIPSYNC_OPERATION_ID),
    ]);
  let finalEvaluationComplete =
    workflowMode === "lamp" &&
    finalEvaluation?.status === "completed" &&
    isLampEvaluationArtifact(finalEvaluation.result, 2);
  let combinedCandidateProofsComplete = false;
  if (
    workflowMode === "combined" &&
    run &&
    firstPlanEvaluation?.status === "completed" &&
    finalEvaluation?.status === "completed"
  ) {
    try {
      const plannerOperations = await Promise.all(
        (execution.combinedPlanOperationIds ?? []).map(async (operationId) => {
          const operation = await storage.getPaidOperation(
            input.runId,
            operationId
          );
          if (!operation) throw new Error("Missing Combined planner journal.");
          return operation;
        })
      );
      const plan = await validateLampCombinedExecutionBinding({
        run,
        execution,
        planOperations: plannerOperations,
      });
      const [planHash, firstArtifact, finalArtifact] = await Promise.all([
        hashLampCombinedPlan(plan),
        parseLampCombinedEvaluationArtifact(firstPlanEvaluation.result, {
          plan,
          iteration: 1,
        }),
        parseLampCombinedEvaluationArtifact(finalEvaluation.result, {
          plan,
          iteration: 2,
        }),
      ]);
      const expectedFinalPrompt = await compileLampCombinedFinalPrompt(
        input.renderedPrompt,
        plan,
        execution.relightIntensity,
        firstArtifact
      );
      const initialGeneration = run.providerOperations?.find(
        (operation) => operation.id === videoGenerationOperationId(1)
      );
      const initialReceipt = execution.combinedCandidateReceipts?.initial;
      const finalReceipt = execution.combinedCandidateReceipts?.final;
      finalEvaluationComplete =
        finalArtifact.planHash === planHash &&
        final?.renderedPrompt === expectedFinalPrompt.rendered;
      combinedCandidateProofsComplete = Boolean(
        finalEvaluationComplete &&
          initialGeneration &&
          final &&
          initialReceipt &&
          finalReceipt &&
          lampCombinedCandidateReceiptMatches({
            receipt: initialReceipt,
            generationOperation: initialGeneration,
            evaluationOperation: firstPlanEvaluation,
            planId: plan.id,
            planHash,
            sourceHasAudio: run.originalVideo.hasAudio,
            canonicalSourceSync: run.originalVideo.syncBaseline,
            lipsyncOperation: null,
          }) &&
          lampCombinedCandidateReceiptMatches({
            receipt: finalReceipt,
            generationOperation: final,
            evaluationOperation: finalEvaluation,
            planId: plan.id,
            planHash,
            sourceHasAudio: run.originalVideo.hasAudio,
            canonicalSourceSync: run.originalVideo.syncBaseline,
            lipsyncOperation: lipsync,
          })
      );
    } catch {
      finalEvaluationComplete = false;
      combinedCandidateProofsComplete = false;
    }
  }
  if (
    workflowMode === "background" &&
    run &&
    firstPlanEvaluation?.status === "completed" &&
    isLampBackgroundEvaluationArtifact(
      firstPlanEvaluation.result,
      1
    ) &&
    finalEvaluation?.status === "completed" &&
    isLampBackgroundEvaluationArtifact(finalEvaluation.result, 2)
  ) {
    try {
      const planOperation = execution.planOperationId
        ? await storage.getPaidOperation(
            input.runId,
            execution.planOperationId
          )
        : null;
      const cleanupPlan = await validateLampBackgroundExecutionBinding({
        run,
        execution,
        planOperation,
      });
      const expectedFinalPrompt = compileLampBackgroundFinalPrompt(
        input.renderedPrompt,
        cleanupPlan,
        firstPlanEvaluation.result
      ).rendered;
      finalEvaluationComplete =
        firstPlanEvaluation.result.cleanupPlanId === cleanupPlan.id &&
        finalEvaluation.result.cleanupPlanId === cleanupPlan.id &&
        final?.renderedPrompt === expectedFinalPrompt;
    } catch {
      finalEvaluationComplete = false;
    }
  }
  if (
    workflowMode === "beautify" &&
    run &&
    firstPlanEvaluation?.status === "completed" &&
    isLampBeautifyEvaluationArtifact(firstPlanEvaluation.result, 1) &&
    finalEvaluation?.status === "completed" &&
    isLampBeautifyEvaluationArtifact(finalEvaluation.result, 2)
  ) {
    try {
      const planOperation = execution.planOperationId
        ? await storage.getPaidOperation(
            input.runId,
            execution.planOperationId
          )
        : null;
      const plan = await validateLampBeautifyExecutionBinding({
        run,
        execution,
        planOperation,
      });
      const expectedFinalPrompt = compileLampBeautifyFinalPrompt(
        input.renderedPrompt,
        plan,
        firstPlanEvaluation.result
      ).rendered;
      finalEvaluationComplete =
        firstPlanEvaluation.result.planId === plan.id &&
        finalEvaluation.result.planId === plan.id &&
        final?.renderedPrompt === expectedFinalPrompt;
    } catch {
      finalEvaluationComplete = false;
    }
  }
  if (
    workflowMode === "iris" &&
    run &&
    firstPlanEvaluation?.status === "completed" &&
    isLampIrisEvaluationArtifact(firstPlanEvaluation.result, 1) &&
    finalEvaluation?.status === "completed" &&
    isLampIrisEvaluationArtifact(finalEvaluation.result, 2)
  ) {
    try {
      const planOperation = execution.planOperationId
        ? await storage.getPaidOperation(
            input.runId,
            execution.planOperationId
          )
        : null;
      const plan = await validateLampIrisExecutionBinding({
        run,
        execution,
        planOperation,
      });
      const expectedFinalPrompt = compileLampIrisFinalPrompt(
        input.renderedPrompt,
        plan,
        firstPlanEvaluation.result
      ).rendered;
      finalEvaluationComplete =
        firstPlanEvaluation.result.planId === plan.id &&
        finalEvaluation.result.planId === plan.id &&
        final?.renderedPrompt === expectedFinalPrompt;
    } catch {
      finalEvaluationComplete = false;
    }
  }
  const finalSyncVerified =
    workflowMode === "combined"
      ? combinedCandidateProofsComplete
      : Boolean(final?.renderedPrompt &&
      v2SyncSettlementVerified({
        runId: input.runId,
        candidateVerdict: execution.candidateSyncVerdict,
        finalGeneration: final,
        lipsync,
        canonicalSourceSync: run?.originalVideo.syncBaseline,
        sourceHasAudio: run?.originalVideo.hasAudio,
      }));
  if (
    twoPass &&
    final?.status === "completed" &&
    final.result &&
    final.result.audioVerified &&
    finalEvaluationComplete &&
    finalSyncVerified
  ) {
    return "two_pass_completed";
  }

  const currentEvaluation =
    twoPass && execution.phase === "evaluating"
      ? await storage.getPaidOperation(
          input.runId,
          workflowMode === "background"
            ? lampBackgroundEvaluationOperationId(execution.iteration)
            : workflowMode === "beautify"
              ? lampBeautifyEvaluationOperationId(execution.iteration)
              : workflowMode === "iris"
                ? lampIrisEvaluationOperationId(execution.iteration)
                : workflowMode === "combined"
                  ? lampCombinedEvaluationOperationId(
                      execution.iteration as 1 | 2
                    )
                : lampEvaluationOperationId(execution.iteration)
        )
      : null;
  const candidateSyncProofMissing = Boolean(
    twoPass &&
      final?.status === "completed" &&
      final.result?.audioVerified &&
      finalEvaluationComplete &&
      (workflowMode === "combined" || lipsync === null) &&
      !finalSyncVerified
  );
  const evaluationAmbiguous = Boolean(
    (currentEvaluation && currentEvaluation.status !== "completed") ||
      (lipsync && lipsync.status !== "completed") ||
      candidateSyncProofMissing
  );
  const status = runExecutionFailureStatus({
    evaluationAmbiguous,
    generation: currentGeneration,
  });
  execution = await storage.getRunExecution(input.runId);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId
  ) {
    return "not_owner";
  }
  if (execution.status === "awaiting_review") return "awaiting_review";
  if (execution.status === "user_action_required") {
    return "user_action_required";
  }
  if (execution.status === "failed") return "failed";
  if (execution.status === "reconcile_required") return "reconcile_required";
  const candidate: RunExecution = {
    ...execution,
    status,
    revision: execution.revision + 1,
    updatedAt: Math.max(Date.now(), execution.updatedAt),
    error: error.slice(0, 2_000),
  };
  const advanced = await storage.advanceRunExecution(candidate, execution.revision);
  const durable = advanced.execution;
  if (!durable) return "not_owner";
  if (
    durable.executionId !== input.executionId ||
    durable.workflowRunId !== workflowRunId
  ) {
    return "not_owner";
  }
  if (
    durable.status === "awaiting_review" ||
    durable.status === "user_action_required" ||
    durable.status === "failed" ||
    durable.status === "reconcile_required"
  ) {
    return durable.status;
  }
  throw new Error("Run execution changed while failure was being recorded.");
}

recordExecutionFailure.maxRetries = 4;

// ---------------------------------------------------------------------------
// Lamp Chain — Combined Version 2.
//
// Sequential single-pass stages: stage N's generation conditions on stage
// N-1's audio-remuxed delivered cut (stage 1 on the canonical original). The
// regenerate-from-original law is deliberately suspended here — that is the
// experiment — while frozen prompts, exact paid journals, and the original-
// audio remux/hash law hold for every stage.
//
// Delivery settles on structural proof alone (every stage generated, audio
// verified). All evaluation — judge calls, SyncNet, luma, gaze — runs AFTER
// settlement as detached measurement journals that can never hold, repair,
// or un-deliver the artifact. A detached-evaluation failure surfaces as a
// missing/reconcile-marked judge journal on the run, nothing more.
// ---------------------------------------------------------------------------

interface BoundChainPlan {
  plan: LampChainPlan;
  envelope: LampChainPromptEnvelope;
}

async function durableLampChainRun(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<DurableRelightRunResult> {
  try {
    const bound = await readBoundChainPlan(input, workflowRunId);
    const stageCount = bound.envelope.stagePrompts.length;
    let lastResult: VideoGenerationOperationResult | undefined;
    for (let stage = 1; stage <= stageCount; stage += 1) {
      const stagePrompt = bound.envelope.stagePrompts[stage - 1]!;
      lastResult = await runChainGenerationAttempt(
        input,
        workflowRunId,
        stage,
        stagePrompt.rendered
      );
      await appendChainStageReceiptStep(
        input,
        workflowRunId,
        stage,
        stagePrompt.stageKind
      );
    }
    await settleChainExecution(input, workflowRunId);
    // Delivered. Everything after this line is detached measurement.
    await runChainDetachedEvaluations(input, workflowRunId, stageCount);
    return {
      runId: input.runId,
      executionId: input.executionId,
      status: "awaiting_review",
      videoUrl: lastResult?.videoUrl,
      audioVerified: lastResult?.audioVerified,
    };
  } catch (error) {
    const safeError =
      error instanceof Error
        ? error.message
        : "Durable Lamp Chain execution failed.";
    const failure = await recordChainExecutionFailure(
      input,
      workflowRunId,
      safeError
    );
    if (failure === "chain_completed") {
      // Every stage's structural proof exists; only settlement was lost.
      await settleChainExecution(input, workflowRunId);
      const bound = await readBoundChainPlan(input, workflowRunId);
      await runChainDetachedEvaluations(
        input,
        workflowRunId,
        bound.envelope.stagePrompts.length
      );
      return {
        runId: input.runId,
        executionId: input.executionId,
        status: "awaiting_review",
      };
    }
    if (failure === "awaiting_review") {
      // Already delivered (for example a crash between settlement and the
      // detached tail). Finish the measurement pass best-effort and return.
      try {
        const bound = await readBoundChainPlan(input, workflowRunId);
        await runChainDetachedEvaluations(
          input,
          workflowRunId,
          bound.envelope.stagePrompts.length
        );
      } catch {
        // The delivered artifact is untouchable; measurement gaps are visible
        // on the run's evaluation journals.
      }
      return {
        runId: input.runId,
        executionId: input.executionId,
        status: "awaiting_review",
      };
    }
    throw new Error(
      failure === "user_action_required"
        ? "Lamp Chain paused until its exact spend approval is renewed."
        : failure === "reconcile_required"
          ? "Lamp Chain requires provider reconciliation."
          : "Lamp Chain stopped before every stage held a structural delivery proof."
    );
  }
}

async function readBoundChainPlan(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<BoundChainPlan> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.renderedPrompt !== input.renderedPrompt ||
    execution.executionId !== `lamp-chain:${input.runId}`
  ) {
    throw new Error(
      "Durable run execution no longer owns the approved Lamp Chain plan."
    );
  }
  if (!run.chainPlan) {
    throw new Error("Lamp Chain lost its approved plan before execution.");
  }
  const plan = parseLampChainPlan(run.chainPlan);
  if (plan.aggregate.approval.status !== "approved") {
    throw new Error("Lamp Chain execution requires the human-approved plan.");
  }
  const planHash = await hashLampChainPlan(plan);
  if (execution.approvedPlanHash !== planHash) {
    throw new Error(
      "Lamp Chain approved plan hash no longer matches the bound execution."
    );
  }
  for (const operationId of execution.combinedPlanOperationIds ?? []) {
    const operation = await storage.getPaidOperation(input.runId, operationId);
    if (
      !operation ||
      operation.status !== "completed" ||
      operation.kind !== "plan"
    ) {
      throw new Error(
        `Lamp Chain planner journal ${operationId} is missing or incomplete.`
      );
    }
  }
  // Byte-validates every frozen stage prompt against a fresh compile of the
  // exact approved plan (persisted-format law, read side).
  const envelope = parseLampChainPromptEnvelope(
    JSON.parse(execution.renderedPrompt),
    { plan, relightIntensity: execution.relightIntensity }
  );
  return { plan, envelope };
}

readBoundChainPlan.maxRetries = 2;

async function enterChainGenerationPhase(
  input: DurableRelightRunInput,
  workflowRunId: string,
  stage: number
): Promise<boolean> {
  "use step";
  const storage = getStorage();
  const current = await storage.getRunExecution(input.runId);
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.workflowRunId !== workflowRunId ||
    current.status !== "running"
  ) {
    return false;
  }
  if (current.iteration === stage && current.phase === "video_generation") {
    return true;
  }
  // No evaluating phase between chain stages: stage k follows stage k-1's
  // video_generation directly. Stage 1 follows binding's preparing phase.
  const validPrior =
    stage === 1
      ? current.iteration === 0 && current.phase === "preparing"
      : current.iteration === stage - 1 &&
        current.phase === "video_generation";
  if (!validPrior) return false;
  const candidate: RunExecution = {
    ...current,
    iteration: stage,
    phase: "video_generation",
    revision: current.revision + 1,
    updatedAt: Math.max(Date.now(), current.updatedAt),
  };
  const advanced = await storage.advanceRunExecution(candidate, current.revision);
  return Boolean(
    advanced.execution?.workflowRunId === workflowRunId &&
      advanced.execution.status === "running" &&
      advanced.execution.iteration === stage &&
      advanced.execution.phase === "video_generation"
  );
}

enterChainGenerationPhase.maxRetries = 2;

async function chainGenerationPhaseDisposition(
  input: DurableRelightRunInput,
  workflowRunId: string,
  stage: number
): Promise<PhaseRecoveryDisposition> {
  "use step";
  const current = await getStorage().getRunExecution(input.runId);
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.workflowRunId !== workflowRunId ||
    current.status !== "running"
  ) {
    return "terminal";
  }
  if (current.iteration === stage && current.phase === "video_generation") {
    return "entered";
  }
  const validPrior =
    stage === 1
      ? current.iteration === 0 && current.phase === "preparing"
      : current.iteration === stage - 1 &&
        current.phase === "video_generation";
  return validPrior ? "retryable" : "terminal";
}

chainGenerationPhaseDisposition.maxRetries = 2;

async function enterChainGenerationPhaseWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  stage: number
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS; attempt += 1) {
    try {
      if (await enterChainGenerationPhase(input, workflowRunId, stage)) return;
    } catch (error) {
      lastError = error;
    }
    let disposition: PhaseRecoveryDisposition;
    try {
      disposition = await chainGenerationPhaseDisposition(
        input,
        workflowRunId,
        stage
      );
    } catch (error) {
      lastError = error;
      await sleep("5m");
      continue;
    }
    if (disposition === "entered") return;
    if (disposition === "terminal") {
      throw (lastError instanceof Error
        ? lastError
        : new Error("Durable run execution no longer owns chain generation."));
    }
    await sleep("5m");
  }
  throw new Error(
    `Chain stage ${stage} could not cross its retry-safe phase checkpoint within seven days.`
  );
}

async function prepareChainAttempt(
  input: DurableRelightRunInput,
  workflowRunId: string,
  stage: number
): Promise<string> {
  "use step";
  await assertGenerationOwner(input, workflowRunId, stage);
  const [run, execution] = await Promise.all([
    getStorage().getRun(input.runId),
    getStorage().getRunExecution(input.runId),
  ]);
  if (!run || !execution || execution.executionId !== input.executionId) {
    throw new Error("Run not found during Lamp Chain preparation.");
  }
  if (!run.chainPlan) {
    throw new Error("Lamp Chain lost its approved plan before preparation.");
  }
  const plan = parseLampChainPlan(run.chainPlan);
  if (
    plan.aggregate.approval.status !== "approved" ||
    execution.approvedPlanHash !== (await hashLampChainPlan(plan))
  ) {
    throw new Error(
      "Lamp Chain preparation no longer matches the approved plan."
    );
  }
  try {
    assertVideoGenerationAuthorized(run, stage);
  } catch (error) {
    // A valid exact chain grant means this is an orchestration invariant;
    // only an absent/expired/mismatched grant is resumable by a human click.
    if (
      hasReusableLampChainApproval(run, execution.source, execution.batchId)
    ) {
      throw error;
    }
    throw new Error(
      `${LAMP_USER_ACTION_REQUIRED_PREFIX}${error instanceof Error ? error.message : "Chain spend approval must be renewed."}`
    );
  }
  return prepareLampChainStageStart(input.runId, stage);
}

prepareChainAttempt.maxRetries = 2;

async function runChainGenerationAttempt(
  input: DurableRelightRunInput,
  workflowRunId: string,
  stage: number,
  renderedPrompt: string
): Promise<VideoGenerationOperationResult> {
  await enterChainGenerationPhaseWithRecovery(input, workflowRunId, stage);
  let checkpoint = await readGenerationCheckpointWithRecovery(
    input,
    workflowRunId,
    stage,
    renderedPrompt
  );
  for (
    let attempt = 0;
    checkpoint.state === "unclaimed" && attempt < MAX_RETRY_SAFE_GAP_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const preparedUploadUri = await prepareChainAttempt(
        input,
        workflowRunId,
        stage
      );
      const started = await startAttempt(
        input,
        workflowRunId,
        stage,
        renderedPrompt,
        preparedUploadUri
      );
      checkpoint = {
        state: "started",
        interactionId: started.interactionId,
      };
    } catch (error) {
      if (error instanceof Error && isLampUserActionRequiredError(error)) {
        throw error;
      }
      checkpoint = await readGenerationCheckpointWithRecovery(
        input,
        workflowRunId,
        stage,
        renderedPrompt
      );
      if (checkpoint.state === "ambiguous") throw error;
      if (checkpoint.state === "unclaimed") await sleep("5m");
    }
  }
  if (checkpoint.state === "completed") {
    try {
      await recordProviderWorkflowCompleted(input, workflowRunId, stage);
    } catch {
      // The completed artifact journal is authoritative.
    }
    return checkpoint.result;
  }
  if (checkpoint.state !== "started") {
    throw new Error(
      checkpoint.state === "ambiguous"
        ? `Chain stage ${stage} has an ambiguous durable start and requires reconciliation.`
        : `Chain stage ${stage} could not pass its retry-safe preparation boundary within seven days.`
    );
  }
  try {
    await recordProviderWorkflowRunning(input, workflowRunId, stage);
  } catch {
    // The provider handle is already durable.
  }

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    await sleep("8s");
    try {
      const result = await pollAttempt({
        runId: input.runId,
        iteration: stage,
        interactionId: checkpoint.interactionId,
      });
      if (result.done) {
        try {
          await recordProviderWorkflowCompleted(input, workflowRunId, stage);
        } catch {
          // Result commitment, not this marker, is the paid boundary.
        }
        return result;
      }
    } catch (pollError) {
      const disposition = await inspectAttemptAfterPollErrorWithRecovery(
        input,
        workflowRunId,
        stage,
        renderedPrompt
      );
      if (disposition === "completed") {
        const completed = await readCompletedGenerationWithRecovery(
          input.runId,
          stage
        );
        try {
          await recordProviderWorkflowCompleted(input, workflowRunId, stage);
        } catch {
          // The committed provider result remains safe to continue from.
        }
        return completed;
      }
      if (disposition !== "retryable") throw pollError;
    }
  }

  for (let poll = 0; poll < MAX_RECONCILIATION_POLLS; poll += 1) {
    await sleep("5m");
    try {
      const result = await pollAttempt({
        runId: input.runId,
        iteration: stage,
        interactionId: checkpoint.interactionId,
      });
      if (result.done) {
        try {
          await recordProviderWorkflowCompleted(input, workflowRunId, stage);
        } catch {
          // The committed provider result remains safe to continue from.
        }
        return result;
      }
    } catch (pollError) {
      const disposition = await inspectAttemptAfterPollErrorWithRecovery(
        input,
        workflowRunId,
        stage,
        renderedPrompt
      );
      if (disposition === "completed") {
        const completed = await readCompletedGenerationWithRecovery(
          input.runId,
          stage
        );
        try {
          await recordProviderWorkflowCompleted(input, workflowRunId, stage);
        } catch {
          // The committed provider result remains safe to continue from.
        }
        return completed;
      }
      if (disposition !== "retryable") throw pollError;
    }
  }
  throw new Error(
    `Chain stage ${stage} remained unresolved after seven days of non-billed reconciliation.`
  );
}

async function appendChainStageReceiptStep(
  input: DurableRelightRunInput,
  workflowRunId: string,
  stage: number,
  stageKind: LampChainStage
): Promise<void> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "running" ||
    execution.iteration !== stage
  ) {
    throw new Error(
      "Durable run execution no longer owns the chain stage receipt."
    );
  }
  const existing = execution.chainStageReceipts ?? [];
  const already = existing.find((receipt) => receipt.stage === stage);
  if (already) {
    if (already.stageKind !== stageKind) {
      throw new Error(
        `Chain stage ${stage} receipt binds a different stage kind.`
      );
    }
    return;
  }
  if (existing.length !== stage - 1) {
    throw new Error(
      `Chain stage receipts must be contiguous; stage ${stage} cannot follow ${existing.length}.`
    );
  }
  const generationOperation = run.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(stage)
  );
  const receipt = buildLampChainStageReceipt({
    stage,
    stageKind,
    generationOperation,
    sourceHasAudio: run.originalVideo.hasAudio,
    recordedAt: Date.now(),
  });
  const candidate: RunExecution = {
    ...execution,
    chainStageReceipts: [...existing, receipt],
    revision: execution.revision + 1,
    updatedAt: Math.max(Date.now(), execution.updatedAt),
  };
  const advanced = await storage.advanceRunExecution(candidate, execution.revision);
  const durable = advanced.execution;
  if (
    !durable ||
    durable.workflowRunId !== workflowRunId ||
    (durable.chainStageReceipts?.length ?? 0) < stage
  ) {
    throw new Error("Chain stage receipt journaling lost durable ownership.");
  }
}

appendChainStageReceiptStep.maxRetries = 4;

async function settleChainExecution(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<void> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.executionId !== `lamp-chain:${input.runId}` ||
    execution.renderedPrompt !== input.renderedPrompt ||
    execution.inputHash !== runExecutionInputHash(input.renderedPrompt)
  ) {
    throw new Error("Lamp Chain settlement no longer owns its durable execution.");
  }
  if (execution.status === "awaiting_review" && execution.phase === "complete") {
    return;
  }
  if (!run.chainPlan) {
    throw new Error("Lamp Chain settlement lost the approved plan.");
  }
  const plan = parseLampChainPlan(run.chainPlan);
  const envelope = parseLampChainPromptEnvelope(
    JSON.parse(execution.renderedPrompt),
    { plan, relightIntensity: execution.relightIntensity }
  );
  const stageCount = envelope.stagePrompts.length;
  const receipts = execution.chainStageReceipts ?? [];
  if (receipts.length !== stageCount) {
    throw new Error(
      "Lamp Chain settlement requires a structural receipt for every stage."
    );
  }
  for (const stagePrompt of envelope.stagePrompts) {
    const receipt = receipts[stagePrompt.stage - 1]!;
    const generationOperation = run.providerOperations?.find(
      (operation) =>
        operation.id === videoGenerationOperationId(stagePrompt.stage)
    );
    if (
      !generationOperation ||
      !lampChainStageReceiptMatches({
        receipt,
        generationOperation,
        expectedRenderedPrompt: stagePrompt.rendered,
        stage: stagePrompt.stage,
        stageKind: stagePrompt.stageKind,
        sourceHasAudio: run.originalVideo.hasAudio,
      })
    ) {
      throw new Error(
        `Lamp Chain stage ${stagePrompt.stage} requires exact generation and audio proof.`
      );
    }
  }
  await settleExecutionRecord(
    execution,
    workflowRunId,
    stageCount,
    input.executionId
  );
  await setVideoGenerationWorkflowState(
    input.runId,
    stageCount,
    workflowRunId,
    "completed"
  );
}

settleChainExecution.maxRetries = 4;

async function chainStageEvaluationStep(
  input: DurableRelightRunInput,
  workflowRunId: string,
  stage: number,
  previousArtifact: LampChainEvaluationArtifact | undefined
): Promise<LampChainEvaluationArtifact> {
  "use step";
  const storage = getStorage();
  const [execution, run] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
  ]);
  if (
    !execution ||
    !run ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId ||
    execution.status !== "awaiting_review"
  ) {
    throw new Error(
      "Detached chain evaluation runs only for the delivered execution it measures."
    );
  }
  if (!run.chainPlan) {
    throw new Error("Detached chain evaluation lost the approved plan.");
  }
  return runLampChainStageEvaluation({
    runId: input.runId,
    stage,
    plan: parseLampChainPlan(run.chainPlan),
    previousArtifact,
  });
}

chainStageEvaluationStep.maxRetries = 2;

/**
 * The detached measurement tail. Per-stage failures are contained: the stage's
 * judge journal (absent or reconcile-marked) is the durable record, the delta
 * chain restarts at the next stage, and delivery is never revisited.
 */
async function runChainDetachedEvaluations(
  input: DurableRelightRunInput,
  workflowRunId: string,
  stageCount: number
): Promise<void> {
  let previous: LampChainEvaluationArtifact | undefined;
  for (let stage = 1; stage <= stageCount; stage += 1) {
    try {
      previous = await chainStageEvaluationStep(
        input,
        workflowRunId,
        stage,
        previous
      );
    } catch {
      previous = undefined;
    }
  }
}

type ChainFailureRecord =
  | "chain_completed"
  | "awaiting_review"
  | "user_action_required"
  | "failed"
  | "reconcile_required"
  | "not_owner";

async function recordChainExecutionFailure(
  input: DurableRelightRunInput,
  workflowRunId: string,
  error: string
): Promise<ChainFailureRecord> {
  "use step";
  const storage = getStorage();
  let execution = await storage.getRunExecution(input.runId);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId
  ) {
    return "not_owner";
  }
  if (execution.status === "awaiting_review") return "awaiting_review";
  if (execution.status === "user_action_required") {
    return "user_action_required";
  }
  if (execution.status === "failed") return "failed";
  if (execution.status === "reconcile_required") return "reconcile_required";

  if (error.startsWith(LAMP_USER_ACTION_REQUIRED_PREFIX)) {
    const candidate: RunExecution = {
      ...execution,
      status: "user_action_required",
      revision: execution.revision + 1,
      updatedAt: Math.max(Date.now(), execution.updatedAt),
      error: error.slice(0, 2_000),
    };
    const advanced = await storage.advanceRunExecution(
      candidate,
      execution.revision
    );
    const durable = advanced.execution;
    if (
      durable?.executionId === input.executionId &&
      durable.workflowRunId === workflowRunId &&
      durable.status === "user_action_required"
    ) {
      return "user_action_required";
    }
    if (durable?.status === "awaiting_review") return "awaiting_review";
    if (durable?.status === "reconcile_required") return "reconcile_required";
    if (durable?.status === "failed") return "failed";
    return "not_owner";
  }

  let run = await storage.getRun(input.runId);
  let currentGeneration = run?.providerOperations?.find(
    (operation) =>
      operation.id === videoGenerationOperationId(execution!.iteration)
  );
  if (
    execution.phase === "video_generation" &&
    (currentGeneration?.status === "in_progress" ||
      currentGeneration?.status === "reconcile_required")
  ) {
    await markVideoGenerationWorkflowError(
      input.runId,
      execution.iteration,
      error
    );
    run = await storage.getRun(input.runId);
    currentGeneration = run?.providerOperations?.find(
      (operation) =>
        operation.id === videoGenerationOperationId(execution!.iteration)
    );
  }

  // Structural completion: every stage already holds its receipt. Settlement
  // (not this recorder) re-proves the receipts against the exact journals.
  let stageCount = 0;
  try {
    const envelope = JSON.parse(execution.renderedPrompt) as {
      stagePrompts?: unknown[];
    };
    stageCount = Array.isArray(envelope.stagePrompts)
      ? envelope.stagePrompts.length
      : 0;
  } catch {
    stageCount = 0;
  }
  if (
    stageCount >= 2 &&
    (execution.chainStageReceipts?.length ?? 0) === stageCount
  ) {
    return "chain_completed";
  }

  // Chain has no delivery-blocking evaluations; only the active generation
  // journal can make the stop ambiguous.
  const status = runExecutionFailureStatus({
    evaluationAmbiguous: false,
    generation: currentGeneration,
  });
  execution = await storage.getRunExecution(input.runId);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId
  ) {
    return "not_owner";
  }
  if (execution.status === "awaiting_review") return "awaiting_review";
  if (execution.status === "user_action_required") {
    return "user_action_required";
  }
  if (execution.status === "failed") return "failed";
  if (execution.status === "reconcile_required") return "reconcile_required";
  const candidate: RunExecution = {
    ...execution,
    status,
    revision: execution.revision + 1,
    updatedAt: Math.max(Date.now(), execution.updatedAt),
    error: error.slice(0, 2_000),
  };
  const advanced = await storage.advanceRunExecution(candidate, execution.revision);
  const durable = advanced.execution;
  if (!durable) return "not_owner";
  if (
    durable.executionId !== input.executionId ||
    durable.workflowRunId !== workflowRunId
  ) {
    return "not_owner";
  }
  if (
    durable.status === "awaiting_review" ||
    durable.status === "user_action_required" ||
    durable.status === "failed" ||
    durable.status === "reconcile_required"
  ) {
    return durable.status;
  }
  throw new Error("Run execution changed while chain failure was recorded.");
}

recordChainExecutionFailure.maxRetries = 4;
