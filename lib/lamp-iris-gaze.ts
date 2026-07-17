/**
 * Lamp Iris gaze measurements — the deterministic third leg (the
 * LAMP-INTENSITY.md pattern: measured calibration beside prompt recipes and
 * target-matching criteria). A meter measures the SOURCE once and each
 * CANDIDATE before its evaluation; the numbers are (a) given to the judge as
 * magnitude ground truth, (b) persisted on the evaluation artifact, and
 * (c) compiled into the Final prompt as a measured-calibration correction so
 * pass 2 is steered, never a blind re-roll.
 *
 * Everything is SOURCE-RELATIVE (the SyncNet source-baseline lesson):
 * absolute "on-lens" is unknowable across cameras, but the shift between the
 * source's reading anchor and the candidate's gaze is exactly the corrected
 * quantity. The meter fails open: runs without measurements behave exactly
 * as before.
 */

export const LAMP_IRIS_GAZE_METER_VERSION = "lamp-iris-gaze-meter-v1" as const;

export interface LampIrisGazeMeasurements {
  version: typeof LAMP_IRIS_GAZE_METER_VERSION;
  framesAnalyzed: number;
  /** Fraction of sampled frames with a confidently detected face (0-1). */
  faceDetectionRate: number;
  /**
   * Median iris-center position inside the eye aperture, averaged over both
   * eyes. Coordinates are normalized: x 0=outer-left of the aperture,
   * 1=outer-right; y 0=upper lid, 1=lower lid. A webcam subject reading a
   * screen below the lens sits with irisY well above the aperture midline
   * (lid-relative), i.e. numerically HIGH y in image terms — the meter
   * normalizes so that LOWER irisY means the gaze has lifted toward the
   * camera.
   */
  medianIrisX: number;
  medianIrisY: number;
  /** Interquartile ranges — reading scans show up as wide X dispersion. */
  irisXDispersion: number;
  irisYDispersion: number;
  /** Blink events detected from the eye-aspect-ratio trace. */
  blinkCount: number;
  blinkTimestampsSec: number[];
}

