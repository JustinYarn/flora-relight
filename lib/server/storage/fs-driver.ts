/**
 * lib/server/storage/fs-driver.ts — the default storage driver: the local
 * <repo>/data filesystem, byte-for-byte the pre-seam behavior.
 *
 * Run/media I/O delegates to lib/server/runstore.ts. Small process-local
 * mutation queues provide the filesystem equivalent of the cloud driver's
 * atomic provider, grading, and draft transitions. Media keeps the seam's
 * local-path short-circuits:
 *
 *   - mediaWritePath  → the canonical destination path itself, so ffmpeg
 *     writes land directly where they always did;
 *   - putMediaFromFile → NO-OP when the local file already IS the canonical
 *     path (the normal case), plain copy otherwise;
 *   - getMediaToFile  → returns the canonical path, ignoring the suggested
 *     localPath (zero copying).
 */

import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  DATA_ROOT,
  UPLOADS_ROOT,
  assertRunId,
  deleteRun as deleteRunFiles,
  ensureDir,
  listRuns as listRunFiles,
  readBatches,
  readGradeDrafts,
  readRun,
  runDir,
  runMediaPath,
  runMediaUrl,
  safeJoin,
  writeBatches,
  writeGradeDrafts,
  writeJsonAtomic,
  writeRun,
} from "@/lib/server/runstore";
import type {
  Batch,
  BatchExecution,
  PaidOperation,
  ProviderOperation,
  Run,
  RunExecution,
  SpendApproval,
  VideoAsset,
} from "@/lib/types";
import {
  assertBatchExecution,
  assertBatchExecutionTransition,
  assertNewBatchExecution,
} from "./batch-execution";
import { mergeBatch, mergeBatchList } from "./batch-merge";
import {
  assertNewRunExecution,
  assertRunExecution,
  assertRunExecutionTransition,
} from "./run-execution";
import {
  ActiveRunDeletionError,
  hasDeletionBlockingBatchWork,
  hasDeletionBlockingRunWork,
} from "./run-deletion";
import { isProviderLostInteraction } from "@/lib/server/run-execution-failure";
import { isReplayableLampCombinedEvaluationFailure } from "@/lib/server/definitive-provider-rejection";
import type { MediaRange, MediaStat, RunPageCursor, StorageDriver } from "./types";
import {
  lampCombinedApprovalDisposition,
  validateLampCombinedApprovalMutation,
} from "./lamp-combined-approval";

const PAID_OPERATION_ID_RE = /^[a-z0-9:_-]{1,160}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const RUN_TOMBSTONES_PATH = path.join(DATA_ROOT, "run-tombstones.json");
// Kept outside runs/<id>/ so media listing/serving can never expose it.
const RUN_EXECUTIONS_ROOT = path.join(DATA_ROOT, "run-executions");
const BATCH_EXECUTIONS_ROOT = path.join(DATA_ROOT, "batch-executions");

type RunTombstones = Record<string, number>;

