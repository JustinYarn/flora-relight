/**
 * /api/runs — dumb persistence for run state.
 *
 * GET    → paginated compact runs (frame pixels omitted) + batches on page 1
 * GET ?id=<runId> → one full run, including judged frame pixels
 * PUT    → body { run: Run } — upsert one run's JSON (client store is the
 *          in-session source of truth and pushes here after mutations).
 * DELETE → ?id=<runId> — permanently removes the run and its entire media
 *          folder (source, generated videos, anchors, exports). Irreversible;
 *          the UI owns the confirmation step.
 */

import { NextRequest, NextResponse } from "next/server";
import type {
  Batch,
  FrameSample,
  HumanCheckGrade,
  HumanGrade,
  ProviderOperation,
  Run,
  RunExecution,
  VideoAsset,
} from "@/lib/types";
import { isValidRunId } from "@/lib/server/runstore";
import {
  getStorage,
  type PaidOperationCostEntry,
  type RunPageCursor,
} from "@/lib/server/storage";
import { buildRun } from "@/lib/run-factory";
import {
  createSpendApproval,
  hasReusableFirstCutApproval,
} from "@/lib/server/spend-approval";
import { estimateFirstCut, estimateRun } from "@/lib/cost";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { initialMegaPrompt } from "@/lib/prompts/mega-prompt";
import { readCanonicalIngestByRunId } from "@/lib/server/ingest";
import { hasGeminiKey } from "@/lib/server/gemini";
import { enqueueRunExecution } from "@/lib/server/run-execution-coordinator";
import { summarizeBatchExecution } from "@/lib/server/batch-execution-view";
import { runExecutionInputHash } from "@/lib/server/run-execution-input";
import {
  BlobDeletionIncompleteError,
  LegacyPublicMediaDeletionError,
} from "@/lib/server/storage/blob-driver";
import { ActiveRunDeletionError } from "@/lib/server/storage/run-deletion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 25;
const SAFE_RESPONSE_BYTES = 3_500_000;
const MAX_GRADE_NOTE_LENGTH = 4_000;
const MAX_GRADE_OVERALL_NOTE_LENGTH = 8_000;
const HUMAN_GRADE_SCALE: Record<
  HumanCheckGrade["points"],
  Pick<HumanCheckGrade, "score" | "verdict">
> = {
  1: { score: 30, verdict: "fail" },
  2: { score: 55, verdict: "fail" },
  3: { score: 72, verdict: "borderline" },
  4: { score: 85, verdict: "pass" },
  5: { score: 95, verdict: "pass" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the final grade as strictly as the autosaved draft. */
function parseHumanGrade(value: unknown): HumanGrade | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.gradedAt) ||
    (value.gradedAt as number) < 0 ||
    typeof value.shipIt !== "boolean" ||
    !isRecord(value.scores) ||
    Object.keys(value.scores).length !== EVAL_DEFS.length ||
    (value.overallNote !== undefined &&
      (typeof value.overallNote !== "string" ||
        value.overallNote.length > MAX_GRADE_OVERALL_NOTE_LENGTH))
  ) {
    return null;
  }

  const scores: Record<string, HumanCheckGrade> = {};
  for (const definition of EVAL_DEFS) {
    const candidate = value.scores[definition.id];
    if (!isRecord(candidate)) return null;
    const points = candidate.points;
    if (!Number.isInteger(points) || (points as number) < 1 || (points as number) > 5) {
      return null;
    }
    const canonical = HUMAN_GRADE_SCALE[points as HumanCheckGrade["points"]];
    if (
      candidate.score !== canonical.score ||
      candidate.verdict !== canonical.verdict ||
      (candidate.note !== undefined &&
        (typeof candidate.note !== "string" ||
          candidate.note.length > MAX_GRADE_NOTE_LENGTH))
    ) {
      return null;
    }
    scores[definition.id] = {
      points: points as HumanCheckGrade["points"],
      ...canonical,
      ...(typeof candidate.note === "string" && candidate.note.length > 0
        ? { note: candidate.note }
        : {}),
    };
  }

  return {
    gradedAt: value.gradedAt as number,
    scores,
    shipIt: value.shipIt,
    ...(typeof value.overallNote === "string" && value.overallNote.length > 0
      ? { overallNote: value.overallNote }
      : {}),
  };
}

async function enqueueFirstCut(run: Run) {
  const approval = run.spendApproval;
  if (!approval) throw new Error("Live spend approval was not persisted.");
  const existingExecution = await getStorage().getRunExecution(run.id);
  return enqueueRunExecution({
    runId: run.id,
    // Execution identity is stable across a fresh user confirmation that only
    // renews an expired approval. The approval remains the operation's spend
    // authority, but it must not strand an already-persisted queued execution.
    executionId: existingExecution?.executionId ?? `first-cut:${run.id}`,
    source: "single",
  });
}

