import {
  lampBeautifyPlanRequiresGeneration,
  parseLampBeautifyPlan,
  type LampBeautifyEnhanceItem,
  type LampBeautifyIntensity,
  type LampBeautifyPlan,
} from "../lamp-beautify.ts";
import {
  collectLampBeautifyCorrections,
  type LampBeautifyCorrection,
  type LampBeautifyEvaluationArtifact,
} from "../lamp-beautify-evaluation.ts";

export interface LampBeautifyBasePrompt {
  task: string;
  scope: string;
  locks: {
    identityAndPermanentFeatures: string;
    performance: string;
    wardrobeAndOtherPeople: string;
    backgroundAndRoom: string;
    lightingAndCamera: string;
    audio: string;
  };
  application: string;
  negative: string[];
}

export interface LampBeautifyMegaPrompt {
  version: 1 | 2;
  base: LampBeautifyBasePrompt;
  plan: LampBeautifyPlan;
  corrections: LampBeautifyCorrection[];
  rendered: string;
}

/**
 * Immutable task contract for the touch-up experiment. Background, lighting,
 * and camera are explicitly locked; this branch can later be combined with
 * cleanup or relighting without muddying what it proves on its own.
 */
export const LAMP_BEAUTIFY_BASE_PROMPT: LampBeautifyBasePrompt = {
  task: [
    "Apply a bounded professional on-camera touch-up to the primary subject of this exact source video as a restrained, source-faithful edit.",
    "The original video is structural, temporal, photometric, and performance ground truth.",
    "The human-approved enhancement plan is the complete edit authorization.",
    "Apply every approved enhancement at its approved intensity wherever the relevant region is visible.",
    "An enhancement plan is expected to produce a visible, camera-ready improvement; do not return an unchanged or near-unchanged result merely because the edit is subtle.",
    "Do not improve, restyle, or change anything outside the approved enhancement list.",
  ].join(" "),
  scope: [
    "Enhancement permission applies only to entries in the plan's ENHANCE list, only on the primary subject, and only at the approved intensity.",
    "Categories not listed under ENHANCE are protected: whatever their current state, it is intentional and must remain.",
    "The edit is grooming-level: it may reduce temporary, surface-level imperfections and never redesigns the person.",
  ].join(" "),
  locks: {
    identityAndPermanentFeatures: [
      "Keep the exact same person, unmistakably recognizable in every frame.",
      "Do not alter facial geometry, bone structure, face or body shape, eye size, nose, jaw, apparent age, or expression range.",
      "Permanent features stay: moles, scars, freckles, birthmarks, wrinkles consistent with age, and the facial-hair pattern are part of identity, not imperfections.",
    ].join(" "),
    performance: [
      "Keep every gesture, posture shift, blink, head turn, body trajectory, and lip movement at the same corresponding moment.",
      "Do not re-time, stabilize, smooth, exaggerate, or reanimate the performance.",
    ].join(" "),
    wardrobeAndOtherPeople: [
      "Keep clothing, accessories, and worn objects exactly as in the source.",
      "Every other visible person is fully protected wherever they move or appear and receives no enhancement of any kind.",
    ].join(" "),
    backgroundAndRoom: [
      "Keep every background pixel source-faithful: architecture, furniture, objects, screens, reflections, clutter, and all room content remain exactly as filmed.",
      "No cleanup, decor change, blur, or background adjustment of any kind.",
    ].join(" "),
    lightingAndCamera: [
      "Keep source exposure, contrast, color temperature, saturation, shadows, focus, depth of field, noise character, framing, crop, resolution, perspective, lens feel, camera position, and camera motion unchanged.",
      "No relighting, color grade, beauty lighting, reframing, stabilization, or subject-separation effect.",
    ].join(" "),
    audio: [
      "Source audio is canonical and restored outside generation.",
      "Do not reinterpret the performance from audio or attempt to generate replacement sound.",
    ].join(" "),
  },
  application: [
    "Apply each approved enhancement uniformly and continuously across the full timeline, tracking the subject through motion, occlusion, and lighting variation.",
    "Real skin keeps pores, texture, and natural micro-variation at every intensity; enhancement reduces temporary distractions, it never manufactures a surface.",
    "The result must read as the same person on a well-prepared day, never as a filter.",
  ].join(" "),
  negative: [
    "Do not enhance, retouch, or alter anything outside the approved ENHANCE list.",
    "Do not reshape the face or body, slim, enlarge eyes, straighten or resize the nose, sculpt the jaw, or change apparent age.",
    "Do not remove or fade moles, scars, freckles, birthmarks, age-consistent wrinkles, or the facial-hair pattern.",
    "Do not shift skin tone, apply makeup that is not present in the source, change the hairstyle, or alter wardrobe.",
    "Do not produce plastic, waxy, over-smoothed, or poreless skin at any intensity.",
    "Do not enhance any person other than the primary subject.",
    "Do not change the background, room content, lighting, color grade, focus, framing, or camera.",
    "Do not add text, captions, logos, watermarks, graphics, or visible masks.",
    "Do not change playback speed, duration, frame cadence, event timing, or source audio.",
  ],
};

