import { EVAL_DEFS, getEvalDef } from "./prompts/eval-defs.ts";
import {
  initialMegaPrompt,
  nextMegaPrompt,
} from "./prompts/mega-prompt.ts";
import type {
  Correction,
  EvalResult,
  IterationComposite,
  JudgeVerdict,
  MegaPrompt,
  Verdict,
  Violation,
  ViolationSeverity,
} from "@/lib/types";
import { clamp, verdictFor } from "./util.ts";

/**
 * Lamp deliberately evaluates only checks it can truthfully perform in one
 * whole-video pass. Temporal alignment still lacks its documented local
 * correlation metric, and anchor matching is inapplicable because Lamp has no
 * Look Anchor stage. Human grading keeps all 11 rows so those gaps remain
 * visible instead of being manufactured as passes.
 */
export const LAMP_VISUAL_EVAL_DEFS = EVAL_DEFS.filter(
  (definition) =>
    definition.method !== "deterministic" &&
    definition.id !== "lighting-match-to-anchor"
);

export const LAMP_UNAVAILABLE_EVAL_IDS = [
  "temporal-alignment",
  "lighting-match-to-anchor",
] as const;

export const LAMP_EVALUATOR_VERSION = "lamp-holistic-v1";
export const LAMP_MAX_ITERATIONS = 2;
export const LAMP_COMPOSITE_PASS_THRESHOLD = 75;

const LAMP_APPLICABLE_EVAL_IDS = [
  ...LAMP_VISUAL_EVAL_DEFS.map((definition) => definition.id),
  "audio-integrity",
] as const;

/**
 * Build Lamp's aggregate only when every applicable check is present exactly
 * once. The score is normalized over the applicable weights, so unavailable
 * temporal alignment and inapplicable anchor matching are never fabricated or
 * silently counted as passes.
 */
export function lampCompositeForResults(
  results: EvalResult[]
): IterationComposite | undefined {
  const applicable = LAMP_APPLICABLE_EVAL_IDS.map((evalId) => {
    const matches = results.filter((result) => result.evalId === evalId);
    return matches.length === 1 ? matches[0] : undefined;
  });
  if (
    applicable.some(
      (result) =>
        result === undefined ||
        !Number.isFinite(result.score) ||
        !["pass", "borderline", "fail"].includes(result.verdict)
    )
  ) {
    return undefined;
  }

  let weightedScore = 0;
  let totalWeight = 0;
  const hardGateFailures: string[] = [];
  for (const result of applicable as EvalResult[]) {
    const definition = getEvalDef(result.evalId);
    weightedScore += definition.weight * result.score;
    totalWeight += definition.weight;
    if (definition.hardGate && result.verdict !== "pass") {
      hardGateFailures.push(result.evalId);
    }
  }
  const score =
    Math.round((totalWeight > 0 ? weightedScore / totalWeight : 0) * 10) / 10;
  return {
    score,
    passed:
      score >= LAMP_COMPOSITE_PASS_THRESHOLD && hardGateFailures.length === 0,
    hardGateFailures,
  };
}

/**
 * Final AI evidence stays sealed on ordinary reads until the human grade is
 * durably saved. The Grade workspace may explicitly reveal the already-saved
 * artifact; that opt-in read never starts or retries provider work. Initial
 * evidence remains available to drive and inspect the correction pass.
 * Returning an empty projection also overwrites any stale browser-authored copy.
 */
export function projectLampEvaluationForRead(input: {
  iteration: 1 | 2;
  artifact?: LampEvaluationArtifact;
  humanGradeSaved: boolean;
  /** Explicit, read-only reveal requested from the exact-run Grade surface. */
  revealFinalEvaluation?: boolean;
}): { evalResults: EvalResult[]; composite?: IterationComposite } {
  if (
    !input.artifact ||
    (input.iteration === 2 &&
      !input.humanGradeSaved &&
      input.revealFinalEvaluation !== true)
  ) {
    return { evalResults: [] };
  }
  return {
    evalResults: input.artifact.evalResults,
    composite: lampCompositeForResults(input.artifact.evalResults),
  };
}

export function lampEvaluationOperationId(iteration: number): string {
  return `judge:${iteration}:lamp-holistic:gemini`;
}

export interface LampModelEval {
  evalId: string;
  score: number;
  confidence: number;
  verdict?: Verdict;
  violations: Violation[];
  reasoning: string;
}

export interface LampEvaluationArtifact {
  version: typeof LAMP_EVALUATOR_VERSION;
  iteration: number;
  evalResults: EvalResult[];
  /** Fixed provider estimate recorded by the paid-operation journal. */
  costUsd: number;
}

