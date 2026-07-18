"use client";

import type { Iteration, Run } from "@/lib/types";
import {
  isApprovedPlanNoOp,
  isTwoPassWorkflowMode,
  runWorkflowMode,
} from "@/lib/workflow-mode";
import {
  DELIVERED_ATTEMPT_KEY,
  reviewAttemptKey,
  reviewAttemptLabel,
} from "@/components/review/attempt-selection";

function dotColor(status: Iteration["status"]): string {
  return status === "running"
    ? "var(--running)"
    : status === "ungraded"
      ? "var(--borderline)"
    : status === "passed"
      ? "var(--pass)"
      : "var(--fail)";
}

/** Each Lamp method exposes its two meaningful outputs; legacy extra
 * iterations remain inspectable by their version number. */
export function AttemptSwitcher({
  run,
  activeKey,
  onSelect,
}: {
  run: Run;
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  const workflowMode = runWorkflowMode(run);
  const combined = workflowMode === "combined";
  if (run.iterations.length === 0) {
    return (
      <p className="text-2xs text-faint">
        {combined
          ? "Take 1 in progress — preparing the approved-plan prompt…"
          : "initial video in progress — preparing the mega prompt…"}
      </p>
    );
  }

  const chipClass = (active: boolean) =>
    `flex min-h-10 items-center gap-1.5 rounded-md px-3 py-1 text-sm transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96] ${
      active ? "bg-raised text-ink" : "text-muted hover:text-ink"
    }`;

  const lampRun = isTwoPassWorkflowMode(workflowMode);
  const approvedPlanNoOp = isApprovedPlanNoOp(run);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-2 text-2xs uppercase tracking-[0.14em] text-faint">
        {approvedPlanNoOp ? "Delivery" : "Videos"}
      </span>
      {run.iterations.map((it) => {
        const key = reviewAttemptKey(run, it);
        const label = reviewAttemptLabel(run, it);
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={chipClass(activeKey === key)}
            aria-pressed={activeKey === key}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${it.status === "running" ? "status-pulse" : ""}`}
              style={{ background: dotColor(it.status) }}
            />
            {label}
            {!combined ? (
              <span className="text-2xs tabular-nums text-faint">v{it.index}</span>
            ) : null}
            {!lampRun && run.bestIterationIndex === it.index ? (
              <span className="text-2xs text-accent" title="best attempt">
                ★
              </span>
            ) : null}
          </button>
        );
      })}
      {!lampRun && run.finalVideo ? (
        <>
          <span className="px-1 text-faint">·</span>
          <button
            onClick={() => onSelect(DELIVERED_ATTEMPT_KEY)}
            className={chipClass(activeKey === DELIVERED_ATTEMPT_KEY)}
            aria-pressed={activeKey === DELIVERED_ATTEMPT_KEY}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: run.fallback?.applied ? "var(--borderline)" : "var(--pass)",
              }}
            />
            Final
          </button>
        </>
      ) : null}
    </div>
  );
}
