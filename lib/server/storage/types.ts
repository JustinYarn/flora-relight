/**
 * lib/server/storage/types.ts — the storage driver seam.
 *
 * Everything the server routes need for run/batch persistence and run media
 * lives behind this interface so the backing store can be swapped by env:
 *
 *   - fs driver (default, lib/server/storage/fs-driver.ts): the existing
 *     <repo>/data filesystem layout, byte-for-byte the pre-seam behavior.
 *   - blob driver (lib/server/storage/blob-driver.ts): private Vercel Blob for
 *     media + Postgres for run/batch JSON, selected only when credentials are
 *     present and FLORA_BLOB_ACCESS=private is explicit.
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

import type {
  Batch,
  BatchExecution,
  GradeDraft,
  HumanGrade,
  PaidOperation,
  ProviderOperation,
  Run,
  RunExecution,
  SpendApproval,
  VideoAsset,
} from "@/lib/types";

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

/** Secret-safe result of an active durable-backend round trip. */
export interface DurableStorageVerification {
  ok: boolean;
  checkedAt: number;
  blob: { ok: boolean };
  database: { ok: boolean };
}

/** Result of a revision-checked grading-draft upsert. */
export type GradeDraftWriteResult =
  | { ok: true; draft: GradeDraft }
  | { ok: false; current: GradeDraft | null };

/** Result of a revision-checked grading-draft deletion. */
export type GradeDraftDeleteResult =
  | { ok: true; existed: boolean }
  | { ok: false; current: GradeDraft | null };

/** Stable keyset cursor for newest-first run listings. */
export interface RunPageCursor {
  createdAt: number;
  id: string;
}

export interface RunPage {
  runs: Run[];
  hasMore: boolean;
}

export type IngestFinalizationClaim =
  | { status: "acquired"; token: string }
  | { status: "busy" | "conflict" };

/**
 * Durable ownership record minted before a browser may upload raw bytes.
 * The deterministic pathname lets a later browser session discover a
 * completed private upload without ever receiving a reusable download URL.
 */
export interface IngestUploadReservation {
  schema: "flora.ingest-upload.v1";
  runId: string;
  pathname: string;
  fileName: string;
  access: "private";
  createdAt: number;
  completed?: {
    pathname: string;
    contentType: string;
    etag: string;
    completedAt: number;
  };
}

/** First writer owns a run id; retries receive the durable reservation. */
export type IngestUploadReserveResult =
  | { created: true; reservation: IngestUploadReservation }
  | { created: false; reservation: IngestUploadReservation | null };

/** Atomic application-level claim for a potentially billed provider action. */
export type ProviderOperationClaimResult =
  | { claimed: true; run: Run }
  | { claimed: false; run: Run | null; operation?: ProviderOperation };

export type HumanGradeWriteResult =
  | { ok: true; run: Run }
  | { ok: false; current: Run | null };

/** Winner/loser result for a revision-checked batch status transition. */
export type BatchAdvanceResult =
  | { advanced: true; batch: Batch }
  | { advanced: false; batch: Batch | null };

/** First writer wins; a duplicate receives the already-durable execution. */
export type RunExecutionCreateResult =
  | { created: true; execution: RunExecution }
  | { created: false; execution: RunExecution | null };

/** Winner/loser result for one revision-checked execution transition. */
export type RunExecutionAdvanceResult =
  | { advanced: true; execution: RunExecution }
  | { advanced: false; execution: RunExecution | null };

/** First writer wins; a duplicate receives the already-durable execution. */
export type BatchExecutionCreateResult =
  | { created: true; execution: BatchExecution }
  | { created: false; execution: BatchExecution | null };

/** Winner/loser result for one revision-checked batch execution transition. */
export type BatchExecutionAdvanceResult =
  | { advanced: true; execution: BatchExecution }
  | { advanced: false; execution: BatchExecution | null };

/** Atomic reservation result for one synchronous potentially billed call. */
export type PaidOperationClaimResult =
  | { claimed: true; operation: PaidOperation }
  | { claimed: false; operation: PaidOperation | null };

/** Minimal server-owned projection used to rebuild the displayed actual spend. */
export interface PaidOperationCostEntry {
  id: string;
  provider: PaidOperation["provider"];
  kind: PaidOperation["kind"];
  iteration?: number;
  evalId?: string;
  costUsd: number;
}

export interface StorageDriver {
  /** Driver id, for the one-line startup log. */
  readonly name: "fs" | "blob";

