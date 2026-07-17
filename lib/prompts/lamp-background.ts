import {
  lampBackgroundPlanRequiresGeneration,
  parseLampBackgroundCleanupPlan,
  type LampBackgroundCleanupPlan,
  type LampBackgroundPlanItem,
} from "../lamp-background.ts";
import {
  collectLampBackgroundCorrections,
  type LampBackgroundCorrection,
  type LampBackgroundEvaluationArtifact,
} from "../lamp-background-evaluation.ts";

export interface LampBackgroundBasePrompt {
  task: string;
  scope: string;
  locks: {
    identityAndSkin: string;
    performance: string;
    appearanceAndInteraction: string;
    protectedBackground: string;
    lightingAndCamera: string;
    audio: string;
  };
  reconstruction: string;
  negative: string[];
}

export interface LampBackgroundMegaPrompt {
  version: 1 | 2;
  base: LampBackgroundBasePrompt;
  cleanupPlan: LampBackgroundCleanupPlan;
  corrections: LampBackgroundCorrection[];
  rendered: string;
}

/**
 * Immutable task contract for the cleanup experiment. Lighting is explicitly
 * locked; this branch can later be combined with relighting without muddying
 * what this workflow proves on its own.
 */
export const LAMP_BACKGROUND_BASE_PROMPT: LampBackgroundBasePrompt = {
  task: [
    "Tidy and clean the background of this exact source video as a restrained, source-faithful edit.",
    "The original video is structural, temporal, photometric, and performance ground truth.",
    "The human-approved cleanup plan is the complete edit authorization.",
    "Remove every approved removal target wherever it appears and realistically reconstruct only the pixels it covered.",
    "A cleanup plan is expected to produce a visible, presentation-ready improvement; do not return an unchanged or near-unchanged result merely because the edit is difficult.",
    "Do not redesign the room or improve anything outside the approved plan.",
  ].join(" "),
  scope: [
    "Background includes desks and foreground surfaces outside the subject.",
    "Removal permission applies only to entries in the plan's REMOVE list.",
    "PRESERVE entries, UNCERTAIN entries, and all unlisted content are protected.",
    "Anything worn, held, touched, or actively used is part of the protected performance, and this applies to every visible person, even when it overlaps the background.",
  ].join(" "),
  locks: {
    identityAndSkin: [
      "Keep every person in the frame exactly the same — the primary presenter and anyone else visible, in full or in part.",
      "Do not alter facial geometry, recognizable features, complexion, pores, fine lines, marks, facial hair, or apparent age.",
      "No beautification, smoothing, retouching, or invented skin detail.",
    ].join(" "),
    performance: [
      "Keep every gesture, posture shift, blink, head turn, body trajectory, and lip movement at the same corresponding moment.",
      "Do not re-time, stabilize, smooth, exaggerate, or reanimate the performance.",
    ].join(" "),
    appearanceAndInteraction: [
      "Keep hair, garments, pattern geometry, accessories, and worn objects unchanged for every visible person.",
      "Keep every object that any visible person holds, touches, or actively uses, including during intermittent moments.",
      "Never use cleanup permission to erase through a person or an interacting object.",
    ].join(" "),
    protectedBackground: [
      "Preserve every visible person wherever they move or appear, architecture, fixed furniture, wall art, windows, screens, reflections, pets, moving objects, meaningful personal objects, every PRESERVE item, every UNCERTAIN item, and all unlisted scene content.",
      "Do not add replacement decor or substitute a different object.",
    ].join(" "),
    lightingAndCamera: [
      "Keep source exposure, contrast, color temperature, saturation, shadows, focus, depth of field, noise character, framing, crop, resolution, perspective, lens feel, camera position, and camera motion unchanged.",
      "No relighting, color grade, background blur, reframing, stabilization, or subject-separation effect.",
    ].join(" "),
    audio: [
      "Source audio is canonical and restored outside generation.",
      "Do not reinterpret the performance from audio or attempt to generate replacement sound.",
    ].join(" "),
  },
  reconstruction: [
    "For each approved removal footprint, infer the smallest plausible continuation of the real source surface behind it.",
    "Match surrounding geometry, perspective, texture scale, noise, compression, lighting, shadow structure, reflections, and focus.",
    "Keep reconstruction temporally locked to the static camera through occlusions.",
    "No flicker, popping, crawling texture, shifting seams, halos, smears, repeated patches, warped lines, or blurry fill.",
  ].join(" "),
  negative: [
    "Do not remove, move, simplify, replace, repaint, or invent anything outside the approved REMOVE list.",
    "Do not leave an approved removal target partially present, intermittently reappearing, or replaced by a lookalike.",
    "Do not empty the room, stage a new room, add decor, or turn cleanup into aesthetic redesign.",
    "Do not remove, alter, or restyle any person — at the frame edge, in the background, or partially visible — nor skin, hair, wardrobe, accessories, motion, lip movement, or actively used objects.",
    "Do not relight, recolor, blur, reframe, crop, zoom, stabilize, sharpen, denoise, or change depth of field.",
    "Do not add text, captions, logos, watermarks, graphics, or visible cleanup masks.",
    "Do not change playback speed, duration, frame cadence, event timing, or source audio.",
  ],
};

