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
 * Judge a candidate against the absolute bar, or against its measured source
 * when that original source cannot itself clear the absolute bar.
 */
export function v2SyncVerdict(
  metrics: SyncNetMetrics,
  sourceSync?: SyncNetMetrics | null
): V2SyncVerdict {
  const absolute = v2SyncPasses(metrics);
  const summary = `confidence ${metrics.confidence.toFixed(2)}, distance ${metrics.distance.toFixed(2)}, offset ${metrics.offsetSec.toFixed(2)}s`;
  if (!usableBaseline(sourceSync) || v2SyncPasses(sourceSync)) {
    return {
      pass: absolute,
      mode: "absolute",
      reason: `${summary} versus the absolute ${V2_SYNC_MIN_CONFIDENCE}/${V2_SYNC_MAX_DISTANCE} bar`,
    };
  }
  const sourceSummary = `source baseline confidence ${sourceSync.confidence.toFixed(2)}, distance ${sourceSync.distance.toFixed(2)}`;
  if (absolute) {
    return {
      pass: true,
      mode: "source_relative",
      reason: `${summary} clears the absolute bar outright (${sourceSummary})`,
    };
  }
  const minConfidence = Math.min(
    V2_SYNC_MIN_CONFIDENCE,
    sourceSync.confidence - V2_SYNC_SOURCE_CONFIDENCE_TOLERANCE
  );
  const maxDistance = Math.max(
    V2_SYNC_MAX_DISTANCE,
    sourceSync.distance + V2_SYNC_SOURCE_DISTANCE_TOLERANCE
  );
  const pass =
    Number.isFinite(metrics.confidence) &&
    Number.isFinite(metrics.distance) &&
    Number.isFinite(metrics.offsetSec) &&
    metrics.confidence >= minConfidence &&
    metrics.distance <= maxDistance &&
    Math.abs(metrics.offsetSec) <= V2_SYNC_SOURCE_MAX_ABS_OFFSET_SEC;
  return {
    pass,
    mode: "source_relative",
    reason: `${summary} versus the source-relative bar (confidence ≥ ${minConfidence.toFixed(2)}, distance ≤ ${maxDistance.toFixed(2)}, |offset| ≤ ${V2_SYNC_SOURCE_MAX_ABS_OFFSET_SEC.toFixed(2)}s; ${sourceSummary})`,
  };
}
