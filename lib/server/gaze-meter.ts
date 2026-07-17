/**
 * GazeMeter — the deterministic measurement backend behind
 * lib/lamp-iris-gaze.ts. Samples a clip at ~3.6 fps (≤36 frames), runs face +
 * iris landmarking per frame, and aggregates iris-in-aperture positions and
 * an eye-aspect-ratio blink trace into `LampIrisGazeMeasurements`.
 *
 * Deliberately NOT marked "server-only" (the v2-sync-config.ts precedent):
 * scripts/validate-gaze-meter.mjs and tests import this file directly under
 * `node --experimental-strip-types`, where the marker package would throw.
 * It still must never be imported from client code — it spawns ffmpeg and
 * loads a wasm inference engine.
 *
 * Backend choice (measured on this repo, Node 22.23, macOS arm64):
 * - @mediapipe/tasks-vision (preferred) is unusable in Node: after shimming
 *   its script loader (`self.ModuleFactory` + importScripts→require of a
 *   .cjs copy, dummy canvas, WebGL class stubs) the graph does start CPU-only,
 *   but the bundle's ONLY image-input path is `_addBoundTextureAsImageToStream`
 *   — a WebGL texture upload (`ia()` in vision_bundle demands a real
 *   `canvas.getContext("webgl")` and the wasm calls back into GL to read the
 *   texture). Node has no WebGL; headless-gl would add a fragile native build.
 * - @tensorflow/tfjs-node is also unusable here: no darwin prebuilt binding
 *   for Node 22 (napi-v8 tarball 404s) and the node-gyp source fallback
 *   breaks on the space in this worktree's path (unquoted include dirs).
 * - @vladmandic/human on the pure-wasm tfjs backend works: prebuilt wasm, no
 *   native code, models shipped inside the npm package, ~30 ms per frame,
 *   bit-identical output across runs. Its 478-point mesh uses the canonical
 *   MediaPipe indices (iris points 468-477), so the geometry below matches
 *   what the tasks-vision backend would have produced.
 *
 * Determinism: fixed sampling grid, lossless PNG frames, single-threaded wasm
 * inference with a fresh engine per call (`cacheSensitivity: 0`, no temporal
 * state), and fixed-precision rounding before emit. Same file in, same bytes
 * out.
 *
 * Fail-open: any error, missing asset, timeout (~90 s hard cap), or a face
 * detection rate below 0.3 logs one console.warn line and returns null.
 * Callers never see a throw.
 */

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import {
  LAMP_IRIS_GAZE_METER_VERSION,
  type LampIrisGazeMeasurements,
} from "../lamp-iris-gaze.ts";

/** Sampling grid: 18/5 = 3.6 fps exactly; ≤36 frames covers a 10 s clip. */
const SAMPLE_FPS_NUM = 18;
const SAMPLE_FPS_DEN = 5;
const MAX_FRAMES = 36;
/** Frames are downscaled to this width before landmarking. */
const FRAME_WIDTH = 640;
/** Hard wall-clock cap for one video, per the fail-open contract. */
const HARD_CAP_MS = 90_000;
/** Below this fraction of frames with a face the numbers are noise. */
const MIN_DETECTION_RATE = 0.3;
/** Mesh confidence for a frame to count as "confident face". */
const MIN_FACE_SCORE = 0.5;
/** EAR below this fraction of the clip's median EAR reads as a blink dip. */
const BLINK_EAR_FRACTION = 0.7;

/**
 * Canonical MediaPipe FaceMesh indices. Eye "A" is the subject's right eye,
 * "B" the left, but nothing below depends on that labeling: iris clusters
 * are assigned to eyes by proximity, and both eyes are averaged anyway.
 * EAR points are ordered p1..p6 for EAR = (|p2-p6| + |p3-p5|) / (2|p1-p4|).
 */
