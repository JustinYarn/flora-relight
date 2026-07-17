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
   * Timestamps (seconds) of the irisYTrace samples, index-aligned. The
   * sustain math splits the clip into time thirds with these; absent or
   * mismatched timestamps fall back to index thirds.
   */
  irisYTraceTimestampsSec?: number[];
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
  /**
   * On-contact fraction per time third of the clip (null for a third with no
   * usable samples). The sustain contract judges the WEAKEST third: contact
   * held only in the opening seconds is a whole-clip failure.
   */
  onContactByThird?: [number | null, number | null, number | null];
  /**
   * Vertical lift vs the source per time third (source third median minus
   * candidate third median). Present whenever both traces exist — the
   * sustain signal for clips without a measured contact anchor.
   */
  verticalLiftByThird?: [number | null, number | null, number | null];
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
    (value.irisYTraceTimestampsSec === undefined ||
      (Array.isArray(value.irisYTraceTimestampsSec) &&
        (value.irisYTraceTimestampsSec as unknown[]).length <= 64 &&
        (value.irisYTraceTimestampsSec as unknown[]).every(
          (t) => typeof t === "number" && Number.isFinite(t) && t >= 0
        ))) &&
    (value.contactAnchorY === undefined || finite01(value.contactAnchorY))
  );
}

/**
 * Split a trace into time thirds of the clip. Timestamps drive the split so
 * uneven blink exclusion cannot shift the boundaries; a missing or
 * index-mismatched timestamp array falls back to index thirds.
 */
export function lampIrisTraceThirds(
  trace: number[],
  timestampsSec?: number[]
): [number[], number[], number[]] {
  if (
    timestampsSec !== undefined &&
    timestampsSec.length === trace.length &&
    trace.length > 0
  ) {
    const end = Math.max(...timestampsSec);
    if (end > 0) {
      const thirds: [number[], number[], number[]] = [[], [], []];
      for (let i = 0; i < trace.length; i += 1) {
        const t = timestampsSec[i];
        const segment = t < end / 3 ? 0 : t < (2 * end) / 3 ? 1 : 2;
        thirds[segment].push(trace[i]);
      }
      return thirds;
    }
  }
  const a = Math.floor(trace.length / 3);
  const b = Math.floor((2 * trace.length) / 3);
  return [trace.slice(0, a), trace.slice(a, b), trace.slice(b)];
}

function segmentMedian(segment: number[]): number | null {
  if (segment.length === 0) return null;
  const sorted = [...segment].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
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
  const candidateThirds =
    candidate.irisYTrace !== undefined && candidate.irisYTrace.length > 0
      ? lampIrisTraceThirds(
          candidate.irisYTrace,
          candidate.irisYTraceTimestampsSec
        )
      : null;
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
          ...(candidateThirds !== null
            ? {
                onContactByThird: candidateThirds.map((segment) =>
                  segment.length === 0
                    ? null
                    : segment.filter(
                        (y) => Math.abs(y - anchorY) <= LAMP_IRIS_CONTACT_BAND
                      ).length / segment.length
                ) as [number | null, number | null, number | null],
              }
            : {}),
        }
      : {};
  const sourceThirds =
    source.irisYTrace !== undefined && source.irisYTrace.length > 0
      ? lampIrisTraceThirds(source.irisYTrace, source.irisYTraceTimestampsSec)
      : null;
  const liftByThird =
    sourceThirds !== null && candidateThirds !== null
      ? {
          verticalLiftByThird: sourceThirds.map((segment, index) => {
            const sourceMedian = segmentMedian(segment);
            const candidateMedian = segmentMedian(candidateThirds[index]);
            return sourceMedian === null || candidateMedian === null
              ? null
              : sourceMedian - candidateMedian;
          }) as [number | null, number | null, number | null],
        }
      : {};
  return {
    verticalLift: source.medianIrisY - candidate.medianIrisY,
    scanReduction: source.irisXDispersion - candidate.irisXDispersion,
    blinkDelta: candidate.blinkCount - source.blinkCount,
    blinkTimingMatch: matched / denominator,
    ...contact,
    ...liftByThird,
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
    ...(comparison.onContactByThird !== undefined ||
    comparison.verticalLiftByThird !== undefined
      ? [
          `- Held across the clip (opening / middle / closing third of the timeline): ${
            comparison.onContactByThird !== undefined
              ? `on-contact fraction ${comparison.onContactByThird
                  .map((value) => (value === null ? "n/a" : fixed(value)))
                  .join(" / ")}`
              : ""
          }${
            comparison.onContactByThird !== undefined &&
            comparison.verticalLiftByThird !== undefined
              ? "; "
              : ""
          }${
            comparison.verticalLiftByThird !== undefined
              ? `vertical lift ${comparison.verticalLiftByThird
                  .map((value) => (value === null ? "n/a" : fixed(value)))
                  .join(" / ")}`
              : ""
          }. Judge the weakest third: a correction present early that fades toward the reading pattern by the closing third fails for the whole clip.`,
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
  const unevenHold = (thirds: (number | null)[]): boolean => {
    const present = thirds.filter((value): value is number => value !== null);
    return (
      present.length >= 2 &&
      Math.max(...present) - Math.min(...present) > 0.2 &&
      Math.max(...present) >= 0.15
    );
  };
  if (
    comparison.onContactByThird !== undefined &&
    unevenHold(comparison.onContactByThird)
  ) {
    parts.push(
      `Measured across the clip's timeline, the corrected gaze was not held evenly (fraction of frames at the contact position by opening/middle/closing third: ${comparison.onContactByThird
        .map((value) => (value === null ? "n/a" : value.toFixed(2)))
        .join(
          "/"
        )}). Hold the corrected gaze at one constant level at every timestamp from the first frame to the last; the strongest section's level is the level everywhere, including the closing seconds.`
    );
  } else if (
    comparison.verticalLiftByThird !== undefined &&
    (() => {
      const present = comparison.verticalLiftByThird.filter(
        (value): value is number => value !== null
      );
      return (
        present.length >= 2 &&
        Math.max(...present) - Math.min(...present) >
          LAMP_IRIS_NEAR_COPY_LIFT_FLOOR &&
        Math.max(...present) >= LAMP_IRIS_NEAR_COPY_LIFT_FLOOR
      );
    })()
  ) {
    parts.push(
      `Measured across the clip's timeline, the corrected lift was not held evenly (vertical lift by opening/middle/closing third: ${comparison.verticalLiftByThird
        .map((value) => (value === null ? "n/a" : value.toFixed(3)))
        .join(
          "/"
        )}). Hold the corrected gaze at one constant level at every timestamp from the first frame to the last, including the closing seconds.`
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
