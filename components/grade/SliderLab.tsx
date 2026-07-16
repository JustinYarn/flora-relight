"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EvalDefinition,
  EvalResult,
  GradeClipDraft,
  GradeDraftAnswer,
  Run,
} from "@/lib/types";
import { evalDefsForRun, isLampRun } from "@/lib/lamp-evaluation";
import {
  isSliderClipComplete,
  LAMP_SLIDER_DRAFT_ID,
  numericScoreForAnswer,
  pointsForSliderScore,
  verdictForSliderScore,
} from "@/lib/slider-grade";
import { PairPlayer } from "@/components/library/PairPlayer";
import { formatRunDate } from "@/components/library/derive";
import {
  finalLampIteration,
  finalLampVideo,
} from "@/components/grade/derive";
import {
  type GradeDraftSaveState,
  useGradeDraft,
} from "@/components/grade/useGradeDraft";
import { EmptyState, verdictColor } from "@/components/ui";

type AiReadState = "idle" | "loading" | "ready" | "error";

function emptyClipDraft(): GradeClipDraft {
  return { answers: {}, overallNote: "" };
}

function signed(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "±0";
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

function scoreAnchors(definition: EvalDefinition): Array<{
  score: number;
  label: string;
}> {
  if (definition.id === "lighting-quality-delta") {
    return [
      { score: 0, label: "worse" },
      { score: 40, label: "unchanged" },
      { score: 65, label: "meaningful" },
      { score: 80, label: "clearly better" },
      { score: 100, label: "exceptional" },
    ];
  }
  if (definition.id === "audio-integrity") {
    return [
      { score: 0, label: "broken" },
      { score: 100, label: "preserved" },
    ];
  }
  return [
    { score: 0, label: "broken" },
    { score: definition.borderlineThreshold, label: "borderline" },
    { score: definition.passThreshold, label: "passes" },
    { score: 100, label: "excellent" },
  ];
}

function SliderScoreRow({
  definition,
  answer,
  aiResult,
  aiVisible,
  onScore,
  onNote,
}: {
  definition: EvalDefinition;
  answer?: GradeDraftAnswer;
  aiResult?: EvalResult;
  aiVisible: boolean;
  onScore: (score: number) => void;
  onNote: (note: string) => void;
}) {
  const score = numericScoreForAnswer(answer);
  const verdict =
    score === undefined
      ? undefined
      : verdictForSliderScore(score, definition);
  const color = verdict ? verdictColor(verdict) : "var(--muted)";
  const anchors = scoreAnchors(definition);
  const isAudio = definition.id === "audio-integrity";
  const aiGap =
    aiVisible && score !== undefined && aiResult
      ? score - aiResult.score
      : undefined;

  return (
    <div
      className={`py-4 ${
        definition.id === "lighting-quality-delta"
          ? "rounded-xl bg-surface px-4 shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_2px_8px_rgba(0,0,0,0.16)]"
          : ""
      }`}
    >
      <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
        <span className="w-60 shrink-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">
              {definition.name}
            </span>
            {definition.id === "lighting-quality-delta" ? (
              <span className="rounded-full bg-raised px-2 py-0.5 text-2xs text-accent">
                key experiment
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-pretty text-2xs leading-relaxed text-faint">
            {definition.description}
          </span>
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            {isAudio ? (
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {[
                  { score: 0, label: "Broken" },
                  { score: 100, label: "Preserved" },
                ].map((option) => {
                  const selected = score === option.score;
                  return (
                    <button
                      key={option.score}
                      type="button"
                      onClick={() => onScore(option.score)}
                      aria-pressed={selected}
                      className={`min-h-10 flex-1 rounded-lg border px-3 py-1.5 text-sm transition-[transform,color,background-color,border-color] duration-150 ease-out active:scale-[0.96] ${
                        selected
                          ? "border-accent bg-raised text-ink"
                          : "border-edge text-muted hover:border-faint hover:text-ink"
                      }`}
                    >
                      <span className="mr-1 tabular-nums">{option.score}</span>
                      {option.label}
                    </button>
                  );
                })}
              </span>
            ) : (
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={score ?? 50}
                onChange={(event) => onScore(Number(event.target.value))}
                aria-label={`${definition.name} numerical score`}
                aria-valuetext={
                  score === undefined
                    ? "Not rated"
                    : `${score} out of 100, ${verdict}`
                }
                className="h-10 min-w-0 flex-1 cursor-pointer accent-accent"
              />
            )}
            <output
              className="w-16 shrink-0 text-right text-lg font-semibold tabular-nums"
              style={{ color }}
              aria-live="polite"
            >
              {score === undefined ? "—" : score}
              <span className="ml-0.5 text-2xs font-normal text-faint">
                /100
              </span>
            </output>
          </div>

          <div
            className={`mt-1 grid gap-2 text-2xs text-faint ${
              anchors.length === 5
                ? "grid-cols-5"
                : anchors.length === 4
                  ? "grid-cols-4"
                  : "grid-cols-2"
            }`}
            aria-hidden="true"
          >
            {anchors.map((anchor, index) => (
              <span
                key={`${anchor.score}-${anchor.label}`}
                className={`text-pretty ${
                  index === 0
                    ? "text-left"
                    : index === anchors.length - 1
                      ? "text-right"
                      : "text-center"
                }`}
              >
                <span className="tabular-nums">{anchor.score}</span>{" "}
                {anchor.label}
              </span>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
            <span className="tabular-nums" style={{ color }}>
              {score === undefined
                ? "move the slider to rate"
                : `${verdict} at this row's ${definition.borderlineThreshold}/${definition.passThreshold} thresholds`}
            </span>
            {aiVisible ? (
              aiResult ? (
                <>
                  <span className="text-faint">·</span>
                  <span className="tabular-nums text-muted">
                    AI {Math.round(aiResult.score)}
                  </span>
                  <span
                    className="tabular-nums text-muted"
                    title="your numerical score minus the AI score"
                  >
                    gap {aiGap === undefined ? "—" : signed(aiGap)}
                  </span>
                </>
              ) : (
                <span className="text-borderline">
                  AI result was not returned
                </span>
              )
            ) : null}
          </div>

          {score !== undefined ? (
            <input
              value={answer?.note ?? ""}
              onChange={(event) => onNote(event.target.value)}
              placeholder="what made you choose this number? (optional)"
              aria-label={`Optional note for ${definition.name}`}
              maxLength={4000}
              className="mt-2 min-h-10 w-full rounded-md bg-raised px-2.5 py-1.5 text-xs text-ink placeholder:text-faint focus:outline-none"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SaveStatus({
  state,
  onRetry,
}: {
  state: GradeDraftSaveState;
  onRetry: () => void;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span
        role="status"
        aria-live="polite"
        title={state.message}
        className={`text-2xs tabular-nums ${
          state.status === "error"
            ? "text-fail"
            : state.status === "saved"
              ? "text-pass"
              : "text-faint"
        }`}
      >
        {state.status === "loading"
          ? "restoring slider work…"
          : state.status === "saving"
            ? "saving slider work…"
            : state.status === "saved"
              ? "slider work saved"
              : state.status === "error"
                ? "slider work not saved"
                : "separate autosave ready"}
      </span>
      {state.status === "error" && state.retryable ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-10 rounded-md px-2 text-2xs text-muted transition-[transform,color] duration-150 ease-out hover:text-ink active:scale-[0.96]"
        >
          Retry
        </button>
      ) : null}
    </span>
  );
}

export function SliderLab({ runs }: { runs: Run[] }) {
  const lampRuns = useMemo(
    () =>
      runs
        .filter(isLampRun)
        .sort((left, right) => right.createdAt - left.createdAt),
    [runs]
  );
  const { draft, ready, saveState, updateDraft, retry } = useGradeDraft(
    LAMP_SLIDER_DRAFT_ID
  );
  const selectedRun =
    lampRuns.find((run) => run.id === draft?.currentRunId) ?? lampRuns[0];
  const gradeDefs = selectedRun ? evalDefsForRun(selectedRun) : [];
  const clipDraft = selectedRun
    ? draft?.clips[selectedRun.id] ?? emptyClipDraft()
    : emptyClipDraft();
  const answeredCount = gradeDefs.filter(
    (definition) =>
      numericScoreForAnswer(clipDraft.answers[definition.id]) !== undefined
  ).length;
  const complete =
    gradeDefs.length > 0 && answeredCount === gradeDefs.length;
  const completedRuns = lampRuns.filter((run) =>
    isSliderClipComplete(
      draft?.clips[run.id],
      evalDefsForRun(run).map((definition) => definition.id)
    )
  ).length;

  const [aiRun, setAiRun] = useState<Run | null>(null);
  const [aiReadState, setAiReadState] = useState<AiReadState>("idle");
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiVisible, setAiVisible] = useState(false);
  const aiRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!ready || lampRuns.length === 0 || draft?.currentRunId === selectedRun?.id) {
      return;
    }
    updateDraft(
      (workspace) => ({ ...workspace, currentRunId: lampRuns[0].id }),
      { immediate: true }
    );
  }, [
    draft?.currentRunId,
    lampRuns,
    ready,
    selectedRun?.id,
    updateDraft,
  ]);

  useEffect(() => {
    aiRequest.current?.abort();
    aiRequest.current = null;
    setAiRun(null);
    setAiReadState("idle");
    setAiError(null);
    setAiVisible(false);
  }, [selectedRun?.id]);

  useEffect(
    () => () => {
      aiRequest.current?.abort();
    },
    []
  );

  if (!ready) {
    return (
      <p className="py-10 text-center text-2xs text-faint">
        restoring separate slider work…
      </p>
    );
  }

  if (lampRuns.length === 0 || !selectedRun) {
    return (
      <EmptyState
        title="No Lamp finals for the Slider Lab"
        hint="Finish a Lamp run first. This experiment uses the same provider-backed Final videos as Grade, but stores its numerical ratings separately."
      />
    );
  }

  const relit = finalLampVideo(selectedRun);
  const aiResults = finalLampIteration(aiRun ?? selectedRun)?.evalResults ?? [];
  const comparisons = gradeDefs.flatMap((definition) => {
    const human = numericScoreForAnswer(clipDraft.answers[definition.id]);
    const ai = aiResults.find((result) => result.evalId === definition.id);
    return human !== undefined && ai ? [{ definition, human, ai }] : [];
  });
  const meanAbsoluteGap =
    comparisons.length > 0
      ? comparisons.reduce(
          (sum, comparison) =>
            sum + Math.abs(comparison.human - comparison.ai.score),
          0
        ) / comparisons.length
      : undefined;
  const largestGap = [...comparisons].sort(
    (left, right) =>
      Math.abs(right.human - right.ai.score) -
      Math.abs(left.human - left.ai.score)
  )[0];
  const lightingComparison = comparisons.find(
    (comparison) => comparison.definition.id === "lighting-quality-delta"
  );

  const updateClip = (
    update: (current: GradeClipDraft) => GradeClipDraft
  ): void => {
    updateDraft((workspace) => ({
      ...workspace,
      clips: {
        ...workspace.clips,
        [selectedRun.id]: update(
          workspace.clips[selectedRun.id] ?? emptyClipDraft()
        ),
      },
    }));
  };

  const toggleAiComparison = async (): Promise<void> => {
    if (aiReadState === "loading") return;
    if (aiVisible) {
      setAiVisible(false);
      return;
    }
    if (aiRun) {
      setAiVisible(true);
      return;
    }

    aiRequest.current?.abort();
    const controller = new AbortController();
    aiRequest.current = controller;
    setAiReadState("loading");
    setAiError(null);
    try {
      const response = await fetch(
        `/api/runs?id=${encodeURIComponent(selectedRun.id)}&revealFinalEvaluation=1`,
        { cache: "no-store", signal: controller.signal }
      );
      const payload = (await response.json().catch(() => null)) as
        | { run?: Run; error?: string }
        | null;
      if (!response.ok || !payload?.run) {
        throw new Error(
          payload?.error ??
            `Saved AI evaluation could not be read (${response.status}).`
        );
      }
      if (controller.signal.aborted) return;
      setAiRun(payload.run);
      setAiReadState("ready");
      setAiVisible(true);
    } catch (error) {
      if (controller.signal.aborted) return;
      setAiReadState("error");
      setAiError(
        error instanceof Error
          ? error.message
          : "Saved AI evaluation could not be read."
      );
    } finally {
      if (aiRequest.current === controller) aiRequest.current = null;
    }
  };

  return (
    <div>
      <section className="rounded-xl bg-surface px-4 py-3 shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_2px_8px_rgba(0,0,0,0.16)]">
        <div className="flex flex-wrap items-start gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink">
              Lamp Slider Lab
            </span>
            <span className="mt-0.5 block max-w-3xl text-pretty text-2xs leading-relaxed text-muted">
              Rate the same nine Lamp checks on an exact 0–100 scale. This
              experiment autosaves to its own calibration draft and never
              changes the run, its AI evaluation, or your canonical Grade.
            </span>
          </span>
          <span className="text-right text-2xs tabular-nums text-muted">
            {completedRuns} of {lampRuns.length} clips complete
          </span>
        </div>
      </section>

      <div className="mt-5 flex flex-wrap items-center gap-2 border-b border-edge pb-4">
        <label
          htmlFor="slider-lab-run"
          className="text-2xs font-medium uppercase tracking-[0.14em] text-faint"
        >
          Video to rate
        </label>
        <select
          id="slider-lab-run"
          value={selectedRun.id}
          onChange={(event) =>
            updateDraft(
              (workspace) => ({
                ...workspace,
                currentRunId: event.target.value,
              }),
              { immediate: true }
            )
          }
          className="min-h-10 min-w-0 max-w-full flex-1 rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm text-ink transition-[transform,border-color,background-color] duration-150 ease-out hover:border-faint focus:border-accent focus:outline-none active:scale-[0.99] sm:max-w-xl"
        >
          {lampRuns.map((run) => {
            const runComplete = isSliderClipComplete(
              draft?.clips[run.id],
              evalDefsForRun(run).map((definition) => definition.id)
            );
            return (
              <option key={run.id} value={run.id}>
                {runComplete ? "✓ " : ""}
                {run.originalVideo.label} · {formatRunDate(run.createdAt)} ·{" "}
                {run.id.slice(-6)}
              </option>
            );
          })}
        </select>
        <SaveStatus state={saveState} onRetry={retry} />
      </div>

      <div className="mt-5 [&>button]:max-w-none">
        <PairPlayer
          original={selectedRun.originalVideo}
          relit={relit}
          audible="relit"
          relitLabel={`FINAL VIDEO · v${finalLampIteration(selectedRun)?.index ?? 2}`}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge pb-4">
        <span
          className={`text-2xs tabular-nums ${
            complete ? "text-pass" : "text-muted"
          }`}
        >
          {answeredCount} of {gradeDefs.length} sliders rated
        </span>
        <span className="text-pretty text-2xs text-faint">
          AI stays hidden until all sliders are set, so the first number remains
          yours.
        </span>
        <button
          type="button"
          onClick={() => void toggleAiComparison()}
          disabled={!complete || aiReadState === "loading"}
          className="ml-auto min-h-10 rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition-[transform,color,background-color,border-color] duration-150 ease-out hover:border-faint disabled:cursor-not-allowed disabled:text-faint active:scale-[0.96]"
          title={
            complete
              ? undefined
              : "Rate all nine sliders before revealing the saved AI scores"
          }
        >
          {aiReadState === "loading"
            ? "Loading saved AI…"
            : aiVisible
              ? "Hide AI comparison"
              : aiReadState === "error"
                ? "Try AI comparison again"
                : "Reveal AI comparison"}
        </button>
      </div>

      {aiError ? (
        <p className="mt-3 text-pretty text-2xs text-fail" role="alert">
          {aiError}
        </p>
      ) : null}

      {aiVisible ? (
        <section className="mt-4 grid gap-3 rounded-xl bg-surface p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_2px_8px_rgba(0,0,0,0.16)] sm:grid-cols-3">
          <span>
            <span className="block text-2xl font-semibold tabular-nums text-ink">
              {lightingComparison
                ? signed(
                    lightingComparison.human - lightingComparison.ai.score
                  )
                : "—"}
            </span>
            <span className="text-2xs text-faint">
              lighting gap · you minus AI
            </span>
          </span>
          <span>
            <span className="block text-2xl font-semibold tabular-nums text-ink">
              {meanAbsoluteGap === undefined
                ? "—"
                : Math.round(meanAbsoluteGap)}
            </span>
            <span className="text-2xs text-faint">
              mean absolute gap across returned checks
            </span>
          </span>
          <span>
            <span className="block text-sm font-semibold text-ink">
              {largestGap?.definition.name ?? "No comparison yet"}
            </span>
            <span className="text-2xs tabular-nums text-faint">
              {largestGap
                ? `largest raw gap · ${signed(
                    largestGap.human - largestGap.ai.score
                  )}`
                : "the AI returned no matching scores"}
            </span>
          </span>
        </section>
      ) : null}

      <section className="mt-6 divide-y divide-edge border-b border-t border-edge">
        {gradeDefs.map((definition) => (
          <SliderScoreRow
            key={definition.id}
            definition={definition}
            answer={clipDraft.answers[definition.id]}
            aiResult={aiResults.find(
              (result) => result.evalId === definition.id
            )}
            aiVisible={aiVisible}
            onScore={(score) =>
              updateClip((current) => ({
                ...current,
                answers: {
                  ...current.answers,
                  [definition.id]: {
                    points: pointsForSliderScore(score),
                    numericScore: score,
                    note: current.answers[definition.id]?.note ?? "",
                  },
                },
              }))
            }
            onNote={(note) =>
              updateClip((current) => {
                const existing = current.answers[definition.id];
                return existing
                  ? {
                      ...current,
                      answers: {
                        ...current.answers,
                        [definition.id]: { ...existing, note },
                      },
                    }
                  : current;
              })
            }
          />
        ))}
      </section>

      <p className="mt-4 text-pretty text-2xs leading-relaxed text-faint">
        The hidden compatibility bucket stored beside each slider value exists
        only so this experiment can reuse durable draft autosave. All displayed
        comparisons use your exact numerical score.
      </p>
    </div>
  );
}
