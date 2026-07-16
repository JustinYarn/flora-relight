/**
 * POST /api/batches/start
 *
 * Mock mode commits durable run skeletons and returns browser ownership. Live
 * mode first freezes a server-only BatchExecution/budget plan, gives approval
 * only to admitted members, atomically advances the trusted Batch, and then
 * enqueues a durable parent Workflow. A lost response can repeat every step;
 * only non-paid Workflow contenders are duplicated.
 */

import { NextRequest, NextResponse } from "next/server";
import type {
  Batch,
  BatchExecution,
  BatchUploadItem,
  Run,
  VideoAsset,
  WorkflowMode,
} from "@/lib/types";
import { buildQueuedRun, freshNodeStates } from "@/lib/run-factory";
import {
  batchApprovalStartedAt,
  batchApprovalScope,
  batchExecutionMode,
  normalizedWorkflowMode,
} from "@/lib/server/batch-contract";
import { requeueLampBatchExecutionAfterApproval } from "@/lib/server/batch-execution-resume";
import {
  DURABLE_BATCH_CONCURRENCY,
  microsToUsd,
} from "@/lib/server/batch-budget";
import {
  enqueueBatchExecution,
  prepareBatchExecution,
} from "@/lib/server/batch-execution-coordinator";
import { summarizeBatchExecution } from "@/lib/server/batch-execution-view";
import { hasGeminiKey } from "@/lib/server/gemini";
import { v2SyncConfigIssue } from "@/lib/server/syncnet";
import { readCanonicalIngestByRunId } from "@/lib/server/ingest";
import { isValidRunId } from "@/lib/server/runstore";
import {
  BATCH_APPROVAL_LIFETIME_MS,
  createSpendApproval,
  hasReusableFirstCutApproval,
  hasReusableLampApproval,
} from "@/lib/server/spend-approval";
import { getStorage, type StorageDriver } from "@/lib/server/storage";
import { workflowForMode } from "@/lib/workflow-def";
import {
  FLORA_RETIRED_BATCH_ERROR,
  floraRetiredForNewWork,
} from "@/lib/workflow-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StartBody {
  batchId?: unknown;
  budgetUsd?: unknown;
  approveLiveSpend?: unknown;
  allowIncompleteUploads?: unknown;
  workflowMode?: unknown;
}

function readyVideo(
  item: BatchUploadItem
): item is BatchUploadItem & { video: VideoAsset } {
  return item.status === "ready" && item.video !== undefined;
}

function validateBody(body: StartBody): string | null {
  if (!isValidRunId(body.batchId)) return "Invalid batch id.";
  if (
    body.budgetUsd !== undefined &&
    (typeof body.budgetUsd !== "number" ||
      !Number.isFinite(body.budgetUsd) ||
      body.budgetUsd <= 0)
  ) {
    return "budgetUsd must be a positive number when provided.";
  }
  if (
    body.approveLiveSpend !== undefined &&
    typeof body.approveLiveSpend !== "boolean"
  ) {
    return "approveLiveSpend must be a boolean.";
  }
  if (
    body.allowIncompleteUploads !== undefined &&
    typeof body.allowIncompleteUploads !== "boolean"
  ) {
    return "allowIncompleteUploads must be a boolean.";
  }
  if (
    body.workflowMode !== undefined &&
    body.workflowMode !== "flora" &&
    body.workflowMode !== "lamp"
  ) {
    return 'workflowMode must be either "flora" or "lamp".';
  }
  return null;
}