function compactFrame(frame: FrameSample): FrameSample {
  return { timestampSec: frame.timestampSec };
}

/**
 * List/grade/library views need run facts and media URLs, not dozens of
 * embedded JPEG data URLs. Keeping pixels out of list responses is the main
 * payload win; the full document remains available through GET ?id=.
 */
function compactRun(run: Run): Run {
  return {
    ...run,
    _compact: true,
    iterations: run.iterations.map((iteration) => ({
      ...iteration,
      // Mock runs may carry the relit keyframe as an embedded data URL. Live
      // runs carry a small served URL, which is safe and useful to retain.
      relitKeyframeDataUrl: iteration.relitKeyframeDataUrl?.startsWith("data:")
        ? undefined
        : iteration.relitKeyframeDataUrl,
      beforeFrames: iteration.beforeFrames.map(compactFrame),
      afterFrames: iteration.afterFrames.map(compactFrame),
    })),
  };
}

function compactBatches(batches: Batch[]): Batch[] {
  return batches.map((batch) =>
    batch.status === "uploading" || batch.status === "ready"
      ? batch
      : { ...batch, uploads: undefined }
  );
}

function restoreFramePixels(compact: FrameSample[], full: FrameSample[]): FrameSample[] {
  return compact.map((frame) => {
    if (frame.dataUrl) return frame;
    const archived = full.find((candidate) => candidate.timestampSec === frame.timestampSec);
    return archived?.dataUrl ? archived : frame;
  });
}

/**
 * A compact record may still be mutated by a Library/Review action. Merge the
 * omitted pixel evidence back from the stored document before replacing it.
 */
function expandCompactRun(candidate: Run, current: Run | null): Run {
  const clean: Run = { ...candidate };
  delete clean._compact;
  if (!candidate._compact || !current) return clean;
  return {
    ...clean,
    iterations: clean.iterations.map((iteration) => {
      const archived = current.iterations.find((item) => item.index === iteration.index);
      if (!archived) return iteration;
      return {
        ...iteration,
        relitKeyframeDataUrl:
          iteration.relitKeyframeDataUrl ?? archived.relitKeyframeDataUrl,
        beforeFrames: restoreFramePixels(iteration.beforeFrames, archived.beforeFrames),
        afterFrames: restoreFramePixels(iteration.afterFrames, archived.afterFrames),
      };
    }),
  };
}

/** The provider trust marker is a read-model field, never browser-owned. */
function clearProviderTrustMarkers(run: Run): void {
  for (const iteration of run.iterations) {
    delete iteration.recoveredFromProviderOperation;
  }
}

/** Remove every new real-artifact claim before restoring trusted stored data. */
function stripIncomingUnverifiedRealArtifacts(run: Run): void {
  for (const iteration of run.iterations) {
    if (iteration.generatedVideo && !iteration.generatedVideo.simulatedFilter) {
      iteration.generatedVideo = undefined;
    }
  }
  if (run.finalVideo && !run.finalVideo.simulatedFilter) {
    run.finalVideo = undefined;
  }
}

/**
 * Preserve legacy real-artifact links already on disk while refusing changes
 * to them from a browser snapshot. Journal-backed artifacts are reconstructed
 * separately below; mock simulated artifacts remain browser presentation data.
 */
function restoreStoredLegacyArtifacts(candidate: Run, current: Run): void {
  const completedIndexes = new Set(
    (current.providerOperations ?? [])
      .filter((operation) => operation.status === "completed" && operation.result)
      .map((operation) => operation.iteration)
  );
  const candidateByIndex = new Map(
    candidate.iterations.map((iteration) => [iteration.index, iteration])
  );
  for (const archived of current.iterations) {
    if (completedIndexes.has(archived.index)) continue;
    if (!archived.generatedVideo || archived.generatedVideo.simulatedFilter) continue;
    const incoming = candidateByIndex.get(archived.index);
    if (!incoming) {
      candidate.iterations.push({
        ...archived,
        recoveredFromProviderOperation: undefined,
      });
      continue;
    }
    incoming.generatedVideo = archived.generatedVideo;
  }
  if (current.finalVideo && !current.finalVideo.simulatedFilter) {
    candidate.finalVideo = current.finalVideo;
  }
}

