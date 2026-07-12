/**
 * lib/server/storage/scratch.ts — deterministic local scratch paths for
 * remote-driver media round-trips (ffmpeg needs real files).
 *
 * Paths are deterministic per (runId, fileName) so that within one server
 * process a file is downloaded at most once and the Gemini Files-API upload
 * cache (keyed by absolute path) keeps hitting. Run media files are
 * write-once per name, so reusing an existing scratch copy is safe.
 *
 * The fs driver never touches these — it short-circuits to its canonical
 * data/ paths.
 */

import os from "node:os";
import path from "node:path";
import { assertMediaFileName, assertRunId } from "@/lib/server/runstore";

export const SCRATCH_ROOT = path.join(os.tmpdir(), "flora-relight");

/** Local scratch destination for a remote media round-trip (pure path math). */
export function scratchMediaPath(runId: string, fileName: string): string {
  return path.join(SCRATCH_ROOT, "media", assertRunId(runId), assertMediaFileName(fileName));
}

/** Local scratch staging dir for uploads on remote drivers. */
export function scratchUploadsDir(): string {
  return path.join(SCRATCH_ROOT, "uploads");
}
