"use client";

import { useMemo, useState } from "react";
import type { HumanCheckGrade, Run } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { Button, verdictColor } from "@/components/ui";
import { PairPlayer } from "@/components/library/PairPlayer";
import {
  formatRunDate,
  shippedIteration,
  shippedVideo,
} from "@/components/library/derive";
import { SCALE, scalePoint } from "@/components/grade/derive";

/*
 * Blind grading of ONE clip. Deliberately shows NOTHING from the AI judges —
 * no scores, no verdicts, no violations — so the human read is un-anchored.
 * The same shippedVideo/shippedIteration helpers used by the comparison view
 * pick the cut, so you grade exactly the attempt the AI scored.
 */

/** Rows where the check is about sound or timing get a how-to-look hint. */
const ROW_HINTS: Record<string, string> = {
  "audio-integrity": "listen with sound",
  "temporal-alignment": "watch the lips",
};

interface Answer {
  points: HumanCheckGrade["points"];
  note: string;
}

function ScaleRow({
  answer,
  onPick,
  onNote,
}: {
  answer?: Answer;
  onPick: (points: HumanCheckGrade["points"]) => void;
  onNote: (note: string) => void;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {SCALE.map((p) => {
          const selected = answer?.points === p.points;
          const color = verdictColor(p.verdict);
          return (
            <button
              key={p.points}
              onClick={() => onPick(p.points)}
              aria-pressed={selected}
              title={`${p.points} of 5`}
              className={`rounded-md border px-2 py-1 text-2xs transition ${
                selected ? "font-semibold" : "text-muted hover:text-ink"
              }`}
              style={
                selected
                  ? {
                      color,
                      borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
                      background: `color-mix(in srgb, ${color} 13%, transparent)`,
                    }
                  : { borderColor: "var(--edge)" }
              }
            >
              <span
                className="mr-1 font-semibold tabular-nums"
                style={{ color }}
              >
                {p.points}
              </span>
              {p.label}
            </button>
          );
        })}
      </div>
      {answer ? (
        <input
          value={answer.note}
          onChange={(e) => onNote(e.target.value)}
          placeholder="note — what did you see? (optional)"
          aria-label="Optional note for this check"
          className="mt-2 w-full max-w-md rounded-md bg-raised px-2.5 py-1 text-xs text-ink placeholder:text-faint focus:outline-none"
        />
      ) : null}
    </div>
  );
}

export function ClipGrader({
  run,
  remaining,
  onSkip,
}: {
  run: Run;
  /** Clips still in the queue, this one included. */
  remaining: number;
  onSkip: () => void;
}) {
  const setHumanGrade = useAppStore((s) => s.setHumanGrade);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [shipIt, setShipIt] = useState<boolean | undefined>(undefined);
  const [overallNote, setOverallNote] = useState("");

  const shipped = shippedIteration(run);
  const relit = shippedVideo(run);
  const answeredCount = useMemo(
    () => EVAL_DEFS.filter((d) => answers[d.id]).length,
    [answers]
  );
  const complete = answeredCount === EVAL_DEFS.length && shipIt !== undefined;

  const save = () => {
    if (!complete || shipIt === undefined) return;
    const scores: Record<string, HumanCheckGrade> = {};
    for (const def of EVAL_DEFS) {
      const a = answers[def.id];
      if (!a) return;
      const p = scalePoint(a.points);
      scores[def.id] = {
        points: p.points,
        score: p.score,
        verdict: p.verdict,
        ...(a.note.trim() ? { note: a.note.trim() } : {}),
      };
    }
    setHumanGrade(run.id, {
      gradedAt: Date.now(),
      scores,
      shipIt,
      ...(overallNote.trim() ? { overallNote: overallNote.trim() } : {}),
    });
    // The queue recomputes upstream — the next ungraded clip mounts fresh.
  };

  const shipButton = (value: boolean, label: string) => {
    const selected = shipIt === value;
    const color = value ? "var(--pass)" : "var(--fail)";
    return (
      <button
        key={label}
        onClick={() => setShipIt(value)}
        aria-pressed={selected}
        className={`rounded-md border px-2.5 py-1 text-xs transition ${
          selected ? "font-semibold" : "text-muted hover:text-ink"
        }`}
        style={
          selected
            ? {
                color,
                borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
                background: `color-mix(in srgb, ${color} 13%, transparent)`,
              }
            : { borderColor: "var(--edge)" }
        }
      >
        {label}
      </button>
    );
  };

  return (
    <div>
      {/* Clip header */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-4">
        <h2 className="text-sm font-medium text-ink">
          {run.originalVideo.label}
        </h2>
        <span className="text-2xs text-faint">
          {formatRunDate(run.createdAt)}
          {shipped ? ` · attempt v${shipped.index}` : ""} · {remaining}{" "}
          {remaining === 1 ? "clip" : "clips"} in the queue
        </span>
      </div>

      {/* The before/after — large, front and center. Original side carries the audio. */}
      <div className="[&>button]:max-w-none">
        <PairPlayer
          original={run.originalVideo}
          relit={relit}
          relitLabel={
            run.finalVideo
              ? "RELIT · FINAL"
              : shipped
                ? `RELIT v${shipped.index}`
                : "RELIT"
          }
        />
      </div>

      {/* The 11 checks — flat rows, same order as everywhere else in the app */}
      <section className="mt-6 divide-y divide-edge border-b border-t border-edge">
        {EVAL_DEFS.map((def) => (
          <div
            key={def.id}
            className="flex flex-wrap items-start gap-x-5 gap-y-2 py-3.5"
          >
            <span className="w-60 shrink-0">
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink">{def.name}</span>
                {ROW_HINTS[def.id] ? (
                  <span className="text-2xs text-borderline">
                    {ROW_HINTS[def.id]}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block text-2xs text-faint">
                {def.description}
              </span>
            </span>
            <ScaleRow
              answer={answers[def.id]}
              onPick={(points) =>
                setAnswers((cur) => ({
                  ...cur,
                  [def.id]: { points, note: cur[def.id]?.note ?? "" },
                }))
              }
              onNote={(note) =>
                setAnswers((cur) => {
                  const existing = cur[def.id];
                  return existing
                    ? { ...cur, [def.id]: { ...existing, note } }
                    : cur;
                })
              }
            />
          </div>
        ))}
      </section>

      {/* Sticky bottom bar — progress, the ship call, save/skip */}
      <div className="sticky bottom-0 z-10 -mx-6 mt-4 border-t border-edge bg-canvas px-6 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span
            className={`text-2xs tabular-nums ${
              answeredCount === EVAL_DEFS.length ? "text-pass" : "text-muted"
            }`}
          >
            {answeredCount} of {EVAL_DEFS.length} answered
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-xs text-muted">Would you ship this cut?</span>
            {shipButton(true, "yes")}
            {shipButton(false, "no")}
          </span>
          <input
            value={overallNote}
            onChange={(e) => setOverallNote(e.target.value)}
            placeholder="overall note (optional)"
            aria-label="Optional overall note for this clip"
            className="min-w-40 flex-1 rounded-md bg-raised px-2.5 py-1.5 text-xs text-ink placeholder:text-faint focus:outline-none"
          />
          <span className="flex items-center gap-2">
            <Button variant="ghost" onClick={onSkip}>
              Skip this clip
            </Button>
            <Button
              onClick={save}
              disabled={!complete}
              title={
                complete
                  ? undefined
                  : "answer all 11 checks and the ship question first"
              }
            >
              Save grade &amp; next
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
