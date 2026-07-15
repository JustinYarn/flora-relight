export const V2_SYNC_MIN_CONFIDENCE = 4;
export const V2_SYNC_MAX_DISTANCE = 10;
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