const V1_HEADER = "=== LAMP BEAUTIFY TOUCH-UP MEGA PROMPT v1 ===";
const V2_HEADER = "=== LAMP BEAUTIFY TOUCH-UP MEGA PROMPT v2 ===";
const PLAN_HEADING = "[APPROVED ENHANCEMENT PLAN]";
const LOCKS_HEADING = "[INVARIANT LOCKS]";
const CORRECTIONS_HEADING = "[ACTIVE CORRECTIONS FROM EVALUATION]";
const NEVER_DO_HEADING = "[NEVER DO]";

function assertApprovedPlan(plan: LampBeautifyPlan): LampBeautifyPlan {
  const canonical = parseLampBeautifyPlan(plan);
  if (canonical.approval.status !== "approved") {
    throw new Error(
      "Lamp Beautify generation requires explicit human approval of the enhancement plan."
    );
  }
  if (!lampBeautifyPlanRequiresGeneration(canonical)) {
    throw new Error(
      "An exceptional no-op must bypass generation and deliver the exact source video."
    );
  }
  return canonical;
}

const INTENSITY_LINES: Record<LampBeautifyIntensity, string> = {
  1: "intensity 1 of 3 — subtle: barely perceptible, deniable; err toward doing less",
  2: "intensity 2 of 3 — balanced: noticeable side-by-side with the source, natural in isolation",
  3: "intensity 3 of 3 — polished: clearly groomed for camera, still physically plausible",
};

/**
 * What each catalog category must leave untouched, stated inline with the
 * authorization so intensity can never be read as broader permission.
 */
const CATEGORY_GUARDRAILS: Record<LampBeautifyEnhanceItem["id"], string> = {
  "skin-evenness":
    "Reduce temporary blemishes, shine, and irritation only. Pores, skin texture, permanent marks, and apparent age remain exactly as in the source.",
  "under-eye-softening":
    "Soften dark circles or puffiness only. Natural under-eye contours, fine lines, and the subject's rested-versus-tired character remain believable.",
  "teeth-brightening":
    "Brighten within plausible natural enamel tones only. Tooth shape, alignment, and mouth movement remain exactly as in the source.",
  "eye-clarity":
    "Reduce visible redness and slightly brighten the sclera only. Iris color, eye shape, catchlights, and gaze remain exactly as in the source.",
  "hair-tidy":
    "Tame stray flyaway strands only. The hairstyle, hairline, volume, and color remain exactly as in the source.",
};

function renderEnhanceItem(item: LampBeautifyEnhanceItem): string {
  return [
    `[${item.id}] ${INTENSITY_LINES[item.intensity]}.`,
    CATEGORY_GUARDRAILS[item.id],
    `Why: ${item.rationale}`,
  ].join(" ");
}

/**
 * Only approved enhancements are rendered. Declined and uncertain categories
 * are deliberately absent from generation input — naming them would put the
 * idea in the model's context (the ring-light lesson from Lamp Background),
 * and the scope line already protects everything unlisted.
 */
