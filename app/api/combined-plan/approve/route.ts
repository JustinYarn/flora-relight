import { NextRequest, NextResponse } from "next/server";

import { estimateLampCombinedTwoPass } from "@/lib/cost";
import {
  parseLampCombinedControls,
  parseLampCombinedPlan,
  type LampCombinedControls,
} from "@/lib/lamp-combined";
import { initialLampCombinedMegaPrompt } from "@/lib/prompts/lamp-combined";
import { approveLampCombinedPlanForRun } from "@/lib/server/lamp-combined-approval";
import { assertLampCombinedPlannerJournals } from "@/lib/server/lamp-combined-planner";
import { enqueueRunExecution } from "@/lib/server/run-execution-coordinator";
import {
  createSpendApproval,
  hasReusableLampCombinedTwoPassApproval,
} from "@/lib/server/spend-approval";
import { getStorage } from "@/lib/server/storage";
import { isValidRunId } from "@/lib/server/runstore";
import { v2SyncConfigIssue } from "@/lib/server/syncnet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function draftCopyOfCombinedPlan(value: unknown) {
  const plan = parseLampCombinedPlan(value);
  return parseLampCombinedPlan({
    ...plan,
    backgroundPlan: {
      ...plan.backgroundPlan,
      approval: { status: "draft" },
    },
    beautify:
      plan.beautify.state === "enabled"
        ? {
            state: "enabled",
            plan: {
              ...plan.beautify.plan,
              approval: { status: "draft" },
            },
          }
        : plan.beautify,
    iris:
      plan.iris.state === "enabled"
        ? {
            state: "enabled",
            intensity: plan.iris.intensity,
            plan: {
              ...plan.iris.plan,
              approval: { status: "draft" },
            },
          }
        : plan.iris,
    approval: { status: "draft" },
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    runId?: unknown;
    planHash?: unknown;
    controls?: unknown;
    relightIntensity?: unknown;
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
  if (body.approveLiveSpend !== true) {
    return jsonError(
      400,
      "approveLiveSpend must be true to start the approved Combined two-pass run."
    );
  }
  let controls: LampCombinedControls;
  try {
    controls = parseLampCombinedControls(body.controls);
  } catch (error) {
    return jsonError(
      400,
      error instanceof Error ? error.message : "Combined controls are invalid."
    );
  }
  if (
    typeof body.relightIntensity !== "number" ||
    !Number.isInteger(body.relightIntensity) ||
    body.relightIntensity < 0 ||
    body.relightIntensity > 100 ||
    body.relightIntensity % 5 !== 0
  ) {
    return jsonError(
      400,
      "relightIntensity must be a five-point step from 0 through 100."
    );
  }

  const storage = getStorage();
  const run = await storage.getRun(body.runId);
  if (!run) return jsonError(404, "Run not found.");
  let approval;
  try {
    approval = await approveLampCombinedPlanForRun({
      run,
      presentedPlanHash: body.planHash,
      presentedControls: controls,
      presentedRelightIntensity: body.relightIntensity,
      approvedAt: Date.now(),
    });
  } catch (error) {
    return jsonError(
      409,
      error instanceof Error
        ? error.message
        : "The Combined plan could not be approved safely."
    );
  }

  // Mock drafts are provider-free. They may be reviewed through this endpoint
  // but can never acquire a live-spend grant or durable paid execution.
  if (run.live !== true) {
    const updated = { ...run, combinedPlan: approval.approvedPlan };
    await storage.putRun(updated);
    return NextResponse.json({
      ok: true,
      run: updated,
      mock: true,
      serverOwned: false,
    });
  }
  try {
    await assertLampCombinedPlannerJournals({
      runId: run.id,
      controls,
      plan: approval.approvedPlan,
    });
  } catch (error) {
    return jsonError(
      409,
      error instanceof Error
        ? error.message
        : "Completed Combined planner journals are required."
    );
  }

  // Fail before minting generation spend authorization.
  const syncIssue = v2SyncConfigIssue();
  if (syncIssue) {
    return jsonError(
      503,
      `Lamp Combined's final sync verification is not configured: ${syncIssue}`
    );
  }

  let updated;
  const spendApproval = createSpendApproval(
    run.originalVideo,
    "single",
    undefined,
    Date.now(),
    "combined_two_pass",
    controls
  );
  const write = await storage.approveLampCombinedRun(run.id, {
    expectedPlanHash: approval.approvedPlanHash,
    expectedDraftPlan: approval.alreadyApproved
      ? draftCopyOfCombinedPlan(approval.approvedPlan)
      : parseLampCombinedPlan(run.combinedPlan),
    approvedPlan: approval.approvedPlan,
    spendApproval,
  });
  if (write.ok) {
    updated = write.run;
  } else if (write.current) {
      // A concurrent identical click may have won with a different timestamp.
      // Re-validate the stored winner instead of restamping or replacing it.
      try {
        const concurrent = await approveLampCombinedPlanForRun({
          run: write.current,
          presentedPlanHash: body.planHash,
          presentedControls: controls,
          presentedRelightIntensity: body.relightIntensity,
          approvedAt: Date.now(),
        });
        if (
          !concurrent.alreadyApproved ||
          !hasReusableLampCombinedTwoPassApproval(write.current)
        ) {
          throw new Error("Concurrent approval did not preserve the exact grant.");
        }
        updated = write.current;
      } catch {
        return NextResponse.json(
          {
            error:
              "The Combined plan changed while approval was being saved. Reload the current aggregate before trying again.",
            run: write.current,
          },
          { status: 409 }
        );
      }
  } else {
    return jsonError(
      409,
      "The run disappeared while its Combined approval was being saved."
    );
  }

  const approvedPlan = parseLampCombinedPlan(updated.combinedPlan);

  const prompt = await initialLampCombinedMegaPrompt(
    approvedPlan,
    approval.relightIntensity
  );
  let launch;
  try {
    launch = await enqueueRunExecution({
      runId: updated.id,
      executionId: `lamp-combined:${updated.id}`,
      source: "single",
      renderedPrompt: prompt.rendered,
      combinedPlanOperationIds: approval.plannerOperationIds,
      approvedPlanHash: approval.approvedPlanHash,
      relightIntensity: approval.relightIntensity,
    });
  } catch (error) {
    console.error(
      "[combined-plan/approve] durable execution enqueue failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      {
        error:
          "The approved Combined plan was saved, but durable dispatch is temporarily unavailable. Retrying this exact approval reuses completed planner journals and cannot repeat paid planning.",
        run: updated,
      },
      { status: 502 }
    );
  }
  return NextResponse.json({
    ok: true,
    run: { ...updated, serverExecution: launch.execution },
    execution: launch.execution,
    costEstimate: estimateLampCombinedTwoPass(updated.originalVideo.durationSec),
    noOp: false,
    serverOwned: true,
  });
}
