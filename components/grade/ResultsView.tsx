"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { Run } from "@/lib/types";
import {
  EVAL_DEFS,
  getEvalDef,
  humanGradeEvalDefsForMode,
} from "@/lib/prompts/eval-defs";
import { LAMP_UNAVAILABLE_EVAL_IDS } from "@/lib/lamp-evaluation";
import { SectionTitle, verdictColor } from "@/components/ui";
import {
  aiPassRatePct,
  biggestDisagreements,
  biggestDivergence,
  collectComparisons,
  finalLampIteration,
  humanGradeEvalDefsForRun,
  humanVerdictWord,
  isLampRun,
  overallAgreementPct,
  perCheckStats,
  shipRatePct,
} from "@/components/grade/derive";

/*
 * "Compare with AI" — the calibration read-out over every graded clip.
 * The AI side of every number is the final v2 evaluation. Human answers stay
 * blind until save, then this view reveals both sides video by video.
 */

function Stat({
  value,
  label,
  color,
  title,
}: {
  value: string;
  label: string;
  color?: string;
  title?: string;
}) {
  return (
    <div title={title}>
      <div
        className="text-2xl font-semibold tabular-nums"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      <div className="mt-0.5 text-2xs text-faint">{label}</div>
    </div>
  );
}

function pct(v: number | undefined): string {
  return v === undefined ? "—" : `${Math.round(v)}%`;
}

