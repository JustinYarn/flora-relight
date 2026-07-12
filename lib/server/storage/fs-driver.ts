/**
 * lib/server/storage/fs-driver.ts — the default storage driver: the local
 * <repo>/data filesystem, byte-for-byte the pre-seam behavior.
 *
 * This file deliberately contains NO new persistence logic: every operation
 * delegates to the existing lib/server/runstore.ts functions (atomic JSON
 * writes, traversal guards, index maintenance — all unchanged). The only
 * additions are the seam's local-path short-circuits:
 *
 *   - mediaWritePath  → the canonical destination path itself, so ffmpeg
 *     writes land directly where they always did;
 *   - putMediaFromFile → NO-OP when the local file already IS the canonical
 *     path (the normal case), plain copy otherwise;
 *   - getMediaToFile  → returns the canonical path, ignoring the suggested
 *     localPath (zero copying).
 */

import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  UPLOADS_ROOT,
  deleteRun,
  ensureDir,
  listRuns,
  readBatches,
  readRun,
  runDir,
  runMediaPath,
  runMediaUrl,
  writeBatches,
  writeRun,
} from "@/lib/server/runstore";
import type { MediaRange, MediaStat, StorageDriver } from "./types";

export function createFsDriver(): StorageDriver {
  return {
    name: "fs",

    // --- run / batch state: the existing runstore functions, unchanged -----
    getRun: readRun,
    putRun: writeRun,
    deleteRun,
    listRuns,
    getBatches: readBatches,
    putBatches: writeBatches,

    // --- media --------------------------------------------------------------

    async stagingDir(): Promise<string> {
      await ensureDir(UPLOADS_ROOT);
      return UPLOADS_ROOT;
    },

    async mediaWritePath(runId: string, fileName: string): Promise<string> {
      const dest = runMediaPath(runId, fileName); // validates id + name
      await ensureDir(runDir(runId));
      return dest;
    },

    async putMediaFromFile(
      runId: string,
      fileName: string,
      localPath: string
    ): Promise<void> {
      const dest = runMediaPath(runId, fileName);
      if (path.resolve(localPath) === dest) return; // already in place — no copy
      await ensureDir(runDir(runId));
      await fsp.copyFile(localPath, dest);
    },

    async getMediaToFile(runId: string, fileName: string, localPath: string): Promise<string> {
      void localPath; // part of the seam contract; the fs driver's canonical path wins
      const abs = runMediaPath(runId, fileName);
      await fsp.access(abs); // throw when missing — parity with remote download failure
      return abs;
    },

    async mediaExists(runId: string, fileName: string): Promise<boolean> {
      try {
        await fsp.access(runMediaPath(runId, fileName));
        return true;
      } catch {
        return false;
      }
    },

    async statMedia(runId: string, fileName: string): Promise<MediaStat | null> {
      try {
        const stat = await fsp.stat(runMediaPath(runId, fileName));
        if (!stat.isFile()) return null;
        return { size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    },

    async listMedia(runId: string): Promise<string[]> {
      try {
        return await fsp.readdir(runDir(runId));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },

    async deleteMediaDir(runId: string): Promise<void> {
      await fsp.rm(runDir(runId), { recursive: true, force: true });
    },

    async mediaReadStream(
      runId: string,
      fileName: string,
      range?: MediaRange
    ): Promise<ReadableStream> {
      const abs = runMediaPath(runId, fileName);
      const nodeStream = createReadStream(
        abs,
        range ? { start: range.start, end: range.end } : undefined
      );
      return Readable.toWeb(nodeStream) as unknown as ReadableStream;
    },

    async publicMediaUrl(runId: string, fileName: string): Promise<string> {
      return runMediaUrl(runId, fileName);
    },
  };
}
