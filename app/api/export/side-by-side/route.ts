/**
 * POST /api/export/side-by-side — build a downloadable comparison video.
 *
 * Body: { runId, version } where version is an attempt number or "final"
 * ("final" picks the highest relit-v*.mp4 present in the run's media —
 * version numbers are whatever the files say, salvaged oddities included).
 *
 * Composes source.mp4 (left) + relit-v<version>.mp4 (right) at 720p halves
 * with the untouched original audio track, persists
 * side-by-side-v<version>.mp4 via the storage driver, and returns its media
 * URL. Regeneration is skipped when the output already exists and is newer
 * than both inputs. Local ffmpeg only — no API spend. ffmpeg needs real
 * paths, so remote drivers round-trip through the scratch dir
 * (getMediaToFile / putMediaFromFile); the fs driver short-circuits to its
 * canonical data/ paths.
 */

import { NextRequest, NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sideBySide } from "@/lib/server/ffmpeg";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage, scratchMediaPath } from "@/lib/server/storage";

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

/** Highest N across relit-v<N>.mp4 files in the run's media, or null. */
async function highestRelitVersion(runId: string): Promise<number | null> {
  const names = await getStorage().listMedia(runId);
  let best: number | null = null;
  for (const entry of names) {
    const m = /^relit-v(\d+)\.mp4$/.exec(entry);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && (best === null || n > best)) best = n;
  }
  return best;
}

/**
 * One build per output at a time: concurrent clicks await the same ffmpeg
 * run instead of racing two writers onto one file.
 *
 * NOTE(vercel-deploy): this in-process Map only dedupes within ONE server
 * instance. On a multi-instance deploy (serverless scale-out) two instances
 * can still build the same export concurrently — wasteful but safe, since
 * each builds to its own temp file and the final persist is atomic
 * (rename on fs / last-write-wins re-put on blob).
 */
const inFlight = new Map<string, Promise<void>>();

function buildOnce(key: string, build: () => Promise<void>): Promise<void> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const job = build().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
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

  const storage = getStorage();

  // "final" → the highest relit-v*.mp4 actually persisted.
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

  const relitName = `relit-v${version}.mp4`;
  const [relitStat, sourceStat] = await Promise.all([
    storage.statMedia(runId, relitName),
    storage.statMedia(runId, "source.mp4"),
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

  const outName = `side-by-side-v${version}.mp4`;

  const outStat = await storage.statMedia(runId, outName);
  const cached =
    outStat !== null &&
    outStat.mtimeMs > relitStat.mtimeMs &&
    outStat.mtimeMs > sourceStat.mtimeMs;

  if (!cached) {
    try {
      await buildOnce(`${runId}/${outName}`, async () => {
        // Materialize the inputs locally (fs driver: canonical paths, zero
        // copying; blob driver: scratch downloads).
        const source = await storage.getMediaToFile(
          runId,
          "source.mp4",
          scratchMediaPath(runId, "source.mp4")
        );
        const relit = await storage.getMediaToFile(
          runId,
          relitName,
          scratchMediaPath(runId, relitName)
        );
        // Original audio track; fall back to the source video's own track if
        // the demuxed m4a is somehow missing.
        const audio = (await storage.mediaExists(runId, "source-audio.m4a"))
          ? await storage.getMediaToFile(
              runId,
              "source-audio.m4a",
              scratchMediaPath(runId, "source-audio.m4a")
            )
          : source;

        // Compose to a temp name beside the destination, then rename — the
        // media route never sees a half-written file and a crash never
        // leaves a torn output behind.
        const outLocal = await storage.mediaWritePath(runId, outName);
        const tmpLocal = path.join(
          path.dirname(outLocal),
          `side-by-side-v${version}.${randomBytes(4).toString("hex")}.tmp.mp4`
        );
        try {
          await sideBySide(source, relit, audio, tmpLocal);
          await fsp.rename(tmpLocal, outLocal);
        } catch (err) {
          await fsp.unlink(tmpLocal).catch(() => undefined);
          throw err;
        }
        await storage.putMediaFromFile(runId, outName, outLocal);
      });
    } catch (err) {
      console.error("[export/side-by-side] comparison build failed:", {
        runId,
        version,
        error: err,
      });
      return jsonError(
        500,
        "The comparison video could not be built. Try again or check the server logs."
      );
    } finally {
      // Remote media is materialized under one deterministic per-run /tmp
      // directory. A warm export worker must not retain every source, relit,
      // audio, and rendered comparison it has touched. Local fs paths are the
      // canonical durable store and must never be removed here.
      if (storage.name === "blob") {
        const scratchRunDir = path.dirname(
          scratchMediaPath(runId, "source.mp4")
        );
        await fsp.rm(scratchRunDir, { recursive: true, force: true }).catch(
          (error) => {
            console.warn(
              `[export/side-by-side] scratch cleanup failed for ${runId}:`,
              error instanceof Error ? error.message : error
            );
          }
        );
      }
    }
  }

  return NextResponse.json({
    url: await storage.publicMediaUrl(runId, outName),
    cached,
    version,
  });
}
