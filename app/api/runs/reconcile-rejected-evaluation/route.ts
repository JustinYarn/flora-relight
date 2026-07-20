/**
 * Human/operator acknowledgment for one synchronous Gemini judge request that
 * was definitively rejected or returned Gemini's explicit retryable 503
 * UNAVAILABLE capacity response.
 *
 * The route never calls a provider and never authorizes spend. It archives the
 * exact sealed journal, withdraws the prior approval, and pauses the same
 * Combined execution for a fresh exact confirmation. Completed planners and
 * video generations keep their canonical ids and replay from cache.
 */

import { NextRequest, NextResponse } from "next/server";

import { isReplayableLampCombinedEvaluationFailure } from "@/lib/server/definitive-provider-rejection";
import { lampCombinedEvaluationOperationId } from "@/lib/lamp-combined-operations";
import { rejectedPaidOperationArchiveId } from "@/lib/server/rejected-paid-operation-archive";
import {
  acknowledgeRejectedLampCombinedEvaluation,
  isAcknowledgedRejectedEvaluationError,
} from "@/lib/server/run-execution-resume";
import { getStorage } from "@/lib/server/storage";
import { isValidRunId } from "@/lib/server/runstore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { runId?: unknown; inputHash?: unknown; startedAt?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!isValidRunId(body.runId)) {
    return NextResponse.json(
      { error: "A valid runId is required." },
      { status: 400 }
    );
  }
  if (typeof body.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(body.inputHash)) {
    return NextResponse.json(
      { error: "The exact rejected evaluation inputHash is required." },
      { status: 400 }
    );
  }
  if (
    typeof body.startedAt !== "number" ||
    !Number.isSafeInteger(body.startedAt) ||
    body.startedAt < 0
  ) {
    return NextResponse.json(
      { error: "The exact rejected evaluation startedAt is required." },
      { status: 400 }
    );
  }

  const storage = getStorage();
  const [run, execution] = await Promise.all([
    storage.getRun(body.runId),
    storage.getRunExecution(body.runId),
  ]);
  if (!run || !execution) {
    return NextResponse.json(
      { error: "Run or its durable execution was not found." },
      { status: 404, headers: NO_STORE }
    );
  }
  if (
    run.live !== true ||
    execution.executionId !== `lamp-combined:${body.runId}` ||
    execution.source !== "single" ||
    execution.batchId !== undefined ||
    execution.phase !== "evaluating" ||
    (execution.iteration !== 1 && execution.iteration !== 2)
  ) {
    return NextResponse.json(
      { error: "Only a live single-run Combined evaluation can be recovered here." },
      { status: 409, headers: NO_STORE }
    );
  }

  const operationId = lampCombinedEvaluationOperationId(execution.iteration);
  const archivedOperationId = rejectedPaidOperationArchiveId(
    operationId,
    body.inputHash,
    body.startedAt
  );
  const [operation, archivedOperation] = await Promise.all([
    storage.getPaidOperation(body.runId, operationId),
    storage.getPaidOperation(body.runId, archivedOperationId),
  ]);

  if (
    execution.status === "user_action_required" &&
    isAcknowledgedRejectedEvaluationError(execution.error) &&
    archivedOperation?.inputHash === body.inputHash &&
    archivedOperation.startedAt === body.startedAt
  ) {
    return NextResponse.json(
      { ok: true, execution, acknowledged: false, archivedOperationId },
      { headers: NO_STORE }
    );
  }
  if (execution.status !== "reconcile_required") {
    return NextResponse.json(
      { error: "This execution is not awaiting evaluation reconciliation." },
      { status: 409, headers: NO_STORE }
    );
  }

  const rejected = operation ?? archivedOperation;
  if (
    !rejected ||
    rejected.inputHash !== body.inputHash ||
    rejected.startedAt !== body.startedAt ||
    rejected.provider !== "gemini" ||
    rejected.kind !== "judge" ||
    rejected.iteration !== execution.iteration ||
    rejected.status !== "reconcile_required" ||
    !isReplayableLampCombinedEvaluationFailure(rejected.error)
  ) {
    return NextResponse.json(
      {
        error:
          "The saved judge journal is not an exact replayable Gemini request failure. It remains sealed for manual reconciliation.",
      },
      { status: 409, headers: NO_STORE }
    );
  }

  try {
    const superseded = await storage.supersedeDefinitiveRejectedPaidOperation(
      body.runId,
      {
        operationId,
        archivedOperationId,
        inputHash: body.inputHash,
        startedAt: body.startedAt,
        expectedError: rejected.error!,
      }
    );
    if (!superseded.superseded) {
      return NextResponse.json(
        {
          error:
            "The rejected judge journal changed while recovery was being saved. Reload the run and inspect its current evidence.",
        },
        { status: 409, headers: NO_STORE }
      );
    }

    const candidate = acknowledgeRejectedLampCombinedEvaluation(
      execution,
      { operationId, inputHash: body.inputHash }
    );
    const advanced = await storage.advanceRunExecution(
      candidate,
      execution.revision
    );
    const durable = advanced.execution;
    if (durable?.status === "user_action_required") {
      return NextResponse.json(
        {
          ok: true,
          execution: durable,
          acknowledged: advanced.advanced,
          archivedOperationId,
        },
        { headers: NO_STORE }
      );
    }
    return NextResponse.json(
      {
        error:
          "The execution changed while the rejection was being acknowledged. Reload the run to see its current state.",
        execution: durable ?? execution,
      },
      { status: 409, headers: NO_STORE }
    );
  } catch (error) {
    console.error(
      "[runs/reconcile-rejected-evaluation] acknowledgment failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      {
        error:
          "The failed evaluation could not be archived safely. No provider result was accepted; retry after storage is reachable.",
      },
      { status: 503, headers: { ...NO_STORE, "Retry-After": "4" } }
    );
  }
}
