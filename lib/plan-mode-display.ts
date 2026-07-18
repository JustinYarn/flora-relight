import {
  approveLampBeautifyPlan,
  createMockLampBeautifyPlan,
  parseLampBeautifyPlan,
  type LampBeautifyPlan,
} from "./lamp-beautify.ts";
import {
  lampBeautifyNoOpPromptForRun,
  lampBeautifyPromptForRun,
} from "./lamp-beautify-read.ts";
import {
  approveLampIrisPlan,
  createMockLampIrisPlan,
  parseLampIrisPlan,
  type LampIrisPlan,
} from "./lamp-iris.ts";
import {
  lampIrisNoOpPromptForRun,
  lampIrisPromptForRun,
} from "./lamp-iris-read.ts";
import { lampBackgroundDisplayPrompt } from "./lamp-background-display.ts";
import { initialLampBeautifyMegaPrompt } from "./prompts/lamp-beautify.ts";
import { initialLampIrisMegaPrompt } from "./prompts/lamp-iris.ts";
import { runWorkflowMode } from "./workflow-mode.ts";
import type { MegaPrompt, Run, WorkflowMode } from "./types.ts";

export type VersionAPlanMode = Extract<
  WorkflowMode,
  "background" | "beautify" | "iris"
>;

export interface PlanModeDisplayPrompt {
  prompt: MegaPrompt;
  runBound: boolean;
  sample: boolean;
  source: string;
}

const SAMPLE_CREATED_AT = 1_700_000_000_000;
const SAMPLE_BEAUTIFY_PLAN = approveLampBeautifyPlan(
  createMockLampBeautifyPlan("definition-sample", SAMPLE_CREATED_AT),
  SAMPLE_CREATED_AT
);
const SAMPLE_IRIS_PLAN = approveLampIrisPlan(
  createMockLampIrisPlan("definition-sample", SAMPLE_CREATED_AT),
  SAMPLE_CREATED_AT
);

export function isVersionAPlanMode(
  workflowMode: WorkflowMode
): workflowMode is VersionAPlanMode {
  return (
    workflowMode === "background" ||
    workflowMode === "beautify" ||
    workflowMode === "iris"
  );
}

/** Stable, clearly synthetic approved plan for definition-only prompt views. */
export function sampleApprovedLampBeautifyPlan(): LampBeautifyPlan {
  return parseLampBeautifyPlan(SAMPLE_BEAUTIFY_PLAN);
}

/** Stable, clearly synthetic approved plan for definition-only prompt views. */
export function sampleApprovedLampIrisPlan(): LampIrisPlan {
  return parseLampIrisPlan(SAMPLE_IRIS_PLAN);
}

function selectedIterationFor(
  workflowMode: VersionAPlanMode,
  run?: Run,
  iteration?: Run["iterations"][number]
): Run["iterations"][number] | undefined {
  if (!run || runWorkflowMode(run) !== workflowMode) return undefined;
  return iteration ?? run.iterations[run.iterations.length - 1];
}

export function lampBeautifyDisplayPrompt(
  run?: Run,
  iteration?: Run["iterations"][number]
): PlanModeDisplayPrompt {
  const selectedIteration = selectedIterationFor("beautify", run, iteration);
  if (selectedIteration) {
    return {
      prompt: selectedIteration.megaPrompt,
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

  const runPlan =
    run && runWorkflowMode(run) === "beautify" && run.beautifyPlan
      ? parseLampBeautifyPlan(run.beautifyPlan)
      : undefined;
  if (runPlan?.approval.status === "approved") {
    return {
      prompt:
        runPlan.decision === "exceptional-no-op"
          ? lampBeautifyNoOpPromptForRun(runPlan)
          : lampBeautifyPromptForRun(initialLampBeautifyMegaPrompt(runPlan)),
      runBound: true,
      sample: false,
      source:
        runPlan.decision === "exceptional-no-op"
          ? "run.beautifyPlan · approved exceptional no-op"
          : "run.beautifyPlan · approved plan compiled with its frozen v1 renderer",
    };
  }

  const samplePlan = sampleApprovedLampBeautifyPlan();
  return {
    prompt: lampBeautifyPromptForRun(initialLampBeautifyMegaPrompt(samplePlan)),
    runBound: false,
    sample: true,
    source:
      "definition sample · approved Lamp Beautify plan + frozen v1 renderer",
  };
}

export function lampIrisDisplayPrompt(
  run?: Run,
  iteration?: Run["iterations"][number]
): PlanModeDisplayPrompt {
  const selectedIteration = selectedIterationFor("iris", run, iteration);
  if (selectedIteration) {
    return {
      prompt: selectedIteration.megaPrompt,
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

  const runPlan =
    run && runWorkflowMode(run) === "iris" && run.irisPlan
      ? parseLampIrisPlan(run.irisPlan)
      : undefined;
  if (runPlan?.approval.status === "approved") {
    return {
      prompt:
        runPlan.decision === "exceptional-no-op"
          ? lampIrisNoOpPromptForRun(runPlan)
          : lampIrisPromptForRun(initialLampIrisMegaPrompt(runPlan)),
      runBound: true,
      sample: false,
      source:
        runPlan.decision === "exceptional-no-op"
          ? "run.irisPlan · approved exceptional no-op"
          : "run.irisPlan · approved plan compiled with its frozen v1 renderer",
    };
  }

  const samplePlan = sampleApprovedLampIrisPlan();
  return {
    prompt: lampIrisPromptForRun(initialLampIrisMegaPrompt(samplePlan)),
    runBound: false,
    sample: true,
    source: "definition sample · approved Lamp Iris plan + frozen v1 renderer",
  };
}

export function planModeDisplayPrompt(
  workflowMode: VersionAPlanMode,
  run?: Run,
  iteration?: Run["iterations"][number]
): PlanModeDisplayPrompt {
  if (workflowMode === "background") {
    return lampBackgroundDisplayPrompt(run, iteration);
  }
  if (workflowMode === "beautify") {
    return lampBeautifyDisplayPrompt(run, iteration);
  }
  return lampIrisDisplayPrompt(run, iteration);
}
