import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DEFAULT_RELIGHT_INTENSITY,
  isRelightIntensity,
  isRelightLumaMeasurements,
  normalizeRelightIntensity,
  parseRelightIntensityFromPrompt,
  relightIntensityProfile,
  relightMeasuredCalibrationCorrection,
  relightNegativeBlock,
  type RelightLumaMeasurements,
} from "../lib/relight-intensity.ts";
import {
  initialMegaPrompt,
  renderMegaPrompt,
} from "../lib/prompts/mega-prompt.ts";
import { LAMP_RELIGHT_BASE_PROMPT } from "../lib/prompts/base-prompt.ts";
import {
  compileLampFinalPrompt,
  isLampEvaluationArtifact,
  LAMP_EVALUATOR_VERSION,
  LAMP_PREVIOUS_EVALUATOR_VERSIONS,
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

function correctionsBlock(rendered: string): string {
  const start = rendered.indexOf("[ACTIVE CORRECTIONS FROM EVALUATION]");
  const end = rendered.indexOf("[NEVER DO]");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return rendered.slice(start, end);
}

function evaluationArtifact(
  overrides: Partial<LampEvaluationArtifact> = {}
): LampEvaluationArtifact {
  return {
    version: LAMP_EVALUATOR_VERSION,
    iteration: 1,
    evalResults: [],
    usage: { promptTokenCount: 1, candidatesTokenCount: 1 },
    costUsd: 0,
    ...overrides,
  };
}

const ON_TARGET_100: RelightLumaMeasurements = {
  globalStops: -0.6,
  centerStops: 1.5,
  borderStops: -1.7,
  sampleCount: 10,
};

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

test("profile targets move monotonically across the whole ladder", () => {
  const daylight = relightIntensityProfile(0);
  const current = relightIntensityProfile(75);
  const hero = relightIntensityProfile(100);

  assert.equal(daylight.label, "Daylight lift");
  assert.equal(current.shortLabel, "Current Lamp");
  assert.equal(hero.label, "Cinematic hero");
  assert.equal(daylight.faceLiftStops, 0.35);
  assert.equal(current.faceLiftStops, 1.2);
  assert.equal(hero.faceLiftStops, 1.55);
  assert.equal(daylight.keyFillRatio, 1.2);
  assert.equal(current.keyFillRatio, 3);
  assert.equal(hero.keyFillRatio, 5);
  assert.equal(daylight.backgroundStops, 0.1);
  assert.equal(current.backgroundStops, -0.75);
  assert.equal(hero.backgroundStops, -1.8);

  // The whole 0..100 sweep must be monotonic so the slider never lies.
  let previous = relightIntensityProfile(0);
  for (let value = 5; value <= 100; value += 5) {
    const next = relightIntensityProfile(value);
    assert.ok(next.faceLiftStops >= previous.faceLiftStops, `face @${value}`);
    assert.ok(next.keyFillRatio >= previous.keyFillRatio, `key @${value}`);
    assert.ok(
      next.backgroundStops <= previous.backgroundStops,
      `background @${value}`
    );
    previous = next;
  }
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
  assert.match(prompts[0].rendered, /Rim light: None\./);
  assert.match(prompts[0].rendered, /better weather, not as production lighting/);
  assert.doesNotMatch(
    prompts[1].rendered,
    /Requested relight strength: 75\/100\./
  );
  assert.match(prompts[2].rendered, /Requested relight strength: 100\/100\./);
  assert.match(prompts[2].rendered, /cinematic hero-interview treatment/i);
  assert.match(prompts[2].rendered, /Background level vs source: approximately -1\.8 stops/);
  assert.equal(parseRelightIntensityFromPrompt(prompts[0].rendered), 0);
  assert.equal(parseRelightIntensityFromPrompt(prompts[2].rendered), 100);

  // Locks never vary with strength; the default keeps the exact base object.
  for (const prompt of prompts) {
    assert.equal(prompt.base.locks, LAMP_RELIGHT_BASE_PROMPT.locks);
  }
  assert.equal(prompts[1].base, LAMP_RELIGHT_BASE_PROMPT);
});

test("the negative block is scoped to the requested band", () => {
  const base = LAMP_RELIGHT_BASE_PROMPT.negative;
  const daylight = relightNegativeBlock(0, base);
  const current = relightNegativeBlock(75, base);
  const studio = relightNegativeBlock(90, base);
  const hero = relightNegativeBlock(100, base);

  assert.equal(daylight.length, base.length);
  assert.deepEqual(current, [...base]);
  assert.ok(daylight.some((item) => item.includes("near-invisible")));
  assert.ok(
    daylight.some((item) =>
      item.includes("do not force a visible directional key")
    )
  );
  assert.ok(
    studio.some((item) =>
      item.includes("Confident contrast and deliberate subject-background separation")
    )
  );
  assert.ok(
    hero.some((item) => item.includes("restrained filmic contrast curve"))
  );
  // Every band keeps the flat-negative count and the untouched entries.
  assert.ok(hero.includes(base[0]));

  const rendered = initialMegaPrompt("lamp", 100).rendered;
  assert.match(rendered, /restrained filmic contrast curve/);
  assert.doesNotMatch(rendered, /Do not apply any stylistic look/);
});

test("measured calibration wording tracks the target from both sides", () => {
  const short = relightMeasuredCalibrationCorrection(100, {
    globalStops: 0.1,
    centerStops: 0.2,
    borderStops: 0.1,
    sampleCount: 10,
  });
  assert.match(short, /stops SHORT of the target/);
  assert.match(short, /too BRIGHT for the target/);

  const past = relightMeasuredCalibrationCorrection(0, {
    globalStops: 1.0,
    centerStops: 1.2,
    borderStops: -1.0,
    sampleCount: 10,
  });
  assert.match(past, /stops PAST the target/);
  assert.match(past, /too DARK for the target/);

  const hold = relightMeasuredCalibrationCorrection(100, ON_TARGET_100);
  assert.match(hold, /on target — reproduce this magnitude exactly/);
  assert.match(hold, /on target — hold this background relationship/);
});

test("Lamp Final anchors non-default strengths to the measured Initial", () => {
  const initial = initialMegaPrompt("lamp", 100);
  const measurements: RelightLumaMeasurements = {
    globalStops: -0.05,
    centerStops: 0.3,
    borderStops: -0.2,
    sampleCount: 10,
  };
  const artifact = evaluationArtifact({ measurements });
  const finalPrompt = compileLampFinalPrompt(initial.rendered, artifact);
  const corrections = correctionsBlock(finalPrompt.rendered);

  assert.match(corrections, /1\. \[CRITICAL\] MEASURED CALIBRATION/);
  assert.match(corrections, /SHORT of the target/);
  assert.equal(lightingBlock(finalPrompt.rendered), lightingBlock(initial.rendered));

  // Recompiles from the same persisted inputs stay byte-stable.
  const again = compileLampFinalPrompt(initial.rendered, artifact);
  assert.equal(again.rendered, finalPrompt.rendered);
});

test("Lamp Final skips calibration for the default control and unmeasured runs", () => {
  const control = initialMegaPrompt("lamp", DEFAULT_RELIGHT_INTENSITY);
  const withMeasurements = compileLampFinalPrompt(
    control.rendered,
    evaluationArtifact({ measurements: ON_TARGET_100 })
  );
  assert.doesNotMatch(withMeasurements.rendered, /MEASURED CALIBRATION/);

  const selected = initialMegaPrompt("lamp", 20);
  const withoutMeasurements = compileLampFinalPrompt(
    selected.rendered,
    evaluationArtifact()
  );
  assert.doesNotMatch(withoutMeasurements.rendered, /MEASURED CALIBRATION/);
  assert.match(
    withoutMeasurements.rendered,
    /\(none — first iteration or all prior findings resolved\)/
  );
  assert.equal(
    lightingBlock(withoutMeasurements.rendered),
    lightingBlock(selected.rendered)
  );
  assert.match(withoutMeasurements.rendered, /^=== LAMP RELIGHT MEGA PROMPT v2 ===/);
  assert.equal(parseRelightIntensityFromPrompt(withoutMeasurements.rendered), 20);
});

test("evaluation artifacts validate measurements and prior versions", () => {
  assert.equal(isLampEvaluationArtifact(evaluationArtifact()), true);
  assert.equal(
    isLampEvaluationArtifact(
      evaluationArtifact({ measurements: ON_TARGET_100 })
    ),
    true
  );
  for (const version of LAMP_PREVIOUS_EVALUATOR_VERSIONS) {
    assert.equal(isLampEvaluationArtifact(evaluationArtifact({ version })), true);
  }
  assert.equal(
    isLampEvaluationArtifact(
      evaluationArtifact({
        measurements: {
          globalStops: Number.NaN,
          centerStops: 0,
          borderStops: 0,
          sampleCount: 10,
        },
      })
    ),
    false
  );
  assert.equal(
    isRelightLumaMeasurements({
      globalStops: 0,
      centerStops: 0,
      borderStops: 0,
      sampleCount: 0,
    }),
    false
  );
});
