"use client";

import type {
  EvalDefinition,
  EvalResult,
  Iteration,
  ViolationSeverity,
} from "@/lib/types";
import {
  Badge,
  Card,
  ConfidenceMeter,
  ScoreMeter,
  SectionTitle,
  VerdictBadge,
} from "@/components/ui";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { formatTime, LOW_CONFIDENCE } from "@/lib/util";

function severityColor(s: ViolationSeverity): string {
  return s === "critical" ? "var(--fail)" : s === "major" ? "var(--borderline)" : "var(--muted)";
}

function judgeName(id: string): string {
  return id === "claude" ? "Claude" : id === "gemini" ? "Gemini" : id;
}

function fmtDelta(d: number): string {
  const abs = Math.abs(d);
  const v = abs >= 10 ? Math.round(abs).toString() : abs.toFixed(1).replace(/\.0$/, "");
  return d > 0 ? `▲ +${v}` : d < 0 ? `▼ -${v}` : "± 0";
}

function EvalCard({
  def,
  result,
  iterationStatus,
}: {
  def: EvalDefinition;
  result?: EvalResult;
  iterationStatus: Iteration["status"];
}) {
  if (!result) {
    return (
      <Card className="flex flex-col gap-2 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-muted">{def.name}</span>
          <span className="flex shrink-0 items-center gap-1">
            <Badge>{def.category}</Badge>
            {def.hardGate ? <Badge color="var(--accent)">hard gate</Badge> : null}
          </span>
        </div>
        {iterationStatus === "running" ? (
          <>
            <div className="h-1.5 animate-pulse rounded-full bg-raised" />
            <span className="text-2xs text-faint">waiting for judges…</span>
          </>
        ) : (
          <span className="text-2xs text-faint">
            {def.id === "audio-integrity"
              ? "not run — source audio is finalized and verified before each visual evaluation"
              : "not run this iteration"}
          </span>
        )}
      </Card>
    );
  }

  const delta = result.deltaFromPrevious;
  const deltaClass = delta === undefined ? "" : delta > 0 ? "text-pass" : delta < 0 ? "text-fail" : "text-faint";

  return (
    <Card className="flex flex-col gap-2.5 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-ink">{def.name}</span>
        <span className="flex shrink-0 items-center gap-1">
          <Badge>{def.category}</Badge>
          {def.hardGate ? <Badge color="var(--accent)">hard gate</Badge> : null}
        </span>
      </div>

      <ScoreMeter score={result.score} verdict={result.verdict} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <VerdictBadge verdict={result.verdict} />
          {delta !== undefined ? (
            <span className={`text-2xs font-semibold tabular-nums ${deltaClass}`} title="vs previous iteration">
              {fmtDelta(delta)}
            </span>
          ) : null}
        </span>
        <ConfidenceMeter confidence={result.confidence} />
      </div>

      {result.verdicts.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {result.verdicts.map((v) => (
            <Badge key={v.judge}>
              {judgeName(v.judge)} {Math.round(v.score)}
            </Badge>
          ))}
        </div>
      ) : null}

      {result.confidence < LOW_CONFIDENCE ? (
        <div>
          <Badge color="var(--borderline)">judges disagree — needs human eye</Badge>
        </div>
      ) : null}

      {result.violations.length > 0 ? (
        <ul className="space-y-1.5">
          {result.violations.map((v, i) => (
            <li key={i} className="rounded-lg bg-canvas p-2 text-2xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge color={severityColor(v.severity)}>{v.severity}</Badge>
                <span className="text-faint">{v.aspect}</span>
                {v.frameTimestampSec !== undefined ? (
                  <span className="tabular-nums text-faint">@ {formatTime(v.frameTimestampSec)}</span>
                ) : null}
              </div>
              <p className="mt-1 text-muted">{v.description}</p>
              <p className="mt-0.5 italic text-ink">→ {v.correction}</p>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-auto border-t border-edge pt-2 text-2xs text-faint">
        {def.method}
        {def.hardGate ? " · hard gate" : ""} · weight {def.weight.toFixed(2)}
      </div>
    </Card>
  );
}

/** One card per eval, always rendered in registry order. */
export function EvalGrid({ iteration }: { iteration?: Iteration }) {
  return (
    <section>
      <SectionTitle
        right={
          iteration ? <span className="text-2xs text-faint">iteration {iteration.index}</span> : null
        }
      >
        Evals
      </SectionTitle>
      {iteration ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          {EVAL_DEFS.map((def) => (
            <EvalCard
              key={def.id}
              def={def}
              result={iteration.evalResults.find((r) => r.evalId === def.id)}
              iterationStatus={iteration.status}
            />
          ))}
        </div>
      ) : (
        <Card className="p-4 text-2xs text-faint">No iteration selected yet.</Card>
      )}
    </section>
  );
}
