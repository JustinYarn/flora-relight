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
  /**
   * Per-sample non-blink irisY values in sample order (rounded, bounded by
   * the meter's frame cap). Optional and additive: artifacts measured before
   * the contact-anchor upgrade lack it and every consumer fails open.
   */
  irisYTrace?: number[];
  /**
   * The camera-contact anchor for THIS video: the median irisY of its
   * lens-glance cluster (see lampIrisContactAnchor). "Directly at the
   * viewer" is not knowable from geometry alone — it depends on where the
   * camera sat in the recording setup — but a source's own lens glances
   * define it exactly. Present only when a confident cluster exists.
   */
  contactAnchorY?: number;
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
  /**
   * Signed distance from the source's measured contact anchor: positive =
   * the candidate's median gaze rests BELOW the anchor (short of contact),
   * negative = above it (past contact). Absent when the source has no
   * measured anchor.
   */
  offsetFromContact?: number;
  /**
   * Fraction of the candidate's non-blink samples resting within
   * ±LAMP_IRIS_CONTACT_BAND of the source's contact anchor. Absent when the
   * source has no anchor or the candidate has no trace.
   */
  onContactFraction?: number;
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
    ) &&
    (value.irisYTrace === undefined ||
      (Array.isArray(value.irisYTrace) &&
        (value.irisYTrace as unknown[]).length <= 64 &&
        (value.irisYTrace as unknown[]).every(
          (y) => typeof y === "number" && Number.isFinite(y)
        ))) &&
    (value.contactAnchorY === undefined || finite01(value.contactAnchorY))
  );
}

/**
 * Half-width of the contact band around a measured anchor: a candidate gaze
 * resting within it reads as the same position at the meter's precision.
 */
export const LAMP_IRIS_CONTACT_BAND = 0.03;

/**
 * The camera-contact anchor from one video's own gaze trace. A script-reader
 * who ever glances at the lens leaves a small cluster of samples lifted well
 * above the dominant reading anchor; the median of that cluster is where
 * TRUE contact sits for this exact camera geometry. Deterministic and
 * fail-open: no confident cluster (never glanced, or the lifted samples
 * scatter) returns null.
 */
export function lampIrisContactAnchor(irisYTrace: number[]): number | null {
  if (irisYTrace.length < 8) return null;
  const sorted = [...irisYTrace].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  // Lifted = meaningfully above (numerically below) the dominant anchor.
  const lifted = sorted.filter((y) => y <= mid - 0.05);
  if (lifted.length < 2) return null;
  // The cluster must be tight; scattered lifted samples are saccade noise.
  const q1 = lifted[Math.floor((lifted.length - 1) * 0.25)];
  const q3 = lifted[Math.ceil((lifted.length - 1) * 0.75)];
  if (q3 - q1 > 0.04) return null;
  return lifted[Math.floor(lifted.length / 2)];
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
  const anchorY = source.contactAnchorY;
  const contact =
    anchorY !== undefined
      ? {
          offsetFromContact: candidate.medianIrisY - anchorY,
          ...(candidate.irisYTrace !== undefined &&
          candidate.irisYTrace.length > 0
            ? {
                onContactFraction:
                  candidate.irisYTrace.filter(
                    (y) => Math.abs(y - anchorY) <= LAMP_IRIS_CONTACT_BAND
                  ).length / candidate.irisYTrace.length,
              }
            : {}),
        }
      : {};
  return {
    verticalLift: source.medianIrisY - candidate.medianIrisY,
    scanReduction: source.irisXDispersion - candidate.irisXDispersion,
    blinkDelta: candidate.blinkCount - source.blinkCount,
    blinkTimingMatch: matched / denominator,
    ...contact,
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
    ...(comparison.offsetFromContact !== undefined
      ? [
          `- Measured contact anchor (from the source's own lens-glance frames): y=${fixed(
            input.source.contactAnchorY ?? NaN
          )}. Candidate offset from the anchor: ${fixed(
            Math.abs(comparison.offsetFromContact)
          )} aperture units ${
            comparison.offsetFromContact > 0 ? "BELOW" : "ABOVE"
          } contact${
            comparison.onContactFraction !== undefined
              ? `; fraction of candidate frames within the contact band: ${fixed(comparison.onContactFraction)}`
              : ""
          }. A gaze parked off the anchor in either direction is not eye contact — judge over- and under-shoot against this number.`,
        ]
      : []),
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
      `Deterministic measurement of the first take: the pupils lifted only ${comparison.verticalLift.toFixed(
        3
      )} aperture units from the source's reading anchor — measurably unchanged. The pupils must move decisively UP and onto the lens: close most of the gap between the source anchor (median iris y=${input.source.medianIrisY.toFixed(
        3
      )}) and the upper-centered aperture position of true lens contact.`
    );
  }
  if (
    comparison.offsetFromContact !== undefined &&
    Math.abs(comparison.offsetFromContact) > LAMP_IRIS_CONTACT_BAND
  ) {
    const anchor = (input.source.contactAnchorY ?? NaN).toFixed(3);
    const offset = Math.abs(comparison.offsetFromContact).toFixed(3);
    parts.push(
      comparison.offsetFromContact > 0
        ? `The source itself contains lens-contact frames at median iris y=${anchor}; the first take's median gaze rests ${offset} aperture units below that measured contact position. Raise the pupils to rest at the measured contact position, not short of it.`
        : `The source itself contains lens-contact frames at median iris y=${anchor}; the first take's median gaze rests ${offset} aperture units above that measured contact position. Lower the pupils to rest at the measured contact position, not past it.`
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
