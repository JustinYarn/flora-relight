import { EVAL_DEFS, getEvalDef } from "./prompts/eval-defs.ts";
import {
  initialMegaPrompt,
  nextMegaPrompt,
} from "./prompts/mega-prompt.ts";
import {
  isLampBeautifyRun,
  LAMP_BEAUTIFY_UI_EVAL_DEFS,
} from "./lamp-beautify-read.ts";
import {
  isLampBackgroundRun,
  LAMP_BACKGROUND_UI_EVAL_DEFS,
} from "./lamp-background-read.ts";
import type {
  Correction,
  EvalDefinition,
  EvalResult,
  GeminiProUsageSnapshot,
  IterationComposite,
  JudgeVerdict,
  MegaPrompt,
  Run,
  Verdict,
  Violation,
  ViolationSeverity,
} from "@/lib/types";
import { clamp, verdictFor } from "./util.ts";

/**
 * Lamp's complete evaluation and human-grading contract. This positive list is
 * intentionally independent from Flora's wider registry so a Flora-only check
 * cannot leak into Lamp as an empty or "not applicable" row.
 */
export const LAMP_EVAL_IDS = [
  "identity-preservation",
  "skin-texture-age",
  "appearance-fidelity",
  "background-fidelity",
  "lighting-quality-delta",
  "motion-lipsync",
  "temporal-stability",
  "hallucination-artifacts",
  "audio-integrity",
] as const;

const LAMP_SKIN_PROMPT = `Protocol: whole-video comparison across corresponding moments in the complete source and candidate.

ROLE
You are the skin-rendering examiner for Lamp's video relighting pipeline. The candidate may change illumination and color response. Judge whether the underlying skin still belongs to the same untreated person at the same apparent age, while allowing only extremely subtle cosmetic softening that is detectable through close A/B inspection rather than normal playback.

FACTOR OUT THE RELIGHT FIRST
Do not punish exposure, contrast, white balance, shadow placement, highlight placement, catchlights, or other plausible lighting effects. Brighter or lower-contrast skin, warmer or cooler tone, and texture that is fainter but still present are permitted. Judge the PRESENCE and POSITION of real structures after accounting for the new light, not whether every pore has identical contrast strength.

WHAT TO INSPECT
Across the full timeline, inspect the forehead, cheeks, nose, under-eyes, mouth area, chin, jaw, ears, neck, and hairline. Compare pores, fine lines, freckles, moles, scars, blemishes, facial hair, complexion variation, highlight roll-off, and apparent age. Marks and age cues must remain substantially present and correctly positioned. Skin must continue to look natural rather than plastic, waxy, foundation-like, or airbrushed.

ALLOWED SUBTLETY
Extremely subtle, localized beautification may pass only when it is detectable through deliberate close A/B inspection, does not read as a beauty filter at normal viewing size, preserves the person's marks and age cues, and does not create a perceptible age shift. This allowance is narrow: obvious smoothing, broad texture removal, cleanup of marks, plastic rendering, or visible de-aging fails.

NO ARTIFICIAL AGING
Never add age detail. Any wrinkle, crease, or age line that is not present at the corresponding source moment is a violation and must score below the borderline threshold after ruling out a shadow or contrast explanation. Use the exact violation aspect \`added_wrinkles\` whenever this occurs.

SCORING ANCHORS
- 95–100: No cosmetic alteration beyond lighting; real structures, marks, and age cues remain intact.
- 85–94 PASS: At most extremely subtle localized softening detectable only in close A/B inspection. Texture and marks remain substantially present, apparent age is unchanged, and no wrinkle or crease is added.
- 70–84 BORDERLINE: Localized texture thinning or softening is noticeable under deliberate comparison, but it is not an obvious beauty-filter or de-aging effect at normal playback. No wrinkle is added and there is no clear age shift.
- 0–69 FAIL: Obvious smoothing or airbrushing, broad pore/line or mark removal, plastic or waxy skin, perceptible de-aging, or any added wrinkle, crease, or age line.

Thresholds for this Lamp eval: pass ≥ 85, borderline ≥ 70, else fail.

CORRECTIONS
Write region-scoped restore/stop imperatives. For excessive smoothing, restore the source's natural structures and marks without sharpening or inventing detail. For artificial aging, remove the invented wrinkle or crease and restore the source's apparent age. Do not prescribe a new complexion or beauty treatment.`;

const LAMP_SKIN_OVERRIDE: Partial<EvalDefinition> = {
  description:
    "Preserves natural skin and apparent age; only extremely subtle close-inspection softening may pass, and added wrinkles never do.",
  passThreshold: 85,
  borderlineThreshold: 70,
  promptTemplate: LAMP_SKIN_PROMPT,
};

export const LAMP_EVAL_DEFS: EvalDefinition[] = LAMP_EVAL_IDS.map((evalId) => {
  const definition = getEvalDef(evalId);
  return evalId === "skin-texture-age"
    ? { ...definition, ...LAMP_SKIN_OVERRIDE }
    : definition;
});