/**
 * Frozen first-generation base contract — the exact bytes every execution
 * enqueued before the 2026-07-16 protected-region and multi-person changes
 * compiled from. Persisted prompts are immutable, so binding validation for
 * those runs must reproduce this contract verbatim. Never edit; never compile
 * new prompts from it. Exported only so tests can pin the frozen bytes.
 */
export const LEGACY_V1_BASE_PROMPT: LampBackgroundBasePrompt = {
  task: [
    "Tidy and clean the background of this exact source video as a restrained, source-faithful edit.",
    "The original video is structural, temporal, photometric, and performance ground truth.",
    "The human-approved cleanup plan is the complete edit authorization.",
    "Remove every approved removal target wherever it appears and realistically reconstruct only the pixels it covered.",
    "A cleanup plan is expected to produce a visible, presentation-ready improvement; do not return an unchanged or near-unchanged result merely because the edit is difficult.",
    "Do not redesign the room or improve anything outside the approved plan.",
  ].join(" "),
  scope: [
    "Background includes desks and foreground surfaces outside the subject.",
    "Removal permission applies only to entries in the plan's REMOVE list.",
    "PRESERVE entries, UNCERTAIN entries, and all unlisted content are protected.",
    "Anything worn, held, touched, or actively used is part of the protected subject performance, even when it overlaps the background.",
  ].join(" "),
  locks: {
    identityAndSkin: [
      "Keep the exact same person in every frame.",
      "Do not alter facial geometry, recognizable features, complexion, pores, fine lines, marks, facial hair, or apparent age.",
      "No beautification, smoothing, retouching, or invented skin detail.",
    ].join(" "),
    performance: [
      "Keep every gesture, posture shift, blink, head turn, body trajectory, and lip movement at the same corresponding moment.",
      "Do not re-time, stabilize, smooth, exaggerate, or reanimate the performance.",
    ].join(" "),
    appearanceAndInteraction: [
      "Keep hair, garments, pattern geometry, accessories, and worn objects unchanged.",
      "Keep every object that the subject holds, touches, or actively uses, including during intermittent moments.",
      "Never use cleanup permission to erase through the subject or an interacting object.",
    ].join(" "),
    protectedBackground: [
      "Preserve architecture, fixed furniture, wall art, windows, screens, reflections, pets, moving objects, meaningful personal objects, every PRESERVE item, every UNCERTAIN item, and all unlisted scene content.",
      "Do not add replacement decor or substitute a different object.",
    ].join(" "),
    lightingAndCamera: [
      "Keep source exposure, contrast, color temperature, saturation, shadows, focus, depth of field, noise character, framing, crop, resolution, perspective, lens feel, camera position, and camera motion unchanged.",
      "No relighting, color grade, background blur, reframing, stabilization, or subject-separation effect.",
    ].join(" "),
    audio: [
      "Source audio is canonical and restored outside generation.",
      "Do not reinterpret the performance from audio or attempt to generate replacement sound.",
    ].join(" "),
  },
  reconstruction: [
    "For each approved removal footprint, infer the smallest plausible continuation of the real source surface behind it.",
    "Match surrounding geometry, perspective, texture scale, noise, compression, lighting, shadow structure, reflections, and focus.",
    "Keep reconstruction temporally locked to the static camera through occlusions.",
    "No flicker, popping, crawling texture, shifting seams, halos, smears, repeated patches, warped lines, or blurry fill.",
  ].join(" "),
  negative: [
    "Do not remove, move, simplify, replace, repaint, or invent anything outside the approved REMOVE list.",
    "Do not leave an approved removal target partially present, intermittently reappearing, or replaced by a lookalike.",
    "Do not empty the room, stage a new room, add decor, or turn cleanup into aesthetic redesign.",
    "Do not alter the person, skin, hair, wardrobe, accessories, motion, lip movement, or actively used objects.",
    "Do not relight, recolor, blur, reframe, crop, zoom, stabilize, sharpen, denoise, or change depth of field.",
    "Do not add text, captions, logos, watermarks, graphics, or visible cleanup masks.",
    "Do not change playback speed, duration, frame cadence, event timing, or source audio.",
  ],
};

