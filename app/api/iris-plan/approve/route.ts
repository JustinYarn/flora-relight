import { NextRequest, NextResponse } from "next/server";

import {
  applyLampIrisIntensityOverride,
  approveLampIrisPlan,
  hashLampIrisPlan,
  type LampIrisIntensity,
} from "@/lib/lamp-iris";
import { lampIrisPlanOperationId } from "@/lib/lamp-iris-operations";
import {
  lampIrisNoOpPromptForRun,
  lampIrisPromptForRun,
} from "@/lib/lamp-iris-read";
import { initialLampIrisMegaPrompt } from "@/lib/prompts/lamp-iris";
import {
  hasReusableLampIrisApproval,
  createSpendApproval,
} from "@/lib/server/spend-approval";
import { enqueueRunExecution } from "@/lib/server/run-execution-coordinator";
import { getStorage } from "@/lib/server/storage";
import {
  isLampIrisPlanArtifact,
  type LampIrisPlanArtifact,
} from "@/lib/server/lamp-iris-planner";
import { v2SyncConfigIssue } from "@/lib/server/syncnet";
import { isValidRunId } from "@/lib/server/runstore";
import { runWorkflowMode } from "@/lib/workflow-mode";
import type { Run, VideoAsset } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function noOpRun(
  run: Run,
  plan: Extract<
    LampIrisPlanArtifact,
    { status: "ready" }
  >["plan"]
): Run {
  const approvedPlan = approveLampIrisPlan(plan, Date.now());
  const finalVideo: VideoAsset = {
    ...run.originalVideo,
    id: `lamp-iris-no-op-${run.id}`,
    kind: "final",
    label: "Lamp Iris — approved unchanged source",
  };
  return {
    ...run,
    workflowId: "lamp-iris-v1",
    workflowMode: "iris",
    irisPlan: approvedPlan,
    iterations: [
      {
        index: 2,
        megaPrompt: lampIrisNoOpPromptForRun(approvedPlan),
        generatedVideo: finalVideo,
        beforeFrames: [],
        afterFrames: [],
        evalResults: [],
        status: "ungraded",
      },
    ],
    nodeStates: {
      ...run.nodeStates,
      plan: {
        nodeId: "plan",
        status: "succeeded",
        detail: "approved exceptional no-op",
      },
      initial: {
        nodeId: "initial",
        status: "skipped",
        detail: "no generation authorized",
      },
      critique: {
        nodeId: "critique",
        status: "skipped",
        detail: "no generated candidate to critique",
      },
      final: {
        nodeId: "final",
        status: "skipped",
        detail: "exact source passes through unchanged",
      },
      review: {
        nodeId: "review",
        status: "queued",
        detail: "human grade required for the approved no-op",
      },
    },
    finalVideo,
    status: "awaiting-review",
    live: true,
    log: [
      ...run.log,
      {
        at: Date.now(),
        nodeId: "review",
        level: "info",
        message:
          "Lamp Iris plan approved as an exceptional no-op. The exact source is ready for human grading; no generation or final AI evaluation was run.",
      },
    ],
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    runId?: unknown;
    planHash?: unknown;
    approveLiveSpend?: unknown;
    intensityOverride?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "Body must be JSON.");
  }
  if (!isValidRunId(body.runId)) return jsonError(400, "Invalid runId.");
  if (
    typeof body.planHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.planHash)
  ) {
    return jsonError(400, "planHash must be a lowercase SHA-256 digest.");
  }
  if (
    body.approveLiveSpend !== undefined &&
    typeof body.approveLiveSpend !== "boolean"
  ) {
    return jsonError(400, "approveLiveSpend must be a boolean.");
  }
  if (
    body.intensityOverride !== undefined &&
    body.intensityOverride !== 1 &&
    body.intensityOverride !== 2 &&
    body.intensityOverride !== 3
  ) {
    return jsonError(400, "intensityOverride must be 1, 2, or 3.");
  }

  const storage = getStorage();
  const [run, operation] = await Promise.all([
    storage.getRun(body.runId),
    storage.getPaidOperation(
      body.runId,
      lampIrisPlanOperationId()
    ),
  ]);
  if (!run) return jsonError(404, "Run not found.");
  if (runWorkflowMode(run) !== "iris") {
    return jsonError(409, "This run is not a Lamp Iris run.");
  }
  if (
    operation?.status !== "completed" ||
    !isLampIrisPlanArtifact(operation.result)
  ) {
    return jsonError(
      409,
      run.irisPlan && run.live !== true
        ? "This is a demo run — its plan never had a real planner analysis, so live generation cannot be authorized. Upload the clip as a live run to use the dial for real."
        : "A completed gaze-plan analysis is required before approval."
    );
  }
  if (operation.result.status !== "ready") {
    return jsonError(409, operation.result.reason);
  }
  let draftPlan = operation.result.plan;
  if (draftPlan.runId !== run.id) {
    return jsonError(
      409,
      "The gaze plan belongs to a different source run and cannot be approved."
    );
  }
  if (body.intensityOverride !== undefined) {
    if (draftPlan.decision !== "correct") {
      return jsonError(
        409,
        "An intensity override applies only to a correct decision."
      );
    }
    draftPlan = applyLampIrisIntensityOverride(
      draftPlan,
      body.intensityOverride as LampIrisIntensity
    );
  }
  const canonicalHash = await hashLampIrisPlan(draftPlan);
  if (canonicalHash !== body.planHash) {
    return jsonError(
      409,
      "The gaze plan changed before approval. Reload and review the current plan."
    );
  }
  const existingApprovedPlan =
    run.irisPlan?.approval.status === "approved" &&
    (await hashLampIrisPlan(run.irisPlan)) ===
      canonicalHash
      ? run.irisPlan
      : undefined;

  if (draftPlan.decision === "exceptional-no-op") {
    if (
      existingApprovedPlan?.decision === "exceptional-no-op" &&
      run.status === "awaiting-review" &&
      run.finalVideo?.url === run.originalVideo.url
    ) {
      return NextResponse.json({
        ok: true,
        run,
        noOp: true,
        serverOwned: true,
      });
    }
    const completed = noOpRun(run, draftPlan);
    await storage.putRun(completed);
    return NextResponse.json({
      ok: true,
      run: completed,
      noOp: true,
      serverOwned: true,
    });
  }
  if (body.approveLiveSpend !== true) {
    return jsonError(
      400,
      "approveLiveSpend must be true to start the approved two-pass gaze correction."
    );
  }
  const syncIssue = v2SyncConfigIssue();
  if (syncIssue) {
    return jsonError(
      503,
      `Lamp Iris's final sync verification is not configured: ${syncIssue}`
    );
  }

  const approvedPlan =
    existingApprovedPlan?.decision === "correct"
      ? existingApprovedPlan
      : approveLampIrisPlan(draftPlan, Date.now());
  const reusableApproval = hasReusableLampIrisApproval(run);
  let updated = reusableApproval
    ? run
    : await storage.putCanonicalRunSource(
        run.id,
        run.originalVideo,
        createSpendApproval(
          run.originalVideo,
          "single",
          undefined,
          Date.now(),
          "iris_two_pass"
        )
      );
  if (!updated) {
    return jsonError(
      409,
      "The run disappeared while its gaze-correction approval was being saved."
    );
  }
  updated = {
    ...updated,
    irisPlan: approvedPlan,
  };
  await storage.putRun(updated);

  const prompt = initialLampIrisMegaPrompt(approvedPlan);
  let launch;
  try {
    launch = await enqueueRunExecution({
      runId: updated.id,
      executionId: `lamp-iris:${updated.id}`,
      source: "single",
      renderedPrompt: prompt.rendered,
      planOperationId: lampIrisPlanOperationId(),
      approvedPlanHash: canonicalHash,
    });
  } catch (error) {
    console.error(
      "[iris-plan/approve] durable execution enqueue failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      {
        error:
          "The approved gaze correction was saved, but durable dispatch is temporarily unavailable. Retrying this exact approval will reuse completed journals and will not repeat the planning call.",
        run: updated,
      },
      { status: 502 }
    );
  }
  return NextResponse.json({
    ok: true,
    run: {
      ...updated,
      iterations:
        updated.iterations.length > 0
          ? updated.iterations
          : [
              {
                index: 1,
                megaPrompt: lampIrisPromptForRun(prompt),
                beforeFrames: [],
                afterFrames: [],
                evalResults: [],
                status: "running",
              },
            ],
      serverExecution: launch.execution,
    },
    execution: launch.execution,
    noOp: false,
    serverOwned: true,
  });
}