export const LAMP_VISUAL_EVAL_DEFS = LAMP_EVAL_DEFS.filter(
  (definition) => definition.method !== "deterministic"
);

/** Strip Flora's sampled-frame envelope before a rubric enters Lamp's one video call. */
export function lampWholeVideoRubric(definition: EvalDefinition): string {
  return definition.promptTemplate
    .replace(
      /^Protocol:[^\n]*\n\n/m,
      "Protocol: compare both complete videos over their full timelines.\n\n"
    )
    .replace(
      /INPUTS\n[\s\S]*?Inspect the event-picked frames hardest — failures concentrate where motion and expression peak\.\n*/,
      ""
    )
    .replace(/\nOUTPUT\n[\s\S]*$/, "")
    .split("{{BEFORE_FRAMES}}")
    .join("the complete ORIGINAL video attached first")
    .split("{{AFTER_FRAMES}}")
    .join("the complete CANDIDATE video attached second")
    .split("index-locked pair")
    .join("corresponding moment")
    .split("frame-pair by frame-pair")
    .join("across corresponding moments")
    .split("event-picked frames")
    .join("challenging motion and speech moments");
}

export function getLampEvalDef(id: string): EvalDefinition {
  const definition = LAMP_EVAL_DEFS.find((candidate) => candidate.id === id);
  if (!definition) {
    throw new Error(
      `Unknown Lamp eval id "${id}". Known ids: ${LAMP_EVAL_IDS.join(", ")}`
    );
  }
  return definition;
}

type RunEvalScope = Pick<Run, "workflowId" | "workflowMode" | "serverExecution">;

/** Durable execution identity wins over browser-authored presentation fields. */
export function isLampRun(run: RunEvalScope): boolean {
  if (run.serverExecution?.executionId) {
    return run.serverExecution.executionId.startsWith("lamp:");
  }
  return run.workflowMode === "lamp" || run.workflowId === "lamp-v1";
}

export function evalDefsForRun(run: RunEvalScope): EvalDefinition[] {
  if (isLampBeautifyRun(run)) return LAMP_BEAUTIFY_UI_EVAL_DEFS;
  if (isLampBackgroundRun(run)) return LAMP_BACKGROUND_UI_EVAL_DEFS;
  return isLampRun(run) ? LAMP_EVAL_DEFS : EVAL_DEFS;
}

/** Resolve one display definition without falling back to Flora for a scoped run. */
export function evalDefForRun(
  run: RunEvalScope,
  evalId: string
): EvalDefinition | undefined {
  return evalDefsForRun(run).find((definition) => definition.id === evalId);
}

/**
 * Registry-wide lookup for surfaces that have a pipeline node but no Run.
 * Run-aware consumers should prefer evalDefForRun so shared ids retain their
 * method-specific wording and thresholds.
 */
export function evalDefForId(evalId: string): EvalDefinition | undefined {
  return (
    LAMP_BEAUTIFY_UI_EVAL_DEFS.find(
      (definition) => definition.id === evalId
    ) ??
    LAMP_BACKGROUND_UI_EVAL_DEFS.find(
      (definition) => definition.id === evalId
    ) ??
    LAMP_EVAL_DEFS.find((definition) => definition.id === evalId) ??
    EVAL_DEFS.find((definition) => definition.id === evalId)
  );
}

export const LAMP_EVALUATOR_VERSION = "lamp-holistic-v2";
export const LAMP_LEGACY_EVALUATOR_VERSION = "lamp-holistic-v1";
export const LAMP_MAX_ITERATIONS = 2;
export const LAMP_COMPOSITE_PASS_THRESHOLD = 75;

/**
 * Build Lamp's aggregate only when every Lamp check is present exactly once.
 * The score is normalized over Lamp's weights; Flora-only checks never enter
 * the calculation.
 */
