import { NextRequest, NextResponse } from "next/server";

import {
  approveLampBackgroundCleanupPlan,
  hashLampBackgroundCleanupPlan,
} from "@/lib/lamp-background";
import { lampBackgroundPlanOperationId } from "@/lib/lamp-background-operations";
import {
  lampBackgroundNoOpPromptForRun,
  lampBackgroundPromptForRun,
} from "@/lib/lamp-background-read";
import { initialLampBackgroundMegaPrompt } from "@/lib/prompts/lamp-background";
import {
  hasReusableLampBackgroundApproval,
  createSpendApproval,
} from "@/lib/server/spend-approval";
import { enqueueRunExecution } from "@/lib/server/run-execution-coordinator";
import { getStorage } from "@/lib/server/storage";
import {
  isLampBackgroundPlanArtifact,
  type LampBackgroundPlanArtifact,
} from "@/lib/server/lamp-background-planner";
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
    LampBackgroundPlanArtifact,
    { status: "ready" }
  >["plan"]
): Run {
  const approvedPlan = approveLampBackgroundCleanupPlan(plan, Date.now());
  const finalVideo: VideoAsset = {
    ...run.originalVideo,
    id: `lamp-background-no-op-${run.id}`,
    kind: "final",
    label: "Lamp Background — approved unchanged source",
  };
  return {
    ...run,
    workflowId: "lamp-background-v1",
    workflowMode: "background",
    backgroundCleanupPlan: approvedPlan,
    iterations: [
      {
        index: 2,
        megaPrompt: lampBackgroundNoOpPromptForRun(approvedPlan),
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
          "Lamp Background plan approved as an exceptional no-op. The exact source is ready for human grading; no generation or final AI evaluation was run.",
      },
    ],
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    runId?: unknown;
    planHash?: unknown;
    approveLiveSpend?: unknown;
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

  const storage = getStorage();
  const [run, operation] = await Promise.all([
    storage.getRun(body.runId),
    storage.getPaidOperation(
      body.runId,
      lampBackgroundPlanOperationId()
    ),
  ]);
  if (!run) return jsonError(404, "Run not found.");
  if (runWorkflowMode(run) !== "background") {
    return jsonError(409, "This run is not a Lamp Background run.");
  }
  if (
    operation?.status !== "completed" ||
    !isLampBackgroundPlanArtifact(operation.result)
  ) {
    return jsonError(
      409,
      "A completed cleanup-plan analysis is required before approval."
    );
  }
  if (operation.result.status !== "ready") {
    return jsonError(409, operation.result.reason);
  }
  const draftPlan = operation.result.plan;
  if (draftPlan.runId !== run.id) {
    return jsonError(
      409,
      "The cleanup plan belongs to a different source run and cannot be approved."
    );
  }
  const canonicalHash = await hashLampBackgroundCleanupPlan(draftPlan);
  if (canonicalHash !== body.planHash) {
    return jsonError(
      409,
      "The cleanup plan changed before approval. Reload and review the current plan."
    );
  }
  const existingApprovedPlan =
    run.backgroundCleanupPlan?.approval.status === "approved" &&
    (await hashLampBackgroundCleanupPlan(run.backgroundCleanupPlan)) ===
      canonicalHash
      ? run.backgroundCleanupPlan
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
      "approveLiveSpend must be true to start the approved two-pass cleanup."
    );
  }
  const syncIssue = v2SyncConfigIssue();
  if (syncIssue) {
    return jsonError(
      503,
      `Lamp Background's final sync verification is not configured: ${syncIssue}`
    );
  }

  const approvedPlan =
    existingApprovedPlan?.decision === "cleanup"
      ? existingApprovedPlan
      : approveLampBackgroundCleanupPlan(draftPlan, Date.now());
  const reusableApproval = hasReusableLampBackgroundApproval(run);
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
          "background_two_pass"
        )
      );
  if (!updated) {
    return jsonError(
      409,
      "The run disappeared while its cleanup approval was being saved."
    );
  }
  updated = {
    ...updated,
    backgroundCleanupPlan: approvedPlan,
  };
  await storage.putRun(updated);

  const prompt = initialLampBackgroundMegaPrompt(approvedPlan);
  let launch;
  try {
    launch = await enqueueRunExecution({
      runId: updated.id,
      executionId: `lamp-background:${updated.id}`,
      source: "single",
      renderedPrompt: prompt.rendered,
      planOperationId: lampBackgroundPlanOperationId(),
      approvedPlanHash: canonicalHash,
    });
  } catch (error) {
    console.error(
      "[background-plan/approve] durable execution enqueue failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      {
        error:
          "The approved cleanup was saved, but durable dispatch is temporarily unavailable. Retrying this exact approval will reuse completed journals and will not repeat the planning call.",
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
                megaPrompt: lampBackgroundPromptForRun(prompt),
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
