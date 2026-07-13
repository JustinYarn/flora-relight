"use client";

/**
 * One clip on the batch review board. Renders live from the store while the
 * worker queue drains: queued → running (node states animate the badge) →
 * terminal, with gate-failure chips, confidence and fallback flags. Durable
 * first cuts route into the full grading workspace; mock runs retain the
 * lightweight inline approve action.
 */

import Link from "next/link";
import { Badge, Button, Card, ScoreMeter } from "@/components/ui";
import { getEvalDef } from "@/lib/prompts/eval-defs";
import { formatUsd } from "@/lib/cost";
import { LOW_CONFIDENCE } from "@/lib/util";
import { shippedVideo } from "@/components/library/derive";
import type { BatchExecutionMember, Run, Verdict } from "@/lib/types";

export type BoardStatus =
  | "queued"
  | "running"
  | "awaiting-review"
  | "graded"
  | "approved"
  | "needs-changes"
  | "failed"
  | "reconcile-required"
  | "skipped-budget";

const STATUS_META: Record<BoardStatus, { color: string; label: string }> = {
  queued: { color: "var(--faint)", label: "queued" },
  running: { color: "var(--running)", label: "running" },
  "awaiting-review": { color: "var(--borderline)", label: "needs your review" },
  graded: { color: "var(--pass)", label: "human grade saved" },
  approved: { color: "var(--pass)", label: "approved" },
  "needs-changes": { color: "var(--fail)", label: "needs changes" },
  failed: { color: "var(--fail)", label: "failed" },
  "reconcile-required": {
    color: "var(--borderline)",
    label: "needs reconciliation",
  },
  "skipped-budget": { color: "var(--faint)", label: "skipped by cap" },
};

/**
 * A batch run waiting for a worker slot is status "running" with every node
 * still idle — the board surfaces that as "queued".
 */
export function boardStatus(
  run: Run,
  member?: BatchExecutionMember
): BoardStatus {
  if (member?.state === "awaiting_review" && run.humanGrade) {
    return "graded";
  }
  if (
    member?.state === "awaiting_review" &&
    (run.status === "approved" || run.status === "needs-changes")
  ) {
    return run.status;
  }
  if (member?.state === "queued") return "queued";
  if (member?.state === "running") return "running";
  if (member?.state === "awaiting_review") return "awaiting-review";
  if (member?.state === "failed") return "failed";
  if (member?.state === "reconcile_required") return "reconcile-required";
  if (member?.state === "skipped_budget") return "skipped-budget";
  if (run.status === "running") {
    const untouched = Object.values(run.nodeStates).every(
      (n) => n.status === "idle"
    );
    return untouched ? "queued" : "running";
  }
  return run.status;
}

function compositeVerdict(
  composite: { score: number; passed: boolean },
  passThreshold: number
): Verdict {
  if (composite.passed) return "pass";
  // Score cleared the bar but a hard gate failed → borderline, else fail.
  return composite.score >= passThreshold ? "borderline" : "fail";
}

export function BatchRunCard({
  run,
  member,
  maxIterations,
  passThreshold,
  onApprove,
}: {
  run: Run;
  member?: BatchExecutionMember;
  maxIterations: number;
  passThreshold: number;
  onApprove: (runId: string) => void;
}) {
  const status = boardStatus(run, member);
  const meta = STATUS_META[status];

  const latest = run.iterations[run.iterations.length - 1];
  const latestScored = [...run.iterations].reverse().find((it) => it.composite);
  const composite = latestScored?.composite;

  const gateFailures =
    composite && !composite.passed ? composite.hardGateFailures : [];
  const lowConfidence = (latest?.evalResults ?? []).some(
    (r) => r.confidence < LOW_CONFIDENCE
  );
  const lastLog = run.log[run.log.length - 1];
  // Set by the store's worker queue when the batch budget cap stops dispatch.
  const budgetCapped = run.log.some((l) =>
    l.message.includes("batch budget reached")
  ) || member?.state === "skipped_budget";
  const preview = shippedVideo(run) ?? run.originalVideo;
  const displayedMaxIterations = member ? 1 : maxIterations;

  return (
    <Card className="flex flex-col gap-2.5 p-3">
      <video
        src={`${preview.url}#t=0.5`}
        muted
        playsInline
        preload="metadata"
        className="aspect-video w-full rounded-lg border border-edge bg-canvas object-cover"
      />

      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-ink" title={run.originalVideo.label}>
          {run.originalVideo.label}
        </span>
        <Badge color={meta.color}>{meta.label}</Badge>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-2xs tabular-nums text-faint">
          attempt {run.iterations.length}/{displayedMaxIterations}
        </span>
        {run.cost ? (
          <span
            className="text-2xs tabular-nums text-faint"
            title="est. live cost for this clip — mock mode spends $0"
          >
            est. {formatUsd(run.cost.estimatedUsd)}
          </span>
        ) : null}
        {budgetCapped ? (
          <Badge color="var(--borderline)">budget cap</Badge>
        ) : null}
        {run.fallback?.applied ? (
          <Badge color="var(--borderline)">
            <span title="safe fallback (lighting copied onto original pixels)">
              safe fallback
            </span>
          </Badge>
        ) : null}
        {lowConfidence ? (
          <Badge color="var(--borderline)">low confidence</Badge>
        ) : null}
      </div>

      {composite ? (
        <ScoreMeter
          score={composite.score}
          verdict={compositeVerdict(composite, passThreshold)}
        />
      ) : (
        <span className="text-2xs text-faint">
          {status === "awaiting-review" ? "ready for your grade" : "no score yet"}
        </span>
      )}

      {gateFailures.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {gateFailures.map((evalId) => (
            <Badge key={evalId} color="var(--fail)">
              <span title={`must-pass check failed (${evalId})`}>
                {getEvalDef(evalId).name}
              </span>
            </Badge>
          ))}
        </div>
      ) : null}

      {lastLog ? (
        <p className="truncate text-2xs text-faint" title={lastLog.message}>
          {lastLog.message}
        </p>
      ) : null}

      <div className="mt-auto flex items-center gap-2 pt-1">
        <Link
          href={`/runs/${run.id}`}
          className="inline-flex items-center rounded-lg border border-edge px-3.5 py-1.5 text-sm text-muted transition hover:border-faint hover:text-ink"
        >
          Open review
        </Link>
        {status === "awaiting-review" && member ? (
          <Link
            href="/grade"
            className="inline-flex min-h-10 items-center rounded-lg bg-pass px-3.5 py-1.5 text-sm font-medium text-canvas transition-transform active:scale-[0.96]"
          >
            Grade in workspace
          </Link>
        ) : status === "awaiting-review" ? (
          <Button variant="success" onClick={() => onApprove(run.id)}>
            Approve
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