const V1_HEADER = "=== LAMP BACKGROUND CLEANUP MEGA PROMPT v1 ===";
const V2_HEADER = "=== LAMP BACKGROUND CLEANUP MEGA PROMPT v2 ===";
const PLAN_HEADING = "[APPROVED CLEANUP PLAN]";
const LOCKS_HEADING = "[INVARIANT LOCKS]";
const CORRECTIONS_HEADING = "[ACTIVE CORRECTIONS FROM EVALUATION]";
const NEVER_DO_HEADING = "[NEVER DO]";

function assertApprovedCleanupPlan(
  cleanupPlan: LampBackgroundCleanupPlan
): LampBackgroundCleanupPlan {
  const plan = parseLampBackgroundCleanupPlan(cleanupPlan);
  if (plan.approval.status !== "approved") {
    throw new Error(
      "Lamp Background generation requires explicit human approval of the cleanup plan."
    );
  }
  if (!lampBackgroundPlanRequiresGeneration(plan)) {
    throw new Error(
      "An exceptional no-op must bypass generation and deliver the exact source video."
    );
  }
  return plan;
}

function renderItem(item: LampBackgroundPlanItem): string {
  return `[${item.id}] ${item.label} — ${item.location}. ${item.rationale} Visibility: ${item.temporalVisibility}.`;
}

/**
 * Protected content is rendered by location only. A preserve label names an
 * object type, and the generator materializes names over source pixels (a
 * panel light mislabeled "ring light" was rendered as a literal ring light),
 * so generation prompts must never assert what a protected region contains.
 * Full labels still reach plan review and the evaluator, which compare
 * against the source instead of generating from a description.
 */
function renderProtectedRegion(item: LampBackgroundPlanItem): string {
  return `[${item.id}] protected source region — ${item.location}: keep exactly what the source shows here; do not reinterpret, replace, upgrade, or restyle it. Visibility: ${item.temporalVisibility}.`;
}

export function renderLampBackgroundPlanBlock(
  cleanupPlan: LampBackgroundCleanupPlan
): string {
  const plan = assertApprovedCleanupPlan(cleanupPlan);
  const preserve =
    plan.preserve.length === 0
      ? "- (no named items; all unlisted content remains protected)"
      : plan.preserve
          .map((item) => `- ${renderProtectedRegion(item)}`)
          .join("\n");
  const uncertain =
    plan.uncertain.length === 0
      ? "- (none)"
      : plan.uncertain
          .map(
            (item) =>
              `- ${renderProtectedRegion(item)} Not a removal target under any interpretation. Safe default: PRESERVE.`
          )
          .join("\n");
  return [
    `Plan ID: ${plan.id}`,
    `Scene: ${plan.sceneSummary}`,
    "Decision: CLEANUP",
    "",
    "REMOVE — execute every target, but remove nothing else:",
    plan.remove.map((item) => `- ${renderItem(item)}`).join("\n"),
    "",
    "PRESERVE — keep exactly source-faithful:",
    preserve,
    "",
    "UNCERTAIN — preserve by default; these are not removal targets:",
    uncertain,
    "",
    "GLOBAL DEFAULT: all content not explicitly listed under REMOVE is protected.",
  ].join("\n");
}

