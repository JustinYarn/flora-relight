"use client";

import { useState } from "react";
import type { Run } from "@/lib/types";
import { Badge, Button } from "@/components/ui";
import { formatClock } from "@/lib/util";

/**
 * Sticky bottom bar: capture the human verdict when a run is awaiting
 * review, or replay the recorded decision read-only afterwards.
 */
export function ReviewBar({
  run,
  onSubmit,
}: {
  run: Run;
  onSubmit: (decision: "approved" | "needs-changes", notes: string) => void;
}) {
  const [notes, setNotes] = useState("");

  if (run.review) {
    return (
      <div className="sticky bottom-0 z-20 -mx-6 border-t border-edge bg-surface px-6 py-3">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center gap-3">
          <span className="text-2xs uppercase tracking-wider text-faint">Human review</span>
          <Badge color={run.review.decision === "approved" ? "var(--pass)" : "var(--fail)"}>
            {run.review.decision === "approved" ? "approved" : "needs changes"}
          </Badge>
          <span className="text-2xs text-faint">at {formatClock(run.review.reviewedAt)}</span>
          <p className="min-w-0 flex-1 truncate text-sm text-muted" title={run.review.notes}>
            {run.review.notes ? run.review.notes : <span className="text-faint">no notes recorded</span>}
          </p>
        </div>
      </div>
    );
  }

  if (run.status !== "awaiting-review") return null;

  return (
    <div className="sticky bottom-0 z-20 -mx-6 border-t border-edge bg-surface px-6 py-3">
      <div className="mx-auto flex max-w-screen-2xl items-center gap-3">
        <span className="hidden shrink-0 text-2xs uppercase tracking-wider text-faint sm:block">
          Human review
        </span>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes for the record — what looks right, what to fix…"
          className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
        />
        <Button variant="success" onClick={() => onSubmit("approved", notes)}>
          Approve
        </Button>
        <Button variant="danger" onClick={() => onSubmit("needs-changes", notes)}>
          Request changes
        </Button>
      </div>
    </div>
  );
}
