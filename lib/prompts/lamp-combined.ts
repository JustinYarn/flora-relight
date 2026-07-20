/**
 * Lamp Combined's frozen prompt-product contract.
 *
 * This compiler deliberately does not compose the four legacy prompts. It
 * renders one plan-bound instruction set in which every mutable pixel region
 * has exactly one owner. Both passes condition on the original source video;
 * pass two patches only the corrections slot in the persisted pass-one bytes.
 */

import {
  hashLampCombinedPlan,
  LAMP_COMBINED_CLEANLINESS_PROFILES,
  lampCombinedEnabledConcerns,
  parseLampCombinedPlan,
  parseLampCombinedRelightIntensity,
  type LampCombinedPlan,
} from "../lamp-combined.ts";
import {
  collectLampCombinedCorrections,
  type LampCombinedCompiledCorrection,
  type LampCombinedEvaluationArtifact,
} from "../lamp-combined-evaluation.ts";
import type { LampBackgroundPlanItem } from "../lamp-background.ts";
import type { LampBeautifyEnhanceItem } from "../lamp-beautify.ts";
import type { LampIrisCorrectItem } from "../lamp-iris.ts";
import {
  isRelightIntensity,
  relightLightingDirective,
  relightNegativeBlock,
} from "../relight-intensity.ts";

/**
 * Day-one lineage. These bytes are a persistence contract: never edit these
 * constants after a real run has stored a prompt compiled from them. A future
 * prompt is a new lineage with a new compiler, never an in-place rewrite.
 */
export const LAMP_COMBINED_PROMPT_LINEAGE =
  "lamp-combined-mega-prompt-v1" as const;
export const LAMP_COMBINED_V1_HEADER =
  "=== LAMP COMBINED MEGA PROMPT v1 ===" as const;
export const LAMP_COMBINED_V1_PLAN_HEADING =
  "[EXACT HUMAN-APPROVED AGGREGATE PLAN]" as const;
export const LAMP_COMBINED_V1_OWNERSHIP_HEADING =
  "[UNIFIED REGION-OWNERSHIP LOCK MATRIX]" as const;
export const LAMP_COMBINED_V1_CORRECTIONS_HEADING =
  "[ACTIVE CORRECTIONS FROM EVALUATION]" as const;
export const LAMP_COMBINED_V1_NEVER_DO_HEADING = "[NEVER DO]" as const;

const INITIAL_CORRECTIONS_BODY = [
  "INITIAL PASS — no candidate-specific evaluation has run yet.",
  "Execute the approved aggregate plan completely on the ORIGINAL source video. Do not invent a correction, target, region, object, person, or creative goal.",
].join("\n");

/** Frozen v1 instructions outside the plan, lighting recipe, and corrections. */
export const LAMP_COMBINED_V1_TASK = [
  "Create one source-faithful, presentation-ready edit of this exact ORIGINAL source video.",
  "This is one Combined generation product, not a chain of Relight, Background, Beautify, and Iris outputs.",
  "Apply the separately bound lighting recipe, the exact approved background cleanup plan, and only the enabled approved presenter treatments in one coherent render.",
  "The original video remains identity, geometry, performance, timing, camera, and scene ground truth for both Initial and Final.",
  "If this is Final, start again from the ORIGINAL source video and use the correction ledger only as additional steering; never use Initial pixels, audio, frames, or a previous generated video as input.",
].join(" ");

/**
 * The overlap rule is explicit: Beautify may change eye-area surface
 * presentation, while Iris alone owns direction, pupil/iris placement, and
 * the minimum lid pose implied by that direction. Neither owns blink timing.
 */
