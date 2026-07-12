/**
 * lib/server/storage/index.ts — getStorage(): the one place drivers are
 * chosen. Every server route goes through this; nothing outside lib/server/
 * storage/ imports a driver file directly.
 *
 * Selection (once per process):
 *   BLOB_READ_WRITE_TOKEN + (DATABASE_URL || POSTGRES_URL)  → blob driver
 *   otherwise                                               → fs driver
 *
 * Local dev with no env vars therefore behaves byte-for-byte as before the
 * seam existed.
 */

import { createBlobDriver } from "./blob-driver";
import { createFsDriver } from "./fs-driver";
import type { StorageDriver } from "./types";

export type { MediaRange, MediaStat, StorageDriver } from "./types";
export { scratchMediaPath, scratchUploadsDir } from "./scratch";

let driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (!driver) {
    const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
    driver =
      process.env.BLOB_READ_WRITE_TOKEN && databaseUrl
        ? createBlobDriver(databaseUrl)
        : createFsDriver();
    console.log(
      `[storage] driver: ${driver.name}` +
        (driver.name === "fs" ? " (local <repo>/data)" : " (Vercel Blob + Neon Postgres)")
    );
  }
  return driver;
}
