"use client";

import type { Iteration, Run, Verdict } from "@/lib/types";
import { Badge, verdictColor } from "@/components/ui";
import { formatUsd } from "@/lib/cost";
import { isApprovedPlanNoOp } from "@/lib/workflow-mode";

/**
 * One flat horizontal strip under the hero: the composite number, the
 * attempt's verdict chip, attempt count, best-attempt marker. No card.
 * (Run-level review status lives in the page header badge — this line is
 * about the attempt currently on screen.)
 */
export function VerdictLine({
  run,
  iteration,
  threshold,
}: {
  run: Run;
  iteration?: Iteration;
  threshold: number;
}) {
  const composite = iteration?.composite;
  const availableResultCount = iteration?.evalResults.length ?? 0;
  const sentDirectlyToHumanGrade =
    iteration?.status === "ungraded" && iteration.evalResults.length === 0;
  const meterVerdict: Verdict = composite
    ? composite.passed
      ? "pass"
      : composite.score >= threshold
        ? "borderline"
        : "fail"
    : "borderline";

  const videosGenerated = run.iterations.length;
  const approvedPlanNoOp = isApprovedPlanNoOp(run);
  const scoreLabel =
    iteration?.index === 2
      ? "Final AI score"
      : iteration?.index === 1
        ? "Initial critique score"
        : "Available AI score";

  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-y border-edge py-5">
      {composite ? (
        <>
          <span className="flex items-baseline gap-2">
            <span
              className="text-3xl font-semibold tabular-nums"
              style={{ color: verdictColor(meterVerdict) }}
            >
              {composite.score.toFixed(1)}
            </span>
            <span
              className="text-2xs text-faint"
              title="Overall score (weighted composite of all checks)"
            >
              {scoreLabel} · pass ≥ {threshold}
            </span>
          </span>
          {composite.passed ? (
            <Badge color="var(--pass)">passed</Badge>
          ) : (
            <span className="flex items-baseline gap-2">
              <Badge color="var(--fail)">failed</Badge>
              {composite.hardGateFailures.length > 0 ? (
                <span
                  className="text-2xs text-faint"
                  title="must-pass checks (hard gates) that failed"
                >
                  {composite.hardGateFailures.length} must-pass check
                  {composite.hardGateFailures.length === 1 ? "" : "s"} failed
                </span>
              ) : (
                <span className="text-2xs text-faint">below threshold</span>
              )}
            </span>
          )}
        </>
      ) : (
        <span className="flex items-baseline gap-3">
          <span className="text-3xl font-semibold tabular-nums text-faint">—</span>
          <span className="text-2xs text-faint">
            {iteration ? (
              availableResultCount > 0 ? (
                `${availableResultCount} AI result${
                  availableResultCount === 1 ? "" : "s"
                } available · no aggregate score recorded`
              ) : sentDirectlyToHumanGrade ? (
                "automated scoring not run · awaiting your grade"
              ) : iteration.status === "running" ? (
                <span className="animate-pulse">scoring…</span>
              ) : (
                "evaluation stopped before a score was recorded"
              )
            ) : (
              "waiting for the initial video"
            )}
          </span>
        </span>
      )}

      <span className="ml-auto flex items-baseline gap-4 text-sm text-muted">
        <span className="tabular-nums">
          {approvedPlanNoOp
            ? "Exact source · no generation"
            : videosGenerated >= 2
            ? "Initial + Final generated"
            : videosGenerated === 1
              ? "Initial generated"
              : "Preparing initial"}
        </span>
        {run.cost ? (
          <span
            className="text-2xs tabular-nums text-faint"
            title={
              run.live
                ? "Provider spend recorded for this Lamp run"
                : "What this simulated run would cost against live APIs"
            }
          >
            {run.live
              ? `actual spend ${formatUsd(run.cost.actualUsd)}`
              : `est. live cost ${formatUsd(run.cost.estimatedUsd)} · mock $0.00`}
          </span>
        ) : null}
      </span>
    </div>
  );
}
