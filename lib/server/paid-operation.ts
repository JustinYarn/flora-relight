import "server-only";

import { canonicalInputHash } from "@/lib/canonical-input-hash";
import { getStorage } from "@/lib/server/storage";
import { assertPaidOperationAuthorized } from "@/lib/server/spend-approval";
import type { JudgeId, PaidOperation, Run } from "@/lib/types";

export function manifestOperationId(): string {
  return "manifest:v1";
}

export function anchorOperationId(iteration: number): string {
  return `anchor:${iteration}`;
}

export function judgeOperationId(
  iteration: number,
  evalId: string,
  judge: JudgeId
): string {
  return `judge:${iteration}:${evalId}:${judge}`;
}

/** Fingerprint validated inputs without persisting media, prompts, or frames. */
export function paidOperationInputHash(value: unknown): string {
  return canonicalInputHash(value);
}

export type BeginPaidOperationResult =
  | { state: "claimed"; operation: PaidOperation }
  | { state: "cached"; operation: PaidOperation }
  | {
      state: "blocked";
      reason: "input_mismatch" | "in_progress" | "reconcile_required" | "run_missing";
      operation: PaidOperation | null;
    };

export interface BeginPaidOperationInput {
  run: Run;
  id: string;
  provider: PaidOperation["provider"];
  kind: PaidOperation["kind"];
  iteration?: number;
  evalId?: string;
  canonicalInput: unknown;
}

export class PaidOperationAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaidOperationAuthorizationError";
  }
}

function classifyExisting(
  operation: PaidOperation,
  inputHash: string
): BeginPaidOperationResult {
  if (operation.inputHash !== inputHash) {
    return { state: "blocked", reason: "input_mismatch", operation };
  }
  if (operation.status === "completed" && operation.result !== undefined) {
    return { state: "cached", operation };
  }
  return {
    state: "blocked",
    reason:
      operation.status === "reconcile_required"
        ? "reconcile_required"
        : operation.status === "completed"
          ? "reconcile_required"
          : "in_progress",
    operation,
  };
}

/**
 * Reserve the single right to issue a billed request. Existing completed
 * operations are free cache reads, while every non-completed duplicate is
 * blocked. Only the atomic storage winner receives `state: "claimed"`.
 */
export async function beginPaidOperation(
  input: BeginPaidOperationInput
): Promise<BeginPaidOperationResult> {
  const storage = getStorage();
  const inputHash = paidOperationInputHash({
    operationId: input.id,
    payload: input.canonicalInput,
  });
  const existing = await storage.getPaidOperation(input.run.id, input.id);
  if (existing) return classifyExisting(existing, inputHash);

  // Checked only for a NEW claim. Returning an already-completed response is
  // non-billed and remains safe after approval expiry.
  try {
    assertPaidOperationAuthorized(
      input.run,
      input.kind,
      input.iteration,
      input.evalId,
      input.id
    );
  } catch (error) {
    throw new PaidOperationAuthorizationError(
      error instanceof Error ? error.message : "Live spend is not authorized."
    );
  }
  const now = Date.now();
  const operation: PaidOperation = {
    id: input.id,
    runId: input.run.id,
    provider: input.provider,
    kind: input.kind,
    ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
    ...(input.evalId ? { evalId: input.evalId } : {}),
    inputHash,
    status: "in_progress",
    startedAt: now,
    updatedAt: now,
  };
  const claim = await storage.claimPaidOperation(operation);
  if (claim.claimed) return { state: "claimed", operation: claim.operation };
  if (!claim.operation) {
    return { state: "blocked", reason: "run_missing", operation: null };
  }
  return classifyExisting(claim.operation, inputHash);
}

/** Persist the exact response before returning it to the browser. */
export async function completePaidOperation<T>(
  operation: PaidOperation,
  result: T
): Promise<T> {
  const completed = await getStorage().completePaidOperation(
    operation.runId,
    operation.id,
    operation.inputHash,
    result
  );
  if (completed?.status !== "completed" || completed.result === undefined) {
    throw new Error("Paid operation result could not be committed safely.");
  }
  return completed.result as T;
}

/** Persist an asynchronous provider id before any polling or artifact work. */
export async function persistPaidOperationProviderId(
  operation: PaidOperation,
  providerOperationId: string
): Promise<PaidOperation> {
  const updated = await getStorage().setPaidOperationProviderId(
    operation.runId,
    operation.id,
    operation.inputHash,
    providerOperationId
  );
  if (
    updated?.status !== "in_progress" ||
    updated.providerOperationId !== providerOperationId
  ) {
    throw new Error("Paid provider operation id could not be committed safely.");
  }
  return updated;
}

/** Seal an uncertain call so no automatic or manual retry can re-bill it. */
export async function markPaidOperationReconcileRequired(
  operation: PaidOperation,
  safeError: string,
  receipt?: unknown
): Promise<void> {
  await getStorage().reconcilePaidOperation(
    operation.runId,
    operation.id,
    operation.inputHash,
    safeError.slice(0, 500),
    receipt
  );
}

export function paidOperationBlockedMessage(
  result: Extract<BeginPaidOperationResult, { state: "blocked" }>
): string {
  switch (result.reason) {
    case "input_mismatch":
      return "This operation id was already reserved with different validated inputs.";
    case "in_progress":
      return "This provider request may already be in progress. Reconcile it before any retry.";
    case "reconcile_required":
      return "This provider request has an ambiguous outcome and requires reconciliation before any retry.";
    case "run_missing":
      return "Run not found.";
  }
}