/** "+7" / "−12" — mean(your score − AI score); negative = you're harsher. */
function fmtGap(gap: number): string {
  const rounded = Math.round(gap);
  if (rounded === 0) return "±0";
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

function isUnavailable(evalId: string): boolean {
  return LAMP_UNAVAILABLE_EVAL_IDS.includes(
    evalId as (typeof LAMP_UNAVAILABLE_EVAL_IDS)[number]
  );
}

function VideoComparison({ run, defaultOpen }: { run: Run; defaultOpen: boolean }) {
  const final = finalLampIteration(run);
  const aiResults = final?.evalResults ?? [];
  const lamp = isLampRun(run);
  const definitions = humanGradeEvalDefsForRun(run);
  const applicableCount =
    definitions.length - (lamp ? LAMP_UNAVAILABLE_EVAL_IDS.length : 0);
  const availableCount = aiResults.filter(
    (result) => !lamp || !isUnavailable(result.evalId)
  ).length;

  return (
    <details
      open={defaultOpen}
      className="group rounded-xl bg-surface shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_2px_8px_rgba(0,0,0,0.16)]"
    >
      <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 rounded-xl px-4 py-3 transition-[transform,background-color] duration-150 ease-out hover:bg-raised active:scale-[0.96] [&::-webkit-details-marker]:hidden">
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium text-ink"
          title={run.originalVideo.label}
        >
          {run.originalVideo.label}
        </span>
        <span className="text-2xs tabular-nums text-muted">
          Final v{final?.index ?? 2} · {availableCount} of {applicableCount} applicable AI
          results
        </span>
        <span
          className="text-2xs font-medium"
          style={{ color: run.humanGrade?.shipIt ? "var(--pass)" : "var(--fail)" }}
        >
          You: {run.humanGrade?.shipIt ? "ship" : "do not ship"}
        </span>
        <span className="text-faint transition-[transform] duration-150 ease-out group-open:rotate-180">
          ⌄
        </span>
      </summary>

      <div className="overflow-x-auto px-4 pb-4">
        <div className="min-w-[720px]">
          <div className="grid grid-cols-[minmax(160px,1fr)_minmax(145px,0.8fr)_minmax(170px,0.9fr)_64px] gap-x-4 border-b border-edge pb-2 text-2xs uppercase tracking-[0.14em] text-faint">
          <span>check</span>
          <span>your grade</span>
          <span>final AI</span>
          <span className="text-right">gap</span>
        </div>
          <div className="divide-y divide-edge">
            {definitions.map((def) => {
            const human = run.humanGrade?.scores[def.id];
            const ai = aiResults.find((result) => result.evalId === def.id);
            const gap =
              human && ai && !(lamp && isUnavailable(def.id))
                ? human.score - ai.score
                : undefined;
            return (
              <div
                key={def.id}
                className="grid min-h-12 grid-cols-[minmax(160px,1fr)_minmax(145px,0.8fr)_minmax(170px,0.9fr)_64px] items-center gap-x-4 py-2.5 text-xs"
              >
                <span className="min-w-0 text-pretty font-medium text-ink">
                  {def.name}
                </span>
                <span className="tabular-nums">
                  {human ? (
                    <span style={{ color: verdictColor(human.verdict) }}>
                      {human.score} · {humanVerdictWord(human.points)}
                    </span>
                  ) : (
                    <span className="text-faint">Not graded</span>
                  )}
                </span>
                <span className="tabular-nums">
                  {lamp && isUnavailable(def.id) ? (
                    <span
                      className="text-faint"
                      title="Lamp does not yet implement the documented local temporal-correlation metric."
                    >
                      Unavailable
                    </span>
                  ) : ai ? (
                    <span style={{ color: verdictColor(ai.verdict) }}>
                      {Math.round(ai.score)} · {ai.verdict}{" "}
                      <span className="text-faint">
                        ({Math.round(ai.confidence * 100)}% confidence)
                      </span>
                    </span>
                  ) : (
                    <span className="text-borderline">Not returned</span>
                  )}
                </span>
                <span className="text-right tabular-nums text-muted">
                  {gap === undefined ? "—" : fmtGap(gap)}
                </span>
              </div>
            );
            })}
          </div>
          <div className="flex justify-end border-t border-edge pt-3">
            <Link
              href={`/runs/${run.id}`}
              className="inline-flex min-h-10 items-center text-xs text-accent transition-[transform,filter] duration-150 ease-out hover:brightness-110 active:scale-[0.96]"
            >
              Review final video →
            </Link>
          </div>
        </div>
      </div>
    </details>
  );
}

export function ResultsView({ gradedRuns }: { gradedRuns: Run[] }) {
  const comps = useMemo(() => collectComparisons(gradedRuns), [gradedRuns]);
  const statDefinitions = useMemo(
    () =>
      gradedRuns.every(isLampRun)
        ? humanGradeEvalDefsForMode("lamp")
        : EVAL_DEFS,
    [gradedRuns]
  );
  const stats = useMemo(
    () => perCheckStats(comps, statDefinitions),
    [comps, statDefinitions]
  );
  const overall = overallAgreementPct(comps);
  const divergence = biggestDivergence(stats);
  const shipRate = shipRatePct(gradedRuns);
  const aiPassRate = aiPassRatePct(gradedRuns);
  const disagreements = useMemo(() => biggestDisagreements(comps), [comps]);
  const hasComparisons = comps.length > 0;

  return (
    <div>
      {/* HEADER STRIP — flat one-line stats, no cards */}
      <div className="flex flex-wrap items-end gap-x-10 gap-y-4 border-b border-edge pb-5">
        <Stat value={String(gradedRuns.length)} label="clips graded" />
        <Stat
          value={pct(overall)}
          label="overall agreement"
          title="per-check verdict match across every graded clip; one step apart (pass↔borderline or borderline↔fail) counts as half agreement"
        />
        <Stat
          value={pct(shipRate)}
          label="your ship rate"
          color="var(--pass)"
          title="clips you answered yes to 'Would you ship this cut?'"
        />
        <Stat
          value={pct(aiPassRate)}
          label="final AI pass rate"
          title="among videos with all nine applicable final v2 results, the share that passed the complete automated gate"
        />
      </div>

      {!hasComparisons ? (
        <p className="border-b border-edge py-4 text-sm text-muted">
          Your human responses are saved, but these final videos have no
          returned AI results to compare with them.
        </p>
      ) : null}

      <section className="pt-6">
        <SectionTitle
          right={
            <span className="text-2xs text-faint">
              human grade vs final v2 AI evaluation
            </span>
          }
        >
          By video
        </SectionTitle>
        <p className="mb-4 max-w-3xl text-pretty text-xs leading-relaxed text-muted">
          Open a video to compare every one of your saved grades with the AI
          evaluation made after the final regeneration. Lamp has nine applicable
          automated results; timing correlation remains unavailable and Look
          Anchor matching does not apply.
        </p>
        <div className="space-y-2">
          {gradedRuns.map((run, index) => (
            <VideoComparison key={run.id} run={run} defaultOpen={index === 0} />
          ))}
        </div>
      </section>

      <div className="mt-10 border-t border-edge pt-6">
        <SectionTitle>Aggregate calibration</SectionTitle>
        <p className="text-pretty text-xs text-muted">
          These summaries combine only human/AI pairs that actually exist.
          Missing and inapplicable checks never count as agreement.
        </p>
      </div>

      {divergence ? (
        <p className="border-b border-edge py-4 text-sm text-ink">
          You disagree with the AI most on:{" "}
          <span className="font-semibold">
            {getEvalDef(divergence.evalId).name}
          </span>{" "}
          <span className="text-2xs text-faint">
            ({Math.round(divergence.agreementPct)}% agreement over{" "}
            {divergence.compared} {divergence.compared === 1 ? "clip" : "clips"}
            )
          </span>
        </p>
      ) : null}

      {/* PER-CHECK TABLE — mode-applicable flat rows */}
      <section className="pt-6">
        <SectionTitle>Check by check</SectionTitle>
        <div className="flex items-center gap-x-5 border-b border-edge pb-2 text-2xs uppercase tracking-[0.14em] text-faint">
          <span className="w-60 shrink-0">check</span>
          <span className="w-24 shrink-0">agreement</span>
          <span
            className="w-24 shrink-0"
            title="mean(your score − AI score); negative = you score it lower than the AI"
          >
            score gap
          </span>
          <span className="flex-1">who&apos;s harsher</span>
        </div>
        <div className="divide-y divide-edge border-b border-edge">
          {stats.map((s) => {
            const def = getEvalDef(s.evalId);
            if (s.compared === 0) {
              return (
                <div
                  key={s.evalId}
                  className="flex items-center gap-x-5 py-3 text-sm"
                >
                  <span className="w-60 shrink-0 font-medium text-muted">
                    {def.name}
                  </span>
                  <span className="flex-1 text-2xs text-faint">
                    {isUnavailable(s.evalId)
                      ? "unavailable in Lamp — temporal correlation is not implemented yet"
                      : "no final AI result was returned for a graded video"}
                  </span>
                </div>
              );
            }
            return (
              <div
                key={s.evalId}
                className="flex flex-wrap items-center gap-x-5 gap-y-1 py-3 text-sm"
              >
                <span className="w-60 shrink-0 font-medium text-ink">
                  {def.name}
                </span>
                <span className="w-24 shrink-0 tabular-nums text-ink">
                  {Math.round(s.agreementPct)}%
                </span>
                <span
                  className="w-24 shrink-0 tabular-nums text-muted"
                  title="mean(your score − AI score); negative = you score it lower than the AI"
                >
                  {fmtGap(s.meanScoreGap)}
                </span>
                <span
                  className={`flex-1 text-xs ${
                    s.direction === "aligned" ? "text-faint" : "text-muted"
                  }`}
                >
                  {s.direction}
                  <span className="ml-2 text-2xs text-faint">
                    {s.compared} {s.compared === 1 ? "clip" : "clips"}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* BIGGEST DISAGREEMENTS — the rubric-calibration signal */}
      <section className="pt-8">
        <SectionTitle>Biggest disagreements</SectionTitle>
        {disagreements.length === 0 ? (
          <p className="py-4 text-sm text-muted">
            {hasComparisons
              ? "None yet — every available automated verdict matches your human verdict."
              : "No comparison is available because automated quality checks were not run."}
          </p>
        ) : (
          <div className="divide-y divide-edge border-b border-edge">
            {disagreements.map((d) => {
              const def = getEvalDef(d.evalId);
              return (
                <div
                  key={`${d.run.id}-${d.evalId}`}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3"
                >
                  <span
                    className="w-56 shrink-0 truncate text-xs text-muted"
                    title={d.run.originalVideo.label}
                  >
                    {d.run.originalVideo.label}
                  </span>
                  <span className="w-52 shrink-0 text-sm font-medium text-ink">
                    {def.name}
                  </span>
                  <span className="flex-1 text-xs tabular-nums">
                    <span className="text-faint">You: </span>
                    <span
                      className="font-semibold"
                      style={{ color: verdictColor(d.human.verdict) }}
                    >
                      {d.human.score} · {humanVerdictWord(d.human.points)}
                    </span>
                    <span className="text-faint"> · AI: </span>
                    <span
                      className="font-semibold"
                      style={{ color: verdictColor(d.ai.verdict) }}
                    >
                      {Math.round(d.ai.score)} · {d.ai.verdict}
                    </span>
                    <span className="text-faint">
                      {" "}
                      ({Math.round(d.ai.confidence * 100)}% conf)
                    </span>
                  </span>
                  <Link
                    href={`/runs/${d.run.id}`}
                    className="inline-flex min-h-10 items-center text-xs text-accent transition-[transform,filter] duration-150 ease-out hover:brightness-110 active:scale-[0.96]"
                  >
                    Review →
                  </Link>
                </div>
              );
            })}
          </div>
        )}
        {hasComparisons ? (
          <p className="pt-4 text-2xs text-faint">
            Use these to refine the judge rubrics (Rubrics tab) or the generation
            brief — start with the high-confidence disagreements.
          </p>
        ) : null}
      </section>
    </div>
  );
}
