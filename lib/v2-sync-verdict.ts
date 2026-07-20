/**
 * Workflow-safe SyncNet policy. Keep this module free of Node-only imports so
 * durable orchestration can decide whether a candidate needs repair without
 * pulling hashing/provider code into the workflow isolate.
 */
export const V2_SYNC_MIN_CONFIDENCE = 4;
export const V2_SYNC_MAX_DISTANCE = 10;
export const V2_SYNC_SOURCE_CONFIDENCE_TOLERANCE = 0.5;
export const V2_SYNC_SOURCE_DISTANCE_TOLERANCE = 1;
export const V2_SYNC_SOURCE_MAX_ABS_OFFSET_SEC = 0.05;
export const V2_SYNC_SOURCE_SPEECH_TOLERANCE = 0.1;

export interface SyncNetMetrics {
  confidence: number;
  distance: number;
  offsetSec: number;
  speechPercentage: number;
}

export function v2SyncPasses(metrics: SyncNetMetrics): boolean {
  return (
    Number.isFinite(metrics.confidence) &&
    Number.isFinite(metrics.distance) &&
    metrics.confidence >= V2_SYNC_MIN_CONFIDENCE &&
    metrics.distance <= V2_SYNC_MAX_DISTANCE
  );
}

export interface V2SyncVerdict {
  pass: boolean;
  mode: "absolute" | "source_relative";
  /** Human-readable explanation, safe to embed in run errors and logs. */
  reason: string;
}

function usableBaseline(
  sourceSync: SyncNetMetrics | null | undefined
): sourceSync is SyncNetMetrics {
  return (
    !!sourceSync &&
    Number.isFinite(sourceSync.confidence) &&
    Number.isFinite(sourceSync.distance)
  );
}

/**
 * Judge a candidate against both the stable absolute bar and its exact source.
 * A healthy source must never be degraded merely because the candidate still
 * lands barely inside 4/10. A source below the absolute bar keeps the legacy
 * source-relative admission path, but timing and speech coverage must still
 * remain source-faithful.
 */
export function v2SyncVerdict(
  metrics: SyncNetMetrics,
  sourceSync?: SyncNetMetrics | null
): V2SyncVerdict {
  const absolute = v2SyncPasses(metrics);
  const summary = `confidence ${metrics.confidence.toFixed(2)}, distance ${metrics.distance.toFixed(2)}, offset ${metrics.offsetSec.toFixed(2)}s`;
  if (!usableBaseline(sourceSync)) {
    return {
      pass: absolute,
      mode: "absolute",
      reason: `${summary} versus the absolute ${V2_SYNC_MIN_CONFIDENCE}/${V2_SYNC_MAX_DISTANCE} bar`,
    };
  }
  const sourceSummary = `source baseline confidence ${sourceSync.confidence.toFixed(2)}, distance ${sourceSync.distance.toFixed(2)}`;
  const sourcePassesAbsolute = v2SyncPasses(sourceSync);
  const minConfidence = sourcePassesAbsolute
    ? Math.max(
        V2_SYNC_MIN_CONFIDENCE,
        sourceSync.confidence - V2_SYNC_SOURCE_CONFIDENCE_TOLERANCE
      )
    : Math.min(
        V2_SYNC_MIN_CONFIDENCE,
        sourceSync.confidence - V2_SYNC_SOURCE_CONFIDENCE_TOLERANCE
      );
  const maxDistance = sourcePassesAbsolute
    ? Math.min(
        V2_SYNC_MAX_DISTANCE,
        sourceSync.distance + V2_SYNC_SOURCE_DISTANCE_TOLERANCE
      )
    : Math.max(
        V2_SYNC_MAX_DISTANCE,
        sourceSync.distance + V2_SYNC_SOURCE_DISTANCE_TOLERANCE
      );
  const maxSpeechRegression = Math.max(
    0,
    sourceSync.speechPercentage - V2_SYNC_SOURCE_SPEECH_TOLERANCE
  );
  const offsetDelta = Math.abs(metrics.offsetSec - sourceSync.offsetSec);
  const pass =
    Number.isFinite(metrics.confidence) &&
    Number.isFinite(metrics.distance) &&
    Number.isFinite(metrics.offsetSec) &&
    Number.isFinite(metrics.speechPercentage) &&
    metrics.confidence >= minConfidence &&
    metrics.distance <= maxDistance &&
    offsetDelta <= V2_SYNC_SOURCE_MAX_ABS_OFFSET_SEC &&
    metrics.speechPercentage >= maxSpeechRegression;
  return {
    pass,
    mode: "source_relative",
    reason: `${summary} versus the source-relative bar (confidence ≥ ${minConfidence.toFixed(2)}, distance ≤ ${maxDistance.toFixed(2)}, offset delta ≤ ${V2_SYNC_SOURCE_MAX_ABS_OFFSET_SEC.toFixed(2)}s, speech ≥ ${(maxSpeechRegression * 100).toFixed(0)}%; ${sourceSummary})`,
  };
}
