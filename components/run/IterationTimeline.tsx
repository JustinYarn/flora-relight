"use client";

import type { Iteration, NodeRunStatus, Run } from "@/lib/types";
import { StatusDot, verdictColor } from "@/components/ui";

const ITER_TO_NODE_STATUS: Record<Iteration["status"], NodeRunStatus> = {
  running: "running",
  passed: "succeeded",
  failed: "failed",
};

/**
 * Horizontal chips: Iter 1..n (+ Final when the run has shipped a final
 * video). Selecting a chip drives the player, eval grid, prompt panel and
 * frame strip below.
 */
export function IterationTimeline({
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
        Waiting for the first iteration — ingest and manifest extraction in progress…
      </p>
    );
  }

  const chipClass = (active: boolean) =>
    `flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
      active
        ? "border-accent bg-raised text-ink"
        : "border-edge bg-surface text-muted hover:border-faint hover:text-ink"
    }`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {run.iterations.map((it) => {
        const key = `iter-${it.index}`;
        return (
          <button key={key} onClick={() => onSelect(key)} className={chipClass(activeKey === key)}>
            <StatusDot status={ITER_TO_NODE_STATUS[it.status]} />
            <span>Iter {it.index}</span>
            {it.composite ? (
              <span
                className="text-2xs font-semibold tabular-nums"
                style={{ color: verdictColor(it.composite.passed ? "pass" : "fail") }}
              >
                {Math.round(it.composite.score)}
              </span>
            ) : null}
            {run.bestIterationIndex === it.index ? (
              <span className="text-2xs text-accent" title="best iteration">
                ★
              </span>
            ) : null}
          </button>
        );
      })}
      {run.finalVideo ? (
        <button onClick={() => onSelect("final")} className={chipClass(activeKey === "final")}>
          <span className="inline-block h-2 w-2 rounded-full bg-pass" />
          <span>Final</span>
          {run.fallback?.applied ? (
            <span className="text-2xs text-borderline" title="fallback applied">
              fallback
            </span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