function mergeServerGeneratedVideos(
  candidate: Run,
  current: Run | null,
  operations: ProviderOperation[] | undefined
): void {
  for (const operation of operations ?? []) {
    if (operation.status !== "completed" || !operation.result) continue;
    const archived = current?.iterations.find(
      (iteration) => iteration.index === operation.iteration
    );
    let iteration = candidate.iterations.find(
      (item) => item.index === operation.iteration
    );
    if (!iteration) {
      if (archived) {
        iteration = {
          ...archived,
          generatedVideo: undefined,
          recoveredFromProviderOperation: undefined,
        };
        candidate.iterations.push(iteration);
      } else {
        const recoveredPrompt = initialMegaPrompt();
        recoveredPrompt.version = operation.iteration;
        if (operation.renderedPrompt) {
          recoveredPrompt.rendered = operation.renderedPrompt;
        }
        iteration = {
          index: operation.iteration,
          megaPrompt: recoveredPrompt,
          beforeFrames: [],
          afterFrames: [],
          evalResults: [],
          status: "running",
          recoveredFromProviderOperation: true,
        };
        candidate.iterations.push(iteration);
      }
    }
    iteration.interactionId =
      operation.providerInteractionId ?? archived?.interactionId ?? iteration.interactionId;
    // The provider journal is authoritative for the actual artifact. Browser
    // snapshots cannot substitute a URL, duration, or dimensions.
    iteration.generatedVideo = {
      id: `generated-${operation.iteration}`,
      kind: "generated",
      url: operation.result.videoUrl,
      label: `Omni Flash v${operation.iteration}`,
      durationSec: operation.result.durationSec,
      width: candidate.originalVideo.width,
      height: candidate.originalVideo.height,
      hasAudio: candidate.originalVideo.hasAudio,
      simulatedFilter: undefined,
    };
    iteration.recoveredFromProviderOperation = true;
  }
  candidate.iterations.sort((a, b) => a.index - b.index);
}

function firstCutProviderOperation(run: Run): ProviderOperation | undefined {
  return run.providerOperations?.find(
    (operation) =>
      operation.kind === "video_generation" && operation.iteration === 1
  );
}

/** A durable execution may expose only the exact provider input it owns. */
function providerOperationMatchesExecution(
  operation: ProviderOperation,
  execution: RunExecution
): boolean {
  return (
    operation.kind === "video_generation" &&
    operation.iteration === 1 &&
    operation.renderedPrompt === execution.renderedPrompt &&
    execution.inputHash === runExecutionInputHash(execution.renderedPrompt)
  );
}

function mergeCost(
  candidate: Run["cost"],
  current: Run["cost"]
): Run["cost"] {
  if (!candidate) return current;
  if (!current) return candidate;
  const items = new Map<string, NonNullable<Run["cost"]>["items"][number]>();
  for (const item of [...current.items, ...candidate.items]) {
    const key = `${item.estimated ? "estimate" : "actual"}:${item.label}`;
    items.set(key, item);
  }
  const mergedItems = Array.from(items.values());
  return {
    estimatedUsd: Math.max(candidate.estimatedUsd, current.estimatedUsd),
    actualUsd: mergedItems
      .filter((item) => !item.estimated)
      .reduce((sum, item) => sum + item.usd, 0),
    items: mergedItems,
  };
}

/**
 * Provider operation results are the server-owned recovery journal. Derive
 * their generated asset and actual cost into every read so a stale browser
 * snapshot cannot make a completed background artifact disappear from the UI.
 */
function paidCostLabel(entry: PaidOperationCostEntry): string {
  if (entry.kind === "manifest") return "Scene manifest extraction (Gemini)";
  if (entry.kind === "anchor") {
    return `Look Anchor relight v${entry.iteration ?? 1} (Gemini image edit)`;
  }
  const evalName =
    EVAL_DEFS.find((definition) => definition.id === entry.evalId)?.name ??
    entry.evalId ??
    "Unknown check";
  return `${evalName} — ${entry.provider} judge (v${entry.iteration ?? 1})`;
}