export interface LampIrisGazeComparison {
  /**
   * Positive = the candidate's gaze lifted toward the camera relative to the
   * source's reading anchor (in normalized aperture units).
   */
  verticalLift: number;
  /** Positive = horizontal scanning dispersion shrank (reading scans calmed). */
  scanReduction: number;
  /** candidate blinks minus source blinks; the contract demands |delta| <= 1. */
  blinkDelta: number;
  /** Fraction agreement of candidate blink timestamps with source (±0.25s). */
  blinkTimingMatch: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite01(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isLampIrisGazeMeasurements(
  value: unknown
): value is LampIrisGazeMeasurements {
  return (
    isRecord(value) &&
    value.version === LAMP_IRIS_GAZE_METER_VERSION &&
    Number.isSafeInteger(value.framesAnalyzed) &&
    (value.framesAnalyzed as number) > 0 &&
    finite01(value.faceDetectionRate) &&
    finite01(value.medianIrisX) &&
    finite01(value.medianIrisY) &&
    finite01(value.irisXDispersion) &&
    finite01(value.irisYDispersion) &&
    Number.isSafeInteger(value.blinkCount) &&
    (value.blinkCount as number) >= 0 &&
    Array.isArray(value.blinkTimestampsSec) &&
    (value.blinkTimestampsSec as unknown[]).every(
      (t) => typeof t === "number" && Number.isFinite(t) && t >= 0
    )
  );
}

/**
 * Measurements are only trustworthy when the meter actually saw the face.
 * Below this rate the numbers are noise and the feature must fail open.
 */
export const LAMP_IRIS_GAZE_MIN_DETECTION_RATE = 0.6;

export function lampIrisGazeMeasurementsUsable(
  measurements: LampIrisGazeMeasurements
): boolean {
  return (
    measurements.framesAnalyzed >= 8 &&
    measurements.faceDetectionRate >= LAMP_IRIS_GAZE_MIN_DETECTION_RATE
  );
}

export function compareLampIrisGaze(
  source: LampIrisGazeMeasurements,
  candidate: LampIrisGazeMeasurements
): LampIrisGazeComparison {
  const tolerance = 0.25;
  const matched = candidate.blinkTimestampsSec.filter((t) =>
    source.blinkTimestampsSec.some((s) => Math.abs(s - t) <= tolerance)
  ).length;
  const denominator = Math.max(
    source.blinkTimestampsSec.length,
    candidate.blinkTimestampsSec.length,
    1
  );
  return {
    verticalLift: source.medianIrisY - candidate.medianIrisY,
    scanReduction: source.irisXDispersion - candidate.irisXDispersion,
    blinkDelta: candidate.blinkCount - source.blinkCount,
    blinkTimingMatch: matched / denominator,
  };
}

/**
 * Meaningful-change floor: below this vertical lift the candidate's gaze is
 * measurably the source's gaze (a near-copy), regardless of how it reads.
 * Derived from the aperture normalization, not tuned on wishes: a real
 * screen-to-lens correction moves the iris a large fraction of the aperture.
 */
export const LAMP_IRIS_NEAR_COPY_LIFT_FLOOR = 0.05;

/**
 * Render the measured block for the holistic judge. The numbers are ground
 * truth for MAGNITUDE only; perceived contact and naturalness remain the
 * judge's call. Rendered deterministically so it can be part of the
 * evaluation's canonical input.
 */
export function renderLampIrisGazeMeasurementBlock(input: {
  source: LampIrisGazeMeasurements;
  candidate: LampIrisGazeMeasurements;
}): string {
  const comparison = compareLampIrisGaze(input.source, input.candidate);
  const fixed = (value: number) => value.toFixed(3);
  return [
    "MEASURED GAZE CALIBRATION (deterministic landmark meter — magnitude ground truth; do not re-estimate these quantities visually):",
    `- Source reading anchor: median iris position x=${fixed(input.source.medianIrisX)} y=${fixed(input.source.medianIrisY)} (aperture-normalized; higher y = lower gaze), horizontal dispersion ${fixed(input.source.irisXDispersion)}, ${input.source.blinkCount} blinks.`,
    `- Candidate: median iris position x=${fixed(input.candidate.medianIrisX)} y=${fixed(input.candidate.medianIrisY)}, horizontal dispersion ${fixed(input.candidate.irisXDispersion)}, ${input.candidate.blinkCount} blinks.`,
    `- Vertical lift toward the camera: ${fixed(comparison.verticalLift)} aperture units${
      comparison.verticalLift < LAMP_IRIS_NEAR_COPY_LIFT_FLOOR
        ? " — BELOW the near-copy floor: the gaze measurably did not move; gaze-adherence must score this as failed undershoot"
        : ""
    }.`,
    `- Reading-scan reduction: ${fixed(comparison.scanReduction)} (positive = scanning calmed).`,
    `- Blink delta: ${comparison.blinkDelta >= 0 ? "+" : ""}${comparison.blinkDelta} (contract allows at most ±1); blink timing match ${fixed(comparison.blinkTimingMatch)}.`,
  ].join("\n");
}

/**
 * Render the measured-calibration correction for the Final pass — the
 * concrete magnitude instruction that makes pass 2 a steered second take.
 * Only rendered when the Initial measurably undershot.
 */
export function renderLampIrisMeasuredCalibrationCorrection(input: {
  source: LampIrisGazeMeasurements;
  initial: LampIrisGazeMeasurements;
}): string | null {
  const comparison = compareLampIrisGaze(input.source, input.initial);
  const parts: string[] = [];
  if (comparison.verticalLift < LAMP_IRIS_NEAR_COPY_LIFT_FLOOR) {
    parts.push(
      `Deterministic measurement of the previous pass: the pupils lifted only ${comparison.verticalLift.toFixed(
        3
      )} aperture units from the source's reading anchor — measurably unchanged. The pupils must move decisively UP and onto the lens: close most of the gap between the source anchor (median iris y=${input.source.medianIrisY.toFixed(
        3
      )}) and the upper-centered aperture position of true lens contact.`
    );
  }
  if (comparison.scanReduction <= 0 && input.source.irisXDispersion > 0.04) {
    parts.push(
      `Horizontal reading scans measurably survived (dispersion ${input.initial.irisXDispersion.toFixed(
        3
      )} vs source ${input.source.irisXDispersion.toFixed(
        3
      )}); hold the pupils still-and-steady in the lens through speech.`
    );
  }
  if (Math.abs(comparison.blinkDelta) > 1) {
    parts.push(
      `Blink count measurably drifted (${comparison.blinkDelta > 0 ? "+" : ""}${
        comparison.blinkDelta
      } vs source); restore every source blink at its source timestamp and add none.`
    );
  }
  if (parts.length === 0) return null;
  return parts.join(" ");
}