export const LAMP_COMBINED_V1_REGION_OWNERSHIP_LOCK_MATRIX = [
  "LIGHTING OWNER — may change illumination over the whole frame only: light direction, intensity, falloff, exposure response, contrast, color temperature, catchlight response, and source-plausible subject/background separation, exactly at the separately bound relight strength. It owns no object, anatomy, identity, performance, camera, or timing change.",
  "BACKGROUND OWNER — may remove only the human-approved REMOVE target footprints and reconstruct only the pixels those targets covered. It owns no person, interacted object, protected or uncertain region, unlisted object, architecture redesign, replacement decor, or wider cleanup.",
  "BEAUTIFY OWNER — when enabled, may change only approved presentation categories inside four primary-presenter zones: expression muscles without changing speech articulation or beat timing; skin surface appearance without changing geometry, marks, or age; under-eye surface appearance; and eye-area clarity without changing anatomy, gaze, pupils, irises, eyelid pose, or blink timing. It owns no other person and no hair, teeth, wardrobe, body, background, lighting recipe, or camera change.",
  "IRIS OWNER — when enabled, may change only the primary presenter's gaze direction, pupil/iris orientation, and the minimum eyelid pose physically implied by that direction, at approved moments and intensity. It owns no blink timing, brow performance, expression, head pose, mouth, facial geometry, eye anatomy or color, skin treatment, other person, lighting, background, or camera change.",
  "OVERLAP PRECEDENCE — Iris owns gaze direction and direction-implied eyelid pose; Beautify owns only approved eye-area surface clarity. Lighting may change how every source surface is illuminated but may not alter what that surface is. Background reconstruction stops at every person and interacted-object boundary.",
  "EVERYTHING ELSE — hard locked to the corresponding ORIGINAL source moment: identity and recognizable anatomy; facial geometry and permanent marks; apparent age; every other visible person; hair and facial hair; teeth; wardrobe, patterns, accessories, body shape, held/touched/used objects; gestures, posture, head and body trajectories, expression beats, blinks, mouth shapes and lip-sync; architecture and all unlisted scene content; camera position and motion, lens, perspective, focus, depth of field, crop, framing, resolution and cadence; duration, event timing, and source audio.",
].join("\n");

export const LAMP_COMBINED_V1_APPLICATION_STANDARD = [
  "Solve all enabled edits together so boundaries remain coherent through the complete timeline.",
  "Keep the primary presenter's identity and performance recognizable at every corresponding moment, including speech, motion, occlusions, and frame edges.",
  "A requested edit must be plainly complete at normal playback size, but strength never widens region ownership or authorization.",
  "Reconstruction and facial edits must remain temporally stable: no popping, flicker, crawling texture, shifting seams, halos, smears, melting geometry, frozen eyes, or inconsistent occlusion handling.",
  "Treat every disabled concern as a preservation-only hard gate, not as permission to approximate or improve it.",
  "Provider sound is disposable. Preserve performance timing visually; canonical source audio is restored and verified outside generation.",
].join(" ");

/** The first two prefixes intentionally participate in relight band scoping. */
export const LAMP_COMBINED_V1_NEGATIVE_BASE = [
  "No globally flat exposure lift when the requested lighting profile calls for direction, modelling, or subject-background separation.",
  "Do not apply any stylistic look that exceeds the requested lighting profile or changes the source into a different visual world.",
  "Do not change, add, remove, replace, restyle, or redesign any object outside the exact approved background REMOVE footprints.",
  "Do not add a person, remove a person, change who anyone is, reconstruct a face, change facial geometry, remove permanent marks, or change apparent age.",
  "Do not alter hair, facial hair, teeth, body shape, wardrobe, garment colors or patterns, accessories, or anything held, touched, worn, or actively used.",
  "Do not retime, reanimate, stabilize, smooth, exaggerate, or replace the performance; preserve gestures, posture, head motion, blinks, mouth shapes, and frame-accurate lip-sync.",
  "Do not reframe, crop, zoom, change camera or lens character, alter perspective, add background blur, change depth of field, sharpen, denoise, or change duration or frame cadence.",
  "Do not add text, captions, logos, watermarks, graphics, visible masks, replacement decor, or hallucinated detail.",
  "Do not generate replacement audio or reinterpret the performance from sound.",
] as const;

export type LampCombinedPromptCorrectionCandidate =
  LampCombinedCompiledCorrection;

export interface LampCombinedMegaPrompt {
  lineage: typeof LAMP_COMBINED_PROMPT_LINEAGE;
  iteration: 1 | 2;
  aggregatePlanId: string;
  aggregatePlanHash: string;
  relightIntensity: number;
  corrections: LampCombinedPromptCorrectionCandidate[];
  rendered: string;
}

function assertApprovedAggregatePlan(plan: LampCombinedPlan): LampCombinedPlan {
  const canonical = parseLampCombinedPlan(plan);
  if (canonical.approval.status !== "approved") {
    throw new Error(
      "Lamp Combined generation requires one explicit human approval of the aggregate plan."
    );
  }
  return canonical;
}

function assertPromptRelightIntensity(value: unknown): number {
  const canonical = parseLampCombinedRelightIntensity(value);
  if (!isRelightIntensity(canonical)) {
    throw new Error(
      "Lamp Combined prompt intensity must use the canonical 5-point relight slider step."
    );
  }
  return canonical;
}

