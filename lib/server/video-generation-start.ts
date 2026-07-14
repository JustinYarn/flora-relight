import "server-only";

import { isValidRunId } from "@/lib/server/runstore";
import { firstCutMaximumMicros } from "@/lib/server/batch-budget";
import { assertVideoGenerationAuthorized } from "@/lib/server/spend-approval";
import { getStorage } from "@/lib/server/storage";
import {
  prepareVideoGenerationStart,
  startVideoGeneration,
  videoGenerationOperationId,
} from "@/lib/server/videogen-operation";
import type { ProviderOperation } from "@/lib/types";
import { PRICE_TABLE } from "@/lib/cost";

export type VideoGenerationStartErrorCode =
  | "invalid_request"
  | "run_not_found"
  | "not_authorized"
  | "source_preparation_failed"
  | "unresolved_start"
  | "provider_start_failed";

/**
 * Stable failure categories let HTTP routes and durable Workflows share the
 * same paid-start boundary without making transport concerns part of it.
 */
export class VideoGenerationStartError extends Error {
  readonly code: VideoGenerationStartErrorCode;
  readonly cause?: unknown;

  constructor(
    code: VideoGenerationStartErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "VideoGenerationStartError";
    this.code = code;
    this.cause = cause;
  }
}

export interface ClaimAndStartVideoGenerationInput {
  runId: string;
  iteration: number;
  /** Exact serialized prompt persisted with the one billed-operation claim. */
  renderedPrompt: string;
  /** Server-prepared Gemini Files URI; never accepted from an HTTP client. */
  preparedUploadUri?: string;
  /** Durable coordinators reject legacy handles whose exact prompt is unknown. */
  requireExactPrompt?: boolean;
}

export interface ClaimAndStartVideoGenerationResult {
  operationId: string;
  interactionId: string;
  status: ProviderOperation["status"];
  startedAt: number;
  /** True only for the request that won the atomic billed-operation claim. */
  claimed: boolean;
}

function assertValidInput(input: ClaimAndStartVideoGenerationInput): void {
  if (!isValidRunId(input.runId)) {
    throw new VideoGenerationStartError(
      "invalid_request",
      "Invalid runId."
    );
  }
  if (!Number.isInteger(input.iteration) || input.iteration < 1) {
    throw new VideoGenerationStartError(
      "invalid_request",
      "iteration must be a positive integer."
    );
  }
  if (
    typeof input.renderedPrompt !== "string" ||
    input.renderedPrompt.length === 0 ||
    input.renderedPrompt.length > 100_000
  ) {
    throw new VideoGenerationStartError(
      "invalid_request",
      "renderedPrompt must contain 1 to 100,000 characters."
    );
  }
  if (
    input.preparedUploadUri !== undefined &&
    (typeof input.preparedUploadUri !== "string" ||
      input.preparedUploadUri.length === 0 ||
      input.preparedUploadUri.length > 10_000)
  ) {
    throw new VideoGenerationStartError(
      "invalid_request",
      "preparedUploadUri must be a non-empty server URI."
    );
  }
}

export function assertVideoGenerationPromptMatches(
  operation: ProviderOperation,
  renderedPrompt: string,
  requireExactPrompt = false
): void {
  // Older journal entries may not contain the prompt. Preserve their existing
  // recovery path, but never equate two known-different billed inputs.
  if (requireExactPrompt && operation.renderedPrompt === undefined) {
    throw new VideoGenerationStartError(
      "unresolved_start",
      "This legacy generation handle is not bound to an exact prompt. Reconcile it manually before a durable coordinator can adopt it."
    );
  }
  if (operation.renderedPrompt !== undefined && operation.renderedPrompt !== renderedPrompt) {
    throw new VideoGenerationStartError(
      "unresolved_start",
      "This generation was already claimed with a different rendered prompt. Reconcile it before retrying so it cannot be billed twice."
    );
  }
}

/**
 * Reserve and start one video-generation provider interaction.
 *
 * Retry-safe preparation is completed before the atomic claim. Only the claim
 * winner may issue the billed provider create call. A persisted provider
 * handle is always resumed without requiring a fresh spend approval; a prior
 * claim with no handle fails closed for manual reconciliation.
 */
