import assert from "node:assert/strict";
import test from "node:test";

import {
  isLipsyncOperationResult,
  LIPSYNC_MODEL,
  v2SyncPasses,
  type SyncNetMetrics,
} from "../lib/v2-sync.ts";
import { lipsync2ProCostFromDuration } from "../lib/cost.ts";

const metrics = (
  confidence: number,
  distance: number
): SyncNetMetrics => ({
  confidence,
  distance,
  offsetSec: -0.04,
  speechPercentage: 0.87,
});

test("V2 SyncNet gate admits its exact confidence and distance boundaries", () => {
  assert.equal(v2SyncPasses(metrics(4, 10)), true);
  assert.equal(v2SyncPasses(metrics(3.999, 10)), false);
  assert.equal(v2SyncPasses(metrics(4, 10.001)), false);
});

test("Lipsync cost is derived from actual output duration", () => {
  assert.ok(Math.abs(lipsync2ProCostFromDuration(5.3) - 0.441225) < 1e-12);
  assert.throws(() => lipsync2ProCostFromDuration(0), /positive and finite/);
});

test("completed Lipsync results retain both SyncNet checks", () => {
  assert.equal(
    isLipsyncOperationResult({
      predictionId: "prediction_fixture",
      model: LIPSYNC_MODEL,
      videoUrl: "/api/media/runs/run_fixture/relit-v2.mp4",
      billableDurationSec: 5.3,
      costUsd: 0.441225,
      audioVerified: true,
      preSync: metrics(3.38, 11.22),
      postSync: metrics(6.2, 8.1),
    }),
    true
  );
});
