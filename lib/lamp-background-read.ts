import {
  LAMP_BACKGROUND_EVAL_DEFS,
  LAMP_BACKGROUND_EVAL_IDS,
  LAMP_BACKGROUND_EVALUATOR_VERSION,
  type LampBackgroundEvalDefinition,
  type LampBackgroundEvaluationArtifact,
} from "./lamp-background-evaluation.ts";
import {
  parseLampBackgroundCleanupPlan,
  type LampBackgroundCleanupPlan,
} from "./lamp-background.ts";
import {
  LAMP_BACKGROUND_BASE_PROMPT,
  renderLampBackgroundCorrection,
  type LampBackgroundMegaPrompt,
} from "./prompts/lamp-background.ts";
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

const CATEGORY_MAP: Record<
  LampBackgroundEvalDefinition["category"],
  EvalCategory
> = {
  identity: "identity",
  skin: "identity",
  appearance: "appearance",
  motion: "motion",
  cleanup: "background",
  temporal: "temporal",
  artifact: "hallucination",
  fidelity: "framing",
  audio: "audio",
};

/** Existing UI surfaces consume EvalDefinition; this adapter preserves that contract. */
export const LAMP_BACKGROUND_UI_EVAL_DEFS: EvalDefinition[] =
  LAMP_BACKGROUND_EVAL_DEFS.map((definition) => ({
    id: definition.id,
    name: definition.name,
    category: CATEGORY_MAP[definition.category],
    description: definition.description,
    method:
      definition.method === "deterministic"
        ? "deterministic"
        : "dual-llm-judge",
    hardGate: definition.hardGate,
    weight: definition.weight,
    passThreshold: definition.passThreshold,
    borderlineThreshold: definition.borderlineThreshold,
    promptTemplate:
      definition.method === "deterministic" ? "" : definition.rubric,
    ...(definition.method === "deterministic"
      ? { deterministicNote: definition.rubric }
      : {}),
  }));

function presentationBase(): RelightBasePrompt {
  return {
    task: LAMP_BACKGROUND_BASE_PROMPT.task,
    locks: {
      identity: LAMP_BACKGROUND_BASE_PROMPT.locks.identityAndSkin,
      performance: LAMP_BACKGROUND_BASE_PROMPT.locks.performance,
      wardrobe: LAMP_BACKGROUND_BASE_PROMPT.locks.appearanceAndInteraction,
      background: LAMP_BACKGROUND_BASE_PROMPT.locks.protectedBackground,
      camera: LAMP_BACKGROUND_BASE_PROMPT.locks.lightingAndCamera,
      audio: LAMP_BACKGROUND_BASE_PROMPT.locks.audio,
    },
    lighting: {
      style:
        "LOCK SOURCE LIGHTING — Lamp Background does not authorize a relight or color grade.",
      keyLight:
        "Preserve the source key direction, intensity, softness, shadows, and highlight response.",
      fillLight:
        "Preserve the source fill level and contrast exactly outside approved removal footprints.",
      rimLight:
        "Do not add rim light, glow, subject separation, or any other lighting effect.",
      colorTemperature:
        "Preserve source white balance, color temperature, saturation, and exposure.",
      mood:
        "Preserve the source look. The only intended improvement is approved visual-clutter removal.",
    },
    negative: [...LAMP_BACKGROUND_BASE_PROMPT.negative],
  };
}

/**
 * Run.Iteration retains the historical MegaPrompt presentation shape. The
 * exact provider bytes remain the background renderer's `rendered` value.
 */
