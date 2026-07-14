import { PRICE_TABLE } from "../cost.ts";
import { MAX_GEN_SECONDS } from "./ffmpeg.ts";

export const USD_MICROS = 1_000_000;

/**
 * Hard server-owned live batch width. Browser and legacy Batch records are
 * presentation/input state only; they never get to widen provider dispatch.
 */
export const DURABLE_BATCH_CONCURRENCY = 2;

export interface BatchBudgetMember {
  runId: string;
  reservedMicros: number;
}

export interface BatchBudgetPlan {
  selected: BatchBudgetMember[];
  skippedRunIds: string[];
  budgetLimitMicros: number;
  reservedMicros: number;
}

/** Backwards-compatible names retained for the legacy Flora first-cut path. */
export type FirstCutBudgetMember = BatchBudgetMember;
export type FirstCutBudgetPlan = BatchBudgetPlan;

/** Integer money conversion used by every server-owned batch decision. */
export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error("USD amount must be a finite non-negative number.");
  }
  const micros = Math.round(usd * USD_MICROS);
  if (!Number.isSafeInteger(micros)) {
    throw new Error("USD amount is too large to represent safely.");
  }
  return micros;
}

export function microsToUsd(micros: number): number {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new Error("Micros must be a non-negative safe integer.");
  }
  return micros / USD_MICROS;
}

/**
 * Full reservation for one generation-only cut. The provider bills output
 * duration, which is not known until finalization, so reserve the model's
 * complete supported output window before the call starts.
 */
export function firstCutMaximumMicros(): number {
  return Math.ceil(
    MAX_GEN_SECONDS *
      PRICE_TABLE.omniFlashPerOutputSecond.usd *
      USD_MICROS
  );
}

/**
 * Deterministically admit a prefix under the hard cap. Reserving every
 * admitted member up front means later concurrency cannot race the budget.
 */
export function planBatchBudget(
  runIds: string[],
  reservationMicros: number,
  budgetUsd?: number
): BatchBudgetPlan {
  if (
    !Number.isSafeInteger(reservationMicros) ||
    reservationMicros <= 0
  ) {
    throw new Error("Member reservation must be a positive safe integer.");
  }
  const uncappedTotal = reservationMicros * runIds.length;
  if (!Number.isSafeInteger(uncappedTotal)) {
    throw new Error("Batch reservation is too large to represent safely.");
  }
  const budgetLimitMicros =
    budgetUsd === undefined ? uncappedTotal : usdToMicros(budgetUsd);
  const selected: BatchBudgetMember[] = [];
  const skippedRunIds: string[] = [];
  let reservedMicros = 0;
  for (const runId of runIds) {
    if (reservedMicros + reservationMicros <= budgetLimitMicros) {
      selected.push({ runId, reservedMicros: reservationMicros });
      reservedMicros += reservationMicros;
    } else {
      skippedRunIds.push(runId);
    }
  }
  return {
    selected,
    skippedRunIds,
    budgetLimitMicros,
    reservedMicros,
  };
}


export function planFirstCutBudget(
  runIds: string[],
  budgetUsd?: number
): FirstCutBudgetPlan {
  return planBatchBudget(runIds, firstCutMaximumMicros(), budgetUsd);
}