export async function claimAndStartVideoGeneration(
  input: ClaimAndStartVideoGenerationInput
): Promise<ClaimAndStartVideoGenerationResult> {
  assertValidInput(input);

  const storage = getStorage();
  const operationId = videoGenerationOperationId(input.iteration);
  // Preserve the original route contract: the journal timestamp represents
  // the start request, including its retry-safe source-preparation phase.
  const startedAt = Date.now();
  const run = await storage.getRun(input.runId);
  if (!run) {
    throw new VideoGenerationStartError(
      "run_not_found",
      "Run not found."
    );
  }

  const existing = run.providerOperations?.find(
    (operation) => operation.id === operationId
  );
  if (existing) {
    assertVideoGenerationPromptMatches(
      existing,
      input.renderedPrompt,
      input.requireExactPrompt
    );
  }
  if (existing?.providerInteractionId) {
    return {
      operationId,
      interactionId: existing.providerInteractionId,
      status: existing.status,
      startedAt: existing.startedAt,
      claimed: false,
    };
  }
  if (existing) {
    throw new VideoGenerationStartError(
      "unresolved_start",
      "This generation has an unresolved start attempt. Reconcile it before retrying so it cannot be billed twice."
    );
  }

  try {
    assertVideoGenerationAuthorized(run, input.iteration);
  } catch (error) {
    throw new VideoGenerationStartError(
      "not_authorized",
      error instanceof Error
        ? error.message
        : "Live spend is not authorized for this attempt.",
      error
    );
  }

  // Probe/demux and Files-upload work is safe to retry, so it must finish
  // before an operation journal entry reserves the right to bill.
  let preparedUploadUri = input.preparedUploadUri;
  if (!preparedUploadUri) {
    try {
      preparedUploadUri = await prepareVideoGenerationStart(input.runId);
    } catch (error) {
      throw new VideoGenerationStartError(
        "source_preparation_failed",
        "The source video could not be prepared for generation.",
        error
      );
    }
  }

  const claim = await storage.claimProviderOperation(input.runId, {
    id: operationId,
    provider: "gemini",
    kind: "video_generation",
    iteration: input.iteration,
    maxAuthorizedCostMicros: firstCutMaximumMicros(),
    billingUsdPerOutputSecond:
      PRICE_TABLE.omniFlashPerOutputSecond.usd,
    renderedPrompt: input.renderedPrompt,
    status: "in_progress",
    workflowStatus: "pending",
    startedAt,
    updatedAt: startedAt,
  });
  if (!claim.run) {
    throw new VideoGenerationStartError(
      "run_not_found",
      "Run not found."
    );
  }

  const claimedOperation = claim.claimed
    ? claim.run.providerOperations?.find(
        (operation) => operation.id === operationId
      )
    : claim.operation;
  if (!claim.claimed) {
    if (claimedOperation) {
      assertVideoGenerationPromptMatches(
        claimedOperation,
        input.renderedPrompt,
        input.requireExactPrompt
      );
    }
    if (!claimedOperation?.providerInteractionId) {
      throw new VideoGenerationStartError(
        "unresolved_start",
        "This generation has an unresolved start attempt. Reconcile it before retrying so it cannot be billed twice."
      );
    }
    return {
      operationId,
      interactionId: claimedOperation.providerInteractionId,
      status: claimedOperation.status,
      startedAt: claimedOperation.startedAt,
      claimed: false,
    };
  }

  try {
    const providerStart = await startVideoGeneration({
      runId: input.runId,
      iteration: input.iteration,
      prompt: input.renderedPrompt,
      preparedUploadUri,
    });
    return {
      operationId,
      interactionId: providerStart.interactionId,
      status: providerStart.status,
      startedAt: providerStart.startedAt,
      claimed: true,
    };
  } catch (error) {
    throw new VideoGenerationStartError(
      "provider_start_failed",
      "Video generation could not be started safely.",
      error
    );
  }
}
