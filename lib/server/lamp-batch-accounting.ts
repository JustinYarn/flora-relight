import { usdToMicros } from "./batch-budget.ts";

export interface LampBatchActualCosts {
  initialGenerationUsd: number;
  initialEvaluationUsd: number;
  finalGenerationUsd: number;
  finalEvaluationUsd: number;
  lipsyncRepairUsd?: number;
}

/**
 * Lamp settles a member only after all four paid boundaries are journaled.
 * Integer conversion happens before addition so batch accounting never relies
 * on floating-point totals or silently omits one critique/generation.
 */
export function confirmedLampBatchActualMicros(
  costs: LampBatchActualCosts
): number {
  const parts = [
    costs.initialGenerationUsd,
    costs.initialEvaluationUsd,
    costs.finalGenerationUsd,
    costs.finalEvaluationUsd,
    costs.lipsyncRepairUsd ?? 0,
  ].map(usdToMicros);
  const total = parts.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) {
    throw new Error("Lamp actual spend exceeded the safe integer range.");
  }
  return total;
}