interface EyeSpec {
  corners: readonly [number, number];
  upperLid: readonly [number, number, number];
  lowerLid: readonly [number, number, number];
  ear: readonly [number, number, number, number, number, number];
}
const EYE_A: EyeSpec = {
  corners: [33, 133],
  upperLid: [160, 159, 158],
  lowerLid: [144, 145, 153],
  ear: [33, 160, 158, 133, 153, 144],
};
const EYE_B: EyeSpec = {
  corners: [362, 263],
  upperLid: [385, 386, 387],
  lowerLid: [373, 374, 380],
  ear: [362, 385, 387, 263, 373, 380],
};
const IRIS_CLUSTER_1 = [468, 469, 470, 471, 472] as const;
const IRIS_CLUSTER_2 = [473, 474, 475, 476, 477] as const;

interface Point {
  x: number;
  y: number;
}

/** Minimal structural view of the @vladmandic/human API surface we use. */
interface HumanFace {
  faceScore?: number;
  score?: number;
  meshRaw?: number[][];
}
interface HumanTensor {
  dispose(): void;
}
interface HumanLike {
  load(): Promise<unknown>;
  detect(input: HumanTensor): Promise<{ face: HumanFace[] }>;
  tf: {
    tensor3d(
      values: Uint8Array,
      shape: [number, number, number],
      dtype: "int32"
    ): HumanTensor;
  };
}
type HumanCtor = new (config: Record<string, unknown>) => HumanLike;

class GazeMeterFailure extends Error {}

const nodeRequire = createRequire(import.meta.url);

let fetchBridgeInstalled = false;
/**
 * tfjs's browser build loads model json/weights and the backend wasm via
 * fetch(). Bridge absolute local paths under our asset roots to disk reads;
 * every other request passes through untouched. Idempotent per process.
 */
function installLocalFetchBridge(assetRoots: string[]): void {
  if (fetchBridgeInstalled) return;
  fetchBridgeInstalled = true;
  const roots = assetRoots.map((r) => path.resolve(r) + path.sep);
  const passthrough = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(
      typeof input === "object" && input !== null && "url" in input
        ? input.url
        : input
    );
    const localPath = url.startsWith("file://") ? url.slice(7) : url;
    if (
      path.isAbsolute(localPath) &&
      roots.some((root) => path.resolve(localPath).startsWith(root)) &&
      fs.existsSync(localPath)
    ) {
      const body = await fsp.readFile(localPath);
      const contentType = localPath.endsWith(".json")
        ? "application/json"
        : localPath.endsWith(".wasm")
          ? "application/wasm"
          : "application/octet-stream";
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { "Content-Type": contentType },
      });
    }
    return passthrough(input as RequestInfo, init);
  }) as typeof fetch;
}

/**
 * Model directory: @vladmandic/human ships its models inside the npm package,
 * so no CDN download is needed. LAMP_IRIS_GAZE_MODEL_PATH (kept from the
 * meter contract) overrides the directory holding blazeface/facemesh/iris
 * model files for pinned or air-gapped deployments.
 */
function resolveModelDir(humanPackageDir: string): string {
  const override = process.env.LAMP_IRIS_GAZE_MODEL_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(humanPackageDir, "models");
}

