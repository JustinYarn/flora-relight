/**
 * Canonical Lamp relight-strength contract.
 *
 * The browser selects one coarse experimental value, while the server
 * deterministically turns that value into prompt bytes AND evaluation
 * criteria. Missing legacy values resolve to 75 because that is the
 * historical Lamp lighting specification.
 *
 * WHY THIS FILE LOOKS THE WAY IT DOES (calibration evidence, 2026-07-16):
 * the first slider iteration changed only six soft adjectives inside the
 * [LIGHTING SPECIFICATION] block while every lock and negative stayed fixed.
 * A live 25-vs-100 A/B produced Initial takes 4% apart in average luma while
 * back-to-back takes of the SAME prompt varied by 10% — the slider's signal
 * was smaller than sampling noise, and both Finals regressed to the source.
 * The redesigned ladder therefore (1) widens the per-band creative range,
 * including band-scoped negatives, (2) scopes the evaluator's criteria to the
 * requested band, and (3) feeds deterministic luma measurements of the
 * Initial take back into the Final prompt so the second generation is a
 * steered calibration pass, never a blind re-roll.
 */

export const RELIGHT_INTENSITY_MIN = 0;
export const RELIGHT_INTENSITY_MAX = 100;
export const RELIGHT_INTENSITY_STEP = 5;
export const DEFAULT_RELIGHT_INTENSITY = 75;

export interface RelightIntensityBand {
  /** Inclusive intensity range this band owns. */
  min: number;
  max: number;
  label:
    | "Daylight lift"
    | "Soft daylight"
    | "Pro video call"
    | "Broadcast interview"
    | "Premium studio"
    | "Cinematic hero";
}

/** The six named looks the slider travels through, lowest to highest. */
export const RELIGHT_INTENSITY_BANDS: readonly RelightIntensityBand[] = [
  { min: 0, max: 19, label: "Daylight lift" },
  { min: 20, max: 39, label: "Soft daylight" },
  { min: 40, max: 59, label: "Pro video call" },
  { min: 60, max: 79, label: "Broadcast interview" },
  { min: 80, max: 94, label: "Premium studio" },
  { min: 95, max: 100, label: "Cinematic hero" },
];

export interface RelightIntensityProfile {
  label: RelightIntensityBand["label"];
  shortLabel: string;
  description: string;
  /** Approximate facial-midtone lift vs the source, in stops. */
  faceLiftStops: number;
  /** Approximate key-to-fill contrast ratio (N:1). */
  keyFillRatio: number;
  /** Approximate background level vs the source, in signed stops. */
  backgroundStops: number;
  /** One-line rim/separation character for targets and UI. */
  rim: string;
  /** The band's style paragraph — the core creative direction. */
  promptClause: string;
  /** Per-band key/fill/rim/background/color/mood directive lines. */
  light: {
    keyLight: string;
    fillLight: string;
    rimLight: string;
    backgroundLight: string;
    colorTemperature: string;
    mood: string;
  };
  /** Creative permissions the base contract would otherwise read as forbidden. */
  allowances: string[];
  /** Extra prohibitions that only apply at this band. */
  restraints: string[];
}

export function isRelightIntensity(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RELIGHT_INTENSITY_MIN &&
    value <= RELIGHT_INTENSITY_MAX &&
    value % RELIGHT_INTENSITY_STEP === 0
  );
}

/** Legacy or malformed persisted values fail closed to historical Lamp. */
export function normalizeRelightIntensity(value: unknown): number {
  return isRelightIntensity(value) ? value : DEFAULT_RELIGHT_INTENSITY;
}

function roundTo(value: number, increment: number): number {
  return Number((Math.round(value / increment) * increment).toFixed(2));
}

/**
 * Piecewise-linear interpolation over fixed anchor points, so numeric targets
 * move monotonically WITHIN a band as well as across bands. Anchors sit at
 * band edges; the curve is deterministic for every legal slider value.
 */
const ANCHOR_INTENSITIES = [0, 20, 40, 60, 80, 95, 100] as const;

function interpolateAnchors(
  intensity: number,
  values: readonly number[]
): number {
  for (let i = 0; i < ANCHOR_INTENSITIES.length - 1; i += 1) {
    const left = ANCHOR_INTENSITIES[i];
    const right = ANCHOR_INTENSITIES[i + 1];
    if (intensity <= right) {
      const t = (intensity - left) / (right - left);
      return values[i] + (values[i + 1] - values[i]) * Math.max(0, t);
    }
  }
  return values[values.length - 1];
}

