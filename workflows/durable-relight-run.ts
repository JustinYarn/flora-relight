import { getWorkflowMetadata, sleep } from "workflow";
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
import { runLampHolisticEvaluation } from "@/lib/server/lamp-evaluator";
import type { PreparedLipsyncInputs } from "@/lib/server/replicate-lipsync";
import { getStorage } from "@/lib/server/storage";
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
  hasReusableLampApproval,
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
  isLipsyncOperationResult,
  LIPSYNC_OPERATION_ID,
  v2SyncVerdict,
  type LipsyncOperationResult,
  type SyncNetMetrics,
} from "@/lib/v2-sync";
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

  try {
    const backgroundPlan =
      workflowMode === "background"
        ? await readBoundBackgroundPlan(input, workflowRunId)
        : undefined;
    const beautifyPlan =
      workflowMode === "beautify"
        ? await readBoundBeautifyPlan(input, workflowRunId)
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
    if (workflowMode === "beautify") {
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
    if (workflowMode === "beautify") {
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
    if (workflowMode === "beautify") {
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
      if (workflowMode === "beautify") {
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

interface EffectiveV2 {
  videoUrl: string;
  audioVerified: true;
}

async function finalizeV2WithSync(
  input: DurableRelightRunInput,
  workflowRunId: string
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

  const candidate = await analyzeV2CandidateStep(input, workflowRunId);
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
  iteration: 1 | 2,
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
  iteration: 1 | 2,
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
  if (workflowMode === "background" || workflowMode === "beautify") {
    const planOperation = execution.planOperationId
      ? await getStorage().getPaidOperation(
          input.runId,
          execution.planOperationId
        )
      : null;
    if (workflowMode === "beautify") {
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
  try {
    assertVideoGenerationAuthorized(run, iteration);
  } catch (error) {
    // A valid exact Lamp grant means this is an orchestration invariant (for
    // example, a missing prior completion), not something another user click
    // can repair. Only an absent/expired/mismatched Lamp grant is resumable.
    const reusableApproval =
      workflowMode === "beautify"
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
  iteration: 1 | 2,
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
  iteration: 1 | 2
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

async function analyzeV2CandidateStep(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<V2CandidateSyncCheck> {
  "use step";
  await assertV2FinalizeOwner(input, workflowRunId);
  return analyzeV2Candidate(input.runId);
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

async function recordProviderWorkflowRunning(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2
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
  iteration: 1 | 2
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
  iteration: 1 | 2,
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
  iteration: 1 | 2,
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
  iteration: 1 | 2
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
  iteration: 1 | 2
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
    (lipsync !== null &&
      (lipsync.status !== "completed" ||
        !isLipsyncOperationResult(lipsync.result) ||
        !v2SyncVerdict(
          lipsync.result.postSync,
          run?.originalVideo.syncBaseline ?? null
        ).pass))
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
    (lipsync !== null &&
      (lipsync.status !== "completed" ||
        !isLipsyncOperationResult(lipsync.result) ||
        !v2SyncVerdict(
          lipsync.result.postSync,
          run.originalVideo.syncBaseline ?? null
        ).pass))
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
    (lipsync !== null &&
      (lipsync.status !== "completed" ||
        !isLipsyncOperationResult(lipsync.result) ||
        !v2SyncVerdict(
          lipsync.result.postSync,
          run.originalVideo.syncBaseline ?? null
        ).pass))
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

async function settleExecutionRecord(
  execution: RunExecution,
  workflowRunId: string,
  iteration: 1 | 2,
  executionId: string
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
  const [firstBackgroundEvaluation, finalEvaluation, lipsync] =
    await Promise.all([
      workflowMode === "background"
        ? storage.getPaidOperation(
            input.runId,
            lampBackgroundEvaluationOperationId(1)
          )
        : Promise.resolve(null),
      workflowMode === "background"
        ? storage.getPaidOperation(
            input.runId,
            lampBackgroundEvaluationOperationId(2)
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
  if (
    workflowMode === "background" &&
    run &&
    firstBackgroundEvaluation?.status === "completed" &&
    isLampBackgroundEvaluationArtifact(
      firstBackgroundEvaluation.result,
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
        firstBackgroundEvaluation.result
      ).rendered;
      finalEvaluationComplete =
        firstBackgroundEvaluation.result.cleanupPlanId === cleanupPlan.id &&
        finalEvaluation.result.cleanupPlanId === cleanupPlan.id &&
        final?.renderedPrompt === expectedFinalPrompt;
    } catch {
      finalEvaluationComplete = false;
    }
  }
  if (
    twoPass &&
    final?.status === "completed" &&
    final.result &&
    final.result.audioVerified &&
    finalEvaluationComplete &&
    (lipsync === null ||
      (lipsync.status === "completed" &&
        isLipsyncOperationResult(lipsync.result) &&
        v2SyncVerdict(
          lipsync.result.postSync,
          run?.originalVideo.syncBaseline ?? null
        ).pass))
  ) {
    return "two_pass_completed";
  }

  const currentEvaluation =
    twoPass && execution.phase === "evaluating"
      ? await storage.getPaidOperation(
          input.runId,
          workflowMode === "background"
            ? lampBackgroundEvaluationOperationId(execution.iteration)
            : lampEvaluationOperationId(execution.iteration)
        )
      : null;
  const evaluationAmbiguous = Boolean(
    (currentEvaluation && currentEvaluation.status !== "completed") ||
      (lipsync && lipsync.status !== "completed")
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
