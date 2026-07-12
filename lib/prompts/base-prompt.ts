import type { RelightBasePrompt } from "@/lib/types";

/**
 * RELIGHT_BASE_PROMPT — the immutable constraint block.
 *
 * This never changes between iterations. It frames the video model as a
 * LIGHTING PROPAGATOR sitting between two ground truths:
 *   - the ORIGINAL video (structural ground truth: content, geometry, motion, timing)
 *   - the approved LOOK ANCHOR frame (photometric ground truth: the light itself)
 *
 * Pink-elephant discipline: every lock is a REGION-SCOPED PROHIBITION.
 * We never name a mutable attribute positively ("keep the red shirt red"
 * invites the model to repaint the shirt — and bakes caption errors into the
 * prompt). The Scene Manifest carries the positive inventory, and it is used
 * by EVALS only, never rendered into this prompt.
 */
export const RELIGHT_BASE_PROMPT: RelightBasePrompt = {
  task: [
    "Relight and color-grade this exact video as a SOURCE-FAITHFUL EDIT of the existing footage: modify illumination and color response only.",
    "You are operating as a LIGHTING PROPAGATOR, not a creative director.",
    "Your single job is to carry the illumination of the approved anchor frame across every frame of the original video.",
    "The original video is the structural ground truth: every pixel of content, geometry, motion, and timing comes from it.",
    "The anchor frame is the photometric ground truth: every quality of light — direction, softness, contrast, color temperature, subject-background separation — comes from it.",
    "Produce the original performance, exactly as recorded, under the anchor's light.",
    "The test for every change you make is simple: if a difference cannot be explained purely as a change of illumination or color response, do not make it.",
  ].join(" "),

  locks: {
    identity: [
      "Do not alter the person's face, head shape, facial structure, skin texture, apparent age, or any feature by which they could be recognized.",
      "Moles, scars, freckles, facial hair, and skin detail must remain exactly where they are in the source.",
      "Render source skin faithfully: the same complexion, undertone, pores, fine lines, blemishes, facial hair, natural color variation, microcontrast, reflectance, and apparent age — all at their ORIGINAL strength.",
      "The output must contain the same human being, frame for frame.",
      "Change how light falls on the face; never change the face itself.",
    ].join(" "),
    performance: [
      "Do not alter any motion.",
      "Every gesture, posture shift, blink, head turn, and lip movement must occur at the same frame index and follow the same trajectory as in the original video.",
      "Do not re-time, smooth, dampen, exaggerate, or re-animate anything.",
      "The performance is fixed; only its illumination changes.",
    ].join(" "),
    wardrobe: [
      "Do not alter any garment, accessory, or worn object.",
      "No change to cut, fit, fabric, construction, pattern geometry, or presence — nothing worn may appear, disappear, or transform.",
      "Everything on the person in the original must appear identical in the output, differing only in how it is lit.",
    ].join(" "),
    background: [
      "Do not add, remove, move, resize, or replace any object or surface in the environment.",
      "The room stays exactly as it is.",
      "Shadows, brightness, and color temperature on the environment may change as a natural consequence of the new lighting; the environment itself may not.",
    ].join(" "),
    camera: [
      "Do not change framing, crop, zoom, camera position, lens characteristics, perspective, or resolution.",
      "Frame N of the output must be spatially registered with frame N of the input: same composition, same borders, same subject placement.",
      "No stabilization, no reframing, no push-in.",
    ].join(" "),
    audio: [
      "Ignore audio entirely.",
      "The original audio stream is preserved outside this system and will be remuxed onto the final video byte-for-byte after generation.",
      "Generate video frames only; do not attempt to interpret, synchronize to, or reproduce any sound.",
    ].join(" "),
  },

  lighting: {
    style:
      "Three-point professional studio lighting, executed with restraint so the result remains fully believable in a home-office webcam setting — a clearly visible, high-end professional studio interview look, not a stage. Matte-to-satin finish with gradual highlight roll-off; preserve full highlight detail.",
    keyLight:
      "Broad, soft, gently directional key from approximately 45 degrees camera-left, positioned slightly above the subject's eye level. Large-source quality, as from a diffused softbox: gentle modelling across the face, a soft shadow edge under the jaw and nose, and a small natural catchlight in the eyes. Measurable target: lift facial midtones approximately 1.0–1.25 stops across the forehead, both cheeks, and chin, so the face reads as professionally lit at normal viewing size.",
    fillLight:
      "Restrained fill from camera-right at low intensity with natural falloff, lifting the shadow side of the face so detail stays readable without flattening the key's modelling. Preserve the natural key-to-shadow difference. Target a flattering key-to-fill contrast around 2:1 to 3:1.",
    rimLight:
      "A subtle rim/hair light from behind and above the subject, opposite the key, tracing a fine edge of light along the hair and shoulders. It exists to separate the subject from the background and should read as depth, not as a visible effect.",
    colorTemperature:
      "Neutral-to-subtly-warm white in the 4800-5600K range, held consistent across the entire clip. Skin renders natural and healthy; whites stay white; no mixed-temperature conflict between subject and background.",
    mood: "Polished, confident, professional — the lighting of a well-produced interview or premium video call, with a natural matte-to-satin skin response, gradual highlight roll-off, local contrast preserved around the eyes, nose, mouth, and jaw, and three-dimensional facial modeling intact. Cinematic in quality, yet plausibly achievable in the room shown; flattering contrast, never theatrical.",
  },

  negative: [
    "Do not add or remove any object, person, or element anywhere in the frame.",
    "Do not render any new lamp, softbox, window, practical, or other light source as a visible object in the frame — the new lighting arrives as illumination only, its fixtures forever off-screen.",
    "Do not replace, repaint, redecorate, blur, or restyle the background.",
    "Do not smooth, retouch, or beautify skin; preserve pores, lines, and natural texture exactly.",
    "No beautification, smoothing, waxiness, or apparent-age change — skin structure ships at its original strength.",
    "No globally flat exposure lift in place of directional shaping — the relight must read as a directional key with natural falloff, not a uniform brightness increase.",
    "One coherent lighting treatment, stable from first frame to last — no drift in exposure, direction, fill ratio, or white balance.",
    "Do not reframe, crop, zoom, stabilize, or move the camera.",
    "Do not change playback speed, duration, frame count, or the timing of any event.",
    "Do not add text, captions, subtitles, logos, watermarks, or graphic overlays.",
    "Do not apply any stylistic look — no film emulation, HDR tone-mapping, painterly or anime rendering, or color grading beyond the specified lighting. This is a photorealistic relight only.",
  ],
};
