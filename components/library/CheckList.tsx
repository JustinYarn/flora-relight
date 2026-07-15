"use client";

import { useState } from "react";
import type {
  EvalDefinition,
  EvalResult,
  Iteration,
  ViolationSeverity,
} from "@/lib/types";
import {
  Badge,
  ConfidenceMeter,
  ScoreMeter,
  VerdictBadge,
  verdictColor,
} from "@/components/ui";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { formatTime } from "@/lib/util";

/*
 * Level 2/3 of the Library's progressive disclosure: workflow checks as compact
 * rows; clicking one expands both judges' verdicts and the violations in
 * place. Mirrors the interaction pattern of components/review/EvalList.tsx
 * (its row internals are not exported, so the markup is mirrored, compacted).
 */

function severityColor(s: ViolationSeverity): string {
  return s === "critical"
    ? "var(--fail)"
    : s === "major"
      ? "var(--borderline)"
      : "var(--muted)";
}

function judgeName(id: string): string {
  return id === "claude" ? "Claude" : id === "gemini" ? "Gemini" : id;
}

/** Level 3: judge details for one check, expanded in place. */
function CheckDetail({ result }: { result: EvalResult }) {
  return (
    <div className="space-y-3 pb-4 pl-1">
      {result.verdicts.length > 0 ? (
        <div className="space-y-1">
          {result.verdicts.map((v) => (
            <div key={v.judge} className="flex items-baseline gap-3">
              <span className="w-14 shrink-0 text-2xs uppercase tracking-wider text-faint">
                {judgeName(v.judge)}
              </span>
              <span
                className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums"
                style={{ color: verdictColor(v.verdict) }}
              >
                {Math.round(v.score)}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-xs text-muted"
                title={v.reasoning}
              >
                {v.reasoning}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">
          Checked automatically by code — no AI judges involved.
        </p>
      )}

      {result.violations.length > 0 ? (
        <ul className="space-y-2">
          {result.violations.map((v, i) => (
            <li key={i} className="text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge color={severityColor(v.severity)}>{v.severity}</Badge>
                <span className="text-faint">{v.aspect}</span>
                {v.frameTimestampSec !== undefined ? (
                  <span className="tabular-nums text-faint">
                    @ {formatTime(v.frameTimestampSec)}
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-muted">{v.description}</p>
              <p className="mt-0.5 italic text-ink">→ {v.correction}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-2xs text-faint">no violations recorded</p>
      )}
    </div>
  );
}

function CheckRow({
  def,
  result,
  running,
  open,
  onToggle,
}: {
  def: EvalDefinition;
  result?: EvalResult;
  running: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const nameCell = (
    <span className="flex w-56 shrink-0 items-center gap-2">
      <span className={`text-sm ${result ? "text-ink" : "text-muted"}`}>{def.name}</span>
      {def.hardGate ? (
        <span
          className="text-2xs uppercase tracking-wider text-faint"
          title="must pass — failing this check fails the attempt"
        >
          must pass
        </span>
      ) : null}
    </span>
  );

  // Checks without a result on this attempt are informational, not expandable.
  if (!result) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
        {nameCell}
        <span className="flex-1 text-2xs text-faint">
          {running ? "waiting for judges…" : "not run this attempt"}
        </span>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-left transition hover:bg-[color-mix(in_srgb,var(--raised)_40%,transparent)]"
      >
        {nameCell}
        <span className="min-w-[120px] flex-1">
          <ScoreMeter score={result.score} verdict={result.verdict} />
        </span>
        <span className="hidden w-28 shrink-0 sm:block">
          <ConfidenceMeter confidence={result.confidence} />
        </span>
        <span className="flex w-20 shrink-0 justify-end">
          <VerdictBadge verdict={result.verdict} />
        </span>
        <span className="w-3 text-center text-2xs text-faint">{open ? "▴" : "▾"}</span>
      </button>
      {open ? <CheckDetail result={result} /> : null}
    </div>
  );
}

/** The workflow checks for one attempt, flat rows, single accordion for detail. */
export function CheckList({
  iteration,
  runActive,
  definitions = EVAL_DEFS,
}: {
  iteration?: Iteration;
  /** False once the run has settled — a still-"running" attempt then reads as never finished, not in flight. */
  runActive: boolean;
  definitions?: readonly EvalDefinition[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (!iteration) {
    return (
      <p className="py-3 text-2xs text-faint">
        no attempts recorded for this run — nothing was checked
      </p>
    );
  }

  return (
    <div className="divide-y divide-edge">
      {definitions.map((def) => (
        <CheckRow
          key={def.id}
          def={def}
          result={iteration.evalResults.find((r) => r.evalId === def.id)}
          running={runActive && iteration.status === "running"}
          open={openId === def.id}
          onToggle={() => setOpenId((cur) => (cur === def.id ? null : def.id))}
        />
      ))}
    </div>
  );
}