/**
 * Frozen pre-2026-07-16 plan-block rendering, in which preserve and uncertain
 * entries carried object labels. Persisted v1 prompts are immutable bytes, so
 * runs compiled before the protected-region change bind their plan through
 * this exact form. Validators accept it as an alternate rendering of the same
 * approved plan; nothing new is ever compiled from it.
 */
export function renderLegacyLampBackgroundPlanBlockV1(
  cleanupPlan: LampBackgroundCleanupPlan
): string {
  const plan = assertApprovedCleanupPlan(cleanupPlan);
  const preserve =
    plan.preserve.length === 0
      ? "- (no named items; all unlisted content remains protected)"
      : plan.preserve.map((item) => `- ${renderItem(item)}`).join("\n");
  const uncertain =
    plan.uncertain.length === 0
      ? "- (none)"
      : plan.uncertain
          .map(
            (item) =>
              `- ${renderItem(item)} Uncertainty: ${item.uncertainty} Safe default: PRESERVE.`
          )
          .join("\n");
  return [
    `Plan ID: ${plan.id}`,
    `Scene: ${plan.sceneSummary}`,
    "Decision: CLEANUP",
    "",
    "REMOVE — execute every target, but remove nothing else:",
    plan.remove.map((item) => `- ${renderItem(item)}`).join("\n"),
    "",
    "PRESERVE — keep exactly source-faithful:",
    preserve,
    "",
    "UNCERTAIN — preserve by default; these are not removal targets:",
    uncertain,
    "",
    "GLOBAL DEFAULT: all content not explicitly listed under REMOVE is protected.",
  ].join("\n");
}

/**
 * True when the rendered bytes are a faithful initial compile of this exact
 * approved plan — current protected-region form or the frozen legacy form.
 * Both blocks are deterministic functions of the hash-bound plan, so either
 * one proves the binding.
 */
export function isPersistedInitialLampBackgroundPrompt(
  cleanupPlan: LampBackgroundCleanupPlan,
  rendered: string
): boolean {
  const plan = assertApprovedCleanupPlan(cleanupPlan);
  const neutral = initialLampBackgroundMegaPrompt(plan).rendered;
  if (rendered === neutral) return true;
  // Executions enqueued before 2026-07-16 hold the frozen first-generation
  // bytes: the legacy base contract with the label-based plan block. The two
  // mixed intermediates never shipped, so only these two forms are valid.
  const legacyBase = renderLampBackgroundMegaPrompt({
    version: 1,
    base: LEGACY_V1_BASE_PROMPT,
    cleanupPlan: plan,
    corrections: [],
  });
  const neutralBlock = renderLampBackgroundPlanBlock(plan);
  const legacyBlock = renderLegacyLampBackgroundPlanBlockV1(plan);
  const legacy =
    neutralBlock === legacyBlock
      ? legacyBase
      : legacyBase.replace(neutralBlock, legacyBlock);
  return rendered === legacy;
}

function findPlanItems(
  plan: LampBackgroundCleanupPlan,
  correction: LampBackgroundCorrection
): LampBackgroundPlanItem[] {
  const source =
    correction.action === "restore-preserved-background"
      ? plan.preserve
      : correction.action === "preserve-uncertain-background"
        ? plan.uncertain
        : plan.remove;
  return correction.planItemIds.map((itemId) => {
    const item = source.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw new Error(
        `Correction ${correction.id} references a plan item outside its allowed classification.`
      );
    }
    return item;
  });
}

/**
 * Corrections are rendered from a closed action vocabulary and approved plan
 * entries. No judge-authored instruction is ever copied into provider input.
 */
