/**
 * Validation and forward-only transition rules for server-owned executions.
 * Kept pure so both storage drivers enforce the same lifecycle before CAS.
 */

import type {
  RunExecution,
  RunExecutionPhase,
  RunExecutionStatus,
} from "../../types.ts";
import { assertRunId } from "../runstore.ts";
import {
  isLampApprovalReplayTransition,
  isLampLostGenerationAcknowledgeTransition,
  LAMP_USER_ACTION_REQUIRED_PREFIX,
} from "../run-execution-resume.ts";
import {
  isLampChainExecutionId,
  isTwoPassExecutionId,
} from "../../workflow-mode.ts";
import { isRelightIntensity } from "../../relight-intensity.ts";
import { isV2CandidateSyncVerdict } from "../../v2-sync.ts";
import { isLampCombinedCandidateQualificationReceipt } from "../../lamp-combined-candidate.ts";
import { isLampChainStageReceipt } from "../../lamp-chain-candidate.ts";
import { LAMP_CHAIN_STAGE_PROMPT_LINEAGE } from "../../prompts/lamp-chain.ts";
import { createHash } from "node:crypto";

const EXECUTION_ID_RE = /^[a-z0-9:_-]{1,160}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_OPTIONAL_ID_LENGTH = 256;
const MAX_ERROR_LENGTH = 2_000;
const MAX_RENDERED_PROMPT_LENGTH = 100_000;

const PHASE_RANK: Record<RunExecutionPhase, number> = {
  queued: 0,
  preparing: 1,
  video_generation: 2,
  evaluating: 3,
  finalizing: 4,
  complete: 5,
};

const STATUS_TRANSITIONS: Record<
  RunExecutionStatus,
  ReadonlySet<RunExecutionStatus>
> = {
  queued: new Set([
    "queued",
    "running",
    "failed",
    "reconcile_required",
  ]),
  running: new Set([
    "running",
    "user_action_required",
    "awaiting_review",
    "failed",
    "reconcile_required",
  ]),
  user_action_required: new Set([
    "user_action_required",
    "queued",
    "failed",
    "reconcile_required",
  ]),
  awaiting_review: new Set(["awaiting_review"]),
  failed: new Set(["failed"]),
  reconcile_required: new Set([
    "reconcile_required",
    "awaiting_review",
    "failed",
  ]),
};

