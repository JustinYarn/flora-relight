/**
 * lib/server/storage/blob-driver.ts — cloud storage driver:
 * Vercel Blob (media) + Neon Postgres (run/batch JSON).
 *
 * Selected by lib/server/storage/index.ts when BLOB_READ_WRITE_TOKEN and
 * DATABASE_URL (or POSTGRES_URL) are both present. Uses
 * @neondatabase/serverless — NOT @vercel/postgres, which is deprecated since
 * the Vercel Postgres sunset (June 2025).
 *
 * SCHEMA (created lazily by ensureSchema()):
 *
 *   runs(
 *     id         text PRIMARY KEY,
 *     status     text,           -- scalar copies of the summary fields so
 *     created_at bigint,         -- listings/summaries are a cheap SELECT
 *     label      text,
 *     data       jsonb,          -- the full Run JSON verbatim (NULL for a
 *                                -- media-only stub row: ingest uploads media
 *                                -- BEFORE the client pushes the first Run)
 *     media      jsonb NOT NULL DEFAULT '{}'   -- fileName → BlobMediaEntry
 *   )
 *   batches(id int PRIMARY KEY DEFAULT 1, data jsonb NOT NULL)  -- one row
 *
 * The media map lives in its OWN jsonb column (not inside `data`) because
 * putRun() writes the client's full Run JSON verbatim — if the map lived in
 * `data` every run upsert would clobber it. Blob URLs are NOT derivable from
 * (runId, fileName): uploads use addRandomSuffix, so the returned URL is the
 * only handle and must be persisted.
 *
 * MEDIA: blobs are uploaded with put() to a PUBLIC store under keys
 * runs/<runId>/<fileName> (plus the random suffix). publicMediaUrl() returns
 * the stored blob URL directly — public blob URLs support HTTP Range
 * natively, so <video> elements can point at them without a proxy; the
 * /api/media route 302-redirects to them when this driver is active
 * (mediaReadStream is intentionally NOT implemented).
 *
 * ffmpeg needs real local paths, so getMediaToFile() downloads into the
 * deterministic scratch path and mediaWritePath() hands out a scratch path
 * that putMediaFromFile() later uploads. See types.ts for the round-trip
 * contract.
 */

import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { del, put } from "@vercel/blob";
import { neon } from "@neondatabase/serverless";
import type { Batch, Run } from "@/lib/types";
import { assertMediaFileName, assertRunId } from "@/lib/server/runstore";
import { scratchMediaPath, scratchUploadsDir } from "./scratch";
import type { MediaStat, StorageDriver } from "./types";

/** One persisted media file: the blob URL plus what statMedia() reports. */
interface BlobMediaEntry {
  url: string;
  size: number;
  uploadedAt: number; // ms epoch — doubles as mtimeMs
}

type MediaMap = Record<string, BlobMediaEntry>;

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
};

function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