async function createEngine(): Promise<HumanLike> {
  // The package's exports map lacks "./" prefixes on its subpath keys, so
  // Node treats them as conditions; the bare specifier resolves to
  // human.node.js (which hard-requires @tensorflow/tfjs-node). Reach the
  // wasm dist by absolute file path — exports maps do not apply there.
  const humanDistDir = path.dirname(nodeRequire.resolve("@vladmandic/human"));
  const humanPackageDir = path.dirname(humanDistDir);
  const wasmDistDir = path.dirname(
    nodeRequire.resolve("@tensorflow/tfjs-backend-wasm")
  );
  const modelDir = resolveModelDir(humanPackageDir);
  installLocalFetchBridge([modelDir, wasmDistDir]);

  const loaded: unknown = nodeRequire(
    path.join(humanDistDir, "human.node-wasm.js")
  );
  const ctor = (loaded as { default?: unknown }).default ?? loaded;
  if (typeof ctor !== "function") {
    throw new GazeMeterFailure("human dist did not export a constructor");
  }
  const human = new (ctor as HumanCtor)({
    backend: "wasm",
    wasmPath: wasmDistDir + path.sep,
    modelBasePath: modelDir,
    cacheSensitivity: 0,
    debug: false,
    filter: { enabled: false },
    face: {
      enabled: true,
      detector: { rotation: false, maxDetected: 1, minConfidence: 0.2 },
      mesh: { enabled: true },
      iris: { enabled: true },
      attention: { enabled: false },
      emotion: { enabled: false },
      description: { enabled: false },
      antispoof: { enabled: false },
      liveness: { enabled: false },
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    gesture: { enabled: false },
    segmentation: { enabled: false },
  });
  await human.load();
  return human;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const binary = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
    // Args array, never a shell string — paths with spaces/quotes stay inert.
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new GazeMeterFailure("ffmpeg timed out"));
      }
    }, Math.max(1, timeoutMs));
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-400);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new GazeMeterFailure(`ffmpeg spawn failed: ${error.message}`));
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const line = stderrTail.split("\n").filter(Boolean).pop() ?? "";
        reject(new GazeMeterFailure(`ffmpeg exited ${code}: ${line}`));
      }
    });
  });
}

function meshPoint(mesh: number[][], index: number, w: number, h: number): Point {
  const entry = mesh[index];
  return { x: entry[0] * w, y: entry[1] * h };
}

