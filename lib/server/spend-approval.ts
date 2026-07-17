import { randomUUID } from "node:crypto";
import {
  FIRST_CUT_MAX_OUTPUT_SECONDS,
  estimateRun,
  lampBackgroundPlanReservationUsd,
  lampBackgroundTwoPassReservationUsd,
  lampRunReservationUsd,
} from "../cost.ts";
import {
  firstCutMaximumMicros,
  microsToUsd,
  usdToMicros,
} from "./batch-budget.ts";
import { FLORA_WORKFLOW } from "../flora-workflow-def.ts";
import {
  LAMP_BACKGROUND_HOLISTIC_EVAL_ID,
  lampBackgroundEvaluationOperationId,
  lampBackgroundPlanOperationId,
} from "../lamp-background-operations.ts";
import { lampEvaluationOperationId } from "../lamp-evaluation.ts";
import { LIPSYNC_OPERATION_ID } from "../v2-sync.ts";
import type {
  PaidOperation,
  Run,
  SpendApproval,
  VideoAsset,
} from "../types.ts";

export const SINGLE_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const BATCH_APPROVAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const APPROVAL_CLOCK_SKEW_MS = 60_000;
/** Preserve recovery of pre-Lamp approvals that allowed up to four attempts. */
const LEGACY_MAX_ITERATIONS = 4;

export function lampMaximumMicros(): number {
  return usdToMicros(lampRunReservationUsd(FIRST_CUT_MAX_OUTPUT_SECONDS));
}

export function lampBackgroundPlanMaximumMicros(): number {
  return usdToMicros(lampBackgroundPlanReservationUsd());
}

export function lampBackgroundMaximumMicros(): number {
  return usdToMicros(
    lampBackgroundTwoPassReservationUsd(FIRST_CUT_MAX_OUTPUT_SECONDS)
  );
}

export function lampBackgroundTwoPassMaximumMicros(): number {
  return lampBackgroundMaximumMicros();
}

function approvalLifetimeMs(source: SpendApproval["source"]): number {
  return source === "batch"
    ? BATCH_APPROVAL_LIFETIME_MS
    : SINGLE_APPROVAL_LIFETIME_MS;
}

export function createSpendApproval(
  video: VideoAsset,
  source: SpendApproval["source"],
  batchId?: string,
  now = Date.now(),
  scope: NonNullable<SpendApproval["scope"]> = "full_pipeline"
): SpendApproval {
  if (
    !video.runId ||
    !Number.isFinite(video.durationSec) ||
    video.durationSec <= 0 ||
    typeof video.url !== "string" ||
    video.url.length === 0
  ) {
    throw new Error("Spend approval requires a canonical durable source video.");
  }
  if (source === "batch" && (!batchId || batchId.length === 0)) {
    throw new Error("Batch spend approval requires a canonical batch identity.");
  }
  if (source === "single" && batchId !== undefined) {
    throw new Error("Single-run spend approval cannot carry a batch identity.");
  }
  const maxIterations =
    scope === "background_plan"
      ? 0
      : scope === "first_cut"
        ? 1
        : scope === "lamp_two_pass" || scope === "background_two_pass"
          ? 2
          : FLORA_WORKFLOW.config.maxIterations;
  return {
    id: randomUUID(),
    source,
    scope,
    ...(batchId ? { batchId } : {}),
    runId: video.runId,
    sourceUrl: video.url,
    durationSec: video.durationSec,
    approvedAt: now,
    expiresAt: now + approvalLifetimeMs(source),
    maxUsd:
      scope === "first_cut"
        ? microsToUsd(firstCutMaximumMicros())
        : scope === "lamp_two_pass"
          ? microsToUsd(lampMaximumMicros())
          : scope === "background_plan"
            ? microsToUsd(lampBackgroundPlanMaximumMicros())
            : scope === "background_two_pass"
              ? microsToUsd(lampBackgroundMaximumMicros())
              : estimateRun(video.durationSec, maxIterations).totalUsd,
    maxIterations,
  };
}

function approvalIterationsAreValid(
  scope: SpendApproval["scope"],
  maxIterations: number
): boolean {
  if (!Number.isSafeInteger(maxIterations)) return false;
  if (scope === "background_plan") return maxIterations === 0;
  if (scope === "first_cut") return maxIterations === 1;
  if (scope === "lamp_two_pass" || scope === "background_two_pass") {
    return maxIterations === 2;
  }
  return maxIterations >= 1 && maxIterations <= LEGACY_MAX_ITERATIONS;
}

