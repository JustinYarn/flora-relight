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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require("ffmpeg-static") as string | null;
    return typeof p === "string" && p.length > 0 ? p : null;
  } catch {
    return null;
  }
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
  maxSec: number
): Promise<number> {
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y",
    "-ss", "0",
    "-i", srcPath,
    "-t", String(maxSec),
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
export async function reencodeToMp4(srcPath: string, outPath: string): Promise<void> {
  const tools = await getTools();
  await runOrThrow(tools.ffmpeg, [
    "-y",
    "-i", srcPath,
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
