"use client";

import type { Iteration, Run, Verdict } from "@/lib/types";
import { Badge, verdictColor } from "@/components/ui";
import { formatUsd } from "@/lib/cost";

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
  const meterVerdict: Verdict = composite
    ? composite.passed
      ? "pass"
      : composite.score >= threshold
        ? "borderline"
        : "fail"
    : "borderline";

  const attempts = run.iterations.length;

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
              Overall score · pass ≥ {threshold}
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
              <span className="animate-pulse">scoring…</span>
            ) : (
              "waiting for the first attempt"
            )}
          </span>
        </span>
      )}

      <span className="ml-auto flex items-baseline gap-4 text-sm text-muted">
        <span className="tabular-nums">
          {attempts} attempt{attempts === 1 ? "" : "s"}
        </span>
        {run.bestIterationIndex !== undefined ? (
          <span>
            best <span className="text-accent">v{run.bestIterationIndex} ★</span>
          </span>
        ) : null}
        {run.cost ? (
          <span
            className="text-2xs tabular-nums text-faint"
            title="What this run would cost against live APIs — mock mode spends $0"
          >
            est. live cost {formatUsd(run.cost.estimatedUsd)} · mock $0.00
          </span>
        ) : null}
      </span>
    </div>
  );
}