function meanPoint(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function eyeAspectRatio(mesh: number[][], eye: EyeSpec, w: number, h: number): number {
  const [p1, p2, p3, p4, p5, p6] = eye.ear.map((i) => meshPoint(mesh, i, w, h));
  const horizontal = distance(p1, p4);
  if (horizontal < 1e-6) return 0;
  return (distance(p2, p6) + distance(p3, p5)) / (2 * horizontal);
}

/**
 * Iris center normalized inside one eye's aperture box. x runs 0 at the
 * image-left corner of the aperture to 1 at the image-right corner (projected
 * onto the corner-to-corner axis, robust to mild head roll). y runs 0 at the
 * upper lid to 1 at the lower lid — image y grows downward, so a gaze lifted
 * toward the camera moves the iris toward the upper lid and y toward 0,
 * exactly the contract's "LOWER medianIrisY means the gaze lifted".
 */
function normalizedIrisPosition(
  mesh: number[][],
  eye: EyeSpec,
  iris: Point,
  w: number,
  h: number
): { x: number; y: number } | null {
  const cornerA = meshPoint(mesh, eye.corners[0], w, h);
  const cornerB = meshPoint(mesh, eye.corners[1], w, h);
  const eyeCenter = meanPoint([cornerA, cornerB]);
  const cornerSpan = distance(cornerA, cornerB);
  if (cornerSpan < 2) return null;
  // The iris cluster must actually sit in this eye; a wildly displaced iris
  // (occlusion, model glitch on AI-generated eyes) invalidates the sample.
  if (distance(iris, eyeCenter) > 0.75 * cornerSpan) return null;

  const [left, right] = cornerA.x <= cornerB.x ? [cornerA, cornerB] : [cornerB, cornerA];
  const axisX = right.x - left.x;
  const axisY = right.y - left.y;
  const x =
    ((iris.x - left.x) * axisX + (iris.y - left.y) * axisY) /
    (axisX * axisX + axisY * axisY);

  const upperY = meanPoint(eye.upperLid.map((i) => meshPoint(mesh, i, w, h))).y;
  const lowerY = meanPoint(eye.lowerLid.map((i) => meshPoint(mesh, i, w, h))).y;
  const aperture = lowerY - upperY;
  if (aperture < 0.5) return null;
  const y = (iris.y - upperY) / aperture;
  return { x, y };
}

function median(values: number[]): number {
  return quantile(values, 0.5);
}

/** Linear-interpolation quantile over a sorted copy; deterministic. */
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function interquartileRange(values: number[]): number {
  return quantile(values, 0.75) - quantile(values, 0.25);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

interface FrameSample {
  timestampSec: number;
  hasFace: boolean;
  irisX: number | null;
  irisY: number | null;
  ear: number | null;
}

async function analyzeFrames(
  human: HumanLike,
  frameDir: string,
  frameFiles: string[],
  deadline: number
): Promise<FrameSample[]> {
  const samples: FrameSample[] = [];
  for (let i = 0; i < frameFiles.length; i++) {
    if (Date.now() > deadline) {
      throw new GazeMeterFailure("hard time cap exceeded during landmarking");
    }
    const timestampSec = round((i * SAMPLE_FPS_DEN) / SAMPLE_FPS_NUM, 3);
    const { data, info } = await sharp(path.join(frameDir, frameFiles[i]))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tensor = human.tf.tensor3d(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      [info.height, info.width, 3],
      "int32"
    );
    let result: { face: HumanFace[] };
    try {
      result = await human.detect(tensor);
    } finally {
      tensor.dispose();
    }

    const face = result.face.find(
      (f) =>
        (f.faceScore ?? f.score ?? 0) >= MIN_FACE_SCORE &&
        Array.isArray(f.meshRaw) &&
        f.meshRaw.length >= 478
    );
    if (!face || !face.meshRaw) {
      samples.push({ timestampSec, hasFace: false, irisX: null, irisY: null, ear: null });
      continue;
    }

    const mesh = face.meshRaw;
    const w = info.width;
    const h = info.height;
    const ear =
      (eyeAspectRatio(mesh, EYE_A, w, h) + eyeAspectRatio(mesh, EYE_B, w, h)) / 2;

    // Assign the two iris clusters to eyes by proximity — Human/MediaPipe
    // left-right index conventions never enter the math.
    const cluster1 = meanPoint(IRIS_CLUSTER_1.map((i) => meshPoint(mesh, i, w, h)));
    const cluster2 = meanPoint(IRIS_CLUSTER_2.map((i) => meshPoint(mesh, i, w, h)));
    const centerA = meanPoint(EYE_A.corners.map((i) => meshPoint(mesh, i, w, h)));
    const irisForA =
      distance(cluster1, centerA) <= distance(cluster2, centerA) ? cluster1 : cluster2;
    const irisForB = irisForA === cluster1 ? cluster2 : cluster1;

    const posA = normalizedIrisPosition(mesh, EYE_A, irisForA, w, h);
    const posB = normalizedIrisPosition(mesh, EYE_B, irisForB, w, h);
    const both = posA !== null && posB !== null;
    samples.push({
      timestampSec,
      hasFace: true,
      irisX: both ? (posA.x + posB.x) / 2 : null,
      irisY: both ? (posA.y + posB.y) / 2 : null,
      ear,
    });
  }
  return samples;
}

interface BlinkTrace {
  blinkCount: number;
  blinkTimestampsSec: number[];
  dipTimestamps: Set<number>;
}

/**
 * Blink events from the EAR trace: a run of consecutive sampled frames with
 * EAR below BLINK_EAR_FRACTION x the clip's median EAR is one blink (runs
 * separated by a single non-dip sample are merged — lid re-openings shorter
 * than the ~278 ms sampling period are the same blink). The event timestamp
 * is the deepest frame of the run.
 */
function detectBlinks(samples: FrameSample[]): BlinkTrace {
  const earSamples = samples.filter(
    (s): s is FrameSample & { ear: number } => s.ear !== null
  );
  if (earSamples.length === 0) {
    return { blinkCount: 0, blinkTimestampsSec: [], dipTimestamps: new Set() };
  }
  const threshold = BLINK_EAR_FRACTION * median(earSamples.map((s) => s.ear));
  const dipTimestamps = new Set<number>();
  const runs: FrameSample[][] = [];
  let current: FrameSample[] = [];
  let gap = 0;
  for (const sample of samples) {
    const isDip = sample.ear !== null && sample.ear < threshold;
    if (isDip) {
      dipTimestamps.add(sample.timestampSec);
      if (current.length > 0 && gap > 1) {
        runs.push(current);
        current = [];
      }
      current.push(sample);
      gap = 0;
    } else {
      gap += 1;
    }
  }
  if (current.length > 0) runs.push(current);

  const blinkTimestampsSec = runs.map((run) => {
    let deepest = run[0];
    for (const sample of run) {
      if ((sample.ear ?? Infinity) < (deepest.ear ?? Infinity)) deepest = sample;
    }
    return deepest.timestampSec;
  });
  return { blinkCount: runs.length, blinkTimestampsSec, dipTimestamps };
}

/**
 * Measure a video's gaze trace. Resolves to null — never throws — when the
 * clip cannot be measured confidently (see module doc).
 */
export async function measureLampIrisGaze(
  videoPath: string
): Promise<LampIrisGazeMeasurements | null> {
  const deadline = Date.now() + HARD_CAP_MS;
  let frameDir: string | null = null;
  try {
    await fsp.access(videoPath, fs.constants.R_OK);
    frameDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lamp-iris-gaze-"));
    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        videoPath,
        "-vf",
        `fps=${SAMPLE_FPS_NUM}/${SAMPLE_FPS_DEN},scale=${FRAME_WIDTH}:-2:flags=bicubic`,
        "-frames:v",
        String(MAX_FRAMES),
        "-y",
        path.join(frameDir, "frame-%03d.png"),
      ],
      Math.min(60_000, deadline - Date.now())
    );
    const frameFiles = (await fsp.readdir(frameDir))
      .filter((name) => name.endsWith(".png"))
      .sort();
    if (frameFiles.length === 0) {
      throw new GazeMeterFailure("ffmpeg produced no frames");
    }

    const human = await createEngine();
    const samples = await analyzeFrames(human, frameDir, frameFiles, deadline);

    const framesAnalyzed = samples.length;
    const facesFound = samples.filter((s) => s.hasFace).length;
    const faceDetectionRate = facesFound / framesAnalyzed;
    if (faceDetectionRate < MIN_DETECTION_RATE) {
      throw new GazeMeterFailure(
        `face detection rate ${faceDetectionRate.toFixed(2)} below ${MIN_DETECTION_RATE}`
      );
    }

    const blinks = detectBlinks(samples);
    // Blink-dip frames are excluded from iris-position statistics: with the
    // lids closing, "position inside the aperture" is meaningless.
    const irisSamples = samples.filter(
      (s): s is FrameSample & { irisX: number; irisY: number } =>
        s.irisX !== null &&
        s.irisY !== null &&
        !blinks.dipTimestamps.has(s.timestampSec)
    );
    if (irisSamples.length < 4) {
      throw new GazeMeterFailure(
        `only ${irisSamples.length} usable iris samples`
      );
    }
    const xs = irisSamples.map((s) => s.irisX);
    const ys = irisSamples.map((s) => s.irisY);

    return {
      version: LAMP_IRIS_GAZE_METER_VERSION,
      framesAnalyzed,
      faceDetectionRate: round(faceDetectionRate, 4),
      medianIrisX: round(median(xs), 4),
      medianIrisY: round(median(ys), 4),
      irisXDispersion: round(interquartileRange(xs), 4),
      irisYDispersion: round(interquartileRange(ys), 4),
      blinkCount: blinks.blinkCount,
      blinkTimestampsSec: blinks.blinkTimestampsSec,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[gaze-meter] fail-open, no measurements: ${reason} (${videoPath})`);
    return null;
  } finally {
    if (frameDir) {
      await fsp.rm(frameDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
