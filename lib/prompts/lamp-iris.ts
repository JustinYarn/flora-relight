import {
  lampIrisPlanRequiresGeneration,
  parseLampIrisPlan,
  type LampIrisCorrectItem,
  type LampIrisIntensity,
  type LampIrisPlan,
} from "../lamp-iris.ts";
import {
  collectLampIrisCorrections,
  type LampIrisCorrection,
  type LampIrisEvaluationArtifact,
} from "../lamp-iris-evaluation.ts";
import { renderLampIrisMeasuredCalibrationCorrection } from "../lamp-iris-gaze.ts";

export interface LampIrisBasePrompt {
  task: string;
  scope: string;
  locks: {
    identityAndEyeAppearance: string;
    performanceAndHeadPose: string;
    blinksAndEyeLife: string;
    wardrobeAndOtherPeople: string;
    backgroundAndRoom: string;
    lightingAndCamera: string;
    audio: string;
  };
  application: string;
  negative: string[];
}

export interface LampIrisMegaPrompt {
  version: 1 | 2;
  base: LampIrisBasePrompt;
  plan: LampIrisPlan;
  corrections: LampIrisCorrection[];
  /**
   * Deterministic GazeMeter steering compiled from the Initial evaluation's
   * persisted measurements — pass 2's concrete magnitude instruction.
   * Undefined when no usable measurements exist (fail-open).
   */
  measuredCalibration?: string;
  rendered: string;
}

/**
 * Immutable task contract for the eye-contact experiment — third
 * generation (pupil-literal). The first live run shipped a near-copy; the
 * second generation demanded visible difference but still let "toward the
 * lens" blur into "near the lens". This generation names the physical
 * target exactly: the pupils aim INTO the lens itself — the screen,
 * prompter, or any point near the camera is a different target, and a gaze
 * parked there reads as looking at the viewer's chin, not their eyes.
 * Perceived contact with the person watching is the bar at every level.
 * The dead-stare overshoot remains the mirror failure.
 */
export const LAMP_IRIS_BASE_PROMPT: LampIrisBasePrompt = {
  task: [
    "Correct the on-camera gaze of the primary subject of this exact source video so a person who was reading from a script, notes, or a prompter reads as making literal eye contact with the camera — pupils aimed into the lens itself, so the person watching the clip feels personally looked at.",
    "Eye contact is a precise physical target: the camera's lens is a single point, and the screen, prompter, or notes near it are DIFFERENT points. A gaze parked on the screen below the lens reads on playback as looking at the viewer's chin or past them — it is exactly the input state this workflow exists to eliminate. Near the lens is not the lens.",
    "The original video is structural, temporal, photometric, and performance ground truth for everything EXCEPT gaze direction — gaze direction is the one property this workflow exists to change, and it must visibly change.",
    "The human-approved gaze-correction plan is the complete edit authorization.",
    "The goal of this workflow is the same person delivering the same take whose pupils now rest in the lens the way a confident speaker's would — the viewer feels looked in the eye — alive, blinking exactly as filmed, occasionally breaking naturally, while every other pixel behaves as the source.",
    "Calibrate VISIBLE CHANGE to each approved intensity: at 1 the lift of the pupils toward the lens must be findable in a side-by-side; at 2 the pupils must read as IN the lens through speech, evident at a glance at the same timestamp; at 3 the contact must be unmistakable even without the source — every paused speaking frame reads as the subject looking straight at the person watching.",
    "Undershooting is the defining failure of this workflow: a candidate whose eye region is hard to distinguish from the source has failed its one job — and so has a gaze moved only as far as the screen or the lens's neighborhood, because it still misses the viewer's eyes.",
    "Overshooting is the mirror failure: a frozen, unblinking, glassy stare is worse than the original reading pattern.",
    "Do not improve, restyle, or change anything outside the approved gaze-correction list.",
  ].join(" "),
  scope: [
    "Correction permission applies only to entries in the plan's CORRECT list, only on the primary subject, and only at the approved intensity.",
    "The permitted change is gaze direction plus the minimal eyelid pose that direction implies — nothing else about the eyes and nothing beyond the eyes.",
    "Categories not listed under CORRECT are protected: whatever their current state, it is intentional and must remain.",
    "The edit is redirection-level: it moves where the eyes rest and never redesigns the eyes, the face, or the performance.",
  ].join(" "),
  locks: {
    identityAndEyeAppearance: [
      "Keep the exact same person, unmistakably recognizable in every frame.",
      "Do not alter facial geometry, bone structure, face or body shape, or apparent age.",
      "The eyes remain the subject's exact eyes: iris color and texture, sclera tone including any natural redness, eye shape and size, lash and brow appearance, and catchlight character all match the source; only direction and natural lid travel may differ.",
      "Permanent features stay: moles, scars, freckles, birthmarks, wrinkles consistent with age, and the facial-hair pattern are part of identity, not imperfections.",
    ].join(" "),
    performanceAndHeadPose: [
      "Keep every gesture, posture shift, head position and rotation, body trajectory, and word at the same corresponding moment.",
      "The head is never re-aimed toward the camera: eye contact is achieved inside the eye sockets alone, on the source's exact head pose at every frame.",
      "Speech articulation is sacred: the subject is reading a script and the delivered audio is the untouched source track, so mouth shapes must form the same phonemes at the same timestamps and lip-sync must remain frame-accurate.",
    ].join(" "),
    blinksAndEyeLife: [
      "Every blink in the source occurs in the output at its source timestamp with natural lid travel; no blink is removed, added, shortened, or stretched.",
      "Corrected gaze keeps living micro-texture — tiny saccades, natural settling, believable moments of thought — and never hardens into pixel-frozen fixation.",
      "Both eyes converge naturally on the lens; gaze correction never produces cross-eyed, wall-eyed, or asymmetric alignment.",
    ].join(" "),
    wardrobeAndOtherPeople: [
      "Keep clothing, accessories, and worn objects exactly as in the source.",
      "Every other visible person is fully protected wherever they move or appear: their gaze, eyes, and everything else remain exactly as filmed.",
    ].join(" "),
    backgroundAndRoom: [
      "Keep every background pixel source-faithful: architecture, furniture, objects, screens, reflections, clutter, and all room content remain exactly as filmed.",
      "No cleanup, decor change, blur, or background adjustment of any kind.",
    ].join(" "),
    lightingAndCamera: [
      "Keep source exposure, contrast, color temperature, saturation, shadows, focus, depth of field, noise character, framing, crop, resolution, perspective, lens feel, camera position, and camera motion unchanged.",
      "No relighting, color grade, glow, reframing, stabilization, or zoom; the only permitted optical difference is the plausible local light response of the eye region to its corrected direction.",
    ].join(" "),
    audio: [
      "Source audio is canonical and restored outside generation.",
      "Do not reinterpret the performance from audio or attempt to generate replacement sound.",
    ].join(" "),
  },
  application: [
    "Move the pupils decisively into the lens: redirection is the product, and a timid, source-hugging eye region is this workflow's characteristic failure.",
    "Aim for the lens, not its neighborhood: a correction that stops at the top of the screen or drifts around the camera still misses the viewer's eyes and fails.",
    "Apply each approved correction continuously across the full timeline, tracking the subject through motion, expression changes, and partial occlusion.",
    "Corrected gaze must read as attention, not surveillance: the pupils rest in the lens the way they would rest on a person's eyes, with the natural softness, settling, and micro-movement of real conversation.",
    "Transitions matter as much as rest states: when the gaze moves — into a retained natural break, back to the lens, into a blink — it travels with believable saccade motion, never popping or teleporting.",
    "The finished frame test: pause the candidate beside the source at any speaking moment — the source's pupils rest on the reading material, the candidate's pupils rest in the lens, the person watching feels looked at, and absolutely nothing else in the frame has changed.",
    "The result must read as the same person on the same take who simply knew the camera was a person — never as a re-acted take, a staring contest, or painted-on eyes.",
  ].join(" "),
  negative: [
    "Do not correct, restyle, or alter anything outside the approved CORRECT list.",
    "Do not settle the gaze on the screen, prompter, monitor edge, or any point near the camera in place of the lens itself; near-lens gaze is not eye contact.",
    "Do not re-aim, rotate, or re-pose the head, neck, or body to achieve contact; the correction lives in the eyes alone.",
    "Do not remove, add, retime, shorten, or extend any blink.",
    "Do not freeze the eyes into a fixed stare, strip natural micro-saccades, or produce glassy, painted, waxy, or dead eyes.",
    "Do not change iris color or texture, sclera tone, eye shape or size, lash or brow appearance, or catchlight character; do not whiten, brighten, enlarge, or beautify the eyes.",
    "Do not introduce cross-eyed, wall-eyed, or asymmetric gaze.",
    "Do not change the expression, warm the mood, or alter the mouth in any way; do not break lip-sync, change mouth shapes during speech, or re-time any movement.",
    "Do not smooth skin, remove or fade permanent features, or touch hair or wardrobe.",
    "Do not correct or alter any person other than the primary subject.",
    "Do not change the background, room content, lighting, color grade, focus, framing, or camera.",
    "Do not add text, captions, logos, watermarks, graphics, or visible masks.",
    "Do not change playback speed, duration, frame cadence, event timing, or source audio.",
  ],
};

