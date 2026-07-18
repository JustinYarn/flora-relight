/**
 * POST /api/runs/recover — adopt an interrupted server-owned single run.
 *
 * The confirmation route persists the Run, its exact spend approval, and then
 * the RunExecution before submitting a Workflow contender. A function can be
 * killed between any two of those writes. This endpoint is the durable outbox
 * adopter used by hydration/detail polling:
 *
 * - approved Run with no execution -> create it and submit a contender
 * - queued execution with no Workflow -> submit another non-paid contender
 * - committed provider result with unfinished settlement -> repair settlement
 *
 * Workflow ownership and the paid-operation journal remain the exactly-once
 * boundaries, so retries here cannot create a second provider operation.
 */

import { NextRequest, NextResponse } from "next/server";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";
import {
  enqueueRunExecution,
  repairCompletedRunExecution,
} from "@/lib/server/run-execution-coordinator";
import { recoverStoppedWorkflowExecution } from "@/lib/server/dead-workflow-recovery";
import { COMBINED_COMPLETED_EVIDENCE_INCOMPLETE } from "@/lib/server/completed-workflow-recovery";
import {
  hasReusableFirstCutApproval,
  hasReusableLampBackgroundApproval,
  hasReusableLampBeautifyApproval,
  hasReusableLampIrisApproval,
  hasReusableLampApproval,
} from "@/lib/server/spend-approval";
import {
  hashLampBackgroundCleanupPlan,
  lampBackgroundPlanRequiresGeneration,
  parseLampBackgroundCleanupPlan,
} from "@/lib/lamp-background";
import { lampBackgroundPlanOperationId } from "@/lib/lamp-background-operations";
import { initialLampBackgroundMegaPrompt } from "@/lib/prompts/lamp-background";
import {
  hashLampBeautifyPlan,
  lampBeautifyPlanRequiresGeneration,
  parseLampBeautifyPlan,
} from "@/lib/lamp-beautify";
import { lampBeautifyPlanOperationId } from "@/lib/lamp-beautify-operations";
import { initialLampBeautifyMegaPrompt } from "@/lib/prompts/lamp-beautify";
import {
  hashLampIrisPlan,
  lampIrisPlanRequiresGeneration,
  parseLampIrisPlan,
} from "@/lib/lamp-iris";
import { lampIrisPlanOperationId } from "@/lib/lamp-iris-operations";
import { initialLampIrisMegaPrompt } from "@/lib/prompts/lamp-iris";
import {
  runWorkflowMode,
  workflowModeFromExecutionId,
} from "@/lib/workflow-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A newly submitted contender normally binds within seconds. Throttling the
// durable outbox retry prevents an open detail page from creating a stream of
// harmless-but-wasteful loser Workflows during a platform queue delay.
const ENQUEUE_RECOVERY_LEASE_MS = 30_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { runId?: unknown };
  try {
    body = (await req.json()) as { runId?: unknown };
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  if (!isValidRunId(body.runId)) {
    return NextResponse.json({ error: "A valid runId is required." }, { status: 400 });
  }

  const storage = getStorage();
  const [run, observedExecution] = await Promise.all([
    storage.getRun(body.runId),
    storage.getRunExecution(body.runId),
  ]);
  let current = observedExecution;
  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }
  if (
    !current &&
    (!run.spendApproval ||
      run.spendApproval.source !== "single" ||
      run.spendApproval.batchId !== undefined)
  ) {
    return NextResponse.json(
      { error: "This uploaded clip has not been approved for generation." },
      { status: 409 }
    );
  }
  if (
    current &&
    (current.source !== "single" ||
      current.batchId !== undefined ||
      (current.executionId !== `first-cut:${body.runId}` &&
        current.executionId !== `lamp:${body.runId}` &&
        current.executionId !== `lamp-background:${body.runId}` &&
        current.executionId !== `lamp-beautify:${body.runId}` &&
        current.executionId !== `lamp-iris:${body.runId}` &&
        current.executionId !== `lamp-combined:${body.runId}`))
  ) {
    return NextResponse.json(
      { error: "This run belongs to a different durable execution." },
      { status: 409 }
    );
  }
  const workflowMode = current
    ? workflowModeFromExecutionId(current.executionId)
    : runWorkflowMode(run);
  // A "running" record whose Workflow is terminal can never advance itself:
  // external death uses the existing fail-closed reconciler, while terminal
  // Combined completion gets one exact-proof settlement-only repair. Do this
  // before the outbox logic, which would otherwise leave it unchanged forever.
  if (current?.status === "running") {
    const running = current;
    try {
      const recovered = await recoverStoppedWorkflowExecution(
        running,
        run,
        workflowMode === "combined"
          ? {
              repairCompletedCombined: () =>
                repairCompletedRunExecution({
                  runId: running.runId,
                  executionId: running.executionId,
                  source: running.source,
                  renderedPrompt: running.renderedPrompt,
                  ...(running.combinedPlanOperationIds
                    ? {
                        combinedPlanOperationIds:
                          running.combinedPlanOperationIds,
                      }
                    : {}),
                  ...(running.approvedPlanHash
                    ? { approvedPlanHash: running.approvedPlanHash }
                    : {}),
                }),
            }
          : undefined
      );
      if (recovered?.outcome === "evidence_incomplete") {
        return NextResponse.json(
          {
            code: "COMBINED_SETTLEMENT_EVIDENCE_INCOMPLETE",
            error:
              recovered.execution?.error ??
              COMBINED_COMPLETED_EVIDENCE_INCOMPLETE,
            execution: recovered.execution,
            enqueued: false,
          },
          {
            status: 409,
            headers: { "Cache-Control": "private, no-store, max-age=0" },
          }
        );
      }
      if (recovered && recovered.outcome !== "changed") {
        return NextResponse.json(
          {
            ok: true,
            execution: recovered.execution,
            enqueued: false,
          },
          { headers: { "Cache-Control": "private, no-store, max-age=0" } }
        );
      }
      if (recovered?.execution) current = recovered.execution;
    } catch (error) {
      // Best-effort adoption: a storage/API hiccup here must not break the
      // normal outbox path below. The next poll retries after the lease.
      console.error(
        "[runs/recover] dead-workflow reconciliation failed:",
        error instanceof Error ? error.message : error
      );
    }
  }
  if (workflowMode === "combined") {
    return NextResponse.json(
      {
        code: "COMBINED_RECOVERY_UNSUPPORTED",
        error:
          "Lamp Combined automatic replay is paused because safe adoption must reconstruct the exact aggregate plan, enabled planner journals, and source-rooted prompts together. Liveness was checked, the saved run was left intact, and no provider work was restarted.",
      },
      {
        status: 409,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      }
    );
  }

  const reusableApproval =
    workflowMode === "background"
      ? hasReusableLampBackgroundApproval(run)
      : workflowMode === "beautify"
        ? hasReusableLampBeautifyApproval(run)
        : workflowMode === "iris"
          ? hasReusableLampIrisApproval(run)
          : workflowMode === "lamp"
            ? hasReusableLampApproval(run)
            : hasReusableFirstCutApproval(run, "single");
  if ((!current || current.status === "queued") && !reusableApproval) {
    return NextResponse.json(
      {
        error:
          "This run's generation approval expired or no longer matches its saved source. Re-open the spend confirmation to continue.",
      },
      {
        status: 409,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      }
    );
  }

  if (current?.status === "queued") {
    const now = Date.now();
    if (now - current.updatedAt < ENQUEUE_RECOVERY_LEASE_MS) {
      return NextResponse.json(
        { ok: true, execution: current, enqueued: false },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } }
      );
    }
    const claim = await storage.advanceRunExecution(
      {
        ...current,
        revision: current.revision + 1,
        updatedAt: Math.max(now, current.updatedAt),
      },
      current.revision
    );
    if (!claim.advanced || !claim.execution) {
      return NextResponse.json(
        { ok: true, execution: claim.execution ?? current, enqueued: false },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } }
      );
    }
    current = claim.execution;
  }

  try {
    const executionId =
      current?.executionId ??
      (workflowMode === "background"
        ? `lamp-background:${body.runId}`
        : workflowMode === "beautify"
          ? `lamp-beautify:${body.runId}`
          : workflowMode === "iris"
            ? `lamp-iris:${body.runId}`
            : workflowMode === "lamp"
              ? `lamp:${body.runId}`
              : `first-cut:${body.runId}`);
    let renderedPrompt = current?.renderedPrompt;
    let planOperationId = current?.planOperationId;
    let approvedPlanHash = current?.approvedPlanHash;
    if (workflowMode === "background" && !current) {
      let cleanupPlan: ReturnType<
        typeof parseLampBackgroundCleanupPlan
      >;
      try {
        cleanupPlan = parseLampBackgroundCleanupPlan(
          run.backgroundCleanupPlan
        );
      } catch {
        return NextResponse.json(
          {
            error:
              "Lamp Background recovery requires a valid approved cleanup plan for this source.",
          },
          {
            status: 409,
            headers: {
              "Cache-Control": "private, no-store, max-age=0",
            },
          }
        );
      }
      if (
        cleanupPlan.approval.status !== "approved" ||
        cleanupPlan.runId !== run.id ||
        !lampBackgroundPlanRequiresGeneration(cleanupPlan)
      ) {
        return NextResponse.json(
          {
            error:
              "Lamp Background recovery requires the exact approved cleanup plan for this source.",
          },
          {
            status: 409,
            headers: {
              "Cache-Control": "private, no-store, max-age=0",
            },
          }
        );
      }
      renderedPrompt = initialLampBackgroundMegaPrompt(cleanupPlan).rendered;
      planOperationId = lampBackgroundPlanOperationId();
      approvedPlanHash =
        await hashLampBackgroundCleanupPlan(cleanupPlan);
    }
    if (workflowMode === "beautify" && !current) {
      let beautifyPlan: ReturnType<typeof parseLampBeautifyPlan>;
      try {
        beautifyPlan = parseLampBeautifyPlan(run.beautifyPlan);
      } catch {
        return NextResponse.json(
          {
            error:
              "Lamp Beautify recovery requires a valid approved enhancement plan for this source.",
          },
          {
            status: 409,
            headers: {
              "Cache-Control": "private, no-store, max-age=0",
            },
          }
        );
      }
      if (
        beautifyPlan.approval.status !== "approved" ||
        beautifyPlan.runId !== run.id ||
        !lampBeautifyPlanRequiresGeneration(beautifyPlan)
      ) {
        return NextResponse.json(
          {
            error:
              "Lamp Beautify recovery requires the exact approved enhancement plan for this source.",
          },
          {
            status: 409,
            headers: {
              "Cache-Control": "private, no-store, max-age=0",
            },
          }
        );
      }
      renderedPrompt = initialLampBeautifyMegaPrompt(beautifyPlan).rendered;
      planOperationId = lampBeautifyPlanOperationId();
      approvedPlanHash = await hashLampBeautifyPlan(beautifyPlan);
    }
    if (workflowMode === "iris" && !current) {
      let irisPlan: ReturnType<typeof parseLampIrisPlan>;
      try {
        irisPlan = parseLampIrisPlan(run.irisPlan);
      } catch {
        return NextResponse.json(
          {
            error:
              "Lamp Iris recovery requires a valid approved gaze plan for this source.",
          },
          {
            status: 409,
            headers: {
              "Cache-Control": "private, no-store, max-age=0",
            },
          }
        );
      }
      if (
        irisPlan.approval.status !== "approved" ||
        irisPlan.runId !== run.id ||
        !lampIrisPlanRequiresGeneration(irisPlan)
      ) {
        return NextResponse.json(
          {
            error:
              "Lamp Iris recovery requires the exact approved gaze plan for this source.",
          },
          {
            status: 409,
            headers: {
              "Cache-Control": "private, no-store, max-age=0",
            },
          }
        );
      }
      renderedPrompt = initialLampIrisMegaPrompt(irisPlan).rendered;
      planOperationId = lampIrisPlanOperationId();
      approvedPlanHash = await hashLampIrisPlan(irisPlan);
    }
    const adopted = await enqueueRunExecution({
      runId: body.runId,
      executionId,
      source: "single",
      ...(renderedPrompt ? { renderedPrompt } : {}),
      ...(planOperationId ? { planOperationId } : {}),
      ...(approvedPlanHash ? { approvedPlanHash } : {}),
    });
    return NextResponse.json(
      {
        ok: true,
        execution: adopted.execution,
        enqueued: adopted.enqueued,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } }
    );
  } catch (error) {
    console.error(
      "[runs/recover] durable single-run adoption failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      {
        error:
          "Durable run dispatch is temporarily unavailable. This saved run will retry automatically; existing provider work will not be repeated.",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "Retry-After": "4",
        },
      }
    );
  }
}
