"use client";

import type { Iteration, Run } from "@/lib/types";
import { isTwoPassWorkflowMode, runWorkflowMode } from "@/lib/workflow-mode";

function dotColor(status: Iteration["status"]): string {
  return status === "running"
    ? "var(--running)"
    : status === "ungraded"
      ? "var(--borderline)"
    : status === "passed"
      ? "var(--pass)"
      : "var(--fail)";
}

/** Initial and Final are the two meaningful Lamp outputs. Legacy extra
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
  if (run.iterations.length === 0) {
    return (
      <p className="text-2xs text-faint">
        initial video in progress — preparing the mega prompt…
      </p>
    );
  }

  const chipClass = (active: boolean) =>
    `flex min-h-10 items-center gap-1.5 rounded-md px-3 py-1 text-sm transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96] ${
      active ? "bg-raised text-ink" : "text-muted hover:text-ink"
    }`;

  const lampRun = isTwoPassWorkflowMode(runWorkflowMode(run));
  const backgroundNoOp =
    runWorkflowMode(run) === "background" &&
    run.backgroundCleanupPlan?.approval.status === "approved" &&
    run.backgroundCleanupPlan.decision === "exceptional-no-op";
  // Older single-cut runs have one delivered artifact. Name that output Final
  // instead of rendering duplicate Initial/Final controls for the same file.
  const singleDelivered = run.iterations.length === 1 && Boolean(run.finalVideo);

  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-2 text-2xs uppercase tracking-[0.14em] text-faint">
        {backgroundNoOp ? "Delivery" : "Videos"}
      </span>
      {run.iterations.map((it) => {
        const lampFinal = lampRun && (singleDelivered || it.index === 2);
        const key = lampFinal && run.finalVideo ? "final" : `iter-${it.index}`;
        const label = backgroundNoOp
          ? "Exact source"
          : lampRun
          ? singleDelivered
            ? "Final"
            : it.index === 1
              ? "Initial"
              : it.index === 2
                ? "Final"
                : `v${it.index}`
          : `v${it.index}`;
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
            <span className="text-2xs tabular-nums text-faint">v{it.index}</span>
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
            onClick={() => onSelect("final")}
            className={chipClass(activeKey === "final")}
            aria-pressed={activeKey === "final"}
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
