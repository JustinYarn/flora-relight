import { NextRequest, NextResponse } from "next/server";

import {
  applyLampBeautifyIntensityOverride,
  approveLampBeautifyPlan,
  hashLampBeautifyPlan,
  type LampBeautifyIntensity,
} from "@/lib/lamp-beautify";
import { lampBeautifyPlanOperationId } from "@/lib/lamp-beautify-operations";
import {
  lampBeautifyNoOpPromptForRun,
  lampBeautifyPromptForRun,
} from "@/lib/lamp-beautify-read";
import { initialLampBeautifyMegaPrompt } from "@/lib/prompts/lamp-beautify";
import {
  hasReusableLampBeautifyApproval,
  createSpendApproval,
} from "@/lib/server/spend-approval";
import { enqueueRunExecution } from "@/lib/server/run-execution-coordinator";
import { getStorage } from "@/lib/server/storage";
import {
  isLampBeautifyPlanArtifact,
  type LampBeautifyPlanArtifact,
} from "@/lib/server/lamp-beautify-planner";
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
    LampBeautifyPlanArtifact,
    { status: "ready" }
  >["plan"]
): Run {
  const approvedPlan = approveLampBeautifyPlan(plan, Date.now());
  const finalVideo: VideoAsset = {
    ...run.originalVideo,
    id: `lamp-beautify-no-op-${run.id}`,
    kind: "final",
    label: "Lamp Beautify — approved unchanged source",
  };
  return {
    ...run,
    workflowId: "lamp-beautify-v1",
    workflowMode: "beautify",
    beautifyPlan: approvedPlan,
    iterations: [
      {
        index: 2,
        megaPrompt: lampBeautifyNoOpPromptForRun(approvedPlan),
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
          "Lamp Beautify plan approved as an exceptional no-op. The exact source is ready for human grading; no generation or final AI evaluation was run.",
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
      lampBeautifyPlanOperationId()
    ),
  ]);
  if (!run) return jsonError(404, "Run not found.");
  if (runWorkflowMode(run) !== "beautify") {
    return jsonError(409, "This run is not a Lamp Beautify run.");
  }
  if (
    operation?.status !== "completed" ||
    !isLampBeautifyPlanArtifact(operation.result)
  ) {
    return jsonError(
      409,
      "A completed enhancement-plan analysis is required before approval."
    );
  }
  if (operation.result.status !== "ready") {
    return jsonError(409, operation.result.reason);
  }
  let draftPlan = operation.result.plan;
  if (draftPlan.runId !== run.id) {
    return jsonError(
      409,
      "The enhancement plan belongs to a different source run and cannot be approved."
    );
  }
  if (body.intensityOverride !== undefined) {
    if (draftPlan.decision !== "enhance") {
      return jsonError(
        409,
        "An intensity override applies only to an enhance decision."
      );
    }
    draftPlan = applyLampBeautifyIntensityOverride(
      draftPlan,
      body.intensityOverride as LampBeautifyIntensity
    );
  }
  const canonicalHash = await hashLampBeautifyPlan(draftPlan);
  if (canonicalHash !== body.planHash) {
    return jsonError(
      409,
      "The enhancement plan changed before approval. Reload and review the current plan."
    );
  }
  const existingApprovedPlan =
    run.beautifyPlan?.approval.status === "approved" &&
    (await hashLampBeautifyPlan(run.beautifyPlan)) ===
      canonicalHash
      ? run.beautifyPlan
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
      "approveLiveSpend must be true to start the approved two-pass touch-up."
    );
  }
  const syncIssue = v2SyncConfigIssue();
  if (syncIssue) {
    return jsonError(
      503,
      `Lamp Beautify's final sync verification is not configured: ${syncIssue}`
    );
  }

  const approvedPlan =
    existingApprovedPlan?.decision === "enhance"
      ? existingApprovedPlan
      : approveLampBeautifyPlan(draftPlan, Date.now());
  const reusableApproval = hasReusableLampBeautifyApproval(run);
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
          "beautify_two_pass"
        )
      );
  if (!updated) {
    return jsonError(
      409,
      "The run disappeared while its enhancement approval was being saved."
    );
  }
  updated = {
    ...updated,
    beautifyPlan: approvedPlan,
  };
  await storage.putRun(updated);

  const prompt = initialLampBeautifyMegaPrompt(approvedPlan);
  let launch;
  try {
    launch = await enqueueRunExecution({
      runId: updated.id,
      executionId: `lamp-beautify:${updated.id}`,
      source: "single",
      renderedPrompt: prompt.rendered,
      planOperationId: lampBeautifyPlanOperationId(),
      approvedPlanHash: canonicalHash,
    });
  } catch (error) {
    console.error(
      "[beautify-plan/approve] durable execution enqueue failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      {
        error:
          "The approved enhancement was saved, but durable dispatch is temporarily unavailable. Retrying this exact approval will reuse completed journals and will not repeat the planning call.",
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
                megaPrompt: lampBeautifyPromptForRun(prompt),
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