function renderBackgroundRemoval(item: LampBackgroundPlanItem): string {
  return `[${item.id}] ${item.label} — ${item.location}. ${item.rationale} Visibility: ${item.temporalVisibility}.`;
}

function renderProtectedBackground(item: LampBackgroundPlanItem): string {
  return `[${item.id}] protected source region — ${item.location}: preserve exactly what the source shows; do not reinterpret, replace, upgrade, or restyle it. Visibility: ${item.temporalVisibility}.`;
}

function renderBackgroundPlan(plan: LampCombinedPlan): string {
  const background = plan.backgroundPlan;
  const profile =
    LAMP_COMBINED_CLEANLINESS_PROFILES[plan.controls.cleanlinessLevel];
  const remove =
    background.remove.length === 0
      ? "- (none — background is preservation-only)"
      : background.remove
          .map((item) => `- ${renderBackgroundRemoval(item)}`)
          .join("\n");
  const preserve =
    background.preserve.length === 0
      ? "- (no named regions; every unlisted source region is still protected)"
      : background.preserve
          .map((item) => `- ${renderProtectedBackground(item)}`)
          .join("\n");
  const uncertain =
    background.uncertain.length === 0
      ? "- (none)"
      : background.uncertain
          .map(
            (item) =>
              `- ${renderProtectedBackground(item)} Safe default: PRESERVE; never promote this to a removal target.`
          )
          .join("\n");
  return [
    `Background subplan ID: ${background.id}`,
    `Decision: ${background.decision.toUpperCase()}`,
    `Scene: ${background.sceneSummary}`,
    `Cleanliness control: ${plan.controls.cleanlinessLevel}/3 — ${profile.label}.`,
    `Execution amplitude: ${profile.executionDirective}`,
    `Scope fence: ${profile.scopeRule} Cleanliness may never add a target, merge neighboring objects into a target, empty the room, or redecorate.`,
    "",
    "REMOVE — the complete and exclusive target set:",
    remove,
    "",
    "PRESERVE — location-only protected regions:",
    preserve,
    "",
    "UNCERTAIN — preservation-only regions:",
    uncertain,
    "",
    "BACKGROUND DEFAULT: every person and every pixel not explicitly listed under REMOVE is protected.",
  ].join("\n");
}

function renderBeautifyItem(item: LampBeautifyEnhanceItem): string {
  return `[${item.id}] intensity ${item.intensity}/3. Why: ${item.rationale} Source evidence: ${item.evidence}`;
}

function renderBeautifyPlan(plan: LampCombinedPlan): string {
  if (plan.beautify.state === "disabled") {
    return [
      "BEAUTIFY: DISABLED by the approved aggregate control.",
      "All facial presentation zones are preservation-only hard gates. Do not beautify, retouch, smooth, de-age, restyle, or improve any person.",
    ].join("\n");
  }
  const beautify = plan.beautify.plan;
  if (beautify.decision !== "enhance" || beautify.enhance.length === 0) {
    return [
      `Beautify subplan ID: ${beautify.id}`,
      `BEAUTIFY: ENABLED, decision ${beautify.decision.toUpperCase()}.`,
      "No facial category is authorized. All facial presentation zones are preservation-only hard gates.",
    ].join("\n");
  }
  return [
    `Beautify subplan ID: ${beautify.id}`,
    `Subject: ${beautify.subjectSummary}`,
    `BEAUTIFY: ENABLED at aggregate level ${plan.controls.beautifyLevel}/3.`,
    "ENHANCE — apply only these approved categories inside their owned primary-presenter zones:",
    ...beautify.enhance.map((item) => `- ${renderBeautifyItem(item)}`),
    "BEAUTIFY DEFAULT: declined, uncertain, legacy, and unlisted categories; every other person; and every region outside those approved facial zones are preservation-only.",
  ].join("\n");
}

function renderIrisItem(item: LampIrisCorrectItem): string {
  return `[${item.id}] Presenter intensity ${item.intensity}/3. Why: ${item.rationale} Source evidence: ${item.evidence}`;
}

