/**
 * Thin promisified wrappers around the system ffmpeg binary.
 *
 * SERVER ONLY — imports node:child_process. Never import from client code.
 *
 * Safety: every invocation uses child_process.spawn with an args ARRAY.
 * Paths are never interpolated into a shell string, so filenames containing
 * spaces/quotes/semicolons are inert.
 *
 * Binary discovery: FFMPEG_PATH / FFPROBE_PATH env vars win; otherwise we try
 * `ffmpeg` on PATH, then a short list of common install locations (homebrew,
 * /usr/local, global npm ffmpeg-static). Detection runs once per process.
 * ffprobe is optional — when absent, probe() parses `ffmpeg -i` stderr.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Omni Flash hard cap on input clip length (seconds). */
export const MAX_GEN_SECONDS = 10;
/** Trim target: just under the cap so re-encode rounding never tips us over. */
export const TRIM_TARGET_SECONDS = 9.9;

/**
 * Ingest resolution cap. Omni rejects oversized inputs: observed live
 * 2026-07-15, a 3840x2160 source's generation died server-side ("response
 * exceeds the maximum allowed size limit"), after which its interaction became
 * permanently unreadable and the run sealed as reconcile_required. 1080p
 * sources complete reliably, and generations output 720p regardless, so
 * anything larger is downscaled at ingest with aspect ratio preserved.
 */
export const MAX_INGEST_WIDTH = 1920;
export const MAX_INGEST_HEIGHT = 1080;

/** True when a probed source exceeds the provider-safe ingest resolution. */
export function needsIngestDownscale(width: number, height: number): boolean {
  return width > MAX_INGEST_WIDTH || height > MAX_INGEST_HEIGHT;
}

/**
 * Scale filter fitting a frame within the ingest cap: aspect preserved,
 * dimensions forced even for yuv420p, sources already within the cap pass
 * through unchanged (min() keeps their native size).
 */
const INGEST_DOWNSCALE_FILTER =
  `scale=w='min(iw,${MAX_INGEST_WIDTH})':h='min(ih,${MAX_INGEST_HEIGHT})'` +
  ":force_original_aspect_ratio=decrease:force_divisible_by=2";

/** Optional re-encode behavior shared by trimTo / reencodeToMp4. */
export interface ReencodeOpts {
  /** Downscale to the provider-safe ingest resolution during the encode. */
  downscale?: boolean;
}

function reencodeVfArgs(opts?: ReencodeOpts): string[] {
  return opts?.downscale ? ["-vf", INGEST_DOWNSCALE_FILTER] : [];
}

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn `bin` with an args array (no shell). Resolves with exit code + output. */
function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject); // e.g. ENOENT — binary not found
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** run() that rejects with a readable error when ffmpeg exits non-zero. */
async function runOrThrow(bin: string, args: string[]): Promise<RunResult> {
  const res = await run(bin, args);
  if (res.code !== 0) {
    const tail = res.stderr.split("\n").filter(Boolean).slice(-6).join("\n");
    throw new Error(
      `${path.basename(bin)} exited with code ${res.code} (args: ${args.join(" ")})\n${tail}`
    );
  }
  return res;
}

// ---------------------------------------------------------------------------
// Binary discovery (once per process)
// ---------------------------------------------------------------------------

interface Tools {
  ffmpeg: string;
  /** null when no ffprobe anywhere — probe() falls back to `ffmpeg -i`. */
  ffprobe: string | null;
}

/** Secret-safe capability summary used by the production-readiness route. */
export interface FfmpegReadiness {
  ready: boolean;
  ffprobeReady: boolean;
  status: "ready" | "unavailable";
}

/** Secret-safe result returned by the provider-free Workflow deployment probe. */
export interface SyntheticFfmpegSmokeResult {
  binarySource: "bundled" | "explicit_override" | "local_fallback";
  scratchWritable: true;
  encoded: true;
  audioDemuxed: true;
  remuxed: true;
  probed: true;
  width: 64;
  height: 64;
  hasAudio: true;
  durationMs: number;
  outputBytes: number;
}

