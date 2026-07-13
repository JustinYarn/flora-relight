import { getWorkflowMetadata, sleep } from "workflow";
import { getStorage } from "@/lib/server/storage";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import {
  claimAndStartVideoGeneration,
  type ClaimAndStartVideoGenerationResult,
} from "@/lib/server/video-generation-start";
import {
  markVideoGenerationWorkflowError,
  pollVideoGeneration,
  prepareVideoGenerationStart,
  setVideoGenerationWorkflowState,
  videoGenerationOperationId,
  type PollVideoGenerationResult,
} from "@/lib/server/videogen-operation";
import type { ProviderOperation, RunExecution } from "@/lib/types";

export interface DurableRelightRunInput {
  runId: string;
  executionId: string;
  /** Exact bytes hash-bound when the server created RunExecution revision 1. */
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
// Slow, non-billed reconciliation keeps a persisted provider handle alive
// through long provider/network incidents instead of making a 20-minute race
// permanently fail-looking. After seven days, manual reconciliation is safer.
const MAX_RECONCILIATION_POLLS = 7 * 24 * 12;
const KNOWN_PROVIDER_FAILURES = new Set<ProviderOperation["status"]>([
  "failed",
  "cancelled",
  "incomplete",
  "budget_exceeded",
]);

/**
 * Production milestone: one canonical first cut, then human grading.
 *
 * This intentionally does not run or fabricate the browser engine's manifest,
 * anchor gate, visual judges, automatic pass/fail, correction loop, or
 * fallback. The durable provider journal remains the artifact of record and
 * Run materialization labels the result as awaiting human review.
 */
export async function durableRelightRun(
  input: DurableRelightRunInput
): Promise<DurableRelightRunResult> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const bound = await bindExecution(input, workflowRunId);
  if (!bound) return { runId: input.runId, executionId: input.executionId, status: "not_owner" };

  try {
    if (!(await enterGenerationPhase(input, workflowRunId))) {
      return { runId: input.runId, executionId: input.executionId, status: "not_owner" };
    }

    // Files upload/probe/demux is retry-safe and happens before the provider
    // claim. Keeping it outside the zero-retry billed step means a transient
    // local/media failure does not strand an unused billing reservation.
    const preparedUploadUri = await prepareFirstCut(input, workflowRunId);

    // This is the only potentially billed step. The provider SDK and this
    // Workflow step both have automatic retries disabled; the atomic provider
    // journal is the sole authority on whether the call may happen.
    const started = await startFirstCut(
      input,
      workflowRunId,
      preparedUploadUri
    );

    // Workflow-status metadata is non-billed bookkeeping. Exhausting its
    // retries must not discard a safely persisted provider handle.
    try {
      await recordProviderWorkflowRunning(input, workflowRunId);
    } catch {
      // Settlement replays this write and the provider journal remains enough
      // to poll/finalize safely in the meantime.
    }

    for (let poll = 0; poll < MAX_POLLS; poll += 1) {
      await sleep("8s");
      try {
        const result = await pollFirstCut({
          runId: input.runId,
          iteration: 1,
          interactionId: started.interactionId,
        });
        if (result.done) {
          await settleExecution(input, workflowRunId);
          return {
            runId: input.runId,
            executionId: input.executionId,
            status: "awaiting_review",
            videoUrl: result.videoUrl,
            audioVerified: result.audioVerified,
          };
        }
      } catch (pollError) {
        const disposition = await inspectFirstCutAfterPollError(
          input,
          workflowRunId
        );
        if (disposition === "completed") {
          await settleExecution(input, workflowRunId);
          return {
            runId: input.runId,
            executionId: input.executionId,
            status: "awaiting_review",
          };
        }
        if (disposition !== "retryable") throw pollError;
      }
    }

    // The provider handle is durable and polling is non-billed. Slow down but
    // keep reconciling so a completion just after the normal window still
    // reaches the grading queue without any second create call.
    for (let poll = 0; poll < MAX_RECONCILIATION_POLLS; poll += 1) {
      await sleep("5m");
      try {
        const result = await pollFirstCut({
          runId: input.runId,
          iteration: 1,
          interactionId: started.interactionId,
        });
        if (result.done) {
          await settleExecution(input, workflowRunId);
          return {
            runId: input.runId,
            executionId: input.executionId,
            status: "awaiting_review",
            videoUrl: result.videoUrl,
            audioVerified: result.audioVerified,
          };
        }
      } catch (pollError) {
        const disposition = await inspectFirstCutAfterPollError(
          input,
          workflowRunId
        );
        if (disposition === "completed") {
          await settleExecution(input, workflowRunId);
          return {
            runId: input.runId,
            executionId: input.executionId,
            status: "awaiting_review",
          };
        }
        if (disposition !== "retryable") throw pollError;
      }
    }
    throw new Error(
      "Video generation remained unresolved after seven days of non-billed reconciliation."
    );
  } catch (error) {
    const safeError =
      error instanceof Error ? error.message : "Durable first-cut execution failed.";
    const failure = await recordExecutionFailure(input, workflowRunId, safeError);
    if (failure === "completed" || failure === "awaiting_review") {
      await settleExecution(input, workflowRunId);
      return {
        runId: input.runId,
        executionId: input.executionId,
        status: "awaiting_review",
      };
    }
    // RunExecution is the user-facing authority, but the Workflow run must
    // also be failed for operator monitoring instead of looking successful.
    throw new Error(
      failure === "reconcile_required"
        ? "Durable first-cut execution requires provider reconciliation."
        : "Durable first-cut execution failed before a gradeable artifact was confirmed."
    );
  }
}

