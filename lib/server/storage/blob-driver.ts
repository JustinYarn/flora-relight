/**
 * lib/server/storage/blob-driver.ts — cloud storage driver:
 * Vercel Blob (media) + Neon Postgres (run/batch JSON).
 *
 * Selected by lib/server/storage/index.ts when BLOB_READ_WRITE_TOKEN,
 * DATABASE_URL (or POSTGRES_URL), and FLORA_BLOB_ACCESS=private are present. Uses
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
 *     deleted_at bigint,         -- permanent tombstone; row id is never reused
 *     data       jsonb,          -- the full Run JSON verbatim (NULL for a
 *                                -- media-only stub row: ingest uploads media
 *                                -- BEFORE the client pushes the first Run)
 *     media      jsonb NOT NULL DEFAULT '{}'   -- fileName → BlobMediaEntry
 *   )
 *   batches(id int PRIMARY KEY DEFAULT 1, data jsonb NOT NULL)  -- legacy row
 *   batch_records(
 *     id text PRIMARY KEY, revision bigint, created_at bigint,
 *     updated_at bigint, data jsonb
 *   ) -- independently revisioned, monotonic batch checkpoints
 *   grade_drafts(
 *     id text PRIMARY KEY, revision bigint, updated_at bigint, data jsonb
 *   ) -- revisioned blind-grading working memory
 *   ingest_finalizations(
 *     run_id text PRIMARY KEY, upload_fingerprint text, lease_token text,
 *     lease_expires_at bigint, updated_at bigint
 *   ) -- short lease serializing duplicate cloud finalize requests
 *   ingest_uploads(
 *     run_id text PRIMARY KEY, pathname text UNIQUE, created_at bigint,
 *     data jsonb
 *   ) -- pre-token ownership + signed upload-completion receipt
 *   blob_cleanup_handles(
 *     url text PRIMARY KEY, run_id text, created_at bigint, data jsonb
 *   ) -- server-only displaced-media handles retained until deletion succeeds
 *   storage_health_checks(id text PRIMARY KEY, created_at bigint, payload text)
 *     -- transient rows used by active readiness write/read/delete probes
 *   video_finalizations(
 *     run_id text, iteration int, lease_token text, lease_expires_at bigint
 *   ) -- cross-instance lease around deterministic generated media writes
 *   run_executions(
 *     run_id text PRIMARY KEY, execution_id text, revision bigint,
 *     status text, phase text, updated_at bigint, data jsonb
 *   ) -- server-only, revision-CAS durable coordinator state
 *   batch_executions(
 *     batch_id text PRIMARY KEY, execution_id text, revision bigint,
 *     status text, updated_at bigint, data jsonb
 *   ) -- server-only, revision-CAS dispatcher and budget state
 *
 * The media map lives in its OWN jsonb column (not inside `data`) because
 * browser run snapshots replace most of the Run JSON (server-owned provider,
 * grade, and approval fields are preserved atomically). If the map lived in
 * `data`, a normal run upsert could clobber it. Blob URLs are NOT derivable from
 * (runId, fileName): uploads use addRandomSuffix, so the returned URL is the
 * only handle and must be persisted.
 *
 * MEDIA: new blobs are uploaded to a PRIVATE store under keys
 * runs/<runId>/<fileName> (plus the random suffix). Browser references stay
 * same-origin under /api/media; that route authenticates and streams bytes
 * with Range through get(). Older media-map entries did not record access,
 * so reads infer it from their persisted .public/.private Blob hostname.
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
import { del, get, put, type BlobAccessType } from "@vercel/blob";
import { neon } from "@neondatabase/serverless";
import type {
  Batch,
  BatchExecution,
  GradeDraft,
  PaidOperation,
  Run,
  RunExecution,
} from "@/lib/types";
import { assertMediaFileName, assertRunId } from "@/lib/server/runstore";
import {
  assertBatchExecution,
  assertBatchExecutionTransition,
  assertNewBatchExecution,
} from "./batch-execution";
import { mergeBatch } from "./batch-merge";
import {
  assertNewRunExecution,
  assertRunExecution,
  assertRunExecutionTransition,
} from "./run-execution";
import { scratchMediaPath, scratchUploadsDir } from "./scratch";
import type {
  DurableStorageVerification,
  IngestUploadReservation,
  MediaStat,
  PaidOperationCostEntry,
  RunPageCursor,
  StorageDriver,
} from "./types";

/** One persisted media file: the blob URL plus what statMedia() reports. */
interface BlobMediaEntry {
  url: string;
  size: number;
  uploadedAt: number; // ms epoch — doubles as mtimeMs
  /** Absent on legacy rows; infer from the persisted Blob hostname. */
  access?: BlobAccessType;
}

type MediaMap = Record<string, BlobMediaEntry>;
type BlobCleanupHandleRow = { url: string; data: BlobMediaEntry };
type RunExecutionRow = { revision: number | string; data: RunExecution };
type BatchExecutionRow = { revision: number | string; data: BatchExecution };

/**
 * The current private-store credential cannot remove an object from the legacy
 * public store. Keep its database handle intact so an operator with the old
 * store credential can migrate/delete it deliberately.
 */
export class LegacyPublicMediaDeletionError extends Error {
  constructor() {
    super("Legacy public media requires operator cleanup before this run can be deleted.");
    this.name = "LegacyPublicMediaDeletionError";
  }
}

/** A deletion request is incomplete until every current-store Blob is gone. */
export class BlobDeletionIncompleteError extends Error {
  constructor() {
    super("Run media deletion did not complete.");
    this.name = "BlobDeletionIncompleteError";
  }
}

const PAID_OPERATION_ID_RE = /^[a-z0-9:_-]{1,160}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function assertPaidOperationId(id: unknown): string {
  if (typeof id !== "string" || !PAID_OPERATION_ID_RE.test(id)) {
    throw new Error("Invalid paid operation id");
  }
  return id;
}

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

function providerUrlWithoutQuery(value: string): string {
  const query = value.indexOf("?");
  const hash = value.indexOf("#");
  const cut = [query, hash].filter((index) => index >= 0);
  return cut.length > 0 ? value.slice(0, Math.min(...cut)) : value;
}

/**
 * Replace only exact URLs already present in this run's server-only media map.
 * This safely covers old Run/operation shapes without guessing field names or
 * rewriting arbitrary provider/user strings.
 */
function canonicalizeKnownMediaUrls<T>(
  value: T,
  runId: string,
  media: MediaMap
): T {
  const lookup = new Map<string, string>();
  for (const [fileName, entry] of Object.entries(media)) {
    const canonical = `/api/media/runs/${runId}/${fileName}`;
    lookup.set(entry.url, canonical);
    lookup.set(providerUrlWithoutQuery(entry.url), canonical);
  }

  const visit = (item: unknown): unknown => {
    if (typeof item === "string") {
      return lookup.get(item) ?? lookup.get(providerUrlWithoutQuery(item)) ?? item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).map(([key, child]) => [
        key,
        visit(child),
      ])
    );
  };

  return visit(value) as T;
}

function inferBlobAccess(entry: BlobMediaEntry): BlobAccessType {
  if (entry.access === "private" || entry.access === "public") return entry.access;
  let hostname: string;
  try {
    hostname = new URL(entry.url).hostname;
  } catch {
    throw new Error("Stored Blob media URL is invalid");
  }
  if (hostname.endsWith(".private.blob.vercel-storage.com")) return "private";
  if (hostname.endsWith(".public.blob.vercel-storage.com")) return "public";
  throw new Error("Stored media URL is not a recognized Vercel Blob URL");
}

