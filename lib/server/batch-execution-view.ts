import "server-only";

import type {
  BatchExecution,
  BatchExecutionSummary,
} from "@/lib/types";

/** Keep exact prompt bytes in server storage while exposing progress/accounting. */
export function summarizeBatchExecution(
  execution: BatchExecution
): BatchExecutionSummary {
  const summary = { ...execution } as Partial<BatchExecution>;
  delete summary.renderedPrompt;
  return summary as BatchExecutionSummary;
}
