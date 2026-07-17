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
  PaidOperation,
  ProviderOperation,
  Run,
  RunExecution,
  VideoAsset,
  WorkflowMode,
} from "@/lib/types";
import { isValidRunId } from "@/lib/server/runstore";
import {
  getStorage,
  type PaidOperationCostEntry,
  type RunPageCursor,
} from "@/lib/server/storage";
import { buildRun, freshNodeStates } from "@/lib/run-factory";
import { workflowForMode } from "@/lib/workflow-def";
import {
  createSpendApproval,
  hasReusableFirstCutApproval,
  hasReusableLampBackgroundPlanApproval,
  hasReusableLampBeautifyPlanApproval,
  hasReusableLampIrisPlanApproval,
  hasReusableLampApproval,
} from "@/lib/server/spend-approval";
import {
  estimateFirstCut,
  estimateLampBackgroundPlan,
  estimateLampBackgroundTwoPass,
  estimateLampBeautifyPlan,
  estimateLampBeautifyTwoPass,
  estimateLampIrisPlan,
  estimateLampIrisTwoPass,
  estimateLampRun,
  estimateRun,
} from "@/lib/cost";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { parseHumanGrade } from "@/lib/human-grade";
import { initialMegaPrompt } from "@/lib/prompts/mega-prompt";
import {
  createMockLampBackgroundCleanupPlan,
  hashLampBackgroundCleanupPlan,
  lampBackgroundPlanRequiresGeneration,
  parseLampBackgroundCleanupPlan,
  type LampBackgroundCleanupPlan,
} from "@/lib/lamp-background";
import {
  isLampBackgroundEvaluationArtifact,
  isLampBackgroundRun,
  lampBackgroundPromptForRun,
  projectLampBackgroundEvaluationForRead,
} from "@/lib/lamp-background-read";
import { LAMP_BACKGROUND_EVAL_IDS } from "@/lib/lamp-background-evaluation";
import {
  lampBackgroundEvaluationOperationId,
  lampBackgroundPlanOperationId,
} from "@/lib/lamp-background-operations";
import {
  compileLampBackgroundFinalPrompt,
  initialLampBackgroundMegaPrompt,
} from "@/lib/prompts/lamp-background";
import {
  isLampBackgroundPlanArtifact,
  runLampBackgroundPlanner,
} from "@/lib/server/lamp-background-planner";
import {
  createMockLampBeautifyPlan,
  hashLampBeautifyPlan,
  lampBeautifyPlanRequiresGeneration,
  lampBeautifyPlansDifferOnlyByIntensity,
  parseLampBeautifyPlan,
  type LampBeautifyPlan,
} from "@/lib/lamp-beautify";
import {
  isLampBeautifyEvaluationArtifact,
  isLampBeautifyRun,
  lampBeautifyPromptForRun,
  projectLampBeautifyEvaluationForRead,
} from "@/lib/lamp-beautify-read";
import {
  lampBeautifyEvaluationOperationId,
  lampBeautifyPlanOperationId,
} from "@/lib/lamp-beautify-operations";
import {
  compileLampBeautifyFinalPrompt,
  initialLampBeautifyMegaPrompt,
} from "@/lib/prompts/lamp-beautify";
import {
  isLampBeautifyPlanArtifact,
  runLampBeautifyPlanner,
} from "@/lib/server/lamp-beautify-planner";
import {
  createMockLampIrisPlan,
  hashLampIrisPlan,
  lampIrisPlanRequiresGeneration,
  lampIrisPlansDifferOnlyByIntensity,
  parseLampIrisPlan,
  type LampIrisPlan,
} from "@/lib/lamp-iris";
import {
  isLampIrisEvaluationArtifact,
  isLampIrisRun,
  lampIrisPromptForRun,
  projectLampIrisEvaluationForRead,
} from "@/lib/lamp-iris-read";
import { selectLampIrisDeliveredIteration } from "@/lib/lamp-iris-evaluation";
import {
  lampIrisEvaluationOperationId,
  lampIrisPlanOperationId,
} from "@/lib/lamp-iris-operations";
import {
  compileLampIrisFinalPrompt,
  initialLampIrisMegaPrompt,
} from "@/lib/prompts/lamp-iris";
import {
  isLampIrisPlanArtifact,
  runLampIrisPlanner,
} from "@/lib/server/lamp-iris-planner";
import {
  compileLampFinalPrompt,
  isLampEvaluationArtifact,
  LAMP_EVAL_IDS,
  lampEvaluationOperationId,
  projectLampEvaluationForRead,
  type LampEvaluationArtifact,
} from "@/lib/lamp-evaluation";
import { readCanonicalIngestByRunId } from "@/lib/server/ingest";
import { hasGeminiKey } from "@/lib/server/gemini";
import { v2SyncConfigIssue } from "@/lib/server/syncnet";
import { enqueueRunExecution } from "@/lib/server/run-execution-coordinator";
import { workflowRunLiveness } from "@/lib/server/dead-workflow-recovery";
import {
  FLORA_RETIRED_RUN_ERROR,
  floraRetiredForNewWork,
  runHasStartedWork,
  runWorkflowMode,
  workflowModeFromExecutionId,
  workflowModeLabel,
} from "@/lib/workflow-mode";
import { isArchivedLostGenerationId } from "@/lib/lost-interaction";
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
const ALL_EVAL_IDS = EVAL_DEFS.map((definition) => definition.id);

function persistedWorkflowMode(run: Run): WorkflowMode {
  return runWorkflowMode(run);
}

async function prepareLampBackgroundPlan(input: {
  run: Run;
  mock: boolean;
}): Promise<
  | { ok: true; run: Run; plan: LampBackgroundCleanupPlan }
  | { ok: false; status: number; message: string; run: Run }
> {
  const storage = getStorage();
  const failPlan = async (message: string): Promise<Run> => {
    const failed: Run = {
      ...input.run,
      status: "failed",
      nodeStates: {
        ...input.run.nodeStates,
        plan: {
          nodeId: "plan",
          status: "failed",
          detail: message,
        },
      },
      log: [
        ...input.run.log,
        {
          at: Date.now(),
          nodeId: "plan",
          level: "error",
          message,
        },
      ],
    };
    await storage.putRun(failed);
    return failed;
  };
  if (input.run.backgroundCleanupPlan) {
    try {
      const plan = parseLampBackgroundCleanupPlan(
        input.run.backgroundCleanupPlan
      );
      if (plan.runId !== input.run.id) {
        throw new Error("The saved cleanup plan belongs to a different run.");
      }
      return { ok: true, run: input.run, plan };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The saved Lamp Background plan is invalid.";
      return {
        ok: false,
        status: 409,
        message,
        run: await failPlan(message),
      };
    }
  }
  if (input.mock) {
    const plan = createMockLampBackgroundCleanupPlan(
      input.run.id,
      Date.now()
    );
    const updated = { ...input.run, backgroundCleanupPlan: plan };
    await storage.putRun(updated);
    return { ok: true, run: updated, plan };
  }
  let artifact;
  try {
    artifact = await runLampBackgroundPlanner(input.run.id);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Lamp Background planning could not be completed safely.";
    return {
      ok: false,
      status: 502,
      message,
      run: await failPlan(message),
    };
  }
  if (!isLampBackgroundPlanArtifact(artifact)) {
    const message = "Lamp Background planning returned an invalid artifact.";
    return {
      ok: false,
      status: 502,
      message,
      run: await failPlan(message),
    };
  }
  if (artifact.status !== "ready") {
    const message = artifact.reason;
    return {
      ok: false,
      status: artifact.status === "unsupported" ? 422 : 502,
      message,
      run: await failPlan(message),
    };
  }
  const updated = {
    ...input.run,
    backgroundCleanupPlan: artifact.plan,
    live: true,
  };
  await storage.putRun(updated);
  return { ok: true, run: updated, plan: artifact.plan };
}

async function prepareLampBeautifyPlan(input: {
  run: Run;
  mock: boolean;
}): Promise<
  | { ok: true; run: Run; plan: LampBeautifyPlan }
  | { ok: false; status: number; message: string; run: Run }
> {
  const storage = getStorage();
  const failPlan = async (message: string): Promise<Run> => {
    const failed: Run = {
      ...input.run,
      status: "failed",
      nodeStates: {
        ...input.run.nodeStates,
        plan: {
          nodeId: "plan",
          status: "failed",
          detail: message,
        },
      },
      log: [
        ...input.run.log,
        {
          at: Date.now(),
          nodeId: "plan",
          level: "error",
          message,
        },
      ],
    };
    await storage.putRun(failed);
    return failed;
  };
  if (input.run.beautifyPlan) {
    try {
      const plan = parseLampBeautifyPlan(input.run.beautifyPlan);
      if (plan.runId !== input.run.id) {
        throw new Error("The saved enhancement plan belongs to a different run.");
      }
      return { ok: true, run: input.run, plan };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The saved Lamp Beautify plan is invalid.";
      return {
        ok: false,
        status: 409,
        message,
        run: await failPlan(message),
      };
    }
  }
  if (input.mock) {
    const plan = createMockLampBeautifyPlan(input.run.id, Date.now());
    const updated = { ...input.run, beautifyPlan: plan };
    await storage.putRun(updated);
    return { ok: true, run: updated, plan };
  }
  let artifact;
  try {
    artifact = await runLampBeautifyPlanner(input.run.id);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Lamp Beautify planning could not be completed safely.";
    return {
      ok: false,
      status: 502,
      message,
      run: await failPlan(message),
    };
  }
  if (!isLampBeautifyPlanArtifact(artifact)) {
    const message = "Lamp Beautify planning returned an invalid artifact.";
    return {
      ok: false,
      status: 502,
      message,
      run: await failPlan(message),
    };
  }
  if (artifact.status !== "ready") {
    const message = artifact.reason;
    return {
      ok: false,
      status: artifact.status === "unsupported" ? 422 : 502,
      message,
      run: await failPlan(message),
    };
  }
  const updated = {
    ...input.run,
    beautifyPlan: artifact.plan,
    live: true,
  };
  await storage.putRun(updated);
  return { ok: true, run: updated, plan: artifact.plan };
}

async function prepareLampIrisPlan(input: {
  run: Run;
  mock: boolean;
}): Promise<
  | { ok: true; run: Run; plan: LampIrisPlan }
  | { ok: false; status: number; message: string; run: Run }
> {
  const storage = getStorage();
  const failPlan = async (message: string): Promise<Run> => {
    const failed: Run = {
      ...input.run,
      status: "failed",
      nodeStates: {
        ...input.run.nodeStates,
        plan: {
          nodeId: "plan",
          status: "failed",
          detail: message,
        },
      },
      log: [
        ...input.run.log,
        {
          at: Date.now(),
          nodeId: "plan",
          level: "error",
          message,
        },
      ],
    };
    await storage.putRun(failed);
    return failed;
  };
  if (input.run.irisPlan) {
    try {
      const plan = parseLampIrisPlan(input.run.irisPlan);
      if (plan.runId !== input.run.id) {
        throw new Error("The saved gaze plan belongs to a different run.");
      }
      return { ok: true, run: input.run, plan };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The saved Lamp Iris plan is invalid.";
      return {
        ok: false,
        status: 409,
        message,
        run: await failPlan(message),
      };
    }
  }
  if (input.mock) {
    const plan = createMockLampIrisPlan(input.run.id, Date.now());
    const updated = { ...input.run, irisPlan: plan };
    await storage.putRun(updated);
    return { ok: true, run: updated, plan };
  }
  let artifact;
  try {
    artifact = await runLampIrisPlanner(input.run.id);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Lamp Iris planning could not be completed safely.";
    return {
      ok: false,
      status: 502,
      message,
      run: await failPlan(message),
    };
  }
  if (!isLampIrisPlanArtifact(artifact)) {
    const message = "Lamp Iris planning returned an invalid artifact.";
    return {
      ok: false,
      status: 502,
      message,
      run: await failPlan(message),
    };
  }
  if (artifact.status !== "ready") {
    const message = artifact.reason;
    return {
      ok: false,
      status: artifact.status === "unsupported" ? 422 : 502,
      message,
      run: await failPlan(message),
    };
  }
  const updated = {
    ...input.run,
    irisPlan: artifact.plan,
    live: true,
  };
  await storage.putRun(updated);
  return { ok: true, run: updated, plan: artifact.plan };
}