export function renderLampBackgroundCorrection(
  plan: LampBackgroundCleanupPlan,
  correction: LampBackgroundCorrection
): string {
  const items = findPlanItems(plan, correction);
  const targets = items
    .map((item) => `[${item.id}] ${item.label} at ${item.location}`)
    .join("; ");
  // Protected content follows the same rule as the plan block: location only,
  // never an object name the generator could materialize.
  const protectedTargets = items
    .map((item) => `[${item.id}] the exact source content at ${item.location}`)
    .join("; ");
  switch (correction.action) {
    case "restore-subject-identity":
      return "Restore the exact source person's facial geometry, recognizable features, and identity at every corresponding moment; change background pixels only.";
    case "restore-skin":
      return "Restore source skin texture, marks, complexion variation, facial hair, and apparent age without smoothing, sharpening, beautifying, or inventing detail.";
    case "restore-appearance":
      return "Restore the subject's source hair, clothing, accessories, worn objects, and every held, touched, or actively used object at every corresponding moment.";
    case "restore-motion-lipsync":
      return "Restore the source performance timing and trajectories exactly, including gestures, blinks, head motion, body motion, and lip movement; do not retime or reanimate.";
    case "complete-approved-removal":
      return `Complete only these already approved removals wherever visible: ${targets}. Do not remove or alter any other content.`;
    case "restore-preserved-background":
      return `Restore these explicitly preserved regions exactly from the source: ${protectedTargets}. They are not removal targets.`;
    case "preserve-uncertain-background":
      return `Restore and preserve these uncertain regions exactly from the source: ${protectedTargets}. Uncertainty never grants removal permission.`;
    case "restore-unplanned-background-change":
      return "Restore every unapproved background change to the source. Only the cleanup plan's REMOVE entries may remain absent; all other content must match.";
    case "stabilize-approved-removal":
      return `Keep these approved removals stable wherever their source locations are visible: ${targets}. Prevent reappearance, popping, flicker, edge chatter, and shifting reconstruction.`;
    case "repair-inpainting":
      return `Repair reconstruction only inside the footprints of these approved removals: ${targets}. Continue the real surrounding source surfaces with stable geometry, texture, lighting, focus, and noise; invent no object or design.`;
    case "restore-lighting-camera":
      return "Restore source exposure, color, shadows, focus, depth of field, framing, crop, perspective, lens feel, noise, and camera motion everywhere outside the minimum approved removal footprints.";
  }
}

function renderCorrections(
  plan: LampBackgroundCleanupPlan,
  corrections: LampBackgroundCorrection[],
  eol = "\n"
): string {
  if (corrections.length === 0) {
    return "(none — first pass or no safe structured correction was available)";
  }
  return corrections
    .map(
      (correction, index) =>
        `${index + 1}. [${correction.severity.toUpperCase()}] ${renderLampBackgroundCorrection(
          plan,
          correction
        )}`
    )
    .join(eol);
}

export function renderLampBackgroundMegaPrompt(
  prompt: Omit<LampBackgroundMegaPrompt, "rendered">
): string {
  const plan = assertApprovedCleanupPlan(prompt.cleanupPlan);
  const base = prompt.base;
  const locks = [
    `IDENTITY & SKIN — ${base.locks.identityAndSkin}`,
    `PERFORMANCE — ${base.locks.performance}`,
    `APPEARANCE & INTERACTION — ${base.locks.appearanceAndInteraction}`,
    `PROTECTED BACKGROUND — ${base.locks.protectedBackground}`,
    `LIGHTING & CAMERA — ${base.locks.lightingAndCamera}`,
    `AUDIO — ${base.locks.audio}`,
  ].join("\n");
  return [
    prompt.version === 1 ? V1_HEADER : V2_HEADER,
    "",
    "[TASK]",
    base.task,
    "",
    "[EDIT SCOPE]",
    base.scope,
    "",
    PLAN_HEADING,
    renderLampBackgroundPlanBlock(plan),
    "",
    LOCKS_HEADING,
    locks,
    "",
    "[RECONSTRUCTION STANDARD]",
    base.reconstruction,
    "",
    CORRECTIONS_HEADING,
    renderCorrections(plan, prompt.corrections),
    "",
    NEVER_DO_HEADING,
    base.negative.map((instruction) => `- ${instruction}`).join("\n"),
  ].join("\n");
}

export function initialLampBackgroundMegaPrompt(
  cleanupPlan: LampBackgroundCleanupPlan
): LampBackgroundMegaPrompt {
  const plan = assertApprovedCleanupPlan(cleanupPlan);
  const prompt: Omit<LampBackgroundMegaPrompt, "rendered"> = {
    version: 1,
    base: LAMP_BACKGROUND_BASE_PROMPT,
    cleanupPlan: plan,
    corrections: [],
  };
  return {
    ...prompt,
    rendered: renderLampBackgroundMegaPrompt(prompt),
  };
}