async function readRunTombstones(): Promise<RunTombstones> {
  try {
    return JSON.parse(await fsp.readFile(RUN_TOMBSTONES_PATH, "utf8")) as RunTombstones;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function isRunTombstoned(runId: string): Promise<boolean> {
  return Object.prototype.hasOwnProperty.call(await readRunTombstones(), runId);
}

function assertPaidOperationId(id: unknown): string {
  if (typeof id !== "string" || !PAID_OPERATION_ID_RE.test(id)) {
    throw new Error("Invalid paid operation id");
  }
  return id;
}

function paidOperationsPath(runId: string): string {
  return path.join(runDir(runId), "paid-operations.json");
}

function runExecutionPath(runId: string): string {
  return safeJoin(RUN_EXECUTIONS_ROOT, `${assertRunId(runId)}.json`);
}

async function readRunExecution(runId: string): Promise<RunExecution | null> {
  try {
    const parsed = JSON.parse(
      await fsp.readFile(runExecutionPath(runId), "utf8")
    ) as unknown;
    return assertRunExecution(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function batchExecutionPath(batchId: string): string {
  return safeJoin(BATCH_EXECUTIONS_ROOT, `${assertRunId(batchId)}.json`);
}

async function readBatchExecution(
  batchId: string
): Promise<BatchExecution | null> {
  try {
    const parsed = JSON.parse(
      await fsp.readFile(batchExecutionPath(batchId), "utf8")
    ) as unknown;
    return assertBatchExecution(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readPaidOperations(runId: string): Promise<PaidOperation[]> {
  try {
    return JSON.parse(
      await fsp.readFile(paidOperationsPath(runId), "utf8")
    ) as PaidOperation[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function mergeProviderOperation(
  current: ProviderOperation | undefined,
  incoming: ProviderOperation
): ProviderOperation {
  if (!current) return incoming;
  const currentTerminal = current.status !== "in_progress";
  const preserveCurrentStatus =
    current.status === "completed" ||
    (currentTerminal && incoming.status === "in_progress");
  return {
    ...current,
    ...incoming,
    workflowRunId: incoming.workflowRunId ?? current.workflowRunId,
    workflowStatus: incoming.workflowStatus ?? current.workflowStatus,
    workflowClaimToken:
      incoming.workflowClaimToken ?? current.workflowClaimToken,
    workflowClaimedAt: incoming.workflowClaimedAt ?? current.workflowClaimedAt,
    providerInteractionId:
      incoming.providerInteractionId ?? current.providerInteractionId,
    // The atomic claim snapshots these before the billed create call. Later
    // status/finalization writes may never widen or reprice that grant.
    maxAuthorizedCostMicros: current.maxAuthorizedCostMicros,
    billingUsdPerOutputSecond: current.billingUsdPerOutputSecond,
    result: incoming.result ?? current.result,
    error: incoming.error ?? current.error,
    status: preserveCurrentStatus ? current.status : incoming.status,
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
  };
}

function approvalMatchesVideo(
  approval: SpendApproval | undefined,
  video: VideoAsset
): approval is SpendApproval {
  return Boolean(
    approval &&
      approval.runId === video.runId &&
      approval.sourceUrl === video.url &&
      Number.isFinite(approval.durationSec) &&
      Math.abs(approval.durationSec - video.durationSec) <= 0.001
  );
}

export function createFsDriver(): StorageDriver {
  // Local dev runs in one Node process. Serialize the whole-map draft updates
  // so two near-simultaneous autosaves cannot both pass the revision check.
  let draftMutation: Promise<void> = Promise.resolve();
  function withDraftLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = draftMutation.then(operation, operation);
    draftMutation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  // All writes to one Run document share a single queue. This prevents a
  // normal browser snapshot from racing an atomic grade/provider update in
  // local development.
  let runMutation: Promise<void> = Promise.resolve();
  function withRunLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = runMutation.then(operation, operation);
    runMutation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  // Batch writes originate from both the browser autosave and server routes.
  // Serialize their read/merge/write cycle so the local driver has the same
  // per-record semantics as the cloud driver's revision CAS.
  let batchMutation: Promise<void> = Promise.resolve();
  function withBatchLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = batchMutation.then(operation, operation);
    batchMutation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  // The JSON file is durable; this process-wide queue provides the local
  // development equivalent of the cloud table's atomic row transitions.
  let paidOperationMutation: Promise<void> = Promise.resolve();
  function withPaidOperationLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = paidOperationMutation.then(operation, operation);
    paidOperationMutation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  const videoFinalizationLeases = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  return {
    name: "fs",

    // --- run / batch state: the existing runstore functions, unchanged -----
    async getRun(runId: string) {
      assertRunId(runId);
      if (await isRunTombstoned(runId)) return null;
      return readRun(runId);
    },
    async putRun(run: Run) {
      return withRunLock(async () => {
        if (await isRunTombstoned(run.id)) {
          throw new Error(`Run ${run.id} was permanently deleted`);
        }
        const current = await readRun(run.id);
        await writeRun({
          ...run,
          ...(current?.originalVideo
            ? { originalVideo: current.originalVideo }
            : {}),
          ...(current?.providerOperations
            ? { providerOperations: current.providerOperations }
            : {}),
          ...(current?.humanGrade ? { humanGrade: current.humanGrade } : {}),
          ...(current?.spendApproval
            ? { spendApproval: current.spendApproval }
            : {}),
        });
      });
    },
    async approveLampCombinedRun(runId, input) {
      const id = assertRunId(runId);
      const validated = await validateLampCombinedApprovalMutation(id, input);
      return withRunLock(async () => {
        if (await isRunTombstoned(id)) {
          return { ok: false as const, current: null };
        }
        const current = await readRun(id);
        if (!current) return { ok: false as const, current: null };
        const disposition = await lampCombinedApprovalDisposition(
          current,
          validated
        );
        if (disposition === "conflict") {
          return { ok: false as const, current };
        }
        if (disposition === "already_approved") {
          return { ok: true as const, run: current };
        }
        const updated: Run = {
          ...current,
          combinedPlan: validated.approvedPlan,
          spendApproval: validated.spendApproval,
        };
        await writeRun(updated);
        return { ok: true as const, run: updated };
      });
    },
    async getRunExecution(runId) {
      const id = assertRunId(runId);
      return withRunLock(async () => {
        if (await isRunTombstoned(id)) return null;
        if (!(await readRun(id))) return null;
        return readRunExecution(id);
      });
    },
    async createRunExecution(execution) {
      const candidate = assertNewRunExecution(execution);
      return withRunLock(async () => {
        if (await isRunTombstoned(candidate.runId)) {
          return { created: false as const, execution: null };
        }
        if (!(await readRun(candidate.runId))) {
          return { created: false as const, execution: null };
        }
        const current = await readRunExecution(candidate.runId);
        if (current) {
          return { created: false as const, execution: current };
        }
        await writeJsonAtomic(runExecutionPath(candidate.runId), candidate);
        return { created: true as const, execution: candidate };
      });
    },
    async advanceRunExecution(execution, expectedRevision) {
      assertRunId(execution.runId);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new Error("expectedRevision must be a positive safe integer");
      }
      return withRunLock(async () => {
        if (await isRunTombstoned(execution.runId)) {
          return { advanced: false as const, execution: null };
        }
        if (!(await readRun(execution.runId))) {
          return { advanced: false as const, execution: null };
        }
        const current = await readRunExecution(execution.runId);
        if (!current) {
          return { advanced: false as const, execution: null };
        }
        if (current.revision !== expectedRevision) {
          return { advanced: false as const, execution: current };
        }
        const candidate = assertRunExecutionTransition(
          current,
          execution,
          expectedRevision
        );
        await writeJsonAtomic(runExecutionPath(candidate.runId), candidate);
        return { advanced: true as const, execution: candidate };
      });
    },
    async putCanonicalRunSource(runId, video, approval) {
      return withRunLock(async () => {
        if (await isRunTombstoned(runId)) return null;
        const current = await readRun(runId);
        if (!current) return null;
        if (video.runId !== runId) {
          throw new Error("Canonical video run id does not match the run");
        }
        const retainedApproval =
          approval ??
          (approvalMatchesVideo(current.spendApproval, video)
            ? current.spendApproval
            : undefined);
        const updated: Run = {
          ...current,
          originalVideo: video,
          ...(retainedApproval ? { spendApproval: retainedApproval } : {}),
        };
        if (!retainedApproval) delete updated.spendApproval;
        await writeRun(updated);
        return updated;
      });
    },
    async claimProviderOperation(runId, operation) {
      return withRunLock(async () => {
        if (await isRunTombstoned(runId)) {
          return { claimed: false as const, run: null };
        }
        const run = await readRun(runId);
        if (!run) return { claimed: false as const, run: null };
        const existing = run.providerOperations?.find(
          (item) => item.id === operation.id
        );
        if (existing) {
          return { claimed: false as const, run, operation: existing };
        }
        const updated = {
          ...run,
          providerOperations: [...(run.providerOperations ?? []), operation],
        };
        await writeRun(updated);
        return { claimed: true as const, run: updated };
      });
    },
    async putProviderOperation(runId, operation) {
      return withRunLock(async () => {
        const run = await readRun(runId);
        if (!run) return null;
        const operations = [...(run.providerOperations ?? [])];
        const index = operations.findIndex((item) => item.id === operation.id);
        const merged = mergeProviderOperation(
          index >= 0 ? operations[index] : undefined,
          operation
        );
        if (index >= 0) operations[index] = merged;
        else operations.push(merged);
        const updated = { ...run, providerOperations: operations };
        await writeRun(updated);
        return updated;
      });
    },
    async supersedeLostVideoGeneration(runId, input) {
      const operationId = assertPaidOperationId(input.operationId);
      const archivedId = assertPaidOperationId(input.archivedOperationId);
      return withRunLock(async () => {
        if (await isRunTombstoned(runId)) {
          return { superseded: false as const, run: null };
        }
        const run = await readRun(runId);
        if (!run) return { superseded: false as const, run: null };
        const operations = [...(run.providerOperations ?? [])];
        const index = operations.findIndex((item) => item.id === operationId);
        const alreadyArchived = operations.some(
          (item) => item.id === archivedId
        );
        if (index < 0) {
          // A lost response after a completed supersession retries here.
          return { superseded: alreadyArchived, run };
        }
        const operation = operations[index];
        if (
          alreadyArchived ||
          operation.providerInteractionId !== input.providerInteractionId ||
          !isProviderLostInteraction(operation)
        ) {
          return { superseded: false as const, run };
        }
        operations[index] = {
          ...operation,
          id: archivedId,
          updatedAt: Date.now(),
        };
        const updated: Run = { ...run, providerOperations: operations };
        // The old grant covered exactly one attempt at this generation.
        // Withdrawing it forces the replacement through a fresh explicit
        // confirmation instead of silently reusing a still-valid approval.
        delete updated.spendApproval;
        await writeRun(updated);
        return { superseded: true as const, run: updated };
      });
    },
    async supersedeDefinitiveRejectedPaidOperation(runId, input) {
      const id = assertRunId(runId);
      const operationId = assertPaidOperationId(input.operationId);
      const archivedId = assertPaidOperationId(input.archivedOperationId);
      if (!SHA256_RE.test(input.inputHash)) {
        throw new Error("Invalid paid operation inputHash");
      }
      if (!Number.isSafeInteger(input.startedAt) || input.startedAt < 0) {
        throw new Error("Invalid paid operation startedAt");
      }
      if (!isReplayableLampCombinedEvaluationFailure(input.expectedError)) {
        return { superseded: false as const, run: await readRun(id) };
      }
      return withPaidOperationLock(async () => {
        if (await isRunTombstoned(id)) {
          return { superseded: false as const, run: null };
        }
        const operations = await readPaidOperations(id);
        const index = operations.findIndex((item) => item.id === operationId);
        const archivedIndex = operations.findIndex(
          (item) => item.id === archivedId
        );
        const matches = (operation: PaidOperation | undefined) =>
          Boolean(
            operation &&
              operation.provider === "gemini" &&
              operation.kind === "judge" &&
              operation.status === "reconcile_required" &&
              operation.inputHash === input.inputHash &&
              operation.startedAt === input.startedAt &&
              operation.error === input.expectedError &&
              isReplayableLampCombinedEvaluationFailure(operation.error)
          );
        if (index >= 0) {
          if (archivedIndex >= 0 || !matches(operations[index])) {
            return { superseded: false as const, run: await readRun(id) };
          }
          operations[index] = {
            ...operations[index],
            id: archivedId,
            updatedAt: Date.now(),
          };
          await writeJsonAtomic(paidOperationsPath(id), operations);
        } else if (!matches(operations[archivedIndex])) {
          return { superseded: false as const, run: await readRun(id) };
        }

        return withRunLock(async () => {
          const run = await readRun(id);
          if (!run) return { superseded: false as const, run: null };
          if (!run.spendApproval) {
            return { superseded: true as const, run };
          }
          const updated: Run = { ...run };
          delete updated.spendApproval;
          await writeRun(updated);
          return { superseded: true as const, run: updated };
        });
      });
    },
    async claimProviderWorkflow(runId, operationId, claimToken) {
      if (!/^[a-f0-9]{32}$/.test(claimToken)) {
        throw new Error("Invalid provider Workflow claim token");
      }
      return withRunLock(async () => {
        const run = await readRun(runId);
        if (!run) return { claimed: false as const, run: null };
        const operations = [...(run.providerOperations ?? [])];
        const index = operations.findIndex((item) => item.id === operationId);
        const operation = index >= 0 ? operations[index] : undefined;
        if (
          !operation ||
          !operation.providerInteractionId ||
          operation.workflowRunId ||
          operation.workflowClaimToken
        ) {
          return { claimed: false as const, run, ...(operation ? { operation } : {}) };
        }
        const claimedOperation = {
          ...operation,
          workflowClaimToken: claimToken,
          workflowClaimedAt: Date.now(),
          updatedAt: Date.now(),
        };
        operations[index] = claimedOperation;
        const updated = { ...run, providerOperations: operations };
        await writeRun(updated);
        return { claimed: true as const, run: updated };
      });
    },
    async putHumanGrade(runId, grade, expectedGradedAt) {
      return withRunLock(async () => {
        const run = await readRun(runId);
        if (!run) return { ok: false as const, current: null };
        if ((run.humanGrade?.gradedAt ?? null) !== expectedGradedAt) {
          return { ok: false as const, current: run };
        }
        const updated = { ...run, humanGrade: grade };
        await writeRun(updated);
        return { ok: true as const, run: updated };
      });
    },
    async getPaidOperation(runId, operationId) {
      const id = assertRunId(runId);
      const opId = assertPaidOperationId(operationId);
      return (await readPaidOperations(id)).find((item) => item.id === opId) ?? null;
    },
    async listPaidOperationCosts(runId) {
      const operations = await readPaidOperations(assertRunId(runId));
      return operations.flatMap((operation) => {
        const result = operation.result;
        const costUsd =
          result && typeof result === "object"
            ? (result as { costUsd?: unknown }).costUsd
            : undefined;
        if (
          operation.status !== "completed" ||
          typeof costUsd !== "number" ||
          !Number.isFinite(costUsd) ||
          costUsd < 0
        ) {
          return [];
        }
        return [
          {
            id: operation.id,
            provider: operation.provider,
            kind: operation.kind,
            ...(operation.iteration !== undefined
              ? { iteration: operation.iteration }
              : {}),
            ...(operation.evalId ? { evalId: operation.evalId } : {}),
            costUsd,
          },
        ];
      });
    },
    async claimPaidOperation(operation) {
      assertRunId(operation.runId);
      assertPaidOperationId(operation.id);
      if (!SHA256_RE.test(operation.inputHash)) {
        throw new Error("Paid operation inputHash must be a sha256 hex digest");
      }
      return withPaidOperationLock(async () => {
        if (await isRunTombstoned(operation.runId)) {
          return { claimed: false as const, operation: null };
        }
        // Claims are valid only while the canonical Run still exists.
        if (!(await readRun(operation.runId))) {
          return { claimed: false as const, operation: null };
        }
        const operations = await readPaidOperations(operation.runId);
        const existing = operations.find((item) => item.id === operation.id);
        if (existing) return { claimed: false as const, operation: existing };
        await writeJsonAtomic(paidOperationsPath(operation.runId), [
          ...operations,
          operation,
        ]);
        return { claimed: true as const, operation };
      });
    },
    async setPaidOperationProviderId(
      runId,
      operationId,
      inputHash,
      providerOperationId
    ) {
      const id = assertRunId(runId);
      const opId = assertPaidOperationId(operationId);
      if (!SHA256_RE.test(inputHash)) throw new Error("Invalid paid operation inputHash");
      if (!providerOperationId) throw new Error("Provider operation id is required");
      return withPaidOperationLock(async () => {
        const operations = await readPaidOperations(id);
        const index = operations.findIndex((item) => item.id === opId);
        if (index < 0) return null;
        const current = operations[index];
        if (
          current.inputHash !== inputHash ||
          current.status !== "in_progress" ||
          (current.providerOperationId &&
            current.providerOperationId !== providerOperationId)
        ) {
          return current;
        }
        const updated: PaidOperation = {
          ...current,
          providerOperationId,
          updatedAt: Date.now(),
        };
        operations[index] = updated;
        await writeJsonAtomic(paidOperationsPath(id), operations);
        return updated;
      });
    },
    async completePaidOperation(runId, operationId, inputHash, result) {
      const id = assertRunId(runId);
      const opId = assertPaidOperationId(operationId);
      if (!SHA256_RE.test(inputHash)) throw new Error("Invalid paid operation inputHash");
      return withPaidOperationLock(async () => {
        const operations = await readPaidOperations(id);
        const index = operations.findIndex((item) => item.id === opId);
        if (index < 0) return null;
        const current = operations[index];
        if (current.inputHash !== inputHash) return null;
        if (current.status === "completed") return current;
        if (current.status !== "in_progress") return current;
        const completed: PaidOperation = {
          ...current,
          status: "completed",
          result,
          error: undefined,
          updatedAt: Date.now(),
        };
        operations[index] = completed;
        await writeJsonAtomic(paidOperationsPath(id), operations);
        return completed;
      });
    },
    async reconcilePaidOperation(
      runId,
      operationId,
      inputHash,
      error,
      receipt
    ) {
      const id = assertRunId(runId);
      const opId = assertPaidOperationId(operationId);
      if (!SHA256_RE.test(inputHash)) throw new Error("Invalid paid operation inputHash");
      if (receipt !== undefined && JSON.stringify(receipt) === undefined) {
        throw new Error("Paid operation receipt must be JSON serializable");
      }
      return withPaidOperationLock(async () => {
        const operations = await readPaidOperations(id);
        const index = operations.findIndex((item) => item.id === opId);
        if (index < 0) return null;
        const current = operations[index];
        if (current.inputHash !== inputHash) return null;
        if (current.status === "completed" || current.status === "reconcile_required") {
          return current;
        }
        const reconciled: PaidOperation = {
          ...current,
          status: "reconcile_required",
          ...(receipt !== undefined ? { result: receipt } : {}),
          error: error.slice(0, 500),
          updatedAt: Date.now(),
        };
        operations[index] = reconciled;
        await writeJsonAtomic(paidOperationsPath(id), operations);
        return reconciled;
      });
    },
    async deleteRun(runId: string, options?: { force?: boolean }) {
      const id = assertRunId(runId);
      return withBatchLock(() =>
        withPaidOperationLock(() =>
          withRunLock(async () => {
            const tombstones = await readRunTombstones();
            const alreadyTombstoned = Object.prototype.hasOwnProperty.call(
              tombstones,
              id
            );
            const batches = await readBatches();
            const [run, execution, paidOperations, batchExecutions] =
              await Promise.all([
                readRun(id),
                readRunExecution(id),
                readPaidOperations(id),
                Promise.all(
                  batches.map((batch) => readBatchExecution(batch.id))
                ).then((items) =>
                  items.filter(
                    (item): item is BatchExecution => item !== null
                  )
                ),
              ]);
            if (
              !alreadyTombstoned &&
              options?.force !== true &&
              (hasDeletionBlockingRunWork(run, execution, paidOperations) ||
                hasDeletionBlockingBatchWork(id, batchExecutions))
            ) {
              throw new ActiveRunDeletionError();
            }
            let runExists = false;
            try {
              await fsp.access(runDir(id));
              runExists = true;
            } catch {
              runExists = false;
            }
            let executionExists = false;
            try {
              await fsp.access(runExecutionPath(id));
              executionExists = true;
            } catch {
              executionExists = false;
            }
            if (!runExists && !executionExists) return false;
            tombstones[id] = tombstones[id] ?? Date.now();
            // Commit the non-reusable id before removing files. A delayed
            // browser PUT therefore fails instead of recreating billing state.
            await writeJsonAtomic(RUN_TOMBSTONES_PATH, tombstones);
            const deletedRun = await deleteRunFiles(id);
            await fsp.rm(runExecutionPath(id), { force: true });
            return deletedRun || executionExists;
          })
        )
      );
    },
    async listRuns() {
      const tombstones = await readRunTombstones();
      return (await listRunFiles()).filter(
        (run) => !Object.prototype.hasOwnProperty.call(tombstones, run.id)
      );
    },
    async listRunsPage(limit: number, cursor?: RunPageCursor) {
      const tombstones = await readRunTombstones();
      const all = (await listRunFiles()).filter(
        (run) => !Object.prototype.hasOwnProperty.call(tombstones, run.id)
      );
      const eligible = (cursor
        ? all.filter(
            (run) =>
              run.createdAt < cursor.createdAt ||
              (run.createdAt === cursor.createdAt && run.id < cursor.id)
          )
        : all
      ).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      const page = eligible.slice(0, limit + 1);
      return {
        runs: page.slice(0, limit),
        hasMore: page.length > limit,
      };
    },
    async getBatchExecution(batchId) {
      const id = assertRunId(batchId);
      return withBatchLock(async () => {
        if (!(await readBatches()).some((batch) => batch.id === id)) return null;
        return readBatchExecution(id);
      });
    },
    async listBatchExecutions() {
      return withBatchLock(async () => {
        const executions = await Promise.all(
          (await readBatches()).map((batch) => readBatchExecution(batch.id))
        );
        return executions.filter(
          (execution): execution is BatchExecution => execution !== null
        );
      });
    },
    async createBatchExecution(execution) {
      const candidate = assertNewBatchExecution(execution);
      return withBatchLock(async () => {
        const current = await readBatchExecution(candidate.batchId);
        if (current) {
          return { created: false as const, execution: current };
        }
        if (
          !(await readBatches()).some(
            (batch) =>
              batch.id === candidate.batchId && batch.status === "ready"
          )
        ) {
          return { created: false as const, execution: null };
        }
        const tombstones = await readRunTombstones();
        const memberRuns = await Promise.all(
          candidate.members.map((member) => readRun(member.runId))
        );
        if (
          candidate.members.some(
            (member, index) =>
              !memberRuns[index] ||
              Object.prototype.hasOwnProperty.call(tombstones, member.runId)
          )
        ) {
          return { created: false as const, execution: null };
        }
        await writeJsonAtomic(batchExecutionPath(candidate.batchId), candidate);
        return { created: true as const, execution: candidate };
      });
    },
    async advanceBatchExecution(execution, expectedRevision) {
      assertRunId(execution.batchId);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new Error("expectedRevision must be a positive safe integer");
      }
      return withBatchLock(async () => {
        if (
          !(await readBatches()).some((batch) => batch.id === execution.batchId)
        ) {
          return { advanced: false as const, execution: null };
        }
        const current = await readBatchExecution(execution.batchId);
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
        await writeJsonAtomic(batchExecutionPath(candidate.batchId), candidate);
        return { advanced: true as const, execution: candidate };
      });
    },
    async getBatches() {
      return withBatchLock(async () => mergeBatchList(await readBatches(), []));
    },
    async putBatch(batch: Batch) {
      return withBatchLock(async () => {
        const current = await readBatches();
        const saved = mergeBatch(
          current.find((item) => item.id === batch.id) ?? null,
          batch
        );
        await writeBatches(
          mergeBatchList(
            current.filter((item) => item.id !== batch.id),
            [saved]
          )
        );
        return saved;
      });
    },
    async advanceBatch(batch, expectedStatus) {
      return withBatchLock(async () => {
        const current = await readBatches();
        const existing = current.find((item) => item.id === batch.id) ?? null;
        if (!existing || existing.status !== expectedStatus) {
          return { advanced: false as const, batch: existing };
        }
        const saved = mergeBatch(existing, batch);
        if (saved.status === existing.status) {
          throw new Error("A batch transition must advance its durable status");
        }
        await writeBatches(
          mergeBatchList(
            current.filter((item) => item.id !== batch.id),
            [saved]
          )
        );
        return { advanced: true as const, batch: saved };
      });
    },
    async putBatches(batches: Batch[]) {
      return withBatchLock(async () => {
        await writeBatches(mergeBatchList(await readBatches(), batches));
      });
    },

    async getGradeDraft(draftId) {
      const id = assertRunId(draftId);
      return (await readGradeDrafts())[id] ?? null;
    },

    async putGradeDraft(draft, expectedRevision) {
      assertRunId(draft.id);
      return withDraftLock(async () => {
        const drafts = await readGradeDrafts();
        const current = drafts[draft.id] ?? null;
        if ((current?.revision ?? 0) !== expectedRevision) {
          return { ok: false as const, current };
        }
        const saved = {
          ...draft,
          revision: expectedRevision + 1,
          updatedAt: Date.now(),
        };
        await writeGradeDrafts({ ...drafts, [draft.id]: saved });
        return { ok: true as const, draft: saved };
      });
    },

    async deleteGradeDraft(draftId, expectedRevision) {
      const id = assertRunId(draftId);
      return withDraftLock(async () => {
        const drafts = await readGradeDrafts();
        const current = drafts[id] ?? null;
        if (!current && expectedRevision === 0) {
          return { ok: true as const, existed: false };
        }
        if (!current || current.revision !== expectedRevision) {
          return { ok: false as const, current };
        }
        const { [id]: removed, ...remaining } = drafts;
        void removed;
        await writeGradeDrafts(remaining);
        return { ok: true as const, existed: true };
      });
    },

    async claimVideoFinalization(runId, iteration, leaseMs) {
      const id = assertRunId(runId);
      if (!Number.isSafeInteger(iteration) || iteration < 1) {
        throw new Error("iteration must be a positive safe integer");
      }
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
        throw new Error("leaseMs must be a positive safe integer");
      }
      if (!(await readRun(id))) return { status: "conflict" as const };

      const key = `${id}:${iteration}`;
      const now = Date.now();
      const existing = videoFinalizationLeases.get(key);
      if (existing && existing.expiresAt > now) {
        return { status: "busy" as const };
      }
      const token = randomBytes(16).toString("hex");
      videoFinalizationLeases.set(key, { token, expiresAt: now + leaseMs });
      return { status: "acquired" as const, token };
    },

    async releaseVideoFinalization(runId, iteration, token) {
      const id = assertRunId(runId);
      if (!Number.isSafeInteger(iteration) || iteration < 1) return;
      const key = `${id}:${iteration}`;
      if (videoFinalizationLeases.get(key)?.token === token) {
        videoFinalizationLeases.delete(key);
      }
    },

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