/**            anchors at:          0     20    40    60    80    95    100 */
const FACE_LIFT_ANCHORS = [0.35, 0.6, 0.9, 1.1, 1.25, 1.45, 1.55] as const;
const KEY_FILL_ANCHORS = [1.2, 1.5, 2.0, 2.5, 3.2, 4.2, 5.0] as const;
const BACKGROUND_ANCHORS = [0.1, 0.1, 0.0, -0.3, -0.9, -1.5, -1.8] as const;

export function relightIntensityMeasurableTargets(value: unknown): {
  faceLiftStops: number;
  keyFillRatio: number;
  backgroundStops: number;
} {
  const intensity = normalizeRelightIntensity(value);
  return {
    faceLiftStops: roundTo(interpolateAnchors(intensity, FACE_LIFT_ANCHORS), 0.05),
    keyFillRatio: roundTo(interpolateAnchors(intensity, KEY_FILL_ANCHORS), 0.1),
    backgroundStops: roundTo(
      interpolateAnchors(intensity, BACKGROUND_ANCHORS),
      0.05
    ),
  };
}

export function relightIntensityProfile(
  value: unknown
): RelightIntensityProfile {
  const intensity = normalizeRelightIntensity(value);
  const targets = relightIntensityMeasurableTargets(intensity);

  if (intensity <= 19) {
    return {
      label: "Daylight lift",
      shortLabel: "Near-invisible daylight lift",
      description:
        "As if a large window just out of frame let in soft morning daylight — the same room, simply fresher and easier to read. No production signature at all.",
      ...targets,
      rim: "none — no separation effect of any kind",
      promptClause:
        "Brighten this footage as if a large window just out of frame began letting in soft morning daylight. The edit must be nearly invisible: the same room, the same ambience, simply fresher, clearer, and easier to read. No production signature of any kind — no visible key direction, no rim, no grade. At normal viewing size the viewer should suspect only that the weather improved.",
      light: {
        keyLight:
          "A broad, sourceless daylight lift with at most a whisper of direction. It should read as ambient window light filling the room, never as a placed fixture.",
        fillLight:
          "Shadows lift naturally with the ambient light; keep their original softness and character rather than imposing a fill structure.",
        rimLight: "None. Do not introduce any separation effect.",
        backgroundLight:
          "The room brightens with the same gentle daylight as the subject and stays within a tenth of a stop of its source relationship — no deliberate subject-background contrast.",
        colorTemperature:
          "Hold the source's color character, gently cleaned: whites a touch fresher, skin unchanged, no styling.",
        mood: "Fresh, honest, untouched — a better-weather day in the same room.",
      },
      allowances: [
        "A soft, even brightness lift with source-plausible falloff is the requested outcome at this strength; direction may be barely perceptible.",
      ],
      restraints: [
        "Do not introduce a visible directional key, rim accent, contrast grade, or any color styling — the result must read as better weather, not as production lighting.",
      ],
    };
  }
  if (intensity <= 39) {
    return {
      label: "Soft daylight",
      shortLabel: "Bright, airy window light",
      description:
        "A clear daylight improvement: a broad window-like source with gentle direction, clean whites, an airy feel — pleasant and unproduced.",
      ...targets,
      rim: "none — separation from tonal balance only",
      promptClause:
        "Relight this as a bright, airy daylight scene: a broad, soft, window-like source from slightly camera-left lifts the face, whites turn clean, and the whole room feels naturally brighter. Direction is gentle but present. It should look like a well-chosen seat beside a big window on a bright day — clearly nicer than the source, and still completely unproduced.",
      light: {
        keyLight:
          "A broad, soft, window-like key from gently camera-left, large-source in quality, with a soft, wide falloff across the face — felt as direction, never seen as a fixture.",
        fillLight:
          "Ambient daylight fill keeps the shadow side open and readable; preserve a gentle, natural key-to-shadow difference without a produced fill structure.",
        rimLight:
          "None. Any separation must come from natural tonal balance, not an edge effect.",
        backgroundLight:
          "The room may brighten slightly with the daylight; keep it within about a tenth of a stop of its source relationship to the subject.",
        colorTemperature:
          "Clean neutral daylight, 5000–5600K, consistent across the clip; whites clean, skin natural.",
        mood: "Airy, bright, optimistic — natural daylight at its best.",
      },
      allowances: [
        "A clearly visible daylight brightening of the entire scene is requested; it may read as an obvious improvement while staying plausibly un-lit.",
      ],
      restraints: [
        "No rim or hair-light signature, no studio contrast, no grade — the scene must remain believably daylight-only.",
      ],
    };
  }
  if (intensity <= 59) {
    return {
      label: "Pro video call",
      shortLabel: "Polished creator video-call look",
      description:
        "The look of a top-tier remote presenter: an intentional soft key with tidy fill and a clean catchlight — 'excellent webcam setup', not a studio.",
      ...targets,
      rim: "feather-light separation only",
      promptClause:
        "Create the polished look of a top-tier remote presenter: a clearly intentional but soft key shapes the face from about 30–40 degrees camera-left, shadows stay open under tidy fill, and the eyes carry a small clean catchlight. The room reads exactly as-is, professionally tidy in tone. This is 'excellent webcam setup done by someone who cares', not a studio.",
      light: {
        keyLight:
          "A soft, clearly intentional key from roughly 30–40 degrees camera-left near eye level, with visible but gentle facial modelling and a small, clean catchlight in both eyes.",
        fillLight:
          "Tidy fill from camera-right keeps the shadow side fully readable; modest, controlled contrast that flatters without drama.",
        rimLight:
          "At most feather-light separation; it must never read as a visible effect.",
        backgroundLight:
          "Hold the room at its source level, tidied in tone; no deliberate darkening or brightening beyond the spill of the key.",
        colorTemperature:
          "Neutral 4800–5400K, consistent across the clip; skin natural and healthy, whites clean.",
        mood: "Competent, polished, approachable — the best version of a real home office.",
      },
      allowances: [
        "An intentionally lit look is requested at this strength — the improvement should be obvious while remaining plausible for a high-end webcam setup.",
      ],
      restraints: [
        "No visible rim signature, no background manipulation, no grade beyond clean neutral color.",
      ],
    };
  }
  if (intensity <= 79) {
    return {
      label: "Broadcast interview",
      shortLabel:
        intensity === DEFAULT_RELIGHT_INTENSITY
          ? "Current Lamp"
          : "Produced broadcast interview",
      description:
        "A clearly produced interview setup: soft key, restrained fill, subtle rim, the background sitting slightly quieter than the subject.",
      ...targets,
      rim: "subtle, believable rim/hair light",
      promptClause:
        "Create a professional broadcast-interview look. Use a broad soft key approximately 35–45 degrees camera-left and slightly above eye level, restrained camera-right fill, natural catchlights, and a subtle rim or hair light. Let the background sit slightly quieter than the subject so the person clearly reads first. The transformation should be clearly visible, polished, and believable in the existing room.",
      light: {
        keyLight:
          "A broad, soft, gently directional key from approximately 35–45 degrees camera-left, slightly above eye level, with softbox-quality modelling, a soft jaw/nose shadow edge, and natural catchlights.",
        fillLight:
          "Restrained camera-right fill with natural falloff; shadow detail stays readable while the key's modelling clearly leads.",
        rimLight:
          "A subtle rim/hair light from behind-opposite the key, tracing a fine edge on hair and shoulders — depth, not an effect.",
        backgroundLight:
          "Deliberately hold the room slightly quieter than the subject — roughly a third to two-thirds of a stop below its source relationship — so the person reads first.",
        colorTemperature:
          "Neutral-to-subtly-warm white, 4800–5600K, consistent across the clip; natural skin, clean whites.",
        mood: "Polished, confident, professional — a well-produced interview or premium video call.",
      },
      allowances: [
        "A clearly produced, studio-adjacent treatment is requested: visible key direction, a subtle rim, and a background held modestly quieter than the subject are all part of the target.",
      ],
      restraints: [
        "Keep the treatment believable in the existing room: no theatrical contrast, no color styling, no background falloff beyond the modest target.",
      ],
    };
  }
  if (intensity <= 94) {
    return {
      label: "Premium studio",
      shortLabel: "Unmistakable premium studio",
      description:
        "A high-end corporate-documentary studio look: sculpted key, defined rim, the background deliberately about a stop darker with smooth falloff.",
      ...targets,
      rim: "defined, clean hair-and-shoulder rim",
      promptClause:
        "Transform this into an unmistakable premium studio interview — the look of a high-end corporate documentary. A sculpted soft key models the face with confident contrast, a defined hair-and-shoulder rim separates the subject cleanly, and the background deliberately falls about a stop darker with smooth, natural falloff so the person glows against a quieter room. Controlled speculars, rich but truthful color. Expensive and intentional, and still unmistakably photoreal.",
      light: {
        keyLight:
          "A sculpted, soft directional key from 35–45 degrees camera-left, above eye level: pronounced but flattering facial modelling, crisp catchlights, gradual highlight roll-off with full highlight detail.",
        fillLight:
          "Controlled, deliberately restrained fill: the shadow side keeps detail but sits clearly below the key, giving confident three-dimensional contrast.",
        rimLight:
          "A defined, clean hair-and-shoulder rim from behind-opposite the key — bright enough to clearly separate the subject, never a halo or pasted edge.",
        backgroundLight:
          "Deliberately darken the room's illumination to roughly a stop below its source relationship to the subject, with smooth natural falloff deepening away from the subject; every object stays exactly where it is, simply receiving less light.",
        colorTemperature:
          "Neutral-to-warm studio white, 4600–5400K on the subject; the darker background may cool very slightly; skin rich, truthful, never orange.",
        mood: "Premium, sculpted, intentional — an expensive corporate-documentary interview.",
      },
      allowances: [
        "Deliberate background darkening of roughly 0.7–1.2 stops with smooth falloff is part of the requested look — this is intended illumination change, not a content change.",
        "Confident, controlled contrast that clearly exceeds a believable webcam setup is requested; the result should read as a professional studio, not a home office.",
      ],
      restraints: [
        "No theatrical color washes, no visible fixtures, no halos or matte edges around the subject, no clipped facial highlights.",
      ],
    };
  }
  return {
    label: "Cinematic hero",
    shortLabel: "Maximum cinematic hero interview",
    description:
      "A prestige-documentary hero treatment: boldly sculpted key, crisp rim, the room plunging into moody darkness well over a stop down, filmic contrast.",
    ...targets,
    rim: "strong, crisp rim — a bright clean edge",
    promptClause:
      "Push to a full cinematic hero-interview treatment — the dramatic, filmic look of a prestige streaming documentary. A strongly sculpted soft key carves the face with bold but flattering modelling; a crisp rim draws a bright, clean edge along hair and shoulders; and the room plunges into moody darkness well over a stop below the subject, its objects intact but receding into cinematic shadow. Filmic contrast with gentle highlight roll-off. Skin keeps every pore. A restrained, motivated color character — subtly warm skin against cooler, darker surroundings — is welcome. The result should look expensively lit on a set, while remaining photoreal: the same person, the same room, the same performance.",
    light: {
      keyLight:
        "A strongly sculpted soft key from 35–50 degrees camera-left, above eye level: bold, deliberate facial modelling with a clearly directional shadow side, crisp catchlights, and gradual filmic highlight roll-off holding full detail.",
      fillLight:
        "Minimal, precise fill: the shadow side of the face stays legible but deep, carrying real contrast — dramatic, flattering, controlled.",
      rimLight:
        "A strong, crisp rim from behind-opposite the key, drawing a bright clean edge along hair and shoulders for definitive subject-background separation — never a glow or halo.",
      backgroundLight:
        "Plunge the room's illumination well over a stop below its source relationship — moody, cinematic darkness deepening smoothly away from the subject. Every object remains exactly in place, simply falling into shadow; the falloff must read as light dying naturally in a real room.",
      colorTemperature:
        "Motivated split character: skin holds a subtly warm 4400–5200K while the darkened room may drift gently cooler; the contrast stays restrained and photoreal, never a color wash.",
      mood: "Cinematic, dramatic, prestige — the hero interview of a high-end streaming documentary.",
    },
    allowances: [
      "Deep, deliberate background falloff of roughly 1.3–2.0 stops is the core of the requested look — intended illumination change, not a content change.",
      "A restrained filmic contrast curve and a subtly motivated color character (warm subject, cooler dark surround) are requested at this strength.",
      "The lighting change should be unmistakable and dramatic — a timid, believable-webcam result is a failure at this strength.",
    ],
    restraints: [
      "The background falloff must never read as a vignette filter, spotlight circle, or masked matte — only as light falling away naturally in a real room.",
      "No halos, no glow, no beauty smoothing, no clipped facial highlights, no visible fixtures, no theatrical color washes.",
    ],
  };
}