function materializeServerResults(
  run: Run,
  paidCosts: PaidOperationCostEntry[] = [],
  execution?: RunExecution | null
): Run {
  const materialized: Run = {
    ...run,
    iterations: run.iterations.map((iteration) => ({ ...iteration })),
    cost: run.cost
      ? { ...run.cost, items: [...run.cost.items] }
      : undefined,
  };
  clearProviderTrustMarkers(materialized);
  const firstCutOperation = firstCutProviderOperation(materialized);
  const executionBindingMismatch = Boolean(
    execution &&
      (execution.inputHash !== runExecutionInputHash(execution.renderedPrompt) ||
        (firstCutOperation &&
          !providerOperationMatchesExecution(firstCutOperation, execution)))
  );
  const durableExecution = executionBindingMismatch
    ? {
        ...execution!,
        status: "reconcile_required" as const,
        error:
          "The completed provider artifact does not match this execution's immutable input. Manual reconciliation is required.",
      }
    : execution;
  if (execution) {
    // A server-owned execution reconstructs real media only from its matching
    // provider journal. Never let an archived browser/legacy URL fill this gap.
    for (const iteration of materialized.iterations) {
      if (iteration.generatedVideo && !iteration.generatedVideo.simulatedFilter) {
        iteration.generatedVideo = undefined;
      }
    }
  }
  const artifactOperations = execution
    ? materialized.providerOperations?.filter(
        (operation) =>
          operation.kind !== "video_generation" ||
          operation.iteration !== 1 ||
          providerOperationMatchesExecution(operation, execution)
      )
    : materialized.providerOperations;
  mergeServerGeneratedVideos(
    materialized,
    materialized,
    artifactOperations
  );
  // A live finalVideo was only a browser-created alias of the already-remuxed
  // generation. Prefer the exact journal-backed URL the trust marker proves.
  if (
    materialized.providerOperations?.some(
      (operation) => operation.status === "completed" && operation.result
    )
  ) {
    materialized.finalVideo = undefined;
  }
  const actualItems: NonNullable<Run["cost"]>["items"] = paidCosts.map(
    (entry) => ({
      label: paidCostLabel(entry),
      usd: entry.costUsd,
      estimated: false,
    })
  );
  for (const operation of materialized.providerOperations ?? []) {
    if (operation.status !== "completed" || !operation.result) continue;
    const label = `Video generation v${operation.iteration} (${operation.result.durationSec.toFixed(1)}s, Omni Flash)`;
    if (!actualItems.some((item) => item.label === label)) {
      actualItems.push({
        label,
        usd: operation.result.costUsd,
        estimated: false,
      });
    }
  }
  if (actualItems.length > 0) {
    const estimatedItems = (materialized.cost?.items ?? []).filter(
      (item) => item.estimated
    );
    materialized.cost = {
      estimatedUsd:
        materialized.cost?.estimatedUsd ??
        estimateRun(materialized.originalVideo.durationSec).totalUsd,
      actualUsd: actualItems.reduce((sum, item) => sum + item.usd, 0),
      items: [...estimatedItems, ...actualItems],
    };
  }
  if (durableExecution) {
    const execution = durableExecution;
    const budgetSkipped = execution.error?.startsWith("BATCH_BUDGET_SKIPPED") === true;
    const firstCutEstimate = estimateFirstCut(
      materialized.originalVideo.durationSec
    );
    const confirmedItems = (materialized.cost?.items ?? []).filter(
      (item) => !item.estimated
    );
    materialized.serverExecution = execution;
    materialized.live = true;
    materialized.cost = {
      estimatedUsd: firstCutEstimate.totalUsd,
      actualUsd: confirmedItems.reduce((sum, item) => sum + item.usd, 0),
      items: [
        ...firstCutEstimate.items.map((item) => ({
          label: item.label,
          usd: item.usd,
          estimated: true,
        })),
        ...confirmedItems,
      ],
    };
    const reviewed =
      materialized.status === "approved" ||
      materialized.status === "needs-changes";
    if (!reviewed) {
      materialized.status =
        execution.status === "awaiting_review"
          ? "awaiting-review"
          : execution.status === "failed" ||
              execution.status === "reconcile_required"
            ? "failed"
            : "running";
    }

    const videoOperation = firstCutProviderOperation(materialized);
    if (execution.iteration >= 1) {
      let iteration = materialized.iterations.find((item) => item.index === 1);
      if (!iteration) {
        const megaPrompt = initialMegaPrompt();
        // RunExecution revision 1 binds the exact prompt bytes before any
        // Workflow contender can start. The provider journal is a secondary
        // replay record, not the source of truth for an as-yet queued run.
        megaPrompt.rendered = execution.renderedPrompt;
        iteration = {
          index: 1,
          megaPrompt,
          beforeFrames: [],
          afterFrames: [],
          evalResults: [],
          status: "running",
        };
        materialized.iterations.push(iteration);
        materialized.iterations.sort((a, b) => a.index - b.index);
      }
      if (
        execution.status === "awaiting_review" &&
        videoOperation?.status === "completed" &&
        videoOperation.result
      ) {
        iteration.status = "ungraded";
      } else if (
        execution.status === "failed" ||
        execution.status === "reconcile_required"
      ) {
        iteration.status = "failed";
      }
    }

    // This production cut is generation-to-human-grade only. Make every
    // skipped automated stage explicit rather than inheriting optimistic
    // browser state or presenting an unrun check as a pass.
    const skipped = [
      "manifest",
      "anchor",
      "anchor-gate",
      "conform",
      "sample",
      "eval-align",
      "eval-identity",
      "eval-skin",
      "eval-appearance",
      "eval-background",
      "eval-lighting-delta",
      "eval-lighting-anchor",
      "eval-motion",
      "eval-temporal",
      "eval-halluc",
      "ledger",
      "gate",
      "fallback",
    ];
    for (const nodeId of skipped) {
      materialized.nodeStates[nodeId] = {
        nodeId,
        status: "skipped",
        detail: "not run — first cut sent to human grading",
      };
    }
    const active =
      execution.status === "queued" || execution.status === "running";
    materialized.nodeStates.src = {
      nodeId: "src",
      status:
        execution.phase === "queued" && !budgetSkipped ? "queued" : "succeeded",
      detail: "canonical stored source",
    };
    materialized.nodeStates.ingest = {
      nodeId: "ingest",
      status:
        budgetSkipped
          ? "skipped"
          : execution.phase === "queued"
          ? "queued"
          : execution.phase === "preparing"
            ? "running"
            : "succeeded",
      detail: "server-owned media preparation",
    };
    materialized.nodeStates.compile = {
      nodeId: "compile",
      status: execution.iteration >= 1 ? "succeeded" : active ? "queued" : "skipped",
      detail: execution.iteration >= 1 ? "canonical first-cut brief" : undefined,
    };
    materialized.nodeStates.videogen = {
      nodeId: "videogen",
      status:
        budgetSkipped
          ? "skipped"
          : execution.status === "awaiting_review"
          ? "succeeded"
          : execution.status === "failed" || execution.status === "reconcile_required"
            ? "failed"
            : execution.phase === "video_generation" || execution.phase === "finalizing"
              ? "running"
              : "queued",
      detail:
        budgetSkipped
          ? "not started — batch budget cap"
          : execution.status === "reconcile_required"
          ? "provider outcome needs reconciliation"
          : execution.status === "awaiting_review"
            ? "canonical first cut ready"
            : "server Workflow owns this stage",
    };
    materialized.nodeStates.remux = {
      nodeId: "remux",
      status: execution.status === "awaiting_review" ? "succeeded" : "queued",
      detail:
        execution.status === "awaiting_review"
          ? "original audio finalized onto generated cut"
          : undefined,
    };
    materialized.nodeStates["eval-audio"] = {
      nodeId: "eval-audio",
      status:
        execution.status === "awaiting_review"
          ? videoOperation?.result?.audioVerified
            ? "succeeded"
            : "failed"
          : "queued",
      detail:
        execution.status === "awaiting_review"
          ? videoOperation?.result?.audioVerified
            ? "original audio verified"
            : "audio verification needs review"
          : undefined,
    };
    materialized.nodeStates.review = {
      nodeId: "review",
      status:
        reviewed
          ? "succeeded"
          : execution.status === "awaiting_review"
            ? "queued"
            : "idle",
      detail: reviewed ? materialized.review?.decision : "human grade required",
    };
    delete materialized.bestIterationIndex;
    delete materialized.finalVideo;
    delete materialized.fallback;

    const logKey = `server execution ${execution.executionId}`;
    if (!materialized.log.some((entry) => entry.message.includes(logKey))) {
      const safeExecutionError = execution.error
        ?.replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
      const message =
        budgetSkipped
          ? `${logKey}: skipped — batch budget reached before this clip was dispatched; actual spend $0.00`
          : execution.status === "awaiting_review"
          ? `${logKey}: canonical first cut generated and audio finalized; automated quality checks were not run — awaiting human grading`
          : execution.status === "reconcile_required"
            ? `${logKey}: provider outcome is ambiguous and requires reconciliation; no automatic retry will run`
            : execution.status === "failed"
              ? `${logKey}: durable first-cut execution stopped before a gradeable artifact was confirmed${safeExecutionError ? ` — ${safeExecutionError}` : ""}`
              : `${logKey}: durable server Workflow owns first-cut generation; this browser may close safely`;
      materialized.log.push({
        at: execution.updatedAt,
        nodeId: execution.status === "awaiting_review" ? "review" : "videogen",
        level:
          execution.status === "failed" || execution.status === "reconcile_required"
            ? "error"
            : "info",
        message,
      });
    }
  } else {
    delete materialized.serverExecution;
  }
  return materialized;
}