let toolsPromise: Promise<Tools> | null = null;

async function candidateWorks(bin: string): Promise<boolean> {
  try {
    const res = await run(bin, ["-version"]);
    return res.code === 0;
  } catch {
    return false;
  }
}

/** Global npm installs of ffmpeg-static (one per nvm node version). */
async function ffmpegStaticCandidates(): Promise<string[]> {
  const out: string[] = [];
  const nvmVersions = path.join(os.homedir(), ".nvm", "versions", "node");
  try {
    for (const v of await fsp.readdir(nvmVersions)) {
      const p = path.join(nvmVersions, v, "lib", "node_modules", "ffmpeg-static", "ffmpeg");
      if (existsSync(p)) out.push(p);
    }
  } catch {
    // no nvm — fine
  }
  return out;
}

/**
 * The bundled ffmpeg-static dependency — the binary that ships inside the
 * Vercel serverless bundle (via next.config outputFileTracingIncludes).
 * Resolved lazily: the module just exports the absolute binary path.
 */
function bundledFfmpegStatic(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const p = require("ffmpeg-static") as string | null;
    return typeof p === "string" && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/**
 * Serverless bundles can strip the execute bit from traced binaries, and the
 * deployed filesystem is read-only — so if a candidate EXISTS but can't run,
 * copy it to /tmp and chmod it there. Returns the runnable path or null.
 */
async function makeRunnable(candidate: string): Promise<string | null> {
  if (!existsSync(candidate)) return null;
  if (await candidateWorks(candidate)) return candidate;
  try {
    const tmpCopy = path.join(os.tmpdir(), `ffmpeg-bundled-${path.basename(candidate)}`);
    if (!existsSync(tmpCopy)) {
      await fsp.copyFile(candidate, tmpCopy);
    }
    await fsp.chmod(tmpCopy, 0o755);
    if (await candidateWorks(tmpCopy)) return tmpCopy;
  } catch {
    // fall through
  }
  return null;
}

async function detectTools(): Promise<Tools> {
  const ffmpegCandidates = [
    process.env.FFMPEG_PATH,
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
    bundledFfmpegStatic(),
    ...(await ffmpegStaticCandidates()),
  ].filter((c): c is string => Boolean(c));

  let ffmpegBin: string | null = null;
  for (const c of ffmpegCandidates) {
    if (await candidateWorks(c)) {
      ffmpegBin = c;
      break;
    }
  }
  if (!ffmpegBin) {
    // Last resort for read-only serverless bundles: the traced ffmpeg-static
    // binary may exist without its execute bit — copy to /tmp and chmod.
    const bundled = bundledFfmpegStatic();
    if (bundled) ffmpegBin = await makeRunnable(bundled);
  }
  if (!ffmpegBin) {
    throw new Error(
      "ffmpeg not found. Install it (e.g. `brew install ffmpeg`) or set FFMPEG_PATH."
    );
  }

  // Prefer ffprobe when available (structured JSON output beats stderr parsing).
  const ffprobeCandidates = [
    process.env.FFPROBE_PATH,
    "ffprobe",
    path.join(path.dirname(ffmpegBin), "ffprobe"), // sibling of resolved ffmpeg
    "/opt/homebrew/bin/ffprobe",
    "/usr/local/bin/ffprobe",
    "/usr/bin/ffprobe",
  ].filter((c): c is string => Boolean(c));

  let ffprobeBin: string | null = null;
  for (const c of ffprobeCandidates) {
    if (await candidateWorks(c)) {
      ffprobeBin = c;
      break;
    }
  }

  return { ffmpeg: ffmpegBin, ffprobe: ffprobeBin };
}

function getTools(): Promise<Tools> {
  if (!toolsPromise) {
    toolsPromise = detectTools().catch((err) => {
      toolsPromise = null; // allow retry (e.g. after installing ffmpeg)
      throw err;
    });
  }
  return toolsPromise;
}

/**
 * Prefer the traced ffmpeg-static artifact for the deployment smoke so a
 * system binary cannot hide a missing bundle. Explicit paths keep container
 * deployments supported; PATH discovery is a local-development fallback only.
 */
async function getSyntheticSmokeFfmpeg(): Promise<{
  bin: string;
  source: SyntheticFfmpegSmokeResult["binarySource"];
}> {
  const bundled = bundledFfmpegStatic();
  if (bundled) {
    const runnable = await makeRunnable(bundled);
    if (runnable) return { bin: runnable, source: "bundled" };
  }

  const override = process.env.FFMPEG_PATH;
  if (override && (await candidateWorks(override))) {
    return { bin: override, source: "explicit_override" };
  }

  if (process.env.NODE_ENV !== "production") {
    return { bin: (await getTools()).ffmpeg, source: "local_fallback" };
  }
  throw new Error("bundled ffmpeg is unavailable");
}

/**
 * Exercise the real binary discovery path without reading media or calling a
 * network/provider API. Binary paths and discovery errors stay server-only.
 */
export async function getFfmpegReadiness(): Promise<FfmpegReadiness> {
  try {
    const tools = await getTools();
    return {
      ready: true,
      ffprobeReady: tools.ffprobe !== null,
      status: "ready",
    };
  } catch {
    return {
      ready: false,
      ffprobeReady: false,
      status: "unavailable",
    };
  }
}

/**
 * Exercise the media operations the hosted Workflow depends on without
 * reading user media or contacting a provider. The inputs are generated by
 * ffmpeg itself, kept deliberately tiny, and removed from writable scratch in
 * all outcomes. Errors expose only the bounded stage name; binary paths and
 * ffmpeg diagnostics remain server-only.
 */
export async function runSyntheticFfmpegSmoke(): Promise<SyntheticFfmpegSmokeResult> {
  type Stage =
    | "binary discovery"
    | "scratch setup"
    | "synthetic encode"
    | "audio demux"
    | "audio remux"
    | "output probe";

  const maxOutputBytes = 512 * 1024;
  let stage: Stage = "binary discovery";
  let scratchDir: string | null = null;

  try {
    const ffmpeg = await getSyntheticSmokeFfmpeg();
    stage = "scratch setup";
    scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flora-ffmpeg-smoke-"));
    const encodedPath = path.join(scratchDir, "encoded.mp4");
    const audioPath = path.join(scratchDir, "audio.m4a");
    const remuxedPath = path.join(scratchDir, "remuxed.mp4");

    stage = "synthetic encode";
    await runOrThrow(ffmpeg.bin, [
      "-v", "error",
      "-y",
      "-f", "lavfi",
      "-i", "color=c=black:s=64x64:r=8",
      "-f", "lavfi",
      "-i", "sine=frequency=1000:sample_rate=48000",
      "-t", "0.5",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "35",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "32k",
      "-shortest",
      "-movflags", "+faststart",
      encodedPath,
    ]);

    stage = "audio demux";
    await runOrThrow(ffmpeg.bin, [
      "-v", "error",
      "-y",
      "-i", encodedPath,
      "-vn",
      "-c:a", "copy",
      audioPath,
    ]);

    stage = "audio remux";
    await runOrThrow(ffmpeg.bin, [
      "-v", "error",
      "-y",
      "-i", encodedPath,
      "-i", audioPath,
      "-c:v", "copy",
      "-c:a", "copy",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-shortest",
      remuxedPath,
    ]);

    stage = "output probe";
    const [media, stat] = await Promise.all([
      probeViaFfmpegStderr(ffmpeg.bin, remuxedPath),
      fsp.stat(remuxedPath),
    ]);
    if (
      media.width !== 64 ||
      media.height !== 64 ||
      !media.hasAudio ||
      !Number.isFinite(media.durationSec) ||
      media.durationSec < 0.25 ||
      media.durationSec > 1.5 ||
      stat.size < 1 ||
      stat.size > maxOutputBytes
    ) {
      throw new Error("unexpected synthetic media result");
    }

    return {
      binarySource: ffmpeg.source,
      scratchWritable: true,
      encoded: true,
      audioDemuxed: true,
      remuxed: true,
      probed: true,
      width: 64,
      height: 64,
      hasAudio: true,
      durationMs: Math.round(media.durationSec * 1_000),
      outputBytes: stat.size,
    };
  } catch {
    throw new Error(`Provider-free ffmpeg smoke failed during ${stage}.`);
  } finally {
    if (scratchDir) {
      await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

function parseFrac(frac: string | undefined): number {
  if (!frac) return 0;
  const [num, den] = frac.split("/").map(Number);
  if (!Number.isFinite(num)) return 0;
  if (den === undefined) return num;
  if (!Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

async function probeViaFfprobe(ffprobe: string, filePath: string): Promise<ProbeResult> {
  const res = await runOrThrow(ffprobe, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(res.stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      duration?: string;
    }>;
  };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const durationSec =
    Number(data.format?.duration ?? video?.duration ?? 0) || 0;
  const fps = parseFrac(video?.avg_frame_rate) || parseFrac(video?.r_frame_rate);
  return {
    durationSec,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps,
    hasAudio,
  };
}

async function probeViaFfmpegStderr(ffmpeg: string, filePath: string): Promise<ProbeResult> {
  // `ffmpeg -i <file>` with no output exits non-zero by design; the metadata
  // we need is on stderr either way.
  const res = await run(ffmpeg, ["-hide_banner", "-i", filePath]);
  const err = res.stderr;

  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  if (!dur) {
    const tail = err.split("\n").filter(Boolean).slice(-4).join("\n");
    throw new Error(`Could not probe ${filePath} — no Duration in ffmpeg output.\n${tail}`);
  }
  const durationSec =
    Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);

  // e.g. "Stream #0:0[0x1](und): Video: h264 ..., 1920x1080 [SAR 1:1 ...], 30 fps, ..."
  const videoLine = err
    .split("\n")
    .find((l) => /Stream #\d+:\d+.*Video:/.test(l));
  let width = 0;
  let height = 0;
  let fps = 0;
  if (videoLine) {
    // Dimensions appear as ", WxH" after the pixel format — anchor on the
    // comma so hex stream tags like [0x1] can't match.
    const dims = /,\s*(\d{2,5})x(\d{2,5})[\s,[]/.exec(videoLine + " ");
    if (dims) {
      width = Number(dims[1]);
      height = Number(dims[2]);
    }
    const fpsMatch =
      /(\d+(?:\.\d+)?)\s*fps/.exec(videoLine) ??
      /(\d+(?:\.\d+)?)\s*tbr/.exec(videoLine);
    if (fpsMatch) fps = Number(fpsMatch[1]);
  }
  const hasAudio = /Stream #\d+:\d+.*Audio:/.test(err);
  return { durationSec, width, height, fps, hasAudio };
}

/** Duration, dimensions, fps, and audio presence of a media file. */
export async function probe(filePath: string): Promise<ProbeResult> {
  const tools = await getTools();
  if (tools.ffprobe) return probeViaFfprobe(tools.ffprobe, filePath);
  return probeViaFfmpegStderr(tools.ffmpeg, filePath);
}

/**
 * Extract one deterministic JPEG judge frame from a canonical local video.
 * Callers choose a unique temporary output path and remove it after reading.
 * A fixed codec/scale/quality keeps operation fingerprints stable on retries.
 */
export async function extractJpegFrame(
  videoPath: string,
  timestampSec: number,
  outPath: string,
  width = 640
): Promise<void> {
  if (!Number.isFinite(timestampSec) || timestampSec < 0) {
    throw new Error("Frame timestamp must be a finite non-negative number.");
  }
  if (!Number.isSafeInteger(width) || width < 64 || width > 1920) {
    throw new Error("Frame width must be an integer from 64 to 1920 pixels.");
  }
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y",
    "-i", videoPath,
    "-ss", timestampSec.toFixed(3),
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-q:v", "4",
    "-an",
    outPath,
  ]);
}

// ---------------------------------------------------------------------------
// relight luma measurement (deterministic, zero provider cost)
// ---------------------------------------------------------------------------

/** Center crop treated as the subject proxy in webcam framing. */
const LUMA_CENTER_WIDTH_FRACTION = 0.5;
const LUMA_CENTER_HEIGHT_FRACTION = 0.6;
const LUMA_CENTER_AREA_FRACTION =
  LUMA_CENTER_WIDTH_FRACTION * LUMA_CENTER_HEIGHT_FRACTION;
/** signalstats YAVG floor before log2 — black frames must not explode stops. */
const LUMA_FLOOR = 1;

interface RegionLumaSamples {
  full: number[];
  center: number[];
}

function parseYavgSamples(stdout: string): number[] {
  const samples: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    if (match) samples.push(Number(match[1]));
  }
  return samples;
}

function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error("Luma measurement produced no samples.");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function sampleRegionLuma(videoPath: string): Promise<RegionLumaSamples> {
  const tools = await getTools();
  const passes = await Promise.all([
    runOrThrow(tools.ffmpeg, [
      "-i", videoPath,
      "-vf", "fps=1,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
      "-f", "null", "-",
    ]),
    runOrThrow(tools.ffmpeg, [
      "-i", videoPath,
      "-vf",
      `fps=1,crop=iw*${LUMA_CENTER_WIDTH_FRACTION}:ih*${LUMA_CENTER_HEIGHT_FRACTION}:(iw-ow)/2:(ih-oh)/2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`,
      "-f", "null", "-",
    ]),
  ]);
  const full = parseYavgSamples(passes[0].stdout);
  const center = parseYavgSamples(passes[1].stdout);
  if (full.length === 0 || center.length === 0) {
    throw new Error("Luma measurement returned no signalstats samples.");
  }
  return { full, center };
}

function regionMedians(samples: RegionLumaSamples): {
  full: number;
  center: number;
  border: number;
} {
  const paired = Math.min(samples.full.length, samples.center.length);
  const borders: number[] = [];
  for (let i = 0; i < paired; i += 1) {
    // The border (background proxy) is the exact area-weighted complement of
    // the center crop, so it needs no third decode pass.
    borders.push(
      (samples.full[i] - LUMA_CENTER_AREA_FRACTION * samples.center[i]) /
        (1 - LUMA_CENTER_AREA_FRACTION)
    );
  }
  return {
    full: Math.max(LUMA_FLOOR, median(samples.full)),
    center: Math.max(LUMA_FLOOR, median(samples.center)),
    border: Math.max(LUMA_FLOOR, median(borders)),
  };
}

export interface RelightLumaMeasurementResult {
  globalStops: number;
  centerStops: number;
  borderStops: number;
  sampleCount: number;
}

/**
 * Measure a candidate relight against its source as region luma deltas in
 * stops. Deterministic by construction: fixed 1fps sampling, fixed center
 * crop, medians across samples — same two files always produce the same
 * numbers, so durable replays and prompt recompiles stay byte-stable. Zero
 * provider cost; callers treat failures as advisory (measurement is never
 * allowed to block a billed run).
 */
export async function measureRelightLuma(
  sourcePath: string,
  candidatePath: string
): Promise<RelightLumaMeasurementResult> {
  const [source, candidate] = await Promise.all([
    sampleRegionLuma(sourcePath),
    sampleRegionLuma(candidatePath),
  ]);
  const sourceMedians = regionMedians(source);
  const candidateMedians = regionMedians(candidate);
  const stops = (cand: number, src: number) => {
    const value = Math.log2(cand / src);
    return Number(value.toFixed(3));
  };
  return {
    globalStops: stops(candidateMedians.full, sourceMedians.full),
    centerStops: stops(candidateMedians.center, sourceMedians.center),
    borderStops: stops(candidateMedians.border, sourceMedians.border),
    sampleCount: Math.min(
      source.full.length,
      source.center.length,
      candidate.full.length,
      candidate.center.length
    ),
  };
}

// ---------------------------------------------------------------------------
// trim / demux / remux
// ---------------------------------------------------------------------------

/**
 * Trim `srcPath` to at most `maxSec` seconds, re-encoding video (h264) and
 * audio (aac). Re-encode is deliberate: stream-copy trims cut on keyframes and
 * can overshoot the cap — the Omni input limit is hard, so we need frame
 * accuracy. Returns the actual duration of the output (probed, post-encode).
 */
export async function trimTo(
  srcPath: string,
  outPath: string,
  maxSec: number,
  opts?: ReencodeOpts
): Promise<number> {
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y",
    "-ss", "0",
    "-i", srcPath,
    "-t", String(maxSec),
    ...reencodeVfArgs(opts),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ]);
  const probed = await probe(outPath);
  return probed.durationSec;
}

/** sha256 (hex) of a file's bytes, streamed. */
export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Extract the audio track to an .m4a (stream copy — bit-exact when the source
 * audio is AAC, which lets the sha256 double as an audio-preservation
 * fingerprint). Falls back to an AAC re-encode for non-AAC sources that can't
 * be stream-copied into an m4a container. Returns the sha256 of the output.
 */
export async function demuxAudio(
  srcPath: string,
  outPath: string
): Promise<{ sha256: string }> {
  const tools = await getTools();
  try {
    await runOrThrow(tools.ffmpeg, [
      "-y", "-i", srcPath, "-vn", "-c:a", "copy", outPath,
    ]);
  } catch {
    // Source audio codec not m4a-compatible (e.g. opus/pcm) — re-encode.
    await runOrThrow(tools.ffmpeg, [
      "-y", "-i", srcPath, "-vn", "-c:a", "aac", "-b:a", "192k", outPath,
    ]);
  }
  return { sha256: await sha256File(outPath) };
}

/** Convert the canonical source audio into the WAV input required by Lipsync-2-Pro. */
export async function transcodeAudioToWav(
  srcPath: string,
  outPath: string
): Promise<void> {
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y",
    "-i", srcPath,
    "-vn",
    "-c:a", "pcm_s16le",
    "-ar", "48000",
    "-ac", "1",
    outPath,
  ]);
}

