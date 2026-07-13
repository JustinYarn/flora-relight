import { NextRequest, NextResponse } from "next/server";
import { getRun, start } from "workflow/api";
import {
  durabilitySmoke,
  type DurabilitySmokeResult,
} from "@/workflows/durability-smoke";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function enabled(): boolean {
  return process.env.FLORA_WORKFLOW_SMOKE_ENABLED === "1";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!enabled()) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = body?.token;
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(token)) {
    return NextResponse.json({ error: "Invalid token." }, { status: 400 });
  }
  const workflowRun = await start(durabilitySmoke, [token]);
  return NextResponse.json({ workflowRunId: workflowRun.runId }, { status: 202 });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!enabled()) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const workflowRunId = req.nextUrl.searchParams.get("id");
  if (!workflowRunId) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }
  const workflowRun = getRun<DurabilitySmokeResult>(workflowRunId);
  if (!(await workflowRun.exists)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const status = await workflowRun.status;
  return NextResponse.json({
    status,
    ...(status === "completed" ? { result: await workflowRun.returnValue } : {}),
  });
}
