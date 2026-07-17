/**
 * /api/grade-drafts — durable, revision-checked blind-grading working memory.
 *
 * GET    ?id=<draftId>                           → { draft }
 * PUT    { draft, expectedRevision }             → { draft }
 * DELETE ?id=<draftId>&expectedRevision=<number> → { ok, existed }
 *
 * Revisions are compare-and-swap tokens. A stale write/delete returns 409 and
 * the current server document; it never replaces newer work from another tab.
 */

import { NextRequest, NextResponse } from "next/server";
import type {
  GradeClipDraft,
  GradeDraft,
  GradeDraftAnswer,
} from "@/lib/types";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { LAMP_BACKGROUND_EVAL_IDS } from "@/lib/lamp-background-evaluation";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_DRAFT_ID = "default";
const MAX_CLIPS = 5_000;
const MAX_NOTE_LENGTH = 4_000;
const MAX_OVERALL_NOTE_LENGTH = 8_000;
const EVAL_IDS = new Set([
  ...EVAL_DEFS.map((definition) => definition.id),
  ...LAMP_BACKGROUND_EVAL_IDS,
]);

function noStoreJson(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseDraftId(value: string | null): string | null {
  const id = value ?? DEFAULT_DRAFT_ID;
  return isValidRunId(id) ? id : null;
}

function parseAnswer(value: unknown): GradeDraftAnswer | null {
  if (!isRecord(value)) return null;
  const points = value.points;
  const note = value.note;
  if (
    !Number.isInteger(points) ||
    (points as number) < 1 ||
    (points as number) > 5 ||
    typeof note !== "string" ||
    note.length > MAX_NOTE_LENGTH
  ) {
    return null;
  }
  return {
    points: points as GradeDraftAnswer["points"],
    note,
  };
}

function parseClipDraft(value: unknown): GradeClipDraft | null {
  if (!isRecord(value) || !isRecord(value.answers)) return null;
  const answerEntries = Object.entries(value.answers);
  if (answerEntries.length > EVAL_IDS.size) return null;

  const answers: Record<string, GradeDraftAnswer> = {};
  for (const [evalId, candidate] of answerEntries) {
    if (!EVAL_IDS.has(evalId)) return null;
    const answer = parseAnswer(candidate);
    if (!answer) return null;
    answers[evalId] = answer;
  }

  if (
    typeof value.overallNote !== "string" ||
    value.overallNote.length > MAX_OVERALL_NOTE_LENGTH ||
    (value.shipIt !== undefined && typeof value.shipIt !== "boolean")
  ) {
    return null;
  }

  return {
    answers,
    ...(typeof value.shipIt === "boolean" ? { shipIt: value.shipIt } : {}),
    overallNote: value.overallNote,
  };
}

/** Validate untrusted JSON and rebuild a prototype-free, server-owned draft. */
function parseDraft(value: unknown, expectedRevision: number): GradeDraft | null {
  if (!isRecord(value) || !isValidRunId(value.id) || !isRecord(value.clips)) {
    return null;
  }

  const clipEntries = Object.entries(value.clips);
  if (clipEntries.length > MAX_CLIPS) return null;
  const clips: Record<string, GradeClipDraft> = {};
  for (const [runId, candidate] of clipEntries) {
    if (!isValidRunId(runId)) return null;
    const clip = parseClipDraft(candidate);
    if (!clip) return null;
    clips[runId] = clip;
  }

  if (!Array.isArray(value.skippedRunIds) || value.skippedRunIds.length > MAX_CLIPS) {
    return null;
  }
  const skippedRunIds: string[] = [];
  const seen = new Set<string>();
  for (const runId of value.skippedRunIds) {
    if (!isValidRunId(runId)) return null;
    if (!seen.has(runId)) {
      seen.add(runId);
      skippedRunIds.push(runId);
    }
  }

  if (value.currentRunId !== undefined && !isValidRunId(value.currentRunId)) {
    return null;
  }

  return {
    id: value.id,
    // These are overwritten by the storage driver after the CAS succeeds.
    revision: expectedRevision,
    updatedAt: 0,
    clips,
    skippedRunIds,
    ...(typeof value.currentRunId === "string"
      ? { currentRunId: value.currentRunId }
      : {}),
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const id = parseDraftId(req.nextUrl.searchParams.get("id"));
  if (!id) return noStoreJson({ error: "Invalid draft id." }, { status: 400 });
  const draft = await getStorage().getGradeDraft(id);
  return noStoreJson({ draft });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return noStoreJson({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!isRecord(body) || !isRevision(body.expectedRevision)) {
    return noStoreJson(
      { error: "Expected body { draft, expectedRevision } with a non-negative revision." },
      { status: 400 }
    );
  }

  const draft = parseDraft(body.draft, body.expectedRevision);
  if (!draft) {
    return noStoreJson({ error: "Invalid grading draft." }, { status: 400 });
  }

  const result = await getStorage().putGradeDraft(draft, body.expectedRevision);
  if (!result.ok) {
    return noStoreJson(
      { error: "revision_conflict", current: result.current },
      { status: 409 }
    );
  }
  return noStoreJson({ draft: result.draft });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const id = parseDraftId(req.nextUrl.searchParams.get("id"));
  const rawRevision = req.nextUrl.searchParams.get("expectedRevision");
  const expectedRevision = rawRevision === null ? Number.NaN : Number(rawRevision);
  if (!id || !isRevision(expectedRevision)) {
    return noStoreJson(
      { error: "A valid id and non-negative expectedRevision are required." },
      { status: 400 }
    );
  }

  const result = await getStorage().deleteGradeDraft(id, expectedRevision);
  if (!result.ok) {
    return noStoreJson(
      { error: "revision_conflict", current: result.current },
      { status: 409 }
    );
  }
  return noStoreJson({ ok: true, id, existed: result.existed });
}
