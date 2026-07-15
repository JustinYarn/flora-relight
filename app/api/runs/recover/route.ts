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
import { enqueueRunExecution } from "@/lib/server/run-execution-coordinator";
import { reconcileDeadWorkflowExecution } from "@/lib/server/dead-workflow-recovery";
import {
  hasReusableFirstCutApproval,
  hasReusableLampApproval,
} from "@/lib/server/spend-approval";

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
        current.executionId !== `lamp:${body.runId}`))
  ) {
    return NextResponse.json(
      { error: "This run belongs to a different durable execution." },
      { status: 409 }
    );
  }
  // A "running" record whose Workflow run died from outside (operator
  // cancellation, engine loss) can never advance itself: recordExecutionFailure
  // only runs inside the workflow. Reconcile it here before the outbox logic,
  // which otherwise returns it unchanged forever.
  if (current?.status === "running") {
    try {
      const reconciled = await reconcileDeadWorkflowExecution(current, run);
      if (reconciled) {
        return NextResponse.json(
          { ok: true, execution: reconciled, enqueued: false },
          { headers: { "Cache-Control": "private, no-store, max-age=0" } }
        );
      }
    } catch (error) {
      // Best-effort adoption: a storage/API hiccup here must not break the
      // normal outbox path below. The next poll retries after the lease.
      console.error(
        "[runs/recover] dead-workflow reconciliation failed:",
        error instanceof Error ? error.message : error
      );
    }
  }

  if (
    (!current || current.status === "queued") &&
    !(
      current?.executionId.startsWith("lamp:") ||
      (!current && run.spendApproval?.scope === "lamp_two_pass")
        ? hasReusableLampApproval(run)
        : hasReusableFirstCutApproval(run, "single")
    )
  ) {
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
      (run.spendApproval?.scope === "lamp_two_pass"
        ? `lamp:${body.runId}`
        : `first-cut:${body.runId}`);
    const adopted = await enqueueRunExecution({
      runId: body.runId,
      executionId,
      source: "single",
      ...(current ? { renderedPrompt: current.renderedPrompt } : {}),
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