function assertIngestUploadReservation(
  value: IngestUploadReservation
): IngestUploadReservation {
  const runId = assertRunId(value.runId);
  if (
    value.schema !== "flora.ingest-upload.v1" ||
    value.access !== "private" ||
    typeof value.fileName !== "string" ||
    value.fileName.length < 1 ||
    value.fileName.length > 255 ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt <= 0
  ) {
    throw new Error("Invalid ingest upload reservation");
  }
  const expectedPrefix = `uploads/${runId}/`;
  if (
    typeof value.pathname !== "string" ||
    !value.pathname.startsWith(expectedPrefix) ||
    value.pathname.slice(expectedPrefix.length).includes("/") ||
    value.pathname.includes("..")
  ) {
    throw new Error("Invalid ingest upload pathname");
  }
  if (
    value.completed &&
    (value.completed.pathname !== value.pathname ||
      typeof value.completed.contentType !== "string" ||
      value.completed.contentType.length < 1 ||
      value.completed.contentType.length > 255 ||
      typeof value.completed.etag !== "string" ||
      value.completed.etag.length < 1 ||
      value.completed.etag.length > 255 ||
      !Number.isSafeInteger(value.completed.completedAt) ||
      value.completed.completedAt <= 0)
  ) {
    throw new Error("Invalid ingest upload completion");
  }
  return value;
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
            deleted_at bigint,
            data       jsonb,
            media      jsonb NOT NULL DEFAULT '{}'::jsonb
          )
        `;
        await sql`
          ALTER TABLE runs ADD COLUMN IF NOT EXISTS deleted_at bigint
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS batches (
            id   int PRIMARY KEY DEFAULT 1,
            data jsonb NOT NULL
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS batch_records (
            id         text PRIMARY KEY,
            revision   bigint NOT NULL,
            created_at bigint NOT NULL,
            updated_at bigint NOT NULL,
            data       jsonb NOT NULL
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS batch_records_newest_idx
          ON batch_records (created_at DESC, id DESC)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS grade_drafts (
            id         text PRIMARY KEY,
            revision   bigint NOT NULL,
            updated_at bigint NOT NULL,
            data       jsonb NOT NULL
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS ingest_finalizations (
            run_id            text PRIMARY KEY,
            upload_fingerprint text NOT NULL,
            lease_token       text NOT NULL,
            lease_expires_at  bigint NOT NULL,
            updated_at        bigint NOT NULL
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS ingest_uploads (
            run_id     text PRIMARY KEY,
            pathname   text NOT NULL UNIQUE,
            created_at bigint NOT NULL,
            data       jsonb NOT NULL
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS blob_cleanup_handles (
            url        text PRIMARY KEY,
            run_id     text NOT NULL,
            created_at bigint NOT NULL,
            data       jsonb NOT NULL
          )
        `;
        await sql`
          CREATE INDEX IF NOT EXISTS blob_cleanup_handles_run_idx
          ON blob_cleanup_handles (run_id, created_at)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS storage_health_checks (
            id         text PRIMARY KEY,
            created_at bigint NOT NULL,
            payload    text NOT NULL
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS video_finalizations (
            run_id           text NOT NULL,
            iteration        integer NOT NULL,
            lease_token      text NOT NULL,
            lease_expires_at bigint NOT NULL,
            updated_at       bigint NOT NULL,
            PRIMARY KEY (run_id, iteration)
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS paid_operations (
            run_id       text NOT NULL,
            operation_id text NOT NULL,
            input_hash   text NOT NULL,
            status       text NOT NULL,
            data         jsonb NOT NULL,
            PRIMARY KEY (run_id, operation_id)
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS run_executions (
            run_id       text PRIMARY KEY,
            execution_id text NOT NULL,
            revision     bigint NOT NULL,
            status       text NOT NULL,
            phase        text NOT NULL,
            updated_at   bigint NOT NULL,
            data         jsonb NOT NULL
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS batch_executions (
            batch_id     text PRIMARY KEY,
            execution_id text NOT NULL,
            revision     bigint NOT NULL,
            status       text NOT NULL,
            updated_at   bigint NOT NULL,
            data         jsonb NOT NULL
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
      SELECT media FROM runs
      WHERE id = ${assertRunId(runId)}
        AND deleted_at IS NULL
    `) as Array<{ media: MediaMap | null }>;
    return rows[0]?.media ?? {};
  }

  async function projectRunMedia(run: Run): Promise<Run> {
    return canonicalizeKnownMediaUrls(run, run.id, await readMediaMap(run.id));
  }

  async function projectPaidOperationMedia(
    operation: PaidOperation
  ): Promise<PaidOperation> {
    return canonicalizeKnownMediaUrls(
      operation,
      operation.runId,
      await readMediaMap(operation.runId)
    );
  }

  async function projectBatchMedia(batch: Batch): Promise<Batch> {
    if (!batch.uploads?.some((upload) => upload.video)) return batch;
    return {
      ...batch,
      uploads: batch.uploads.map((upload) =>
        upload.video
          ? {
              ...upload,
              // Batch uploads are always the canonical ingested source. Never
              // replay a persisted provider URL when its Run was tombstoned or
              // its old media map is unavailable; the same-origin route will
              // correctly return 404 while the batch history stays intact.
              video: {
                ...upload.video,
                url: `/api/media/runs/${upload.runId}/source.mp4`,
              },
            }
          : upload
      ),
    };
  }

  /** Best-effort orphan cleanup for compensating writes, never user deletion. */
  async function deleteBlobsBestEffort(urls: string[]): Promise<void> {
    const unique = [...new Set(urls)];
    if (unique.length === 0) return;
    try {
      await del(unique);
    } catch (err) {
      console.warn(
        "[storage/blob] orphan cleanup failed (continuing):",
        err instanceof Error ? err.name : "unknown_error"
      );
    }
  }

  /**
   * User-visible deletion is fail-closed: metadata handles stay durable until
   * the provider confirms that every private Blob (including raw upload) is
   * deleted. The caller can safely retry a partially completed tombstone.
   */
  async function deleteBlobsStrict(handles: string[]): Promise<void> {
    const unique = [...new Set(handles)];
    if (unique.length === 0) return;
    try {
      await del(unique);
    } catch (err) {
      console.error(
        "[storage/blob] durable blob deletion failed:",
        err instanceof Error ? err.name : "unknown_error"
      );
      throw new BlobDeletionIncompleteError();
    }
  }

  async function readRetainedMediaHandles(
    runId: string
  ): Promise<BlobCleanupHandleRow[]> {
    await ensureSchema();
    return (await sql`
      SELECT url, data
      FROM blob_cleanup_handles
      WHERE run_id = ${assertRunId(runId)}
      ORDER BY created_at ASC, url ASC
    `) as BlobCleanupHandleRow[];
  }

  /**
   * Retry current-private-store cleanup after a successful canonical write.
   * Legacy public-store handles deliberately stay in the server-only ledger:
   * the current token cannot delete them, and no read projection exposes them.
   */
  async function retryRetainedMediaCleanup(runId: string): Promise<void> {
    let rows: BlobCleanupHandleRow[];
    try {
      rows = await readRetainedMediaHandles(runId);
    } catch (err) {
      console.warn(
        "[storage/blob] retained media cleanup could not be read; canonical write remains committed:",
        err instanceof Error ? err.name : "unknown_error"
      );
      return;
    }
    for (const row of rows) {
      let access: BlobAccessType;
      try {
        if (row.data.url !== row.url) throw new Error("Retained media URL mismatch");
        access = inferBlobAccess(row.data);
      } catch {
        console.warn("[storage/blob] retained media handle is invalid; preserving it");
        continue;
      }
      if (access !== "private") continue;
      try {
        await del(row.url);
        await sql`
          DELETE FROM blob_cleanup_handles
          WHERE run_id = ${runId} AND url = ${row.url}
        `;
      } catch (err) {
        console.warn(
          "[storage/blob] retained media cleanup failed; preserving its handle:",
          err instanceof Error ? err.name : "unknown_error"
        );
      }
    }
  }

  function executionFromRow(row: RunExecutionRow): RunExecution {
    const execution = assertRunExecution(row.data);
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || execution.revision !== revision) {
      throw new Error("Stored run execution revision is inconsistent");
    }
    return execution;
  }

  function batchExecutionFromRow(row: BatchExecutionRow): BatchExecution {
    const execution = assertBatchExecution(row.data);
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || execution.revision !== revision) {
      throw new Error("Stored batch execution revision is inconsistent");
    }
    return execution;
  }

  type BatchRecordRow = { revision: number | string; data: Batch };
  type BatchCasResult = { applied: boolean; batch: Batch | null };
  const MAX_BATCH_CAS_ATTEMPTS = 20;

  /**
   * Revision-checked read/merge/write. Neon HTTP requests do not share a
   * transaction, so a failed revision predicate is retried from the winner's
   * new value until this checkpoint has been monotonically incorporated.
   */
  async function casBatchRecord(
    incoming: Batch,
    expectedStatus?: Batch["status"]
  ): Promise<BatchCasResult> {
    await ensureSchema();
    for (let attempt = 0; attempt < MAX_BATCH_CAS_ATTEMPTS; attempt += 1) {
      const rows = (await sql`
        SELECT revision, data FROM batch_records WHERE id = ${incoming.id}
      `) as BatchRecordRow[];
      const current = rows[0];

      if (!current) {
        if (expectedStatus !== undefined) {
          return { applied: false, batch: null };
        }
        const saved = mergeBatch(null, incoming);
        const inserted = (await sql`
          INSERT INTO batch_records (
            id, revision, created_at, updated_at, data
          ) VALUES (
            ${saved.id}, 1, ${saved.createdAt},
            ${saved.updatedAt ?? saved.createdAt},
            ${JSON.stringify(saved)}::jsonb
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING data
        `) as Array<{ data: Batch }>;
        if (inserted[0]) return { applied: true, batch: inserted[0].data };
        continue;
      }

      if (
        expectedStatus !== undefined &&
        current.data.status !== expectedStatus
      ) {
        return { applied: false, batch: current.data };
      }

      const saved = mergeBatch(current.data, incoming);
      if (
        expectedStatus !== undefined &&
        saved.status === current.data.status
      ) {
        throw new Error("A batch transition must advance its durable status");
      }
      const updated = (await sql`
        UPDATE batch_records
        SET revision = revision + 1,
            created_at = ${saved.createdAt},
            updated_at = ${saved.updatedAt ?? saved.createdAt},
            data = ${JSON.stringify(saved)}::jsonb
        WHERE id = ${saved.id} AND revision = ${current.revision}
        RETURNING data
      `) as Array<{ data: Batch }>;
      if (updated[0]) return { applied: true, batch: updated[0].data };
    }
    throw new Error(
      `Batch ${incoming.id} changed too often to save safely; retry the request.`
    );
  }

  async function putBatchRecord(batch: Batch): Promise<Batch> {
    const result = await casBatchRecord(batch);
    if (!result.batch) throw new Error(`Batch ${batch.id} could not be saved`);
    return result.batch;
  }

  // One-time, idempotent compatibility import for deployments that still
  // have the former whole-array row. Monotonic CAS makes concurrent imports
  // from several cold serverless instances safe.
  let legacyBatchMigration: Promise<void> | null = null;
  function migrateLegacyBatches(): Promise<void> {
    if (!legacyBatchMigration) {
      legacyBatchMigration = (async () => {
        await ensureSchema();
        const rows = (await sql`
          SELECT data FROM batches WHERE id = 1
        `) as Array<{ data: Batch[] }>;
        for (const batch of rows[0]?.data ?? []) {
          await putBatchRecord(batch);
        }
      })().catch((error) => {
        legacyBatchMigration = null;
        throw error;
      });
    }
    return legacyBatchMigration;
  }

  return {
    name: "blob",

    async verifyDurableStorage(): Promise<DurableStorageVerification> {
      const checkedAt = Date.now();
      const nonce = randomBytes(16).toString("hex");
      const payload = `flora-storage-check:${nonce}`;

      const databaseCheck = (async (): Promise<boolean> => {
        let roundTripOk = false;
        let cleanupOk = true;
        try {
          await ensureSchema();
          await sql`
            INSERT INTO storage_health_checks (id, created_at, payload)
            VALUES (${nonce}, ${checkedAt}, ${payload})
          `;
          const rows = (await sql`
            SELECT payload FROM storage_health_checks WHERE id = ${nonce}
          `) as Array<{ payload: string }>;
          roundTripOk = rows[0]?.payload === payload;
        } catch {
          roundTripOk = false;
        } finally {
          // Cleanup is part of the probe contract and runs even when the read
          // is missing or mismatched. The public projection remains secret- and
          // error-free.
          try {
            const deleted = (await sql`
              DELETE FROM storage_health_checks WHERE id = ${nonce}
              RETURNING id
            `) as Array<{ id: string }>;
            cleanupOk = deleted.length === 0 || deleted[0]?.id === nonce;
          } catch {
            cleanupOk = false;
          }
        }
        return roundTripOk && cleanupOk;
      })();

      const blobCheck = (async (): Promise<boolean> => {
        const pathname = `.flora-readiness/${nonce}.txt`;
        let blobUrl: string | null = null;
        let roundTripOk = false;
        try {
          const written = await put(pathname, payload, {
            access: "private",
            addRandomSuffix: false,
            allowOverwrite: false,
            contentType: "text/plain; charset=utf-8",
            cacheControlMaxAge: 60,
          });
          blobUrl = written.url;
          const read = await get(pathname, { access: "private", useCache: false });
          if (!read || read.statusCode !== 200) return false;
          roundTripOk = (await new Response(read.stream).text()) === payload;
        } catch {
          return false;
        } finally {
          if (blobUrl) {
            try {
              await del(blobUrl);
            } catch {
              roundTripOk = false;
            }
          }
        }
        return roundTripOk;
      })();

      const [databaseOk, blobOk] = await Promise.all([databaseCheck, blobCheck]);
      return {
        ok: databaseOk && blobOk,
        checkedAt,
        blob: { ok: blobOk },
        database: { ok: databaseOk },
      };
    },

    // -----------------------------------------------------------------------
    // Run / batch JSON state
    // -----------------------------------------------------------------------

    async getRun(runId: string): Promise<Run | null> {
      await ensureSchema();
      const rows = (await sql`
        SELECT data, media FROM runs
        WHERE id = ${assertRunId(runId)}
          AND deleted_at IS NULL
      `) as Array<{ data: Run | null; media: MediaMap | null }>;
      const row = rows[0];
      return row?.data
        ? canonicalizeKnownMediaUrls(row.data, row.data.id, row.media ?? {})
        : null; // media-only stub rows read as "no run"
    },

    async putRun(run: Run): Promise<void> {
      await ensureSchema();
      assertRunId(run.id);
      const label = run.originalVideo?.label ?? run.id;
      // `media` is deliberately untouched: run upserts must never clobber the
      // fileName→URL map (media rows can even pre-date the first putRun).
      const rows = (await sql`
        INSERT INTO runs (id, status, created_at, label, deleted_at, data)
        SELECT ${run.id}, ${run.status}, ${run.createdAt}, ${label},
               NULL, ${JSON.stringify(run)}::jsonb
        ON CONFLICT (id) DO UPDATE SET
          status     = EXCLUDED.status,
          created_at = EXCLUDED.created_at,
          label      = EXCLUDED.label,
          data       =
            (EXCLUDED.data - 'originalVideo' - 'providerOperations' - 'humanGrade' - 'spendApproval')
            || CASE
                 WHEN runs.data ? 'originalVideo'
                   THEN jsonb_build_object(
                     'originalVideo', runs.data->'originalVideo'
                   )
                 WHEN EXCLUDED.data ? 'originalVideo'
                   THEN jsonb_build_object(
                     'originalVideo', EXCLUDED.data->'originalVideo'
                   )
                 ELSE '{}'::jsonb
               END
            || CASE
                 WHEN runs.data ? 'providerOperations'
                   THEN jsonb_build_object(
                     'providerOperations', runs.data->'providerOperations'
                   )
                 WHEN EXCLUDED.data ? 'providerOperations'
                   THEN jsonb_build_object(
                     'providerOperations', EXCLUDED.data->'providerOperations'
                   )
                 ELSE '{}'::jsonb
               END
            || CASE
                 WHEN runs.data ? 'humanGrade'
                   THEN jsonb_build_object('humanGrade', runs.data->'humanGrade')
                 WHEN EXCLUDED.data ? 'humanGrade'
                   THEN jsonb_build_object('humanGrade', EXCLUDED.data->'humanGrade')
                 ELSE '{}'::jsonb
               END
            || CASE
                 WHEN runs.data ? 'spendApproval'
                   THEN jsonb_build_object(
                     'spendApproval', runs.data->'spendApproval'
                   )
                 WHEN EXCLUDED.data ? 'spendApproval'
                   THEN jsonb_build_object(
                     'spendApproval', EXCLUDED.data->'spendApproval'
                   )
                 ELSE '{}'::jsonb
               END
        WHERE runs.deleted_at IS NULL
        RETURNING id
      `) as Array<{ id: string }>;
      if (!rows[0]) throw new Error(`Run ${run.id} was permanently deleted`);
    },

    async getRunExecution(runId) {
      await ensureSchema();
      const id = assertRunId(runId);
      const rows = (await sql`
        SELECT execution.revision, execution.data
        FROM run_executions AS execution
        INNER JOIN runs AS run ON run.id = execution.run_id
        WHERE execution.run_id = ${id}
          AND run.data IS NOT NULL
          AND run.deleted_at IS NULL
      `) as RunExecutionRow[];
      return rows[0] ? executionFromRow(rows[0]) : null;
    },

    async createRunExecution(execution) {
      await ensureSchema();
      const candidate = assertNewRunExecution(execution);
      const rows = (await sql`
        INSERT INTO run_executions (
          run_id, execution_id, revision, status, phase, updated_at, data
        )
        SELECT ${candidate.runId}, ${candidate.executionId},
               ${candidate.revision}, ${candidate.status}, ${candidate.phase},
               ${candidate.updatedAt}, ${JSON.stringify(candidate)}::jsonb
        FROM runs
        WHERE id = ${candidate.runId}
          AND data IS NOT NULL
          AND deleted_at IS NULL
        ON CONFLICT (run_id) DO NOTHING
        RETURNING revision, data
      `) as RunExecutionRow[];
      if (rows[0]) {
        // Close the only tombstone race left by stateless Neon HTTP calls: a
        // delete may have committed and cleaned up after this INSERT took its
        // snapshot. Re-read through the live-run join and remove an orphan if
        // the canonical Run disappeared concurrently.
        const durable = await this.getRunExecution(candidate.runId);
        if (!durable) {
          await sql`
            DELETE FROM run_executions
            WHERE run_id = ${candidate.runId}
              AND execution_id = ${candidate.executionId}
              AND revision = ${candidate.revision}
          `;
          return { created: false as const, execution: null };
        }
        return { created: true as const, execution: durable };
      }
      return {
        created: false as const,
        execution: await this.getRunExecution(candidate.runId),
      };
    },

    async advanceRunExecution(execution, expectedRevision) {
      await ensureSchema();
      const runId = assertRunId(execution.runId);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new Error("expectedRevision must be a positive safe integer");
      }
      const current = await this.getRunExecution(runId);
      if (!current) {
        return { advanced: false as const, execution: null };
      }
      // A stale caller receives the winner without having its now-obsolete
      // transition validated or written.
      if (current.revision !== expectedRevision) {
        return { advanced: false as const, execution: current };
      }
      const candidate = assertRunExecutionTransition(
        current,
        execution,
        expectedRevision
      );
      const rows = (await sql`
        UPDATE run_executions AS execution
        SET execution_id = ${candidate.executionId},
            revision = ${candidate.revision},
            status = ${candidate.status},
            phase = ${candidate.phase},
            updated_at = ${candidate.updatedAt},
            data = ${JSON.stringify(candidate)}::jsonb
        WHERE execution.run_id = ${candidate.runId}
          AND execution.execution_id = ${candidate.executionId}
          AND execution.revision = ${expectedRevision}
          AND EXISTS (
            SELECT 1 FROM runs AS run
            WHERE run.id = execution.run_id
              AND run.data IS NOT NULL
              AND run.deleted_at IS NULL
          )
        RETURNING revision, data
      `) as RunExecutionRow[];
      if (rows[0]) {
        return { advanced: true as const, execution: executionFromRow(rows[0]) };
      }
      return {
        advanced: false as const,
        execution: await this.getRunExecution(candidate.runId),
      };
    },

    async putCanonicalRunSource(runId, video, approval) {
      await ensureSchema();
      assertRunId(runId);
      if (video.runId !== runId) {
        throw new Error("Canonical video run id does not match the run");
      }
      const videoJson = JSON.stringify(video);
      const approvalJson = approval ? JSON.stringify(approval) : null;
      const rows = (await sql`
        UPDATE runs
        SET label = ${video.label},
            data =
              (data - 'originalVideo' - 'spendApproval')
              || jsonb_build_object('originalVideo', ${videoJson}::jsonb)
              || CASE
                   WHEN ${approvalJson}::text IS NOT NULL
                     THEN jsonb_build_object(
                       'spendApproval', ${approvalJson}::jsonb
                     )
                   WHEN data->'spendApproval'->>'runId' = ${runId}
                     AND data->'spendApproval'->>'sourceUrl' = ${video.url}
                     AND data->'spendApproval'->'durationSec' =
                       to_jsonb(${video.durationSec}::double precision)
                     THEN jsonb_build_object(
                       'spendApproval', data->'spendApproval'
                     )
                   ELSE '{}'::jsonb
                 END
        WHERE id = ${runId}
          AND data IS NOT NULL
          AND deleted_at IS NULL
        RETURNING data
      `) as Array<{ data: Run }>;
      return rows[0] ? projectRunMedia(rows[0].data) : null;
    },

    async claimProviderOperation(runId, operation) {
      await ensureSchema();
      assertRunId(runId);
      const rows = (await sql`
        UPDATE runs
        SET data = jsonb_set(
          data,
          '{providerOperations}',
          COALESCE(data->'providerOperations', '[]'::jsonb)
            || ${JSON.stringify([operation])}::jsonb,
          true
        )
        WHERE id = ${runId}
          AND data IS NOT NULL
          AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              COALESCE(data->'providerOperations', '[]'::jsonb)
            ) AS item
            WHERE item->>'id' = ${operation.id}
          )
        RETURNING data
      `) as Array<{ data: Run }>;
      if (rows[0]) {
        return {
          claimed: true as const,
          run: await projectRunMedia(rows[0].data),
        };
      }
      const run = await this.getRun(runId);
      return {
        claimed: false as const,
        run,
        ...(run?.providerOperations?.find((item) => item.id === operation.id)
          ? {
              operation: run.providerOperations.find(
                (item) => item.id === operation.id
              ),
            }
          : {}),
      };
    },

    async putProviderOperation(runId, operation) {
      await ensureSchema();
      const id = assertRunId(runId);
      const operationId = assertPaidOperationId(operation.id);
      const serialized = JSON.stringify(operation);
      const serializedArray = JSON.stringify([operation]);
      const rows = (await sql`
        UPDATE runs
        SET data = jsonb_set(
          data,
          '{providerOperations}',
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                COALESCE(data->'providerOperations', '[]'::jsonb)
              ) AS existing
              WHERE existing->>'id' = ${operationId}
            ) THEN (
              SELECT jsonb_agg(
                CASE
                  WHEN item->>'id' = ${operationId} THEN
                    CASE
                      WHEN item->>'status' = 'completed'
                        OR (
                          item->>'status' <> 'in_progress'
                          AND ${operation.status} = 'in_progress'
                        )
                      THEN
                        (item || ${serialized}::jsonb)
                        || jsonb_build_object(
                          'status', item->'status',
                          'updatedAt', GREATEST(
                            COALESCE((item->>'updatedAt')::bigint, 0),
                            ${operation.updatedAt}
                          )
                        )
                      ELSE
                        (item || ${serialized}::jsonb)
                        || jsonb_build_object(
                          'updatedAt', GREATEST(
                            COALESCE((item->>'updatedAt')::bigint, 0),
                            ${operation.updatedAt}
                          )
                        )
                    END
                  ELSE item
                END
                ORDER BY ordinal
              )
              FROM jsonb_array_elements(
                COALESCE(data->'providerOperations', '[]'::jsonb)
              ) WITH ORDINALITY AS entries(item, ordinal)
            )
            ELSE COALESCE(data->'providerOperations', '[]'::jsonb)
              || ${serializedArray}::jsonb
          END,
          true
        )
        WHERE id = ${id} AND data IS NOT NULL
        RETURNING data
      `) as Array<{ data: Run }>;
      return rows[0] ? projectRunMedia(rows[0].data) : null;
    },

    async claimProviderWorkflow(runId, operationId, claimToken) {
      await ensureSchema();
      const id = assertRunId(runId);
      const opId = assertPaidOperationId(operationId);
      if (!/^[a-f0-9]{32}$/.test(claimToken)) {
        throw new Error("Invalid provider Workflow claim token");
      }
      const now = Date.now();
      const rows = (await sql`
        UPDATE runs
        SET data = jsonb_set(
          data,
          '{providerOperations}',
          (
            SELECT jsonb_agg(
              CASE
                WHEN item->>'id' = ${opId}
                  THEN item || jsonb_build_object(
                    'workflowClaimToken', ${claimToken},
                    'workflowClaimedAt', ${now},
                    'updatedAt', ${now}
                  )
                ELSE item
              END
              ORDER BY ordinal
            )
            FROM jsonb_array_elements(
              COALESCE(data->'providerOperations', '[]'::jsonb)
            ) WITH ORDINALITY AS entries(item, ordinal)
          ),
          true
        )
        WHERE id = ${id}
          AND data IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              COALESCE(data->'providerOperations', '[]'::jsonb)
            ) AS item
            WHERE item->>'id' = ${opId}
              AND NULLIF(item->>'providerInteractionId', '') IS NOT NULL
              AND NULLIF(item->>'workflowRunId', '') IS NULL
              AND NULLIF(item->>'workflowClaimToken', '') IS NULL
          )
        RETURNING data
      `) as Array<{ data: Run }>;
      if (rows[0]) {
        return {
          claimed: true as const,
          run: await projectRunMedia(rows[0].data),
        };
      }
      const run = await this.getRun(id);
      const operation = run?.providerOperations?.find((item) => item.id === opId);
      return {
        claimed: false as const,
        run,
        ...(operation ? { operation } : {}),
      };
    },

    async putHumanGrade(runId, grade, expectedGradedAt) {
      await ensureSchema();
      assertRunId(runId);
      const rows = expectedGradedAt === null
        ? ((await sql`
            UPDATE runs
            SET data = jsonb_set(
              data,
              '{humanGrade}',
              ${JSON.stringify(grade)}::jsonb,
              true
            )
            WHERE id = ${runId}
              AND data IS NOT NULL
              AND data->'humanGrade' IS NULL
            RETURNING data
          `) as Array<{ data: Run }>)
        : ((await sql`
            UPDATE runs
            SET data = jsonb_set(
              data,
              '{humanGrade}',
              ${JSON.stringify(grade)}::jsonb,
              true
            )
            WHERE id = ${runId}
              AND data IS NOT NULL
              AND data->'humanGrade'->>'gradedAt' = ${String(expectedGradedAt)}
            RETURNING data
          `) as Array<{ data: Run }>);
      if (rows[0]) {
        return {
          ok: true as const,
          run: await projectRunMedia(rows[0].data),
        };
      }
      return { ok: false as const, current: await this.getRun(runId) };
    },

    async getPaidOperation(runId, operationId) {
      await ensureSchema();
      const id = assertRunId(runId);
      const opId = assertPaidOperationId(operationId);
      const rows = (await sql`
        SELECT data
        FROM paid_operations
        WHERE run_id = ${id} AND operation_id = ${opId}
      `) as Array<{ data: PaidOperation }>;
      return rows[0] ? projectPaidOperationMedia(rows[0].data) : null;
    },

    async listPaidOperationCosts(runId) {
      await ensureSchema();
      const rows = (await sql`
        SELECT
          operation_id,
          data->>'provider' AS provider,
          data->>'kind' AS kind,
          NULLIF(data->>'iteration', '')::integer AS iteration,
          data->>'evalId' AS eval_id,
          (data->'result'->>'costUsd')::double precision AS cost_usd
        FROM paid_operations
        WHERE run_id = ${assertRunId(runId)}
          AND status = 'completed'
          AND jsonb_typeof(data->'result'->'costUsd') = 'number'
        ORDER BY (data->>'startedAt')::bigint ASC
      `) as Array<{
        operation_id: string;
        provider: PaidOperationCostEntry["provider"];
        kind: PaidOperationCostEntry["kind"];
        iteration: number | null;
        eval_id: string | null;
        cost_usd: number;
      }>;
      return rows.map((row) => ({
        id: row.operation_id,
        provider: row.provider,
        kind: row.kind,
        ...(row.iteration !== null ? { iteration: row.iteration } : {}),
        ...(row.eval_id ? { evalId: row.eval_id } : {}),
        costUsd: row.cost_usd,
      }));
    },

    async claimPaidOperation(operation) {
      await ensureSchema();
      const id = assertRunId(operation.runId);
      const opId = assertPaidOperationId(operation.id);
      if (!SHA256_RE.test(operation.inputHash)) {
        throw new Error("Paid operation inputHash must be a sha256 hex digest");
      }
      const rows = (await sql`
        INSERT INTO paid_operations (
          run_id, operation_id, input_hash, status, data
        )
        SELECT ${id}, ${opId}, ${operation.inputHash}, ${operation.status},
               ${JSON.stringify(operation)}::jsonb
        FROM runs
        WHERE id = ${id}
          AND data IS NOT NULL
          AND deleted_at IS NULL
        ON CONFLICT (run_id, operation_id) DO NOTHING
        RETURNING data
      `) as Array<{ data: PaidOperation }>;
      if (rows[0]) {
        return {
          claimed: true as const,
          operation: await projectPaidOperationMedia(rows[0].data),
        };
      }
      return {
        claimed: false as const,
        operation: await this.getPaidOperation(id, opId),
      };
    },

    async completePaidOperation(runId, operationId, inputHash, result) {
      await ensureSchema();
      const id = assertRunId(runId);
      const opId = assertPaidOperationId(operationId);
      if (!SHA256_RE.test(inputHash)) throw new Error("Invalid paid operation inputHash");
      const serialized = JSON.stringify(result);
      if (serialized === undefined) throw new Error("Paid operation result must be JSON serializable");
      const now = Date.now();
      const rows = (await sql`
        UPDATE paid_operations
        SET status = 'completed',
            data = (data - 'error') || jsonb_build_object(
              'status', 'completed',
              'updatedAt', ${now},
              'result', ${serialized}::jsonb
            )
        WHERE run_id = ${id}
          AND operation_id = ${opId}
          AND input_hash = ${inputHash}
          AND status = 'in_progress'
        RETURNING data
      `) as Array<{ data: PaidOperation }>;
      return rows[0]
        ? projectPaidOperationMedia(rows[0].data)
        : this.getPaidOperation(id, opId);
    },

    async reconcilePaidOperation(runId, operationId, inputHash, error) {
      await ensureSchema();
      const id = assertRunId(runId);
      const opId = assertPaidOperationId(operationId);
      if (!SHA256_RE.test(inputHash)) throw new Error("Invalid paid operation inputHash");
      const now = Date.now();
      const safeError = error.slice(0, 500);
      const rows = (await sql`
        UPDATE paid_operations
        SET status = 'reconcile_required',
            data = data || jsonb_build_object(
              'status', 'reconcile_required',
              'updatedAt', ${now},
              'error', ${safeError}
            )
        WHERE run_id = ${id}
          AND operation_id = ${opId}
          AND input_hash = ${inputHash}
          AND status = 'in_progress'
        RETURNING data
      `) as Array<{ data: PaidOperation }>;
      return rows[0]
        ? projectPaidOperationMedia(rows[0].data)
        : this.getPaidOperation(id, opId);
    },

    async deleteRun(runId: string): Promise<boolean> {
      await ensureSchema();
      const id = assertRunId(runId);
      const now = Date.now();

      type DeletionRunRow = {
        deleted_at: number | string | null;
        media: MediaMap | null;
      };
      const [beforeRowsRaw, beforeUploadsRaw, beforeCleanup] = await Promise.all([
        sql`
          SELECT deleted_at, media FROM runs WHERE id = ${id}
        `,
        sql`
          SELECT pathname FROM ingest_uploads WHERE run_id = ${id}
        `,
        readRetainedMediaHandles(id),
      ]);
      const beforeRows = beforeRowsRaw as unknown as DeletionRunRow[];
      const beforeUploads = beforeUploadsRaw as unknown as Array<{ pathname: string }>;
      const before = beforeRows[0];
      const existed =
        Boolean(before && before.deleted_at === null) ||
        beforeUploads.length > 0 ||
        beforeCleanup.length > 0;

      // A private-store token cannot delete an object from the old public
      // store. Refuse before hiding a live Run and retain the URL as the only
      // cleanup/migration handle.
      if (
        [...Object.values(before?.media ?? {}), ...beforeCleanup.map((row) => row.data)]
          .some((entry) => inferBlobAccess(entry) === "public")
      ) {
        throw new LegacyPublicMediaDeletionError();
      }

      // Commit (or resume) the permanent tombstone before any remote delete.
      // putRun/putMedia/upload completion all reject this id from this point.
      // Keep media intact until the provider confirms deletion so a retry never
      // loses the only private Blob handles.
      const tombstoned = (await sql`
        INSERT INTO runs (id, deleted_at)
        VALUES (${id}, ${now})
        ON CONFLICT (id) DO UPDATE SET
          status = NULL,
          label = NULL,
          data = NULL,
          deleted_at = COALESCE(runs.deleted_at, EXCLUDED.deleted_at)
        RETURNING media
      `) as Array<{ media: MediaMap | null }>;
      const media = tombstoned[0]?.media ?? {};
      const [uploadRowsRaw, cleanupRows] = await Promise.all([
        sql`
          SELECT pathname FROM ingest_uploads WHERE run_id = ${id}
        `,
        readRetainedMediaHandles(id),
      ]);
      const uploadRows = uploadRowsRaw as unknown as Array<{ pathname: string }>;
      if (
        [...Object.values(media), ...cleanupRows.map((row) => row.data)]
          .some((entry) => inferBlobAccess(entry) === "public")
      ) {
        // Covers the narrow preflight/tombstone race without discarding the
        // public handles. The id remains fail-closed and operator-recoverable.
        throw new LegacyPublicMediaDeletionError();
      }

      await deleteBlobsStrict([
        ...Object.values(media).map((entry) => entry.url),
        ...uploadRows.map((row) => row.pathname),
        ...cleanupRows.map((row) => row.url),
      ]);

      // One database statement retires every path that could continue or
      // resurrect ingest after the remote objects are confirmed deleted. The
      // compact paid-operation journal remains as a non-replay audit record.
      await sql`
        WITH retired_ingest_finalizations AS (
          DELETE FROM ingest_finalizations WHERE run_id = ${id}
          RETURNING run_id
        ), retired_ingest_uploads AS (
          DELETE FROM ingest_uploads WHERE run_id = ${id}
          RETURNING run_id
        ), retired_run_executions AS (
          DELETE FROM run_executions WHERE run_id = ${id}
          RETURNING run_id
        ), retired_video_finalizations AS (
          DELETE FROM video_finalizations WHERE run_id = ${id}
          RETURNING run_id
        ), retired_blob_cleanup_handles AS (
          DELETE FROM blob_cleanup_handles WHERE run_id = ${id}
          RETURNING run_id
        )
        UPDATE runs
        SET media = '{}'::jsonb
        WHERE id = ${id}
          AND deleted_at IS NOT NULL
      `;
      return existed;
    },

    async listRuns(): Promise<Run[]> {
      await ensureSchema();
      const rows = (await sql`
        SELECT id, data, media FROM runs
        WHERE data IS NOT NULL
          AND deleted_at IS NULL
        ORDER BY created_at DESC NULLS LAST
      `) as Array<{ id: string; data: Run; media: MediaMap | null }>;
      return rows.map((row) =>
        canonicalizeKnownMediaUrls(row.data, row.id, row.media ?? {})
      );
    },

    async listRunsPage(limit: number, cursor?: RunPageCursor) {
      await ensureSchema();
      const rowLimit = limit + 1;
      const rows = cursor
        ? ((await sql`
            SELECT id, data, media FROM runs
            WHERE data IS NOT NULL
              AND deleted_at IS NULL
              AND (
                created_at < ${cursor.createdAt}
                OR (created_at = ${cursor.createdAt} AND id < ${cursor.id})
              )
            ORDER BY created_at DESC NULLS LAST, id DESC
            LIMIT ${rowLimit}
          `) as Array<{ id: string; data: Run; media: MediaMap | null }> )
        : ((await sql`
            SELECT id, data, media FROM runs
            WHERE data IS NOT NULL
              AND deleted_at IS NULL
            ORDER BY created_at DESC NULLS LAST, id DESC
            LIMIT ${rowLimit}
          `) as Array<{ id: string; data: Run; media: MediaMap | null }> );
      return {
        runs: rows.slice(0, limit).map((row) =>
          canonicalizeKnownMediaUrls(row.data, row.id, row.media ?? {})
        ),
        hasMore: rows.length > limit,
      };
    },

    async getBatchExecution(batchId) {
      await migrateLegacyBatches();
      const id = assertRunId(batchId);
      const rows = (await sql`
        SELECT execution.revision, execution.data
        FROM batch_executions AS execution
        INNER JOIN batch_records AS batch ON batch.id = execution.batch_id
        WHERE execution.batch_id = ${id}
      `) as BatchExecutionRow[];
      return rows[0] ? batchExecutionFromRow(rows[0]) : null;
    },

    async listBatchExecutions() {
      await migrateLegacyBatches();
      const rows = (await sql`
        SELECT execution.revision, execution.data
        FROM batch_executions AS execution
        INNER JOIN batch_records AS batch ON batch.id = execution.batch_id
        ORDER BY batch.created_at DESC, execution.batch_id DESC
      `) as BatchExecutionRow[];
      return rows.map(batchExecutionFromRow);
    },

    async createBatchExecution(execution) {
      await migrateLegacyBatches();
      const candidate = assertNewBatchExecution(execution);
      const rows = (await sql`
        INSERT INTO batch_executions (
          batch_id, execution_id, revision, status, updated_at, data
        )
        SELECT ${candidate.batchId}, ${candidate.executionId},
               ${candidate.revision}, ${candidate.status},
               ${candidate.updatedAt}, ${JSON.stringify(candidate)}::jsonb
        FROM batch_records
        WHERE id = ${candidate.batchId}
          AND data->>'status' = 'ready'
        ON CONFLICT (batch_id) DO NOTHING
        RETURNING revision, data
      `) as BatchExecutionRow[];
      if (rows[0]) {
        return {
          created: true as const,
          execution: batchExecutionFromRow(rows[0]),
        };
      }
      return {
        created: false as const,
        execution: await this.getBatchExecution(candidate.batchId),
      };
    },

    async advanceBatchExecution(execution, expectedRevision) {
      await migrateLegacyBatches();
      const batchId = assertRunId(execution.batchId);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new Error("expectedRevision must be a positive safe integer");
      }
      const current = await this.getBatchExecution(batchId);
      if (!current) {
        return { advanced: false as const, execution: null };
      }
      if (current.revision !== expectedRevision) {
        return { advanced: false as const, execution: current };
      }
      const candidate = assertBatchExecutionTransition(
        current,
        execution,
        expectedRevision
      );
      const rows = (await sql`
        UPDATE batch_executions AS execution
        SET execution_id = ${candidate.executionId},
            revision = ${candidate.revision},
            status = ${candidate.status},
            updated_at = ${candidate.updatedAt},
            data = ${JSON.stringify(candidate)}::jsonb
        WHERE execution.batch_id = ${candidate.batchId}
          AND execution.execution_id = ${candidate.executionId}
          AND execution.revision = ${expectedRevision}
          AND EXISTS (
            SELECT 1 FROM batch_records AS batch
            WHERE batch.id = execution.batch_id
          )
        RETURNING revision, data
      `) as BatchExecutionRow[];
      if (rows[0]) {
        return {
          advanced: true as const,
          execution: batchExecutionFromRow(rows[0]),
        };
      }
      return {
        advanced: false as const,
        execution: await this.getBatchExecution(candidate.batchId),
      };
    },

    async getBatches(): Promise<Batch[]> {
      await migrateLegacyBatches();
      const rows = (await sql`
        SELECT data FROM batch_records
        ORDER BY created_at DESC, id DESC
      `) as Array<{ data: Batch }>;
      return Promise.all(rows.map((row) => projectBatchMedia(row.data)));
    },

    async putBatch(batch: Batch): Promise<Batch> {
      await migrateLegacyBatches();
      return projectBatchMedia(await putBatchRecord(batch));
    },

    async advanceBatch(batch, expectedStatus) {
      await migrateLegacyBatches();
      const result = await casBatchRecord(batch, expectedStatus);
      return result.batch
        ? {
            advanced: result.applied,
            batch: await projectBatchMedia(result.batch),
          }
        : { advanced: false, batch: null };
    },

    async putBatches(batches: Batch[]): Promise<void> {
      await migrateLegacyBatches();
      for (const batch of batches) await putBatchRecord(batch);
    },

    async getGradeDraft(draftId: string): Promise<GradeDraft | null> {
      await ensureSchema();
      const rows = (await sql`
        SELECT data FROM grade_drafts WHERE id = ${assertRunId(draftId)}
      `) as Array<{ data: GradeDraft }>;
      return rows[0]?.data ?? null;
    },

    async putGradeDraft(draft, expectedRevision) {
      await ensureSchema();
      assertRunId(draft.id);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error("expectedRevision must be a non-negative safe integer");
      }

      const saved: GradeDraft = {
        ...draft,
        revision: expectedRevision + 1,
        updatedAt: Date.now(),
      };
      let rows: Array<{ data: GradeDraft }>;
      if (expectedRevision === 0) {
        rows = (await sql`
          INSERT INTO grade_drafts (id, revision, updated_at, data)
          VALUES (${saved.id}, ${saved.revision}, ${saved.updatedAt},
                  ${JSON.stringify(saved)}::jsonb)
          ON CONFLICT (id) DO NOTHING
          RETURNING data
        `) as Array<{ data: GradeDraft }>;
      } else {
        rows = (await sql`
          UPDATE grade_drafts
          SET revision = ${saved.revision},
              updated_at = ${saved.updatedAt},
              data = ${JSON.stringify(saved)}::jsonb
          WHERE id = ${saved.id} AND revision = ${expectedRevision}
          RETURNING data
        `) as Array<{ data: GradeDraft }>;
      }

      if (rows[0]) return { ok: true as const, draft: rows[0].data };
      const current = await this.getGradeDraft(draft.id);
      return { ok: false as const, current };
    },

    async deleteGradeDraft(draftId, expectedRevision) {
      await ensureSchema();
      const id = assertRunId(draftId);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error("expectedRevision must be a non-negative safe integer");
      }
      const rows = (await sql`
        DELETE FROM grade_drafts
        WHERE id = ${id} AND revision = ${expectedRevision}
        RETURNING id
      `) as Array<{ id: string }>;
      if (rows.length > 0) return { ok: true as const, existed: true };
      const current = await this.getGradeDraft(id);
      if (!current && expectedRevision === 0) {
        return { ok: true as const, existed: false };
      }
      return { ok: false as const, current };
    },

    async reserveIngestUpload(reservation) {
      await ensureSchema();
      const candidate = assertIngestUploadReservation(reservation);
      const inserted = (await sql`
        INSERT INTO ingest_uploads (run_id, pathname, created_at, data)
        SELECT
          ${candidate.runId}, ${candidate.pathname}, ${candidate.createdAt},
          ${JSON.stringify(candidate)}::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM runs WHERE id = ${candidate.runId}
        )
        ON CONFLICT DO NOTHING
        RETURNING data
      `) as Array<{ data: IngestUploadReservation }>;
      if (inserted[0]) {
        return {
          created: true as const,
          reservation: assertIngestUploadReservation(inserted[0].data),
        };
      }
      const rows = (await sql`
        SELECT upload.data
        FROM ingest_uploads AS upload
        WHERE upload.run_id = ${candidate.runId}
          AND NOT EXISTS (
            SELECT 1 FROM runs AS run
            WHERE run.id = upload.run_id
          )
      `) as Array<{ data: IngestUploadReservation }>;
      return {
        created: false as const,
        reservation: rows[0]
          ? assertIngestUploadReservation(rows[0].data)
          : null,
      };
    },

    async getIngestUpload(runId) {
      await ensureSchema();
      const rows = (await sql`
        SELECT upload.data
        FROM ingest_uploads AS upload
        WHERE upload.run_id = ${assertRunId(runId)}
          AND NOT EXISTS (
            SELECT 1 FROM runs AS run
            WHERE run.id = upload.run_id
              AND run.deleted_at IS NOT NULL
          )
      `) as Array<{ data: IngestUploadReservation }>;
      return rows[0] ? assertIngestUploadReservation(rows[0].data) : null;
    },

    async listPendingIngestUploads(limit) {
      await migrateLegacyBatches();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Pending ingest limit must be between 1 and 100");
      }
      const rows = (await sql`
        SELECT upload.data
        FROM ingest_uploads AS upload
        WHERE NOT EXISTS (
          SELECT 1 FROM runs AS run
          WHERE run.id = upload.run_id
            AND (run.data IS NOT NULL OR run.deleted_at IS NOT NULL)
        )
          AND NOT EXISTS (
            SELECT 1
            FROM batch_records AS batch
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(batch.data -> 'runIds') = 'array'
                  THEN batch.data -> 'runIds'
                ELSE '[]'::jsonb
              END
            ) AS member(run_id)
            WHERE member.run_id = upload.run_id
          )
        ORDER BY upload.created_at DESC, upload.run_id DESC
        LIMIT ${limit}
      `) as Array<{ data: IngestUploadReservation }>;
      return rows.map((row) => assertIngestUploadReservation(row.data));
    },

    async completeIngestUpload(runId, pathname, completion) {
      await ensureSchema();
      const id = assertRunId(runId);
      if (
        completion.pathname !== pathname ||
        !Number.isSafeInteger(completion.completedAt) ||
        completion.completedAt <= 0 ||
        typeof completion.contentType !== "string" ||
        typeof completion.etag !== "string"
      ) {
        throw new Error("Invalid ingest upload completion");
      }
      const completionJson = JSON.stringify(completion);
      const rows = (await sql`
        UPDATE ingest_uploads
        SET data = jsonb_set(data, '{completed}', ${completionJson}::jsonb, true)
        WHERE run_id = ${id}
          AND pathname = ${pathname}
          AND NOT EXISTS (
            SELECT 1 FROM runs AS run
            WHERE run.id = ingest_uploads.run_id
              AND run.deleted_at IS NOT NULL
          )
          AND (
            data->'completed' IS NULL OR
            (
              data->'completed'->>'pathname' = ${pathname} AND
              data->'completed'->>'etag' = ${completion.etag}
            )
          )
        RETURNING data
      `) as Array<{ data: IngestUploadReservation }>;
      if (rows[0]) return assertIngestUploadReservation(rows[0].data);
      return null;
    },

    async claimIngestFinalization(runId, uploadFingerprint, leaseMs) {
      await ensureSchema();
      const id = assertRunId(runId);
      if (!/^[a-f0-9]{64}$/.test(uploadFingerprint)) {
        throw new Error("uploadFingerprint must be a sha256 hex digest");
      }
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
        throw new Error("leaseMs must be a positive safe integer");
      }

      const token = randomBytes(16).toString("hex");
      const now = Date.now();
      const expiresAt = now + leaseMs;
      const claimed = (await sql`
        INSERT INTO ingest_finalizations (
          run_id, upload_fingerprint, lease_token, lease_expires_at, updated_at
        )
        SELECT ${id}, ${uploadFingerprint}, ${token}, ${expiresAt}, ${now}
        WHERE NOT EXISTS (
          SELECT 1 FROM runs
          WHERE id = ${id}
            AND deleted_at IS NOT NULL
        )
        ON CONFLICT (run_id) DO UPDATE SET
          lease_token = EXCLUDED.lease_token,
          lease_expires_at = EXCLUDED.lease_expires_at,
          updated_at = EXCLUDED.updated_at
        WHERE ingest_finalizations.upload_fingerprint = EXCLUDED.upload_fingerprint
          AND ingest_finalizations.lease_expires_at <= ${now}
          AND NOT EXISTS (
            SELECT 1 FROM runs
            WHERE id = ingest_finalizations.run_id
              AND deleted_at IS NOT NULL
          )
        RETURNING lease_token
      `) as Array<{ lease_token: string }>;
      if (claimed[0]?.lease_token === token) {
        return { status: "acquired" as const, token };
      }

      const current = (await sql`
        SELECT upload_fingerprint
        FROM ingest_finalizations
        WHERE run_id = ${id}
          AND NOT EXISTS (
            SELECT 1 FROM runs
            WHERE id = ${id}
              AND deleted_at IS NOT NULL
          )
      `) as Array<{ upload_fingerprint: string }>;
      return current[0]?.upload_fingerprint === uploadFingerprint
        ? { status: "busy" as const }
        : { status: "conflict" as const };
    },

    async releaseIngestFinalization(runId, token) {
      await ensureSchema();
      const now = Date.now();
      await sql`
        UPDATE ingest_finalizations
        SET lease_expires_at = 0, updated_at = ${now}
        WHERE run_id = ${assertRunId(runId)} AND lease_token = ${token}
      `;
    },

    async claimVideoFinalization(runId, iteration, leaseMs) {
      await ensureSchema();
      const id = assertRunId(runId);
      if (!Number.isSafeInteger(iteration) || iteration < 1) {
        throw new Error("iteration must be a positive safe integer");
      }
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
        throw new Error("leaseMs must be a positive safe integer");
      }
      const token = randomBytes(16).toString("hex");
      const now = Date.now();
      const expiresAt = now + leaseMs;
      const rows = (await sql`
        INSERT INTO video_finalizations (
          run_id, iteration, lease_token, lease_expires_at, updated_at
        )
        SELECT ${id}, ${iteration}, ${token}, ${expiresAt}, ${now}
        FROM runs
        WHERE id = ${id}
          AND data IS NOT NULL
          AND deleted_at IS NULL
        ON CONFLICT (run_id, iteration) DO UPDATE SET
          lease_token = EXCLUDED.lease_token,
          lease_expires_at = EXCLUDED.lease_expires_at,
          updated_at = EXCLUDED.updated_at
        WHERE video_finalizations.lease_expires_at <= ${now}
        RETURNING lease_token
      `) as Array<{ lease_token: string }>;
      if (rows[0]?.lease_token === token) {
        return { status: "acquired" as const, token };
      }
      return (await this.getRun(id))
        ? { status: "busy" as const }
        : { status: "conflict" as const };
    },

    async releaseVideoFinalization(runId, iteration, token) {
      await ensureSchema();
      if (!Number.isSafeInteger(iteration) || iteration < 1) return;
      await sql`
        DELETE FROM video_finalizations
        WHERE run_id = ${assertRunId(runId)}
          AND iteration = ${iteration}
          AND lease_token = ${token}
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
      const id = assertRunId(runId);
      const name = assertMediaFileName(fileName);
      await ensureSchema();
      const stat = await fsp.stat(localPath);

      // Ensure every writer has a row it can lock before uploading. The
      // no-op conflict update rejects a permanent tombstone and closes the
      // otherwise-unrecoverable race between two first media writes.
      const owned = (await sql`
        INSERT INTO runs (id)
        VALUES (${id})
        ON CONFLICT (id) DO UPDATE SET id = runs.id
        WHERE runs.deleted_at IS NULL
        RETURNING id
      `) as Array<{ id: string }>;
      if (!owned[0]) throw new Error(`Run ${id} was permanently deleted`);

      // Random suffixes keep re-puts collision-free. Private access is the
      // production invariant; the provider URL is retained server-side only
      // as the authenticated SDK read/delete handle.
      const blob = await put(`runs/${id}/${name}`, createReadStream(localPath), {
        access: "private",
        addRandomSuffix: true,
        contentType: contentTypeFor(name),
        // VERIFY(vercel): default edge/browser cache is one month; run media
        // is write-once per fileName so the default is fine — revisit only if
        // a same-name overwrite flow ever appears.
      });

      const entry: BlobMediaEntry = {
        url: blob.url,
        size: stat.size,
        uploadedAt: Date.now(),
        access: "private",
      };

      // Media can arrive before the first putRun (ingest) — upsert a stub row
      // whose `data` stays NULL until the client pushes the Run JSON. Lock the
      // row before reading its old entry, then replace the canonical map and
      // retain that displaced handle in the SAME statement. Consequently a
      // transient Blob deletion failure or concurrent same-name writer can
      // never erase the only cleanup handle.
      try {
        const committed = (await sql`
          WITH prior AS MATERIALIZED (
            SELECT media -> ${name}::text AS entry
            FROM runs
            WHERE id = ${id}
              AND deleted_at IS NULL
            FOR UPDATE
          ), committed AS (
            UPDATE runs
            SET media = runs.media ||
              jsonb_build_object(${name}::text, ${JSON.stringify(entry)}::jsonb)
            WHERE id = ${id}
              AND deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM prior)
            RETURNING id
          ), retained AS (
            INSERT INTO blob_cleanup_handles (url, run_id, created_at, data)
            SELECT prior.entry ->> 'url', ${id}, ${Date.now()}, prior.entry
            FROM prior
            CROSS JOIN committed
            WHERE jsonb_typeof(prior.entry) = 'object'
              AND prior.entry ->> 'url' IS NOT NULL
              AND prior.entry ->> 'url' <> ${entry.url}
            ON CONFLICT (url) DO NOTHING
            RETURNING url
          )
          SELECT committed.id,
                 (SELECT count(*) FROM retained) AS retained_count
          FROM committed
        `) as Array<{ id: string }>;
        if (!committed[0]) {
          throw new Error(`Run ${id} was permanently deleted`);
        }
      } catch (err) {
        // A Blob without its database handle is unreachable garbage. Compensate
        // immediately when the metadata commit fails, then preserve the error.
        await deleteBlobsBestEffort([blob.url]);
        throw err;
      }

      // Cleanup is deliberately after the atomic metadata commit. A failed
      // delete leaves the old URL only in blob_cleanup_handles, never in a
      // browser-visible Run/media response, and the next write/delete retries.
      await retryRetainedMediaCleanup(id);
    },

    async getMediaToFile(
      runId: string,
      fileName: string,
      localPath: string
    ): Promise<string> {
      // Validate the durable live-row handle before trusting an old local
      // scratch copy. A tombstone must make even cached bytes unreadable.
      const map = await readMediaMap(runId);
      const entry = map[assertMediaFileName(fileName)];
      if (!entry) {
        throw new Error(`Media not found: runs/${runId}/${fileName}`);
      }

      // Run media is write-once per name — an existing scratch copy is valid.
      try {
        await fsp.access(localPath);
        return localPath;
      } catch {
        // fall through to download
      }

      const access = inferBlobAccess(entry);
      let source: ReadableStream<Uint8Array>;
      if (access === "public") {
        // Migration path: legacy public media may live in the old store after
        // BLOB_READ_WRITE_TOKEN moves to the new private store. Public reads
        // need no token and remain pinned to a validated Blob hostname.
        const response = await fetch(entry.url);
        if (!response.ok || !response.body) {
          throw new Error(`Blob download failed for runs/${runId}/${fileName}`);
        }
        source = response.body;
      } else {
        const response = await get(entry.url, {
          access: "private",
          useCache: false,
        });
        if (!response || response.statusCode !== 200) {
          throw new Error(`Blob download failed for runs/${runId}/${fileName}`);
        }
        source = response.stream;
      }
      await fsp.mkdir(path.dirname(localPath), { recursive: true });
      // Download to a temp name + rename so concurrent readers never see a
      // half-written scratch file.
      const tmp = `${localPath}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await pipeline(
          Readable.fromWeb(source as unknown as import("stream/web").ReadableStream),
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
      const id = assertRunId(runId);
      const [rowsRaw, cleanupRows] = await Promise.all([
        sql`
          SELECT media FROM runs
          WHERE id = ${id}
            AND deleted_at IS NULL
        `,
        readRetainedMediaHandles(id),
      ]);
      const rows = rowsRaw as unknown as Array<{ media: MediaMap | null }>;
      const media = rows[0]?.media ?? {};
      if (
        [...Object.values(media), ...cleanupRows.map((row) => row.data)]
          .some((entry) => inferBlobAccess(entry) === "public")
      ) {
        throw new LegacyPublicMediaDeletionError();
      }
      await deleteBlobsStrict([
        ...Object.values(media).map((entry) => entry.url),
        ...cleanupRows.map((row) => row.url),
      ]);
      if (Object.keys(media).length === 0 && cleanupRows.length === 0) return;

      // Clear only the exact snapshot whose objects were deleted. If a writer
      // raced us, retain all handles and fail so the operation can be retried;
      // remote deletion is idempotent.
      const cleared = (await sql`
        UPDATE runs
        SET media = '{}'::jsonb
        WHERE id = ${id}
          AND deleted_at IS NULL
          AND media = ${JSON.stringify(media)}::jsonb
        RETURNING id
      `) as Array<{ id: string }>;
      if (!cleared[0]) {
        throw new BlobDeletionIncompleteError();
      }
      // Remove only the cleanup snapshots whose remote objects were included
      // above. A concurrent later replacement must keep its newly inserted
      // handle even though this ingest-only media reset succeeded.
      for (const row of cleanupRows) {
        await sql`
          DELETE FROM blob_cleanup_handles
          WHERE run_id = ${id} AND url = ${row.url}
        `;
      }
    },

    async mediaReadStream(runId, fileName, range) {
      const map = await readMediaMap(runId);
      const entry = map[assertMediaFileName(fileName)];
      if (!entry) {
        throw new Error(`Media not found: runs/${runId}/${fileName}`);
      }
      const headers = range
        ? { Range: `bytes=${range.start}-${range.end}` }
        : undefined;
      const access = inferBlobAccess(entry);
      if (access === "public") {
        const response = await fetch(entry.url, { headers });
        if (!response.ok || !response.body) {
          throw new Error(`Blob read failed for runs/${runId}/${fileName}`);
        }
        return response.body;
      }
      const result = await get(entry.url, {
        access: "private",
        headers,
      });
      if (!result || result.statusCode !== 200) {
        throw new Error(`Blob read failed for runs/${runId}/${fileName}`);
      }
      return result.stream;
    },

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
      return `/api/media/runs/${runId}/${fileName}`;
    },
  };
}
