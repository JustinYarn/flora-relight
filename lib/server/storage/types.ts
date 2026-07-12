/**
 * lib/server/storage/types.ts — the storage driver seam.
 *
 * Everything the server routes need for run/batch persistence and run media
 * lives behind this interface so the backing store can be swapped by env:
 *
 *   - fs driver (default, lib/server/storage/fs-driver.ts): the existing
 *     <repo>/data filesystem layout, byte-for-byte the pre-seam behavior.
 *   - blob driver (lib/server/storage/blob-driver.ts): Vercel Blob for media
 *     + Postgres for run/batch JSON, selected when BLOB_READ_WRITE_TOKEN and
 *     POSTGRES_URL are both present.
 *
 * DESIGN RULE — ffmpeg needs real local paths. Media ops are therefore
 * expressed as local-file round-trips:
 *
 *   READ:  getMediaToFile(runId, fileName, localPath) → local path to read.
 *          Remote drivers download into `localPath` and return it; the fs
 *          driver IGNORES `localPath` and returns its canonical on-disk path
 *          (zero copying).
 *
 *   WRITE: p = await mediaWritePath(runId, fileName)  → local path to write;
 *          ...ffmpeg (or fs write) produces the file at p...
 *          await putMediaFromFile(runId, fileName, p) → persist.
 *          The fs driver's mediaWritePath returns the canonical destination
 *          path, so its putMediaFromFile is a NO-OP for that path (zero
 *          copying). Remote drivers hand out a scratch path and upload it.
 *
 * Callers pick `localPath` for reads via scratchMediaPath() (see scratch.ts)
 * — deterministic per (runId, fileName) so remote round-trips and the Gemini
 * Files-API upload cache (keyed by absolute path) stay coherent within a
 * server process.
 */

import type { Batch, Run } from "@/lib/types";

/** Size + mtime of a stored media file (mtime = upload time on remote drivers). */
export interface MediaStat {
  size: number;
  mtimeMs: number;
}

/** Inclusive byte range for partial media reads. */
export interface MediaRange {
  start: number;
  end: number;
}

export interface StorageDriver {
  /** Driver id, for the one-line startup log. */
  readonly name: "fs" | "blob";

  // -------------------------------------------------------------------------
  // Run / batch JSON state
  // -------------------------------------------------------------------------

  /** Full run JSON, or null when the run doesn't exist. */
  getRun(runId: string): Promise<Run | null>;

  /** Upsert one run's JSON (and any driver-side index bookkeeping). */
  putRun(run: Run): Promise<void>;

  /**
   * Permanently delete a run: its JSON/state AND its whole media folder.
   * Returns whether anything existed. Irreversible by design.
   */
  deleteRun(runId: string): Promise<boolean>;

  /** All persisted runs, newest first. */
  listRuns(): Promise<Run[]>;

  /** The whole batch list (empty array when none persisted yet). */
  getBatches(): Promise<Batch[]>;

  /** Whole-array batch write (low volume; order is preserved verbatim). */
  putBatches(batches: Batch[]): Promise<void>;

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  /**
   * A local directory for transient ingest staging (cleaned per request by
   * the caller). fs driver → <data>/uploads; remote drivers → os tmp.
   */
  stagingDir(): Promise<string>;

  /**
   * Local path a caller should WRITE the media file to (parent dir ensured).
   * MUST be followed by putMediaFromFile(runId, fileName, <returned path>)
   * once the file is complete. fs → canonical destination (put is a no-op);
   * remote → scratch path (put uploads it).
   */
  mediaWritePath(runId: string, fileName: string): Promise<string>;

  /**
   * Persist a completed local file as run media. Does NOT delete `localPath`
   * (callers own scratch cleanup). fs driver short-circuits to a no-op when
   * `localPath` already is the canonical destination.
   */
  putMediaFromFile(runId: string, fileName: string, localPath: string): Promise<void>;

  /**
   * Make run media available as a real local file and return its path.
   * Throws when the media doesn't exist. fs → canonical path (localPath
   * ignored, zero copying); remote → downloads to `localPath`.
   */
  getMediaToFile(runId: string, fileName: string, localPath: string): Promise<string>;

  /** Does this media file exist in the store? */
  mediaExists(runId: string, fileName: string): Promise<boolean>;

  /** Size + mtime, or null when missing (or not a regular file). */
  statMedia(runId: string, fileName: string): Promise<MediaStat | null>;

  /** File names stored for this run (empty when the run has no media). */
  listMedia(runId: string): Promise<string[]>;

  /** Delete ALL media for a run (no-op when none). */
  deleteMediaDir(runId: string): Promise<void>;

  /**
   * Web ReadableStream of a media file for the serving route, optionally a
   * byte range (inclusive). Callers stat first (statMedia) to build headers
   * and validate the range against the size.
   *
   * OPTIONAL: drivers whose media has a directly fetchable public URL (blob)
   * omit this — the serving route redirects to publicMediaUrl() instead of
   * streaming through the function.
   */
  mediaReadStream?(
    runId: string,
    fileName: string,
    range?: MediaRange
  ): Promise<ReadableStream>;

  /**
   * Public URL under which this media file is served.
   *   fs   → "/api/media/runs/<runId>/<fileName>" (same-origin route, exactly
   *          as before the seam; the access gate middleware always applies).
   *   blob → the blob's own public CDN URL (unguessable random suffix; native
   *          Range support for <video>). Non-derivable, hence async — looked
   *          up from the run row's persisted media map.
   */
  publicMediaUrl(runId: string, fileName: string): Promise<string>;

  /**
   * OPTIONAL: reverse-map an ABSOLUTE media URL this driver issued back to
   * (runId, fileName), or null when it isn't one of ours. Needed because
   * clients echo publicMediaUrl() values back as `sourceUrl` — for the blob
   * driver those are CDN URLs, not app-relative paths. Drivers whose public
   * URLs are same-origin "/api/media/..." (fs) omit this.
   */
  resolveMediaUrl?(url: string): Promise<{ runId: string; fileName: string } | null>;
}
