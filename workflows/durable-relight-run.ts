import { getWorkflowMetadata, sleep } from "workflow";
import {
  compileLampFinalPrompt,
  isLampEvaluationArtifact,
  lampEvaluationOperationId,
  type LampEvaluationArtifact,
} from "@/lib/lamp-evaluation";
import { runLampHolisticEvaluation } from "@/lib/server/lamp-evaluator";
import { getStorage } from "@/lib/server/storage";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import {
  isLampUserActionRequiredError,
  LAMP_USER_ACTION_REQUIRED_PREFIX,
} from "@/lib/server/run-execution-resume";
import {
  claimAndStartVideoGeneration,
  VideoGenerationStartError,
  type ClaimAndStartVideoGenerationResult,
} from "@/lib/server/video-generation-start";
import { PaidOperationAuthorizationError } from "@/lib/server/paid-operation";
import {
  assertVideoGenerationAuthorized,
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
import type {
  ProviderOperation,
  RunExecution,
  VideoGenerationOperationResult,
} from "@/lib/types";

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
const KNOWN_PROVIDER_FAILURES = new Set<ProviderOperation["status"]>([
  "failed",
  "cancelled",
  "incomplete",
  "budget_exceeded",
]);

/**
 * Lamp runs use the fixed two-pass contract, whether started alone or by the
 * durable batch parent:
 *
 *   original + mega prompt v1 -> generation 1 -> holistic critique
 *   -> corrected mega prompt v2 -> generation 2 from original
 *   -> final holistic evaluation -> blind human grading
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
  const lamp = input.executionId.startsWith("lamp:");

  try {
    const first = await runGenerationAttempt(
      input,
      workflowRunId,
      1,
      input.renderedPrompt
    );

    if (!lamp) {
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
    const firstEvaluation = await evaluateAttemptWithRecovery(
      input,
      workflowRunId,
      1,
      []
    );
    const finalPrompt = compileLampFinalPrompt(
      input.renderedPrompt,
      firstEvaluation
    );

    const final = await runGenerationAttempt(
      input,
      workflowRunId,
      2,
      finalPrompt.rendered
    );
    await enterEvaluationPhaseWithRecovery(input, workflowRunId, 2);
    await evaluateAttemptWithRecovery(
      input,
      workflowRunId,
      2,
      firstEvaluation.evalResults
    );
    await settleLampExecution(input, workflowRunId, finalPrompt.rendered);
    return {
      runId: input.runId,
      executionId: input.executionId,
      status: "awaiting_review",
      videoUrl: final.videoUrl,
      audioVerified: final.audioVerified,
    };
  } catch (error) {
    const safeError =
      error instanceof Error ? error.message : "Durable Lamp execution failed.";
    const failure = await recordExecutionFailure(
      input,
      workflowRunId,
      safeError
    );
    if (failure === "legacy_completed") {
      await settleLegacyFirstCut(input, workflowRunId);
      return { runId: input.runId, executionId: input.executionId, status: "awaiting_review" };
    }
    if (failure === "lamp_completed") {
      const firstEvaluation = await readCompletedEvaluation(input.runId, 1);
      const finalPrompt = compileLampFinalPrompt(
        input.renderedPrompt,
        firstEvaluation
      );
      await settleLampExecution(input, workflowRunId, finalPrompt.rendered);
      return { runId: input.runId, executionId: input.executionId, status: "awaiting_review" };
    }
    if (failure === "awaiting_review") {
      return { runId: input.runId, executionId: input.executionId, status: "awaiting_review" };
    }
    throw new Error(
      failure === "user_action_required"
        ? "Durable Lamp execution paused until its exact spend approval is renewed."
        : failure === "reconcile_required"
        ? "Durable Lamp execution requires provider reconciliation."
        : "Durable Lamp execution stopped before a gradeable final artifact was confirmed."
    );
  }
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
  try {
    assertVideoGenerationAuthorized(run, iteration);
  } catch (error) {
    // A valid exact Lamp grant means this is an orchestration invariant (for
    // example, a missing prior completion), not something another user click
    // can repair. Only an absent/expired/mismatched Lamp grant is resumable.
    if (
      hasReusableLampApproval(
        run,
        execution.source,
        execution.batchId
      )
    ) {
      throw error;
    }
    throw new Error(
      `${LAMP_USER_ACTION_REQUIRED_PREFIX}${error instanceof Error ? error.message : "Lamp spend approval must be renewed."}`
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

pollAttempt.maxRetries = 2;

type PollErrorDisposition = "completed" | "retryable" | "terminal" | "unrecoverable";

async function inspectAttemptAfterPollError(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  renderedPrompt: string
): Promise<PollErrorDisposition> {
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
  if (operation.status === "completed" && operation.result) return "completed";
  if (KNOWN_PROVIDER_FAILURES.has(operation.status)) return "terminal";
  return operation.providerInteractionId ? "retryable" : "unrecoverable";
}

inspectAttemptAfterPollError.maxRetries = 2;

async function inspectAttemptAfterPollErrorWithRecovery(
  input: DurableRelightRunInput,
  workflowRunId: string,
  iteration: 1 | 2,
  renderedPrompt: string
): Promise<PollErrorDisposition> {
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
    execution.executionId.startsWith("lamp:") ||
    execution.renderedPrompt !== input.renderedPrompt ||
    operation?.status !== "completed" ||
    !operation.result ||
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
  const [execution, run, finalEvaluation] = await Promise.all([
    storage.getRunExecution(input.runId),
    storage.getRun(input.runId),
    storage.getPaidOperation(input.runId, lampEvaluationOperationId(2)),
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
    !isLampEvaluationArtifact(finalEvaluation.result, 2)
  ) {
    throw new Error(
      "Lamp's final artifact and final evaluation are not durably journaled against this execution."
    );
  }
  await settleExecutionRecord(execution, workflowRunId, 2, input.executionId);
  await setVideoGenerationWorkflowState(input.runId, 2, workflowRunId, "completed");
}

settleLampExecution.maxRetries = 4;

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
  | "lamp_completed"
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
    input.executionId.startsWith("lamp:") &&
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
  const lamp = input.executionId.startsWith("lamp:");
  if (!lamp && first?.status === "completed" && first.result) {
    return "legacy_completed";
  }
  const final = run?.providerOperations?.find(
    (operation) => operation.id === videoGenerationOperationId(2)
  );
  const finalEvaluation = await storage.getPaidOperation(
    input.runId,
    lampEvaluationOperationId(2)
  );
  if (
    lamp &&
    final?.status === "completed" &&
    final.result &&
    final.result.audioVerified &&
    finalEvaluation?.status === "completed" &&
    isLampEvaluationArtifact(finalEvaluation.result, 2)
  ) {
    return "lamp_completed";
  }

  const currentEvaluation =
    lamp && execution.phase === "evaluating"
      ? await storage.getPaidOperation(
          input.runId,
          lampEvaluationOperationId(execution.iteration)
        )
      : null;
  const ambiguousEvaluation = Boolean(
    currentEvaluation && currentEvaluation.status !== "completed"
  );
  const ambiguousGeneration = Boolean(
    currentGeneration &&
      !KNOWN_PROVIDER_FAILURES.has(currentGeneration.status) &&
      currentGeneration.status !== "completed"
  );
  const status =
    ambiguousEvaluation || ambiguousGeneration
      ? "reconcile_required"
      : "failed";
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