export function lampCompositeForResults(
  results: EvalResult[]
): IterationComposite | undefined {
  // Duplicate detection must run on the RAW rows: normalization dedupes via
  // find(), so a corrupted artifact with two rows for one check would
  // otherwise silently score from whichever came first.
  const lampIds = new Set(LAMP_EVAL_DEFS.map((definition) => definition.id));
  const seen = new Set<string>();
  for (const result of results) {
    if (!lampIds.has(result.evalId)) continue;
    if (seen.has(result.evalId)) return undefined;
    seen.add(result.evalId);
  }
  const normalizedResults = normalizeLampResultsForCurrentPolicy(results);
  const applicable = LAMP_EVAL_DEFS.map((definition) => {
    const matches = normalizedResults.filter(
      (result) => result.evalId === definition.id
    );
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
    const definition = getLampEvalDef(result.evalId);
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
 * Final AI evidence is visible on ordinary reads as soon as it is saved. The
 * Grade workspace may explicitly request a blind projection for an ungraded
 * Final, then reveal the same saved artifact without starting provider work.
 * Initial evidence always remains available to drive and inspect correction.
 */
export function projectLampEvaluationForRead(input: {
  iteration: 1 | 2;
  artifact?: LampEvaluationArtifact;
  humanGradeSaved: boolean;
  /** Grade-only read policy; ordinary Runs and Journey reads leave this false. */
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
  const evalResults = normalizeLampResultsForCurrentPolicy(
    input.artifact.evalResults
  );
  return {
    evalResults,
    composite: lampCompositeForResults(evalResults),
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
  version:
    | typeof LAMP_EVALUATOR_VERSION
    | typeof LAMP_LEGACY_EVALUATOR_VERSION;
  iteration: number;
  evalResults: EvalResult[];
  /** Exact token counters returned by GenerateContent (legacy v1 may omit). */
  usage?: GeminiProUsageSnapshot;
  /** Usage-derived provider charge recorded by the paid-operation journal. */
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

function isAddedWrinkleViolation(violation: Violation): boolean {
  const aspect = violation.aspect
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
  const describesAgeDetail =
    /\bwrinkles?\b/.test(aspect) ||
    /\bcreases?\b/.test(aspect) ||
    /\bage lines?\b/.test(aspect);
  const describesAddition = /\b(added|new|invented|artificial|extra)\b/.test(
    aspect
  );
  return aspect.includes("artificial aging") ||
    (describesAgeDetail && describesAddition);
}

/**
 * Read old Lamp artifacts through today's nine-check policy without changing
 * their provider score or reasoning. Retired Flora-only rows are removed, and
 * deterministic verdict labels are recalculated from the active thresholds.
 *
 * POLICY (Justin, 2026-07-16): this re-grading of history is deliberate.
 * Every artifact — regardless of the thresholds its judge was prompted
 * with — is presented under the CURRENT rules, so verdicts stay comparable
 * across the whole library after a policy change. Pinned by test
 * "historical artifacts re-verdict under the current thresholds".
 */
export function normalizeLampResultsForCurrentPolicy(
  results: EvalResult[]
): EvalResult[] {
  return LAMP_EVAL_DEFS.flatMap((definition): EvalResult[] => {
    const result = results.find((candidate) => candidate.evalId === definition.id);
    if (!result) return [];
    let score = clamp(result.score, 0, 100);
    if (
      definition.id === "skin-texture-age" &&
      result.violations.some(isAddedWrinkleViolation)
    ) {
      score = Math.min(score, definition.borderlineThreshold - 1);
    }
    const verdict = verdictFor(
      score,
      definition.passThreshold,
      definition.borderlineThreshold
    );
    const scoreChanged = score !== result.score;
    const { deltaFromPrevious, ...stable } = result;
    return [
      {
        ...stable,
        score,
        verdict,
        verdicts: result.verdicts.map((judgeVerdict) => ({
          ...judgeVerdict,
          score,
          verdict,
        })),
        ...(!scoreChanged && deltaFromPrevious !== undefined
          ? { deltaFromPrevious }
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
  let score = clamp(rawScore, 0, 100);
  const confidence = clamp(
    typeof value.confidence === "number"
      ? value.confidence
      : Number(value.confidence),
    0,
    1
  );
  if (!Number.isFinite(confidence)) return null;
  const violations = coerceViolations(value.violations);
  if (
    definition.id === "skin-texture-age" &&
    violations.some(isAddedWrinkleViolation)
  ) {
    // Lamp's approved skin contract makes invented age detail an unconditional
    // fail. The server caps a self-inconsistent model score instead of allowing
    // a reported added wrinkle to pass through as borderline or pass.
    score = Math.min(score, definition.borderlineThreshold - 1);
  }
  const verdict = verdictFor(
    score,
    definition.passThreshold,
    definition.borderlineThreshold
  );
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
  const definition = getLampEvalDef("audio-integrity");
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
  usage: GeminiProUsageSnapshot;
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
  // A non-passing check with zero violations is a valid judge outcome (a low
  // score whose cause the model could not localize), not a malformed response.
  // The correction compiler reads only violations — nextMegaPrompt skips
  // entries with nothing usable to compile and renderPersistedLampV2 renders
  // an explicit "(none — …)" block for an empty ledger — so the artifact is
  // accepted as-is: the check stays recorded as fail/borderline with its
  // reasoning, the Final generation still runs, and the human grades blind.
  // Rejecting it here would crash a billed run after the provider call.
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
    usage: input.usage,
    costUsd: input.costUsd,
  };
}

export function isLampEvaluationArtifact(
  value: unknown,
  iteration?: number
): value is LampEvaluationArtifact {
  if (!isRecord(value)) return false;
  const usageValid =
    isRecord(value.usage) &&
    Number.isSafeInteger(value.usage.promptTokenCount) &&
    Number.isSafeInteger(value.usage.candidatesTokenCount);
  if (
    (value.version !== LAMP_EVALUATOR_VERSION &&
      value.version !== LAMP_LEGACY_EVALUATOR_VERSION) ||
    !Number.isSafeInteger(value.iteration) ||
    !Array.isArray(value.evalResults) ||
    (value.version === LAMP_EVALUATOR_VERSION && !usageValid) ||
    (value.usage !== undefined && !usageValid) ||
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
      (result) =>
        LAMP_VISUAL_EVAL_DEFS.some(
          (definition) => definition.id === result.evalId
        )
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