function renderIrisPlan(plan: LampCombinedPlan): string {
  if (plan.iris.state === "disabled") {
    return [
      "EYE CONTACT: DISABLED by the approved aggregate control.",
      "Gaze direction, pupils, irises, eyelid pose, blinks, and eye motion are preservation-only hard gates for every person.",
    ].join("\n");
  }
  const iris = plan.iris.plan;
  if (iris.decision !== "correct" || iris.correct.length === 0) {
    return [
      `Iris subplan ID: ${iris.id}`,
      `EYE CONTACT: ENABLED, decision ${iris.decision.toUpperCase()}.`,
      "No gaze category is authorized. Gaze and eyelids remain preservation-only hard gates.",
    ].join("\n");
  }
  return [
    `Iris subplan ID: ${iris.id}`,
    `Subject and observed gaze: ${iris.subjectSummary}`,
    `EYE CONTACT: ENABLED at fixed Presenter intensity ${plan.iris.intensity}/3.`,
    "CORRECT — apply only these approved gaze categories inside the Iris-owned primary-presenter eye region:",
    ...iris.correct.map((item) => `- ${renderIrisItem(item)}`),
    "IRIS DEFAULT: declined, uncertain, and unlisted gaze categories; every blink; all non-directional eye anatomy; and every other person's eyes are preservation-only.",
  ].join("\n");
}

export function renderLampCombinedV1PlanBlock(
  plan: LampCombinedPlan,
  aggregatePlanHash: string
): string {
  const canonical = assertApprovedAggregatePlan(plan);
  if (!/^[a-f0-9]{64}$/.test(aggregatePlanHash)) {
    throw new Error("Lamp Combined aggregate plan hash must be a SHA-256 hex digest.");
  }
  const approvedAt =
    canonical.approval.status === "approved"
      ? canonical.approval.approvedAt
      : /* istanbul ignore next -- narrowed by assertion above */ 0;
  return [
    `Aggregate plan version: ${canonical.version}`,
    `Aggregate plan ID: ${canonical.id}`,
    `Aggregate plan SHA-256: ${aggregatePlanHash}`,
    `Run binding: ${canonical.runId}`,
    `One human approval timestamp: ${approvedAt}`,
    `Controls: beautify=${canonical.controls.beautifyLevel}/3; cleanliness=${canonical.controls.cleanlinessLevel}/3; eyeContact=${canonical.controls.eyeContact ? "on" : "off"}.`,
    "",
    "BACKGROUND CONCERN",
    renderBackgroundPlan(canonical),
    "",
    "BEAUTIFY CONCERN",
    renderBeautifyPlan(canonical),
    "",
    "IRIS / EYE-CONTACT CONCERN",
    renderIrisPlan(canonical),
  ].join("\n");
}

function renderCorrections(
  corrections: readonly LampCombinedPromptCorrectionCandidate[]
): string {
  if (corrections.length === 0) {
    return "FINAL PASS — evaluation found no candidate-specific visual correction. Re-execute the unchanged approved contract from the ORIGINAL source; do not invent a new target or increase any strength.";
  }
  return [
    "FINAL PASS — start again from the ORIGINAL source. Apply only this deterministic correction ledger; it cannot widen the approved plan, enabled concerns, owned regions, or requested strengths:",
    ...corrections.map(
      (correction, index) =>
        `${index + 1}. [${correction.severity.toUpperCase()}] [${correction.concern}] [${correction.id}] ${correction.instruction}`
    ),
  ].join("\n");
}

function renderInitialPrompt(input: {
  plan: LampCombinedPlan;
  aggregatePlanHash: string;
  relightIntensity: number;
}): string {
  const scopedNegatives = relightNegativeBlock(
    input.relightIntensity,
    LAMP_COMBINED_V1_NEGATIVE_BASE
  );
  return [
    LAMP_COMBINED_V1_HEADER,
    `Prompt lineage: ${LAMP_COMBINED_PROMPT_LINEAGE}`,
    "",
    "[TASK]",
    LAMP_COMBINED_V1_TASK,
    "",
    "[SEPARATELY BOUND RELIGHT INTENSITY]",
    relightLightingDirective(input.relightIntensity),
    "",
    LAMP_COMBINED_V1_PLAN_HEADING,
    renderLampCombinedV1PlanBlock(input.plan, input.aggregatePlanHash),
    "",
    LAMP_COMBINED_V1_OWNERSHIP_HEADING,
    LAMP_COMBINED_V1_REGION_OWNERSHIP_LOCK_MATRIX,
    "",
    "[APPLICATION STANDARD]",
    LAMP_COMBINED_V1_APPLICATION_STANDARD,
    "",
    LAMP_COMBINED_V1_CORRECTIONS_HEADING,
    INITIAL_CORRECTIONS_BODY,
    "",
    LAMP_COMBINED_V1_NEVER_DO_HEADING,
    scopedNegatives.map((instruction) => `- ${instruction}`).join("\n"),
  ].join("\n");
}