/**
 * Frozen second-generation base contract (visibility rewrite) — the exact
 * bytes executions enqueued between the 2026-07-17 visibility rewrite and
 * the pupil-literal rewrite compiled from. Persisted prompts are immutable;
 * never edit, never compile new prompts from it.
 */
export const LEGACY_V2_IRIS_BASE_PROMPT: LampIrisBasePrompt = {
  task: [
    "Correct the on-camera gaze of the primary subject of this exact source video so a person who was reading from a script, notes, or a prompter reads as holding natural eye contact with the camera.",
    "The original video is structural, temporal, photometric, and performance ground truth for everything EXCEPT gaze direction — gaze direction is the one property this workflow exists to change, and it must visibly change.",
    "The human-approved gaze-correction plan is the complete edit authorization.",
    "The goal of this workflow is the same person delivering the same take whose eyes now rest on the lens the way a confident speaker's would — alive, blinking exactly as filmed, occasionally breaking naturally — while every other pixel behaves as the source.",
    "Calibrate VISIBLE CHANGE to each approved intensity: at 1 the reduction of the reading pattern must be findable in a side-by-side; at 2 the redirected eyes must be evident at a glance in a same-timestamp side-by-side; at 3 the to-lens contact must be unmistakable even without the source for comparison.",
    "Undershooting is the defining failure of this workflow: a candidate whose eye region is hard to distinguish from the source at corresponding timestamps has failed its one job, no matter how faithful everything else is.",
    "Overshooting is the mirror failure: a frozen, unblinking, glassy stare is worse than the original reading pattern.",
    "Do not improve, restyle, or change anything outside the approved gaze-correction list.",
  ].join(" "),
  scope: [
    "Correction permission applies only to entries in the plan's CORRECT list, only on the primary subject, and only at the approved intensity.",
    "The permitted change is gaze direction plus the minimal eyelid pose that direction implies — nothing else about the eyes and nothing beyond the eyes.",
    "Categories not listed under CORRECT are protected: whatever their current state, it is intentional and must remain.",
    "The edit is redirection-level: it moves where the eyes rest and never redesigns the eyes, the face, or the performance.",
  ].join(" "),
  locks: {
    identityAndEyeAppearance: [
      "Keep the exact same person, unmistakably recognizable in every frame.",
      "Do not alter facial geometry, bone structure, face or body shape, or apparent age.",
      "The eyes remain the subject's exact eyes: iris color and texture, sclera tone including any natural redness, eye shape and size, lash and brow appearance, and catchlight character all match the source; only direction and natural lid travel may differ.",
      "Permanent features stay: moles, scars, freckles, birthmarks, wrinkles consistent with age, and the facial-hair pattern are part of identity, not imperfections.",
    ].join(" "),
    performanceAndHeadPose: [
      "Keep every gesture, posture shift, head position and rotation, body trajectory, and word at the same corresponding moment.",
      "The head is never re-aimed toward the camera: eye contact is achieved inside the eye sockets alone, on the source's exact head pose at every frame.",
      "Speech articulation is sacred: the subject is reading a script and the delivered audio is the untouched source track, so mouth shapes must form the same phonemes at the same timestamps and lip-sync must remain frame-accurate.",
    ].join(" "),
    blinksAndEyeLife: [
      "Every blink in the source occurs in the output at its source timestamp with natural lid travel; no blink is removed, added, shortened, or stretched.",
      "Corrected gaze keeps living micro-texture — tiny saccades, natural settling, believable moments of thought — and never hardens into pixel-frozen fixation.",
      "Both eyes converge naturally on the lens; gaze correction never produces cross-eyed, wall-eyed, or asymmetric alignment.",
    ].join(" "),
    wardrobeAndOtherPeople: [
      "Keep clothing, accessories, and worn objects exactly as in the source.",
      "Every other visible person is fully protected wherever they move or appear: their gaze, eyes, and everything else remain exactly as filmed.",
    ].join(" "),
    backgroundAndRoom: [
      "Keep every background pixel source-faithful: architecture, furniture, objects, screens, reflections, clutter, and all room content remain exactly as filmed.",
      "No cleanup, decor change, blur, or background adjustment of any kind.",
    ].join(" "),
    lightingAndCamera: [
      "Keep source exposure, contrast, color temperature, saturation, shadows, focus, depth of field, noise character, framing, crop, resolution, perspective, lens feel, camera position, and camera motion unchanged.",
      "No relighting, color grade, glow, reframing, stabilization, or zoom; the only permitted optical difference is the plausible local light response of the eye region to its corrected direction.",
    ].join(" "),
    audio: [
      "Source audio is canonical and restored outside generation.",
      "Do not reinterpret the performance from audio or attempt to generate replacement sound.",
    ].join(" "),
  },
  application: [
    "Move the eyes decisively: redirection is the product, and a timid, source-hugging eye region is this workflow's characteristic failure.",
    "Apply each approved correction continuously across the full timeline, tracking the subject through motion, expression changes, and partial occlusion.",
    "Corrected gaze must read as attention, not surveillance: the eyes rest on the lens the way they would rest on a person, with the natural softness, settling, and micro-movement of real conversation.",
    "Transitions matter as much as rest states: when the gaze moves — into a retained natural break, back to the lens, into a blink — it travels with believable saccade motion, never popping or teleporting.",
    "The finished frame test: pause the candidate beside the source at any speaking moment — the eyes must be plainly on the lens where the source's were on the reading material, and absolutely nothing else in the frame may have changed.",
    "The result must read as the same person on the same take who simply knew the camera was a person — never as a re-acted take, a staring contest, or painted-on eyes.",
  ].join(" "),
  negative: [
    "Do not correct, restyle, or alter anything outside the approved CORRECT list.",
    "Do not re-aim, rotate, or re-pose the head, neck, or body to achieve contact; the correction lives in the eyes alone.",
    "Do not remove, add, retime, shorten, or extend any blink.",
    "Do not freeze the eyes into a fixed stare, strip natural micro-saccades, or produce glassy, painted, waxy, or dead eyes.",
    "Do not change iris color or texture, sclera tone, eye shape or size, lash or brow appearance, or catchlight character; do not whiten, brighten, enlarge, or beautify the eyes.",
    "Do not introduce cross-eyed, wall-eyed, or asymmetric gaze.",
    "Do not change the expression, warm the mood, or alter the mouth in any way; do not break lip-sync, change mouth shapes during speech, or re-time any movement.",
    "Do not smooth skin, remove or fade permanent features, or touch hair or wardrobe.",
    "Do not correct or alter any person other than the primary subject.",
    "Do not change the background, room content, lighting, color grade, focus, framing, or camera.",
    "Do not add text, captions, logos, watermarks, graphics, or visible masks.",
    "Do not change playback speed, duration, frame cadence, event timing, or source audio.",
  ],
};