/**
 * Remux: copy the video stream from `videoPath` and the audio stream from
 * `audioPath` into one file, no re-encode. `-shortest` trims to the shorter
 * input so a 9.9s generated video + 10s source audio ends cleanly.
 */
export async function remuxAudio(
  videoPath: string,
  audioPath: string,
  outPath: string
): Promise<void> {
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-c:v", "copy",
    "-c:a", "copy",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-shortest",
    outPath,
  ]);
}

/**
 * Conform a repaired video to the canonical source timeline. The final frame
 * is cloned only when the repaired output is short; `-t` trims when it is
 * long. Re-encoding is required because stream-copy cannot create frames.
 */
export async function conformVideoDuration(
  videoPath: string,
  outPath: string,
  durationSec: number
): Promise<void> {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("Video conform requires a positive finite duration.");
  }
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y",
    "-i", videoPath,
    "-vf", "tpad=stop_mode=clone:stop_duration=1",
    "-t", String(durationSec),
    "-map", "0:v:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-an",
    "-movflags", "+faststart",
    outPath,
  ]);
}

/** Attach the complete canonical audio stream without shortening either input. */
export async function remuxFullAudio(
  videoPath: string,
  audioPath: string,
  outPath: string
): Promise<void> {
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outPath,
  ]);
}

