"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { Run } from "@/lib/types";
import { getEvalDef } from "@/lib/prompts/eval-defs";
import { SectionTitle, verdictColor } from "@/components/ui";
import {
  aiPassRatePct,
  biggestDisagreements,
  biggestDivergence,
  collectComparisons,
  humanVerdictWord,
  overallAgreementPct,
  perCheckStats,
  shipRatePct,
} from "@/components/grade/derive";

/*
 * "Compare with AI" — the calibration read-out over every graded clip.
 * The AI side of every number is the SHIPPED attempt's evalResults (same
 * derive helper the blind grader used to pick the video), so human and AI
 * always judged the identical cut.
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

export function ResultsView({ gradedRuns }: { gradedRuns: Run[] }) {
  const comps = useMemo(() => collectComparisons(gradedRuns), [gradedRuns]);
  const stats = useMemo(() => perCheckStats(comps), [comps]);
  const overall = overallAgreementPct(comps);
  const divergence = biggestDivergence(stats);
  const shipRate = shipRatePct(gradedRuns);
  const aiPassRate = aiPassRatePct(gradedRuns);
  const disagreements = useMemo(() => biggestDisagreements(comps), [comps]);

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
          label="AI pass rate"
          title="clips whose shipped attempt passed the AI gates (composite)"
        />
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

      {/* PER-CHECK TABLE — 11 flat rows */}
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
                    no data yet — the AI never scored this check on a graded
                    clip
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
            None yet — on every compared check, you and the AI landed on the
            same verdict.
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
                    className="text-xs text-accent transition hover:brightness-110"
                  >
                    Review →
                  </Link>
                </div>
              );
            })}
          </div>
        )}
        <p className="pt-4 text-2xs text-faint">
          Use these to refine the judge rubrics (Rubrics tab) or the generation
          brief — start with the high-confidence disagreements.
        </p>
      </section>
    </div>
  );
}