/** Deterministically compile the only prompt bytes a new Initial may store. */
export async function initialLampCombinedMegaPrompt(
  plan: LampCombinedPlan,
  relightIntensity: unknown
): Promise<LampCombinedMegaPrompt> {
  const canonical = assertApprovedAggregatePlan(plan);
  const intensity = assertPromptRelightIntensity(relightIntensity);
  const aggregatePlanHash = await hashLampCombinedPlan(canonical);
  return {
    lineage: LAMP_COMBINED_PROMPT_LINEAGE,
    iteration: 1,
    aggregatePlanId: canonical.id,
    aggregatePlanHash,
    relightIntensity: intensity,
    corrections: [],
    rendered: renderInitialPrompt({
      plan: canonical,
      aggregatePlanHash,
      relightIntensity: intensity,
    }),
  };
}

/** Exact-byte binding check for the day-one lineage. */
export async function isPersistedInitialLampCombinedPrompt(
  persistedRendered: unknown,
  plan: LampCombinedPlan,
  relightIntensity: unknown
): Promise<boolean> {
  if (typeof persistedRendered !== "string") return false;
  try {
    return (
      persistedRendered ===
      (await initialLampCombinedMegaPrompt(plan, relightIntensity)).rendered
    );
  } catch {
    return false;
  }
}

function canonicalTargetIds(plan: LampCombinedPlan): {
  background: Set<string>;
  beautify: Set<string>;
  iris: Set<string>;
  all: Set<string>;
} {
  const background = new Set(plan.backgroundPlan.remove.map((item) => item.id));
  const beautify = new Set(
    plan.beautify.state === "enabled" &&
      plan.beautify.plan.decision === "enhance"
      ? plan.beautify.plan.enhance.map((item) => item.id)
      : []
  );
  const iris = new Set(
    plan.iris.state === "enabled" && plan.iris.plan.decision === "correct"
      ? plan.iris.plan.correct.map((item) => item.id)
      : []
  );
  return {
    background,
    beautify,
    iris,
    all: new Set([...background, ...beautify, ...iris]),
  };
}

