import { RELIGHT_BASE_PROMPT } from "@/lib/prompts/base-prompt";

/** Canonical instruction for the full-loop live Stage-A still-image relight. */
export function canonicalLiveAnchorPrompt(): string {
  const lighting = RELIGHT_BASE_PROMPT.lighting;
  return [
    `Relight this single video frame. ${RELIGHT_BASE_PROMPT.task}`,
    "",
    "Apply exactly this lighting specification:",
    `Style: ${lighting.style}`,
    `Key light: ${lighting.keyLight}`,
    `Fill light: ${lighting.fillLight}`,
    `Rim light: ${lighting.rimLight}`,
    `Color temperature: ${lighting.colorTemperature}`,
    `Mood: ${lighting.mood}`,
    "",
    "Change illumination and color response only — do not alter the person, wardrobe, background, or framing.",
  ].join("\n");
}

/** Scripted mock path uses this shorter request; the mock output is not semantic. */
export const DEMO_ANCHOR_PROMPT =
  "Relight this frame to a soft three-point studio look. Change illumination only — do not alter the person, wardrobe, background, or framing.";
