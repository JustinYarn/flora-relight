/**
 * Filesystem persistence for runs, batches, and their media artifacts.
 *
 * SERVER ONLY. Everything lives under <repo>/data (gitignored, safe to
 * delete to reset):
 *
 *   data/
 *     uploads/                    transient ingest staging (cleaned per request)
 *     batches.json                Batch[] — whole-array writes, low volume
 *     index.json                  light run summaries (id/status/createdAt/label)
 *     runs/<runId>/
 *       run.json                  full Run JSON (client store is the in-session
 *                                 source of truth; it syncs here after mutations)
 *       source.mp4                ingested (and possibly trimmed) upload
 *       source-audio.m4a          demuxed original audio
 *       gen-vN.mp4                iteration N generated video
 *       relit-vN.mp4              iteration N relit/remuxed video
 *       anchor-vN.png             iteration N look-anchor still
 *
 * All JSON writes are atomic (tmp file + rename) so a crash mid-write never
 * leaves a torn file. All path construction goes through the traversal guard.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Batch, Run } from "@/lib/types";

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

/**
 * <repo>/data — resolved robustly against both launch styles:
 * `next dev` run from inside flora-relight (cwd = repo) and
 * `node .../next dev flora-relight` run from the workspace root
 * (cwd = parent). FLORA_DATA_DIR env overrides for deployments.
 */
function resolveDataRoot(): string {
  if (process.env.FLORA_DATA_DIR) return path.resolve(process.env.FLORA_DATA_DIR);
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "flora-relight", "package.json"))) {
    return path.join(cwd, "flora-relight", "data");
  }
  return path.resolve(cwd, "data");
}
export const DATA_ROOT = resolveDataRoot();
export const RUNS_ROOT = path.join(DATA_ROOT, "runs");
export const UPLOADS_ROOT = path.join(DATA_ROOT, "uploads");
const BATCHES_PATH = path.join(DATA_ROOT, "batches.json");
const INDEX_PATH = path.join(DATA_ROOT, "index.json");

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const RUN_ID_RE = /^[a-z0-9_-]{1,64}$/;
/** Filenames we store/serve: single path component, conservative charset. */
const FILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidRunId(id: unknown): id is string {
  return typeof id === "string" && RUN_ID_RE.test(id);
}

/** Throws unless `id` is a sane run id ([a-z0-9_-], 1-64 chars). */
export function assertRunId(id: unknown): string {
  if (!isValidRunId(id)) {
    throw new Error(`Invalid run id: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * Join path segments under `root`, rejecting anything that could escape it:
 * absolute segments, "..", empty/dot segments, null bytes, separators inside
 * a segment. Belt-and-braces: after joining, the resolved path must still be
 * inside `root`.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  for (const seg of segments) {
    if (
      typeof seg !== "string" ||
      seg.length === 0 ||
      seg === "." ||
      seg === ".." ||
      seg.includes("\0") ||
      seg.includes("/") ||
      seg.includes("\\") ||
      path.isAbsolute(seg)
    ) {
      throw new Error(`Unsafe path segment: ${JSON.stringify(seg)}`);
    }
  }
  const joined = path.resolve(resolvedRoot, ...segments);
  if (joined !== resolvedRoot && !joined.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes data root: ${segments.join("/")}`);
  }
  return joined;
}

/** New server-generated run id (lowercase, matches RUN_ID_RE). */
export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// FS helpers
// ---------------------------------------------------------------------------

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

/** Atomic JSON write: serialize → tmp file in the same dir → rename. */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, filePath);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Media path helpers
// ---------------------------------------------------------------------------

export function runDir(runId: string): string {
  return safeJoin(RUNS_ROOT, assertRunId(runId));
}

export function runJsonPath(runId: string): string {
  return safeJoin(runDir(runId), "run.json");
}

