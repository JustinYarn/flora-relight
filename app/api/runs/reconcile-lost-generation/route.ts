/**
 * POST /api/runs/reconcile-lost-generation — human acknowledgment that the
 * provider permanently lost a video-generation interaction (every
 * interactions.get returns 400/404 until the durable journal sealed itself
 * as reconcile_required).
 *
 * This endpoint never talks to the provider and never authorizes spend. It
 * performs exactly two durable writes:
 *
 *   1. archive the sealed journal entry under a superseded id (it keeps
 *      status reconcile_required forever as evidence of a possibly unknown
 *      upstream charge) and withdraw the run's spend approval;
 *   2. move the execution from reconcile_required into the existing
 *      paused-for-approval state.
 *
 * The replacement generation then follows the normal renewal flow: a fresh
 * explicit spend confirmation re-queues the execution, completed provider
 * journals replay as cache hits, and the freed operation id is claimed once
 * with a fresh provider interaction. Nothing can be re-billed silently.
 *
 * The caller must echo the exact lost providerInteractionId so a stale tab
 * cannot acknowledge a journal it has not seen.
 */

import { NextRequest, NextResponse } from "next/server";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";
import { videoGenerationOperationId } from "@/lib/server/videogen-operation";
import {
  isProviderLostInteraction,
  isProviderLostInteractionError,
} from "@/lib/server/run-execution-failure";
import {
  acknowledgeLostLampGeneration,
  isAcknowledgedLostGenerationError,
} from "@/lib/server/run-execution-resume";
import { lostGenerationArchiveId } from "@/lib/server/lost-generation-archive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { runId?: unknown; interactionId?: unknown };
  try {
    body = (await req.json()) as { runId?: unknown; interactionId?: unknown };
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!isValidRunId(body.runId)) {
    return NextResponse.json(
      { error: "A valid runId is required." },
      { status: 400 }
    );
  }
  if (
    typeof body.interactionId !== "string" ||
    body.interactionId.length === 0 ||
    body.interactionId.length > 256
  ) {
    return NextResponse.json(
      { error: "The exact lost interactionId must be echoed back." },
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
      { status: 404 }
    );
  }
  if (
    execution.executionId !== `lamp:${body.runId}` ||
    execution.source !== "single" ||
    execution.batchId !== undefined
  ) {
    return NextResponse.json(
      {
        error:
          "Only a single-run Lamp execution can acknowledge a lost generation here.",
      },
      { status: 409, headers: NO_STORE }
    );
  }
  if (
    execution.status === "user_action_required" &&
    isAcknowledgedLostGenerationError(execution.error)
  ) {
    // A lost response after a completed acknowledgment retries here.
    return NextResponse.json(
      { ok: true, execution, acknowledged: false },
      { headers: NO_STORE }
    );
  }
  if (
    execution.status !== "reconcile_required" ||
    !isProviderLostInteractionError(execution.error)
  ) {
    return NextResponse.json(
      {
        error:
          "This execution is not stopped on a provider-lost generation; nothing was changed.",
      },
      { status: 409, headers: NO_STORE }
    );
  }

  const operationId = videoGenerationOperationId(execution.iteration);
  const archivedOperationId = lostGenerationArchiveId(
    operationId,
    body.interactionId
  );
  const operation = run.providerOperations?.find(
    (item) => item.id === operationId
  );
  const alreadyArchived = run.providerOperations?.some(
    (item) => item.id === archivedOperationId
  );
  if (operation) {
    if (
      !isProviderLostInteraction(operation) ||
      operation.providerInteractionId !== body.interactionId
    ) {
      return NextResponse.json(
        {
          error:
            "The saved generation journal does not match this acknowledgment. Reload the run and review the current provider evidence.",
        },
        { status: 409, headers: NO_STORE }
      );
    }
  } else if (!alreadyArchived) {
    return NextResponse.json(
      { error: "No lost generation journal exists for this run." },
      { status: 409, headers: NO_STORE }
    );
  }

  try {
    const superseded = await storage.supersedeLostVideoGeneration(body.runId, {
      operationId,
      archivedOperationId,
      providerInteractionId: body.interactionId,
    });
    if (!superseded.superseded) {
      return NextResponse.json(
        {
          error:
            "The generation journal changed while this acknowledgment was in flight. Reload the run and try again.",
        },
        { status: 409, headers: NO_STORE }
      );
    }

    const candidate = acknowledgeLostLampGeneration(execution);
    const advanced = await storage.advanceRunExecution(
      candidate,
      execution.revision
    );
    const durable = advanced.execution;
    if (durable?.status === "user_action_required") {
      return NextResponse.json(
        { ok: true, execution: durable, acknowledged: advanced.advanced },
        { headers: NO_STORE }
      );
    }
    return NextResponse.json(
      {
        error:
          "The execution changed while the loss was being acknowledged. Reload the run to see its current state.",
        execution: durable ?? execution,
      },
      { status: 409, headers: NO_STORE }
    );
  } catch (error) {
    console.error(
      "[runs/reconcile-lost-generation] acknowledgment failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      {
        error:
          "The acknowledgment could not be persisted. Nothing was re-billed; retry when storage is reachable.",
      },
      { status: 503, headers: { ...NO_STORE, "Retry-After": "4" } }
    );
  }
}