function encodeCursor(cursor: RunPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): RunPageCursor | undefined | null {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      !isValidRunId(value.id)
    ) {
      return null;
    }
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const storage = getStorage();

  const requestedId = req.nextUrl.searchParams.get("id");
  if (requestedId !== null) {
    if (!isValidRunId(requestedId)) {
      return NextResponse.json({ error: "Invalid run id." }, { status: 400 });
    }
    const [storedRun, paidCosts, execution] = await Promise.all([
      storage.getRun(requestedId),
      storage.listPaidOperationCosts(requestedId),
      storage.getRunExecution(requestedId),
    ]);
    const run = storedRun
      ? materializeServerResults(storedRun, paidCosts, execution)
      : null;
    if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    // Old records may contain several megabytes of frame data. Return it only
    // while comfortably below the platform response cap; otherwise preserve
    // access to every run fact/media URL through the compact representation.
    const fullBody = JSON.stringify({ run });
    const payload =
      Buffer.byteLength(fullBody, "utf8") <= 3_500_000
        ? { run, framesOmitted: false }
        : { run: compactRun(run), framesOmitted: true };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }

  const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
  const limit = Number.isSafeInteger(rawLimit)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, rawLimit))
    : DEFAULT_PAGE_SIZE;
  const cursor = decodeCursor(req.nextUrl.searchParams.get("cursor"));
  if (cursor === null) {
    return NextResponse.json({ error: "Invalid pagination cursor." }, { status: 400 });
  }

  const [page, batches, storedBatchExecutions] = await Promise.all([
    storage.listRunsPage(limit, cursor),
    cursor ? Promise.resolve(undefined) : storage.getBatches(),
    cursor ? Promise.resolve(undefined) : storage.listBatchExecutions(),
  ]);
  const compactBatchList = batches ? compactBatches(batches) : undefined;
  const batchExecutions = storedBatchExecutions?.map(summarizeBatchExecution);
  const runs = await Promise.all(
    page.runs.map(async (run) => {
      const [paidCosts, execution] = await Promise.all([
        storage.listPaidOperationCosts(run.id),
        storage.getRunExecution(run.id),
      ]);
      return compactRun(materializeServerResults(run, paidCosts, execution));
    })
  );
  let truncatedForBytes = false;
  while (
    runs.length > 1 &&
    Buffer.byteLength(
      JSON.stringify({
        runs,
        ...(compactBatchList ? { batches: compactBatchList } : {}),
        ...(batchExecutions ? { batchExecutions } : {}),
      }),
      "utf8"
    ) > SAFE_RESPONSE_BYTES
  ) {
    runs.pop();
    truncatedForBytes = true;
  }
  const last = runs.at(-1);
  const nextCursor =
    (page.hasMore || truncatedForBytes) && last
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : null;
  return NextResponse.json(
    {
      runs,
      ...(compactBatchList ? { batches: compactBatchList } : {}),
      ...(batchExecutions ? { batchExecutions } : {}),
      nextCursor,
      compact: true,
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } }
  );
}