/**
 * Preserve a silent source by discarding any soundtrack invented by the video
 * model. The video stream is copied bit-for-bit; only audio streams are
 * omitted from the finalized artifact.
 */
export async function stripAudio(
  videoPath: string,
  outPath: string
): Promise<void> {
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y",
    "-i", videoPath,
    "-map", "0:v:0",
    "-c:v", "copy",
    "-an",
    outPath,
  ]);
}

/**
 * Preserve a silent source when provider/container padding extends the raw
 * video beyond the source timeline. Stream-copy trimming can overshoot on
 * packet boundaries, so this narrow path re-encodes for frame-accurate length
 * while discarding every audio stream.
 */
export async function trimAndStripAudio(
  videoPath: string,
  outPath: string,
  maxSec: number
): Promise<void> {
  if (!Number.isFinite(maxSec) || maxSec <= 0) {
    throw new Error("Silent-video trim requires a positive finite duration.");
  }
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y",
    "-ss", "0",
    "-i", videoPath,
    "-t", String(maxSec),
    "-map", "0:v:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-an",
    "-movflags", "+faststart",
    outPath,
  ]);
}

/**
 * MD5 of the raw audio bitstream (stream copy, no re-encode), optionally
 * limited to the first `maxSec` seconds of output. Because remuxAudio()
 * stream-copies packets, an output whose audio survived intact produces the
 * SAME digest as the demuxed source audio over the shared duration — this is
 * the live-mode audio-integrity verifier. `-t` is applied as an OUTPUT option
 * so both files cut at identical packet boundaries.
 */