/** Absolute path for a media file inside a run dir (filename validated). */
export function runMediaPath(runId: string, fileName: string): string {
  if (!FILE_NAME_RE.test(fileName)) {
    throw new Error(`Invalid media file name: ${JSON.stringify(fileName)}`);
  }
  return safeJoin(runDir(runId), fileName);
}

/** Public URL under which /api/media serves a run media file. */
export function runMediaUrl(runId: string, fileName: string): string {
  runMediaPath(runId, fileName); // validation only
  return `/api/media/runs/${runId}/${fileName}`;
}

export const sourcePath = (runId: string) => runMediaPath(runId, "source.mp4");
export const sourceAudioPath = (runId: string) => runMediaPath(runId, "source-audio.m4a");
export const genVideoPath = (runId: string, v: number) =>
  runMediaPath(runId, `gen-v${Math.trunc(v)}.mp4`);
export const relitVideoPath = (runId: string, v: number) =>
  runMediaPath(runId, `relit-v${Math.trunc(v)}.mp4`);
export const anchorPath = (runId: string, v: number) =>
  runMediaPath(runId, `anchor-v${Math.trunc(v)}.png`);

/**
 * Resolve a /api/media/<...segments> request to an absolute file path under
 * DATA_ROOT, or throw if any segment is unsafe.
 */
export function resolveMediaRequest(segments: string[]): string {
  return safeJoin(DATA_ROOT, ...segments);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunSummary {
  id: string;
  status: Run["status"];
  createdAt: number;
  label: string;
}

function summarize(run: Run): RunSummary {
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    label: run.originalVideo?.label ?? run.id,
  };
}

export async function readRun(runId: string): Promise<Run | null> {
  return readJson<Run>(runJsonPath(runId));
}

/**
 * Permanently delete one run: its whole media folder (source, generated
 * videos, anchors, exports) and its index entry. Irreversible by design —
 * callers own the confirmation UX.
 */
export async function deleteRun(runId: string): Promise<boolean> {
  assertRunId(runId);
  const dir = runDir(runId);
  let existed = false;
  try {
    await fsp.access(dir);
    existed = true;
  } catch {
    existed = false;
  }
  if (existed) await fsp.rm(dir, { recursive: true, force: true });
  const index = (await readJson<RunSummary[]>(INDEX_PATH)) ?? [];
  await writeJsonAtomic(
    INDEX_PATH,
    index.filter((s) => s.id !== runId)
  );
  return existed;
}

/** Upsert one run's JSON and refresh its entry in data/index.json. */
export async function writeRun(run: Run): Promise<void> {
  assertRunId(run.id);
  await ensureDir(runDir(run.id));
  await writeJsonAtomic(runJsonPath(run.id), run);
  const index = (await readJson<RunSummary[]>(INDEX_PATH)) ?? [];
  const next = index.filter((s) => s.id !== run.id);
  next.push(summarize(run));
  next.sort((a, b) => b.createdAt - a.createdAt);
  await writeJsonAtomic(INDEX_PATH, next);
}

/** All persisted runs, newest first. Skips torn/foreign directories. */
export async function listRuns(): Promise<Run[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(RUNS_ROOT);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const runs: Run[] = [];
  for (const entry of entries) {
    if (!isValidRunId(entry)) continue;
    const run = await readJson<Run>(runJsonPath(entry));
    if (run && run.id === entry) runs.push(run);
  }
  runs.sort((a, b) => b.createdAt - a.createdAt);
  return runs;
}

/** Light summaries from data/index.json (no per-run file reads). */
export async function listRunSummaries(): Promise<RunSummary[]> {
  return (await readJson<RunSummary[]>(INDEX_PATH)) ?? [];
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export async function readBatches(): Promise<Batch[]> {
  return (await readJson<Batch[]>(BATCHES_PATH)) ?? [];
}

export async function writeBatches(batches: Batch[]): Promise<void> {
  await writeJsonAtomic(BATCHES_PATH, batches);
}
