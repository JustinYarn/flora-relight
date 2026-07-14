import {
  FIRST_CUT_MAX_OUTPUT_SECONDS,
} from "../cost.ts";
import {
  firstCutMaximumMicros,
  microsToUsd,
  usdToMicros,
} from "./batch-budget.ts";

/** Pre-container-allowance claims did not persist a price snapshot. */
export const LEGACY_VIDEO_GENERATION_MAX_COST_MICROS = 1_000_000;
export const LEGACY_VIDEO_GENERATION_USD_PER_OUTPUT_SECOND = 0.1;

export interface VideoGenerationCostAuthorization {
  maxAuthorizedCostMicros?: number;
  billingUsdPerOutputSecond?: number;
}

function resolveCostAuthorization(
  authorization: VideoGenerationCostAuthorization
): {
  maxAuthorizedCostMicros: number;
  billingUsdPerOutputSecond: number;
  maxAuthorizedOutputSeconds: number;
} {
  const legacy =
    authorization.maxAuthorizedCostMicros === undefined &&
    authorization.billingUsdPerOutputSecond === undefined;
  const maxAuthorizedCostMicros = legacy
    ? LEGACY_VIDEO_GENERATION_MAX_COST_MICROS
    : authorization.maxAuthorizedCostMicros;
  const billingUsdPerOutputSecond = legacy
    ? LEGACY_VIDEO_GENERATION_USD_PER_OUTPUT_SECOND
    : authorization.billingUsdPerOutputSecond;
  if (
    typeof maxAuthorizedCostMicros !== "number" ||
    !Number.isSafeInteger(maxAuthorizedCostMicros) ||
    maxAuthorizedCostMicros <= 0 ||
    maxAuthorizedCostMicros > firstCutMaximumMicros() ||
    typeof billingUsdPerOutputSecond !== "number" ||
    !Number.isFinite(billingUsdPerOutputSecond) ||
    billingUsdPerOutputSecond <= 0
  ) {
    throw new Error(
      "The video generation claim has no valid immutable cost authorization."
    );
  }
  const maxAuthorizedOutputSeconds =
    microsToUsd(maxAuthorizedCostMicros) / billingUsdPerOutputSecond;
  const floatingPointSlack =
    Number.EPSILON * Math.max(1, maxAuthorizedOutputSeconds) * 4;
  if (
    !Number.isFinite(maxAuthorizedOutputSeconds) ||
    maxAuthorizedOutputSeconds <= 0 ||
    maxAuthorizedOutputSeconds >
      FIRST_CUT_MAX_OUTPUT_SECONDS + floatingPointSlack
  ) {
    throw new Error(
      "The video generation claim exceeds the server output ceiling."
    );
  }
  return {
    maxAuthorizedCostMicros,
    billingUsdPerOutputSecond,
    maxAuthorizedOutputSeconds,
  };
}

/**
 * Price one already-created provider artifact without understating its actual
 * probed duration. The request is paid by this point, so reconciliation may
 * accept only the small container/timebase allowance reserved before launch.
 */
export function authorizedRawOutputCostUsd(
  rawDurationSec: number,
  authorization: VideoGenerationCostAuthorization
): number {
  if (!Number.isFinite(rawDurationSec) || rawDurationSec <= 0) {
    throw new Error("The raw provider output has no valid billable duration.");
  }
  const resolved = resolveCostAuthorization(authorization);
  const floatingPointSlack =
    Number.EPSILON *
    Math.max(1, rawDurationSec, resolved.maxAuthorizedOutputSeconds) *
    4;
  if (
    rawDurationSec >
    resolved.maxAuthorizedOutputSeconds + floatingPointSlack
  ) {
    throw new Error(
      `The raw provider output is ${rawDurationSec.toFixed(3)}s, above the immutable ${resolved.maxAuthorizedOutputSeconds.toFixed(2)}s per-generation authorization.`
    );
  }
  const costUsd =
    rawDurationSec * resolved.billingUsdPerOutputSecond;
  if (usdToMicros(costUsd) > resolved.maxAuthorizedCostMicros) {
    throw new Error(
      "The raw provider output exceeds the immutable per-generation authorization."
    );
  }
  return costUsd;
}
