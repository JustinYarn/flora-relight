import {
  LAMP_IRIS_EVAL_DEFS,
  LAMP_IRIS_EVAL_IDS,
  LAMP_IRIS_EVALUATOR_VERSION,
  type LampIrisEvalDefinition,
  type LampIrisEvaluationArtifact,
} from "./lamp-iris-evaluation.ts";
import { parseLampIrisPlan, type LampIrisPlan } from "./lamp-iris.ts";
import {
  LAMP_IRIS_BASE_PROMPT,
  renderLampIrisCorrection,
  type LampIrisMegaPrompt,
} from "./prompts/lamp-iris.ts";
import type {
  Correction,
  EvalCategory,
  EvalDefinition,
  EvalResult,
  IterationComposite,
  MegaPrompt,
  RelightBasePrompt,
  Run,
  Violation,
} from "./types.ts";

const CATEGORY_MAP: Record<LampIrisEvalDefinition["category"], EvalCategory> = {
  identity: "identity",
  gaze: "appearance",
  eyes: "identity",
  motion: "motion",
  fidelity: "framing",
  background: "background",
  people: "background",
  temporal: "temporal",
  audio: "audio",
};

/** Existing UI surfaces consume EvalDefinition; this adapter preserves that contract. */
export const LAMP_IRIS_UI_EVAL_DEFS: EvalDefinition[] = LAMP_IRIS_EVAL_DEFS.map(
  (definition) => ({
    id: definition.id,
    name: definition.name,
    category: CATEGORY_MAP[definition.category],
    description: definition.description,
    method:
      definition.method === "deterministic" ? "deterministic" : "dual-llm-judge",
    hardGate: definition.hardGate,
    weight: definition.weight,
    passThreshold: definition.passThreshold,
    borderlineThreshold: definition.borderlineThreshold,
    promptTemplate:
      definition.method === "deterministic" ? "" : definition.rubric,
    ...(definition.method === "deterministic"
      ? { deterministicNote: definition.rubric }
      : {}),
  })
);

function presentationBase(): RelightBasePrompt {
  return {
    task: LAMP_IRIS_BASE_PROMPT.task,
    locks: {
      identity: LAMP_IRIS_BASE_PROMPT.locks.identityAndEyeAppearance,
      performance: LAMP_IRIS_BASE_PROMPT.locks.performanceAndHeadPose,
      wardrobe: LAMP_IRIS_BASE_PROMPT.locks.wardrobeAndOtherPeople,
      background: LAMP_IRIS_BASE_PROMPT.locks.backgroundAndRoom,
      camera: LAMP_IRIS_BASE_PROMPT.locks.lightingAndCamera,
      audio: LAMP_IRIS_BASE_PROMPT.locks.audio,
    },
    lighting: {
      style:
        "LOCK SOURCE LIGHTING — Lamp Iris does not authorize a relight, glow, or color grade.",
      keyLight:
        "Preserve the source key direction, intensity, softness, shadows, and highlight response.",
      fillLight:
        "Preserve the source fill level and contrast exactly; no beauty lighting.",
      rimLight:
        "Do not add rim light, glow, bloom, subject separation, or any other lighting effect.",
      colorTemperature:
        "Preserve source white balance, color temperature, saturation, and exposure.",
      mood:
        "Preserve the source look. The only intended improvement is the approved gaze correction.",
    },
    negative: [...LAMP_IRIS_BASE_PROMPT.negative],
  };
}

/**
 * Run.Iteration retains the historical MegaPrompt presentation shape. The
 * exact provider bytes remain the iris renderer's `rendered` value.
 */
export function lampIrisPromptForRun(prompt: LampIrisMegaPrompt): MegaPrompt {
  const corrections: Correction[] = prompt.corrections.map((correction) => ({
    id: correction.id,
    sourceEvalId: correction.sourceEvalId,
    severity: correction.severity,
    instruction: renderLampIrisCorrection(prompt.plan, correction),
    addedAtIteration: 2,
    resolved: false,
  }));
  return {
    version: prompt.version,
    base: presentationBase(),
    lightingDirective:
      "Preserve the exact source lighting, exposure, color, focus, depth of field, framing, and camera behavior.",
    corrections,
    rendered: prompt.rendered,
  };
}

export function lampIrisNoOpPromptForRun(irisPlan: LampIrisPlan): MegaPrompt {
  const plan = parseLampIrisPlan(irisPlan);
  if (
    plan.approval.status !== "approved" ||
    plan.decision !== "exceptional-no-op"
  ) {
    throw new Error(
      "Lamp Iris no-op presentation requires an approved exceptional no-op plan."
    );
  }
  return {
    version: 1,
    base: presentationBase(),
    lightingDirective:
      "No generation was authorized. Deliver the exact source video unchanged.",
    corrections: [],
    rendered: [
      "=== LAMP IRIS APPROVED EXCEPTIONAL NO-OP ===",
      `Plan ID: ${plan.id}`,
      plan.noOpJustification?.summary ?? plan.subjectSummary,
      "The exact source video is the delivery. No generation or final AI evaluation was run.",
    ].join("\n"),
  };
}