/**
 * The two base negatives that are strength-sensitive. At low strengths a
 * gentle ambient lift IS the product; at high strengths a filmic grade IS the
 * product. Rendering the fixed versions at every strength is what pinched the
 * first slider's dynamic range to nothing.
 */
const BASE_NEGATIVE_FLAT_LIFT_PREFIX = "No globally flat exposure lift";
const BASE_NEGATIVE_STYLISTIC_PREFIX = "Do not apply any stylistic look";

/** Band-scope the immutable negative list for the requested strength. */
export function relightNegativeBlock(
  value: unknown,
  baseNegative: readonly string[]
): string[] {
  const intensity = normalizeRelightIntensity(value);
  return baseNegative.map((item) => {
    if (intensity <= 39 && item.startsWith(BASE_NEGATIVE_FLAT_LIFT_PREFIX)) {
      return "A gentle, even daylight lift is the requested outcome at this strength — do not force a visible directional key, rim accent, or contrast grade onto it.";
    }
    if (item.startsWith(BASE_NEGATIVE_STYLISTIC_PREFIX)) {
      if (intensity <= 19) {
        return "Do not apply any stylistic look or grade — no film emulation, HDR tone-mapping, painterly or anime rendering, and no color styling beyond a clean neutral daylight correction. The edit must stay near-invisible.";
      }
      if (intensity <= 39) {
        return "Do not apply any stylistic look or grade — no film emulation, HDR tone-mapping, painterly or anime rendering, and no color styling beyond a clean neutral daylight correction. The improvement must remain believably daylight, never produced.";
      }
      if (intensity >= 95) {
        return "Do not drift into film-emulation presets, HDR tone-mapping, painterly or anime rendering, or costume-drama color washes. A restrained filmic contrast curve and a subtly motivated color character are part of the requested cinematic look; skin must remain truthful and photoreal, never stylized.";
      }
      if (intensity >= 80) {
        return "Do not apply film emulation, HDR tone-mapping, painterly or anime rendering, or theatrical color washes. Confident contrast and deliberate subject-background separation are part of the requested look; hue-shifting stylization is not. The result must stay photorealistic.";
      }
      return item;
    }
    return item;
  });
}