async function enqueueSingleRun(run: Run, workflowMode: WorkflowMode) {
  const approval = run.spendApproval;
  if (!approval) throw new Error("Live spend approval was not persisted.");
  const existingExecution = await getStorage().getRunExecution(run.id);
  if (
    existingExecution &&
    (existingExecution.source !== "single" ||
      workflowModeFromExecutionId(existingExecution.executionId) !==
        workflowMode)
  ) {
    throw new Error(
      `A different durable workflow already owns this run; ${
        workflowModeLabel(workflowMode)
      } requires a fresh run id.`
    );
  }
  const backgroundPlan =
    workflowMode === "background" ? run.backgroundCleanupPlan : undefined;
  const beautifyPlan =
    workflowMode === "beautify" ? run.beautifyPlan : undefined;
  const beautifyPlanHash =
    beautifyPlan?.approval.status === "approved"
      ? await hashLampBeautifyPlan(beautifyPlan)
      : undefined;
  const beautifyRenderedPrompt =
    workflowMode === "beautify" &&
    beautifyPlan?.approval.status === "approved" &&
    lampBeautifyPlanRequiresGeneration(beautifyPlan)
      ? initialLampBeautifyMegaPrompt(beautifyPlan).rendered
      : undefined;
  const irisPlan =
    workflowMode === "iris" ? run.irisPlan : undefined;
  const irisPlanHash =
    irisPlan?.approval.status === "approved"
      ? await hashLampIrisPlan(irisPlan)
      : undefined;
  const irisRenderedPrompt =
    workflowMode === "iris" &&
    irisPlan?.approval.status === "approved" &&
    lampIrisPlanRequiresGeneration(irisPlan)
      ? initialLampIrisMegaPrompt(irisPlan).rendered
      : undefined;
  const approvedPlanHash =
    backgroundPlan?.approval.status === "approved"
      ? await hashLampBackgroundCleanupPlan(backgroundPlan)
      : undefined;
  const backgroundRenderedPrompt =
    workflowMode === "background" &&
    backgroundPlan?.approval.status === "approved" &&
    lampBackgroundPlanRequiresGeneration(backgroundPlan)
      ? initialLampBackgroundMegaPrompt(backgroundPlan).rendered
      : undefined;
  return enqueueRunExecution({
    runId: run.id,
    // Execution identity is stable across a fresh user confirmation that only
    // renews an expired approval. The approval remains the operation's spend
    // authority, but it must not strand an already-persisted queued execution.
    executionId:
      existingExecution?.executionId ??
      (workflowMode === "lamp"
        ? `lamp:${run.id}`
        : workflowMode === "background"
          ? `lamp-background:${run.id}`
          : workflowMode === "beautify"
            ? `lamp-beautify:${run.id}`
            : workflowMode === "iris"
              ? `lamp-iris:${run.id}`
              : `first-cut:${run.id}`),
    source: "single",
    ...(existingExecution?.renderedPrompt ||
    backgroundRenderedPrompt ||
    beautifyRenderedPrompt ||
    irisRenderedPrompt
      ? {
          renderedPrompt:
            existingExecution?.renderedPrompt ??
            backgroundRenderedPrompt ??
            beautifyRenderedPrompt ??
            irisRenderedPrompt!,
        }
      : {}),
    ...(workflowMode === "background"
      ? {
          planOperationId:
            existingExecution?.planOperationId ??
            lampBackgroundPlanOperationId(),
          approvedPlanHash:
            existingExecution?.approvedPlanHash ?? approvedPlanHash,
        }
      : {}),
    ...(workflowMode === "beautify"
      ? {
          planOperationId:
            existingExecution?.planOperationId ??
            lampBeautifyPlanOperationId(),
          approvedPlanHash:
            existingExecution?.approvedPlanHash ?? beautifyPlanHash,
        }
      : {}),
    ...(workflowMode === "iris"
      ? {
          planOperationId:
            existingExecution?.planOperationId ??
            lampIrisPlanOperationId(),
          approvedPlanHash:
            existingExecution?.approvedPlanHash ?? irisPlanHash,
        }
      : {}),
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
        const recoveredPrompt =
          persistedWorkflowMode(candidate) === "background" &&
          candidate.backgroundCleanupPlan
            ? (() => {
                const prompt = initialLampBackgroundMegaPrompt(
                  candidate.backgroundCleanupPlan
                );
                prompt.version = operation.iteration === 2 ? 2 : 1;
                if (operation.renderedPrompt) {
                  prompt.rendered = operation.renderedPrompt;
                }
                return lampBackgroundPromptForRun(prompt);
              })()
            : (() => {
                const prompt = initialMegaPrompt(
                  persistedWorkflowMode(candidate)
                );
                prompt.version = operation.iteration;
                if (operation.renderedPrompt) {
                  prompt.rendered = operation.renderedPrompt;
                }
                return prompt;
              })();
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
      operation.kind === "video_generation" &&
      operation.iteration === 1 &&
      !isArchivedLostGenerationId(operation.id)
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

interface LampEvaluationProjection {
  first: PaidOperation | null;
  final: PaidOperation | null;
}

interface LampBackgroundEvaluationProjection {
  plan: PaidOperation | null;
  planHash: string | null;
  first: PaidOperation | null;
  final: PaidOperation | null;
}

async function readLampEvaluationProjection(
  storage: ReturnType<typeof getStorage>,
  runId: string
): Promise<LampEvaluationProjection> {
  const [first, final] = await Promise.all([
    storage.getPaidOperation(runId, lampEvaluationOperationId(1)),
    storage.getPaidOperation(runId, lampEvaluationOperationId(2)),
  ]);
  return { first, final };
}

async function readLampBackgroundEvaluationProjection(
  storage: ReturnType<typeof getStorage>,
  runId: string
): Promise<LampBackgroundEvaluationProjection> {
  const [plan, first, final] = await Promise.all([
    storage.getPaidOperation(runId, lampBackgroundPlanOperationId()),
    storage.getPaidOperation(runId, lampBackgroundEvaluationOperationId(1)),
    storage.getPaidOperation(runId, lampBackgroundEvaluationOperationId(2)),
  ]);
  const planHash =
    plan?.status === "completed" &&
    isLampBackgroundPlanArtifact(plan.result) &&
    plan.result.status === "ready"
      ? await hashLampBackgroundCleanupPlan(plan.result.plan)
      : null;
  return { plan, planHash, first, final };
}

function lampArtifact(
  operation: PaidOperation | null,
  iteration: 1 | 2
): LampEvaluationArtifact | undefined {
  return operation?.status === "completed" &&
    isLampEvaluationArtifact(operation.result, iteration)
    ? operation.result
    : undefined;
}

function lampBackgroundArtifact(
  operation: PaidOperation | null,
  iteration: 1 | 2
) {
  return operation?.status === "completed" &&
    isLampBackgroundEvaluationArtifact(operation.result, iteration)
    ? operation.result
    : undefined;
}

function isLampExecution(execution: RunExecution | null | undefined): boolean {
  return Boolean(execution?.executionId.startsWith("lamp:"));
}

function isLampBackgroundExecution(
  execution: RunExecution | null | undefined
): boolean {
  return Boolean(execution?.executionId.startsWith("lamp-background:"));
}

function planContentForBinding(plan: LampBackgroundCleanupPlan): unknown {
  return {
    version: plan.version,
    id: plan.id,
    runId: plan.runId,
    createdAt: plan.createdAt,
    sourceScope: plan.sourceScope,
    decision: plan.decision,
    sceneSummary: plan.sceneSummary,
    remove: plan.remove,
    preserve: plan.preserve,
    uncertain: plan.uncertain,
    ...(plan.noOpJustification
      ? { noOpJustification: plan.noOpJustification }
      : {}),
  };
}

function lampBackgroundPlanBindingValid(
  run: Run,
  execution: RunExecution,
  evaluations: LampBackgroundEvaluationProjection
): boolean {
  try {
    const approvedPlan = parseLampBackgroundCleanupPlan(
      run.backgroundCleanupPlan
    );
    const planArtifact = evaluations.plan?.result;
    if (
      approvedPlan.approval.status !== "approved" ||
      !lampBackgroundPlanRequiresGeneration(approvedPlan) ||
      execution.planOperationId !== lampBackgroundPlanOperationId() ||
      typeof execution.approvedPlanHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(execution.approvedPlanHash) ||
      execution.approvedPlanHash !== evaluations.planHash ||
      evaluations.plan?.status !== "completed" ||
      !isLampBackgroundPlanArtifact(planArtifact) ||
      planArtifact.status !== "ready"
    ) {
      return false;
    }
    return (
      JSON.stringify(planContentForBinding(approvedPlan)) ===
      JSON.stringify(planContentForBinding(planArtifact.plan))
    );
  } catch {
    return false;
  }
}

function lampFinalPrompt(
  execution: RunExecution,
  evaluations: LampEvaluationProjection
) {
  const first = lampArtifact(evaluations.first, 1);
  if (!first) return undefined;
  return compileLampFinalPrompt(execution.renderedPrompt, first);
}

function lampBackgroundFinalPrompt(
  run: Run,
  execution: RunExecution,
  evaluations: LampBackgroundEvaluationProjection
) {
  const first = lampBackgroundArtifact(evaluations.first, 1);
  if (!first || !run.backgroundCleanupPlan) return undefined;
  return compileLampBackgroundFinalPrompt(
    execution.renderedPrompt,
    run.backgroundCleanupPlan,
    first
  );
}

interface LampBeautifyEvaluationProjection {
  plan: PaidOperation | null;
  planHash: string | null;
  first: PaidOperation | null;
  final: PaidOperation | null;
}

async function readLampBeautifyEvaluationProjection(
  storage: ReturnType<typeof getStorage>,
  runId: string
): Promise<LampBeautifyEvaluationProjection> {
  const [run, plan, first, final] = await Promise.all([
    storage.getRun(runId),
    storage.getPaidOperation(runId, lampBeautifyPlanOperationId()),
    storage.getPaidOperation(runId, lampBeautifyEvaluationOperationId(1)),
    storage.getPaidOperation(runId, lampBeautifyEvaluationOperationId(2)),
  ]);
  // The execution binds the hash of the plan AS APPROVED — the human
  // intensity dial may legitimately move it away from the journal draft, so
  // the read-side binding hashes the run's approved copy, and the draft is
  // compared modulo intensity in lampBeautifyPlanBindingValid.
  let planHash: string | null = null;
  if (
    plan?.status === "completed" &&
    isLampBeautifyPlanArtifact(plan.result) &&
    plan.result.status === "ready"
  ) {
    try {
      planHash =
        run?.beautifyPlan !== undefined
          ? await hashLampBeautifyPlan(parseLampBeautifyPlan(run.beautifyPlan))
          : await hashLampBeautifyPlan(plan.result.plan);
    } catch {
      planHash = null;
    }
  }
  return { plan, planHash, first, final };
}

function lampBeautifyArtifact(
  operation: PaidOperation | null,
  iteration: 1 | 2
) {
  return operation?.status === "completed" &&
    isLampBeautifyEvaluationArtifact(operation.result, iteration)
    ? operation.result
    : undefined;
}

function isLampBeautifyExecution(
  execution: RunExecution | null | undefined
): boolean {
  return Boolean(execution?.executionId.startsWith("lamp-beautify:"));
}

function lampBeautifyPlanBindingValid(
  run: Run,
  execution: RunExecution,
  evaluations: LampBeautifyEvaluationProjection
): boolean {
  try {
    const approvedPlan = parseLampBeautifyPlan(run.beautifyPlan);
    const planArtifact = evaluations.plan?.result;
    if (
      approvedPlan.approval.status !== "approved" ||
      !lampBeautifyPlanRequiresGeneration(approvedPlan) ||
      execution.planOperationId !== lampBeautifyPlanOperationId() ||
      typeof execution.approvedPlanHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(execution.approvedPlanHash) ||
      execution.approvedPlanHash !== evaluations.planHash ||
      evaluations.plan?.status !== "completed" ||
      !isLampBeautifyPlanArtifact(planArtifact) ||
      planArtifact.status !== "ready"
    ) {
      return false;
    }
    // The approved copy may differ from the journal draft only by the human
    // intensity dial — the same rule the server-side validator enforces.
    return lampBeautifyPlansDifferOnlyByIntensity(
      planArtifact.plan,
      approvedPlan
    );
  } catch {
    return false;
  }
}

function lampBeautifyFinalPrompt(
  run: Run,
  execution: RunExecution,
  evaluations: LampBeautifyEvaluationProjection
) {
  const first = lampBeautifyArtifact(evaluations.first, 1);
  if (!first || !run.beautifyPlan) return undefined;
  return compileLampBeautifyFinalPrompt(
    execution.renderedPrompt,
    run.beautifyPlan,
    first
  );
}

function providerOperationMatchesLampBeautifyExecution(
  operation: ProviderOperation,
  run: Run,
  execution: RunExecution,
  evaluations: LampBeautifyEvaluationProjection
): boolean {
  if (
    operation.kind !== "video_generation" ||
    !lampBeautifyPlanBindingValid(run, execution, evaluations)
  ) {
    return false;
  }
  if (operation.iteration === 1) {
    return (
      operation.renderedPrompt === execution.renderedPrompt &&
      execution.inputHash === runExecutionInputHash(execution.renderedPrompt)
    );
  }
  if (operation.iteration !== 2) return false;
  try {
    return (
      operation.renderedPrompt ===
      lampBeautifyFinalPrompt(run, execution, evaluations)?.rendered
    );
  } catch {
    return false;
  }
}

function mergeLampBeautifyEvaluationResults(
  candidate: Run,
  execution: RunExecution,
  evaluations: LampBeautifyEvaluationProjection,
  hideFinalEvaluation: boolean
): void {
  if (!candidate.beautifyPlan) return;
  const first = lampBeautifyArtifact(evaluations.first, 1);
  const final = lampBeautifyArtifact(evaluations.final, 2);
  const finalPrompt = final
    ? lampBeautifyFinalPrompt(candidate, execution, evaluations)
    : undefined;
  for (const iteration of candidate.iterations) {
    if (iteration.index === 1 && first) {
      const projection = projectLampBeautifyEvaluationForRead({
        iteration: 1,
        artifact: first,
        beautifyPlan: candidate.beautifyPlan,
        humanGradeSaved: candidate.humanGrade !== undefined,
      });
      iteration.evalResults = projection.evalResults;
      if (projection.composite) iteration.composite = projection.composite;
    }
    if (iteration.index === 2) {
      if (finalPrompt) {
        iteration.megaPrompt = lampBeautifyPromptForRun(finalPrompt);
      }
      const projection = projectLampBeautifyEvaluationForRead({
        iteration: 2,
        artifact: final,
        beautifyPlan: candidate.beautifyPlan,
        humanGradeSaved: candidate.humanGrade !== undefined,
        hideFinalEvaluation,
      });
      iteration.evalResults = projection.evalResults;
      if (projection.composite) iteration.composite = projection.composite;
    }
  }
}

interface LampIrisEvaluationProjection {
  plan: PaidOperation | null;
  planHash: string | null;
  first: PaidOperation | null;
  final: PaidOperation | null;
}

async function readLampIrisEvaluationProjection(
  storage: ReturnType<typeof getStorage>,
  runId: string
): Promise<LampIrisEvaluationProjection> {
  const [run, plan, first, final] = await Promise.all([
    storage.getRun(runId),
    storage.getPaidOperation(runId, lampIrisPlanOperationId()),
    storage.getPaidOperation(runId, lampIrisEvaluationOperationId(1)),
    storage.getPaidOperation(runId, lampIrisEvaluationOperationId(2)),
  ]);
  // The execution binds the hash of the plan AS APPROVED — the human
  // intensity dial may legitimately move it away from the journal draft, so
  // the read-side binding hashes the run's approved copy, and the draft is
  // compared modulo intensity in lampIrisPlanBindingValid.
  let planHash: string | null = null;
  if (
    plan?.status === "completed" &&
    isLampIrisPlanArtifact(plan.result) &&
    plan.result.status === "ready"
  ) {
    try {
      planHash =
        run?.irisPlan !== undefined
          ? await hashLampIrisPlan(parseLampIrisPlan(run.irisPlan))
          : await hashLampIrisPlan(plan.result.plan);
    } catch {
      planHash = null;
    }
  }
  return { plan, planHash, first, final };
}

function lampIrisArtifact(
  operation: PaidOperation | null,
  iteration: 1 | 2
) {
  return operation?.status === "completed" &&
    isLampIrisEvaluationArtifact(operation.result, iteration)
    ? operation.result
    : undefined;
}

function isLampIrisExecution(
  execution: RunExecution | null | undefined
): boolean {
  return Boolean(execution?.executionId.startsWith("lamp-iris:"));
}

function lampIrisPlanBindingValid(
  run: Run,
  execution: RunExecution,
  evaluations: LampIrisEvaluationProjection
): boolean {
  try {
    const approvedPlan = parseLampIrisPlan(run.irisPlan);
    const planArtifact = evaluations.plan?.result;
    if (
      approvedPlan.approval.status !== "approved" ||
      !lampIrisPlanRequiresGeneration(approvedPlan) ||
      execution.planOperationId !== lampIrisPlanOperationId() ||
      typeof execution.approvedPlanHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(execution.approvedPlanHash) ||
      execution.approvedPlanHash !== evaluations.planHash ||
      evaluations.plan?.status !== "completed" ||
      !isLampIrisPlanArtifact(planArtifact) ||
      planArtifact.status !== "ready"
    ) {
      return false;
    }
    // The approved copy may differ from the journal draft only by the human
    // intensity dial — the same rule the server-side validator enforces.
    return lampIrisPlansDifferOnlyByIntensity(
      planArtifact.plan,
      approvedPlan
    );
  } catch {
    return false;
  }
}

function lampIrisFinalPrompt(
  run: Run,
  execution: RunExecution,
  evaluations: LampIrisEvaluationProjection
) {
  const first = lampIrisArtifact(evaluations.first, 1);
  if (!first || !run.irisPlan) return undefined;
  return compileLampIrisFinalPrompt(
    execution.renderedPrompt,
    run.irisPlan,
    first
  );
}

function providerOperationMatchesLampIrisExecution(
  operation: ProviderOperation,
  run: Run,
  execution: RunExecution,
  evaluations: LampIrisEvaluationProjection
): boolean {
  if (
    operation.kind !== "video_generation" ||
    !lampIrisPlanBindingValid(run, execution, evaluations)
  ) {
    return false;
  }
  if (operation.iteration === 1) {
    return (
      operation.renderedPrompt === execution.renderedPrompt &&
      execution.inputHash === runExecutionInputHash(execution.renderedPrompt)
    );
  }
  if (operation.iteration !== 2) return false;
  try {
    return (
      operation.renderedPrompt ===
      lampIrisFinalPrompt(run, execution, evaluations)?.rendered
    );
  } catch {
    return false;
  }
}

function mergeLampIrisEvaluationResults(
  candidate: Run,
  execution: RunExecution,
  evaluations: LampIrisEvaluationProjection,
  hideFinalEvaluation: boolean
): void {
  if (!candidate.irisPlan) return;
  const first = lampIrisArtifact(evaluations.first, 1);
  const final = lampIrisArtifact(evaluations.final, 2);
  const finalPrompt = final
    ? lampIrisFinalPrompt(candidate, execution, evaluations)
    : undefined;
  // Best-of-two: the blind-grading hide tracks the settlement's DELIVERED
  // take. Legacy executions without the marker delivered Final (2).
  const deliveredIteration = execution.deliveredIteration ?? 2;
  for (const iteration of candidate.iterations) {
    if (iteration.index === 1 && first) {
      const projection = projectLampIrisEvaluationForRead({
        iteration: 1,
        artifact: first,
        irisPlan: candidate.irisPlan,
        humanGradeSaved: candidate.humanGrade !== undefined,
        hideFinalEvaluation,
        deliveredIteration,
      });
      iteration.evalResults = projection.evalResults;
      if (projection.composite) iteration.composite = projection.composite;
    }
    if (iteration.index === 2) {
      if (finalPrompt) {
        iteration.megaPrompt = lampIrisPromptForRun(finalPrompt);
      }
      const projection = projectLampIrisEvaluationForRead({
        iteration: 2,
        artifact: final,
        irisPlan: candidate.irisPlan,
        humanGradeSaved: candidate.humanGrade !== undefined,
        hideFinalEvaluation,
        deliveredIteration,
      });
      iteration.evalResults = projection.evalResults;
      if (projection.composite) iteration.composite = projection.composite;
    }
  }
}

function providerOperationMatchesLampExecution(
  operation: ProviderOperation,
  execution: RunExecution,
  evaluations: LampEvaluationProjection
): boolean {
  if (execution.inputHash !== runExecutionInputHash(execution.renderedPrompt)) {
    return false;
  }
  if (operation.kind !== "video_generation") return true;
  if (operation.iteration === 1) {
    return providerOperationMatchesExecution(operation, execution);
  }
  if (operation.iteration === 2) {
    return operation.renderedPrompt === lampFinalPrompt(execution, evaluations)?.rendered;
  }
  return false;
}

function providerOperationMatchesLampBackgroundExecution(
  operation: ProviderOperation,
  run: Run,
  execution: RunExecution,
  evaluations: LampBackgroundEvaluationProjection
): boolean {
  if (
    execution.inputHash !== runExecutionInputHash(execution.renderedPrompt) ||
    !lampBackgroundPlanBindingValid(run, execution, evaluations)
  ) {
    return false;
  }
  if (operation.kind !== "video_generation") return true;
  if (operation.iteration === 1) {
    return providerOperationMatchesExecution(operation, execution);
  }
  if (operation.iteration === 2) {
    return (
      operation.renderedPrompt ===
      lampBackgroundFinalPrompt(run, execution, evaluations)?.rendered
    );
  }
  return false;
}

function mergeLampEvaluationResults(
  candidate: Run,
  execution: RunExecution,
  evaluations: LampEvaluationProjection,
  hideFinalEvaluation = false
): void {
  const first = lampArtifact(evaluations.first, 1);
  const final = lampArtifact(evaluations.final, 2);
  const finalPrompt = first ? lampFinalPrompt(execution, evaluations) : undefined;
  for (const [index, artifact] of [
    [1, first],
    [2, final],
  ] as const) {
    const iteration = candidate.iterations.find((item) => item.index === index);
    if (!iteration) continue;
    if (index === 2 && finalPrompt) iteration.megaPrompt = finalPrompt;
    // The final paid artifact remains server-owned. Ordinary reads expose it;
    // only the Grade feed requests a blind projection for an ungraded Final.
    const projection = projectLampEvaluationForRead({
      iteration: index,
      artifact,
      humanGradeSaved: candidate.humanGrade !== undefined,
      hideFinalEvaluation,
    });
    iteration.evalResults = projection.evalResults;
    if (projection.composite) iteration.composite = projection.composite;
    else delete iteration.composite;
  }
}

function mergeLampBackgroundEvaluationResults(
  candidate: Run,
  execution: RunExecution,
  evaluations: LampBackgroundEvaluationProjection,
  hideFinalEvaluation = false
): void {
  if (!candidate.backgroundCleanupPlan) return;
  const first = lampBackgroundArtifact(evaluations.first, 1);
  const final = lampBackgroundArtifact(evaluations.final, 2);
  const finalPrompt = first
    ? lampBackgroundFinalPrompt(candidate, execution, evaluations)
    : undefined;
  for (const [index, artifact] of [
    [1, first],
    [2, final],
  ] as const) {
    const iteration = candidate.iterations.find((item) => item.index === index);
    if (!iteration) continue;
    if (index === 2 && finalPrompt) {
      iteration.megaPrompt = lampBackgroundPromptForRun(finalPrompt);
    }
    const projection = projectLampBackgroundEvaluationForRead({
      iteration: index,
      artifact,
      cleanupPlan: candidate.backgroundCleanupPlan,
      humanGradeSaved: candidate.humanGrade !== undefined,
      hideFinalEvaluation,
    });
    iteration.evalResults = projection.evalResults;
    if (projection.composite) iteration.composite = projection.composite;
    else delete iteration.composite;
  }
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
  if (entry.id === lampBackgroundPlanOperationId()) {
    return "Lamp Background cleanup plan (Gemini)";
  }
  if (entry.id === lampBackgroundEvaluationOperationId(1)) {
    return "Lamp Background Initial whole-video critique (Gemini)";
  }
  if (entry.id === lampBackgroundEvaluationOperationId(2)) {
    return "Lamp Background Final whole-video evaluation (Gemini)";
  }
  if (entry.id === lampBeautifyPlanOperationId()) {
    return "Lamp Beautify enhancement plan (Gemini)";
  }
  if (entry.id === lampBeautifyEvaluationOperationId(1)) {
    return "Lamp Beautify Initial whole-video critique (Gemini)";
  }
  if (entry.id === lampBeautifyEvaluationOperationId(2)) {
    return "Lamp Beautify Final whole-video evaluation (Gemini)";
  }
  if (entry.id === lampIrisPlanOperationId()) {
    return "Lamp Iris gaze plan (Gemini)";
  }
  if (entry.id === lampIrisEvaluationOperationId(1)) {
    return "Lamp Iris Initial whole-video critique (Gemini)";
  }
  if (entry.id === lampIrisEvaluationOperationId(2)) {
    return "Lamp Iris Final whole-video evaluation (Gemini)";
  }
  if (entry.id === lampEvaluationOperationId(1)) {
    return "Lamp whole-video critique (Gemini)";
  }
  if (entry.id === lampEvaluationOperationId(2)) {
    return "Lamp final whole-video evaluation (Gemini)";
  }
  if (entry.kind === "lipsync") {
    return "Final Lipsync-2-Pro repair (Replicate)";
  }
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
  execution?: RunExecution | null,
  lampEvaluations: LampEvaluationProjection = { first: null, final: null },
  backgroundEvaluations: LampBackgroundEvaluationProjection = {
    plan: null,
    planHash: null,
    first: null,
    final: null,
  },
  hideFinalEvaluation = false,
  beautifyEvaluations: LampBeautifyEvaluationProjection = {
    plan: null,
    planHash: null,
    first: null,
    final: null,
  },
  irisEvaluations: LampIrisEvaluationProjection = {
    plan: null,
    planHash: null,
    first: null,
    final: null,
  }
): Run {
  const materialized: Run = {
    ...run,
    iterations: run.iterations.map((iteration) => ({ ...iteration })),
    nodeStates: { ...run.nodeStates },
    log: [...run.log],
    cost: run.cost
      ? { ...run.cost, items: [...run.cost.items] }
      : undefined,
  };
  clearProviderTrustMarkers(materialized);
  const lamp = isLampExecution(execution);
  const background = isLampBackgroundExecution(execution);
  const beautify = isLampBeautifyExecution(execution);
  const iris = isLampIrisExecution(execution);
  const firstCutOperation = firstCutProviderOperation(materialized);
  const secondCutOperation = materialized.providerOperations?.find(
    (operation) =>
      operation.kind === "video_generation" &&
      operation.iteration === 2 &&
      !isArchivedLostGenerationId(operation.id)
  );
  const executionBindingMismatch = Boolean(
    execution &&
      (execution.inputHash !== runExecutionInputHash(execution.renderedPrompt) ||
        (firstCutOperation &&
          !providerOperationMatchesExecution(firstCutOperation, execution)) ||
        (lamp &&
          secondCutOperation &&
          !providerOperationMatchesLampExecution(
            secondCutOperation,
            execution,
            lampEvaluations
          )) ||
        (background &&
          (!lampBackgroundPlanBindingValid(
            materialized,
            execution,
            backgroundEvaluations
          ) ||
            (secondCutOperation &&
              !providerOperationMatchesLampBackgroundExecution(
                secondCutOperation,
                materialized,
                execution,
                backgroundEvaluations
              )))) ||
        (beautify &&
          (!lampBeautifyPlanBindingValid(
            materialized,
            execution,
            beautifyEvaluations
          ) ||
            (secondCutOperation &&
              !providerOperationMatchesLampBeautifyExecution(
                secondCutOperation,
                materialized,
                execution,
                beautifyEvaluations
              )))) ||
        (iris &&
          (!lampIrisPlanBindingValid(
            materialized,
            execution,
            irisEvaluations
          ) ||
            (secondCutOperation &&
              !providerOperationMatchesLampIrisExecution(
                secondCutOperation,
                materialized,
                execution,
                irisEvaluations
              )))))
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
          (lamp
            ? providerOperationMatchesLampExecution(
                operation,
                execution,
                lampEvaluations
              )
            : background
              ? providerOperationMatchesLampBackgroundExecution(
                  operation,
                  materialized,
                  execution,
                  backgroundEvaluations
                )
            : beautify
              ? providerOperationMatchesLampBeautifyExecution(
                  operation,
                  materialized,
                  execution,
                  beautifyEvaluations
                )
            : iris
              ? providerOperationMatchesLampIrisExecution(
                  operation,
                  materialized,
                  execution,
                  irisEvaluations
                )
            : operation.iteration === 1 &&
              providerOperationMatchesExecution(operation, execution))
      )
    : materialized.providerOperations;
  mergeServerGeneratedVideos(materialized, materialized, artifactOperations);
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
    const fallbackEstimate = isLampBackgroundRun(materialized)
      ? materialized.backgroundCleanupPlan?.approval.status === "approved" &&
        materialized.backgroundCleanupPlan.decision === "cleanup"
        ? (() => {
            const plan = estimateLampBackgroundPlan();
            const cleanup = estimateLampBackgroundTwoPass(
              materialized.originalVideo.durationSec
            );
            return {
              totalUsd: plan.totalUsd + cleanup.totalUsd,
              items: [...plan.items, ...cleanup.items],
            };
          })()
        : estimateLampBackgroundPlan()
      : isLampBeautifyRun(materialized)
        ? materialized.beautifyPlan?.approval.status === "approved" &&
          materialized.beautifyPlan.decision === "enhance"
          ? (() => {
              const plan = estimateLampBeautifyPlan();
              const touchUp = estimateLampBeautifyTwoPass(
                materialized.originalVideo.durationSec
              );
              return {
                totalUsd: plan.totalUsd + touchUp.totalUsd,
                items: [...plan.items, ...touchUp.items],
              };
            })()
          : estimateLampBeautifyPlan()
        : isLampIrisRun(materialized)
          ? materialized.irisPlan?.approval.status === "approved" &&
            materialized.irisPlan.decision === "correct"
            ? (() => {
                const plan = estimateLampIrisPlan();
                const correction = estimateLampIrisTwoPass(
                  materialized.originalVideo.durationSec
                );
                return {
                  totalUsd: plan.totalUsd + correction.totalUsd,
                  items: [...plan.items, ...correction.items],
                };
              })()
            : estimateLampIrisPlan()
          : estimateRun(materialized.originalVideo.durationSec);
    materialized.cost = {
      estimatedUsd:
        materialized.cost?.estimatedUsd ??
        fallbackEstimate.totalUsd,
      actualUsd: actualItems.reduce((sum, item) => sum + item.usd, 0),
      items: [...estimatedItems, ...actualItems],
    };
  }
  if (durableExecution) {
    const execution = durableExecution;
    const lamp = isLampExecution(execution);
    const background = isLampBackgroundExecution(execution);
    const beautify = isLampBeautifyExecution(execution);
    const iris = isLampIrisExecution(execution);
    const twoPass = lamp || background || beautify || iris;
    const budgetSkipped = execution.error?.startsWith("BATCH_BUDGET_SKIPPED") === true;
    const estimate = background || beautify || iris
      ? (() => {
          const plan = background
            ? estimateLampBackgroundPlan()
            : beautify
              ? estimateLampBeautifyPlan()
              : estimateLampIrisPlan();
          const cleanup = background
            ? estimateLampBackgroundTwoPass(
                materialized.originalVideo.durationSec
              )
            : beautify
              ? estimateLampBeautifyTwoPass(
                  materialized.originalVideo.durationSec
                )
              : estimateLampIrisTwoPass(
                  materialized.originalVideo.durationSec
                );
          return {
            totalUsd: plan.totalUsd + cleanup.totalUsd,
            items: [...plan.items, ...cleanup.items],
          };
        })()
      : lamp
        ? estimateLampRun(materialized.originalVideo.durationSec)
        : estimateFirstCut(materialized.originalVideo.durationSec);
    const confirmedItems = (materialized.cost?.items ?? []).filter(
      (item) => !item.estimated
    );
    materialized.serverExecution = execution;
    materialized.live = true;
    materialized.cost = {
      estimatedUsd: estimate.totalUsd,
      actualUsd: confirmedItems.reduce((sum, item) => sum + item.usd, 0),
      items: [
        ...estimate.items.map((item) => ({
          label: item.label,
          usd: item.usd,
          estimated: true,
        })),
        ...confirmedItems,
      ],
    };
    const legacyReviewed =
      !twoPass &&
      (materialized.status === "approved" ||
        materialized.status === "needs-changes");
    if (twoPass && materialized.humanGrade) {
      materialized.status = materialized.humanGrade.shipIt
        ? "approved"
        : "needs-changes";
    } else if (!legacyReviewed) {
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
        const megaPrompt =
          background && materialized.backgroundCleanupPlan
            ? (() => {
                const prompt = initialLampBackgroundMegaPrompt(
                  materialized.backgroundCleanupPlan
                );
                prompt.rendered = execution.renderedPrompt;
                return lampBackgroundPromptForRun(prompt);
              })()
            : beautify && materialized.beautifyPlan
              ? (() => {
                  const prompt = initialLampBeautifyMegaPrompt(
                    materialized.beautifyPlan
                  );
                  prompt.rendered = execution.renderedPrompt;
                  return lampBeautifyPromptForRun(prompt);
                })()
              : iris && materialized.irisPlan
                ? (() => {
                    const prompt = initialLampIrisMegaPrompt(
                      materialized.irisPlan
                    );
                    prompt.rendered = execution.renderedPrompt;
                    return lampIrisPromptForRun(prompt);
                  })()
                : initialMegaPrompt(lamp ? "lamp" : "flora");
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

    const lampFinal = lamp
      ? lampFinalPrompt(execution, lampEvaluations)
      : undefined;
    const backgroundFinal = background
      ? lampBackgroundFinalPrompt(
          materialized,
          execution,
          backgroundEvaluations
        )
      : undefined;
    const finalPromptForRun = backgroundFinal
      ? lampBackgroundPromptForRun(backgroundFinal)
      : lampFinal;
    if (twoPass && execution.iteration >= 2 && finalPromptForRun) {
      let iteration = materialized.iterations.find((item) => item.index === 2);
      if (!iteration) {
        iteration = {
          index: 2,
          megaPrompt: finalPromptForRun,
          beforeFrames: [],
          afterFrames: [],
          evalResults: [],
          status: "running",
        };
        materialized.iterations.push(iteration);
        materialized.iterations.sort((a, b) => a.index - b.index);
      } else {
        iteration.megaPrompt = finalPromptForRun;
      }
      if (
        execution.status === "awaiting_review" &&
        secondCutOperation?.status === "completed" &&
        secondCutOperation.result &&
        (lamp
          ? lampArtifact(lampEvaluations.final, 2)
          : beautify
            ? lampBeautifyArtifact(beautifyEvaluations.final, 2)
            : iris
              ? lampIrisArtifact(irisEvaluations.final, 2)
              : lampBackgroundArtifact(backgroundEvaluations.final, 2))
      ) {
        iteration.status = "ungraded";
      } else if (
        execution.status === "failed" ||
        execution.status === "reconcile_required"
      ) {
        iteration.status = "failed";
      }
    }
    if (lamp) {
      // The Grade workspace alone can request a blind read. Every projection
      // comes from the existing paid journal and never invokes an evaluator.
      mergeLampEvaluationResults(
        materialized,
        execution,
        lampEvaluations,
        hideFinalEvaluation && durableExecution?.status === "awaiting_review"
      );
    }
    if (background) {
      mergeLampBackgroundEvaluationResults(
        materialized,
        execution,
        backgroundEvaluations,
        hideFinalEvaluation && durableExecution.status === "awaiting_review"
      );

      const firstEvaluation = lampBackgroundArtifact(
        backgroundEvaluations.first,
        1
      );
      const finalEvaluation = lampBackgroundArtifact(
        backgroundEvaluations.final,
        2
      );
      const terminal =
        execution.status === "failed" ||
        execution.status === "reconcile_required";
      const paused = execution.status === "user_action_required";
      materialized.nodeStates.plan = {
        nodeId: "plan",
        status: "succeeded",
        detail: "human-approved remove / preserve / uncertain contract",
      };
      // Completed evidence outranks the terminal flag: a sealed run must not
      // repaint stages that finished and billed (their journals prove it).
      materialized.nodeStates.initial = {
        nodeId: "initial",
        status: firstEvaluation
          ? "succeeded"
          : terminal
            ? "failed"
            : execution.iteration >= 1 &&
                (execution.phase === "video_generation" ||
                  execution.phase === "finalizing")
              ? "running"
              : paused
                ? "queued"
                : "queued",
        detail: firstEvaluation
          ? "Initial generated, source audio finalized, and ready for correction"
          : paused
            ? "paused before the next authorized paid operation"
            : "source-faithful cleanup from the approved plan",
      };
      materialized.nodeStates.critique = {
        nodeId: "critique",
        status: firstEvaluation
          ? "succeeded"
          : terminal
            ? "failed"
            : execution.phase === "evaluating" && execution.iteration === 1
              ? "running"
              : "queued",
        detail: firstEvaluation
          ? "whole Initial checked against the exact approved plan"
          : "awaiting the first whole-video evaluation",
      };
      materialized.nodeStates.final = {
        nodeId: "final",
        status: finalEvaluation
          ? "succeeded"
          : terminal
            ? "failed"
            : execution.iteration >= 2 &&
                (execution.phase === "video_generation" ||
                  execution.phase === "finalizing" ||
                  execution.phase === "evaluating")
              ? "running"
              : "queued",
        detail: finalEvaluation
          ? "Final generated and evaluated from the saved correction brief"
          : paused
            ? "paused; renew the exact cleanup approval to resume"
            : "one correction pass from the immutable source",
      };
      materialized.nodeStates.review = {
        nodeId: "review",
        status: materialized.humanGrade
          ? "succeeded"
          : execution.status === "awaiting_review"
            ? "queued"
            : "idle",
        detail: materialized.humanGrade
          ? materialized.humanGrade.shipIt
            ? "human grade saved — ship"
            : "human grade saved — do not ship"
          : "blind human grade required; approved plan remains visible",
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
          execution.status === "awaiting_review"
            ? `${logKey}: Lamp Background completed Initial, whole-video critique, Final, and the saved Final evaluation — awaiting blind human grading`
            : execution.status === "user_action_required"
              ? `${logKey}: paused before the next paid operation; renew the same exact cleanup approval to resume without rebilling completed journals`
              : terminal
                ? `${logKey}: durable Lamp Background execution stopped before a gradeable artifact was confirmed${safeExecutionError ? ` — ${safeExecutionError}` : ""}`
                : `${logKey}: durable server Workflow owns Lamp Background's approved two-pass cleanup; this browser may close safely`;
        materialized.log.push({
          at: execution.updatedAt,
          nodeId:
            execution.status === "awaiting_review" ? "review" : "final",
          level: terminal
            ? "error"
            : execution.status === "user_action_required"
              ? "warn"
              : "info",
          message,
        });
      }
      return materialized;
    }
    if (beautify) {
      mergeLampBeautifyEvaluationResults(
        materialized,
        execution,
        beautifyEvaluations,
        hideFinalEvaluation && durableExecution.status === "awaiting_review"
      );

      const firstEvaluation = lampBeautifyArtifact(
        beautifyEvaluations.first,
        1
      );
      const finalEvaluation = lampBeautifyArtifact(
        beautifyEvaluations.final,
        2
      );
      const terminal =
        execution.status === "failed" ||
        execution.status === "reconcile_required";
      const paused = execution.status === "user_action_required";
      materialized.nodeStates.plan = {
        nodeId: "plan",
        status: "succeeded",
        detail: "human-approved enhance / declined / uncertain contract",
      };
      // Completed evidence outranks the terminal flag: a sealed run must not
      // repaint stages that finished and billed (their journals prove it).
      materialized.nodeStates.initial = {
        nodeId: "initial",
        status: firstEvaluation
          ? "succeeded"
          : terminal
            ? "failed"
            : execution.iteration >= 1 &&
                (execution.phase === "video_generation" ||
                  execution.phase === "finalizing")
              ? "running"
              : paused
                ? "queued"
                : "queued",
        detail: firstEvaluation
          ? "Initial generated, source audio finalized, and ready for correction"
          : paused
            ? "paused before the next authorized paid operation"
            : "source-faithful touch-up from the approved plan",
      };
      materialized.nodeStates.critique = {
        nodeId: "critique",
        status: firstEvaluation
          ? "succeeded"
          : terminal
            ? "failed"
            : execution.phase === "evaluating" && execution.iteration === 1
              ? "running"
              : "queued",
        detail: firstEvaluation
          ? "whole Initial checked against the exact approved plan"
          : "awaiting the first whole-video evaluation",
      };
      materialized.nodeStates.final = {
        nodeId: "final",
        status: finalEvaluation
          ? "succeeded"
          : terminal
            ? "failed"
            : execution.iteration >= 2 &&
                (execution.phase === "video_generation" ||
                  execution.phase === "finalizing" ||
                  execution.phase === "evaluating")
              ? "running"
              : "queued",
        detail: finalEvaluation
          ? "Final generated and evaluated from the saved correction brief"
          : paused
            ? "paused; renew the exact enhancement approval to resume"
            : "one correction pass from the immutable source",
      };
      materialized.nodeStates.review = {
        nodeId: "review",
        status: materialized.humanGrade
          ? "succeeded"
          : execution.status === "awaiting_review"
            ? "queued"
            : "idle",
        detail: materialized.humanGrade
          ? materialized.humanGrade.shipIt
            ? "human grade saved — ship"
            : "human grade saved — do not ship"
          : "blind human grade required; approved plan remains visible",
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
          execution.status === "awaiting_review"
            ? `${logKey}: Lamp Beautify completed Initial, whole-video critique, Final, and the saved Final evaluation — awaiting blind human grading`
            : execution.status === "user_action_required"
              ? `${logKey}: paused before the next paid operation; renew the same exact enhancement approval to resume without rebilling completed journals`
              : terminal
                ? `${logKey}: durable Lamp Beautify execution stopped before a gradeable artifact was confirmed${safeExecutionError ? ` — ${safeExecutionError}` : ""}`
                : `${logKey}: durable server Workflow owns Lamp Beautify's approved two-pass touch-up; this browser may close safely`;
        materialized.log.push({
          at: execution.updatedAt,
          nodeId:
            execution.status === "awaiting_review" ? "review" : "final",
          level: terminal
            ? "error"
            : execution.status === "user_action_required"
              ? "warn"
              : "info",
          message,
        });
      }
      return materialized;
    }
    if (iris) {
      mergeLampIrisEvaluationResults(
        materialized,
        execution,
        irisEvaluations,
        hideFinalEvaluation && durableExecution.status === "awaiting_review"
      );

      const firstEvaluation = lampIrisArtifact(
        irisEvaluations.first,
        1
      );
      const finalEvaluation = lampIrisArtifact(
        irisEvaluations.final,
        2
      );
      const terminal =
        execution.status === "failed" ||
        execution.status === "reconcile_required";
      const paused = execution.status === "user_action_required";
      materialized.nodeStates.plan = {
        nodeId: "plan",
        status: "succeeded",
        detail: "human-approved correct / declined / uncertain contract",
      };
      // Completed evidence outranks the terminal flag: a sealed run must not
      // repaint stages that finished and billed (their journals prove it).
      materialized.nodeStates.initial = {
        nodeId: "initial",
        status: firstEvaluation
          ? "succeeded"
          : terminal
            ? "failed"
            : execution.iteration >= 1 &&
                (execution.phase === "video_generation" ||
                  execution.phase === "finalizing")
              ? "running"
              : paused
                ? "queued"
                : "queued",
        detail: firstEvaluation
          ? "Initial generated, source audio finalized, and ready for correction"
          : paused
            ? "paused before the next authorized paid operation"
            : "source-faithful gaze correction from the approved plan",
      };
      materialized.nodeStates.critique = {
        nodeId: "critique",
        status: firstEvaluation
          ? "succeeded"
          : terminal
            ? "failed"
            : execution.phase === "evaluating" && execution.iteration === 1
              ? "running"
              : "queued",
        detail: firstEvaluation
          ? "whole Initial checked against the exact approved plan"
          : "awaiting the first whole-video evaluation",
      };
      materialized.nodeStates.final = {
        nodeId: "final",
        status: finalEvaluation
          ? "succeeded"
          : terminal
            ? "failed"
            : execution.iteration >= 2 &&
                (execution.phase === "video_generation" ||
                  execution.phase === "finalizing" ||
                  execution.phase === "evaluating")
              ? "running"
              : "queued",
        detail: finalEvaluation
          ? "Final generated and evaluated from the saved correction brief"
          : paused
            ? "paused; renew the exact gaze-correction approval to resume"
            : "one correction pass from the immutable source",
      };
      materialized.nodeStates.review = {
        nodeId: "review",
        status: materialized.humanGrade
          ? "succeeded"
          : execution.status === "awaiting_review"
            ? "queued"
            : "idle",
        detail: materialized.humanGrade
          ? materialized.humanGrade.shipIt
            ? "human grade saved — ship"
            : "human grade saved — do not ship"
          : "blind human grade required; approved plan remains visible",
      };

      // Best-of-two delivery: the settled execution may select the Initial
      // take. The legacy best-of marker then points delivered-video readers
      // (Library, batch summaries, legacy resolvers) at v1. A Final delivery
      // — or any unsettled/legacy execution — keeps the field absent exactly
      // as before.
      const deliveredInitial =
        execution.status === "awaiting_review" &&
        execution.deliveredIteration === 1;
      if (deliveredInitial) {
        materialized.bestIterationIndex = 1;
      } else {
        delete materialized.bestIterationIndex;
      }
      delete materialized.finalVideo;
      delete materialized.fallback;
      const logKey = `server execution ${execution.executionId}`;
      if (!materialized.log.some((entry) => entry.message.includes(logKey))) {
        const safeExecutionError = execution.error
          ?.replace(/\s+/g, " ")
          .trim()
          .slice(0, 240);
        const message =
          execution.status === "awaiting_review"
            ? `${logKey}: Lamp Iris completed Initial, whole-video critique, Final, and the saved Final evaluation — awaiting blind human grading`
            : execution.status === "user_action_required"
              ? `${logKey}: paused before the next paid operation; renew the same exact gaze-correction approval to resume without rebilling completed journals`
              : terminal
                ? `${logKey}: durable Lamp Iris execution stopped before a gradeable artifact was confirmed${safeExecutionError ? ` — ${safeExecutionError}` : ""}`
                : `${logKey}: durable server Workflow owns Lamp Iris's approved two-pass gaze correction; this browser may close safely`;
        materialized.log.push({
          at: execution.updatedAt,
          nodeId:
            execution.status === "awaiting_review" ? "review" : "final",
          level: terminal
            ? "error"
            : execution.status === "user_action_required"
              ? "warn"
              : "info",
          message,
        });
      }
      if (deliveredInitial) {
        const bestOfTwoKey = `best-of-two ${execution.executionId}`;
        if (
          !materialized.log.some((entry) =>
            entry.message.includes(bestOfTwoKey)
          )
        ) {
          // Reproduce the settlement's own selection math for the log line;
          // deliveredIteration 1 is only ever written when this selector
          // chose the Initial, so the recomputed reason is the settled one.
          const selectionReason = (() => {
            if (firstEvaluation && finalEvaluation) {
              try {
                return selectLampIrisDeliveredIteration(
                  firstEvaluation,
                  finalEvaluation
                ).reason;
              } catch {
                // Fall through to the generic explanation below.
              }
            }
            return "the Initial outscored the corrected Final.";
          })();
          materialized.log.push({
            at: execution.updatedAt,
            nodeId: "review",
            level: "info",
            message: `${bestOfTwoKey}: ${selectionReason} Delivering the Initial take (v1) for human grading.`,
          });
        }
      }
      return materialized;
    }

    const skipped = lamp
      ? [
          "manifest",
          "anchor",
          "anchor-gate",
          "conform",
          "sample",
          "gate",
          "fallback",
        ]
      : [
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
        detail: lamp
          ? "not part of Lamp's two-pass workflow"
          : "not run — first cut sent to human grading",
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
      detail:
        execution.iteration >= 2 && lamp
          ? "first critique compiled into the final mega prompt"
          : execution.iteration >= 1
            ? lamp
              ? "canonical initial mega prompt"
              : "canonical first-cut brief"
            : undefined,
    };
    materialized.nodeStates.videogen = {
      nodeId: "videogen",
      status:
        budgetSkipped
          ? "skipped"
          : execution.status === "user_action_required"
            ? "queued"
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
          : execution.status === "user_action_required"
            ? "paused — renew the exact Lamp approval to resume"
          : execution.status === "reconcile_required"
          ? "provider outcome needs reconciliation"
          : execution.status === "awaiting_review"
            ? lamp
              ? "initial and final cuts are complete"
              : "canonical first cut ready"
            : lamp
              ? `server Workflow owns generation ${Math.max(1, execution.iteration)} of 2`
              : "server Workflow owns this stage",
    };
    const firstEvaluation = lampArtifact(lampEvaluations.first, 1);
    const finalEvaluation = lampArtifact(lampEvaluations.final, 2);
    if (lamp) {
      const evalNodeIds = [
        "eval-identity",
        "eval-skin",
        "eval-appearance",
        "eval-background",
        "eval-lighting-delta",
        "eval-motion",
        "eval-temporal",
        "eval-halluc",
      ];
      for (const nodeId of evalNodeIds) {
        materialized.nodeStates[nodeId] = {
          nodeId,
          status: finalEvaluation
            ? "succeeded"
            : execution.status === "user_action_required"
              ? "queued"
            : execution.phase === "evaluating"
              ? "running"
              : firstEvaluation
                ? "succeeded"
                : "queued",
          detail: finalEvaluation
            ? "included in Lamp's final whole-video evaluation"
            : execution.status === "user_action_required"
              ? "paused — renew approval to continue the same evaluation journal"
            : firstEvaluation
              ? "included in Lamp's first whole-video critique"
              : "awaiting whole-video evaluation",
        };
      }
      materialized.nodeStates.ledger = {
        nodeId: "ledger",
        status: firstEvaluation ? "succeeded" : execution.phase === "evaluating" ? "running" : "queued",
        detail: firstEvaluation
          ? "all first-pass findings compiled together"
          : "awaiting the first whole-video critique",
      };
    }
    const currentAudioOperation =
      lamp && execution.iteration >= 2 ? secondCutOperation : videoOperation;
    const currentAudioLabel = lamp && execution.iteration >= 2 ? "Final" : "Initial";
    materialized.nodeStates.remux = {
      nodeId: "remux",
      status:
        currentAudioOperation?.status === "completed" &&
        currentAudioOperation.result?.audioVerified
          ? "succeeded"
          : execution.phase === "finalizing"
            ? "running"
            : "queued",
      detail:
        currentAudioOperation?.result?.audioVerified
          ? lamp
            ? `source audio finalized onto ${currentAudioLabel}`
            : "source audio finalized onto generated cut"
          : execution.phase === "finalizing"
            ? `finalizing ${lamp ? currentAudioLabel : "generated cut"} with source audio`
            : undefined,
    };
    const audioOperation = currentAudioOperation;
    materialized.nodeStates["eval-audio"] = {
      nodeId: "eval-audio",
      status:
        audioOperation?.status === "completed" && audioOperation.result
          ? audioOperation.result.audioVerified
            ? "succeeded"
            : "failed"
          : execution.phase === "finalizing"
            ? "running"
            : "queued",
      detail:
        audioOperation?.status === "completed" && audioOperation.result
          ? audioOperation.result.audioVerified
            ? `${lamp ? currentAudioLabel : "generated cut"} source audio verified before evaluation`
            : "audio verification failed closed"
          : execution.phase === "finalizing"
            ? "verifying the complete source audio timeline"
            : undefined,
    };
    materialized.nodeStates.review = {
      nodeId: "review",
      status:
        (lamp ? Boolean(materialized.humanGrade) : legacyReviewed)
          ? "succeeded"
          : execution.status === "awaiting_review"
            ? "queued"
            : "idle",
      detail: lamp
        ? materialized.humanGrade
          ? materialized.humanGrade.shipIt
            ? "human grade saved — ship"
            : "human grade saved — do not ship"
          : "human grade required"
        : legacyReviewed
          ? materialized.review?.decision
          : "human review required",
    };
    // Durable Lamp resolves v2 explicitly and durable legacy jobs are one-cut;
    // neither path may inherit a browser-authored best-of marker.
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
          ? lamp
            ? `${logKey}: Lamp generated the initial cut, critiqued it as a whole, generated the final cut, and completed the final evaluation — awaiting human grading`
            : `${logKey}: canonical first cut generated and audio finalized; automated quality checks were not run — awaiting human grading`
          : execution.status === "reconcile_required"
            ? `${logKey}: provider outcome is ambiguous and requires reconciliation; no automatic retry will run`
            : execution.status === "user_action_required"
              ? `${logKey}: paused before the next paid operation; renew the same exact Lamp approval to replay completed journals and resume without rebilling them`
            : execution.status === "failed"
              ? `${logKey}: durable ${lamp ? "Lamp" : "first-cut"} execution stopped before a gradeable artifact was confirmed${safeExecutionError ? ` — ${safeExecutionError}` : ""}`
              : `${logKey}: durable server Workflow owns ${lamp ? "Lamp's two-pass run" : "first-cut generation"}; this browser may close safely`;
      materialized.log.push({
        at: execution.updatedAt,
        nodeId: execution.status === "awaiting_review" ? "review" : "videogen",
        level:
          execution.status === "failed" || execution.status === "reconcile_required"
            ? "error"
            : execution.status === "user_action_required"
              ? "warn"
            : "info",
        message,
      });
    }
  } else {
    delete materialized.serverExecution;
    if (isLampBackgroundRun(materialized) && materialized.humanGrade) {
      materialized.status = materialized.humanGrade.shipIt
        ? "approved"
        : "needs-changes";
      if (materialized.nodeStates.review) {
        materialized.nodeStates.review = {
          ...materialized.nodeStates.review,
          status: "succeeded",
          detail: materialized.humanGrade.shipIt
            ? "human grade saved — ship"
            : "human grade saved — do not ship",
        };
      }
    }
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
  const hideFinalEvaluation =
    req.nextUrl.searchParams.get("hideFinalEvaluation") === "1" &&
    req.nextUrl.searchParams.get("revealFinalEvaluation") !== "1";

  const requestedId = req.nextUrl.searchParams.get("id");
  if (requestedId !== null) {
    if (!isValidRunId(requestedId)) {
      return NextResponse.json({ error: "Invalid run id." }, { status: 400 });
    }
    const [
      storedRun,
      paidCosts,
      execution,
      lampEvaluations,
      backgroundEvaluations,
      beautifyEvaluations,
      irisEvaluations,
    ] = await Promise.all([
      storage.getRun(requestedId),
      storage.listPaidOperationCosts(requestedId),
      storage.getRunExecution(requestedId),
      readLampEvaluationProjection(storage, requestedId),
      readLampBackgroundEvaluationProjection(storage, requestedId),
      readLampBeautifyEvaluationProjection(storage, requestedId),
      readLampIrisEvaluationProjection(storage, requestedId),
    ]);
    const run = storedRun
      ? materializeServerResults(
          storedRun,
          paidCosts,
          execution,
          lampEvaluations,
          backgroundEvaluations,
          hideFinalEvaluation,
          beautifyEvaluations,
          irisEvaluations
        )
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
      const [
        paidCosts,
        execution,
        lampEvaluations,
        backgroundEvaluations,
        beautifyEvaluations,
        irisEvaluations,
      ] = await Promise.all([
        storage.listPaidOperationCosts(run.id),
        storage.getRunExecution(run.id),
        readLampEvaluationProjection(storage, run.id),
        readLampBackgroundEvaluationProjection(storage, run.id),
        readLampBeautifyEvaluationProjection(storage, run.id),
        readLampIrisEvaluationProjection(storage, run.id),
      ]);
      return compactRun(
        materializeServerResults(
          run,
          paidCosts,
          execution,
          lampEvaluations,
          backgroundEvaluations,
          hideFinalEvaluation,
          beautifyEvaluations,
          irisEvaluations
        )
      );
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
  let body: {
    video?: unknown;
    approveLiveSpend?: unknown;
    approvePlanSpend?: unknown;
    workflowMode?: unknown;
    mock?: unknown;
  };
  try {
    body = (await req.json()) as {
      video?: unknown;
      approveLiveSpend?: unknown;
      approvePlanSpend?: unknown;
      workflowMode?: unknown;
      mock?: unknown;
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
  if (
    body.approvePlanSpend !== undefined &&
    typeof body.approvePlanSpend !== "boolean"
  ) {
    return NextResponse.json(
      { error: "approvePlanSpend must be a boolean." },
      { status: 400 }
    );
  }
  if (body.mock !== undefined && typeof body.mock !== "boolean") {
    return NextResponse.json(
      { error: "mock must be a boolean." },
      { status: 400 }
    );
  }
  if (
    body.workflowMode !== undefined &&
    body.workflowMode !== "flora" &&
    body.workflowMode !== "lamp" &&
    body.workflowMode !== "background" &&
    body.workflowMode !== "beautify" &&
    body.workflowMode !== "iris"
  ) {
    return NextResponse.json(
      {
        error:
          'workflowMode must be "flora", "lamp", "background", "beautify", or "iris".',
      },
      { status: 400 }
    );
  }
  const workflowMode: WorkflowMode =
    body.workflowMode === "flora"
      ? "flora"
      : body.workflowMode === "lamp"
        ? "lamp"
        : body.workflowMode === "background"
          ? "background"
          : body.workflowMode === "iris"
            ? "iris"
            : "beautify";
  if (
    body.approveLiveSpend === true &&
    (workflowMode === "background" ||
      workflowMode === "beautify" ||
      workflowMode === "iris")
  ) {
    return NextResponse.json(
      {
        error:
          workflowMode === "background"
            ? "Approve the source-specific Lamp Background cleanup plan before authorizing the two-pass generation."
            : workflowMode === "iris"
              ? "Approve the source-specific Lamp Iris gaze plan before authorizing the two-pass generation."
              : "Approve the source-specific Lamp Beautify enhancement plan before authorizing the two-pass generation.",
      },
      { status: 409 }
    );
  }
  if (
    (body.approveLiveSpend === true || body.approvePlanSpend === true) &&
    !hasGeminiKey()
  ) {
    return NextResponse.json(
      { error: "Gemini video generation is not configured." },
      { status: 503 }
    );
  }
  if (
    body.approvePlanSpend === true &&
    workflowMode !== "background" &&
    workflowMode !== "beautify" &&
    workflowMode !== "iris"
  ) {
    return NextResponse.json(
      {
        error:
          "Plan spend applies only to Lamp Background, Lamp Beautify, and Lamp Iris runs.",
      },
      { status: 400 }
    );
  }
  if (body.approveLiveSpend === true && workflowMode === "lamp") {
    // The V2 sync check runs after both paid generations; a broken SyncNet /
    // Replicate configuration must refuse admission here, not fail the run
    // after ~$4 of spend.
    const syncIssue = v2SyncConfigIssue();
    if (syncIssue) {
      return NextResponse.json(
        { error: `Lamp's final sync verification is not configured: ${syncIssue}` },
        { status: 503 }
      );
    }
  }

  const storage = getStorage();
  const existing = await storage.getRun(video.runId);
  if (
    workflowMode === "background" &&
    body.mock !== true &&
    body.approvePlanSpend !== true &&
    !existing?.backgroundCleanupPlan
  ) {
    return NextResponse.json(
      {
        error:
          "Approve the one-call cleanup-plan analysis before starting a live Lamp Background run.",
      },
      { status: 400 }
    );
  }
  if (
    workflowMode === "beautify" &&
    body.mock !== true &&
    body.approvePlanSpend !== true &&
    !existing?.beautifyPlan
  ) {
    return NextResponse.json(
      {
        error:
          "Approve the one-call enhancement-plan analysis before starting a live Lamp Beautify run.",
      },
      { status: 400 }
    );
  }
  if (
    workflowMode === "iris" &&
    body.mock !== true &&
    body.approvePlanSpend !== true &&
    !existing?.irisPlan
  ) {
    return NextResponse.json(
      {
        error:
          "Approve the one-call gaze-plan analysis before starting a live Lamp Iris run.",
      },
      { status: 400 }
    );
  }
  // Flora admission requires a run that already carries real Flora work; a
  // fresh run id or a never-started Flora draft is new work and is refused
  // before the ingest read downloads and probes any media.
  if (
    floraRetiredForNewWork(
      workflowMode,
      existing && runHasStartedWork(existing)
        ? persistedWorkflowMode(existing)
        : null
    )
  ) {
    return NextResponse.json({ error: FLORA_RETIRED_RUN_ERROR }, { status: 410 });
  }
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
  if (existing) {
    const existingExecution = await storage.getRunExecution(video.runId);
    const existingMode = persistedWorkflowMode(existing);
    const canAdoptWorkflowMode =
      existingExecution === null &&
      existing.spendApproval === undefined &&
      (existing.providerOperations?.length ?? 0) === 0 &&
      existing.iterations.length === 0 &&
      existing.humanGrade === undefined;
    if (existingMode !== workflowMode && !canAdoptWorkflowMode) {
      return NextResponse.json(
        {
          error: `This saved clip already belongs to ${workflowModeLabel(
            existingMode
          )}. Upload it again as a fresh ${workflowModeLabel(
            workflowMode
          )} run so approvals and artifacts cannot be mixed.`,
        },
        { status: 409 }
      );
    }
    if (
      existingExecution &&
      workflowModeFromExecutionId(existingExecution.executionId) !==
        workflowMode
    ) {
      return NextResponse.json(
        {
          error:
            "This run's saved method and durable execution disagree. It was left untouched to avoid replaying provider work.",
        },
        { status: 409 }
      );
    }
    const existingApproval =
      (workflowMode === "lamp"
        ? hasReusableLampApproval(existing)
        : workflowMode === "background"
          ? hasReusableLampBackgroundPlanApproval(existing)
          : workflowMode === "beautify"
            ? hasReusableLampBeautifyPlanApproval(existing)
            : workflowMode === "iris"
              ? hasReusableLampIrisPlanApproval(existing)
              : hasReusableFirstCutApproval(existing, "single")) &&
      existing.originalVideo.runId === canonicalVideo.runId &&
      existing.originalVideo.url === canonicalVideo.url &&
      Math.abs(existing.originalVideo.durationSec - canonicalVideo.durationSec) <=
        0.001;
    let updated = await storage.putCanonicalRunSource(
      video.runId,
      canonicalVideo,
      (body.approveLiveSpend === true ||
        body.approvePlanSpend === true) &&
      !existingApproval
        ? createSpendApproval(
            canonicalVideo,
            "single",
            undefined,
            Date.now(),
            workflowMode === "lamp"
              ? "lamp_two_pass"
              : workflowMode === "background"
                ? "background_plan"
                : workflowMode === "beautify"
                  ? "beautify_plan"
                  : workflowMode === "iris"
                    ? "iris_plan"
                    : "first_cut"
          )
        : undefined
    );
    if (!updated) {
      return NextResponse.json(
        { error: "The run disappeared while its source was being verified." },
        { status: 409 }
      );
    }
    if (existingMode !== workflowMode) {
      const workflow = workflowForMode(workflowMode);
      updated = {
        ...updated,
        workflowId: workflow.id,
        workflowMode,
        nodeStates: freshNodeStates(workflowMode),
      };
      await storage.putRun(updated);
    }
    if (workflowMode === "background") {
      const prepared = await prepareLampBackgroundPlan({
        run: updated,
        mock: body.mock === true,
      });
      if (!prepared.ok) {
        return NextResponse.json(
          { error: prepared.message, run: prepared.run },
          { status: prepared.status }
        );
      }
      return NextResponse.json({
        ok: true,
        created: false,
        run: prepared.run,
        planReviewRequired:
          prepared.plan.approval.status !== "approved",
        serverOwned: body.mock !== true,
      });
    }
    if (workflowMode === "beautify") {
      const prepared = await prepareLampBeautifyPlan({
        run: updated,
        mock: body.mock === true,
      });
      if (!prepared.ok) {
        return NextResponse.json(
          { error: prepared.message, run: prepared.run },
          { status: prepared.status }
        );
      }
      return NextResponse.json({
        ok: true,
        created: false,
        run: prepared.run,
        planReviewRequired:
          prepared.plan.approval.status !== "approved",
        serverOwned: body.mock !== true,
      });
    }
    if (workflowMode === "iris") {
      const prepared = await prepareLampIrisPlan({
        run: updated,
        mock: body.mock === true,
      });
      if (!prepared.ok) {
        return NextResponse.json(
          { error: prepared.message, run: prepared.run },
          { status: prepared.status }
        );
      }
      return NextResponse.json({
        ok: true,
        created: false,
        run: prepared.run,
        planReviewRequired:
          prepared.plan.approval.status !== "approved",
        serverOwned: body.mock !== true,
      });
    }
    if (body.approveLiveSpend === true) {
      try {
        const launch = await enqueueSingleRun(updated, workflowMode);
        if (
          launch.execution.status === "failed" ||
          launch.execution.status === "reconcile_required"
        ) {
          return NextResponse.json(
            {
              error:
                launch.execution.status === "reconcile_required"
                  ? "This run has an unresolved provider outcome. It will not be billed again automatically; reconcile the existing attempt first."
                  : `This durable ${
                      workflowModeLabel(workflowMode)
                    } run already stopped and cannot be presented as newly started. Create a fresh run after reviewing its saved error.`,
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
            error: `The run was saved, but its durable ${
              workflowModeLabel(workflowMode)
            } execution could not be enqueued. Retry this confirmation; paid operations will not be repeated.`,
          },
          { status: 502 }
        );
      }
    }
    return NextResponse.json({ ok: true, created: false, run: updated });
  }
  const run = buildRun(canonicalVideo, Date.now(), workflowMode);
  if (
    body.approveLiveSpend === true ||
    body.approvePlanSpend === true
  ) {
    run.spendApproval = createSpendApproval(
      canonicalVideo,
      "single",
      undefined,
      Date.now(),
      workflowMode === "lamp"
        ? "lamp_two_pass"
        : workflowMode === "background"
          ? "background_plan"
          : workflowMode === "beautify"
            ? "beautify_plan"
            : workflowMode === "iris"
              ? "iris_plan"
              : "first_cut"
    );
  }
  await storage.putRun(run);
  if (workflowMode === "background") {
    const prepared = await prepareLampBackgroundPlan({
      run,
      mock: body.mock === true,
    });
    if (!prepared.ok) {
      return NextResponse.json(
        { error: prepared.message, run: prepared.run },
        { status: prepared.status }
      );
    }
    return NextResponse.json(
      {
        ok: true,
        created: true,
        run: prepared.run,
        planReviewRequired:
          prepared.plan.approval.status !== "approved",
        serverOwned: body.mock !== true,
      },
      { status: 201 }
    );
  }
  if (workflowMode === "beautify") {
    const prepared = await prepareLampBeautifyPlan({
      run,
      mock: body.mock === true,
    });
    if (!prepared.ok) {
      return NextResponse.json(
        { error: prepared.message, run: prepared.run },
        { status: prepared.status }
      );
    }
    return NextResponse.json(
      {
        ok: true,
        created: true,
        run: prepared.run,
        planReviewRequired:
          prepared.plan.approval.status !== "approved",
        serverOwned: body.mock !== true,
      },
      { status: 201 }
    );
  }
  if (workflowMode === "iris") {
    const prepared = await prepareLampIrisPlan({
      run,
      mock: body.mock === true,
    });
    if (!prepared.ok) {
      return NextResponse.json(
        { error: prepared.message, run: prepared.run },
        { status: prepared.status }
      );
    }
    return NextResponse.json(
      {
        ok: true,
        created: true,
        run: prepared.run,
        planReviewRequired:
          prepared.plan.approval.status !== "approved",
        serverOwned: body.mock !== true,
      },
      { status: 201 }
    );
  }
  if (body.approveLiveSpend === true) {
    try {
      const launch = await enqueueSingleRun(run, workflowMode);
      if (
        launch.execution.status === "failed" ||
        launch.execution.status === "reconcile_required"
      ) {
        return NextResponse.json(
          {
            error:
              launch.execution.status === "reconcile_required"
                ? "This run has an unresolved provider outcome. It will not be billed again automatically; reconcile the existing attempt first."
                : `This durable ${
                    workflowModeLabel(workflowMode)
                  } run already stopped and cannot be presented as newly started. Create a fresh run after reviewing its saved error.`,
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
          error: `The run was saved, but its durable ${
            workflowModeLabel(workflowMode)
          } execution could not be enqueued. Retry this confirmation; paid operations will not be repeated.`,
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
  persisted.workflowId = current.workflowId;
  persisted.workflowMode = current.workflowMode;
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
  let acceptsMockPlanApproval = false;
  try {
    acceptsMockPlanApproval = Boolean(
      current.backgroundCleanupPlan &&
        candidate.backgroundCleanupPlan &&
        current.spendApproval === undefined &&
        current.backgroundCleanupPlan.approval.status === "draft" &&
        candidate.backgroundCleanupPlan.approval.status === "approved" &&
        (await hashLampBackgroundCleanupPlan(
          current.backgroundCleanupPlan
        )) ===
          (await hashLampBackgroundCleanupPlan(
            candidate.backgroundCleanupPlan
          ))
    );
  } catch {
    acceptsMockPlanApproval = false;
  }
  if (acceptsMockPlanApproval) {
    // Provider-free mock plans still require a deliberate human approval.
    persisted.backgroundCleanupPlan =
      candidate.backgroundCleanupPlan;
  } else {
    persisted.backgroundCleanupPlan =
      current.backgroundCleanupPlan;
  }
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
  const expectedGradedAt = body.expectedGradedAt;
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
  const [
    current,
    execution,
    lampEvaluations,
    backgroundEvaluations,
    beautifyEvaluations,
    irisEvaluations,
  ] = await Promise.all([
    storage.getRun(id),
    storage.getRunExecution(id),
    readLampEvaluationProjection(storage, id),
    readLampBackgroundEvaluationProjection(storage, id),
    readLampBeautifyEvaluationProjection(storage, id),
    readLampIrisEvaluationProjection(storage, id),
  ]);
  if (!current) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }
  const materialized = materializeServerResults(
    current,
    [],
    execution,
    lampEvaluations,
    backgroundEvaluations,
    false,
    beautifyEvaluations,
    irisEvaluations
  );
  const authoritativeExecution = materialized.serverExecution;
  const background = authoritativeExecution
    ? isLampBackgroundExecution(authoritativeExecution)
    : isLampBackgroundRun(materialized);
  const beautify =
    !background &&
    (authoritativeExecution
      ? isLampBeautifyExecution(authoritativeExecution)
      : isLampBeautifyRun(materialized));
  const iris =
    !background &&
    !beautify &&
    (authoritativeExecution
      ? isLampIrisExecution(authoritativeExecution)
      : isLampIrisRun(materialized));
  const lamp = !background && !beautify && !iris &&
    (authoritativeExecution
      ? isLampExecution(authoritativeExecution)
      : persistedWorkflowMode(materialized) === "lamp");
  const twoPass = lamp || background || beautify || iris;
  const grade = parseHumanGrade({
    value: body.humanGrade,
    requiredEvalIds: background
      ? LAMP_BACKGROUND_EVAL_IDS
      : lamp
        ? LAMP_EVAL_IDS
        : ALL_EVAL_IDS,
    ...(lamp ? { acceptedLegacyEvalIds: ALL_EVAL_IDS } : {}),
  });
  if (!grade) {
    return NextResponse.json({ error: "Invalid human grade." }, { status: 400 });
  }
  const lastIteration = materialized.iterations.at(-1);
  const selectedIndex = materialized.bestIterationIndex;
  const shipped = twoPass
    ? materialized.iterations.find((iteration) => iteration.index === 2)
    : selectedIndex === undefined
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
  const executionOwnsArtifact = authoritativeExecution
    ? background
      ? authoritativeExecution.status === "awaiting_review" &&
        shipped?.index === 2 &&
        shippedOperation !== undefined &&
        shippedOperation.result?.audioVerified === true &&
        providerOperationMatchesLampBackgroundExecution(
          shippedOperation,
          materialized,
          authoritativeExecution,
          backgroundEvaluations
        ) &&
        lampBackgroundArtifact(backgroundEvaluations.final, 2) !== undefined
      : lamp
        ? authoritativeExecution.status === "awaiting_review" &&
        shipped?.index === 2 &&
        shippedOperation !== undefined &&
        shippedOperation.result?.audioVerified === true &&
        providerOperationMatchesLampExecution(
          shippedOperation,
          authoritativeExecution,
          lampEvaluations
        ) &&
        lampArtifact(lampEvaluations.final, 2) !== undefined
        : authoritativeExecution.status === "awaiting_review" &&
          shipped?.index === 1 &&
          shippedOperation !== undefined &&
          providerOperationMatchesExecution(
            shippedOperation,
            authoritativeExecution
          )
    : true;
  const approvedBackgroundNoOp =
    !authoritativeExecution &&
    background &&
    materialized.backgroundCleanupPlan?.approval.status === "approved" &&
    materialized.backgroundCleanupPlan.runId === materialized.id &&
    materialized.backgroundCleanupPlan.decision === "exceptional-no-op" &&
    materialized.status === "awaiting-review" &&
    shipped?.generatedVideo?.url === materialized.originalVideo.url;
  const canonicalArtifact =
    approvedBackgroundNoOp ||
    (!authoritativeExecution &&
      materialized.live !== true &&
      shipped?.generatedVideo?.simulatedFilter !== undefined) ||
    (shipped?.recoveredFromProviderOperation === true &&
      shipped.generatedVideo !== undefined &&
      shippedOperation !== undefined &&
      executionOwnsArtifact);
  if (!canonicalArtifact) {
    return NextResponse.json(
      { error: "A completed server-verified output video is required before grading." },
      { status: 409 }
    );
  }
  const result = await storage.putHumanGrade(id, grade, expectedGradedAt);
  if (!result.ok && !result.current) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }
  if (!result.ok) {
    const [
      paidCosts,
      freshExecution,
      freshLampEvaluations,
      freshBackgroundEvaluations,
      freshBeautifyEvaluations,
      freshIrisEvaluations,
    ] = await Promise.all([
      storage.listPaidOperationCosts(id),
      storage.getRunExecution(id),
      readLampEvaluationProjection(storage, id),
      readLampBackgroundEvaluationProjection(storage, id),
      readLampBeautifyEvaluationProjection(storage, id),
      readLampIrisEvaluationProjection(storage, id),
    ]);
    const conflictRun = materializeServerResults(
      result.current!,
      paidCosts,
      freshExecution,
      freshLampEvaluations,
      freshBackgroundEvaluations,
      false,
      freshBeautifyEvaluations,
      freshIrisEvaluations
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
  const [
    paidCosts,
    freshExecution,
    freshLampEvaluations,
    freshBackgroundEvaluations,
    freshBeautifyEvaluations,
    freshIrisEvaluations,
  ] = await Promise.all([
    storage.listPaidOperationCosts(id),
    storage.getRunExecution(id),
    readLampEvaluationProjection(storage, id),
    readLampBackgroundEvaluationProjection(storage, id),
    readLampBeautifyEvaluationProjection(storage, id),
    readLampIrisEvaluationProjection(storage, id),
  ]);
  const savedRun = materializeServerResults(
    result.run,
    paidCosts,
    freshExecution,
    freshLampEvaluations,
    freshBackgroundEvaluations,
    false,
    freshBeautifyEvaluations,
    freshIrisEvaluations
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
  const force = req.nextUrl.searchParams.get("force") === "1";
  try {
    if (force) {
      // The operator override abandons unresolved provider evidence, which
      // is the owner's call — but never while a live Workflow still writes
      // to this run. Cancel the workflow first, then force.
      const execution = await getStorage().getRunExecution(id);
      const liveness =
        execution?.workflowRunId &&
        (execution.status === "queued" || execution.status === "running")
          ? await workflowRunLiveness(execution.workflowRunId)
          : null;
      if (liveness === "alive" || liveness === "unknown") {
        return NextResponse.json(
          {
            code: "WORKFLOW_ALIVE",
            error:
              "A durable workflow still owns this run. Cancel that workflow first, then force-delete.",
          },
          {
            status: 409,
            headers: { "Cache-Control": "private, no-store, max-age=0" },
          }
        );
      }
      console.warn(`[runs/delete] operator force-delete of ${id}`);
    }
    const existed = await getStorage().deleteRun(
      id,
      force ? { force: true } : undefined
    );
    return NextResponse.json({ ok: true, id, existed });
  } catch (err) {
    if (err instanceof ActiveRunDeletionError) {
      return NextResponse.json(
        {
          code: "RUN_ACTIVE",
          error:
            "This run still has generation or batch work in progress or awaiting reconciliation. Let it settle before deleting it.",
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