export async function audioStreamMd5(
  filePath: string,
  maxSec?: number
): Promise<string> {
  const tools = await getTools();
  const args = [
    "-v", "error",
    "-i", filePath,
    ...(maxSec !== undefined ? ["-t", String(maxSec)] : []),
    "-map", "0:a:0",
    "-c", "copy",
    "-f", "md5",
    "-",
  ];
  const res = await runOrThrow(tools.ffmpeg, args);
  const m = /MD5=([0-9a-fA-F]+)/.exec(res.stdout + res.stderr);
  if (!m) {
    throw new Error(`audioStreamMd5: no MD5 in ffmpeg output for ${filePath}`);
  }
  return m[1].toLowerCase();
}

/**
 * Remux an arbitrary container into .mp4 without re-encoding (used at ingest
 * for .webm/.mkv uploads etc.). Throws if the streams can't live in mp4 —
 * caller decides whether to fall back to a re-encode.
 */
export async function remuxToMp4(srcPath: string, outPath: string): Promise<void> {
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y", "-i", srcPath, "-c", "copy", "-movflags", "+faststart", outPath,
  ]);
}

/** Full re-encode to h264/aac mp4, no trim (ingest fallback for odd codecs). */
export async function reencodeToMp4(
  srcPath: string,
  outPath: string,
  opts?: ReencodeOpts
): Promise<void> {
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y",
    "-i", srcPath,
    ...reencodeVfArgs(opts),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ]);
}