/**
 * Frozen first-generation base contract — the exact bytes every execution
 * enqueued before the 2026-07-17 visibility rewrite compiled from (including
 * the first live run). Persisted prompts are immutable; never edit, never
 * compile new prompts from it. Exported only so tests can pin the frozen
 * bytes.
 */
export const LEGACY_V1_IRIS_BASE_PROMPT: LampIrisBasePrompt = {
  task: [
    "Correct the on-camera gaze of the primary subject of this exact source video so a person who was reading from a script, notes, or a prompter reads as holding natural eye contact with the camera.",
    "The original video is structural, temporal, photometric, and performance ground truth.",
    "The human-approved gaze-correction plan is the complete edit authorization.",
    "The goal of this workflow is the same person delivering the same take whose eyes now rest on the lens the way a confident speaker's would — alive, blinking exactly as filmed, occasionally breaking naturally — while every other pixel behaves as the source.",
    "Apply every approved correction at its approved intensity wherever the relevant pattern occurs, and calibrate completeness to that intensity: at 1 the reading pattern is calmed while natural glance-aways survive; at 2 contact is the steady state through all speech; at 3 contact is near-continuous except blinks and momentary natural micro-breaks.",
    "Undershooting an approved intensity is a failure exactly like overshooting it: a result whose gaze still reads as anchored to reading material has failed, and so has a frozen, unblinking stare.",
    "Do not improve, restyle, or change anything outside the approved gaze-correction list.",
  ].join(" "),
  scope: [
    "Correction permission applies only to entries in the plan's CORRECT list, only on the primary subject, and only at the approved intensity.",
    "The permitted change is gaze direction plus the minimal eyelid pose that direction implies — nothing else about the eyes and nothing beyond the eyes.",
    "Categories not listed under CORRECT are protected: whatever their current state, it is intentional and must remain.",
    "The edit is redirection-level: it moves where the eyes rest and never redesigns the eyes, the face, or the performance.",
  ].join(" "),
  locks: {
    identityAndEyeAppearance: [
      "Keep the exact same person, unmistakably recognizable in every frame.",
      "Do not alter facial geometry, bone structure, face or body shape, or apparent age.",
      "The eyes remain the subject's exact eyes: iris color and texture, sclera tone including any natural redness, eye shape and size, lash and brow appearance, and catchlight character all match the source; only direction and natural lid travel may differ.",
      "Permanent features stay: moles, scars, freckles, birthmarks, wrinkles consistent with age, and the facial-hair pattern are part of identity, not imperfections.",
    ].join(" "),
    performanceAndHeadPose: [
      "Keep every gesture, posture shift, head position and rotation, body trajectory, and word at the same corresponding moment.",
      "The head is never re-aimed toward the camera: eye contact is achieved inside the eye sockets alone, on the source's exact head pose at every frame.",
      "Speech articulation is sacred: the subject is reading a script and the delivered audio is the untouched source track, so mouth shapes must form the same phonemes at the same timestamps and lip-sync must remain frame-accurate.",
    ].join(" "),
    blinksAndEyeLife: [
      "Every blink in the source occurs in the output at its source timestamp with natural lid travel; no blink is removed, added, shortened, or stretched.",
      "Corrected gaze keeps living micro-texture — tiny saccades, natural settling, believable moments of thought — and never hardens into pixel-frozen fixation.",
      "Both eyes converge naturally on the lens; gaze correction never produces cross-eyed, wall-eyed, or asymmetric alignment.",
    ].join(" "),
    wardrobeAndOtherPeople: [
      "Keep clothing, accessories, and worn objects exactly as in the source.",
      "Every other visible person is fully protected wherever they move or appear: their gaze, eyes, and everything else remain exactly as filmed.",
    ].join(" "),
    backgroundAndRoom: [
      "Keep every background pixel source-faithful: architecture, furniture, objects, screens, reflections, clutter, and all room content remain exactly as filmed.",
      "No cleanup, decor change, blur, or background adjustment of any kind.",
    ].join(" "),
    lightingAndCamera: [
      "Keep source exposure, contrast, color temperature, saturation, shadows, focus, depth of field, noise character, framing, crop, resolution, perspective, lens feel, camera position, and camera motion unchanged.",
      "No relighting, color grade, glow, reframing, stabilization, or zoom; the only permitted optical difference is the plausible local light response of the eye region to its corrected direction.",
    ].join(" "),
    audio: [
      "Source audio is canonical and restored outside generation.",
      "Do not reinterpret the performance from audio or attempt to generate replacement sound.",
    ].join(" "),
  },
  application: [
    "Apply each approved correction continuously across the full timeline, tracking the subject through motion, expression changes, and partial occlusion.",
    "Corrected gaze must read as attention, not surveillance: the eyes rest on the lens the way they would rest on a person, with the natural softness, settling, and micro-movement of real conversation.",
    "Transitions matter as much as rest states: when the gaze moves — into a retained natural break, back to the lens, into a blink — it travels with believable saccade motion, never popping or teleporting.",
    "The result must read as the same person on the same take who simply knew the camera was a person — never as a re-acted take, a staring contest, or painted-on eyes.",
  ].join(" "),
  negative: [
    "Do not correct, restyle, or alter anything outside the approved CORRECT list.",
    "Do not re-aim, rotate, or re-pose the head, neck, or body to achieve contact; the correction lives in the eyes alone.",
    "Do not remove, add, retime, shorten, or extend any blink.",
    "Do not freeze the eyes into a fixed stare, strip natural micro-saccades, or produce glassy, painted, waxy, or dead eyes.",
    "Do not change iris color or texture, sclera tone, eye shape or size, lash or brow appearance, or catchlight character; do not whiten, brighten, enlarge, or beautify the eyes.",
    "Do not introduce cross-eyed, wall-eyed, or asymmetric gaze.",
    "Do not change the expression, warm the mood, or alter the mouth in any way; do not break lip-sync, change mouth shapes during speech, or re-time any movement.",
    "Do not smooth skin, remove or fade permanent features, or touch hair or wardrobe.",
    "Do not correct or alter any person other than the primary subject.",
    "Do not change the background, room content, lighting, color grade, focus, framing, or camera.",
    "Do not add text, captions, logos, watermarks, graphics, or visible masks.",
    "Do not change playback speed, duration, frame cadence, event timing, or source audio.",
  ],
};

