import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_DURATION_TOLERANCE_SEC,
  audioIntegrityDurationsAgree,
  audioPresenceMatchesSource,
} from "../lib/server/audio-integrity.ts";

const SOURCE_DURATION_SEC = 10;
const OUTSIDE_TOLERANCE_SEC = AUDIO_DURATION_TOLERANCE_SEC + 0.01;

test("audio integrity rejects a shorter raw provider output", () => {
  const shorter = SOURCE_DURATION_SEC - OUTSIDE_TOLERANCE_SEC;

  assert.equal(
    audioIntegrityDurationsAgree({
      sourceVideoDurationSec: SOURCE_DURATION_SEC,
      rawVideoDurationSec: shorter,
      finalVideoDurationSec: shorter,
      sourceAudioDurationSec: SOURCE_DURATION_SEC,
    }),
    false
  );
});

test("audio integrity rejects a longer raw provider output hidden by remux -shortest", () => {
  assert.equal(
    audioIntegrityDurationsAgree({
      sourceVideoDurationSec: SOURCE_DURATION_SEC,
      rawVideoDurationSec: SOURCE_DURATION_SEC + OUTSIDE_TOLERANCE_SEC,
      finalVideoDurationSec: SOURCE_DURATION_SEC,
      sourceAudioDurationSec: SOURCE_DURATION_SEC,
    }),
    false
  );
});

test("audio integrity rejects a remuxed final with a shorter timeline", () => {
  assert.equal(
    audioIntegrityDurationsAgree({
      sourceVideoDurationSec: SOURCE_DURATION_SEC,
      rawVideoDurationSec: SOURCE_DURATION_SEC,
      finalVideoDurationSec: SOURCE_DURATION_SEC - OUTSIDE_TOLERANCE_SEC,
      sourceAudioDurationSec: SOURCE_DURATION_SEC,
    }),
    false
  );
});

test("audio integrity accepts probe rounding only when all durations fit the tolerance", () => {
  assert.equal(
    audioIntegrityDurationsAgree({
      sourceVideoDurationSec: SOURCE_DURATION_SEC,
      rawVideoDurationSec: SOURCE_DURATION_SEC + 0.02,
      finalVideoDurationSec: SOURCE_DURATION_SEC - 0.02,
      sourceAudioDurationSec: SOURCE_DURATION_SEC,
    }),
    true
  );
  assert.equal(
    audioIntegrityDurationsAgree({
      sourceVideoDurationSec: SOURCE_DURATION_SEC,
      rawVideoDurationSec: SOURCE_DURATION_SEC + AUDIO_DURATION_TOLERANCE_SEC,
      finalVideoDurationSec: SOURCE_DURATION_SEC,
      sourceAudioDurationSec: SOURCE_DURATION_SEC,
    }),
    true
  );
});

test("audio integrity rejects model-generated audio when the source is silent", () => {
  assert.equal(audioPresenceMatchesSource(false, true), false);
  assert.equal(audioPresenceMatchesSource(false, false), true);
});

test("silent-source integrity still requires the complete source video timeline", () => {
  assert.equal(
    audioIntegrityDurationsAgree({
      sourceVideoDurationSec: SOURCE_DURATION_SEC,
      rawVideoDurationSec: SOURCE_DURATION_SEC - OUTSIDE_TOLERANCE_SEC,
      finalVideoDurationSec: SOURCE_DURATION_SEC - OUTSIDE_TOLERANCE_SEC,
    }),
    false
  );
  assert.equal(
    audioIntegrityDurationsAgree({
      sourceVideoDurationSec: SOURCE_DURATION_SEC,
      rawVideoDurationSec: SOURCE_DURATION_SEC,
      finalVideoDurationSec: SOURCE_DURATION_SEC,
    }),
    true
  );
});
