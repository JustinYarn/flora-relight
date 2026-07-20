import { NextRequest, NextResponse } from "next/server";

import { estimateLampChainSequence } from "@/lib/cost";
import {
  lampChainCombinedControls,
  parseLampChainControls,
  type LampChainControls,
} from "@/lib/lamp-chain";
import { lampChainPlanOperationIds } from "@/lib/lamp-chain-operations";
import { buildLampChainPromptEnvelope } from "@/lib/prompts/lamp-chain";
import { approveLampChainPlanForRun } from "@/lib/server/lamp-chain-approval";
import { assertLampChainPlannerJournals } from "@/lib/server/lamp-chain-planner";
import { enqueueRunExecution } from "@/lib/server/run-execution-coordinator";
import {
  createSpendApproval,
  hasReusableLampChainApproval,
} from "@/lib/server/spend-approval";
import { getStorage } from "@/lib/server/storage";
import { isValidRunId } from "@/lib/server/runstore";
import { LAMP_CHAIN_EXECUTION_PREFIX } from "@/lib/workflow-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
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
      "approveLiveSpend must be true to start the approved Chain sequence."
    );
  }
  let controls: LampChainControls;
  try {
    controls = parseLampChainControls(body.controls);
  } catch (error) {
    return jsonError(
      400,
      error instanceof Error ? error.message : "Chain controls are invalid."
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
    approval = await approveLampChainPlanForRun(run.id, {
      presentedPlanHash: body.planHash,
      controls,
      relightIntensity: body.relightIntensity,
    });
  } catch (error) {
    return jsonError(
      409,
      error instanceof Error
        ? error.message
        : "The Chain plan could not be approved safely."
    );
  }

  // Mock drafts are provider-free. They may be reviewed through this endpoint
  // but can never acquire a live-spend grant or durable paid execution.
  if (run.live !== true) {
    return NextResponse.json({
      ok: true,
      run: approval.run,
      mock: true,
      serverOwned: false,
    });
  }
  try {
    await assertLampChainPlannerJournals({
      runId: run.id,
      controls,
      plan: approval.approvedPlan,
    });
  } catch (error) {
    return jsonError(
      409,
      error instanceof Error
        ? error.message
        : "Completed Chain planner journals are required."
    );
  }

  // Deliberately no v2SyncConfigIssue gate here: Chain treats SyncNet as a
  // detached post-delivery measurement, never a delivery gate.

  // A concurrent identical click may already hold the exact chain-sequence
  // grant; reuse it instead of restamping. Stage order binds through the
  // order-bearing plan hash on the execution record, not the approval.
  let updated = approval.run;
  if (!hasReusableLampChainApproval(updated)) {
    const withSpend = await storage.putCanonicalRunSource(
      updated.id,
      updated.originalVideo,
      createSpendApproval(
        updated.originalVideo,
        "single",
        undefined,
        Date.now(),
        "chain_sequence",
        lampChainCombinedControls(controls)
      )
    );
    if (!withSpend) {
      return jsonError(
        409,
        "The run disappeared while its Chain approval was being saved."
      );
    }
    updated = withSpend;
  }

  // The serialized envelope IS the frozen prompt record for the whole chain.
  const renderedPrompt = JSON.stringify(
    buildLampChainPromptEnvelope(approval.approvedPlan, approval.relightIntensity)
  );
  const executionId = `${LAMP_CHAIN_EXECUTION_PREFIX}${updated.id}`;
  let launch;
  try {
    launch = await enqueueRunExecution({
      runId: updated.id,
      executionId,
      source: "single",
      renderedPrompt,
      combinedPlanOperationIds: lampChainPlanOperationIds(controls),
      approvedPlanHash: approval.approvedPlanHash,
      relightIntensity: approval.relightIntensity,
    });
  } catch (error) {
    console.error(
      "[chain-plan/approve] durable execution enqueue failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      {
        error:
          "The approved Chain plan was saved, but durable dispatch is temporarily unavailable. Retrying this exact approval reuses completed planner journals and cannot repeat paid planning.",
        run: updated,
      },
      { status: 502 }
    );
  }
  return NextResponse.json({
    ok: true,
    run: { ...updated, serverExecution: launch.execution },
    execution: launch.execution,
    executionId,
    plannerOperationIds: approval.plannerOperationIds,
    alreadyApproved: approval.alreadyApproved,
    costEstimate: estimateLampChainSequence(
      controls,
      updated.originalVideo.durationSec
    ),
    noOp: false,
    serverOwned: true,
  });
}