function assertApprovalCoversRun(run: Run, now: number): SpendApproval {
  const approval = run.spendApproval;
  if (!approval) throw new Error("Live spend was not approved for this run.");
  const lifetime =
    approval.source === "single" || approval.source === "batch"
      ? approvalLifetimeMs(approval.source)
      : 0;
  if (
    typeof approval.id !== "string" ||
    approval.id.length === 0 ||
    !Number.isFinite(approval.approvedAt) ||
    !Number.isFinite(approval.expiresAt) ||
    approval.approvedAt > now + APPROVAL_CLOCK_SKEW_MS ||
    approval.expiresAt <= approval.approvedAt ||
    lifetime === 0 ||
    approval.expiresAt - approval.approvedAt > lifetime ||
    (approval.source === "batch"
      ? typeof approval.batchId !== "string" || approval.batchId.length === 0
      : approval.batchId !== undefined) ||
    approval.runId !== run.id ||
    approval.runId !== run.originalVideo.runId ||
    approval.sourceUrl !== run.originalVideo.url ||
    !Number.isFinite(approval.durationSec) ||
    Math.abs(approval.durationSec - run.originalVideo.durationSec) > 0.001 ||
    !Number.isFinite(approval.maxUsd) ||
    approval.maxUsd <= 0 ||
    (approval.scope !== undefined &&
      approval.scope !== "full_pipeline" &&
      approval.scope !== "first_cut" &&
      approval.scope !== "lamp_two_pass" &&
      approval.scope !== "background_plan" &&
      approval.scope !== "background_two_pass") ||
    !approvalIterationsAreValid(approval.scope, approval.maxIterations)
  ) {
    throw new Error("Live spend approval is invalid.");
  }
  if (approval.expiresAt <= now) {
    throw new Error("Live spend approval expired before this operation started.");
  }
  const authorizedWorstCase =
    approval.scope === "first_cut"
      ? microsToUsd(firstCutMaximumMicros())
      : approval.scope === "lamp_two_pass"
        ? microsToUsd(lampMaximumMicros())
        : approval.scope === "background_plan"
          ? microsToUsd(lampBackgroundPlanMaximumMicros())
          : approval.scope === "background_two_pass"
            ? microsToUsd(lampBackgroundMaximumMicros())
            : estimateRun(
                run.originalVideo.durationSec,
                approval.maxIterations
              ).totalUsd;
  const exactMaximumMicros =
    approval.scope === "first_cut"
      ? firstCutMaximumMicros()
      : approval.scope === "lamp_two_pass"
        ? lampMaximumMicros()
        : approval.scope === "background_plan"
          ? lampBackgroundPlanMaximumMicros()
          : approval.scope === "background_two_pass"
            ? lampBackgroundMaximumMicros()
            : null;
  if (
    approval.maxUsd + Number.EPSILON < authorizedWorstCase ||
    (exactMaximumMicros !== null &&
      usdToMicros(approval.maxUsd) !== exactMaximumMicros)
  ) {
    throw new Error("Live spend approval does not match the configured run limit.");
  }
  return approval;
}

/**
 * Lost-response retries may reuse the exact still-valid first-cut approval.
 * Anything expired, underfunded, differently scoped, or bound to another
 * canonical source must require a fresh explicit confirmation.
 */
export function hasReusableFirstCutApproval(
  run: Run,
  source: SpendApproval["source"],
  batchId?: string,
  now = Date.now()
): boolean {
  try {
    const approval = assertApprovalCoversRun(run, now);
    return (
      approval.scope === "first_cut" &&
      approval.source === source &&
      approval.batchId === batchId &&
      approval.maxIterations === 1
    );
  } catch {
    return false;
  }
}

/**
 * Lost-response retries may reuse only the exact two-pass grant for the same
 * execution owner. Batch grants stay bound to their immutable batch id.
 */
export function hasReusableLampApproval(
  run: Run,
  source: SpendApproval["source"] = "single",
  batchId?: string,
  now = Date.now()
): boolean {
  try {
    const approval = assertApprovalCoversRun(run, now);
    return (
      approval.scope === "lamp_two_pass" &&
      approval.source === source &&
      approval.batchId === batchId &&
      approval.maxIterations === 2
    );
  } catch {
    return false;
  }
}

/** Reuse only the exact one-call planner grant bound to this source owner. */
export function hasReusableLampBackgroundPlanApproval(
  run: Run,
  source: SpendApproval["source"] = "single",
  batchId?: string,
  now = Date.now()
): boolean {
  try {
    const approval = assertApprovalCoversRun(run, now);
    return (
      approval.scope === "background_plan" &&
      approval.source === source &&
      approval.batchId === batchId &&
      approval.maxIterations === 0
    );
  } catch {
    return false;
  }
}

/** Reuse only the execution-only cleanup grant; planner spend is not included. */
export function hasReusableLampBackgroundApproval(
  run: Run,
  source: SpendApproval["source"] = "single",
  batchId?: string,
  now = Date.now()
): boolean {
  try {
    const approval = assertApprovalCoversRun(run, now);
    return (
      approval.scope === "background_two_pass" &&
      approval.source === source &&
      approval.batchId === batchId &&
      approval.maxIterations === 2
    );
  } catch {
    return false;
  }
}