const V1_HEADER = "=== LAMP IRIS EYE-CONTACT MEGA PROMPT v1 ===";
const V2_HEADER = "=== LAMP IRIS EYE-CONTACT MEGA PROMPT v2 ===";
const PLAN_HEADING = "[APPROVED GAZE-CORRECTION PLAN]";
const LOCKS_HEADING = "[INVARIANT LOCKS]";
const CORRECTIONS_HEADING = "[ACTIVE CORRECTIONS FROM EVALUATION]";
const NEVER_DO_HEADING = "[NEVER DO]";

function assertApprovedPlan(plan: LampIrisPlan): LampIrisPlan {
  const canonical = parseLampIrisPlan(plan);
  if (canonical.approval.status !== "approved") {
    throw new Error(
      "Lamp Iris generation requires explicit human approval of the gaze-correction plan."
    );
  }
  if (!lampIrisPlanRequiresGeneration(canonical)) {
    throw new Error(
      "An exceptional no-op must bypass generation and deliver the exact source video."
    );
  }
  return canonical;
}

const INTENSITY_LINES: Record<LampIrisIntensity, string> = {
  1: "intensity 1 of 3 — assist: the pupils visibly lift from the reading position toward the lens, findable in a side-by-side; every natural glance-away and blink survives untouched",
  2: "intensity 2 of 3 — presenter: literal eye contact through speech — the pupils read as IN the lens, not near it, evident at a glance in a same-timestamp side-by-side",
  3: "intensity 3 of 3 — anchor: unmistakable literal eye contact in effectively every frame — a viewer would say the person is looking straight into their eyes",
};