// ---------------------------------------------------------------------------
// side-by-side export
// ---------------------------------------------------------------------------

export interface SideBySideOpts {
  /** Height of each half (default 720). Width follows AR, rounded to even. */
  height?: number;
  /** Burned-in corner labels (default ORIGINAL / RELIT). */
  labels?: { left: string; right: string };
}

/**
 * Font candidates for the burned-in labels, in preference order.
 * The DejaVu path covers Debian-family containers (the Dockerfile installs
 * fonts-dejavu-core); the macOS paths cover local dev. No match → labels are
 * skipped, never a failure.
 */
const LABEL_FONT_CANDIDATES = [
  "/System/Library/Fonts/Helvetica.ttc",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

function findLabelFont(): string | null {
  for (const f of LABEL_FONT_CANDIDATES) {
    if (existsSync(f)) return f;
  }
  return null;
}

/**
 * Labels are burned into a filtergraph string; keep only characters that are
 * inert there (no `:` `'` `,` `;` `[` `]` `%` `\`) so a label can never break
 * or smuggle filter options.
 */
function sanitizeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9 ._-]/g, "").trim() || "VIDEO";
}

/**
 * Compose a side-by-side comparison video: `originalPath` on the left,
 * `relitPath` on the right, both scaled to the same height (default 720,
 * width follows aspect ratio with even rounding), hstacked, with the AUDIO
 * taken from `audioPath` (the untouched original track). h264/yuv420p +
 * faststart so the result streams in-browser; `-shortest` ends the cut with
 * the shorter stream.
 *
 * Labels ("ORIGINAL" / "RELIT") are burned into the bottom-left of each half
 * via drawtext when a known system font exists (fs.existsSync probe). No
 * font — or a drawtext failure — falls back to the identical command without
 * labels; labels never break the export.
 *
 * FPS NORMALIZATION (load-bearing): the two inputs routinely have different
 * frame rates (4K source at 30fps, Omni generation at 24fps). Feeding those
 * straight into hstack (a framesync filter) makes the merged stream inherit
 * a timebase-derived frame rate in the tens of thousands — the encoder then
 * duplicates frames until the disk fills. Both branches are forced through
 * `fps=` (the faster input's rate, probed, clamped, default 30) before
 * stacking.
 */