const SEVERITIES: ViolationSeverity[] = ["critical", "major", "minor"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceViolations(value: unknown): Violation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Violation[] => {
    if (!isRecord(item)) return [];
    if (
      typeof item.aspect !== "string" ||
      item.aspect.trim().length === 0 ||
      typeof item.correction !== "string" ||
      item.correction.trim().length === 0
    ) {
      return [];
    }
    return [
      {
        aspect: item.aspect.trim(),
        severity: SEVERITIES.includes(item.severity as ViolationSeverity)
          ? (item.severity as ViolationSeverity)
          : "major",
        description:
          typeof item.description === "string" ? item.description.trim() : "",
        correction: item.correction.trim(),
        ...(typeof item.frameTimestampSec === "number" &&
        Number.isFinite(item.frameTimestampSec)
          ? { frameTimestampSec: item.frameTimestampSec }
          : {}),
      },
    ];
  });
}

function coerceModelEval(
  value: unknown,
  iteration: number,
  previousResults: EvalResult[]
): EvalResult | null {
  if (!isRecord(value) || typeof value.evalId !== "string") return null;
  const definition = LAMP_VISUAL_EVAL_DEFS.find(
    (candidate) => candidate.id === value.evalId
  );
  if (!definition) return null;

  const rawScore =
    typeof value.score === "number" ? value.score : Number(value.score);
  if (!Number.isFinite(rawScore)) return null;
  const score = clamp(rawScore, 0, 100);
  const confidence = clamp(
    typeof value.confidence === "number"
      ? value.confidence
      : Number(value.confidence),
    0,
    1
  );
  if (!Number.isFinite(confidence)) return null;
  const verdict = verdictFor(
    score,
    definition.passThreshold,
    definition.borderlineThreshold
  );
  const violations = coerceViolations(value.violations);
  const judgeVerdict: JudgeVerdict = {
    judge: "gemini",
    score,
    verdict,
    violations,
    reasoning: typeof value.reasoning === "string" ? value.reasoning.trim() : "",
  };
  const previous = previousResults.find((result) => result.evalId === definition.id);
  return {
    evalId: definition.id,
    iteration,
    verdicts: [judgeVerdict],
    score,
    confidence,
    verdict,
    violations,
    ...(previous ? { deltaFromPrevious: score - previous.score } : {}),
  };
}

function audioIntegrityResult(
  iteration: number,
  audioVerified: boolean,
  previousResults: EvalResult[]
): EvalResult {
  const definition = getEvalDef("audio-integrity");
  const score = audioVerified ? 100 : 0;
  const previous = previousResults.find(
    (result) => result.evalId === definition.id
  );
  return {
    evalId: definition.id,
    iteration,
    verdicts: [],
    score,
    confidence: 1,
    verdict: audioVerified ? "pass" : "fail",
    violations: audioVerified
      ? []
      : [
          {
            aspect: "original audio integrity",
            severity: "critical",
            description:
              "The finalized cut did not pass the server's original-audio verification.",
            correction:
              "Do not deliver this artifact; discard provider sound, restore or preserve source silence during finalization, and verify the complete canonical source-audio timeline.",
          },
        ],
    ...(previous ? { deltaFromPrevious: score - previous.score } : {}),
  };
}

/**
 * Convert the provider's one-shot response into canonical per-eval results.
 * Every applicable visual id must appear exactly once. A partial response is
 * rejected instead of silently turning missing checks into passes.
 */
export function buildLampEvaluationArtifact(input: {
  raw: unknown;
  iteration: number;
  audioVerified: boolean;
  previousResults?: EvalResult[];
  costUsd: number;
}): LampEvaluationArtifact {
  if (
    !Number.isSafeInteger(input.iteration) ||
    input.iteration < 1 ||
    input.iteration > LAMP_MAX_ITERATIONS
  ) {
    throw new Error("Lamp evaluation iteration must be 1 or 2.");
  }
  if (!isRecord(input.raw) || !Array.isArray(input.raw.results)) {
    throw new Error("Lamp evaluator returned an invalid result envelope.");
  }
  const previousResults = input.previousResults ?? [];
  const results = input.raw.results
    .map((value) => coerceModelEval(value, input.iteration, previousResults))
    .filter((value): value is EvalResult => value !== null);
  const byId = new Map<string, EvalResult>();
  for (const result of results) {
    if (byId.has(result.evalId)) {
      throw new Error(`Lamp evaluator returned duplicate result ${result.evalId}.`);
    }
    byId.set(result.evalId, result);
  }
  const missing = LAMP_VISUAL_EVAL_DEFS.filter(
    (definition) => !byId.has(definition.id)
  );
  if (missing.length > 0 || byId.size !== LAMP_VISUAL_EVAL_DEFS.length) {
    throw new Error(
      `Lamp evaluator omitted required checks: ${missing
        .map((definition) => definition.id)
      .join(", ") || "unknown result"}.`
    );
  }
  const unactionable = Array.from(byId.values()).filter(
    (result) => result.verdict !== "pass" && result.violations.length === 0
  );
  if (unactionable.length > 0) {
    throw new Error(
      `Lamp evaluator returned non-passing checks without actionable corrections: ${unactionable
        .map((result) => result.evalId)
        .join(", ")}.`
    );
  }
  const ordered = LAMP_VISUAL_EVAL_DEFS.map(
    (definition) => byId.get(definition.id)!
  );
  ordered.push(
    audioIntegrityResult(
      input.iteration,
      input.audioVerified,
      previousResults
    )
  );
  return {
    version: LAMP_EVALUATOR_VERSION,
    iteration: input.iteration,
    evalResults: ordered,
    costUsd: input.costUsd,
  };
}

