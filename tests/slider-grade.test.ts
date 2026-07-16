import assert from "node:assert/strict";
import test from "node:test";

import {
  isSliderClipComplete,
  isSliderScore,
  isSliderScoreForEval,
  numericScoreForAnswer,
  pointsForSliderScore,
  verdictForSliderScore,
} from "../lib/slider-grade.ts";

test("slider scores accept only integer values from 0 through 100", () => {
  assert.equal(isSliderScore(0), true);
  assert.equal(isSliderScore(100), true);
  assert.equal(isSliderScore(72), true);
  assert.equal(isSliderScore(-1), false);
  assert.equal(isSliderScore(101), false);
  assert.equal(isSliderScore(72.5), false);
  assert.equal(isSliderScore(Number.NaN), false);
  assert.equal(isSliderScore("72"), false);
});

test("slider compatibility buckets preserve every legacy human-score anchor", () => {
  assert.equal(pointsForSliderScore(30), 1);
  assert.equal(pointsForSliderScore(55), 2);
  assert.equal(pointsForSliderScore(72), 3);
  assert.equal(pointsForSliderScore(85), 4);
  assert.equal(pointsForSliderScore(95), 5);

  assert.equal(pointsForSliderScore(39), 1);
  assert.equal(pointsForSliderScore(40), 2);
  assert.equal(pointsForSliderScore(64), 2);
  assert.equal(pointsForSliderScore(65), 3);
  assert.equal(pointsForSliderScore(79), 3);
  assert.equal(pointsForSliderScore(80), 4);
  assert.equal(pointsForSliderScore(94), 4);
  assert.equal(pointsForSliderScore(100), 5);
});

test("audio slider scores stay binary while visual checks remain continuous", () => {
  assert.equal(isSliderScoreForEval("audio-integrity", 0), true);
  assert.equal(isSliderScoreForEval("audio-integrity", 100), true);
  assert.equal(isSliderScoreForEval("audio-integrity", 50), false);
  assert.equal(isSliderScoreForEval("lighting-quality-delta", 50), true);
});

test("slider verdicts use the exact threshold of the rubric row", () => {
  const lighting = { passThreshold: 80, borderlineThreshold: 65 };
  assert.equal(verdictForSliderScore(79, lighting), "borderline");
  assert.equal(verdictForSliderScore(80, lighting), "pass");
  assert.equal(verdictForSliderScore(64, lighting), "fail");
  assert.equal(verdictForSliderScore(65, lighting), "borderline");

  const identity = { passThreshold: 88, borderlineThreshold: 75 };
  assert.equal(verdictForSliderScore(85, identity), "borderline");
  assert.equal(verdictForSliderScore(88, identity), "pass");
});

test("slider completion requires an exact numerical answer for every row", () => {
  const complete = {
    answers: {
      lighting: { points: 4 as const, numericScore: 84, note: "" },
      identity: { points: 5 as const, numericScore: 96, note: "" },
    },
    overallNote: "",
  };
  assert.equal(
    isSliderClipComplete(complete, ["lighting", "identity"]),
    true
  );
  assert.equal(isSliderClipComplete(complete, ["lighting", "audio"]), false);
  assert.equal(
    numericScoreForAnswer({ points: 4, numericScore: 84, note: "" }),
    84
  );
  assert.equal(
    numericScoreForAnswer({ points: 4, numericScore: 84.5, note: "" }),
    undefined
  );
});