async function bindExecution(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<boolean> {
  "use step";
  const storage = getStorage();
  const current = await storage.getRunExecution(input.runId);
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.inputHash !== runExecutionInputHash(input.renderedPrompt)
  ) {
    return false;
  }
  if (current.workflowRunId) {
    return current.workflowRunId === workflowRunId && current.status === "running";
  }
  if (current.status !== "queued" || current.phase !== "queued") return false;
  const candidate: RunExecution = {
    ...current,
    status: "running",
    phase: "preparing",
    workflowRunId,
    revision: current.revision + 1,
    updatedAt: Math.max(Date.now(), current.updatedAt),
  };
  const advanced = await storage.advanceRunExecution(candidate, current.revision);
  return (
    advanced.advanced ||
    (advanced.execution?.workflowRunId === workflowRunId &&
      advanced.execution.status === "running")
  );
}

bindExecution.maxRetries = 2;

async function enterGenerationPhase(
  input: DurableRelightRunInput,
  workflowRunId: string
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
  if (current.iteration === 1 && current.phase === "video_generation") return true;
  if (current.iteration !== 0 || current.phase !== "preparing") return false;
  const candidate: RunExecution = {
    ...current,
    iteration: 1,
    phase: "video_generation",
    revision: current.revision + 1,
    updatedAt: Math.max(Date.now(), current.updatedAt),
  };
  const advanced = await storage.advanceRunExecution(candidate, current.revision);
  return (
    advanced.advanced ||
    (advanced.execution?.workflowRunId === workflowRunId &&
      advanced.execution.status === "running" &&
      advanced.execution.iteration === 1 &&
      advanced.execution.phase === "video_generation")
  );
}

enterGenerationPhase.maxRetries = 2;

async function prepareFirstCut(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<string> {
  "use step";
  await assertGenerationOwner(input, workflowRunId);
  return prepareVideoGenerationStart(input.runId);
}

prepareFirstCut.maxRetries = 2;

async function startFirstCut(
  input: DurableRelightRunInput,
  workflowRunId: string,
  preparedUploadUri: string
): Promise<ClaimAndStartVideoGenerationResult> {
  "use step";
  await assertGenerationOwner(input, workflowRunId);
  return claimAndStartVideoGeneration({
    runId: input.runId,
    iteration: 1,
    renderedPrompt: input.renderedPrompt,
    preparedUploadUri,
    requireExactPrompt: true,
  });
}

startFirstCut.maxRetries = 0;

async function assertGenerationOwner(
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
    current.phase !== "video_generation" ||
    current.iteration !== 1
  ) {
    throw new Error("Durable run execution no longer owns generation.");
  }
}

async function recordProviderWorkflowRunning(
  input: DurableRelightRunInput,
  workflowRunId: string
): Promise<void> {
  "use step";
  await setVideoGenerationWorkflowState(
    input.runId,
    1,
    workflowRunId,
    "running"
  );
}

recordProviderWorkflowRunning.maxRetries = 4;

async function pollFirstCut(input: {
  runId: string;
  iteration: number;
  interactionId: string;
}): Promise<PollVideoGenerationResult> {
  "use step";
  return pollVideoGeneration(input);
}

// Polling and deterministic artifact finalization are non-billed and
// idempotent by provider handle, media name, and finalization lease.
pollFirstCut.maxRetries = 2;