  /**
   * Cloud-only active write/read/delete probe. It must not call an AI
   * provider or expose backend errors/secrets in its returned projection.
   */
  verifyDurableStorage?(): Promise<DurableStorageVerification>;

  // -------------------------------------------------------------------------
  // Run / batch JSON state
  // -------------------------------------------------------------------------

  /** Full run JSON, or null when the run doesn't exist. */
  getRun(runId: string): Promise<Run | null>;

  /** Upsert one run's JSON (and any driver-side index bookkeeping). */
  putRun(run: Run): Promise<void>;

  /** Server-only durable coordinator state, separate from browser Run JSON. */
  getRunExecution(runId: string): Promise<RunExecution | null>;

  /** Insert revision 1 exactly once while the canonical Run still exists. */
  createRunExecution(
    execution: RunExecution
  ): Promise<RunExecutionCreateResult>;

  /**
   * Advance only while the durable record is at `expectedRevision`. The
   * supplied execution must be the immutable identity's next revision.
   */
  advanceRunExecution(
    execution: RunExecution,
    expectedRevision: number
  ): Promise<RunExecutionAdvanceResult>;

  /** Server-only durable dispatcher state, separate from browser Batch JSON. */
  getBatchExecution(batchId: string): Promise<BatchExecution | null>;

  /** All durable batch executions whose parent Batch still exists. */
  listBatchExecutions(): Promise<BatchExecution[]>;

  /** Insert a validated revision-1 batch execution exactly once. */
  createBatchExecution(
    execution: BatchExecution
  ): Promise<BatchExecutionCreateResult>;

  /** Revision-checked, forward-only batch execution transition. */
  advanceBatchExecution(
    execution: BatchExecution,
    expectedRevision: number
  ): Promise<BatchExecutionAdvanceResult>;

  /**
   * Replace the server-verified source facts and, when supplied, the approval
   * priced from those exact facts. Ordinary run snapshots are never allowed
   * to replace either field.
   */
  putCanonicalRunSource(
    runId: string,
    video: VideoAsset,
    approval?: SpendApproval
  ): Promise<Run | null>;

  /**
   * Append `operation` only when its stable id does not already exist. Cloud
   * drivers must enforce this in one database statement so two tabs cannot
   * both pass the pre-billing check.
   */
  claimProviderOperation(
    runId: string,
    operation: ProviderOperation
  ): Promise<ProviderOperationClaimResult>;

  /** Atomically merge one server-owned video operation journal entry. */
  putProviderOperation(
    runId: string,
    operation: ProviderOperation
  ): Promise<Run | null>;

  /** Claim the single right to enqueue a poll Workflow for a provider handle. */
  claimProviderWorkflow(
    runId: string,
    operationId: string,
    claimToken: string
  ): Promise<ProviderOperationClaimResult>;

  /** Atomic final-grade write; stale tabs cannot replace an existing grade. */
  putHumanGrade(
    runId: string,
    grade: HumanGrade,
    expectedGradedAt: number | null
  ): Promise<HumanGradeWriteResult>;

  /** Read one server-owned paid-operation journal entry. */
  getPaidOperation(runId: string, operationId: string): Promise<PaidOperation | null>;

  /** Completed billed calls projected without returning prompts/verdict payloads. */
  listPaidOperationCosts(runId: string): Promise<PaidOperationCostEntry[]>;

  /**
   * Insert exactly once by (runId, operation.id). A loser receives the durable
   * existing entry and must never issue the provider request.
   */
  claimPaidOperation(operation: PaidOperation): Promise<PaidOperationClaimResult>;

  /** Mark an in-progress claim complete and persist its replayable response. */
  completePaidOperation(
    runId: string,
    operationId: string,
    inputHash: string,
    result: unknown
  ): Promise<PaidOperation | null>;

  /**
   * Conservatively seal an ambiguous/failed request. Completed entries are
   * immutable and can never be downgraded by a late error handler.
   */
  reconcilePaidOperation(
    runId: string,
    operationId: string,
    inputHash: string,
    error: string
  ): Promise<PaidOperation | null>;

  /**
   * Permanently delete a run: its JSON/state AND its whole media folder.
   * Active or reconciliation-required provider work must be refused before
   * tombstoning so its only durable billing/recovery journal remains intact.
   * Returns whether anything existed. Irreversible by design.
   */
  deleteRun(runId: string): Promise<boolean>;

  /** All persisted runs, newest first. */
  listRuns(): Promise<Run[]>;