export function createBlobDriver(databaseUrl: string): StorageDriver {
  const sql = neon(databaseUrl);

  // Lazy one-shot schema bootstrap; a failure clears the memo so the next
  // request retries instead of poisoning the process forever.
  let schemaReady: Promise<void> | null = null;
  function ensureSchema(): Promise<void> {
    if (!schemaReady) {
      schemaReady = (async () => {
        await sql`
          CREATE TABLE IF NOT EXISTS runs (
            id         text PRIMARY KEY,
            status     text,
            created_at bigint,
            label      text,
            data       jsonb,
            media      jsonb NOT NULL DEFAULT '{}'::jsonb
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS batches (
            id   int PRIMARY KEY DEFAULT 1,
            data jsonb NOT NULL
          )
        `;
      })().catch((err) => {
        schemaReady = null;
        throw err;
      });
    }
    return schemaReady;
  }

  async function readMediaMap(runId: string): Promise<MediaMap> {
    await ensureSchema();
    const rows = (await sql`
      SELECT media FROM runs WHERE id = ${assertRunId(runId)}
    `) as Array<{ media: MediaMap | null }>;
    return rows[0]?.media ?? {};
  }

  /** Best-effort blob deletion — a stale blob is preferable to a failed API call. */
  async function deleteBlobs(urls: string[]): Promise<void> {
    if (urls.length === 0) return;
    try {
      await del(urls);
    } catch (err) {
      console.warn("[storage/blob] blob deletion failed (continuing):", err);
    }
  }

  return {
    name: "blob",

    // -----------------------------------------------------------------------
    // Run / batch JSON state
    // -----------------------------------------------------------------------

    async getRun(runId: string): Promise<Run | null> {
      await ensureSchema();
      const rows = (await sql`
        SELECT data FROM runs WHERE id = ${assertRunId(runId)}
      `) as Array<{ data: Run | null }>;
      return rows[0]?.data ?? null; // media-only stub rows read as "no run"
    },

    async putRun(run: Run): Promise<void> {
      await ensureSchema();
      assertRunId(run.id);
      const label = run.originalVideo?.label ?? run.id;
      // `media` is deliberately untouched: run upserts must never clobber the
      // fileName→URL map (media rows can even pre-date the first putRun).
      await sql`
        INSERT INTO runs (id, status, created_at, label, data)
        VALUES (${run.id}, ${run.status}, ${run.createdAt}, ${label},
                ${JSON.stringify(run)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          status     = EXCLUDED.status,
          created_at = EXCLUDED.created_at,
          label      = EXCLUDED.label,
          data       = EXCLUDED.data
      `;
    },

    async deleteRun(runId: string): Promise<boolean> {
      await ensureSchema();
      assertRunId(runId);
      const rows = (await sql`
        DELETE FROM runs WHERE id = ${runId} RETURNING media
      `) as Array<{ media: MediaMap | null }>;
      if (rows.length === 0) return false;
      await deleteBlobs(Object.values(rows[0].media ?? {}).map((e) => e.url));
      return true;
    },

    async listRuns(): Promise<Run[]> {
      await ensureSchema();
      const rows = (await sql`
        SELECT data FROM runs
        WHERE data IS NOT NULL
        ORDER BY created_at DESC NULLS LAST
      `) as Array<{ data: Run }>;
      return rows.map((r) => r.data);
    },

    async getBatches(): Promise<Batch[]> {
      await ensureSchema();
      const rows = (await sql`
        SELECT data FROM batches WHERE id = 1
      `) as Array<{ data: Batch[] }>;
      return rows[0]?.data ?? [];
    },

    async putBatches(batches: Batch[]): Promise<void> {
      await ensureSchema();
      await sql`
        INSERT INTO batches (id, data) VALUES (1, ${JSON.stringify(batches)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
      `;
    },

    // -----------------------------------------------------------------------
    // Media
    // -----------------------------------------------------------------------

    async stagingDir(): Promise<string> {
      const dir = scratchUploadsDir();
      await fsp.mkdir(dir, { recursive: true });
      return dir;
    },

    async mediaWritePath(runId: string, fileName: string): Promise<string> {
      const p = scratchMediaPath(runId, fileName); // validates id + name
      await fsp.mkdir(path.dirname(p), { recursive: true });
      return p;
    },

    async putMediaFromFile(
      runId: string,
      fileName: string,
      localPath: string
    ): Promise<void> {
      assertRunId(runId);
      assertMediaFileName(fileName);
      const stat = await fsp.stat(localPath);

      // addRandomSuffix keeps URLs unguessable on the public store and makes
      // re-puts collision-free; the URL is persisted below because it is not
      // derivable from the key.
      const blob = await put(`runs/${runId}/${fileName}`, createReadStream(localPath), {
        access: "public",
        addRandomSuffix: true,
        contentType: contentTypeFor(fileName),
        // VERIFY(vercel): default edge/browser cache is one month; run media
        // is write-once per fileName so the default is fine — revisit only if
        // a same-name overwrite flow ever appears.
      });

      const entry: BlobMediaEntry = {
        url: blob.url,
        size: stat.size,
        uploadedAt: Date.now(),
      };

      // Media can arrive before the first putRun (ingest) — upsert a stub row
      // whose `data` stays NULL until the client pushes the Run JSON.
      const previous = (await sql`
        INSERT INTO runs (id, media)
        VALUES (${runId}, jsonb_build_object(${fileName}::text, ${JSON.stringify(entry)}::jsonb))
        ON CONFLICT (id) DO UPDATE SET
          media = runs.media || jsonb_build_object(${fileName}::text, ${JSON.stringify(entry)}::jsonb)
        RETURNING (SELECT media FROM runs WHERE id = ${runId}) AS media
      `) as Array<{ media: MediaMap | null }>;

      // Same-name re-put (shouldn't happen — media is write-once per name):
      // release the now-orphaned previous blob.
      const old = previous[0]?.media?.[fileName];
      if (old && old.url !== entry.url) await deleteBlobs([old.url]);
    },

    async getMediaToFile(
      runId: string,
      fileName: string,
      localPath: string
    ): Promise<string> {
      // Run media is write-once per name — an existing scratch copy is valid.
      try {
        await fsp.access(localPath);
        return localPath;
      } catch {
        // fall through to download
      }

      const map = await readMediaMap(runId);
      const entry = map[assertMediaFileName(fileName)];
      if (!entry) {
        throw new Error(`Media not found: runs/${runId}/${fileName}`);
      }

      const res = await fetch(entry.url);
      if (!res.ok || !res.body) {
        throw new Error(`Blob download failed (${res.status}) for runs/${runId}/${fileName}`);
      }
      await fsp.mkdir(path.dirname(localPath), { recursive: true });
      // Download to a temp name + rename so concurrent readers never see a
      // half-written scratch file.
      const tmp = `${localPath}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await pipeline(
          Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream),
          createWriteStream(tmp)
        );
        await fsp.rename(tmp, localPath);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return localPath;
    },

    async mediaExists(runId: string, fileName: string): Promise<boolean> {
      const map = await readMediaMap(runId);
      return Boolean(map[assertMediaFileName(fileName)]);
    },

    async statMedia(runId: string, fileName: string): Promise<MediaStat | null> {
      const map = await readMediaMap(runId);
      const entry = map[assertMediaFileName(fileName)];
      return entry ? { size: entry.size, mtimeMs: entry.uploadedAt } : null;
    },

    async listMedia(runId: string): Promise<string[]> {
      return Object.keys(await readMediaMap(runId));
    },

    async deleteMediaDir(runId: string): Promise<void> {
      await ensureSchema();
      assertRunId(runId);
      // The scalar subquery in RETURNING evaluates against the statement-start
      // snapshot, i.e. the PRE-update map — exactly the blobs to release.
      const rows = (await sql`
        UPDATE runs SET media = '{}'::jsonb
        WHERE id = ${runId}
        RETURNING (SELECT media FROM runs WHERE id = ${runId}) AS media
      `) as Array<{ media: MediaMap | null }>;
      await deleteBlobs(Object.values(rows[0]?.media ?? {}).map((e) => e.url));
    },

    // mediaReadStream intentionally omitted: public blob URLs are directly
    // fetchable (with native Range support), so /api/media 302-redirects to
    // publicMediaUrl() instead of proxying bytes through the function.

    async resolveMediaUrl(
      url: string
    ): Promise<{ runId: string; fileName: string } | null> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      // VERIFY(vercel): blob URL pathnames mirror the upload key with the
      // random suffix injected before the extension, e.g.
      // /runs/<runId>/source-<suffix>.mp4 — we only trust the runId segment
      // here and confirm the full URL against the persisted media map.
      const segs = parsed.pathname.split("/").filter(Boolean);
      const idx = segs.indexOf("runs");
      if (idx === -1 || segs.length < idx + 3) return null;
      const runId = segs[idx + 1];
      let map: MediaMap;
      try {
        map = await readMediaMap(runId); // throws on malformed run ids
      } catch {
        return null;
      }
      const clean = `${parsed.origin}${parsed.pathname}`;
      for (const [fileName, entry] of Object.entries(map)) {
        if (entry.url === url || entry.url === clean) return { runId, fileName };
      }
      return null;
    },

    async publicMediaUrl(runId: string, fileName: string): Promise<string> {
      const map = await readMediaMap(runId);
      const entry = map[assertMediaFileName(fileName)];
      if (!entry) {
        throw new Error(`Media not found: runs/${runId}/${fileName}`);
      }
      return entry.url;
    },
  };
}
