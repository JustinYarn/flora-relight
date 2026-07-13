/** Read one durable video Workflow status without holding a long request. */

import { NextRequest, NextResponse } from "next/server";
import { getRun as getWorkflowRun } from "workflow/api";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";
import {
  markVideoGenerationWorkflowError,
  videoGenerationOperationId,
  writeVideoGenerationOperation,
  type PollVideoGenerationResult,
} from "@/lib/server/videogen-operation";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  runId?: unknown;
  iteration?: unknown;
  workflowRunId?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (!isValidRunId(body.runId)) {
    return NextResponse.json({ error: "Invalid runId." }, { status: 400 });
  }
  if (
    typeof body.iteration !== "number" ||
    !Number.isInteger(body.iteration) ||
    body.iteration < 1
  ) {
    return NextResponse.json(
      { error: "iteration must be a positive integer." },
      { status: 400 }
    );
  }
  if (typeof body.workflowRunId !== "string" || body.workflowRunId.length === 0) {
    return NextResponse.json({ error: "Missing workflowRunId." }, { status: 400 });
  }

  const runId = body.runId;
  const iteration = body.iteration;
  const operationId = videoGenerationOperationId(iteration);
  const appRun = await getStorage().getRun(runId);
  const operation = appRun?.providerOperations?.find((item) => item.id === operationId);
  if (!appRun || operation?.workflowRunId !== body.workflowRunId) {
    return NextResponse.json({ error: "Workflow execution not found." }, { status: 404 });
  }
  if (
    operation.status === "completed" &&
    operation.result &&
    operation.providerInteractionId
  ) {
    return NextResponse.json({
      done: true,
      status: "completed",
      interactionId: operation.providerInteractionId,
      ...operation.result,
    });
  }

  try {
    const workflowRun = getWorkflowRun<
      Extract<PollVideoGenerationResult, { done: true }>
    >(body.workflowRunId);
    if (!(await workflowRun.exists)) {
      return NextResponse.json({ error: "Workflow execution not found." }, { status: 404 });
    }
    const status = await workflowRun.status;
    await writeVideoGenerationOperation(runId, {
      ...operation,
      workflowStatus: status,
      updatedAt: Date.now(),
    });

    if (status === "completed") {
      return NextResponse.json(await workflowRun.returnValue);
    }
    if (status === "failed" || status === "cancelled") {
      await markVideoGenerationWorkflowError(
        runId,
        iteration,
        `Video workflow ended with status ${status}.`
      );
      return NextResponse.json(
        { error: `Video generation workflow ${status}.` },
        { status: 502 }
      );
    }
    return NextResponse.json({ done: false, status });
  } catch (error) {
    console.error(
      "[live/videogen/poll] failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      { error: "Video generation status could not be read safely." },
      { status: 502 }
    );
  }
}