/**
 * Build only the mutable Lamp lighting block. Identity, performance,
 * wardrobe, environment-content, camera, timing, and audio locks remain in
 * the immutable base prompt at every value.
 */
export function relightLightingDirective(value: unknown): string {
  const intensity = normalizeRelightIntensity(value);
  const profile = relightIntensityProfile(intensity);
  const band =
    RELIGHT_INTENSITY_BANDS.find(
      (candidate) => intensity >= candidate.min && intensity <= candidate.max
    ) ?? RELIGHT_INTENSITY_BANDS[RELIGHT_INTENSITY_BANDS.length - 1];
  const bandIndex = RELIGHT_INTENSITY_BANDS.indexOf(band) + 1;
  const backgroundSigned =
    profile.backgroundStops > 0
      ? `+${profile.backgroundStops}`
      : `${profile.backgroundStops}`;

  return [
    `Requested relight strength: ${intensity}/100.`,
    `Profile: ${profile.label} (band ${bandIndex} of ${RELIGHT_INTENSITY_BANDS.length}).`,
    "",
    "This is the immutable creative target for both Initial and Final. It controls the magnitude and character of illumination only. It is not a quality score and grants no permission to change identity, skin texture or apparent age, performance, wardrobe, environment content, framing, timing, or source audio.",
    "",
    "MEASURABLE TARGETS AT THIS STRENGTH",
    `- Facial-midtone lift vs source: approximately ${profile.faceLiftStops > 0 ? "+" : ""}${profile.faceLiftStops} stops`,
    `- Key-to-fill contrast: approximately ${profile.keyFillRatio}:1`,
    `- Background level vs source: approximately ${backgroundSigned} stops`,
    `- Rim/separation: ${profile.rim}`,
    "",
    `Style: ${profile.promptClause}`,
    `Key light: ${profile.light.keyLight}`,
    `Fill light: ${profile.light.fillLight}`,
    `Rim light: ${profile.light.rimLight}`,
    `Background light: ${profile.light.backgroundLight}`,
    `Color temperature: ${profile.light.colorTemperature}`,
    `Mood: ${profile.light.mood}`,
    "",
    "PERMITTED AT THIS STRENGTH (the base locks otherwise hold in full):",
    ...profile.allowances.map((line) => `- ${line}`),
    "NOT PERMITTED AT THIS STRENGTH:",
    ...profile.restraints.map((line) => `- ${line}`),
    "",
    `Critique corrections are subordinate to this contract. They may repair fidelity, directionality, temporal stability, masking, exposure balance, highlight roll-off, or execution of this profile, but they must not strengthen or weaken the overall relight beyond ${intensity}/100.`,
  ].join("\n");
}

