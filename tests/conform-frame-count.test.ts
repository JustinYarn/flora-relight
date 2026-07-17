import assert from "node:assert/strict";
import test from "node:test";

import { conformedFrameCount } from "../lib/server/ffmpeg.ts";

test("conform cuts land on the nearest whole frame at every source rate", () => {
  // Regression pin — live 2026-07-17, run_bg02_098: a 24fps conform to 9.92s
  // cut with `-t` kept 239 frames (9.958s), 60ms past the 9.90s source audio
  // and just over the ±50ms container allowance, so the app rejected its own
  // billed Lipsync repair. The frame-count cut keeps 238.
  assert.equal(conformedFrameCount(9.92, 24), 238);
  assert.equal(238 / 24 < 9.95, true);

  // 30fps sources (049-class) stay exact.
  assert.equal(conformedFrameCount(9.9, 30), 297);
  // 29fps ingest values round sanely.
  assert.equal(conformedFrameCount(9.93, 29), 288);
  // Never zero frames, even for sub-frame durations.
  assert.equal(conformedFrameCount(0.01, 24), 1);
});

test("conform math refuses degenerate inputs", () => {
  assert.throws(() => conformedFrameCount(0, 24), /positive finite duration/);
  assert.throws(() => conformedFrameCount(9.9, 0), /positive finite frame rate/);
  assert.throws(
    () => conformedFrameCount(Number.NaN, 24),
    /positive finite duration/
  );
});
