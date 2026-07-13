"use client";

import type { Iteration, Run } from "@/lib/types";

function dotColor(status: Iteration["status"]): string {
  return status === "running"
    ? "var(--running)"
    : status === "ungraded"
      ? "var(--borderline)"
    : status === "passed"
      ? "var(--pass)"
      : "var(--fail)";
}

/**
 * Quiet row of text chips: v1 v2 v3 · Final. Selecting one drives the hero
 * and the eval rows. `activeKey` uses the page's keys: "iter-N" | "final".
 */
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
        first attempt in progress — reading the clip and taking the scene inventory…
      </p>
    );
  }

  const chipClass = (active: boolean) =>
    `flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition ${
      active ? "bg-raised text-ink" : "text-muted hover:text-ink"
    }`;

  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-2 text-2xs uppercase tracking-[0.14em] text-faint">
        Attempts
      </span>
      {run.iterations.map((it) => {
        const key = `iter-${it.index}`;
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={chipClass(activeKey === key)}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${it.status === "running" ? "status-pulse" : ""}`}
              style={{ background: dotColor(it.status) }}
            />
            v{it.index}
            {run.bestIterationIndex === it.index ? (
              <span className="text-2xs text-accent" title="best attempt">
                ★
              </span>
            ) : null}
          </button>
        );
      })}
      {run.finalVideo ? (
        <>
          <span className="px-1 text-faint">·</span>
          <button
            onClick={() => onSelect("final")}
            className={chipClass(activeKey === "final")}
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