/**
 * What each catalog category must leave untouched, stated inline with the
 * authorization so intensity can never be read as broader permission.
 */
type IrisBandRecipes = Record<LampIrisIntensity, string>;

/**
 * Third-generation recipes (pupil-literal). The second generation demanded
 * visible difference but "toward the lens" still let the model park the
 * gaze NEAR the camera — on the screen an inch below it — which a viewer
 * reads as looking at their chin. Each band now names the pupil target and
 * the perceived-contact test: does the person watching feel looked in the
 * eye. The keep-clause states what survives at every level.
 */
const CATEGORY_RECIPES: Record<
  LampIrisCorrectItem["id"],
  { bands: IrisBandRecipes; keep: string }
> = {
  "camera-axis-anchor": {
    bands: {
      1: "The pupils lift from the screen toward the lens itself: in a side-by-side they sit clearly higher than the source's for most of the take, and the viewer begins to feel looked AT rather than looked NEAR, while honest checks of the material may survive.",
      2: "The pupils aim into the lens — not at the screen below it, not at its neighborhood — in every speaking frame: both pupils converged on the camera's point, upper lids lifted clear of the pupil, none of the source's downward set anywhere it read. Any paused speaking frame reads as direct eye contact with the person watching, and a same-timestamp side-by-side shows plainly different pupil position — and nothing else different.",
      3: "Unbroken literal eye contact: the pupils meet the viewer's eyes through the lens in effectively every frame — iris centered, lids open and engaged — and any single paused frame reads as the subject looking straight at the person watching.",
    },
    keep: "Only gaze direction and natural lid travel change: iris color and texture, sclera, eye shape and size, lashes, brows, and catchlight character remain exactly as filmed, and the head never re-aims.",
  },
  "reading-scan-smoothing": {
    bands: {
      1: "The most conspicuous line-scanning runs settle into steady lens-ward contact; subtler scans may survive where erasing them would cost naturalness.",
      2: "The horizontal reading rhythm is gone in every passage: during speech the pupils hold still-and-steady in the lens with only natural conversational micro-movement, and no left-right text-tracking survives at any timestamp.",
      3: "Zero text-tracking from first word to last: the eyes never once betray a line being read, holding steady living contact with the viewer through every sentence.",
    },
    keep: "Steadiness never becomes stillness: natural conversational micro-saccades and living eye texture survive at every level, and no blink is traded away for smoothness.",
  },
  "note-glance-bridging": {
    bands: {
      1: "Only the longest, most disruptive note-glances are bridged into continued contact; quick natural glances and thinking looks survive as filmed.",
      2: "Habitual note-glances are gone: sentences are delivered into the lens without the source's recurring drop to notes, and only rare deliberate glance-aways survive as natural breaks.",
      3: "Every note-glance is bridged: the only remaining look-aways are momentary natural micro-breaks that read as thought — never as reading.",
    },
    keep: "A bridge never consumes a blink: every source blink lands at its source timestamp with natural lid travel, and bridged passages keep believable saccade motion into and out of every retained break.",
  },
};

const LEGACY_V2_INTENSITY_LINES: Record<LampIrisIntensity, string> = {
  1: "intensity 1 of 3 — assist: a real, findable reduction of the reading pattern in a side-by-side; every natural glance-away and blink survives untouched",
  2: "intensity 2 of 3 — presenter: evident at a glance in a same-timestamp side-by-side — the eyes sit ON the lens through speech and the source's reading gaze is gone",
  3: "intensity 3 of 3 — anchor: unmistakable even without the source — direct to-lens contact in effectively every frame; a viewer would say the person is looking right at them",
};

const LEGACY_V2_CATEGORY_RECIPES: Record<
  LampIrisCorrectItem["id"],
  { bands: IrisBandRecipes; keep: string }
> = {
  "camera-axis-anchor": {
    bands: {
      1: "The resting gaze lifts visibly toward the lens: in a side-by-side the eyes sit clearly higher than the source's for most of the take, the iris riding centered in the aperture instead of settling low, while honest checks of the material may survive.",
      2: "The eyes sit ON the lens axis in every speaking frame: upper lids lifted clear of the pupil, iris centered in the aperture, none of the source's downward set anywhere it read from material. A same-timestamp side-by-side shows plainly different eye direction — and nothing else different.",
      3: "Direct, unbroken to-lens contact: the gaze vector meets the camera in effectively every frame, iris centered, lids open and engaged — any single paused frame reads as eye contact with the viewer.",
    },
    keep: "Only gaze direction and natural lid travel change: iris color and texture, sclera, eye shape and size, lashes, brows, and catchlight character remain exactly as filmed, and the head never re-aims.",
  },
  "reading-scan-smoothing": {
    bands: {
      1: "The most conspicuous line-scanning runs settle into steady lens-ward contact; subtler scans may survive where erasing them would cost naturalness.",
      2: "The horizontal reading rhythm is gone in every passage: during speech the eyes hold still-and-steady on the lens with only natural conversational micro-movement, and no left-right text-tracking survives at any timestamp.",
      3: "Zero text-tracking from first word to last: the eyes never once betray a line being read, holding steady living contact through every sentence.",
    },
    keep: "Steadiness never becomes stillness: natural conversational micro-saccades and living eye texture survive at every level, and no blink is traded away for smoothness.",
  },
  "note-glance-bridging": {
    bands: {
      1: "Only the longest, most disruptive note-glances are bridged into continued contact; quick natural glances and thinking looks survive as filmed.",
      2: "Habitual note-glances are gone: sentences are delivered to the lens without the source's recurring drop to notes, and only rare deliberate glance-aways survive as natural breaks.",
      3: "Every note-glance is bridged: the only remaining look-aways are momentary natural micro-breaks that read as thought — never as reading.",
    },
    keep: "A bridge never consumes a blink: every source blink lands at its source timestamp with natural lid travel, and bridged passages keep believable saccade motion into and out of every retained break.",
  },
};