export async function sideBySide(
  originalPath: string,
  relitPath: string,
  audioPath: string,
  outPath: string,
  opts?: SideBySideOpts
): Promise<void> {
  const tools = await getTools();
  const height = opts?.height ?? 720;
  const leftLabel = sanitizeLabel(opts?.labels?.left ?? "ORIGINAL");
  const rightLabel = sanitizeLabel(opts?.labels?.right ?? "RELIT");

  // Probe both inputs and stack at the faster of the two rates so neither
  // side stutters. Probe failures fall back to 30fps rather than aborting.
  const [origInfo, relitInfo] = await Promise.all([
    probe(originalPath).catch(() => null),
    probe(relitPath).catch(() => null),
  ]);
  const probedFps = Math.max(origInfo?.fps ?? 0, relitInfo?.fps ?? 0);
  const fps =
    Number.isFinite(probedFps) && probedFps >= 1
      ? Math.min(Math.round(probedFps * 100) / 100, 60)
      : 30;

  const buildArgs = (fontFile: string | null): string[] => {
    const drawtext = (text: string): string =>
      fontFile
        ? `,drawtext=fontfile=${fontFile}:text=${text}:fontcolor=white:fontsize=28:box=1:boxcolor=black@0.4:boxborderw=10:x=24:y=h-th-24`
        : "";
    const graph =
      `[0:v]scale=-2:${height},fps=${fps},setsar=1${drawtext(leftLabel)}[left];` +
      `[1:v]scale=-2:${height},fps=${fps},setsar=1${drawtext(rightLabel)}[right];` +
      `[left][right]hstack=inputs=2:shortest=1[v]`;
    return [
      "-y",
      "-i", originalPath,
      "-i", relitPath,
      "-i", audioPath,
      "-filter_complex", graph,
      "-map", "[v]",
      "-map", "2:a:0",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      outPath,
    ];
  };

  const fontFile = findLabelFont();
  try {
    await runOrThrow(tools.ffmpeg, buildArgs(fontFile));
  } catch (err) {
    // Belt-and-braces: if the labeled graph failed for any drawtext-related
    // reason (font parse error, build without libfreetype), retry unlabeled.
    if (!fontFile) throw err;
    await runOrThrow(tools.ffmpeg, buildArgs(null));
  }
}