/** Read the explicit target from non-default persisted Lamp prompt bytes. */
export function parseRelightIntensityFromPrompt(
  renderedPrompt: string
): number | null {
  const match = renderedPrompt.match(
    /Requested relight strength:\s*(\d{1,3})\/100\./
  );
  if (!match) return null;
  const parsed = Number(match[1]);
  return isRelightIntensity(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Deterministic luma measurements — the calibration half of the contract.
// ---------------------------------------------------------------------------

/**
 * Region-averaged luma deltas of a candidate video vs its source, in stops.
 * Produced deterministically (ffmpeg signalstats over fixed sample points and
 * fixed crops) at zero provider cost. `center` approximates the subject in
 * webcam framing; `border` approximates the background.
 */
export interface RelightLumaMeasurements {
  globalStops: number;
  centerStops: number;
  borderStops: number;
  sampleCount: number;
}

export function isRelightLumaMeasurements(
  value: unknown
): value is RelightLumaMeasurements {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.globalStops === "number" &&
    Number.isFinite(record.globalStops) &&
    typeof record.centerStops === "number" &&
    Number.isFinite(record.centerStops) &&
    typeof record.borderStops === "number" &&
    Number.isFinite(record.borderStops) &&
    Number.isSafeInteger(record.sampleCount) &&
    (record.sampleCount as number) > 0
  );
}

const CENTER_LIFT_TOLERANCE_STOPS = 0.25;
const BACKGROUND_TOLERANCE_STOPS = 0.35;

function formatStops(value: number): string {
  const rounded = roundTo(value, 0.05);
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}`;
}

/**
 * Compile the measured state of the Initial take into one deterministic
 * calibration instruction for the Final prompt. This exists because a live
 * A/B showed back-to-back takes of the same prompt varying by more than the
 * whole slider's effect: without a measured anchor, the Final generation is a
 * re-roll that can silently regress below the requested strength.
 */
export function relightMeasuredCalibrationCorrection(
  value: unknown,
  measurements: RelightLumaMeasurements
): string {
  const intensity = normalizeRelightIntensity(value);
  const profile = relightIntensityProfile(intensity);
  const centerError = measurements.centerStops - profile.faceLiftStops;
  const backgroundError = measurements.borderStops - profile.backgroundStops;

  const subjectVerdict =
    Math.abs(centerError) <= CENTER_LIFT_TOLERANCE_STOPS
      ? `on target — reproduce this magnitude exactly; do not drift brighter, darker, or softer`
      : centerError < 0
        ? `${formatStops(Math.abs(centerError))} stops SHORT of the target — increase the key's strength decisively until the face reads approximately ${formatStops(profile.faceLiftStops)} stops above the source`
        : `${formatStops(centerError)} stops PAST the target — reduce the lift until the face reads approximately ${formatStops(profile.faceLiftStops)} stops above the source`;

  const backgroundVerdict =
    Math.abs(backgroundError) <= BACKGROUND_TOLERANCE_STOPS
      ? `on target — hold this background relationship`
      : backgroundError > 0
        ? `${formatStops(backgroundError)} stops too BRIGHT for the target — take the room's illumination down to approximately ${formatStops(profile.backgroundStops)} stops vs source, with smooth natural falloff`
        : `${formatStops(Math.abs(backgroundError))} stops too DARK for the target — bring the room's illumination up to approximately ${formatStops(profile.backgroundStops)} stops vs source`;

  return [
    `MEASURED CALIBRATION (deterministic, ffmpeg region luma of the previous take vs source, ${measurements.sampleCount} samples):`,
    `subject region measured ${formatStops(measurements.centerStops)} stops vs a ${formatStops(profile.faceLiftStops)}-stop target: ${subjectVerdict}.`,
    `Background region measured ${formatStops(measurements.borderStops)} stops vs a ${formatStops(profile.backgroundStops)}-stop target: ${backgroundVerdict}.`,
    `These magnitudes are ground truth; execute them within the requested ${intensity}/100 ${profile.label} profile.`,
  ].join(" ");
}