async function canonicalizeReadyRuns(
  storage: StorageDriver,
  batch: Batch,
  workflowMode: WorkflowMode
): Promise<Run[]> {
  const allowedRunIds = new Set(batch.runIds);
  const uploads = (batch.uploads ?? []).filter(
    (item): item is BatchUploadItem & { video: VideoAsset } =>
      allowedRunIds.has(item.runId) && readyVideo(item)
  );
  if (uploads.length === 0) {
    throw new Error("This batch has no successfully prepared videos.");
  }

  const runs: Run[] = [];
  for (const upload of uploads) {
    if (!isValidRunId(upload.runId) || upload.video.runId !== upload.runId) {
      throw new Error(`Prepared upload ${upload.label} has an invalid run identity.`);
    }
    const ingest = await readCanonicalIngestByRunId(upload.runId);
    if (!ingest) {
      throw new Error(`No durable ingested source exists for ${upload.label}.`);
    }
    const canonicalVideo: VideoAsset = {
      id: upload.video.id,
      runId: ingest.runId,
      kind: "original",
      url: ingest.url,
      label: upload.label,
      durationSec: ingest.durationSec,
      width: ingest.width,
      height: ingest.height,
      hasAudio: ingest.hasAudio,
    };
    const persisted = await storage.getRun(upload.runId);
    if (persisted) {
      const updated = await storage.putCanonicalRunSource(
        upload.runId,
        canonicalVideo
      );
      if (!updated) {
        throw new Error(`Run ${upload.runId} changed while the batch was starting.`);
      }
      const workflow = workflowForMode(workflowMode);
      const canonicalRun: Run = {
        ...updated,
        workflowId: workflow.id,
        workflowMode,
        nodeStates: freshNodeStates(workflowMode),
      };
      await storage.putRun(canonicalRun);
      runs.push(canonicalRun);
    } else {
      const run = buildQueuedRun(canonicalVideo, Date.now(), workflowMode);
      await storage.putRun(run);
      runs.push(run);
    }
  }
  return runs;
}

async function loadMemberRuns(
  storage: StorageDriver,
  runIds: string[]
): Promise<Run[]> {
  const runs = await Promise.all(runIds.map((runId) => storage.getRun(runId)));
  if (runs.some((run) => run === null)) {
    throw new Error(
      "This batch references a missing run. Recovery stopped before provider dispatch."
    );
  }
  return runs as Run[];
}

async function ensureQueuedMemberApprovals(
  storage: StorageDriver,
  execution: BatchExecution
): Promise<void> {
  if (execution.concurrency !== DURABLE_BATCH_CONCURRENCY) {
    throw new Error("The durable batch does not use the server-owned concurrency limit.");
  }
  const approvalExpiresAt =
    batchApprovalStartedAt(execution) + BATCH_APPROVAL_LIFETIME_MS;
  if (approvalExpiresAt <= Date.now()) {
    throw new Error(
      "The original batch admission window expired before provider dispatch."
    );
  }
  for (const member of execution.members) {
    if (member.state !== "queued") continue;
    const run = await storage.getRun(member.runId);
    if (!run) throw new Error(`Run ${member.runId} was not found.`);
    const lamp = batchExecutionMode(execution) === "lamp";
    const reusable = lamp
      ? hasReusableLampApproval(run, "batch", execution.batchId)
      : hasReusableFirstCutApproval(run, "batch", execution.batchId);
    if (
      reusable &&
      run.spendApproval?.approvedAt === batchApprovalStartedAt(execution) &&
      run.spendApproval.expiresAt === approvalExpiresAt
    ) {
      continue;
    }
    const updated = await storage.putCanonicalRunSource(
      run.id,
      run.originalVideo,
      createSpendApproval(
        run.originalVideo,
        "batch",
        execution.batchId,
        batchApprovalStartedAt(execution),
        batchApprovalScope(batchExecutionMode(execution))
      )
    );
    if (!updated) {
      throw new Error(`Run ${run.id} disappeared while spend approval was saved.`);
    }
  }
}

async function rearmPausedLampBatch(
  storage: StorageDriver,
  execution: BatchExecution
): Promise<BatchExecution> {
  const candidate = requeueLampBatchExecutionAfterApproval(execution);
  const advanced = await storage.advanceBatchExecution(
    candidate,
    execution.revision
  );
  if (advanced.advanced && advanced.execution) return advanced.execution;
  const current = advanced.execution;
  if (
    current?.executionId === execution.executionId &&
    (current.status === "queued" || current.status === "running")
  ) {
    return current;
  }
  throw new Error(
    "The Lamp batch approval changed concurrently; retry the same confirmation."
  );
}

