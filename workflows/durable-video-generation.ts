import { getWorkflowMetadata, sleep } from "workflow";
import {
  markVideoGenerationWorkflowError,
  pollVideoGeneration,
  setVideoGenerationWorkflowState,
  type PollVideoGenerationInput,
  type PollVideoGenerationResult,
} from "@/lib/server/videogen-operation";

export type DurableVideoGenerationInput = PollVideoGenerationInput;
const MAX_POLLS = 150; // 20 minutes at 8s; expected provider latency is 1-7m.

/**
 * Own long-running polling and artifact finalization outside the browser tab.
 * The potentially billed provider create call deliberately happens once in
 * the guarded start route, before this Workflow begins; every step here is
 * non-billed and safe to replay by its stable media/operation keys.
 */
export async function durableVideoGeneration(
  input: DurableVideoGenerationInput
): Promise<Extract<PollVideoGenerationResult, { done: true }>> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  try {
    await recordWorkflowState(input.runId, input.iteration, workflowRunId, "running");
    for (let poll = 0; poll < MAX_POLLS; poll += 1) {
      await sleep("8s");
      const result = await pollProviderGeneration(input);
      if (result.done) {
        await recordWorkflowState(
          input.runId,
          input.iteration,
          workflowRunId,
          "completed"
        );
        return result;
      }
    }
    throw new Error(
      "Video generation exceeded the 20-minute reconciliation deadline."
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Video workflow failed.";
    await recordWorkflowFailure(input.runId, input.iteration, message);
    throw error;
  }
}

async function pollProviderGeneration(input: PollVideoGenerationInput) {
  "use step";
  return pollVideoGeneration(input);
}

// Polling and artifact finalization are non-billed and idempotent by media key.
pollProviderGeneration.maxRetries = 2;

async function recordWorkflowFailure(
  runId: string,
  iteration: number,
  message: string
) {
  "use step";
  await markVideoGenerationWorkflowError(runId, iteration, message);
}

recordWorkflowFailure.maxRetries = 2;

async function recordWorkflowState(
  runId: string,
  iteration: number,
  workflowRunId: string,
  status: "running" | "completed"
) {
  "use step";
  await setVideoGenerationWorkflowState(runId, iteration, workflowRunId, status);
}

recordWorkflowState.maxRetries = 2;