function renderLegacyCorrectItemV2(item: LampIrisCorrectItem): string {
  const recipe = LEGACY_V2_CATEGORY_RECIPES[item.id];
  return [
    `[${item.id}] ${LEGACY_V2_INTENSITY_LINES[item.intensity]}.`,
    `Target: ${recipe.bands[item.intensity]}`,
    `Always: ${recipe.keep}`,
    `Why: ${item.rationale}`,
  ].join(" ");
}

/**
 * Frozen second-generation plan-block rendering (visibility wording). Runs
 * enqueued on it bind their plan through this exact form.
 */
export function renderLegacyLampIrisPlanBlockV2(plan: LampIrisPlan): string {
  const canonical = assertApprovedPlan(plan);
  return [
    `Plan ID: ${canonical.id}`,
    `Subject: ${canonical.subjectSummary}`,
    "Decision: CORRECT",
    "",
    "CORRECT — apply each item at its approved intensity, and nothing else:",
    canonical.correct
      .map((item) => `- ${renderLegacyCorrectItemV2(item)}`)
      .join("\n"),
    "",
    "GLOBAL DEFAULT: every category, region, person, and pixel not explicitly listed under CORRECT is protected.",
  ].join("\n");
}

const LEGACY_V1_INTENSITY_LINES: Record<LampIrisIntensity, string> = {
  1: "intensity 1 of 3 — natural assist: the reading pattern is visibly calmed; natural glance-aways and every blink survive untouched",
  2: "intensity 2 of 3 — presenter: contact is the steady state through all spoken passages, with brief natural breaks surviving at phrase boundaries",
  3: "intensity 3 of 3 — anchor: near-continuous contact except blinks and momentary natural micro-breaks; alive at every moment, never a fixed stare",
};

const LEGACY_V1_CATEGORY_RECIPES: Record<
  LampIrisCorrectItem["id"],
  { bands: IrisBandRecipes; keep: string }
> = {
  "camera-axis-anchor": {
    bands: {
      1: "The resting gaze settles on the lens between reading moments: the habitual off-lens anchor is clearly weakened, and the subject reads as mostly present with occasional honest checks of their material.",
      2: "The lens IS the resting gaze: whenever the subject is speaking, the eyes sit on the camera axis, and the old off-lens anchor is gone in a side-by-side; brief natural settling off-axis survives only at phrase boundaries.",
      3: "Broadcast-anchor axis: the eyes are centered on the lens through effectively the whole take, and any residual off-axis rest reads as a deliberate, momentary human beat rather than a habit.",
    },
    keep: "Only gaze direction and natural lid travel change: iris color and texture, sclera, eye shape and size, lashes, brows, and catchlight character remain exactly as filmed, and the head never re-aims.",
  },
  "reading-scan-smoothing": {
    bands: {
      1: "The most conspicuous line-scanning runs are calmed into steady contact; shorter or subtler scans may survive where removing them would cost naturalness.",
      2: "Reading scans are gone at a glance: during speech the eyes hold conversational steadiness toward the lens instead of tracking lines of text, in every passage.",
      3: "No readable scanning motion anywhere in the take: nothing in the eyes betrays a text being tracked, from the first word to the last.",
    },
    keep: "Steadiness never becomes stillness: natural conversational micro-saccades and living eye texture survive at every level, and no blink is traded away for smoothness.",
  },
  "note-glance-bridging": {
    bands: {
      1: "Only the longest, most disruptive note-glances are bridged into continued contact; quick natural glances and thinking looks survive as filmed.",
      2: "Habitual note-glances are bridged: sentences are delivered to the viewer without the recurring drop to notes, while rare deliberate glance-aways survive as natural breaks.",
      3: "Every note-glance is bridged: the only remaining look-aways are momentary natural micro-breaks that read as thought, never as reading.",
    },
    keep: "A bridge never consumes a blink: every source blink lands at its source timestamp with natural lid travel, and bridged passages keep believable saccade motion into and out of every retained break.",
  },
};

function renderCorrectItem(item: LampIrisCorrectItem): string {
  const recipe = CATEGORY_RECIPES[item.id];
  return [
    `[${item.id}] ${INTENSITY_LINES[item.intensity]}.`,
    `Target: ${recipe.bands[item.intensity]}`,
    `Always: ${recipe.keep}`,
    `Why: ${item.rationale}`,
  ].join(" ");
}

function renderLegacyCorrectItemV1(item: LampIrisCorrectItem): string {
  const recipe = LEGACY_V1_CATEGORY_RECIPES[item.id];
  return [
    `[${item.id}] ${LEGACY_V1_INTENSITY_LINES[item.intensity]}.`,
    `Target: ${recipe.bands[item.intensity]}`,
    `Always: ${recipe.keep}`,
    `Why: ${item.rationale}`,
  ].join(" ");
}

/**
 * Only approved corrections are rendered. Declined and uncertain categories
 * are deliberately absent from generation input — naming them would put the
 * idea in the model's context (the ring-light lesson from Lamp Background),
 * and the scope line already protects everything unlisted.
 */
export function renderLampIrisPlanBlock(plan: LampIrisPlan): string {
  const canonical = assertApprovedPlan(plan);
  return [
    `Plan ID: ${canonical.id}`,
    `Subject: ${canonical.subjectSummary}`,
    "Decision: CORRECT",
    "",
    "CORRECT — apply each item at its approved intensity, and nothing else:",
    canonical.correct.map((item) => `- ${renderCorrectItem(item)}`).join("\n"),
    "",
    "GLOBAL DEFAULT: every category, region, person, and pixel not explicitly listed under CORRECT is protected.",
  ].join("\n");
}