export function renderLampBeautifyPlanBlock(plan: LampBeautifyPlan): string {
  const canonical = assertApprovedPlan(plan);
  return [
    `Plan ID: ${canonical.id}`,
    `Subject: ${canonical.subjectSummary}`,
    "Decision: ENHANCE",
    "",
    "ENHANCE — apply each item at its approved intensity, and nothing else:",
    canonical.enhance.map((item) => `- ${renderEnhanceItem(item)}`).join("\n"),
    "",
    "GLOBAL DEFAULT: every category, region, person, and pixel not explicitly listed under ENHANCE is protected.",
  ].join("\n");
}

function findEnhanceItems(
  plan: LampBeautifyPlan,
  correction: LampBeautifyCorrection
): LampBeautifyEnhanceItem[] {
  return correction.planItemIds.map((itemId) => {
    const item = plan.enhance.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw new Error(
        `Correction ${correction.id} references a category outside the approved ENHANCE list.`
      );
    }
    return item;
  });
}

/**
 * Corrections are rendered from a closed action vocabulary and approved plan
 * entries. No judge-authored instruction is ever copied into provider input.
 */
export function renderLampBeautifyCorrection(
  plan: LampBeautifyPlan,
  correction: LampBeautifyCorrection
): string {
  const canonical = parseLampBeautifyPlan(plan);
  switch (correction.action) {
    case "restore-identity":
      return "Restore the exact source person's facial geometry, recognizable features, permanent marks, and apparent age at every corresponding moment; enhancement never changes who the person is.";
    case "restore-performance-lipsync":
      return "Restore the source performance timing and trajectories exactly, including gestures, blinks, head motion, body motion, and lip movement; do not retime or reanimate.";
    case "complete-approved-enhancement": {
      const items = findEnhanceItems(canonical, correction);
      return `Fully apply these approved enhancements at their approved intensity wherever the region is visible: ${items
        .map((item) => `[${item.id}] at intensity ${item.intensity}`)
        .join("; ")}. A near-unchanged result is not compliant.`;
    }
    case "reduce-enhancement-intensity": {
      const items = findEnhanceItems(canonical, correction);
      return `Dial these enhancements back to their approved intensity — the previous pass overshot: ${items
        .map((item) => `[${item.id}] must read as intensity ${item.intensity} of 3, no stronger`)
        .join("; ")}.`;
    }
    case "remove-unapproved-beautification":
      return "Remove every enhancement outside the approved ENHANCE list. Unlisted categories, regions, and people must match the source exactly.";
    case "repair-skin-texture":
      return "Restore natural skin realism: pores, texture, and micro-variation must survive enhancement. No plastic, waxy, blurred, or poreless surfaces.";
    case "restore-untouched-surroundings":
      return "Restore the background, room content, lighting, color, focus, framing, and camera exactly to the source everywhere; this workflow edits only the approved subject enhancements.";
  }
}

function renderCorrections(
  plan: LampBeautifyPlan,
  corrections: LampBeautifyCorrection[],
  eol = "\n"
): string {
  if (corrections.length === 0) {
    return "(none — first pass or no safe structured correction was available)";
  }
  return corrections
    .map(
      (correction, index) =>
        `${index + 1}. [${correction.severity.toUpperCase()}] ${renderLampBeautifyCorrection(
          plan,
          correction
        )}`
    )
    .join(eol);
}

export function renderLampBeautifyMegaPrompt(
  prompt: Omit<LampBeautifyMegaPrompt, "rendered">
): string {
  const plan = assertApprovedPlan(prompt.plan);
  const base = prompt.base;
  const locks = [
    `IDENTITY & PERMANENT FEATURES — ${base.locks.identityAndPermanentFeatures}`,
    `PERFORMANCE — ${base.locks.performance}`,
    `WARDROBE & OTHER PEOPLE — ${base.locks.wardrobeAndOtherPeople}`,
    `BACKGROUND & ROOM — ${base.locks.backgroundAndRoom}`,
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
    renderLampBeautifyPlanBlock(plan),
    "",
    LOCKS_HEADING,
    locks,
    "",
    "[APPLICATION STANDARD]",
    base.application,
    "",
    CORRECTIONS_HEADING,
    renderCorrections(plan, prompt.corrections),
    "",
    NEVER_DO_HEADING,
    base.negative.map((instruction) => `- ${instruction}`).join("\n"),
  ].join("\n");
}

