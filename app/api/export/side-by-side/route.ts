/**
 * POST /api/export/side-by-side — build a downloadable comparison video.
 *
 * Body: { runId, version } where version is an attempt number or "final"
 * ("final" picks the highest relit-v*.mp4 present in the run dir — version
 * numbers are whatever the files say, salvaged oddities included).
 *
 * Composes source.mp4 (left) + relit-v<version>.mp4 (right) at 720p halves
 * with the untouched original audio track, writes
 * data/runs/<runId>/side-by-side-v<version>.mp4, and returns its media URL.
 * Regeneration is skipped when the output already exists and is newer than
 * both inputs. Local ffmpeg only — no API spend.
 */

import { NextRequest, NextResponse } from "next/server";
import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { sideBySide } from "@/lib/server/ffmpeg";
import {
  isValidRunId,
  relitVideoPath,
  runDir,
  runMediaPath,
  runMediaUrl,
  sourceAudioPath,
  sourcePath,
} from "@/lib/server/runstore";

export const runtime = "nodejs";
export const maxDuration = 120;

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

interface ExportBody {
  runId?: unknown;
  version?: unknown;
}

/** Attempt number (positive integer, number or numeric string) or "final". */
function parseVersion(v: unknown): number | "final" | null {
  if (v === "final") return "final";
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d+$/.test(v)
        ? Number(v)
        : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

async function statOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/** Highest N across relit-v<N>.mp4 files in the run dir, or null when none. */
async function highestRelitVersion(runId: string): Promise<number | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(runDir(runId));
  } catch {
    return null;
  }
  let best: number | null = null;
  for (const entry of entries) {
    const m = /^relit-v(\d+)\.mp4$/.exec(entry);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && (best === null || n > best)) best = n;
  }
  return best;
}

/**
 * One build per output path at a time: concurrent clicks await the same
 * ffmpeg run instead of racing two writers onto one file.
 */
const inFlight = new Map<string, Promise<void>>();

function buildOnce(outPath: string, build: () => Promise<void>): Promise<void> {
  const existing = inFlight.get(outPath);
  if (existing) return existing;
  const job = build().finally(() => inFlight.delete(outPath));
  inFlight.set(outPath, job);
  return job;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: ExportBody;
  try {
    body = (await req.json()) as ExportBody;
  } catch {
    return jsonError(400, "Expected a JSON body.");
  }

  const { runId } = body;
  if (!isValidRunId(runId)) return jsonError(400, "Invalid runId.");

  const requested = parseVersion(body.version);
  if (requested === null) {
    return jsonError(400, 'version must be an attempt number or "final".');
  }

  // "final" → the highest relit-v*.mp4 actually on disk.
  let version: number;
  if (requested === "final") {
    const highest = await highestRelitVersion(runId);
    if (highest === null) {
      return jsonError(
        404,
        "This run has no generated video files to export — simulated (mock) runs and runs still on their first attempt don't have one yet."
      );
    }
    version = highest;
  } else {
    version = requested;
  }

  const relit = relitVideoPath(runId, version);
  const source = sourcePath(runId);
  const [relitStat, sourceStat] = await Promise.all([
    statOrNull(relit),
    statOrNull(source),
  ]);
  if (!relitStat) {
    return jsonError(
      404,
      `Attempt ${version} has no generated video file — simulated (mock) runs and in-flight attempts can't be exported.`
    );
  }
  if (!sourceStat) {
    return jsonError(404, "This run has no source video file on disk.");
  }

  // Original audio track; fall back to the source video's own track if the
  // demuxed m4a is somehow missing.
  const audioCandidate = sourceAudioPath(runId);
  const audio = (await statOrNull(audioCandidate)) ? audioCandidate : source;

  const outName = `side-by-side-v${version}.mp4`;
  const outPath = runMediaPath(runId, outName);

  const outStat = await statOrNull(outPath);
  const cached =
    outStat !== null &&
    outStat.mtimeMs > relitStat.mtimeMs &&
    outStat.mtimeMs > sourceStat.mtimeMs;

  if (!cached) {
    try {
      await buildOnce(outPath, async () => {
        // Compose to a temp name, then rename — the media route never sees a
        // half-written file and a crash never leaves a torn output behind.
        const tmpPath = runMediaPath(
          runId,
          `side-by-side-v${version}.${randomBytes(4).toString("hex")}.tmp.mp4`
        );
        try {
          await sideBySide(source, relit, audio, tmpPath);
          await fsp.rename(tmpPath, outPath);
        } catch (err) {
          await fsp.unlink(tmpPath).catch(() => undefined);
          throw err;
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(500, `Couldn't build the comparison video: ${message}`);
    }
  }

  return NextResponse.json({
    url: runMediaUrl(runId, outName),
    cached,
    version,
  });
}