function assertTimestamp(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative millisecond timestamp`);
  }
}

function assertOptionalText(
  value: unknown,
  name: string,
  maxLength: number
): asserts value is string | undefined {
  if (
    value !== undefined &&
    (typeof value !== "string" || value.length < 1 || value.length > maxLength)
  ) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
}

/** Validate one complete execution record without consulting stored state. */
export function assertRunExecution(execution: unknown): RunExecution {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    throw new Error("Invalid run execution record");
  }
  const candidate = execution as RunExecution;
  assertRunId(candidate.runId);
  if (
    typeof candidate.executionId !== "string" ||
    !EXECUTION_ID_RE.test(candidate.executionId)
  ) {
    throw new Error("Invalid run execution id");
  }
  if (typeof candidate.inputHash !== "string" || !SHA256_RE.test(candidate.inputHash)) {
    throw new Error("Run execution inputHash must be a lowercase sha256 digest");
  }
  if (
    typeof candidate.renderedPrompt !== "string" ||
    candidate.renderedPrompt.length < 1 ||
    candidate.renderedPrompt.length > MAX_RENDERED_PROMPT_LENGTH
  ) {
    throw new Error(
      `Run execution renderedPrompt must contain 1-${MAX_RENDERED_PROMPT_LENGTH} characters`
    );
  }
  const renderedPromptHash = createHash("sha256")
    .update(candidate.renderedPrompt, "utf8")
    .digest("hex");
  if (renderedPromptHash !== candidate.inputHash) {
    throw new Error("Run execution renderedPrompt does not match inputHash");
  }
  if (
    candidate.relightIntensity !== undefined &&
    !isRelightIntensity(candidate.relightIntensity)
  ) {
    throw new Error(
      "Run execution relightIntensity must be a five-point step from 0 through 100"
    );
  }
  if (candidate.source !== "single" && candidate.source !== "batch") {
    throw new Error("Invalid run execution source");
  }
  if (candidate.batchId !== undefined) assertRunId(candidate.batchId);
  if (candidate.source === "single" && candidate.batchId !== undefined) {
    throw new Error("A single-run execution cannot have a batch id");
  }
  if (
    typeof candidate.status !== "string" ||
    !Object.prototype.hasOwnProperty.call(STATUS_TRANSITIONS, candidate.status)
  ) {
    throw new Error("Invalid run execution status");
  }
  if (
    typeof candidate.phase !== "string" ||
    !Object.prototype.hasOwnProperty.call(PHASE_RANK, candidate.phase)
  ) {
    throw new Error("Invalid run execution phase");
  }
  if (!Number.isSafeInteger(candidate.iteration) || candidate.iteration < 0) {
    throw new Error("Run execution iteration must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 1) {
    throw new Error("Run execution revision must be a positive safe integer");
  }
  assertTimestamp(candidate.startedAt, "startedAt");
  assertTimestamp(candidate.updatedAt, "updatedAt");
  if (candidate.updatedAt < candidate.startedAt) {
    throw new Error("Run execution updatedAt cannot precede startedAt");
  }
  assertOptionalText(
    candidate.workflowRunId,
    "workflowRunId",
    MAX_OPTIONAL_ID_LENGTH
  );
  assertOptionalText(
    candidate.planOperationId,
    "planOperationId",
    MAX_OPTIONAL_ID_LENGTH
  );
  if (candidate.combinedPlanOperationIds !== undefined) {
    if (
      !Array.isArray(candidate.combinedPlanOperationIds) ||
      candidate.combinedPlanOperationIds.length < 1 ||
      new Set(candidate.combinedPlanOperationIds).size !==
        candidate.combinedPlanOperationIds.length
    ) {
      throw new Error(
        "Run execution combinedPlanOperationIds must be a non-empty unique array"
      );
    }
    candidate.combinedPlanOperationIds.forEach((operationId, index) =>
      assertOptionalText(
        operationId,
        `combinedPlanOperationIds[${index}]`,
        MAX_OPTIONAL_ID_LENGTH
      )
    );
  }
  if (
    candidate.approvedPlanHash !== undefined &&
    (typeof candidate.approvedPlanHash !== "string" ||
      !SHA256_RE.test(candidate.approvedPlanHash))
  ) {
    throw new Error(
      "Run execution approvedPlanHash must be a lowercase sha256 digest"
    );
  }
  assertOptionalText(candidate.error, "error", MAX_ERROR_LENGTH);
  if (
    candidate.deliveredIteration !== undefined &&
    candidate.deliveredIteration !== 1 &&
    candidate.deliveredIteration !== 2
  ) {
    throw new Error("Run execution deliveredIteration must be 1 or 2");
  }
  if (
    candidate.deliveredIteration !== undefined &&
    !candidate.executionId.startsWith("lamp-iris:")
  ) {
    throw new Error(
      "deliveredIteration is a Lamp Iris best-of-two field and is invalid on other executions"
    );
  }
  if (
    candidate.candidateSyncVerdict !== undefined &&
    !isV2CandidateSyncVerdict(candidate.candidateSyncVerdict)
  ) {
    throw new Error("Run execution candidateSyncVerdict is invalid");
  }

  const combined = candidate.executionId.startsWith("lamp-combined:");
  if (candidate.combinedCandidateReceipts !== undefined) {
    const receipts = candidate.combinedCandidateReceipts;
    if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)) {
      throw new Error("Run execution Combined candidate receipts are invalid");
    }
    if (receipts.initial === undefined && receipts.final === undefined) {
      throw new Error("Run execution Combined candidate receipts cannot be empty");
    }
    if (
      receipts.initial !== undefined &&
      (!isLampCombinedCandidateQualificationReceipt(receipts.initial) ||
        receipts.initial.iteration !== 1)
    ) {
      throw new Error("Run execution Combined Initial receipt is invalid");
    }
    if (
      receipts.final !== undefined &&
      (!isLampCombinedCandidateQualificationReceipt(receipts.final) ||
        receipts.final.iteration !== 2)
    ) {
      throw new Error("Run execution Combined Final receipt is invalid");
    }
    for (const receipt of [receipts.initial, receipts.final]) {
      if (
        receipt &&
        (receipt.recordedAt < candidate.startedAt ||
          receipt.recordedAt > candidate.updatedAt ||
          (receipt.repair &&
            (receipt.repair.recordedAt < receipt.recordedAt ||
              receipt.repair.recordedAt > candidate.updatedAt)))
      ) {
        throw new Error(
          "Combined candidate receipt timestamps must fall inside the execution timeline"
        );
      }
    }
  }
  const chained = isLampChainExecutionId(candidate.executionId);
  if (
    (combined || chained) !==
    Boolean(
      candidate.combinedPlanOperationIds && candidate.approvedPlanHash
    )
  ) {
    throw new Error(
      "A Combined or Chain execution requires its exact planner set and approved plan hash"
    );
  }
  if (
    combined &&
    (candidate.source !== "single" ||
      candidate.batchId !== undefined ||
      candidate.planOperationId !== undefined ||
      candidate.candidateSyncVerdict !== undefined ||
      candidate.deliveredIteration !== undefined ||
      candidate.relightIntensity === undefined)
  ) {
    throw new Error(
      "Lamp Combined is single-run only and cannot use legacy plan, sync, or winner fields"
    );
  }
  if (
    chained &&
    (candidate.source !== "single" ||
      candidate.batchId !== undefined ||
      candidate.planOperationId !== undefined ||
      candidate.candidateSyncVerdict !== undefined ||
      candidate.deliveredIteration !== undefined ||
      candidate.combinedCandidateReceipts !== undefined ||
      candidate.relightIntensity === undefined)
  ) {
    throw new Error(
      "Lamp Chain is single-run only and cannot use legacy plan, sync, winner, or Combined receipt fields"
    );
  }
  if (!combined && candidate.combinedCandidateReceipts !== undefined) {
    throw new Error("Combined candidate receipts are invalid on other executions");
  }
  if (!combined && !chained && candidate.combinedPlanOperationIds !== undefined) {
    throw new Error("Combined planner ids are invalid on other executions");
  }
  if (!chained && candidate.chainStageReceipts !== undefined) {
    throw new Error("Chain stage receipts are invalid on other executions");
  }
  let chainStageCount: number | null = null;
  if (chained) {
    // The chain renderedPrompt is the serialized frozen prompt envelope; its
    // stage list is the delivery contract every receipt must line up against.
    try {
      const envelope = JSON.parse(candidate.renderedPrompt) as {
        lineage?: unknown;
        stagePrompts?: unknown;
      };
      if (
        envelope.lineage !== LAMP_CHAIN_STAGE_PROMPT_LINEAGE ||
        !Array.isArray(envelope.stagePrompts) ||
        envelope.stagePrompts.length < 2 ||
        envelope.stagePrompts.length > 4
      ) {
        throw new Error("wrong shape");
      }
      chainStageCount = envelope.stagePrompts.length;
    } catch {
      throw new Error(
        "A Chain execution must bind a valid serialized stage-prompt envelope"
      );
    }
    const receipts = candidate.chainStageReceipts ?? [];
    if (!Array.isArray(receipts)) {
      throw new Error("Chain stage receipts must be an array");
    }
    if (receipts.length > chainStageCount) {
      throw new Error("Chain stage receipts exceed the bound stage count");
    }
    receipts.forEach((receipt, index) => {
      if (!isLampChainStageReceipt(receipt)) {
        throw new Error(`Chain stage receipt ${index + 1} is invalid`);
      }
      if (receipt.stage !== index + 1) {
        throw new Error("Chain stage receipts must be contiguous from stage 1");
      }
      if (
        receipt.recordedAt < candidate.startedAt ||
        receipt.recordedAt > candidate.updatedAt
      ) {
        throw new Error(
          "Chain stage receipt timestamps must fall inside the execution timeline"
        );
      }
    });
  }
  if (
    candidate.candidateSyncVerdict !== undefined &&
    (!isTwoPassExecutionId(candidate.executionId) || candidate.iteration < 2)
  ) {
    throw new Error(
      "candidateSyncVerdict is valid only after a two-pass Final exists"
    );
  }
  if (
    candidate.candidateSyncVerdict !== undefined &&
    (candidate.candidateSyncVerdict.recordedAt < candidate.startedAt ||
      candidate.candidateSyncVerdict.recordedAt > candidate.updatedAt)
  ) {
    throw new Error(
      "candidateSyncVerdict timestamp must fall inside the execution timeline"
    );
  }

  const planFirst =
    candidate.executionId.startsWith("lamp-background:") ||
    candidate.executionId.startsWith("lamp-beautify:") ||
    candidate.executionId.startsWith("lamp-iris:");
  if (
    planFirst !==
    Boolean(candidate.planOperationId && candidate.approvedPlanHash)
  ) {
    throw new Error(
      "A plan-first execution identity requires an approved planner operation and plan hash"
    );
  }
  if (
    candidate.status === "awaiting_review" &&
    combined &&
    (!candidate.combinedCandidateReceipts?.initial ||
      !candidate.combinedCandidateReceipts?.final)
  ) {
    throw new Error(
      "A completed Combined execution requires explicit receipts for both candidates"
    );
  }
  if (
    candidate.status === "awaiting_review" &&
    chained &&
    (candidate.chainStageReceipts?.length ?? 0) !== chainStageCount
  ) {
    throw new Error(
      "A delivered Chain execution requires a structural receipt for every stage"
    );
  }

  if (candidate.status === "queued" && candidate.phase !== "queued") {
    throw new Error("A queued execution must be in the queued phase");
  }
  if (
    candidate.status === "running" &&
    (candidate.phase === "queued" || candidate.phase === "complete")
  ) {
    throw new Error("A running execution must be in an active phase");
  }
  if (
    candidate.status === "awaiting_review" &&
    candidate.phase !== "complete"
  ) {
    throw new Error("An execution awaiting review must be complete");
  }
  if (
    candidate.status === "user_action_required" &&
    ((!isTwoPassExecutionId(candidate.executionId) &&
      !isLampChainExecutionId(candidate.executionId)) ||
      candidate.phase === "queued" ||
      candidate.phase === "complete" ||
      !candidate.workflowRunId ||
      !candidate.error?.startsWith(LAMP_USER_ACTION_REQUIRED_PREFIX))
  ) {
    throw new Error(
      "A Lamp execution awaiting approval must retain its active owner and reason"
    );
  }

  return candidate;
}

/** Creation is the first durable version of a newly queued execution. */
export function assertNewRunExecution(execution: RunExecution): RunExecution {
  assertRunExecution(execution);
  if (
    execution.revision !== 1 ||
    execution.status !== "queued" ||
    execution.phase !== "queued" ||
    execution.iteration !== 0 ||
    execution.candidateSyncVerdict !== undefined ||
    execution.combinedCandidateReceipts !== undefined ||
    (execution.chainStageReceipts?.length ?? 0) !== 0
  ) {
    throw new Error(
      "A new run execution must start queued at iteration 0 and revision 1"
    );
  }
  return execution;
}

/** Validate a candidate only after its expected revision still owns the CAS. */
export function assertRunExecutionTransition(
  current: RunExecution,
  candidate: RunExecution,
  expectedRevision: number
): RunExecution {
  assertRunExecution(current);
  assertRunExecution(candidate);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("expectedRevision must be a positive safe integer");
  }
  if (current.revision !== expectedRevision) {
    throw new Error("Current run execution revision does not match the expected revision");
  }
  if (candidate.revision !== expectedRevision + 1) {
    throw new Error("Run execution candidate must be the next revision");
  }
  const approvalReplay = isLampApprovalReplayTransition(current, candidate);
  if (
    candidate.runId !== current.runId ||
    candidate.executionId !== current.executionId ||
    candidate.inputHash !== current.inputHash ||
    candidate.renderedPrompt !== current.renderedPrompt ||
    candidate.planOperationId !== current.planOperationId ||
    JSON.stringify(candidate.combinedPlanOperationIds) !==
      JSON.stringify(current.combinedPlanOperationIds) ||
    candidate.approvedPlanHash !== current.approvedPlanHash ||
    candidate.relightIntensity !== current.relightIntensity ||
    candidate.source !== current.source ||
    candidate.batchId !== current.batchId ||
    candidate.startedAt !== current.startedAt
  ) {
    throw new Error("Run execution identity fields are immutable");
  }
  const currentReceipts = current.combinedCandidateReceipts;
  const nextReceipts = candidate.combinedCandidateReceipts;
  const baseReceipt = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const base = { ...(value as Record<string, unknown>) };
    delete base.repair;
    return base;
  };
  if (currentReceipts?.initial) {
    if (
      JSON.stringify(nextReceipts?.initial) !==
      JSON.stringify(currentReceipts.initial)
    ) {
      throw new Error("Combined Initial qualification receipt is immutable");
    }
  } else if (nextReceipts?.initial) {
    if (
      current.status !== "running" ||
      candidate.status !== "running" ||
      current.iteration !== 1 ||
      candidate.iteration !== 1
    ) {
      throw new Error(
        "Combined Initial qualification may only be journaled on the active Initial"
      );
    }
  }
  if (currentReceipts?.final) {
    if (
      JSON.stringify(baseReceipt(nextReceipts?.final)) !==
      JSON.stringify(baseReceipt(currentReceipts.final))
    ) {
      throw new Error("Combined Final base qualification receipt is immutable");
    }
    if (currentReceipts.final.repair) {
      if (
        JSON.stringify(nextReceipts?.final?.repair) !==
        JSON.stringify(currentReceipts.final.repair)
      ) {
        throw new Error("Combined Final repair qualification is immutable");
      }
    } else if (
      nextReceipts?.final?.repair &&
      (current.status !== "running" ||
        candidate.status !== "running" ||
        current.iteration !== 2 ||
        candidate.iteration !== 2)
    ) {
      throw new Error(
        "Combined Final repair may only be appended on the active Final"
      );
    }
  } else if (nextReceipts?.final) {
    if (
      current.status !== "running" ||
      candidate.status !== "running" ||
      current.iteration !== 2 ||
      candidate.iteration !== 2 ||
      !nextReceipts.initial
    ) {
      throw new Error(
        "Combined Final qualification may only follow Initial on the active Final"
      );
    }
  }
  if (
    currentReceipts !== undefined &&
    nextReceipts === undefined
  ) {
    throw new Error("Combined candidate receipts cannot be removed");
  }
  const currentChainReceipts = current.chainStageReceipts ?? [];
  const nextChainReceipts = candidate.chainStageReceipts ?? [];
  if (nextChainReceipts.length < currentChainReceipts.length) {
    throw new Error("Chain stage receipts cannot be removed");
  }
  currentChainReceipts.forEach((receipt, index) => {
    if (
      JSON.stringify(nextChainReceipts[index]) !== JSON.stringify(receipt)
    ) {
      throw new Error("Recorded chain stage receipts are immutable");
    }
  });
  if (
    nextChainReceipts.length > currentChainReceipts.length &&
    (current.status !== "running" ||
      candidate.status !== "running" ||
      nextChainReceipts.length > candidate.iteration)
  ) {
    // A stage receipt may only be journaled while the chain is actively on or
    // past that stage; settlement then requires the full contiguous set.
    throw new Error(
      "Chain stage receipts may only be appended on the active stage"
    );
  }
  if (
    !approvalReplay &&
    current.workflowRunId !== undefined &&
    candidate.workflowRunId !== current.workflowRunId
  ) {
    throw new Error("Run execution workflowRunId is immutable after binding");
  }
  if (current.candidateSyncVerdict !== undefined) {
    if (
      JSON.stringify(candidate.candidateSyncVerdict) !==
      JSON.stringify(current.candidateSyncVerdict)
    ) {
      throw new Error("Run execution candidateSyncVerdict is immutable");
    }
  } else if (
    candidate.candidateSyncVerdict !== undefined &&
    (current.status !== "running" ||
      candidate.status !== "running" ||
      current.iteration !== 2 ||
      candidate.iteration !== 2)
  ) {
    throw new Error(
      "candidateSyncVerdict may only be journaled on the active Final"
    );
  }
  if (candidate.updatedAt < current.updatedAt) {
    throw new Error("Run execution updatedAt cannot move backwards");
  }
  if (!approvalReplay && candidate.iteration < current.iteration) {
    throw new Error("Run execution iteration cannot move backwards");
  }
  // Phase order is per iteration. A later attempt intentionally resets to
  // preparing/video_generation while remaining lexicographically ahead.
  if (
    !approvalReplay &&
    candidate.iteration === current.iteration &&
    PHASE_RANK[candidate.phase] < PHASE_RANK[current.phase]
  ) {
    throw new Error("Run execution phase cannot move backwards");
  }
  if (
    !STATUS_TRANSITIONS[current.status].has(candidate.status) &&
    // A human acknowledging a provider-lost generation is the single guarded
    // exit from reconcile_required into the paused-for-approval state. The
    // replacement generation still fails closed until a fresh exact approval
    // is confirmed, so this cannot re-bill anything by itself.
    !isLampLostGenerationAcknowledgeTransition(current, candidate)
  ) {
    throw new Error(
      `Run execution status cannot move from ${current.status} to ${candidate.status}`
    );
  }
  return candidate;
}
