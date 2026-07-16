import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DEFAULT_RELIGHT_INTENSITY,
  isRelightIntensity,
  normalizeRelightIntensity,
  parseRelightIntensityFromPrompt,
  relightIntensityProfile,
} from "../lib/relight-intensity.ts";
import {
  initialMegaPrompt,
  renderMegaPrompt,
} from "../lib/prompts/mega-prompt.ts";
import { LAMP_RELIGHT_BASE_PROMPT } from "../lib/prompts/base-prompt.ts";
import {
  compileLampFinalPrompt,
  LAMP_EVALUATOR_VERSION,
  type LampEvaluationArtifact,
} from "../lib/lamp-evaluation.ts";

function legacyLightingDirective(): string {
  const lighting = LAMP_RELIGHT_BASE_PROMPT.lighting;
  return [
    `Style: ${lighting.style}`,
    `Key light: ${lighting.keyLight}`,
    `Fill light: ${lighting.fillLight}`,
    `Rim light: ${lighting.rimLight}`,
    `Color temperature: ${lighting.colorTemperature}`,
    `Mood: ${lighting.mood}`,
  ].join("\n");
}

function lightingBlock(rendered: string): string {
  const start = rendered.indexOf("[LIGHTING SPECIFICATION]\n");
  const end = rendered.indexOf("\n\n[ACTIVE CORRECTIONS FROM EVALUATION]");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return rendered.slice(start, end);
}

test("relight strength accepts only five-point steps from 0 through 100", () => {
  for (const value of [0, 5, 50, 75, 100]) {
    assert.equal(isRelightIntensity(value), true);
  }
  for (const value of [-5, 1, 74, 101, 75.5, "75", null]) {
    assert.equal(isRelightIntensity(value), false);
  }
  assert.equal(normalizeRelightIntensity(undefined), DEFAULT_RELIGHT_INTENSITY);
  assert.equal(normalizeRelightIntensity(74), DEFAULT_RELIGHT_INTENSITY);
  assert.equal(normalizeRelightIntensity(25), 25);
});

test("profile targets increase deterministically with the selected strength", () => {
  const natural = relightIntensityProfile(0);
  const current = relightIntensityProfile(75);
  const hero = relightIntensityProfile(100);

  assert.equal(natural.label, "Natural lift");
  assert.equal(current.shortLabel, "Current Lamp");
  assert.equal(hero.label, "Hero studio");
  assert.equal(natural.faceLiftStops, 0.2);
  assert.equal(current.faceLiftStops, 1.2);
  assert.equal(hero.faceLiftStops, 1.5);
  assert.equal(natural.keyFillRatio, 1.2);
  assert.equal(current.keyFillRatio, 3);
  assert.equal(hero.keyFillRatio, 3.6);
});

test("75 remains byte-identical to the historical Lamp prompt", () => {
  const expected = renderMegaPrompt(
    {
      version: 1,
      base: LAMP_RELIGHT_BASE_PROMPT,
      lightingDirective: legacyLightingDirective(),
      corrections: [],
      rendered: "",
    },
    "lamp"
  );
  const current = initialMegaPrompt("lamp", 75).rendered;

  assert.equal(current, expected);
  assert.equal(parseRelightIntensityFromPrompt(current), null);
});

test("non-default strengths bind distinct measured Lamp prompt bytes", () => {
  const prompts = [0, 75, 100].map((value) =>
    initialMegaPrompt("lamp", value)
  );
  const hashes = prompts.map((prompt) =>
    createHash("sha256").update(prompt.rendered, "utf8").digest("hex")
  );

  assert.equal(new Set(hashes).size, 3);
  assert.match(prompts[0].rendered, /Requested relight strength: 0\/100\./);
  assert.match(prompts[0].rendered, /no deliberate rim light/i);
  assert.doesNotMatch(
    prompts[1].rendered,
    /Requested relight strength: 75\/100\./
  );
  assert.match(prompts[2].rendered, /Requested relight strength: 100\/100\./);
  assert.match(prompts[2].rendered, /maximum source-faithful studio/i);
  assert.equal(parseRelightIntensityFromPrompt(prompts[0].rendered), 0);
  assert.equal(parseRelightIntensityFromPrompt(prompts[2].rendered), 100);

  for (const prompt of prompts) {
    assert.equal(prompt.base, LAMP_RELIGHT_BASE_PROMPT);
    assert.equal(prompt.base.locks, LAMP_RELIGHT_BASE_PROMPT.locks);
    assert.equal(prompt.base.negative, LAMP_RELIGHT_BASE_PROMPT.negative);
  }
});

test("Lamp Final preserves the exact selected lighting block", () => {
  const initial = initialMegaPrompt("lamp", 20);
  const evaluation: LampEvaluationArtifact = {
    version: LAMP_EVALUATOR_VERSION,
    iteration: 1,
    evalResults: [],
    usage: { promptTokenCount: 1, candidatesTokenCount: 1 },
    costUsd: 0,
  };
  const finalPrompt = compileLampFinalPrompt(initial.rendered, evaluation);

  assert.equal(lightingBlock(finalPrompt.rendered), lightingBlock(initial.rendered));
  assert.match(finalPrompt.rendered, /^=== LAMP RELIGHT MEGA PROMPT v2 ===/);
  assert.equal(parseRelightIntensityFromPrompt(finalPrompt.rendered), 20);
});