async function advanceReadyBatch(
  storage: StorageDriver,
  batch: Batch,
  execution?: BatchExecution
): Promise<{ batch: Batch; resumed: boolean }> {
  const selectedRunIds = execution
    ? execution.members.map((member) => member.runId)
    : batch.runIds;
  const candidate: Batch = {
    ...batch,
    runIds: selectedRunIds,
    concurrency: execution?.concurrency ?? DURABLE_BATCH_CONCURRENCY,
    status: "running",
    budgetUsd: execution
      ? microsToUsd(execution.budgetLimitMicros)
      : batch.budgetUsd,
    updatedAt: Date.now(),
  };
  const transition = await storage.advanceBatch(candidate, "ready");
  if (transition.advanced) return { batch: transition.batch, resumed: false };
  if (
    transition.batch?.status === "running" ||
    transition.batch?.status === "done"
  ) {
    return { batch: transition.batch, resumed: true };
  }
  throw new Error(
    "The batch changed while it was starting. Reload its durable state before trying again."
  );
}

async function serverOwnedResponse(
  storage: StorageDriver,
  batch: Batch,
  execution: BatchExecution,
  resumed: boolean
): Promise<NextResponse> {
  const runs = await loadMemberRuns(
    storage,
    execution.members.map((member) => member.runId)
  );
  return NextResponse.json({
    ok: true,
    resumed,
    executionOwner: "server" as const,
    batch,
    execution: summarizeBatchExecution(execution),
    runs,
  });
}