/**
 * Frozen first-generation plan-block rendering. Runs enqueued before the
 * visibility rewrite bind their plan through this exact form; validators
 * accept it as an alternate rendering of the same hash-bound plan.
 */
export function renderLegacyLampIrisPlanBlockV1(plan: LampIrisPlan): string {
  const canonical = assertApprovedPlan(plan);
  return [
    `Plan ID: ${canonical.id}`,
    `Subject: ${canonical.subjectSummary}`,
    "Decision: CORRECT",
    "",
    "CORRECT — apply each item at its approved intensity, and nothing else:",
    canonical.correct
      .map((item) => `- ${renderLegacyCorrectItemV1(item)}`)
      .join("\n"),
    "",
    "GLOBAL DEFAULT: every category, region, person, and pixel not explicitly listed under CORRECT is protected.",
  ].join("\n");
}

function findCorrectItems(
  plan: LampIrisPlan,
  correction: LampIrisCorrection
): LampIrisCorrectItem[] {
  return correction.planItemIds.map((itemId) => {
    const item = plan.correct.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw new Error(
        `Correction ${correction.id} references a category outside the approved CORRECT list.`
      );
    }
    return item;
  });
}

/**
 * Corrections are rendered from a closed action vocabulary and approved plan
 * entries. No judge-authored instruction is ever copied into provider input.
 */
export function renderLampIrisCorrection(
  plan: LampIrisPlan,
  correction: LampIrisCorrection
): string {
  const canonical = parseLampIrisPlan(plan);
  switch (correction.action) {
    case "restore-identity":
      return "Restore the exact source person's facial geometry, recognizable features, permanent marks, and apparent age at every corresponding moment; gaze correction never changes who the person is.";
    case "restore-performance-lipsync":
      return "Restore the source performance exactly: head position and rotation, gestures, posture, body trajectory, and speech articulation with frame-accurate lip-sync at the same timestamps. The head is never re-aimed; contact lives in the eyes alone.";
    case "complete-approved-gaze-correction": {
      const items = findCorrectItems(canonical, correction);
      return `The previous pass left the gaze reading essentially as the source — that output failed this workflow's one job. Fully apply these approved gaze corrections at their approved intensity wherever the pattern occurs: ${items
        .map((item) => `[${item.id}] at intensity ${item.intensity}`)
        .join("; ")}. Produce plainly different pupil position at the same timestamps: wherever the source's eyes rest on reading material or near the lens, the candidate's pupils are visibly IN the lens — the person watching must feel looked in the eye in a same-frame comparison.`;
    }
    case "reduce-gaze-lock": {
      const items = findCorrectItems(canonical, correction);
      return `Ease these corrections back to their approved intensity — the previous pass over-locked the gaze: ${items
        .map(
          (item) =>
            `[${item.id}] must read as intensity ${item.intensity} of 3, no stronger`
        )
        .join("; ")}. Restore the natural breaks and living texture that level preserves.`;
    }
    case "restore-blink-pattern":
      return "Restore the source blink pattern exactly: every source blink at its source timestamp with natural lid travel, no blink removed, added, shortened, or stretched.";
    case "repair-eye-naturalness":
      return "Restore believable living eyes: natural micro-saccades and settling, eyelid aperture consistent with the corrected direction, both eyes converging naturally on the lens, and the source's exact iris, sclera, lash, brow, and catchlight appearance. No glassy, painted, frozen, or asymmetric eyes.";
    case "remove-unapproved-changes":
      return "Remove every change outside the approved CORRECT list. The face beyond the eyes, the expression, the mouth, skin, hair, wardrobe, and every unlisted region must match the source exactly.";
    case "restore-untouched-surroundings":
      return "Restore the background, room content, other people, lighting, color, focus, framing, and camera exactly to the source everywhere; this workflow edits only the primary subject's gaze.";
  }
}

function renderCorrections(
  plan: LampIrisPlan,
  corrections: LampIrisCorrection[],
  eol = "\n",
  measuredCalibration?: string
): string {
  const lines: string[] = [];
  if (measuredCalibration) {
    lines.push(`1. [CRITICAL] MEASURED CALIBRATION — ${measuredCalibration}`);
  }
  for (const correction of corrections) {
    lines.push(
      `${lines.length + 1}. [${correction.severity.toUpperCase()}] ${renderLampIrisCorrection(
        plan,
        correction
      )}`
    );
  }
  if (lines.length === 0) {
    return "(none — first pass or no safe structured correction was available)";
  }
  return lines.join(eol);
}

export function renderLampIrisMegaPrompt(
  prompt: Omit<LampIrisMegaPrompt, "rendered">
): string {
  const plan = assertApprovedPlan(prompt.plan);
  const base = prompt.base;
  const locks = [
    `IDENTITY & EYE APPEARANCE — ${base.locks.identityAndEyeAppearance}`,
    `PERFORMANCE & HEAD POSE — ${base.locks.performanceAndHeadPose}`,
    `BLINKS & EYE LIFE — ${base.locks.blinksAndEyeLife}`,
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
    renderLampIrisPlanBlock(plan),
    "",
    LOCKS_HEADING,
    locks,
    "",
    "[APPLICATION STANDARD]",
    base.application,
    "",
    CORRECTIONS_HEADING,
    renderCorrections(plan, prompt.corrections, "\n", prompt.measuredCalibration),
    "",
    NEVER_DO_HEADING,
    base.negative.map((instruction) => `- ${instruction}`).join("\n"),
  ].join("\n");
}

export function initialLampIrisMegaPrompt(plan: LampIrisPlan): LampIrisMegaPrompt {
  const canonical = assertApprovedPlan(plan);
  const prompt: Omit<LampIrisMegaPrompt, "rendered"> = {
    version: 1,
    base: LAMP_IRIS_BASE_PROMPT,
    plan: canonical,
    corrections: [],
  };
  return {
    ...prompt,
    rendered: renderLampIrisMegaPrompt(prompt),
  };
}