function sectionBody(
  rendered: string,
  heading: string,
  nextHeading: string
): string {
  const headingIndex = rendered.indexOf(heading);
  if (headingIndex < 0) {
    throw new Error(`Persisted Lamp Background prompt has no ${heading}.`);
  }
  const headingEnd = headingIndex + heading.length;
  const eol = rendered.startsWith("\r\n", headingEnd)
    ? "\r\n"
    : rendered.startsWith("\n", headingEnd)
      ? "\n"
      : null;
  if (!eol) {
    throw new Error(
      `Persisted Lamp Background prompt has an invalid boundary after ${heading}.`
    );
  }
  const bodyStart = headingEnd + eol.length;
  const bodyEnd = rendered.indexOf(`${eol}${eol}${nextHeading}`, bodyStart);
  if (bodyEnd < 0) {
    throw new Error(
      `Persisted Lamp Background prompt has no ${nextHeading} boundary.`
    );
  }
  return rendered.slice(bodyStart, bodyEnd);
}

function renderPersistedV2(
  persistedV1: string,
  plan: LampBackgroundCleanupPlan,
  corrections: LampBackgroundCorrection[]
): string {
  if (!persistedV1.startsWith(V1_HEADER)) {
    throw new Error(
      "Lamp Background's persisted initial prompt has an invalid v1 header."
    );
  }
  const persistedPlanBlock = sectionBody(
    persistedV1,
    PLAN_HEADING,
    LOCKS_HEADING
  );
  // Persisted v1 bytes are immutable: prompts compiled before the
  // protected-region change carry the frozen legacy block. Either form binds
  // the same approved plan.
  const acceptedPlanBlocks = [
    renderLampBackgroundPlanBlock(plan),
    renderLegacyLampBackgroundPlanBlockV1(plan),
  ];
  if (!acceptedPlanBlocks.includes(persistedPlanBlock)) {
    throw new Error(
      "The approved cleanup plan no longer matches the plan bound into the persisted v1 prompt."
    );
  }

  const headingIndex = persistedV1.indexOf(CORRECTIONS_HEADING);
  if (headingIndex < 0) {
    throw new Error(
      "Lamp Background's persisted initial prompt has no corrections section."
    );
  }
  const headingEnd = headingIndex + CORRECTIONS_HEADING.length;
  const eol = persistedV1.startsWith("\r\n", headingEnd)
    ? "\r\n"
    : persistedV1.startsWith("\n", headingEnd)
      ? "\n"
      : null;
  if (!eol) {
    throw new Error(
      "Lamp Background's persisted initial prompt has an invalid corrections boundary."
    );
  }
  const correctionsStart = headingEnd + eol.length;
  const correctionsEnd = persistedV1.indexOf(
    `${eol}${eol}${NEVER_DO_HEADING}`,
    correctionsStart
  );
  if (correctionsEnd < 0) {
    throw new Error(
      "Lamp Background's persisted initial prompt has no NEVER DO section."
    );
  }
  const withV2Header = V2_HEADER + persistedV1.slice(V1_HEADER.length);
  return (
    withV2Header.slice(0, correctionsStart) +
    renderCorrections(plan, corrections, eol) +
    withV2Header.slice(correctionsEnd)
  );
}

/**
 * Deterministic two-pass compiler. It changes only the version header and
 * correction body in the exact persisted v1 bytes. Corrections may reference
 * approved plan ids but can never create a new removal target.
 */
export function compileLampBackgroundFinalPrompt(
  persistedInitialRendered: string,
  cleanupPlan: LampBackgroundCleanupPlan,
  firstEvaluation: LampBackgroundEvaluationArtifact
): LampBackgroundMegaPrompt {
  const plan = assertApprovedCleanupPlan(cleanupPlan);
  if (
    typeof persistedInitialRendered !== "string" ||
    persistedInitialRendered.length === 0
  ) {
    throw new Error(
      "Lamp Background final prompt requires persisted initial bytes."
    );
  }
  const corrections = collectLampBackgroundCorrections(
    firstEvaluation,
    plan
  );
  return {
    version: 2,
    base: LAMP_BACKGROUND_BASE_PROMPT,
    cleanupPlan: plan,
    corrections,
    rendered: renderPersistedV2(
      persistedInitialRendered,
      plan,
      corrections
    ),
  };
}
