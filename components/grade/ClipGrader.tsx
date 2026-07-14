"use client";

import { useMemo, useState } from "react";
import type { GradeClipDraft, HumanCheckGrade, HumanGrade, Run } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { markServerRunObserved } from "@/lib/persist";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { Button, verdictColor } from "@/components/ui";
import { PairPlayer } from "@/components/library/PairPlayer";
import { formatRunDate } from "@/components/library/derive";
import {
  finalLampIteration,
  finalLampVideo,
  SCALE,
  scalePoint,
} from "@/components/grade/derive";
import type { GradeDraftSaveState } from "@/components/grade/useGradeDraft";

/*
 * Blind grading of ONE clip. Deliberately shows NOTHING from the AI judges —
 * no scores, no verdicts, no violations — so the human read is un-anchored.
 * The same v2/final helpers used by the results view pick the delivered cut;
 * automated comparisons appear only after this blind grade is saved.
 */

/** Rows where the check is about sound or timing get a how-to-look hint. */
const ROW_HINTS: Record<string, string> = {
  "audio-integrity": "listen to the final relit audio",
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
              className={`min-h-10 rounded-md border px-2 py-1 text-2xs transition-[transform,color,background-color,border-color] duration-150 ease-out active:scale-[0.96] ${
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
          maxLength={4000}
          className="mt-2 min-h-10 w-full max-w-md rounded-md bg-raised px-2.5 py-1 text-xs text-ink placeholder:text-faint focus:outline-none"
        />
      ) : null}
    </div>
  );
}

export function ClipGrader({
  run,
  remaining,
  draft,
  draftSaveState,
  onDraftChange,
  onRetryDraftSave,
  onSubmitted,
  onSkip,
}: {
  run: Run;
  /** Clips still in the queue, this one included. */
  remaining: number;
  draft: GradeClipDraft;
  draftSaveState: GradeDraftSaveState;
  onDraftChange: (update: (current: GradeClipDraft) => GradeClipDraft) => void;
  onRetryDraftSave: () => void;
  onSubmitted: (runId: string) => void;
  onSkip: () => void;
}) {
  const answers = draft.answers;
  const shipIt = draft.shipIt;
  const overallNote = draft.overallNote;
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);

  const shipped = finalLampIteration(run);
  const relit = finalLampVideo(run);
  const answeredCount = useMemo(
    () => EVAL_DEFS.filter((d) => answers[d.id]).length,
    [answers]
  );
  const complete = answeredCount === EVAL_DEFS.length && shipIt !== undefined;

  const save = async (): Promise<void> => {
    if (!complete || shipIt === undefined || submitting) return;
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
    const humanGrade: HumanGrade = {
      gradedAt: Date.now(),
      scores,
      shipIt,
      ...(overallNote.trim() ? { overallNote: overallNote.trim() } : {}),
    };

    setSubmitting(true);
    setSubmissionError(null);
    try {
      const response = await fetch(`/api/runs?id=${encodeURIComponent(run.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          humanGrade,
          expectedGradedAt: run.humanGrade?.gradedAt ?? null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { run?: Run; current?: Run; error?: string }
        | null;
      if (!response.ok || !payload?.run) {
        if (response.status === 409 && payload?.current) {
          markServerRunObserved(payload.current);
          useAppStore.setState((state) => ({
            runs: state.runs.map((item) =>
              item.id === run.id ? payload.current! : item
            ),
          }));
        }
        throw new Error(payload?.error ?? `Grade save failed (${response.status}).`);
      }

      // PATCH returns the server's canonical compact record. The full judged
      // frame evidence remains archived server-side and cannot be erased here.
      markServerRunObserved(payload.run);
      useAppStore.setState((state) => ({
        runs: state.runs.map((item) => (item.id === run.id ? payload.run! : item)),
      }));
      // Only clear the draft after the final grade is durably acknowledged.
      onSubmitted(run.id);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : "The grade could not be saved."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const shipButton = (value: boolean, label: string) => {
    const selected = shipIt === value;
    const color = value ? "var(--pass)" : "var(--fail)";
    return (
      <button
        key={label}
        onClick={() =>
          onDraftChange((current) => ({ ...current, shipIt: value }))
        }
        aria-pressed={selected}
        className={`min-h-10 rounded-md border px-2.5 py-1 text-xs transition-[transform,color,background-color,border-color] duration-150 ease-out active:scale-[0.96] ${
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
          {shipped ? ` · final v${shipped.index}` : ""} · {remaining}{" "}
          {remaining === 1 ? "clip" : "clips"} in the queue
        </span>
      </div>

      {/* The before/after — the delivered relit file owns audio during grading. */}
      <div className="[&>button]:max-w-none">
        <PairPlayer
          original={run.originalVideo}
          relit={relit}
          audible="relit"
          relitLabel={
            run.finalVideo
              ? `FINAL VIDEO${shipped ? ` · v${shipped.index}` : ""}`
              : shipped
                ? `FINAL VIDEO · v${shipped.index}`
                : "FINAL VIDEO"
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
                onDraftChange((current) => ({
                  ...current,
                  answers: {
                    ...current.answers,
                    [def.id]: {
                      points,
                      note: current.answers[def.id]?.note ?? "",
                    },
                  },
                }))
              }
              onNote={(note) =>
                onDraftChange((current) => {
                  const existing = current.answers[def.id];
                  return existing
                    ? {
                        ...current,
                        answers: {
                          ...current.answers,
                          [def.id]: { ...existing, note },
                        },
                      }
                    : current;
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
            onChange={(e) => {
              const overallNote = e.target.value;
              onDraftChange((current) => ({ ...current, overallNote }));
            }}
            placeholder="overall note (optional)"
            aria-label="Optional overall note for this clip"
            maxLength={8000}
            className="min-h-10 min-w-40 flex-1 rounded-md bg-raised px-2.5 py-1.5 text-xs text-ink placeholder:text-faint focus:outline-none"
          />
          <span
            role="status"
            aria-live="polite"
            title={draftSaveState.message}
            className={`text-2xs tabular-nums ${
              draftSaveState.status === "error"
                ? "text-fail"
                : draftSaveState.status === "saved"
                  ? "text-pass"
                  : "text-faint"
            }`}
          >
            {draftSaveState.status === "loading"
              ? "restoring draft…"
              : draftSaveState.status === "saving"
                ? "saving draft…"
                : draftSaveState.status === "saved"
                  ? `draft saved${
                      draftSaveState.updatedAt
                        ? ` · ${new Date(draftSaveState.updatedAt).toLocaleTimeString([], {
                            hour: "numeric",
                            minute: "2-digit",
                          })}`
                        : ""
                    }`
                  : draftSaveState.status === "error"
                    ? "draft not saved"
                    : "draft autosave ready"}
          </span>
          {draftSaveState.status === "error" && draftSaveState.retryable ? (
            <button
              type="button"
              onClick={onRetryDraftSave}
              className="min-h-10 rounded-md px-2 text-2xs text-muted transition-colors hover:text-ink active:scale-[0.96]"
            >
              Retry
            </button>
          ) : null}
          {submissionError ? (
            <span className="text-2xs text-fail" role="alert">
              {submissionError}
            </span>
          ) : null}
          <span className="flex items-center gap-2">
            <Button variant="ghost" onClick={onSkip}>
              Skip this clip
            </Button>
            <Button
              onClick={() => void save()}
              disabled={!complete || submitting}
              title={
                complete
                  ? undefined
                  : "answer all 11 checks and the ship question first"
              }
            >
              {submitting ? "Saving grade…" : "Save grade & next"}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
