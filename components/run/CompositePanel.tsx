"use client";

import type { Iteration, Verdict } from "@/lib/types";
import { Badge, Card, ScoreMeter, SectionTitle, verdictColor } from "@/components/ui";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";

/**
 * Composite score for the selected iteration plus the hard-gate checklist.
 * An iteration passes only when composite >= threshold AND every hard gate
 * has verdict "pass" — borderline on a gate is a failure.
 */
export function CompositePanel({
  iteration,
  threshold,
}: {
  iteration?: Iteration;
  threshold: number;
}) {
  const composite = iteration?.composite;
  const hardGates = EVAL_DEFS.filter((d) => d.hardGate);

  const meterVerdict: Verdict = composite
    ? composite.passed
      ? "pass"
      : composite.score >= threshold
        ? "borderline"
        : "fail"
    : "borderline";

  return (
    <Card className="flex flex-col p-4">
      <SectionTitle
        right={
          iteration ? <span className="text-2xs text-faint">iteration {iteration.index}</span> : null
        }
      >
        Composite
      </SectionTitle>

      {composite ? (
        <>
          <div className="flex items-baseline gap-2">
            <span
              className="text-4xl font-semibold tabular-nums"
              style={{ color: verdictColor(meterVerdict) }}
            >
              {composite.score.toFixed(1)}
            </span>
            <span className="text-2xs text-faint">pass ≥ {threshold} + all hard gates</span>
          </div>
          <div className="mt-2">
            <ScoreMeter score={composite.score} verdict={meterVerdict} />
          </div>
          <div className="mt-2">
            {composite.passed ? (
              <Badge color="var(--pass)">iteration passed</Badge>
            ) : composite.hardGateFailures.length > 0 ? (
              <Badge color="var(--fail)">
                {composite.hardGateFailures.length} hard gate
                {composite.hardGateFailures.length === 1 ? "" : "s"} failed
              </Badge>
            ) : (
              <Badge color="var(--fail)">below composite threshold</Badge>
            )}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 py-2">
          <span className="h-1.5 w-24 animate-pulse rounded-full bg-raised" />
          <span className="text-2xs text-faint">
            {iteration ? "scoring in progress…" : "no iteration selected"}
          </span>
        </div>
      )}

      <div className="mt-4 border-t border-edge pt-3">
        <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-faint">
          Hard gates
        </p>
        <ul className="space-y-1.5">
          {hardGates.map((def) => {
            const res = iteration?.evalResults.find((r) => r.evalId === def.id);
            const gatePassed = res ? res.verdict === "pass" : undefined;
            return (
              <li key={def.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  {gatePassed === undefined ? (
                    <span className="w-4 animate-pulse text-center text-faint">·</span>
                  ) : gatePassed ? (
                    <span className="w-4 text-center font-semibold text-pass">✓</span>
                  ) : (
                    <span className="w-4 text-center font-semibold text-fail">✕</span>
                  )}
                  <span className="truncate text-muted">{def.name}</span>
                </span>
                {res ? (
                  <span
                    className="shrink-0 text-2xs font-semibold tabular-nums"
                    style={{ color: verdictColor(res.verdict) }}
                  >
                    {Math.round(res.score)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
