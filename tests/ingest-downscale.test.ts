import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_INGEST_HEIGHT,
  MAX_INGEST_WIDTH,
  needsIngestDownscale,
} from "../lib/server/ffmpeg.ts";

test("ingest downscale caps at the provider-safe 1080p frame", () => {
  assert.equal(MAX_INGEST_WIDTH, 1920);
  assert.equal(MAX_INGEST_HEIGHT, 1080);
});

test("every internal-50 resolution class routes correctly", () => {
  // The four resolutions present in webcam-clips-internal-50/manifest.csv.
  assert.equal(needsIngestDownscale(3840, 2160), true); // 4K — killed a live run
  assert.equal(needsIngestDownscale(2880, 1620), true); // QHD+
  assert.equal(needsIngestDownscale(1920, 1080), false); // proven safe
  assert.equal(needsIngestDownscale(1280, 720), false);
});

test("either oversized axis alone triggers the downscale", () => {
  assert.equal(needsIngestDownscale(2560, 1080), true); // ultrawide
  assert.equal(needsIngestDownscale(1080, 2160), true); // portrait 4K
  assert.equal(needsIngestDownscale(1920, 1200), true); // 16:10 over height
});