  /**
   * One newest-first keyset page. Routes use this instead of serializing the
   * entire corpus into one response (Vercel caps function payloads at 4.5MB).
   */
  listRunsPage(limit: number, cursor?: RunPageCursor): Promise<RunPage>;

  /** The whole batch list (empty array when none persisted yet). */
  getBatches(): Promise<Batch[]>;

  /** Monotonically merge one batch and return its durable representation. */
  putBatch(batch: Batch): Promise<Batch>;

  /**
   * Advance only when the durable record is still at `expectedStatus`.
   * Concurrent callers receive the winner's batch with `advanced: false`.
   */
  advanceBatch(
    batch: Batch,
    expectedStatus: Batch["status"]
  ): Promise<BatchAdvanceResult>;

  /**
   * Legacy list writer. Every supplied batch is merged independently and
   * batches omitted by the caller are preserved.
   */
  putBatches(batches: Batch[]): Promise<void>;

  /** One revisioned blind-grading workspace, or null before the first edit. */
  getGradeDraft(draftId: string): Promise<GradeDraft | null>;

  /**
   * Compare-and-swap upsert. `expectedRevision` is 0 for a new draft; a stale
   * revision returns the current document instead of overwriting it.
   */
  putGradeDraft(
    draft: GradeDraft,
    expectedRevision: number
  ): Promise<GradeDraftWriteResult>;

  /** Revision-checked permanent deletion of one grading workspace. */
  deleteGradeDraft(
    draftId: string,
    expectedRevision: number
  ): Promise<GradeDraftDeleteResult>;

  /**
   * OPTIONAL cloud-only raw-upload reservation. The token route must persist
   * this before minting client write access. A run id and pathname are
   * first-writer-wins so one upload can never be finalized as another run.
   */
  reserveIngestUpload?(
    reservation: IngestUploadReservation
  ): Promise<IngestUploadReserveResult>;

  /** Read the durable raw-upload ownership record for recovery/finalize. */
  getIngestUpload?(runId: string): Promise<IngestUploadReservation | null>;

  /**
   * Newest raw-upload reservations that do not yet have a prepared Run. This
   * is intentionally bounded and server-only so a later browser session can
   * discover interrupted direct uploads without receiving Blob pathnames.
   */
  listPendingIngestUploads?(
    limit: number
  ): Promise<IngestUploadReservation[]>;

  /** Persist an SDK-signature-verified upload completion against its owner. */
  completeIngestUpload?(
    runId: string,
    pathname: string,
    completion: NonNullable<IngestUploadReservation["completed"]>
  ): Promise<IngestUploadReservation | null>;

  /**
   * OPTIONAL cloud-only lease for an ingest reservation. It serializes
   * duplicate finalize requests across serverless instances; an expired lease
   * may be taken over after a killed function.
   */
  claimIngestFinalization?(
    runId: string,
    uploadFingerprint: string,
    leaseMs: number
  ): Promise<IngestFinalizationClaim>;

  /** Release a cloud ingest lease only when `token` still owns it. */
  releaseIngestFinalization?(runId: string, token: string): Promise<void>;

  /** Cross-instance lease around deterministic video artifact finalization. */
  claimVideoFinalization(
    runId: string,
    iteration: number,
    leaseMs: number
  ): Promise<IngestFinalizationClaim>;

  releaseVideoFinalization(
    runId: string,
    iteration: number,
    token: string
  ): Promise<void>;

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
   * Cloud drivers authenticate their backend read here. The public HTTP route
   * remains same-origin and gate-protected; it must never redirect private
   * media to a provider URL.
   */
  mediaReadStream(
    runId: string,
    fileName: string,
    range?: MediaRange
  ): Promise<ReadableStream>;

  /**
   * Browser-safe URL under which this media file is served.
   *   fs   → "/api/media/runs/<runId>/<fileName>" (same-origin route, exactly
   *          as before the seam; the access gate middleware always applies).
   *   blob → the same canonical route. The route authenticates and proxies
   *          bytes with Range support through the Blob SDK.
   */
  publicMediaUrl(runId: string, fileName: string): Promise<string>;

  /**
   * OPTIONAL migration seam: reverse-map an ABSOLUTE legacy media URL back to
   * (runId, fileName), or null when it isn't one of ours. Needed because
   * older clients may echo pre-private CDN URLs back as `sourceUrl`. New
   * clients only receive same-origin "/api/media/..." references.
   */
  resolveMediaUrl?(url: string): Promise<{ runId: string; fileName: string } | null>;
}
