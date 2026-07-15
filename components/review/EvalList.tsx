"use client";

import { useState } from "react";
import type {
  EvalDefinition,
  EvalResult,
  Iteration,
  ViolationSeverity,
  WorkflowMode,
} from "@/lib/types";
import {
  Badge,
  ConfidenceMeter,
  ScoreMeter,
  VerdictBadge,
  verdictColor,
} from "@/components/ui";
import { humanGradeEvalDefsForMode } from "@/lib/prompts/eval-defs";
import { LAMP_UNAVAILABLE_EVAL_IDS } from "@/lib/lamp-evaluation";
import { formatTime, LOW_CONFIDENCE } from "@/lib/util";

const UNAVAILABLE_REASON: Record<(typeof LAMP_UNAVAILABLE_EVAL_IDS)[number], string> = {
  "temporal-alignment":
    "unavailable in Lamp — the documented local temporal-correlation metric is not implemented yet",
};

function unavailableReason(
  evalId: string,
  workflowMode: WorkflowMode
): string | undefined {
  return workflowMode === "lamp" && LAMP_UNAVAILABLE_EVAL_IDS.includes(
    evalId as (typeof LAMP_UNAVAILABLE_EVAL_IDS)[number]
  )
    ? UNAVAILABLE_REASON[evalId as (typeof LAMP_UNAVAILABLE_EVAL_IDS)[number]]
    : undefined;
}

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

function fmtDelta(d: number): string {
  const abs = Math.abs(d);
  const v = abs >= 10 ? Math.round(abs).toString() : abs.toFixed(1).replace(/\.0$/, "");
  return d > 0 ? `▲ +${v}` : d < 0 ? `▼ -${v}` : "± 0";
}