function validateCorrectionTargets(
  plan: LampCombinedPlan,
  candidates: readonly LampCombinedPromptCorrectionCandidate[]
): void {
  const enabled = new Set(lampCombinedEnabledConcerns(plan.controls));
  const targetIds = canonicalTargetIds(plan);
  candidates.forEach((candidate, index) => {
    if (
      (candidate.concern === "beautify" || candidate.concern === "iris") &&
      !enabled.has(candidate.concern)
    ) {
      throw new Error(
        `Correction ${candidate.id} targets disabled concern ${candidate.concern}.`
      );
    }
    const ids = candidate.planItemIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new Error(`corrections[${index}].planItemIds must be strings.`);
    }
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Correction ${candidate.id} repeats a plan item id.`);
    }
    const allowed =
      candidate.concern === "background"
        ? targetIds.background
        : candidate.concern === "beautify"
          ? targetIds.beautify
          : candidate.concern === "iris"
            ? targetIds.iris
            : candidate.concern === "preservation"
              ? targetIds.all
              : new Set<string>();
    for (const id of ids) {
      if (!allowed.has(id)) {
        throw new Error(
          `Correction ${candidate.id} references ${id} outside its approved plan scope.`
        );
      }
    }
    const bracketReferences = Array.from(
      candidate.instruction.matchAll(/\[([a-z0-9]+(?:-[a-z0-9]+)*)\]/g),
      (match) => match[1]!
    );
    for (const id of bracketReferences) {
      if (!allowed.has(id)) {
        throw new Error(
          `Correction ${candidate.id} names ${id} outside its approved plan scope.`
        );
      }
    }
  });
}

function patchCorrectionsBody(
  persistedInitialRendered: string,
  corrections: readonly LampCombinedPromptCorrectionCandidate[]
): string {
  const headingIndex = persistedInitialRendered.indexOf(
    LAMP_COMBINED_V1_CORRECTIONS_HEADING
  );
  if (headingIndex < 0) {
    throw new Error("Persisted Lamp Combined v1 prompt has no corrections slot.");
  }
  const bodyStart =
    headingIndex + LAMP_COMBINED_V1_CORRECTIONS_HEADING.length + 1;
  const bodyEnd = persistedInitialRendered.indexOf(
    `\n\n${LAMP_COMBINED_V1_NEVER_DO_HEADING}`,
    bodyStart
  );
  if (bodyEnd < 0) {
    throw new Error("Persisted Lamp Combined v1 prompt has no NEVER DO boundary.");
  }
  return (
    persistedInitialRendered.slice(0, bodyStart) +
    renderCorrections(corrections) +
    persistedInitialRendered.slice(bodyEnd)
  );
}

/**
 * Compile Final by validating and surgically patching persisted v1 bytes.
 *
 * The signature intentionally has no candidate-video or previous-interaction
 * input. Generation callers must attach the original source video again.
 */
export async function compileLampCombinedFinalPrompt(
  persistedInitialRendered: string,
  plan: LampCombinedPlan,
  relightIntensity: unknown,
  firstEvaluation: LampCombinedEvaluationArtifact
): Promise<LampCombinedMegaPrompt> {
  // Preserve the historical validation boundary: reject an altered Initial
  // before inspecting an evaluation that may belong to another plan.
  await compileLampCombinedFinalPromptFromCorrections(
    persistedInitialRendered,
    plan,
    relightIntensity,
    []
  );
  const corrections = await collectLampCombinedCorrections(
    firstEvaluation,
    plan
  );
  return compileLampCombinedFinalPromptFromCorrections(
    persistedInitialRendered,
    plan,
    relightIntensity,
    corrections
  );
}

async function compileLampCombinedFinalPromptFromCorrections(
  persistedInitialRendered: string,
  plan: LampCombinedPlan,
  relightIntensity: unknown,
  corrections: readonly LampCombinedPromptCorrectionCandidate[]
): Promise<LampCombinedMegaPrompt> {
  const canonical = assertApprovedAggregatePlan(plan);
  const intensity = assertPromptRelightIntensity(relightIntensity);
  const initial = await initialLampCombinedMegaPrompt(canonical, intensity);
  if (
    typeof persistedInitialRendered !== "string" ||
    persistedInitialRendered !== initial.rendered
  ) {
    throw new Error(
      "Lamp Combined Final requires the exact persisted v1 Initial bytes bound to this plan and relight intensity."
    );
  }
  validateCorrectionTargets(canonical, corrections);
  return {
    lineage: LAMP_COMBINED_PROMPT_LINEAGE,
    iteration: 2,
    aggregatePlanId: canonical.id,
    aggregatePlanHash: initial.aggregatePlanHash,
    relightIntensity: intensity,
    corrections: [...corrections],
    rendered: patchCorrectionsBody(persistedInitialRendered, corrections),
  };
}

/**
 * Produce Take 2 even when the optional visual critic is unavailable. The
 * fallback changes no approved scope or strength and always starts from the
 * original source, so it is safe to reproduce and audit later.
 */
export async function compileLampCombinedFallbackFinalPrompt(
  persistedInitialRendered: string,
  plan: LampCombinedPlan,
  relightIntensity: unknown
): Promise<LampCombinedMegaPrompt> {
  return compileLampCombinedFinalPromptFromCorrections(
    persistedInitialRendered,
    plan,
    relightIntensity,
    []
  );
}

/**
 * Resolve the one Final prompt allowed for this execution. A persisted Take 2
 * may have used either the bounded critic or the deterministic fallback; exact
 * byte matching keeps replays and settlement fail-closed.
 */
export async function resolveLampCombinedFinalPrompt(input: {
  persistedInitialRendered: string;
  plan: LampCombinedPlan;
  relightIntensity: unknown;
  firstEvaluation?: LampCombinedEvaluationArtifact;
  persistedFinalRendered?: string;
}): Promise<LampCombinedMegaPrompt> {
  const fallback = await compileLampCombinedFallbackFinalPrompt(
    input.persistedInitialRendered,
    input.plan,
    input.relightIntensity
  );
  const evaluated = input.firstEvaluation
    ? await compileLampCombinedFinalPrompt(
        input.persistedInitialRendered,
        input.plan,
        input.relightIntensity,
        input.firstEvaluation
      )
    : undefined;
  if (input.persistedFinalRendered !== undefined) {
    if (evaluated?.rendered === input.persistedFinalRendered) return evaluated;
    if (fallback.rendered === input.persistedFinalRendered) return fallback;
    throw new Error(
      "Persisted Lamp Combined Take 2 prompt is neither the bounded-critic prompt nor the deterministic fallback."
    );
  }
  return evaluated ?? fallback;
}
