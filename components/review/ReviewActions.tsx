"use client";

import { useState } from "react";
import Link from "next/link";
import type { Run } from "@/lib/types";
import { Badge, Button } from "@/components/ui";
import { formatClock } from "@/lib/util";
import { isLampBlindGradeLocked } from "@/components/grade/derive";

/**
 * Bottom-right sticky cluster while the run awaits review; after the decision
 * it collapses to one quiet line replaying the recorded verdict.
 */
export function ReviewActions({
  run,
  onSubmit,
}: {
  run: Run;
  onSubmit: (decision: "approved" | "needs-changes", notes: string) => void;
}) {
  const [notes, setNotes] = useState("");

  if (run.serverExecution && run.humanGrade) {
    return (
      <p className="flex flex-wrap items-center justify-end gap-2 py-4 text-sm text-muted">
        <span className="text-2xs uppercase tracking-wider text-faint">
          Human grade saved
        </span>
        <Badge color="var(--pass)">complete</Badge>
        <span className="text-2xs text-faint">
          at {formatClock(run.humanGrade.gradedAt)}
        </span>
      </p>
    );
  }

  if (isLampBlindGradeLocked(run)) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-3 py-4">
        <span className="text-pretty text-2xs text-faint">
          The final video is ready. Grade it blind; available final AI results
          stay hidden until your grade is saved.
        </span>
        <Link
          href="/grade"
          className="inline-flex min-h-10 items-center rounded-lg bg-pass px-3.5 py-1.5 text-sm font-medium text-canvas transition-transform active:scale-[0.96]"
        >
          Grade in workspace
        </Link>
      </div>
    );
  }

  if (run.review) {
    return (
      <p className="flex flex-wrap items-center justify-end gap-2 py-4 text-sm text-muted">
        <span className="text-2xs uppercase tracking-wider text-faint">
          Review recorded
        </span>
        <Badge
          color={run.review.decision === "approved" ? "var(--pass)" : "var(--fail)"}
        >
          {run.review.decision === "approved" ? "approved" : "needs changes"}
        </Badge>
        <span className="text-2xs text-faint">at {formatClock(run.review.reviewedAt)}</span>
        {run.review.notes ? (
          <span className="min-w-0 max-w-md truncate" title={run.review.notes}>
            &ldquo;{run.review.notes}&rdquo;
          </span>
        ) : null}
      </p>
    );
  }

  if (run.status !== "awaiting-review") return null;

  return (
    <div className="sticky bottom-4 z-30 ml-auto flex w-full max-w-xl items-center gap-2 rounded-xl border border-edge bg-surface p-2 shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes for the record…"
        className="min-h-10 min-w-0 flex-1 rounded-lg bg-raised px-3 py-1.5 text-sm text-ink placeholder:text-faint focus:outline-none"
      />
      <Button variant="success" onClick={() => onSubmit("approved", notes)}>
        Approve
      </Button>
      <Button variant="danger" onClick={() => onSubmit("needs-changes", notes)}>
        Request changes
      </Button>
    </div>
  );
}