/** Expanded body of one row: judges, violations, delta, method footnote. */
function EvalRowDetail({ def, result }: { def: EvalDefinition; result: EvalResult }) {
  const delta = result.deltaFromPrevious;
  const deltaClass =
    delta === undefined
      ? ""
      : delta > 0
        ? "text-pass"
        : delta < 0
          ? "text-fail"
          : "text-faint";

  return (
    <div className="space-y-4 pb-5">
      {/* Judges */}
      {result.verdicts.length > 0 ? (
        <div className="space-y-1.5">
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

      {/* Violations */}
      {result.violations.length > 0 ? (
        <ul className="space-y-2.5">
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
              <p className="mt-1 text-muted">{v.description}</p>
              <p className="mt-0.5 italic text-ink">→ {v.correction}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-2xs text-faint">no violations recorded</p>
      )}

      {/* Delta + method footnote */}
      <p className="text-2xs text-faint">
        {delta !== undefined ? (
          <span className={`font-semibold tabular-nums ${deltaClass}`}>
            {fmtDelta(delta)} vs previous attempt ·{" "}
          </span>
        ) : null}
        {result.verdicts.length === 1 && result.verdicts[0]?.judge === "gemini"
          ? "Lamp holistic Gemini whole-video evaluation"
          : def.method}
        {def.hardGate ? " · must pass (hard gate)" : ""} · weight {def.weight.toFixed(2)}{" "}
        · pass ≥ {def.passThreshold}
      </p>
    </div>
  );
}

function EvalRow({
  def,
  result,
  unavailable,
  running,
  evalsUnderway,
  open,
  onToggle,
}: {
  def: EvalDefinition;
  result?: EvalResult;
  unavailable?: string;
  running: boolean;
  /** True once the run has reached the checks phase — gates the pulsing rows. */
  evalsUnderway: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const lowConfidence = result !== undefined && result.confidence < LOW_CONFIDENCE;

  const nameCell = (
    <span className="w-60 shrink-0">
      <span className="flex items-center gap-2">
        <span className={`text-sm font-medium ${result ? "text-ink" : "text-muted"}`}>
          {def.name}
        </span>
        {def.hardGate ? (
          <span
            className="text-2xs uppercase tracking-wider text-faint"
            title="must pass (hard gate) — failing this check fails the attempt"
          >
            must pass
          </span>
        ) : null}
      </span>
      {lowConfidence ? (
        <span className="mt-0.5 block text-2xs text-borderline">
          low-confidence result — needs human eye
        </span>
      ) : null}
    </span>
  );

  // Rows without a result are informational, not expandable. While the run
  // executes, the pulsing "waiting…" state only appears once the checks phase
  // has actually started — earlier stages (a 5-minute videogen) show a flat
  // dash instead of ten pulsing rows.
  if (!result) {
    return (
      <div className="-ml-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-l-2 border-transparent py-4 pl-3">
        {nameCell}
        {unavailable ? (
          <span className="flex-1 text-pretty text-2xs text-faint">
            {unavailable}
          </span>
        ) : running && def.id !== "audio-integrity" ? (
          evalsUnderway ? (
            <span className="flex flex-1 items-center gap-3">
              <span className="h-1.5 w-40 animate-pulse rounded-full bg-raised" />
              <span className="text-2xs text-faint">waiting for judges…</span>
            </span>
          ) : (
            <span className="flex-1 text-2xs text-faint">—</span>
          )
        ) : (
          <span className="flex-1 text-2xs text-faint">
            {def.id === "audio-integrity"
              ? "not run yet — Lamp restores and verifies source audio before each holistic visual evaluation"
              : "not run this attempt"}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="-ml-3 border-l-2 pl-3"
      style={{
        borderLeftColor: lowConfidence
          ? "color-mix(in srgb, var(--borderline) 50%, transparent)"
          : "transparent",
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-10 w-full flex-wrap items-center gap-x-5 gap-y-2 py-4 text-left transition-[transform,background-color] duration-150 ease-out hover:bg-[color-mix(in_srgb,var(--raised)_40%,transparent)] active:scale-[0.96]"
      >
        {nameCell}
        <span className="min-w-[160px] flex-1">
          <ScoreMeter score={result.score} verdict={result.verdict} />
        </span>
        <span className="w-32 shrink-0">
          <ConfidenceMeter confidence={result.confidence} />
        </span>
        <span className="flex w-24 shrink-0 justify-end">
          <VerdictBadge verdict={result.verdict} />
        </span>
        <span className="w-3 text-center text-2xs text-faint">{open ? "▴" : "▾"}</span>
      </button>
      {open ? <EvalRowDetail def={def} result={result} /> : null}
    </div>
  );
}

/**
 * The mode-applicable evals as flat rows with hairline dividers — no cards. One row
 * expands at a time (single accordion); the open row stays open across
 * attempt switches so a reviewer can watch one eval change attempt to attempt.
 */
export function EvalList({
  iteration,
  workflowMode,
  evalsUnderway = true,
  hiddenUntilHumanGrade = false,
}: {
  iteration?: Iteration;
  workflowMode: WorkflowMode;
  /**
   * While the run executes: has the pipeline reached the checks phase yet?
   * (see evalPhaseReached in GenerationTheater). Defaults true so completed
   * runs behave exactly as before.
   */
  evalsUnderway?: boolean;
  /** Keep ordinary Review reads hidden; Grade owns the explicit reveal control. */
  hiddenUntilHumanGrade?: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const definitions = humanGradeEvalDefsForMode(workflowMode);
  const applicableCount =
    definitions.length -
    (workflowMode === "lamp" ? LAMP_UNAVAILABLE_EVAL_IDS.length : 0);
  const availableCount =
    iteration?.evalResults.filter(
      (result) => !unavailableReason(result.evalId, workflowMode)
    ).length ?? 0;
  const sectionLabel =
    iteration?.index === 1
      ? "Initial whole-video critique"
      : iteration?.index === 2
        ? "Final AI evaluation"
        : "AI evaluation";

  if (hiddenUntilHumanGrade) {
    return (
      <section className="border-y border-edge py-6">
        <h2 className="text-balance text-sm font-medium text-ink">
          Final AI evaluation is hidden
        </h2>
        <p className="mt-1 max-w-2xl text-pretty text-xs leading-relaxed text-muted">
          Grade Final without opening it, or use Show AI evaluation in the Grade
          workspace if you want to inspect the saved scores first. Revealing it
          reads the existing result and does not run another AI evaluation.
        </p>
      </section>
    );
  }

  return (
    <section>
      <header className="flex flex-wrap items-end justify-between gap-2 border-b border-edge pb-3 pt-2">
        <div>
          <h2 className="text-balance text-sm font-medium text-ink">{sectionLabel}</h2>
          {workflowMode === "lamp" ? (
            <p className="mt-1 text-pretty text-2xs text-faint">
              One of {definitions.length} Lamp rubric rows stays explicitly
              unscored because timing correlation is unavailable.
            </p>
          ) : null}
        </div>
        <span className="text-2xs tabular-nums text-muted">
          {availableCount} of {applicableCount} applicable results available
        </span>
      </header>
      <div className="divide-y divide-edge border-b border-edge">
        {definitions.map((def) => (
          <EvalRow
            key={def.id}
            def={def}
            result={
              unavailableReason(def.id, workflowMode)
                ? undefined
                : iteration?.evalResults.find((r) => r.evalId === def.id)
            }
            unavailable={unavailableReason(def.id, workflowMode)}
            running={iteration?.status === "running"}
            evalsUnderway={evalsUnderway}
            open={openId === def.id}
            onToggle={() => setOpenId((cur) => (cur === def.id ? null : def.id))}
          />
        ))}
      </div>
    </section>
  );
}