export function isLampEvaluationArtifact(
  value: unknown,
  iteration?: number
): value is LampEvaluationArtifact {
  if (!isRecord(value)) return false;
  if (
    value.version !== LAMP_EVALUATOR_VERSION ||
    !Number.isSafeInteger(value.iteration) ||
    !Array.isArray(value.evalResults) ||
    typeof value.costUsd !== "number" ||
    !Number.isFinite(value.costUsd)
  ) {
    return false;
  }
  return iteration === undefined || value.iteration === iteration;
}

const LAMP_V1_HEADER = "=== LAMP RELIGHT MEGA PROMPT v1 ===";
const LAMP_V2_HEADER = "=== LAMP RELIGHT MEGA PROMPT v2 ===";
const ACTIVE_CORRECTIONS_HEADING =
  "[ACTIVE CORRECTIONS FROM EVALUATION]";
const NEVER_DO_HEADING = "[NEVER DO]";

/**
 * Replace only the version header and active-corrections body in the exact
 * persisted v1 bytes. Everything else remains byte-for-byte bound to the
 * RunExecution created before a later deploy can change the current template.
 */
function renderPersistedLampV2(
  persistedV1: string,
  corrections: Correction[]
): string {
  if (!persistedV1.startsWith(LAMP_V1_HEADER)) {
    throw new Error("Lamp's persisted initial prompt has an invalid v1 header.");
  }
  const headingIndex = persistedV1.indexOf(ACTIVE_CORRECTIONS_HEADING);
  if (headingIndex < 0) {
    throw new Error(
      "Lamp's persisted initial prompt has no active-corrections section."
    );
  }
  const headingEnd = headingIndex + ACTIVE_CORRECTIONS_HEADING.length;
  const eol = persistedV1.startsWith("\r\n", headingEnd)
    ? "\r\n"
    : persistedV1.startsWith("\n", headingEnd)
      ? "\n"
      : null;
  if (!eol) {
    throw new Error(
      "Lamp's persisted initial prompt has an invalid corrections boundary."
    );
  }
  const correctionsStart = headingEnd + eol.length;
  const neverDoBoundary = `${eol}${eol}${NEVER_DO_HEADING}`;
  const correctionsEnd = persistedV1.indexOf(
    neverDoBoundary,
    correctionsStart
  );
  if (correctionsEnd < 0) {
    throw new Error("Lamp's persisted initial prompt has no NEVER DO section.");
  }

  const active = corrections.filter((correction) => !correction.resolved);
  const correctionsBlock =
    active.length === 0
      ? "(none — first iteration or all prior findings resolved)"
      : active
          .map(
            (correction, index) =>
              `${index + 1}. [${correction.severity.toUpperCase()}] ${correction.instruction
                .replace(/\r?\n/g, eol)
                .trim()}`
          )
          .join(eol);
  const withV2Header =
    LAMP_V2_HEADER + persistedV1.slice(LAMP_V1_HEADER.length);
  return (
    withV2Header.slice(0, correctionsStart) +
    correctionsBlock +
    withV2Header.slice(correctionsEnd)
  );
}

/**
 * First-pass findings become the one and only corrected Lamp prompt.
 *
 * The provider-facing rendered bytes depend only on the exact persisted v1
 * prompt and canonical evaluation findings. The structured MegaPrompt fields
 * retain the existing correction-ledger shape for UI presentation, but a later
 * base/template deploy can never rewrite the already-bound provider input.
 */
export function compileLampFinalPrompt(
  persistedInitialRendered: string,
  firstEvaluation: LampEvaluationArtifact
): MegaPrompt {
  if (firstEvaluation.iteration !== 1) {
    throw new Error("Lamp final prompt must be compiled from iteration 1.");
  }
  if (
    typeof persistedInitialRendered !== "string" ||
    persistedInitialRendered.length === 0
  ) {
    throw new Error("Lamp final prompt requires the persisted initial bytes.");
  }
  const presentationSeed = initialMegaPrompt("lamp");
  const finalPrompt = nextMegaPrompt(
    presentationSeed,
    firstEvaluation.evalResults.filter(
      (result) => result.evalId !== "audio-integrity"
    )
  );
  return {
    ...finalPrompt,
    rendered: renderPersistedLampV2(
      persistedInitialRendered,
      finalPrompt.corrections
    ),
  };
}
