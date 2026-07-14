/**
 * Media probes can disagree by a packet or frame because container durations
 * are rounded. Fifty milliseconds admits that bookkeeping noise while still
 * rejecting a provider output whose timeline is meaningfully shorter or
 * longer than the source audio.
 */
export const AUDIO_DURATION_TOLERANCE_SEC = 0.05;

export interface AudioIntegrityDurations {
  sourceVideoDurationSec: number;
  rawVideoDurationSec: number;
  finalVideoDurationSec: number;
  sourceAudioDurationSec?: number;
}

/**
 * The delivered artifact must preserve whether the source had audio at all.
 * In particular, a model-generated soundtrack cannot turn a silent source
 * into an audio-bearing final while still passing the integrity gate.
 */
export function audioPresenceMatchesSource(
  sourceHasAudio: boolean,
  finalHasAudio: boolean
): boolean {
  return sourceHasAudio === finalHasAudio;
}

/**
 * Delivery integrity requires the source video, raw generation, finalized
 * deliverable, and (when present) source audio to describe the same timeline.
 * This also protects silent sources, which have no audio duration to act as a
 * clock. Invalid probe values fail closed.
 */
export function audioIntegrityDurationsAgree(
  durations: AudioIntegrityDurations,
  toleranceSec = AUDIO_DURATION_TOLERANCE_SEC
): boolean {
  const values = [
    durations.sourceVideoDurationSec,
    durations.rawVideoDurationSec,
    durations.finalVideoDurationSec,
    ...(durations.sourceAudioDurationSec === undefined
      ? []
      : [durations.sourceAudioDurationSec]),
  ];
  if (
    !Number.isFinite(toleranceSec) ||
    toleranceSec < 0 ||
    values.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    return false;
  }

  const durationSpreadSec = Math.max(...values) - Math.min(...values);
  const floatingPointSlack =
    Number.EPSILON * Math.max(1, ...values.map(Math.abs)) * values.length;
  return durationSpreadSec <= toleranceSec + floatingPointSlack;
}
