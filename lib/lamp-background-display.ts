import {
  approveLampBackgroundCleanupPlan,
  createMockLampBackgroundCleanupPlan,
  parseLampBackgroundCleanupPlan,
  type LampBackgroundCleanupPlan,
} from "./lamp-background.ts";
import {
  lampBackgroundNoOpPromptForRun,
  lampBackgroundPromptForRun,
} from "./lamp-background-read.ts";
import { initialLampBackgroundMegaPrompt } from "./prompts/lamp-background.ts";
import type { MegaPrompt, Run } from "./types.ts";

const SAMPLE_CREATED_AT = 1_700_000_000_000;
const SAMPLE_APPROVED_PLAN = approveLampBackgroundCleanupPlan(
  createMockLampBackgroundCleanupPlan(
    "definition-sample",
    SAMPLE_CREATED_AT
  ),
  SAMPLE_CREATED_AT
);

/** Stable, clearly synthetic approved plan for definition-only prompt views. */
export function sampleApprovedLampBackgroundPlan(): LampBackgroundCleanupPlan {
  return parseLampBackgroundCleanupPlan(SAMPLE_APPROVED_PLAN);
}

export interface LampBackgroundDisplayPrompt {
  prompt: MegaPrompt;
  /** The approved plan actually bound to `prompt`, including the sample case. */
  promptPlan: LampBackgroundCleanupPlan;
  runBound: boolean;
  sample: boolean;
  source: string;
}

/**
 * Prefer exact bytes already attached to a background run. Before approval,
 * fall back to the explicit definition sample because generation is not yet
 * authorized against the run's draft plan.
 */
export function lampBackgroundDisplayPrompt(
  run?: Run,
  iteration?: Run["iterations"][number]
): LampBackgroundDisplayPrompt {
  const selectedIteration =
    iteration ?? run?.iterations[run.iterations.length - 1];
  const runPlan =
    run?.workflowMode === "background" && run.backgroundCleanupPlan
      ? parseLampBackgroundCleanupPlan(run.backgroundCleanupPlan)
      : undefined;

  if (run?.workflowMode === "background" && selectedIteration) {
    return {
      prompt: selectedIteration.megaPrompt,
      promptPlan:
        runPlan?.approval.status === "approved"
          ? runPlan
          : sampleApprovedLampBackgroundPlan(),
      runBound: true,
      sample: false,
      source: `run.iterations · ${
        selectedIteration.index === 1
          ? "Initial"
          : selectedIteration.index === 2
            ? "Final"
            : `v${selectedIteration.index}`
      } · megaPrompt.rendered`,
    };
  }

  if (runPlan?.approval.status === "approved") {
    return {
      prompt:
        runPlan.decision === "exceptional-no-op"
          ? lampBackgroundNoOpPromptForRun(runPlan)
          : lampBackgroundPromptForRun(
              initialLampBackgroundMegaPrompt(runPlan)
            ),
      promptPlan: runPlan,
      runBound: true,
      sample: false,
      source:
        runPlan.decision === "exceptional-no-op"
          ? "run.backgroundCleanupPlan · approved exceptional no-op"
          : "run.backgroundCleanupPlan · approved plan compiled with current v1 renderer",
    };
  }

  const samplePlan = sampleApprovedLampBackgroundPlan();
  return {
    prompt: lampBackgroundPromptForRun(
      initialLampBackgroundMegaPrompt(samplePlan)
    ),
    promptPlan: samplePlan,
    runBound: false,
    sample: true,
    source:
      "definition sample · approved Lamp Background cleanup plan + current v1 renderer",
  };
}