type PollErrorDisposition = "completed" | "retryable" | "terminal" | "unrecoverable";

async function inspectFirstCutAfterPollError(
  input: DurableRelightRunInput,
  workflowRunId: string
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
    (item) => item.id === videoGenerationOperationId(1)
  );
  if (!operation || operation.renderedPrompt !== input.renderedPrompt) {
    return "unrecoverable";
  }
  if (operation.status === "completed" && operation.result) return "completed";
  if (KNOWN_PROVIDER_FAILURES.has(operation.status)) return "terminal";
  return operation.providerInteractionId ? "retryable" : "unrecoverable";
}

inspectFirstCutAfterPollError.maxRetries = 2;

async function settleExecution(
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
    execution.renderedPrompt !== input.renderedPrompt ||
    execution.inputHash !== runExecutionInputHash(input.renderedPrompt) ||
    operation?.status !== "completed" ||
    !operation.result ||
    operation.renderedPrompt !== input.renderedPrompt
  ) {
    throw new Error(
      "Completed first-cut artifact is not durably journaled against the exact execution input."
    );
  }

  let durable = execution;
  if (!(execution.status === "awaiting_review" && execution.phase === "complete")) {
    if (execution.status !== "running" && execution.status !== "reconcile_required") {
      throw new Error("Run execution cannot settle from its current state.");
    }
    const candidate: RunExecution = {
      ...execution,
      status: "awaiting_review",
      phase: "complete",
      iteration: 1,
      revision: execution.revision + 1,
      updatedAt: Math.max(Date.now(), execution.updatedAt),
      error: undefined,
    };
    const advanced = await storage.advanceRunExecution(candidate, execution.revision);
    if (!advanced.execution) {
      throw new Error("Run execution disappeared during settlement.");
    }
    durable = advanced.execution;
    if (
      durable.executionId !== input.executionId ||
      durable.workflowRunId !== workflowRunId ||
      durable.status !== "awaiting_review" ||
      durable.phase !== "complete" ||
      durable.iteration !== 1
    ) {
      throw new Error("Run execution settlement lost its durable ownership.");
    }
  }

  // Always replay this second write. If a prior attempt committed execution
  // settlement and died here, the next step retry repairs the metadata.
  await setVideoGenerationWorkflowState(
    input.runId,
    1,
    workflowRunId,
    "completed"
  );
}

settleExecution.maxRetries = 4;

type FailureRecord =
  | "completed"
  | "awaiting_review"
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
  let run = await storage.getRun(input.runId);
  let operation = run?.providerOperations?.find(
    (item) => item.id === videoGenerationOperationId(1)
  );
  if (
    operation?.status === "completed" &&
    operation.result &&
    operation.renderedPrompt === input.renderedPrompt
  ) {
    return "completed";
  }

  if (
    operation?.status === "in_progress" ||
    operation?.status === "reconcile_required"
  ) {
    // This write is part of the recovery journal, not best-effort metadata.
    // Let the durable step retry so RunExecution cannot move on while the
    // provider operation still misleadingly looks healthy.
    await markVideoGenerationWorkflowError(input.runId, 1, error);
    // Completion can win between the stale read and the reconcile write.
    // Re-read so a verified artifact always dominates the failure path.
    run = await storage.getRun(input.runId);
    operation = run?.providerOperations?.find(
      (item) => item.id === videoGenerationOperationId(1)
    );
    if (
      operation?.status === "completed" &&
      operation.result &&
      operation.renderedPrompt === input.renderedPrompt
    ) {
      return "completed";
    }
  }

  const execution = await storage.getRunExecution(input.runId);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.workflowRunId !== workflowRunId
  ) {
    return "not_owner";
  }
  if (execution.status === "awaiting_review") return "awaiting_review";
  if (execution.status === "failed") return "failed";
  if (execution.status === "reconcile_required") return "reconcile_required";

  const status =
    operation && KNOWN_PROVIDER_FAILURES.has(operation.status)
      ? "failed"
      : operation
        ? "reconcile_required"
        : "failed";
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
    durable.status === "failed" ||
    durable.status === "reconcile_required"
  ) {
    return durable.status;
  }
  // A concurrent same-owner checkpoint won. Retrying the idempotent failure
  // step re-reads the new truth rather than claiming an uncommitted status.
  throw new Error("Run execution changed while failure was being recorded.");
}

recordExecutionFailure.maxRetries = 4;
