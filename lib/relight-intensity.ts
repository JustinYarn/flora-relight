/**
 * Canonical Lamp relight-strength contract.
 *
 * The browser selects one coarse experimental value, while the server
 * deterministically turns that value into prompt bytes. Missing legacy values
 * resolve to 75 because that is the historical Lamp lighting specification.
 */

export const RELIGHT_INTENSITY_MIN = 0;
export const RELIGHT_INTENSITY_MAX = 100;
export const RELIGHT_INTENSITY_STEP = 5;
export const DEFAULT_RELIGHT_INTENSITY = 75;

export interface RelightIntensityProfile {
  label:
    | "Natural lift"
    | "Soft daylight"
    | "Polished natural"
    | "Professional interview"
    | "Strong studio"
    | "Hero studio";
  shortLabel: string;
  description: string;
  faceLiftStops: number;
  keyFillRatio: number;
  promptClause: string;
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

export function relightIntensityProfile(
  value: unknown
): RelightIntensityProfile {
  const intensity = normalizeRelightIntensity(value);
  const measurements = {
    faceLiftStops: roundTo(0.2 + 0.013 * intensity, 0.05),
    keyFillRatio: roundTo(1.2 + 0.024 * intensity, 0.1),
  };

  if (intensity <= 19) {
    return {
      label: "Natural lift",
      shortLabel: "Slight natural daylight",
      description:
        "A gentle off-screen window-light lift that stays close to the source.",
      ...measurements,
      promptClause:
        "Create only a slight, believable daylight lift, as if a large off-screen window added soft natural illumination. Keep the result close to the source at normal viewing size, just easier to read and gently fresher. Keep contrast low, add no deliberate rim light, and preserve the room's existing ambience.",
    };
  }
  if (intensity <= 39) {
    return {
      label: "Soft daylight",
      shortLabel: "Restrained daylight polish",
      description:
        "A clear but unproduced daylight improvement with gentle direction.",
      ...measurements,
      promptClause:
        "Create a clear but restrained natural-daylight improvement. Use a broad, soft, off-screen window-like key with gentle direction and minimal fill. Improve facial readability without making the clip look produced. Separation must come from natural tonal balance, not a visible rim effect.",
    };
  }
  if (intensity <= 59) {
    return {
      label: "Polished natural",
      shortLabel: "Natural professional polish",
      description:
        "Intentional, flattering video-call lighting that still feels ambient.",
      ...measurements,
      promptClause:
        "Create a polished natural video-call look. Use a broad soft directional key and restrained fill for modest facial modelling. Add only feather-light subject separation. The lighting should look intentionally improved but still plausibly ambient and unstaged.",
    };
  }
  if (intensity <= 79) {
    return {
      label: "Professional interview",
      shortLabel: intensity === 75 ? "Current Lamp" : "Professional interview",
      description:
        "A clearly visible, believable interview setup with soft key, fill, and subtle separation.",
      ...measurements,
      promptClause:
        "Create a professional interview look. Use a broad soft key approximately 35–45 degrees camera-left and slightly above eye level, restrained camera-right fill, natural catchlights, and a subtle rim or hair light. The transformation should be clearly visible, polished, and believable in the existing room.",
    };
  }
  if (intensity <= 94) {
    return {
      label: "Strong studio",
      shortLabel: "Premium studio transformation",
      description:
        "An unmistakable high-end studio change with stronger modelling and separation.",
      ...measurements,
      promptClause:
        "Create a strong premium studio-interview transformation. Use pronounced but soft directional facial modelling, controlled fill, clean catchlights, and clear yet natural hair-and-shoulder separation. Hold the background slightly quieter than the subject. The difference should be unmistakable, high-end, and photorealistic.",
    };
  }
  return {
    label: "Hero studio",
    shortLabel: "Maximum source-faithful studio",
    description:
      "The strongest photorealistic hero-interview lighting Lamp can apply without changing content.",
    ...measurements,
    promptClause:
      "Create the maximum source-faithful studio transformation: an unmistakable hero interview setup with strong soft sculpting, refined fill, distinct clean rim separation, and deliberate subject-background depth. Push the lighting change as far as possible without clipping, harshness, halos, theatrical color, beauty filtering, or any content change.",
  };
}

/**
 * Build only the mutable Lamp lighting block. Identity, performance,
 * wardrobe, environment, camera, timing, and audio locks remain in the
 * immutable base prompt at every value.
 */
export function relightLightingDirective(value: unknown): string {
  const intensity = normalizeRelightIntensity(value);
  const profile = relightIntensityProfile(intensity);
  const rimInstruction =
    intensity < 40
      ? "Do not introduce a deliberate rim or hair-light signature."
      : intensity < 60
        ? "Use at most feather-light subject separation; it must not read as a visible effect."
        : intensity < 80
          ? "Use a subtle rim or hair light only where it remains believable in the existing room."
          : "Use clean, controlled hair-and-shoulder separation while avoiding halos or a pasted-on edge.";

  return [
    `Requested relight strength: ${intensity}/100.`,
    `Profile: ${profile.label}.`,
    "",
    "This is the immutable creative target for both Initial and Final. It controls only the magnitude and studio character of illumination. It is not a quality score and grants no permission to change identity, skin texture or apparent age, performance, wardrobe, environment, framing, timing, or source audio.",
    "",
    `Target facial-midtone lift: approximately ${profile.faceLiftStops} stops relative to the source.`,
    `Target key-to-fill contrast: approximately ${profile.keyFillRatio}:1.`,
    "",
    `Style: ${profile.promptClause}`,
    "Key light: Keep the source broad, soft, off-screen, and directionally coherent across the complete clip. Shape illumination rather than applying a uniform exposure increase.",
    "Fill light: Preserve readable shadow detail and natural falloff while holding the requested key-to-fill target.",
    `Rim light: ${rimInstruction}`,
    "Color temperature: Neutral-to-subtly-warm white in the 4800–5600K range, consistent across the full clip. Preserve natural skin and clean whites.",
    `Mood: ${profile.shortLabel}; photorealistic, source-faithful, and plausibly achievable in the unchanged room.`,
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
