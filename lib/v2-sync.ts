export const V2_SYNC_MIN_CONFIDENCE = 4;
export const V2_SYNC_MAX_DISTANCE = 10;
/**
 * Source-relative gate tolerances (see v2SyncVerdict). When the ORIGINAL
 * source cannot itself meet the absolute 4/10 bar (quiet or soft speaker,
 * low speech coverage), the Final is judged against what that footage can
 * actually score: confidence may sit at most this far below the source, and
 * distance at most this far above it.
 */
export const V2_SYNC_SOURCE_CONFIDENCE_TOLERANCE = 0.5;
export const V2_SYNC_SOURCE_DISTANCE_TOLERANCE = 1;
/**
 * ~one frame at 24-30fps. The relative gate trades away the absolute
 * confidence bar, so it must still refuse real audio/video drift outright.
 */
export const V2_SYNC_SOURCE_MAX_ABS_OFFSET_SEC = 0.05;
export const LIPSYNC_OPERATION_ID = "lipsync:2";
export const LIPSYNC_MODEL = "sync/lipsync-2-pro";

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
 * Judge a candidate's SyncNet metrics against what its ORIGINAL source can
 * actually score. Sources that pass the absolute bar keep the absolute bar.
 * Sources that cannot pass it (measured once and persisted as the run's
 * baseline) switch the gate to source-relative: the candidate passes when it
 * is within tolerance of the source and shows no real A/V offset. An
 * absolute pass is always sufficient, so a baseline can only widen the gate,
 * never narrow it — a run that would have survived the absolute rule still
 * survives.
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

export interface LipsyncOperationResult {
  predictionId: string;
  model: typeof LIPSYNC_MODEL;
  videoUrl: string;
  billableDurationSec: number;
  costUsd: number;
  audioVerified: true;
  preSync: SyncNetMetrics;
  postSync: SyncNetMetrics;
}

function isMetrics(value: unknown): value is SyncNetMetrics {
  if (!value || typeof value !== "object") return false;
  const metrics = value as Partial<SyncNetMetrics>;
  return (
    typeof metrics.confidence === "number" &&
    Number.isFinite(metrics.confidence) &&
    typeof metrics.distance === "number" &&
    Number.isFinite(metrics.distance) &&
    typeof metrics.offsetSec === "number" &&
    Number.isFinite(metrics.offsetSec) &&
    typeof metrics.speechPercentage === "number" &&
    Number.isFinite(metrics.speechPercentage)
  );
}

export function isLipsyncOperationResult(
  value: unknown
): value is LipsyncOperationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<LipsyncOperationResult>;
  return (
    typeof result.predictionId === "string" &&
    result.predictionId.length > 0 &&
    result.model === LIPSYNC_MODEL &&
    typeof result.videoUrl === "string" &&
    result.videoUrl.length > 0 &&
    typeof result.billableDurationSec === "number" &&
    Number.isFinite(result.billableDurationSec) &&
    result.billableDurationSec > 0 &&
    typeof result.costUsd === "number" &&
    Number.isFinite(result.costUsd) &&
    result.costUsd >= 0 &&
    result.audioVerified === true &&
    isMetrics(result.preSync) &&
    isMetrics(result.postSync)
  );
}