export function hasReusableLampBackgroundTwoPassApproval(
  run: Run,
  source: SpendApproval["source"] = "single",
  batchId?: string,
  now = Date.now()
): boolean {
  return hasReusableLampBackgroundApproval(run, source, batchId, now);
}

/**
 * Authorize a new synchronous paid operation. Cache reads and reconciliation
 * never call this because they cannot incur new provider spend.
 */
export function assertPaidOperationAuthorized(
  run: Run,
  kind: PaidOperation["kind"],
  iteration?: number,
  evalId?: string,
  operationId?: string,
  now = Date.now()
): void {
  const approval = assertApprovalCoversRun(run, now);
  if (approval.scope === "first_cut") {
    throw new Error(
      "This approval covers first-cut video generation only; automated paid checks were not authorized."
    );
  }
  if (approval.scope === "background_plan") {
    const exactPlanOperation =
      kind === "plan" &&
      iteration === undefined &&
      evalId === undefined &&
      operationId === lampBackgroundPlanOperationId();
    if (!exactPlanOperation) {
      throw new Error(
        "Lamp Background planning authorizes exactly one cleanup-plan operation and no generation or evaluation spend."
      );
    }
    return;
  }
  if (approval.scope === "lamp_two_pass") {
    const holisticEvaluation =
      kind === "judge" &&
      evalId === "lamp-holistic" &&
      operationId === lampEvaluationOperationId(iteration ?? 0) &&
      (iteration === 1 || iteration === 2);
    const finalLipsyncRepair =
      kind === "lipsync" &&
      iteration === 2 &&
      evalId === undefined &&
      operationId === LIPSYNC_OPERATION_ID;
    if (!holisticEvaluation && !finalLipsyncRepair) {
      throw new Error(
        "Lamp authorizes its two holistic evaluations and at most one Lipsync-2-Pro repair for Final."
      );
    }
    return;
  }
  if (approval.scope === "background_two_pass") {
    const holisticEvaluation =
      kind === "judge" &&
      evalId === LAMP_BACKGROUND_HOLISTIC_EVAL_ID &&
      operationId ===
        lampBackgroundEvaluationOperationId(iteration ?? 0) &&
      (iteration === 1 || iteration === 2);
    const finalLipsyncRepair =
      kind === "lipsync" &&
      iteration === 2 &&
      evalId === undefined &&
      operationId === LIPSYNC_OPERATION_ID;
    if (!holisticEvaluation && !finalLipsyncRepair) {
      throw new Error(
        "Lamp Background execution authorizes its two holistic evaluations and at most one Lipsync-2-Pro repair for Final; planning requires a separate approval."
      );
    }
    return;
  }
  if (kind === "plan") {
    throw new Error(
      "Legacy Flora approvals do not authorize Lamp Background planning."
    );
  }
  if (kind === "manifest") {
    if (iteration !== undefined) {
      throw new Error("Manifest extraction does not accept an iteration.");
    }
    return;
  }
  if (
    !Number.isSafeInteger(iteration) ||
    (iteration as number) < 1 ||
    (iteration as number) > approval.maxIterations ||
    (iteration as number) > LEGACY_MAX_ITERATIONS
  ) {
    throw new Error("This paid operation is outside the approved iteration limit.");
  }
}

/**
 * Fail closed immediately before the billed create call. Existing operation
 * handles may still be polled/reconciled after expiry because that costs $0.
 */
export function assertVideoGenerationAuthorized(
  run: Run,
  iteration: number,
  now = Date.now()
): void {
  const approval = assertApprovalCoversRun(run, now);
  if (approval.scope === "background_plan") {
    throw new Error(
      "Lamp Background planning authorizes zero video generation attempts."
    );
  }
  if (approval.scope === "first_cut" && iteration !== 1) {
    throw new Error(
      "This approval covers only the first video generation attempt."
    );
  }
  if (
    (approval.scope === "lamp_two_pass" ||
      approval.scope === "background_two_pass") &&
    iteration !== 1 &&
    iteration !== 2
  ) {
    throw new Error(
      approval.scope === "lamp_two_pass"
        ? "Lamp authorizes exactly two video generation attempts."
        : "Lamp Background execution authorizes exactly two video generation attempts."
    );
  }
  if (
    iteration < 1 ||
    iteration > approval.maxIterations ||
    iteration >
      (approval.scope === "lamp_two_pass" ||
      approval.scope === "background_two_pass"
        ? 2
        : LEGACY_MAX_ITERATIONS)
  ) {
    throw new Error("This generation attempt is outside the approved limit.");
  }
  if (iteration > 1) {
    const previous = run.providerOperations?.find(
      (operation) =>
        operation.kind === "video_generation" &&
        operation.iteration === iteration - 1 &&
        operation.status === "completed" &&
        operation.providerInteractionId
    );
    if (!previous) {
      throw new Error("The previous generation attempt is not complete.");
    }
  }
}