export function lampBackgroundPromptForRun(
  prompt: LampBackgroundMegaPrompt
): MegaPrompt {
  const corrections: Correction[] = prompt.corrections.map((correction) => ({
    id: correction.id,
    sourceEvalId: correction.sourceEvalId,
    severity: correction.severity,
    instruction: renderLampBackgroundCorrection(
      prompt.cleanupPlan,
      correction
    ),
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

export function lampBackgroundNoOpPromptForRun(
  cleanupPlan: LampBackgroundCleanupPlan
): MegaPrompt {
  const plan = parseLampBackgroundCleanupPlan(cleanupPlan);
  if (
    plan.approval.status !== "approved" ||
    plan.decision !== "exceptional-no-op"
  ) {
    throw new Error(
      "Lamp Background no-op presentation requires an approved exceptional no-op plan."
    );
  }
  return {
    version: 1,
    base: presentationBase(),
    lightingDirective:
      "No generation was authorized. Deliver the exact source video unchanged.",
    corrections: [],
    rendered: [
      "=== LAMP BACKGROUND APPROVED EXCEPTIONAL NO-OP ===",
      `Plan ID: ${plan.id}`,
      plan.noOpJustification?.summary ?? plan.sceneSummary,
      "The exact source video is the delivery. No generation or final AI evaluation was run.",
    ].join("\n"),
  };
}

function toViolation(
  plan: LampBackgroundCleanupPlan,
  result: LampBackgroundEvaluationArtifact["evalResults"][number],
  violation: LampBackgroundEvaluationArtifact["evalResults"][number]["violations"][number]
): Violation {
  const correction = violation.correction
    ? renderLampBackgroundCorrection(plan, {
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

export function lampBackgroundArtifactResultsForRun(
  artifact: LampBackgroundEvaluationArtifact,
  cleanupPlan: LampBackgroundCleanupPlan
): EvalResult[] {
  const plan = parseLampBackgroundCleanupPlan(cleanupPlan);
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

export function lampBackgroundCompositeForResults(
  results: EvalResult[]
): IterationComposite | undefined {
  const backgroundIds = new Set<string>(LAMP_BACKGROUND_EVAL_IDS);
  const seen = new Set<string>();
  for (const result of results) {
    if (!backgroundIds.has(result.evalId)) continue;
    if (seen.has(result.evalId)) return undefined;
    seen.add(result.evalId);
  }
  const ordered = LAMP_BACKGROUND_UI_EVAL_DEFS.map((definition) =>
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
    const definition = LAMP_BACKGROUND_UI_EVAL_DEFS[index];
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

export function isLampBackgroundEvaluationArtifact(
  value: unknown,
  iteration?: 1 | 2
): value is LampBackgroundEvaluationArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Partial<LampBackgroundEvaluationArtifact>;
  if (
    artifact.version !== LAMP_BACKGROUND_EVALUATOR_VERSION ||
    (artifact.iteration !== 1 && artifact.iteration !== 2) ||
    (iteration !== undefined && artifact.iteration !== iteration) ||
    typeof artifact.cleanupPlanId !== "string" ||
    artifact.cleanupPlanId.length === 0 ||
    !Array.isArray(artifact.evalResults) ||
    artifact.evalResults.length !== LAMP_BACKGROUND_EVAL_IDS.length ||
    typeof artifact.costUsd !== "number" ||
    !Number.isFinite(artifact.costUsd) ||
    artifact.costUsd < 0
  ) {
    return false;
  }
  const ids = artifact.evalResults.map((result) => result?.evalId);
  return (
    new Set(ids).size === LAMP_BACKGROUND_EVAL_IDS.length &&
    LAMP_BACKGROUND_EVAL_IDS.every((evalId) => ids.includes(evalId))
  );
}

export function projectLampBackgroundEvaluationForRead(input: {
  iteration: 1 | 2;
  artifact?: LampBackgroundEvaluationArtifact;
  cleanupPlan: LampBackgroundCleanupPlan;
  humanGradeSaved: boolean;
  hideFinalEvaluation?: boolean;
}): { evalResults: EvalResult[]; composite?: IterationComposite } {
  if (
    !input.artifact ||
    (input.iteration === 2 &&
      !input.humanGradeSaved &&
      input.hideFinalEvaluation === true)
  ) {
    return { evalResults: [] };
  }
  const evalResults = lampBackgroundArtifactResultsForRun(
    input.artifact,
    input.cleanupPlan
  );
  return {
    evalResults,
    composite: lampBackgroundCompositeForResults(evalResults),
  };
}

export function isLampBackgroundRun(
  run: Pick<Run, "workflowId" | "workflowMode" | "serverExecution">
): boolean {
  if (run.serverExecution?.executionId) {
    return run.serverExecution.executionId.startsWith("lamp-background:");
  }
  return (
    run.workflowMode === "background" ||
    run.workflowId === "lamp-background-v1"
  );
}
