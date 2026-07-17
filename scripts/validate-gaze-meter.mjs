// Validation harness for lib/server/gaze-meter.ts against the real
// run_mrpas6x9_3lhsc artifacts. Run from the repo root with:
//
//   source ~/.nvm/nvm.sh && nvm use && \
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/validate-gaze-meter.mjs
//
// Prints every measurement field for source/relit-v1/relit-v2, the
// compareLampIrisGaze() results against the source, a byte-determinism check
// (source measured twice), and an honest acceptance-gate table.
//
// Calibration truth for this run: a human judged BOTH relit candidates as
// near-copies of the source gaze — SMALL verticalLift (< ~0.05) means the
// meter AGREES with the human. Small numbers here are success.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { measureLampIrisGaze } from "../lib/server/gaze-meter.ts";
import {
  LAMP_IRIS_GAZE_MIN_DETECTION_RATE,
  LAMP_IRIS_NEAR_COPY_LIFT_FLOOR,
  compareLampIrisGaze,
  isLampIrisGazeMeasurements,
  lampIrisGazeMeasurementsUsable,
} from "../lib/lamp-iris-gaze.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runDir = path.join(repoRoot, "data", "runs", "run_mrpas6x9_3lhsc");
const videos = [
  { label: "source", file: path.join(runDir, "source.mp4") },
  { label: "relit-v1", file: path.join(runDir, "relit-v1.mp4") },
  { label: "relit-v2", file: path.join(runDir, "relit-v2.mp4") },
];

function heading(text) {
  console.log(`\n=== ${text} ===`);
}

const measurements = {};
const timings = {};
for (const { label, file } of videos) {
  const startedAt = Date.now();
  const result = await measureLampIrisGaze(file);
  timings[label] = Date.now() - startedAt;
  measurements[label] = result;
  heading(`${label} (${(timings[label] / 1000).toFixed(1)}s)`);
  if (result === null) {
    console.log("measurements: null (fail-open)");
    continue;
  }
  console.log(JSON.stringify(result, null, 2));
  console.log(
    `valid per contract: ${isLampIrisGazeMeasurements(result)}; usable (rate >= ${LAMP_IRIS_GAZE_MIN_DETECTION_RATE}): ${lampIrisGazeMeasurementsUsable(result)}`
  );
}

const source = measurements["source"];
const comparisons = {};
for (const label of ["relit-v1", "relit-v2"]) {
  const candidate = measurements[label];
  heading(`compareLampIrisGaze(source, ${label})`);
  if (!source || !candidate) {
    console.log("skipped: missing measurements");
    continue;
  }
  const comparison = compareLampIrisGaze(source, candidate);
  comparisons[label] = comparison;
  console.log(JSON.stringify(comparison, null, 2));
  const nearCopy = comparison.verticalLift < LAMP_IRIS_NEAR_COPY_LIFT_FLOOR;
  console.log(
    `verticalLift ${comparison.verticalLift.toFixed(4)} is ${
      nearCopy ? "BELOW" : "at/above"
    } the near-copy floor (${LAMP_IRIS_NEAR_COPY_LIFT_FLOOR}) -> meter ${
      nearCopy ? "AGREES with the human near-copy judgment" : "sees a real lift"
    }`
  );
}

heading("determinism (source measured twice)");
const sourceAgain = await measureLampIrisGaze(videos[0].file);
const first = JSON.stringify(source);
const second = JSON.stringify(sourceAgain);
const deterministic = first === second;
console.log(`byte-identical JSON: ${deterministic}`);
if (!deterministic) {
  console.log(`run 1: ${first}`);
  console.log(`run 2: ${second}`);
}

heading("acceptance gates");
const gates = [];
for (const { label } of videos) {
  const m = measurements[label];
  gates.push({
    gate: `${label}: non-null with faceDetectionRate >= 0.6`,
    pass: m !== null && m.faceDetectionRate >= 0.6,
    detail: m === null ? "null" : `rate ${m.faceDetectionRate}`,
  });
}
gates.push({
  gate: "source: >= 1 blink detected",
  pass: source !== null && source.blinkCount >= 1,
  detail: source === null ? "null" : `${source.blinkCount} blinks at [${source.blinkTimestampsSec.join(", ")}]s`,
});
for (const label of ["relit-v1", "relit-v2"]) {
  const c = comparisons[label];
  gates.push({
    gate: `${label}: verticalLift reported honestly`,
    pass: c !== undefined,
    detail: c === undefined ? "missing" : `verticalLift ${c.verticalLift.toFixed(4)} (small = agrees with human near-copy call)`,
  });
}
gates.push({
  gate: "determinism: byte-identical JSON on repeat source run",
  pass: deterministic,
  detail: deterministic ? "identical" : "MISMATCH",
});

let allPassed = true;
for (const { gate, pass, detail } of gates) {
  if (!pass) allPassed = false;
  console.log(`${pass ? "PASS" : "FAIL"}  ${gate} — ${detail}`);
}
console.log(`\noverall: ${allPassed ? "ALL GATES PASSED" : "SOME GATES FAILED"}`);
process.exit(allPassed ? 0 : 1);