export function initialLampBeautifyMegaPrompt(
  plan: LampBeautifyPlan
): LampBeautifyMegaPrompt {
  const canonical = assertApprovedPlan(plan);
  const prompt: Omit<LampBeautifyMegaPrompt, "rendered"> = {
    version: 1,
    base: LAMP_BEAUTIFY_BASE_PROMPT,
    plan: canonical,
    corrections: [],
  };
  return {
    ...prompt,
    rendered: renderLampBeautifyMegaPrompt(prompt),
  };
}

/**
 * True when the rendered bytes are a faithful initial compile of this exact
 * approved plan. Beautify launched with one prompt generation, so exactly one
 * form is valid; any future compiler change must add its predecessor here as
 * a frozen alternate, never mutate this check in place.
 */
export function isPersistedInitialLampBeautifyPrompt(
  plan: LampBeautifyPlan,
  rendered: string
): boolean {
  return rendered === initialLampBeautifyMegaPrompt(plan).rendered;
}

function sectionBody(
  rendered: string,
  heading: string,
  nextHeading: string
): string {
  const headingIndex = rendered.indexOf(heading);
  if (headingIndex < 0) {
    throw new Error(`Persisted Lamp Beautify prompt has no ${heading}.`);
  }
  const headingEnd = headingIndex + heading.length;
  const eol = rendered.startsWith("\r\n", headingEnd)
    ? "\r\n"
    : rendered.startsWith("\n", headingEnd)
      ? "\n"
      : null;
  if (!eol) {
    throw new Error(
      `Persisted Lamp Beautify prompt has an invalid boundary after ${heading}.`
    );
  }
  const bodyStart = headingEnd + eol.length;
  const bodyEnd = rendered.indexOf(`${eol}${eol}${nextHeading}`, bodyStart);
  if (bodyEnd < 0) {
    throw new Error(
      `Persisted Lamp Beautify prompt has no ${nextHeading} boundary.`
    );
  }
  return rendered.slice(bodyStart, bodyEnd);
}

function renderPersistedV2(
  persistedV1: string,
  plan: LampBeautifyPlan,
  corrections: LampBeautifyCorrection[]
): string {
  if (!persistedV1.startsWith(V1_HEADER)) {
    throw new Error(
      "Lamp Beautify's persisted initial prompt has an invalid v1 header."
    );
  }
  const persistedPlanBlock = sectionBody(
    persistedV1,
    PLAN_HEADING,
    LOCKS_HEADING
  );
  if (persistedPlanBlock !== renderLampBeautifyPlanBlock(plan)) {
    throw new Error(
      "The approved enhancement plan no longer matches the plan bound into the persisted v1 prompt."
    );
  }

  const headingIndex = persistedV1.indexOf(CORRECTIONS_HEADING);
  if (headingIndex < 0) {
    throw new Error(
      "Lamp Beautify's persisted initial prompt has no corrections section."
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
      "Lamp Beautify's persisted initial prompt has an invalid corrections boundary."
    );
  }
  const correctionsStart = headingEnd + eol.length;
  const correctionsEnd = persistedV1.indexOf(
    `${eol}${eol}${NEVER_DO_HEADING}`,
    correctionsStart
  );
  if (correctionsEnd < 0) {
    throw new Error(
      "Lamp Beautify's persisted initial prompt has no NEVER DO section."
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
 * approved plan ids but can never create a new enhancement.
 */
export function compileLampBeautifyFinalPrompt(
  persistedInitialRendered: string,
  plan: LampBeautifyPlan,
  firstEvaluation: LampBeautifyEvaluationArtifact
): LampBeautifyMegaPrompt {
  const canonical = assertApprovedPlan(plan);
  if (
    typeof persistedInitialRendered !== "string" ||
    persistedInitialRendered.length === 0
  ) {
    throw new Error(
      "Lamp Beautify final prompt requires persisted initial bytes."
    );
  }
  const corrections = collectLampBeautifyCorrections(
    firstEvaluation,
    canonical
  );
  return {
    version: 2,
    base: LAMP_BEAUTIFY_BASE_PROMPT,
    plan: canonical,
    corrections,
    rendered: renderPersistedV2(
      persistedInitialRendered,
      canonical,
      corrections
    ),
  };
}