function toViolation(
  plan: LampIrisPlan,
  result: LampIrisEvaluationArtifact["evalResults"][number],
  violation: LampIrisEvaluationArtifact["evalResults"][number]["violations"][number]
): Violation {
  const correction = violation.correction
    ? renderLampIrisCorrection(plan, {
        id: `projection:${result.evalId}:${violation.aspect}`,
        sourceEvalId: result.evalId,
        aspect: violation.aspect,
        severity: violation.severity,
        action: violation.correction.action,
        planItemIds: violation.correction.planItemIds,
      })
    : "";
  return {
    aspect: violation.aspect,
    severity: violation.severity,
    description: violation.description,
    ...(violation.frameTimestampSec !== undefined
      ? { frameTimestampSec: violation.frameTimestampSec }
      : {}),
    correction,
  };
}

export function lampIrisArtifactResultsForRun(
  artifact: LampIrisEvaluationArtifact,
  irisPlan: LampIrisPlan
): EvalResult[] {
  const plan = parseLampIrisPlan(irisPlan);
  return artifact.evalResults.map((result) => {
    const violations = result.violations.map((violation) =>
      toViolation(plan, result, violation)
    );
    return {
      evalId: result.evalId,
      iteration: result.iteration,
      verdicts:
        result.evalId === "audio-integrity"
          ? []
          : [
              {
                judge: "gemini",
                score: result.score,
                verdict: result.verdict,
                violations,
                reasoning: result.reasoning,
              },
            ],
      score: result.score,
      confidence: result.confidence,
      verdict: result.verdict,
      violations,
      ...(result.deltaFromPrevious !== undefined
        ? { deltaFromPrevious: result.deltaFromPrevious }
        : {}),
    };
  });
}

export function lampIrisCompositeForResults(
  results: EvalResult[]
): IterationComposite | undefined {
  const irisIds = new Set<string>(LAMP_IRIS_EVAL_IDS);
  const seen = new Set<string>();
  for (const result of results) {
    if (!irisIds.has(result.evalId)) continue;
    if (seen.has(result.evalId)) return undefined;
    seen.add(result.evalId);
  }
  const ordered = LAMP_IRIS_UI_EVAL_DEFS.map((definition) =>
    results.find((result) => result.evalId === definition.id)
  );
  if (
    ordered.some(
      (result) =>
        result === undefined ||
        !Number.isFinite(result.score) ||
        !["pass", "borderline", "fail"].includes(result.verdict)
    )
  ) {
    return undefined;
  }
  let weighted = 0;
  let totalWeight = 0;
  const hardGateFailures: string[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const result = ordered[index]!;
    const definition = LAMP_IRIS_UI_EVAL_DEFS[index];
    weighted += definition.weight * result.score;
    totalWeight += definition.weight;
    if (definition.hardGate && result.verdict !== "pass") {
      hardGateFailures.push(definition.id);
    }
  }
  const score =
    Math.round((totalWeight > 0 ? weighted / totalWeight : 0) * 10) / 10;
  return {
    score,
    passed: hardGateFailures.length === 0,
    hardGateFailures,
  };
}

export function isLampIrisEvaluationArtifact(
  value: unknown,
  iteration?: 1 | 2
): value is LampIrisEvaluationArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Partial<LampIrisEvaluationArtifact>;
  if (
    artifact.version !== LAMP_IRIS_EVALUATOR_VERSION ||
    (artifact.iteration !== 1 && artifact.iteration !== 2) ||
    (iteration !== undefined && artifact.iteration !== iteration) ||
    typeof artifact.planId !== "string" ||
    artifact.planId.length === 0 ||
    !Array.isArray(artifact.evalResults) ||
    artifact.evalResults.length !== LAMP_IRIS_EVAL_IDS.length ||
    typeof artifact.costUsd !== "number" ||
    !Number.isFinite(artifact.costUsd) ||
    artifact.costUsd < 0
  ) {
    return false;
  }
  const ids = artifact.evalResults.map((result) => result?.evalId);
  return (
    new Set(ids).size === LAMP_IRIS_EVAL_IDS.length &&
    LAMP_IRIS_EVAL_IDS.every((evalId) => ids.includes(evalId))
  );
}

export function projectLampIrisEvaluationForRead(input: {
  iteration: 1 | 2;
  artifact?: LampIrisEvaluationArtifact;
  irisPlan: LampIrisPlan;
  humanGradeSaved: boolean;
  hideFinalEvaluation?: boolean;
  /**
   * Best-of-two: which take settlement delivered (1 = Initial, 2 = Final).
   * The blind-grading hide applies to the DELIVERED take — the one the human
   * grades — while the other take's evaluation stays visible. Absent = legacy
   * Final-delivered records, preserving the historical iteration-2 hide.
   */
  deliveredIteration?: 1 | 2;
}): { evalResults: EvalResult[]; composite?: IterationComposite } {
  const deliveredIteration = input.deliveredIteration ?? 2;
  if (
    !input.artifact ||
    (input.iteration === deliveredIteration &&
      !input.humanGradeSaved &&
      input.hideFinalEvaluation === true)
  ) {
    return { evalResults: [] };
  }
  const evalResults = lampIrisArtifactResultsForRun(
    input.artifact,
    input.irisPlan
  );
  return {
    evalResults,
    composite: lampIrisCompositeForResults(evalResults),
  };
}

export function isLampIrisRun(
  run: Pick<Run, "workflowId" | "workflowMode" | "serverExecution">
): boolean {
  if (run.serverExecution?.executionId) {
    return run.serverExecution.executionId.startsWith("lamp-iris:");
  }
  return run.workflowMode === "iris" || run.workflowId === "lamp-iris-v1";
}