/**
 * Create the durable run skeleton BEFORE the browser starts the engine. This
 * prevents a confirmed run from existing only in Zustand during the first
 * persistence debounce window.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { video?: unknown; approveLiveSpend?: unknown };
  try {
    body = (await req.json()) as {
      video?: unknown;
      approveLiveSpend?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const video = body.video as VideoAsset | undefined;
  if (
    !video ||
    typeof video !== "object" ||
    !isValidRunId(video.runId) ||
    typeof video.id !== "string" ||
    typeof video.label !== "string" ||
    video.label.length === 0 ||
    video.label.length > 500
  ) {
    return NextResponse.json(
      { error: "A server-ingested video id, label, and valid runId are required." },
      { status: 400 }
    );
  }
  if (
    body.approveLiveSpend !== undefined &&
    typeof body.approveLiveSpend !== "boolean"
  ) {
    return NextResponse.json(
      { error: "approveLiveSpend must be a boolean." },
      { status: 400 }
    );
  }
  if (body.approveLiveSpend === true && !hasGeminiKey()) {
    return NextResponse.json(
      { error: "Gemini video generation is not configured." },
      { status: 503 }
    );
  }

  const storage = getStorage();
  let ingest;
  try {
    ingest = await readCanonicalIngestByRunId(video.runId);
  } catch (error) {
    console.error(
      "[runs] canonical ingest read failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      { error: "The durable source video could not be verified." },
      { status: 409 }
    );
  }
  if (!ingest) {
    return NextResponse.json(
      { error: "No durable ingested source exists for this run id." },
      { status: 409 }
    );
  }
  const canonicalVideo: VideoAsset = {
    id: video.id,
    runId: ingest.runId,
    kind: "original",
    url: ingest.url,
    label: video.label,
    durationSec: ingest.durationSec,
    width: ingest.width,
    height: ingest.height,
    hasAudio: ingest.hasAudio,
  };
  const existing = await storage.getRun(video.runId);
  if (existing) {
    const existingFirstCutApproval = hasReusableFirstCutApproval(
      existing,
      "single"
    ) &&
      existing.originalVideo.runId === canonicalVideo.runId &&
      existing.originalVideo.url === canonicalVideo.url &&
      Math.abs(existing.originalVideo.durationSec - canonicalVideo.durationSec) <=
        0.001;
    const updated = await storage.putCanonicalRunSource(
      video.runId,
      canonicalVideo,
      body.approveLiveSpend === true && !existingFirstCutApproval
        ? createSpendApproval(
            canonicalVideo,
            "single",
            undefined,
            Date.now(),
            "first_cut"
          )
        : undefined
    );
    if (!updated) {
      return NextResponse.json(
        { error: "The run disappeared while its source was being verified." },
        { status: 409 }
      );
    }
    if (body.approveLiveSpend === true) {
      try {
        const launch = await enqueueFirstCut(updated);
        if (
          launch.execution.status === "failed" ||
          launch.execution.status === "reconcile_required"
        ) {
          return NextResponse.json(
            {
              error:
                launch.execution.status === "reconcile_required"
                  ? "This run has an unresolved provider outcome. It will not be billed again automatically; reconcile the existing attempt first."
                  : "This durable first-cut attempt already stopped and cannot be presented as newly started. Create a fresh run after reviewing its saved error.",
              run: { ...updated, serverExecution: launch.execution },
              execution: launch.execution,
            },
            { status: 409 }
          );
        }
        return NextResponse.json({
          ok: true,
          created: false,
          run: { ...updated, serverExecution: launch.execution },
          execution: launch.execution,
          serverOwned: true,
        });
      } catch (error) {
        console.error(
          "[runs] durable execution enqueue failed:",
          error instanceof Error ? error.message : error
        );
        return NextResponse.json(
          {
            error:
              "The run was saved, but its durable first-cut execution could not be enqueued. Retry this confirmation; paid operations will not be repeated.",
          },
          { status: 502 }
        );
      }
    }
    return NextResponse.json({ ok: true, created: false, run: updated });
  }
  const run = buildRun(canonicalVideo);
  if (body.approveLiveSpend === true) {
    run.spendApproval = createSpendApproval(
      canonicalVideo,
      "single",
      undefined,
      Date.now(),
      "first_cut"
    );
  }
  await storage.putRun(run);
  if (body.approveLiveSpend === true) {
    try {
      const launch = await enqueueFirstCut(run);
      if (
        launch.execution.status === "failed" ||
        launch.execution.status === "reconcile_required"
      ) {
        return NextResponse.json(
          {
            error:
              launch.execution.status === "reconcile_required"
                ? "This run has an unresolved provider outcome. It will not be billed again automatically; reconcile the existing attempt first."
                : "This durable first-cut attempt already stopped and cannot be presented as newly started. Create a fresh run after reviewing its saved error.",
            run: { ...run, serverExecution: launch.execution },
            execution: launch.execution,
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        {
          ok: true,
          created: true,
          run: { ...run, serverExecution: launch.execution },
          execution: launch.execution,
          serverOwned: true,
        },
        { status: 201 }
      );
    } catch (error) {
      console.error(
        "[runs] durable execution enqueue failed:",
        error instanceof Error ? error.message : error
      );
      return NextResponse.json(
        {
          error:
            "The run was saved, but its durable first-cut execution could not be enqueued. Retry this confirmation; paid operations will not be repeated.",
        },
        { status: 502 }
      );
    }
  }
  return NextResponse.json({ ok: true, created: true, run }, { status: 201 });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const run = (body as { run?: unknown })?.run;
  if (!run || typeof run !== "object") {
    return NextResponse.json({ error: "Expected body { run }." }, { status: 400 });
  }
  const candidate = run as Run;
  if (!isValidRunId(candidate.id)) {
    return NextResponse.json(
      { error: "run.id must match [a-z0-9_-] (1-64 chars)." },
      { status: 400 }
    );
  }
  if (typeof candidate.createdAt !== "number") {
    return NextResponse.json(
      { error: "run.createdAt must be a number." },
      { status: 400 }
    );
  }

  const storage = getStorage();
  const current = await storage.getRun(candidate.id);
  if (!current) {
    return NextResponse.json(
      { error: "Create a run from a verified ingest before saving run state." },
      { status: 409 }
    );
  }
  const persisted = expandCompactRun(candidate, current);
  // Read-model only. Durable execution lives in the separate CAS record.
  delete persisted.serverExecution;
  persisted.originalVideo = current.originalVideo;
  persisted.providerOperations = current.providerOperations;
  clearProviderTrustMarkers(persisted);
  stripIncomingUnverifiedRealArtifacts(persisted);
  restoreStoredLegacyArtifacts(persisted, current);
  mergeServerGeneratedVideos(persisted, current, persisted.providerOperations);
  if (
    persisted.providerOperations?.some(
      (operation) => operation.status === "completed" && operation.result
    )
  ) {
    persisted.finalVideo = undefined;
  }
  // These fields are server-owned. A browser snapshot can neither forge nor
  // erase them; dedicated atomic methods are their only write path.
  persisted.humanGrade = current.humanGrade;
  persisted.spendApproval = current.spendApproval;
  persisted.cost = mergeCost(candidate.cost, current.cost);
  await storage.putRun(persisted);
  return NextResponse.json({ ok: true, id: candidate.id });
}

/**
 * Persist the human grade against the server's full run document. Grade pages
 * hydrate compact records (without embedded frame pixels), so a normal whole-
 * run PUT from that page would accidentally erase the archived judge frames.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!isValidRunId(id)) {
    return NextResponse.json({ error: "Invalid run id." }, { status: 400 });
  }
  let body: { humanGrade?: unknown; expectedGradedAt?: unknown };
  try {
    body = (await req.json()) as {
      humanGrade?: unknown;
      expectedGradedAt?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const grade = parseHumanGrade(body.humanGrade);
  const expectedGradedAt = body.expectedGradedAt;
  if (!grade) {
    return NextResponse.json({ error: "Invalid human grade." }, { status: 400 });
  }
  if (
    expectedGradedAt !== null &&
    (typeof expectedGradedAt !== "number" || !Number.isFinite(expectedGradedAt))
  ) {
    return NextResponse.json(
      { error: "expectedGradedAt must be the current timestamp or null." },
      { status: 400 }
    );
  }

  const storage = getStorage();
  const [current, execution] = await Promise.all([
    storage.getRun(id),
    storage.getRunExecution(id),
  ]);
  if (!current) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }
  const materialized = materializeServerResults(current, [], execution);
  const lastIteration = materialized.iterations.at(-1);
  const selectedIndex = materialized.bestIterationIndex;
  const shipped =
    selectedIndex === undefined
      ? lastIteration
      : materialized.iterations.find(
          (iteration) => iteration.index === selectedIndex
        ) ?? materialized.iterations[selectedIndex] ?? lastIteration;
  const shippedOperation = materialized.providerOperations?.find(
    (operation) =>
      operation.iteration === shipped?.index &&
      operation.status === "completed" &&
      operation.result?.videoUrl === shipped?.generatedVideo?.url
  );
  const executionOwnsArtifact = execution
    ? execution.status === "awaiting_review" &&
      shipped?.index === 1 &&
      shippedOperation !== undefined &&
      providerOperationMatchesExecution(shippedOperation, execution)
    : true;
  const canonicalArtifact =
    shipped?.recoveredFromProviderOperation === true &&
    shipped.generatedVideo !== undefined &&
    shippedOperation !== undefined &&
    executionOwnsArtifact;
  if (!canonicalArtifact) {
    return NextResponse.json(
      { error: "A completed server-verified relit video is required before grading." },
      { status: 409 }
    );
  }
  const result = await storage.putHumanGrade(id, grade, expectedGradedAt);
  if (!result.ok && !result.current) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }
  if (!result.ok) {
    const [paidCosts, freshExecution] = await Promise.all([
      storage.listPaidOperationCosts(id),
      storage.getRunExecution(id),
    ]);
    const conflictRun = materializeServerResults(
      result.current!,
      paidCosts,
      freshExecution
    );
    return NextResponse.json(
      {
        error: "This grade changed in another tab. Reload before saving again.",
        current: compactRun(conflictRun),
      },
      {
        status: 409,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      }
    );
  }
  const [paidCosts, freshExecution] = await Promise.all([
    storage.listPaidOperationCosts(id),
    storage.getRunExecution(id),
  ]);
  const savedRun = materializeServerResults(
    result.run,
    paidCosts,
    freshExecution
  );
  return NextResponse.json(
    { ok: true, run: compactRun(savedRun) },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } }
  );
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!isValidRunId(id)) {
    return NextResponse.json(
      { error: "id must match [a-z0-9_-] (1-64 chars)." },
      { status: 400 }
    );
  }
  try {
    const existed = await getStorage().deleteRun(id);
    return NextResponse.json({ ok: true, id, existed });
  } catch (err) {
    if (err instanceof ActiveRunDeletionError) {
      return NextResponse.json(
        {
          code: "RUN_ACTIVE",
          error:
            "This run still has generation work in progress or awaiting reconciliation. Let it settle before deleting it.",
        },
        {
          status: 409,
          headers: { "Cache-Control": "private, no-store, max-age=0" },
        }
      );
    }
    if (err instanceof LegacyPublicMediaDeletionError) {
      return NextResponse.json(
        {
          error:
            "This run still owns media in the retired public store. Migrate or delete those objects with the old store credentials before deleting the run.",
        },
        {
          status: 409,
          headers: { "Cache-Control": "private, no-store, max-age=0" },
        }
      );
    }
    if (err instanceof BlobDeletionIncompleteError) {
      return NextResponse.json(
        {
          error:
            "Run deletion did not complete. Its cleanup handles were preserved; retry when storage is available.",
        },
        {
          status: 503,
          headers: { "Cache-Control": "private, no-store, max-age=0" },
        }
      );
    }
    console.error(
      "[runs/delete] failed:",
      err instanceof Error ? err.name : "unknown_error"
    );
    return NextResponse.json(
      { error: "Run deletion failed. No successful deletion was recorded." },
      {
        status: 500,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      }
    );
  }
}