/**
 * True when the rendered bytes are a faithful initial compile of this exact
 * approved plan — the current form or one of the frozen shipped generations,
 * newest first. Mixed intermediates never shipped, so exactly these forms
 * are valid.
 */
export function isPersistedInitialLampIrisPrompt(
  plan: LampIrisPlan,
  rendered: string
): boolean {
  if (rendered === initialLampIrisMegaPrompt(plan).rendered) return true;
  const generations: Array<{
    base: LampIrisBasePrompt;
    block: (plan: LampIrisPlan) => string;
  }> = [
    { base: LEGACY_V2_IRIS_BASE_PROMPT, block: renderLegacyLampIrisPlanBlockV2 },
    { base: LEGACY_V1_IRIS_BASE_PROMPT, block: renderLegacyLampIrisPlanBlockV1 },
  ];
  for (const generation of generations) {
    try {
      const generationBase = renderLampIrisMegaPrompt({
        version: 1,
        base: generation.base,
        plan,
        corrections: [],
      });
      const currentBlock = renderLampIrisPlanBlock(plan);
      const generationBlock = generation.block(plan);
      const candidate =
        currentBlock === generationBlock
          ? generationBase
          : generationBase.replace(currentBlock, generationBlock);
      if (rendered === candidate) return true;
    } catch {
      // This generation cannot render the plan — try the next.
    }
  }
  return false;
}

function sectionBoundary(
  rendered: string,
  heading: string,
  nextHeading: string
): { bodyStart: number; bodyEnd: number; eol: string } {
  const headingIndex = rendered.indexOf(heading);
  if (headingIndex < 0) {
    throw new Error(`Persisted Lamp Iris prompt has no ${heading}.`);
  }
  const headingEnd = headingIndex + heading.length;
  const eol = rendered.startsWith("\r\n", headingEnd)
    ? "\r\n"
    : rendered.startsWith("\n", headingEnd)
      ? "\n"
      : null;
  if (!eol) {
    throw new Error(
      `Persisted Lamp Iris prompt has an invalid boundary after ${heading}.`
    );
  }
  const bodyStart = headingEnd + eol.length;
  const bodyEnd = rendered.indexOf(`${eol}${eol}${nextHeading}`, bodyStart);
  if (bodyEnd < 0) {
    throw new Error(`Persisted Lamp Iris prompt has no ${nextHeading} boundary.`);
  }
  return { bodyStart, bodyEnd, eol };
}

function renderPersistedV2(
  persistedV1: string,
  plan: LampIrisPlan,
  corrections: LampIrisCorrection[],
  measuredCalibration?: string
): string {
  if (!persistedV1.startsWith(V1_HEADER)) {
    throw new Error(
      "Lamp Iris's persisted initial prompt has an invalid v1 header."
    );
  }
  const planSection = sectionBoundary(persistedV1, PLAN_HEADING, LOCKS_HEADING);
  const persistedPlanBlock = persistedV1.slice(
    planSection.bodyStart,
    planSection.bodyEnd
  );
  // Persisted v1 bytes are immutable: prompts compiled under an earlier
  // generation carry that generation's frozen block. Every shipped form
  // binds the same approved plan.
  const acceptedPlanBlocks = [renderLampIrisPlanBlock(plan)];
  for (const legacyRenderer of [
    renderLegacyLampIrisPlanBlockV2,
    renderLegacyLampIrisPlanBlockV1,
  ]) {
    try {
      acceptedPlanBlocks.push(legacyRenderer(plan));
    } catch {
      // A plan a generation cannot render has no form in it.
    }
  }
  if (!acceptedPlanBlocks.includes(persistedPlanBlock)) {
    throw new Error(
      "The approved gaze-correction plan no longer matches the plan bound into the persisted v1 prompt."
    );
  }

  const correctionsSection = sectionBoundary(
    persistedV1,
    CORRECTIONS_HEADING,
    NEVER_DO_HEADING
  );
  const withV2Header = V2_HEADER + persistedV1.slice(V1_HEADER.length);
  const offset = V2_HEADER.length - V1_HEADER.length;
  return (
    withV2Header.slice(0, correctionsSection.bodyStart + offset) +
    renderCorrections(
      plan,
      corrections,
      correctionsSection.eol,
      measuredCalibration
    ) +
    withV2Header.slice(correctionsSection.bodyEnd + offset)
  );
}

/**
 * Deterministic two-pass compiler. It changes only the version header and
 * correction body in the exact persisted v1 bytes. Corrections may reference
 * approved plan ids but can never create a new gaze edit.
 */
export function compileLampIrisFinalPrompt(
  persistedInitialRendered: string,
  plan: LampIrisPlan,
  firstEvaluation: LampIrisEvaluationArtifact
): LampIrisMegaPrompt {
  const canonical = assertApprovedPlan(plan);
  if (
    typeof persistedInitialRendered !== "string" ||
    persistedInitialRendered.length === 0
  ) {
    throw new Error("Lamp Iris final prompt requires persisted initial bytes.");
  }
  const corrections = collectLampIrisCorrections(firstEvaluation, canonical);
  // Measurements live on the persisted evaluation artifact, so this compile
  // is byte-stable across deploys and replay paths (the LAMP-INTENSITY.md
  // durability rule). No usable measurements → no calibration line.
  const measuredCalibration = firstEvaluation.gazeMeasurements
    ? renderLampIrisMeasuredCalibrationCorrection({
        source: firstEvaluation.gazeMeasurements.source,
        initial: firstEvaluation.gazeMeasurements.candidate,
      }) ?? undefined
    : undefined;
  return {
    version: 2,
    base: LAMP_IRIS_BASE_PROMPT,
    plan: canonical,
    corrections,
    ...(measuredCalibration !== undefined ? { measuredCalibration } : {}),
    rendered: renderPersistedV2(
      persistedInitialRendered,
      canonical,
      corrections,
      measuredCalibration
    ),
  };
}
