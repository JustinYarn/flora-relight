import assert from "node:assert/strict";
import test from "node:test";

import {
  LAMP_IRIS_CONTACT_BAND,
  LAMP_IRIS_GAZE_METER_VERSION,
  compareLampIrisGaze,
  isLampIrisGazeMeasurements,
  lampIrisContactAnchor,
  renderLampIrisGazeMeasurementBlock,
  renderLampIrisMeasuredCalibrationCorrection,
  type LampIrisGazeMeasurements,
} from "../lib/lamp-iris-gaze.ts";

function measurements(
  overrides: Partial<LampIrisGazeMeasurements> = {}
): LampIrisGazeMeasurements {
  return {
    version: LAMP_IRIS_GAZE_METER_VERSION,
    framesAnalyzed: 24,
    faceDetectionRate: 1,
    medianIrisX: 0.5,
    medianIrisY: 0.5,
    irisXDispersion: 0.03,
    irisYDispersion: 0.02,
    blinkCount: 3,
    blinkTimestampsSec: [1.1, 2.2, 3.3],
    ...overrides,
  };
}

/** A script-reader's trace: anchored at 0.50 with four tight lens glances. */
const READER_WITH_GLANCES = [
  0.5, 0.51, 0.5, 0.49, 0.5, 0.42, 0.5, 0.51, 0.41, 0.5, 0.5, 0.42, 0.49,
  0.5, 0.43, 0.5,
];

test("lampIrisContactAnchor finds the lens-glance cluster", () => {
  const anchor = lampIrisContactAnchor(READER_WITH_GLANCES);
  assert.notEqual(anchor, null);
  assert.equal((anchor as number) < 0.44 && (anchor as number) > 0.4, true);
});

test("lampIrisContactAnchor fails open without a confident cluster", () => {
  // Never glanced: every sample sits at the reading anchor.
  assert.equal(
    lampIrisContactAnchor([0.5, 0.51, 0.5, 0.49, 0.5, 0.5, 0.51, 0.5, 0.49]),
    null
  );
  // Lifted samples exist but scatter — saccade noise, not a held glance.
  assert.equal(
    lampIrisContactAnchor([
      0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.3, 0.38, 0.44, 0.35,
    ]),
    null
  );
  // Too few samples to say anything.
  assert.equal(lampIrisContactAnchor([0.5, 0.42, 0.5]), null);
});

test("comparison reports signed contact offset and on-contact fraction", () => {
  const source = measurements({ contactAnchorY: 0.42 });
  const undershot = measurements({
    medianIrisY: 0.5,
    irisYTrace: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.43, 0.41],
  });
  const comparison = compareLampIrisGaze(source, undershot);
  assert.equal(comparison.offsetFromContact !== undefined, true);
  assert.equal(Math.abs((comparison.offsetFromContact as number) - 0.08) < 1e-9, true);
  assert.equal(comparison.onContactFraction, 0.2);

  // No anchor on the source: the contact fields stay absent.
  const withoutAnchor = compareLampIrisGaze(measurements(), undershot);
  assert.equal(withoutAnchor.offsetFromContact, undefined);
  assert.equal(withoutAnchor.onContactFraction, undefined);
});

test("the judge block names over- and under-shoot against the anchor", () => {
  const source = measurements({ contactAnchorY: 0.42 });
  const below = renderLampIrisGazeMeasurementBlock({
    source,
    candidate: measurements({ medianIrisY: 0.5, irisYTrace: [0.5, 0.5] }),
  });
  assert.equal(below.includes("BELOW contact"), true);
  const above = renderLampIrisGazeMeasurementBlock({
    source,
    candidate: measurements({ medianIrisY: 0.3, irisYTrace: [0.3, 0.3] }),
  });
  assert.equal(above.includes("ABOVE contact"), true);
});

test("the calibration correction steers to the measured contact position", () => {
  const source = measurements({ contactAnchorY: 0.42 });
  // Undershoot: resting below the anchor (and below the near-copy floor too).
  const under = renderLampIrisMeasuredCalibrationCorrection({
    source,
    initial: measurements({ medianIrisY: 0.5 }),
  });
  assert.notEqual(under, null);
  assert.equal((under as string).includes("Raise the pupils to rest at the measured contact position"), true);
  // Overshoot: lifted past the anchor.
  const over = renderLampIrisMeasuredCalibrationCorrection({
    source,
    initial: measurements({ medianIrisY: 0.42 - LAMP_IRIS_CONTACT_BAND - 0.02 }),
  });
  assert.notEqual(over, null);
  assert.equal((over as string).includes("Lower the pupils to rest at the measured contact position"), true);
  // Inside the band with real lift: nothing to correct.
  assert.equal(
    renderLampIrisMeasuredCalibrationCorrection({
      source,
      initial: measurements({ medianIrisY: 0.42 }),
    }),
    null
  );
});

test("calibration wording stays clear of the provider-blocked vocabulary", () => {
  const rendered = [
    renderLampIrisMeasuredCalibrationCorrection({
      source: measurements({ contactAnchorY: 0.42, irisXDispersion: 0.06 }),
      initial: measurements({ medianIrisY: 0.52, irisXDispersion: 0.07, blinkCount: 6 }),
    }),
    renderLampIrisGazeMeasurementBlock({
      source: measurements({ contactAnchorY: 0.42 }),
      candidate: measurements({ medianIrisY: 0.5, irisYTrace: [0.5] }),
    }),
  ].join(" ");
  for (const blocked of [
    "failed this workflow's one job",
    "the person watching must feel",
    "same-frame comparison",
    "plainly different",
    "previous pass",
  ]) {
    assert.equal(
      rendered.includes(blocked),
      false,
      `measured wording must not carry the blocked phrasing "${blocked}"`
    );
  }
});

test("the validator accepts the new optional fields and rejects junk", () => {
  assert.equal(isLampIrisGazeMeasurements(measurements()), true);
  assert.equal(
    isLampIrisGazeMeasurements(
      measurements({ irisYTrace: [0.5, 0.42], contactAnchorY: 0.42 })
    ),
    true
  );
  assert.equal(
    isLampIrisGazeMeasurements(
      measurements({ irisYTrace: ["bad"] as unknown as number[] })
    ),
    false
  );
  assert.equal(
    isLampIrisGazeMeasurements(
      measurements({ irisYTrace: new Array(65).fill(0.5) })
    ),
    false
  );
  assert.equal(
    isLampIrisGazeMeasurements(
      measurements({ contactAnchorY: Number.NaN })
    ),
    false
  );
});
