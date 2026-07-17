import assert from "node:assert/strict";
import test from "node:test";

import {
  isLipsyncOperationResult,
  LIPSYNC_MODEL,
  v2SyncPasses,
  v2SyncVerdict,
  type SyncNetMetrics,
} from "../lib/v2-sync.ts";
import { lipsync2ProCostFromDuration } from "../lib/cost.ts";

const metrics = (
  confidence: number,
  distance: number,
  offsetSec = -0.04
): SyncNetMetrics => ({
  confidence,
  distance,
  offsetSec,
  speechPercentage: 0.87,
});

test("V2 SyncNet gate admits its exact confidence and distance boundaries", () => {
  assert.equal(v2SyncPasses(metrics(4, 10)), true);
  assert.equal(v2SyncPasses(metrics(3.999, 10)), false);
  assert.equal(v2SyncPasses(metrics(4, 10.001)), false);
});

test("verdict stays absolute without a baseline or when the source passes", () => {
  const noBaseline = v2SyncVerdict(metrics(3.9, 8));
  assert.equal(noBaseline.pass, false);
  assert.equal(noBaseline.mode, "absolute");
  assert.equal(v2SyncVerdict(metrics(4.2, 8), null).pass, true);

  // A source that clears 4/10 keeps the absolute bar: "almost as good as a
  // healthy source" is not a pass.
  const healthySource = metrics(6.5, 7);
  const nearMiss = v2SyncVerdict(metrics(3.9, 8), healthySource);
  assert.equal(nearMiss.pass, false);
  assert.equal(nearMiss.mode, "absolute");
});

test("run_bg01_049 regression: a quiet-speaker source admits its within-tolerance Final", () => {
  // Live 2026-07-16 evidence — source confidence 2.65 (47% speech), Final
  // candidate 2.74/7.42/-0.04s scored BETTER than the source yet the absolute
  // gate billed an unwinnable $0.82 repair and sealed the run failed.
  const quietSource: SyncNetMetrics = {
    confidence: 2.65,
    distance: 7.5,
    offsetSec: -0.02,
    speechPercentage: 0.47,
  };
  const candidate = v2SyncVerdict(metrics(2.74, 7.42, -0.04), quietSource);
  assert.equal(candidate.pass, true);
  assert.equal(candidate.mode, "source_relative");

  // The $0.82 repair that reached 3.70/6.76/0 must also count as a pass so
  // recovery of the already-sealed run can settle instead of re-killing it.
  const repaired = v2SyncVerdict(metrics(3.7, 6.76, 0), quietSource);
  assert.equal(repaired.pass, true);
  assert.equal(repaired.mode, "source_relative");
});

test("source-relative bar still refuses real regressions", () => {
  const quietSource = metrics(2.65, 7.5, -0.02);
  // Confidence tolerance: 2.65 - 0.5 = 2.15 is the exact floor.
  assert.equal(v2SyncVerdict(metrics(2.15, 8), quietSource).pass, true);
  assert.equal(v2SyncVerdict(metrics(2.149, 8), quietSource).pass, false);
  // Distance headroom never shrinks below the absolute 10.
  assert.equal(v2SyncVerdict(metrics(2.74, 10, 0), quietSource).pass, true);
  assert.equal(v2SyncVerdict(metrics(2.74, 10.001, 0), quietSource).pass, false);
  // The relative gate must refuse real A/V drift outright (~1 frame cap).
  assert.equal(v2SyncVerdict(metrics(2.74, 7.42, 0.05), quietSource).pass, true);
  assert.equal(
    v2SyncVerdict(metrics(2.74, 7.42, -0.051), quietSource).pass,
    false
  );
});

test("an absolute pass is always sufficient, even in source-relative mode", () => {
  // Offset is only guarded when the gate is trading away the confidence bar;
  // metrics that clear 4/10 outright pass exactly as they always have.
  const quietSource = metrics(2.65, 7.5);
  const verdict = v2SyncVerdict(metrics(5.2, 8, 0.3), quietSource);
  assert.equal(verdict.pass, true);
  assert.equal(verdict.mode, "source_relative");
});

test("relative thresholds clamp to the absolute bar via min/max", () => {
  // A source failing only on distance keeps confidence pinned at min(4, 4.5).
  const farSource = metrics(5.0, 12, 0);
  assert.equal(v2SyncVerdict(metrics(4.05, 12.9, 0), farSource).pass, true);
  assert.equal(v2SyncVerdict(metrics(3.9, 12.9, 0), farSource).pass, false);
  // Distance headroom follows the source: max(10, 12 + 1) = 13.
  assert.equal(v2SyncVerdict(metrics(4.05, 13.001, 0), farSource).pass, false);
});

test("a corrupt baseline degrades to the absolute gate", () => {
  const corrupt = metrics(Number.NaN, 7.5);
  const verdict = v2SyncVerdict(metrics(3.9, 8), corrupt);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.mode, "absolute");
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