function browserMockResponse(
  batch: Batch,
  runs: Run[],
  resumed: boolean
): NextResponse {
  return NextResponse.json({
    ok: true,
    resumed,
    executionOwner: "browser_mock" as const,
    execution: null,
    batch,
    runs,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const validationError = validateBody(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const liveConfigured = hasGeminiKey();
  if (body.approveLiveSpend === true && !liveConfigured) {
    return NextResponse.json(
      { error: "Gemini video generation is not configured." },
      { status: 503 }
    );
  }
  if (
    body.approveLiveSpend === true &&
    normalizedWorkflowMode(body.workflowMode as WorkflowMode | undefined) ===
      "lamp"
  ) {
    // Refuse admission while the V2 sync stack is misconfigured — otherwise
    // every audio-bearing member fails after both paid generations.
    const syncIssue = v2SyncConfigIssue();
    if (syncIssue) {
      return NextResponse.json(
        { error: `Lamp's final sync verification is not configured: ${syncIssue}` },
        { status: 503 }
      );
    }
  }
  const storage = getStorage();
  const batches = await storage.getBatches();
  const existing = batches.find((batch) => batch.id === body.batchId);
  if (!existing) {
    return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  }
  const requestedMode = normalizedWorkflowMode(
    body.workflowMode as WorkflowMode | undefined
  );
  const persistedMode = normalizedWorkflowMode(existing.workflowMode);
  if (requestedMode !== persistedMode) {
    return NextResponse.json(
      {
        error:
          "The requested workflow mode does not match this durable batch. Reload before starting it.",
      },
      { status: 409 }
    );
  }
  if (existing.status === "failed") {
    return NextResponse.json(
      { error: "This failed upload batch cannot be restarted automatically." },
      { status: 409 }
    );
  }
  if (
    existing.status === "uploading" &&
    body.allowIncompleteUploads !== true
  ) {
    return NextResponse.json(
      { error: "This batch is still preparing uploads." },
      { status: 409 }
    );
  }

  try {
    let existingExecution = await storage.getBatchExecution(existing.id);

    // Flora may continue only where Flora work already started: a durable
    // Flora execution, or a running/done record recovering a lost response.
    // A never-started Flora draft must be recreated as Lamp.
    const floraContinuationMode = existingExecution
      ? batchExecutionMode(existingExecution)
      : existing.status === "running" || existing.status === "done"
        ? persistedMode
        : null;
    if (floraRetiredForNewWork(requestedMode, floraContinuationMode)) {
      return NextResponse.json(
        { error: FLORA_RETIRED_BATCH_ERROR },
        { status: 410 }
      );
    }

    if (liveConfigured && body.approveLiveSpend !== true) {
      return NextResponse.json(
        {
          error:
            "Starting or recovering this live batch requires explicit confirmation. Browser fallback is disabled when the provider is configured.",
        },
        { status: 403 }
      );
    }

    // Lost-response recovery after the trusted start transition. A queued
    // server execution is repaired and re-enqueued; running/terminal records
    // are simply returned and never restart paid work.
    if (existing.status === "running" || existing.status === "done") {
      if (existingExecution) {
        if (existingExecution.status === "user_action_required") {
          existingExecution = await rearmPausedLampBatch(
            storage,
            existingExecution
          );
        }
        if (existingExecution.status === "queued") {
          await ensureQueuedMemberApprovals(storage, existingExecution);
        }
        // This is intentionally unconditional. Queued executions get a safe
        // non-paid Workflow contender, running ones are a no-op, and terminal
        // executions repair a lost final Batch running -> done transition.
        const launch = await enqueueBatchExecution(existing.id);
        const durableExecution =
          (await storage.getBatchExecution(existing.id)) ?? launch.execution;
        const durableBatch =
          (await storage.getBatches()).find(
            (batch) => batch.id === existing.id
          ) ?? existing;
        return serverOwnedResponse(
          storage,
          durableBatch,
          durableExecution,
          true
        );
      }
      if (liveConfigured) {
        return NextResponse.json(
          {
            error:
              "This legacy running batch has no durable dispatcher claim. It was left untouched to avoid replaying provider work.",
          },
          { status: 409 }
        );
      }
      return browserMockResponse(
        existing,
        await loadMemberRuns(storage, existing.runIds),
        true
      );
    }

    let startableBatch = existing;
    let preparedRuns = await canonicalizeReadyRuns(
      storage,
      startableBatch,
      persistedMode
    );
    if (startableBatch.status === "uploading") {
      // An interrupted browser upload may leave a durable mix of ready and
      // unfinished members. The explicit caller flag freezes the ready subset
      // before spend planning; later upload receipts can survive as prepared
      // standalone runs, but can never widen this confirmed batch.
      const readyCandidate: Batch = {
        ...startableBatch,
        runIds: preparedRuns.map((run) => run.id),
        status: "ready",
        updatedAt: Date.now(),
      };
      const transition = await storage.advanceBatch(
        readyCandidate,
        "uploading"
      );
      if (!transition.batch || transition.batch.status !== "ready") {
        throw new Error(
          "The interrupted upload changed while its ready members were being frozen."
        );
      }
      startableBatch = transition.batch;
      if (!transition.advanced) {
        // A concurrent explicit start may have frozen the same batch first.
        // Rebuild from that winning ordered subset before creating approvals.
        preparedRuns = await canonicalizeReadyRuns(
          storage,
          startableBatch,
          persistedMode
        );
      }
    }
    const preparedBatch: Batch = {
      ...startableBatch,
      workflowMode: persistedMode,
      runIds: preparedRuns.map((run) => run.id),
      concurrency: DURABLE_BATCH_CONCURRENCY,
      budgetUsd:
        typeof body.budgetUsd === "number"
          ? body.budgetUsd
          : existing.budgetUsd,
      updatedAt: Date.now(),
    };

    if (!liveConfigured) {
      const started = await advanceReadyBatch(storage, preparedBatch);
      const racingExecution = await storage.getBatchExecution(existing.id);
      if (racingExecution) {
        return serverOwnedResponse(
          storage,
          started.batch,
          racingExecution,
          true
        );
      }
      return browserMockResponse(started.batch, preparedRuns, started.resumed);
    }

    const execution = await prepareBatchExecution(preparedBatch);
    await ensureQueuedMemberApprovals(storage, execution);
    const started = await advanceReadyBatch(storage, preparedBatch, execution);
    const launch = await enqueueBatchExecution(existing.id);
    return serverOwnedResponse(
      storage,
      started.batch,
      launch.execution,
      started.resumed || existingExecution !== null
    );
  } catch (error) {
    console.error(
      "[batches/start] durable start failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      {
        error:
          "The batch state was saved, but durable dispatch could not be confirmed. Retry this same confirmation; existing claims and provider work will not be repeated.",
      },
      { status: 502 }
    );
  }
}
