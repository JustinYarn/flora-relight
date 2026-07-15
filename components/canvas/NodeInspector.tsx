"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  EvalResult,
  MegaPrompt,
  PipelineNode,
  Run,
  RunConfig,
  ViolationSeverity,
  WorkflowMode,
} from "@/lib/types";
import { EVAL_DEFS, getEvalDef } from "@/lib/prompts/eval-defs";
import {
  LAMP_EVAL_DEFS,
  getLampEvalDef,
  isLampRun,
} from "@/lib/lamp-evaluation";
import { initialMegaPrompt } from "@/lib/prompts/mega-prompt";
import { MANIFEST_PROMPT } from "@/lib/prompts/manifest";
import { formatTime } from "@/lib/util";
import { isArchivedLostGenerationId } from "@/lib/lost-interaction";
import {
  Badge,
  ScoreMeter,
  SectionTitle,
  StatusDot,
  VerdictBadge,
} from "@/components/ui";
import { kindColor, PROVIDER_MODELS } from "@/components/canvas/PipelineNode";
import { promptRoleForNode } from "@/components/canvas/prompt-map";

type Mode = "mock" | "live";
type Iteration = Run["iterations"][number];

function severityColor(severity: ViolationSeverity): string {
  return severity === "critical"
    ? "var(--fail)"
    : severity === "major"
      ? "var(--borderline)"
      : "var(--faint)";
}

function evalName(id: string): string {
  return EVAL_DEFS.find((definition) => definition.id === id)?.name ?? id;
}

function DeltaChip({ delta }: { delta: number }) {
  const positive = delta >= 0;
  return (
    <span
      className="text-2xs font-semibold tabular-nums"
      style={{ color: positive ? "var(--pass)" : "var(--fail)" }}
      title="Score change from the previous video"
    >
      {positive ? "+" : ""}
      {delta.toFixed(1)}
    </span>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      className="rounded-lg bg-raised px-3 py-2.5"
      style={{ boxShadow: "0 0 0 1px rgba(255, 255, 255, 0.06)" }}
    >
      <p className="text-2xs font-medium uppercase tracking-[0.12em] text-faint">
        {label}
      </p>
      <div className="mt-1 text-xs font-medium text-ink">{value}</div>
    </div>
  );
}

interface TraceItem {
  label: string;
  value: ReactNode;
  color?: string;
}

function PromptTrace({ items }: { items: TraceItem[] }) {
  return (
    <ol
      className="rounded-xl bg-raised px-3 py-2"
      style={{
        boxShadow:
          "0 0 0 1px rgba(255, 255, 255, 0.07), 0 8px 22px rgba(0, 0, 0, 0.14)",
      }}
    >
      {items.map((item, index) => (
        <li key={item.label} className="relative flex gap-3 py-2">
          {index < items.length - 1 ? (
            <span
              aria-hidden="true"
              className="absolute bottom-[-8px] left-[4px] top-[19px] w-px bg-edge"
            />
          ) : null}
          <span
            aria-hidden="true"
            className="relative mt-1.5 size-[9px] shrink-0 rounded-full"
            style={{ background: item.color ?? "var(--faint)" }}
          />
          <div className="min-w-0">
            <p className="text-2xs font-medium uppercase tracking-[0.12em] text-faint">
              {item.label}
            </p>
            <div className="mt-0.5 text-pretty text-xs leading-relaxed text-ink">
              {item.value}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function CopyPromptButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1600);
    } catch {
      setState("failed");
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="inline-flex min-h-10 shrink-0 items-center rounded-lg px-3 text-2xs font-medium text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.09)] transition-[color,background-color,scale] duration-150 ease-out hover:bg-raised hover:text-ink active:scale-[0.96]"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy text"}
    </button>
  );
}

function PromptDisclosure({
  eyebrow,
  title,
  text,
  note,
  source,
  testId,
}: {
  eyebrow: string;
  title: string;
  text: string;
  note: string;
  source: string;
  testId: string;
}) {
  return (
    <details
      data-testid={testId}
      className="group rounded-xl bg-raised"
      style={{
        boxShadow:
          "0 0 0 1px rgba(255, 255, 255, 0.07), 0 8px 22px rgba(0, 0, 0, 0.12)",
      }}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-2xs font-semibold uppercase tracking-[0.13em] text-accent">
            {eyebrow}
          </span>
          <span className="mt-0.5 block truncate text-xs font-medium text-ink">
            {title}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="text-lg text-faint transition-transform duration-200 ease-out group-open:rotate-90"
        >
          ›
        </span>
      </summary>
      <div className="px-3.5 pb-3.5">
        <div className="flex items-start justify-between gap-3 border-t border-edge pt-3">
          <p className="text-pretty text-2xs leading-relaxed text-muted">{note}</p>
          <CopyPromptButton text={text} />
        </div>
        <pre
          tabIndex={0}
          aria-label={`${title} source text`}
          className="mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg bg-canvas p-3 font-[family-name:var(--font-geist-mono)] text-2xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {text}
        </pre>
        <p className="mt-2 font-[family-name:var(--font-geist-mono)] text-[10px] text-faint">
          source · {source}
        </p>
      </div>
    </details>
  );
}

/** Most recent result for an eval, scanning iterations newest to oldest. */
function latestResultFor(run: Run | undefined, evalId: string): EvalResult | null {
  if (!run) return null;
  for (let index = run.iterations.length - 1; index >= 0; index -= 1) {
    const found = run.iterations[index].evalResults.find(
      (result) => result.evalId === evalId
    );
    if (found) return found;
  }
  return null;
}

function AttemptPicker({
  attempts,
  selectedIteration,
  onSelect,
}: {
  attempts: Array<{ iteration: Iteration; result: EvalResult }>;
  selectedIteration: number;
  onSelect: (iteration: number) => void;
}) {
  if (attempts.length === 0) return null;
  return (
    <div
      className="rounded-xl bg-raised p-2"
      style={{ boxShadow: "0 0 0 1px rgba(255, 255, 255, 0.07)" }}
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
          Result in view
        </span>
        <span className="text-2xs text-faint">Select Initial or Final to trace it</span>
      </div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        {attempts.map(({ iteration, result }) => (
          <button
            type="button"
            key={iteration.index}
            onClick={() => onSelect(iteration.index)}
            aria-pressed={iteration.index === selectedIteration}
            className="flex min-h-11 items-center justify-between gap-2 rounded-lg bg-canvas px-2.5 py-2 text-left shadow-[0_0_0_1px_rgba(255,255,255,0.07)] transition-[background-color,box-shadow,scale] duration-150 ease-out hover:bg-surface active:scale-[0.98] aria-pressed:bg-surface aria-pressed:shadow-[0_0_0_1px_var(--accent)]"
          >
            <div>
              <span className="block text-2xs font-semibold uppercase tracking-[0.1em] text-faint">
                {iteration.index === 1
                  ? "Initial"
                  : iteration.index === 2
                    ? "Final"
                    : `v${iteration.index}`}
              </span>
              <span className="mt-0.5 block text-sm font-semibold tabular-nums text-ink">
                {Math.round(result.score)}
              </span>
            </div>
            <div className="flex flex-col items-end gap-1">
              <VerdictBadge verdict={result.verdict} />
              {typeof result.deltaFromPrevious === "number" ? (
                <DeltaChip delta={result.deltaFromPrevious} />
              ) : null}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function correctionId(evalId: string, aspect: string): string {
  return `corr:${evalId}:${aspect.trim().toLowerCase().replace(/\s+/g, "-")}`;
}

function runPromptSource(iteration: number): string {
  return `run.iterations · ${iteration === 1 ? "Initial" : iteration === 2 ? "Final" : `v${iteration}`} · megaPrompt.rendered`;
}

function codeCheckSpecificationNote(evalId: string): string {
  if (evalId === "audio-integrity") {
    return "No model prompt. Lamp verifies audio presence, complete source/generated/remuxed timeline agreement, and the restored source-audio fingerprint. Any mismatch fails closed before visual evaluation.";
  }
  if (evalId === "temporal-alignment") {
    return "No model prompt. This planned local correlation check is not implemented in Lamp, so it remains explicitly unavailable rather than receiving a manufactured score.";
  }
  return "No model prompt. This describes the code-check specification; the selected run status and result show whether that procedure actually executed.";
}

function promptViewFor(
  run: Run | undefined,
  iteration: Iteration | undefined
): {
  prompt: MegaPrompt;
  attempt: number;
  runBound: boolean;
  consumed: boolean;
  source: string;
} {
  const workflowMode =
    run?.workflowMode ?? (run?.workflowId === "lamp-v1" ? "lamp" : "flora");
  const attempt = iteration?.index ?? Math.max(1, run?.serverExecution?.iteration ?? 1);
  const operation = run?.providerOperations?.find(
    (item) =>
      item.kind === "video_generation" &&
      item.iteration === attempt &&
      !isArchivedLostGenerationId(item.id)
  );
  const executionPrompt =
    attempt === 1 ? run?.serverExecution?.renderedPrompt : undefined;
  const authoritativeLivePrompt = run?.live
    ? operation?.renderedPrompt ?? executionPrompt
    : undefined;
  if (authoritativeLivePrompt) {
    const prompt = iteration
      ? { ...iteration.megaPrompt, corrections: [...iteration.megaPrompt.corrections] }
      : initialMegaPrompt(workflowMode);
    prompt.version = attempt;
    prompt.rendered = authoritativeLivePrompt;
    const operationCompleted =
      operation?.status === "completed" &&
      Boolean(operation.result) &&
      operation.renderedPrompt === authoritativeLivePrompt;
    return {
      prompt,
      attempt,
      runBound: true,
      consumed: operationCompleted,
      source: operation?.renderedPrompt
        ? `run.providerOperations · video ${attempt} · renderedPrompt`
        : "run.serverExecution.renderedPrompt",
    };
  }
  if (iteration) {
    return {
      prompt: iteration.megaPrompt,
      attempt: iteration.index,
      runBound: true,
      consumed: Boolean(iteration.generatedVideo),
      source: runPromptSource(iteration.index),
    };
  }
  const prompt = initialMegaPrompt(workflowMode);
  const execution = run?.serverExecution;
  if (execution?.renderedPrompt) {
    prompt.version = Math.max(1, execution.iteration);
    prompt.rendered = execution.renderedPrompt;
    return {
      prompt,
      attempt: Math.max(1, execution.iteration),
      runBound: true,
      consumed: false,
      source: "run.serverExecution.renderedPrompt",
    };
  }
  return {
    prompt,
    attempt: 1,
    runBound: false,
    consumed: false,
    source: "lib/prompts/mega-prompt.ts",
  };
}

function generationBriefNote(
  mode: Mode,
  runBound: boolean,
  consumed: boolean
): string {
  if (!runBound) {
    return "This is the current baseline render before a run adds any eval-driven fixes. It is an example, not a historical request.";
  }
  if (!consumed) {
    return "These exact bytes are bound to the selected video. Provider consumption is not confirmed yet, so this is not labeled as a prompt the model already consumed.";
  }
  return mode === "live"
    ? "This rendered text is stored with the selected video and bound to its video-generation request."
    : "This is the exact compiled brief attached to the demo video. Demo output is scripted, so the mock provider does not semantically interpret these words.";
}

function EvalSection({
  evalId,
  nodeId,
  run,
  mode,
  workflowMode,
}: {
  evalId: string;
  nodeId: string;
  run?: Run;
  mode: Mode;
  workflowMode: WorkflowMode;
}) {
  const lamp = run ? isLampRun(run) : workflowMode === "lamp";
  const definition = lamp ? getLampEvalDef(evalId) : getEvalDef(evalId);
  const attempts =
    run?.iterations.flatMap((iteration) => {
      const result = iteration.evalResults.find((item) => item.evalId === evalId);
      return result ? [{ iteration, result }] : [];
    }) ?? [];
  const [selectedAttempt, setSelectedAttempt] = useState<number | null>(null);
  const latestPair = attempts[attempts.length - 1];
  const focusPair =
    attempts.find(({ iteration }) => iteration.index === selectedAttempt) ?? latestPair;
  const latestRunIteration = run?.iterations[run.iterations.length - 1];
  const focusIteration = focusPair?.iteration ?? latestRunIteration;
  const focusResult = focusPair?.result;
  const promptView = promptViewFor(run, focusIteration);
  const brief = promptView.prompt;
  const nextIteration =
    focusResult && run
      ? run.iterations.find(
          (iteration) => iteration.index === focusResult.iteration + 1
        )
      : undefined;
  const priorCorrections = brief.corrections.filter(
    (correction) => correction.sourceEvalId === evalId
  );
  const nextEvalCorrections =
    nextIteration?.megaPrompt.corrections.filter(
      (correction) => correction.sourceEvalId === evalId
    ) ?? [];
  const nextActiveCorrections = nextEvalCorrections.filter(
    (correction) => !correction.resolved
  );
  const resolvedNextCorrections = nextEvalCorrections.filter(
    (correction) =>
      correction.resolved &&
      priorCorrections.some(
        (prior) => prior.id === correction.id && !prior.resolved
      )
  );
  const isRubric = Boolean(definition.promptTemplate);
  const isAudio = evalId === "audio-integrity";
  const scriptedDemoResult = mode === "mock" && Boolean(focusResult);
  const nodeState = run?.nodeStates[nodeId];
  const liveVisualSkipped =
    mode === "live" &&
    Boolean(run) &&
    !isAudio &&
    attempts.length === 0 &&
    nodeState?.status === "skipped";
  const liveAudioStatus =
    mode === "live" && isAudio && attempts.length === 0
      ? nodeState?.status
      : undefined;
  const audioSkipped = isAudio && Boolean(run) && nodeState?.status === "skipped";
  const operationalAudioResult =
    isAudio &&
    (liveAudioStatus === "succeeded" || liveAudioStatus === "failed");
  const checkExecuted = Boolean(focusResult) || operationalAudioResult;
  const focusVideoLabel =
    (focusResult?.iteration ?? promptView.attempt) === 1 ? "Initial" : "Final";
  const transitionParts = [
    nextActiveCorrections.length > 0
      ? `${nextActiveCorrections.length} added or carried`
      : null,
    resolvedNextCorrections.length > 0
      ? `${resolvedNextCorrections.length} resolved and removed`
      : null,
  ].filter((part): part is string => Boolean(part));
  const methodLabel =
    definition.method === "deterministic"
      ? "Code-check specification"
      : definition.method === "hybrid"
        ? "Holistic rubric · local tier not run"
        : "Holistic Gemini rubric";
  const feedForward = isAudio
    ? !run
      ? "No run selected"
      : audioSkipped
        ? "Skipped · no post-remux check"
        : `${focusVideoLabel} audio verified before visual evaluation · never edits a generation brief`
    : liveVisualSkipped
      ? "Skipped · no automated correction"
      : !focusResult
        ? run
          ? "Waiting for a result"
          : "No run selected"
        : !nextIteration
          ? focusResult.violations.length > 0
            ? "Finding recorded · no later brief compiled"
            : "Final result · no later brief compiled"
          : transitionParts.length > 0
            ? `${transitionParts.join(" · ")} in brief v${nextIteration.megaPrompt.version}`
            : focusResult.verdict === "pass"
              ? `Passed · no prompt change in brief v${nextIteration.megaPrompt.version}`
              : `No actionable correction recorded · no prompt change in brief v${nextIteration.megaPrompt.version}`;

  const decisionValue: ReactNode = focusResult ? (
    <span className="inline-flex items-center gap-2">
      {focusResult.iteration === 1 ? "Initial" : "Final"} · {Math.round(focusResult.score)}
      <VerdictBadge verdict={focusResult.verdict} />
    </span>
  ) : liveVisualSkipped ? (
    "Skipped on this selected run"
  ) : isAudio && !run ? (
    "No run selected"
  ) : audioSkipped ? (
    "Skipped on this run"
  ) : liveAudioStatus === "succeeded" ? (
    <span className="inline-flex items-center gap-2">
      Original audio verified
      <VerdictBadge verdict="pass" />
    </span>
  ) : liveAudioStatus === "failed" ? (
    <span className="inline-flex items-center gap-2">
      Audio verification needs review
      <VerdictBadge verdict="fail" />
    </span>
  ) : isAudio && liveAudioStatus ? (
    "Waiting for post-remux verification"
  ) : (
    "No result yet"
  );

  return (
    <>
      <section>
        <SectionTitle>Prompt-to-result trace</SectionTitle>
        {focusResult ? (
          <div className="mb-2">
            <AttemptPicker
              attempts={attempts}
              selectedIteration={focusResult.iteration}
              onSelect={setSelectedAttempt}
            />
          </div>
        ) : null}
        <PromptTrace
          items={[
            {
              label: isAudio
                ? "Runs after"
                : scriptedDemoResult
                  ? "Demo candidate labeled with"
                  : !promptView.runBound
                    ? "Would generate with"
                    : !promptView.consumed
                      ? "Bound with"
                      : "Generated with",
              value: isAudio
                ? "Original audio remux"
                : promptView.runBound
                  ? `Generation brief v${brief.version} · ${promptView.attempt === 1 ? "Initial" : "Final"}`
                  : "Current baseline generation brief",
              color: "var(--accent)",
            },
            {
              label: scriptedDemoResult
                ? "Demo outcome source"
                : !checkExecuted
                  ? "Would be checked by"
                  : "Checked by",
              value: scriptedDemoResult
                ? `${definition.name} · scripted by eval id; this definition is shown for review`
                : isRubric
                  ? `${definition.name} · current canonical rubric`
                  : `${definition.name} · code-check specification`,
              color: scriptedDemoResult
                ? "var(--accent)"
                : isRubric
                  ? "var(--running)"
                  : "var(--muted)",
            },
            {
              label: isAudio ? "Post-remux result" : "Decision in view",
              value: decisionValue,
              color: focusResult
                ? focusResult.verdict === "pass"
                  ? "var(--pass)"
                  : focusResult.verdict === "borderline"
                    ? "var(--borderline)"
                    : "var(--fail)"
                : liveAudioStatus === "succeeded"
                  ? "var(--pass)"
                  : liveAudioStatus === "failed"
                    ? "var(--fail)"
                    : "var(--faint)",
            },
            {
              label: "Feeds forward",
              value: feedForward,
              color: "var(--borderline)",
            },
          ]}
        />
        {liveVisualSkipped ? (
          <p className="mt-2 rounded-lg bg-raised px-3 py-2 text-pretty text-2xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            This panel shows the current definition for review. The selected run
            skipped this check, so it did not produce a score or correction.
          </p>
        ) : liveAudioStatus && attempts.length === 0 ? (
          <p className="mt-2 rounded-lg bg-raised px-3 py-2 text-pretty text-2xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            This run stores audio verification in the node status rather than as a
            scored visual result. It is an operational integrity result, not a
            missing visual evaluation.
          </p>
        ) : mode === "mock" && focusResult ? (
          <p className="mt-2 text-pretty text-2xs leading-relaxed text-faint">
            Demo scores are scripted by eval id. Editing this rubric will not
            recalibrate mock outcomes by itself.
          </p>
        ) : null}
      </section>

      <section>
        <SectionTitle>At a glance</SectionTitle>
        <p className="mb-3 text-pretty text-xs leading-relaxed text-muted">
          {definition.description}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Fact label="Method" value={methodLabel} />
          <Fact
            label="Decision power"
            value={
              definition.hardGate ? (
                <span className="text-fail">Must pass</span>
              ) : (
                "Advisory"
              )
            }
          />
          <Fact label="Weight" value={`${Math.round(definition.weight * 100)}%`} />
          <Fact
            label="Thresholds"
            value={`Pass ≥ ${definition.passThreshold} · Review ≥ ${definition.borderlineThreshold}`}
          />
        </div>
      </section>

      <PromptDisclosure
        eyebrow={
          isAudio
            ? "GENERATION CONTEXT · NOT CHECK INPUT"
            : promptView.runBound
              ? "RUN-BOUND GENERATION PROMPT"
              : "CURRENT BASELINE"
        }
        title={
          isAudio
            ? run
              ? `Video brief v${brief.version} before source-audio finalization`
              : `Baseline video brief v${brief.version} · no audio run selected`
            : promptView.runBound
              ? `Generation brief v${brief.version} for ${promptView.attempt === 1 ? "Initial" : "Final"}`
              : `Baseline generation brief v${brief.version}`
        }
        text={brief.rendered}
        note={
          isAudio
            ? "Shown only as delivery context. Audio Integrity reads the remuxed and ingest audio digests; it does not receive or interpret this generation prompt."
            : generationBriefNote(mode, promptView.runBound, promptView.consumed)
        }
        source={promptView.source}
        testId="generation-prompt-disclosure"
      />

      <PromptDisclosure
        eyebrow={isRubric ? "CURRENT CANONICAL RUBRIC" : "CODE-CHECK SPECIFICATION"}
        title={
          isRubric
            ? `Instructions for ${definition.name}`
            : `Specification for ${definition.name}`
        }
        text={
          definition.promptTemplate ||
          definition.deterministicNote ||
          "No prompt or implementation note is defined."
        }
        note={
          isRubric
            ? lamp
              ? "This is today's code-owned Lamp rubric. Lamp sends all eight visual rubrics in one Gemini request over the complete source and candidate videos. Historical rubric text is not archived per run."
              : "This is today's code-owned Flora rubric. Historical rubric text is not archived per run."
            : codeCheckSpecificationNote(evalId)
        }
        source={
          lamp && evalId === "skin-texture-age"
            ? "lib/lamp-evaluation.ts"
            : "lib/prompts/eval-defs.ts"
        }
        testId="rubric-prompt-disclosure"
      />

      <section>
        <SectionTitle
          right={
            nextIteration ? (
              <Badge color="var(--accent)">brief v{nextIteration.megaPrompt.version}</Badge>
            ) : undefined
          }
        >
          {isAudio ? "What happens after this check" : "What this check changed next"}
        </SectionTitle>
        {liveVisualSkipped ? (
          <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            Skipped on this selected run. No automated finding or mega-prompt
            correction was produced.
          </p>
        ) : isAudio && !run ? (
          <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            Select a run to inspect its post-remux verification. The baseline
            generation brief shown above is context only; no audio check has started.
          </p>
        ) : audioSkipped ? (
          <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            Audio Integrity was skipped because no verified Final delivery was
            available. No mega-prompt change was produced.
          </p>
        ) : isAudio && !focusResult ? (
          <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            {liveAudioStatus === "succeeded"
            ? `${focusVideoLabel} passed audio integrity and can continue to its holistic visual evaluation.`
              : liveAudioStatus === "failed"
                ? "The digest did not verify and delivery needs review."
                : "Audio verification has not finished yet."}{" "}
            This post-remux gate never writes into the video generation prompt.
          </p>
        ) : !focusResult ? (
          <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            No result means no correction from this check. Open a completed demo
            video to see Initial findings turn into the Final generation brief.
          </p>
        ) : isAudio && focusResult.violations.length === 0 ? (
          <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            The complete audio timeline and fingerprint matched, so visual
            evaluation continued. Audio Integrity does not alter the video generation prompt.
          </p>
        ) : isAudio ? (
          <ul className="space-y-2">
            {focusResult.violations.map((violation, index) => (
              <li
                key={`${violation.aspect}-${index}`}
                className="rounded-lg bg-raised p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="text-2xs font-semibold uppercase tracking-[0.1em]"
                    style={{ color: severityColor(violation.severity) }}
                  >
                    {violation.severity}
                  </span>
                  <span className="text-xs font-medium text-ink">{violation.aspect}</span>
                  <span className="ml-auto text-2xs text-faint">
                    post-remux action · not a generation fix
                  </span>
                </div>
                <p className="mt-1 text-pretty text-2xs leading-relaxed text-muted">
                  {violation.description}
                </p>
                <p className="mt-2 rounded-md bg-canvas px-2.5 py-2 font-[family-name:var(--font-geist-mono)] text-2xs leading-relaxed text-ink">
                  {violation.correction}
                </p>
              </li>
            ))}
          </ul>
        ) : focusResult.violations.length > 0 || resolvedNextCorrections.length > 0 ? (
          <ul className="space-y-2">
            {focusResult.violations.map((violation, index) => {
              const id = correctionId(evalId, violation.aspect);
              const prior = priorCorrections.find(
                (correction) => correction.id === id && !correction.resolved
              );
              const next = nextEvalCorrections.find(
                (correction) => correction.id === id && !correction.resolved
              );
              const lifecycle = !nextIteration
                ? "recorded · not applied (no later brief)"
                : next
                  ? prior
                    ? `carried or updated in brief v${nextIteration.megaPrompt.version}`
                    : `added to brief v${nextIteration.megaPrompt.version}`
                  : `not admitted to brief v${nextIteration.megaPrompt.version}`;
              return (
                <li
                  key={`${violation.aspect}-${index}`}
                  className="rounded-lg bg-raised p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="text-2xs font-semibold uppercase tracking-[0.1em]"
                      style={{ color: severityColor(violation.severity) }}
                    >
                      {violation.severity}
                    </span>
                    <span className="text-xs font-medium text-ink">
                      {violation.aspect}
                    </span>
                    {typeof violation.frameTimestampSec === "number" ? (
                      <span className="text-2xs text-faint">
                        @ {formatTime(violation.frameTimestampSec)}
                      </span>
                    ) : null}
                    <span className="ml-auto text-2xs text-faint">{lifecycle}</span>
                  </div>
                  <p className="mt-1 text-pretty text-2xs leading-relaxed text-muted">
                    {violation.description}
                  </p>
                  <p className="mt-2 rounded-md bg-canvas px-2.5 py-2 font-[family-name:var(--font-geist-mono)] text-2xs leading-relaxed text-ink">
                    {violation.correction}
                  </p>
                </li>
              );
            })}
            {resolvedNextCorrections.map((correction) => (
              <li
                key={correction.id}
                className="rounded-lg bg-raised p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge color="var(--pass)">resolved</Badge>
                  <span className="text-xs font-medium text-ink">Prior correction cleared</span>
                  <span className="ml-auto text-2xs text-faint">
                    removed from brief v{nextIteration?.megaPrompt.version}
                  </span>
                </div>
                <p className="mt-2 rounded-md bg-canvas px-2.5 py-2 font-[family-name:var(--font-geist-mono)] text-2xs leading-relaxed text-muted line-through decoration-faint">
                  {correction.instruction}
                </p>
              </li>
            ))}
          </ul>
        ) : focusResult.violations.length === 0 ? (
          <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            {focusResult.verdict === "pass"
              ? nextIteration
                ? "This check passed with no active correction to remove, so the next generation brief was unchanged by this check."
                : "This final check passed, so no later generation brief was needed or compiled."
              : nextIteration
                ? "This check did not pass, but the critique recorded no actionable correction, so the next generation brief was unchanged by this check."
                : "This final check did not pass; the critique recorded no actionable correction, and no later brief was compiled."}
          </p>
        ) : null}
      </section>
    </>
  );
}

function ManifestSection({ run, mode }: { run?: Run; mode: Mode }) {
  const skipped = run?.nodeStates.manifest?.status === "skipped";
  const scriptedDemo = mode === "mock" && Boolean(run);
  return (
    <>
      <section>
        <SectionTitle>Where it sits</SectionTitle>
        <PromptTrace
          items={[
            { label: "Definition input", value: "Sampled source-video frames", color: "var(--faint)" },
            { label: "Definition prompt", value: "Scene inventory extractor", color: "var(--running)" },
            { label: "Definition output", value: "Structured person, room, camera, and lighting inventory", color: "var(--pass)" },
            { label: "Intended role", value: "Ground truth for preservation checks", color: "var(--accent)" },
          ]}
        />
        {mode === "live" && skipped ? (
          <p className="mt-2 text-pretty text-2xs leading-relaxed text-muted">
            This stage was skipped on the selected live first cut. The current
            live judge request also does not attach the manifest yet.
          </p>
        ) : scriptedDemo ? (
          <p className="mt-2 text-pretty text-2xs leading-relaxed text-muted">
            The selected demo assigns a scripted manifest directly; it does not
            invoke this extractor prompt. The definition below is for review and
            future live/full-loop behavior.
          </p>
        ) : null}
      </section>
      <PromptDisclosure
        eyebrow="CURRENT CANONICAL EXTRACTOR"
        title="Scene inventory extraction prompt"
        text={MANIFEST_PROMPT}
        note={
          skipped
            ? "Current definition only. It was not sent on the selected run, and historical extractor text is not snapshotted per run."
            : scriptedDemo
              ? "Current definition only. Demo manifest data is scripted, so editing this text does not change demo output by itself."
              : "Today's extraction template. It describes intended eval ground truth and is deliberately never inserted into the generation brief."
        }
        source="lib/prompts/manifest.ts"
        testId="manifest-prompt-disclosure"
      />
    </>
  );
}

function MegaPromptSection({
  run,
  mode,
  onSelectNode,
}: {
  run?: Run;
  mode: Mode;
  onSelectNode: (nodeId: string) => void;
}) {
  const iteration = run?.iterations[run.iterations.length - 1];
  const promptView = promptViewFor(run, iteration);
  const megaPrompt = promptView.prompt;
  const activeCorrections = megaPrompt.corrections.filter(
    (correction) => !correction.resolved
  );

  return (
    <>
      <section>
        <SectionTitle
          right={<Badge color="var(--accent)">v{megaPrompt.version}</Badge>}
        >
          How the brief compiles
        </SectionTitle>
        <PromptTrace
          items={[
            { label: "Immutable", value: "Task framing + six invariant locks", color: "var(--faint)" },
            { label: "Allowed change", value: "Lighting specification", color: "var(--accent)" },
            {
              label: "From evals",
              value: `${activeCorrections.length} active fix${activeCorrections.length === 1 ? "" : "es"}`,
              color: "var(--borderline)",
            },
            { label: "Output", value: `Generation brief v${megaPrompt.version}`, color: "var(--pass)" },
          ]}
        />
      </section>

      <section>
        <SectionTitle>Active fixes in this brief</SectionTitle>
        {activeCorrections.length > 0 ? (
          <ul className="space-y-2">
            {activeCorrections.map((correction) => (
              <li
                key={correction.id}
                className="rounded-lg bg-raised px-3 py-2.5 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
              >
                <div className="flex items-center gap-2">
                  <Badge color={severityColor(correction.severity)}>
                    {correction.severity}
                  </Badge>
                  <span className="text-2xs text-faint">
                    from {evalName(correction.sourceEvalId)}
                  </span>
                </div>
                <p className="mt-2 text-pretty text-xs leading-relaxed text-ink">
                  {correction.instruction}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            No active fixes yet. The first brief is the immutable base plus the
            lighting specification.
          </p>
        )}
      </section>

      <PromptDisclosure
        eyebrow={promptView.runBound ? "RUN-BOUND GENERATION PROMPT" : "CURRENT BASELINE"}
        title={
          promptView.runBound
            ? `${promptView.consumed ? "Exact compiled brief" : "Brief bound"} for attempt ${promptView.attempt}`
            : "Compiled brief before any eval fixes"
        }
        text={megaPrompt.rendered}
        note={generationBriefNote(mode, promptView.runBound, promptView.consumed)}
        source={promptView.source}
        testId="mega-prompt-disclosure"
      />

      <button
        type="button"
        onClick={() => onSelectNode("videogen")}
        className="inline-flex min-h-10 items-center text-xs text-faint transition-colors duration-150 hover:text-ink"
      >
        See where this brief is consumed →
      </button>
    </>
  );
}

function GenerateSection({
  node,
  run,
  mode,
  onSelectNode,
}: {
  node: PipelineNode;
  run?: Run;
  mode: Mode;
  onSelectNode: (nodeId: string) => void;
}) {
  const iteration = run?.iterations[run.iterations.length - 1];
  const promptView = promptViewFor(run, iteration);
  const megaPrompt = promptView.prompt;
  const videoLabel = promptView.attempt === 1 ? "Initial" : "Final";

  return (
    <>
      <section>
        <SectionTitle>Model handoff</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Fact label="Provider" value={node.providerId ?? "—"} />
          <Fact
            label="Mode"
            value={
              <Badge color={mode === "live" ? "var(--pass)" : "var(--accent)"}>
                {mode.toUpperCase()}
              </Badge>
            }
          />
          {node.providerId ? (
            <div className="col-span-2">
              <Fact
                label="Current model label"
                value={
                  <span className="font-[family-name:var(--font-geist-mono)] text-2xs">
                    {PROVIDER_MODELS[node.providerId]}
                  </span>
                }
              />
            </div>
          ) : null}
        </div>
      </section>

      <section>
        <SectionTitle>What the model receives</SectionTitle>
        <PromptTrace
          items={[
            {
              label: "Source",
              value: "The immutable original video",
              color: "var(--faint)",
            },
            {
              label: "Instructions",
              value: `Mega prompt v${megaPrompt.version}`,
              color: "var(--accent)",
            },
            {
              label: "Correction context",
              value:
                promptView.attempt === 1
                  ? "None · this is the Initial generation"
                  : "Every actionable finding from the Initial critique",
              color: "var(--running)",
            },
            {
              label: "Output",
              value: `${videoLabel} relit video`,
              color: "var(--pass)",
            },
          ]}
        />
      </section>
      <PromptDisclosure
        eyebrow={promptView.runBound ? "RUN-BOUND GENERATION PROMPT" : "CURRENT BASELINE"}
        title={
          promptView.runBound
            ? `${promptView.consumed ? "Prompt consumed" : "Prompt bound"} for ${videoLabel}`
            : "Mega prompt for Initial"
        }
        text={megaPrompt.rendered}
        note={generationBriefNote(mode, promptView.runBound, promptView.consumed)}
        source={promptView.source}
        testId="video-generation-prompt-disclosure"
      />
      <button
        type="button"
        onClick={() => onSelectNode("compile")}
        className="inline-flex min-h-10 items-center text-xs text-faint transition-colors duration-150 hover:text-ink"
      >
        Open the mega-prompt compiler →
      </button>
    </>
  );
}

function AggregateSection({
  run,
  onSelectNode,
}: {
  run?: Run;
  onSelectNode: (nodeId: string) => void;
}) {
  const summaries =
    run?.iterations.map((iteration) => {
      const visual = iteration.evalResults.filter(
        (result) => result.evalId !== "audio-integrity"
      );
      const average =
        visual.length > 0
          ? Math.round(
              visual.reduce((sum, result) => sum + result.score, 0) /
                visual.length
            )
          : null;
      return { index: iteration.index, count: visual.length, average };
    }) ?? [];

  return (
    <>
      <section>
        <SectionTitle>Why this node matters</SectionTitle>
        <PromptTrace
          items={[
            {
              label: "Receives",
              value: "Eight visual results returned together for the whole video",
              color: "var(--running)",
            },
            {
              label: "After Initial",
              value: "Consolidates every actionable finding into one correction set",
              color: "var(--borderline)",
            },
            {
              label: "After Final",
              value: "Shows AI grades in Runs; Grade mode starts blind with an optional reveal",
              color: "var(--accent)",
            },
          ]}
        />
      </section>
      {summaries.length > 0 ? (
        <section>
          <SectionTitle>AI summary by video</SectionTitle>
          <div className="grid gap-2 sm:grid-cols-2">
            {summaries.map(({ index, count, average }) => (
              <div
                key={index}
                className="rounded-lg bg-raised px-3 py-2.5 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
              >
                <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
                  {index === 1 ? "Initial critique" : "Final evaluation"}
                </p>
                <div className="mt-1 flex items-baseline justify-between gap-3">
                  <span className="text-lg font-semibold tabular-nums text-ink">
                    {average ?? "—"}
                  </span>
                  <span className="text-2xs tabular-nums text-faint">
                    {count}/8 visual
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <p className="text-pretty text-xs text-faint">
          Scores and fixes appear here once the automated checks finish.
        </p>
      )}
      <button
        type="button"
        onClick={() => onSelectNode("compile")}
        className="inline-flex min-h-10 items-center text-xs text-faint transition-colors duration-150 hover:text-ink"
      >
        Inspect the Final prompt these fixes create →
      </button>
    </>
  );
}

function generationGateSnapshot(
  iteration: Iteration | undefined,
  definitions: typeof EVAL_DEFS
): {
  score: number;
  hardGateFailures: string[];
} | null {
  if (!iteration) return null;
  const results = iteration.evalResults.filter(
    (result) => result.evalId !== "audio-integrity"
  );
  if (results.length === 0) return null;
  let weighted = 0;
  let totalWeight = 0;
  const hardGateFailures: string[] = [];
  for (const result of results) {
    const definition = definitions.find((candidate) => candidate.id === result.evalId);
    if (!definition) continue;
    weighted += definition.weight * result.score;
    totalWeight += definition.weight;
    if (definition.hardGate && result.verdict !== "pass") {
      hardGateFailures.push(result.evalId);
    }
  }
  return {
    score: Math.round((totalWeight > 0 ? weighted / totalWeight : 0) * 10) / 10,
    hardGateFailures,
  };
}

function GateSection({
  run,
  config,
  workflowMode,
}: {
  run?: Run;
  config: RunConfig;
  workflowMode: WorkflowMode;
}) {
  const definitions = run
    ? isLampRun(run)
      ? LAMP_EVAL_DEFS
      : EVAL_DEFS
    : workflowMode === "lamp"
      ? LAMP_EVAL_DEFS
      : EVAL_DEFS;
  const generationHardGates = definitions.filter(
    (definition) => definition.hardGate && definition.id !== "audio-integrity"
  );
  const skipped = run?.nodeStates.gate?.status === "skipped";
  let compositeIteration: Iteration | undefined;
  if (run) {
    for (let index = run.iterations.length - 1; index >= 0; index -= 1) {
      if (run.iterations[index].composite) {
        compositeIteration = run.iterations[index];
        break;
      }
    }
  }
  const gateSnapshot = generationGateSnapshot(compositeIteration, definitions);
  const gatePassed = gateSnapshot
    ? gateSnapshot.score >= config.compositePassThreshold &&
      gateSnapshot.hardGateFailures.length === 0
    : false;
  const audioResult = latestResultFor(run, "audio-integrity");
  const audioStatus = run?.nodeStates["eval-audio"]?.status;

  return (
    <>
      <section>
        <SectionTitle>Pass rule</SectionTitle>
        <p className="text-pretty text-xs leading-relaxed text-muted">
          Full-loop definition: an attempt passes when the Overall score reaches {config.compositePassThreshold}
          {" "}or higher and every must-pass check passes. Otherwise, findings can feed
          the next brief for up to {config.maxIterations} attempts.
        </p>
      </section>
      {skipped ? (
        <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
          Skipped on the selected durable live first cut. No visual checks,
          composite decision, fix list, or automated retry ran for this cut.
        </p>
      ) : gateSnapshot && compositeIteration ? (
        <section>
          <SectionTitle>Recomputed pre-retry score</SectionTitle>
          <ScoreMeter
            score={gateSnapshot.score}
            verdict={gatePassed ? "pass" : "fail"}
          />
          <p className="mt-1 text-2xs text-faint">
            Attempt {compositeIteration.index} · needs {config.compositePassThreshold} to pass
          </p>
        </section>
      ) : null}
      {!skipped ? (
        <section>
          <SectionTitle>Must-pass checks in that attempt</SectionTitle>
          <div className="divide-y divide-edge">
            {generationHardGates.map((definition) => {
              const result = compositeIteration?.evalResults.find(
                (item) => item.evalId === definition.id
              );
              return (
                <div
                  key={definition.id}
                  className="flex min-h-10 items-center justify-between gap-2"
                >
                  <span className="text-xs text-muted">{definition.name}</span>
                  {result ? (
                    <VerdictBadge verdict={result.verdict} />
                  ) : (
                    <span className="text-2xs text-faint">not recorded</span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      <section>
        <SectionTitle>Separate downstream audio gate</SectionTitle>
        <p className="mb-2 text-pretty text-2xs leading-relaxed text-faint">
          Audio Integrity runs after the winning video is chosen and original
          audio is remuxed. It is not part of this pre-retry checklist.
        </p>
        <div className="flex min-h-10 items-center justify-between gap-2 border-y border-edge">
          <span className="text-xs text-muted">Original audio untouched</span>
          {audioResult ? (
            <VerdictBadge verdict={audioResult.verdict} />
          ) : audioStatus === "succeeded" ? (
            <VerdictBadge verdict="pass" />
          ) : audioStatus === "failed" ? (
            <VerdictBadge verdict="fail" />
          ) : (
            <span className="text-2xs text-faint">
              {audioStatus === "skipped" ? "skipped" : run ? "not recorded" : "no run"}
            </span>
          )}
        </div>
      </section>
    </>
  );
}

function AnchorGateSection({ run, mode }: { run?: Run; mode: Mode }) {
  const current = run?.iterations[run.iterations.length - 1];
  const keyframe = current?.relitKeyframeDataUrl;
  const status = run?.nodeStates["anchor-gate"]?.status;

  return (
    <section>
      <SectionTitle>Look approval checkpoint</SectionTitle>
      <p className="text-pretty text-xs leading-relaxed text-muted">
        This is intended to approve identity, clothing, room, skin, and lighting
        at the cheap still-image tier before video generation.
      </p>
      <p className="mt-2 rounded-lg bg-raised px-3 py-2 text-pretty text-2xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
        {status === "skipped"
          ? "Selected-run status: skipped. The durable live first-cut path currently omits both the Look Anchor and this gate."
          : mode === "live" && status === "succeeded"
            ? "Selected-run status: marked approved by the full-loop path. The still-tier judge is not implemented, so this is not evidence of an automated visual approval."
            : mode === "mock" && run
              ? "Selected demo status: approval is simulated as part of the scripted workflow."
              : "Definition only: this is the intended full-loop checkpoint; no run-bound decision is selected."}
      </p>
      {keyframe ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={keyframe}
          alt="Relit anchor keyframe for the current attempt"
          className="mt-3 w-40 rounded-lg object-cover outline outline-1 -outline-offset-1 outline-white/10"
        />
      ) : null}
    </section>
  );
}

export function NodeInspector({
  node,
  run,
  config,
  mode,
  workflowMode,
  onSelectNode,
  onClose,
}: {
  node: PipelineNode;
  run?: Run;
  config: RunConfig;
  mode: Mode;
  workflowMode: WorkflowMode;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
}) {
  const state = run?.nodeStates[node.id];
  const promptRole = promptRoleForNode(node);
  const runMode: Mode = run ? (run.live ? "live" : "mock") : mode;
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [node.id, onClose]);

  return (
    <aside
      data-testid="node-inspector"
      aria-labelledby="node-inspector-title"
      className="absolute inset-y-0 right-0 z-30 flex w-full flex-col overflow-y-auto bg-surface sm:static sm:z-auto sm:w-[440px] sm:max-w-[48vw]"
      style={{
        boxShadow:
          "-1px 0 0 rgba(255, 255, 255, 0.08), -18px 0 42px rgba(0, 0, 0, 0.2)",
      }}
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 bg-surface/95 px-4 py-3 backdrop-blur-md shadow-[0_1px_0_rgba(255,255,255,0.08)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={promptRole?.color ?? kindColor(node.kind)}>
              {promptRole?.label ?? node.kind}
            </Badge>
            {state ? (
              <span className="flex items-center gap-1.5 text-2xs text-faint">
                <StatusDot status={state.status} />
                {state.status}
              </span>
            ) : null}
            <span className="font-[family-name:var(--font-geist-mono)] text-[10px] text-faint">
              {node.id}
            </span>
          </div>
          <h2
            id="node-inspector-title"
            className="mt-2 text-balance text-base font-semibold text-ink"
          >
            {node.label}
          </h2>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-lg text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.09)] transition-[color,background-color,scale] duration-150 ease-out hover:bg-raised hover:text-ink active:scale-[0.96]"
        >
          ×
        </button>
      </div>

      <div className="flex flex-col gap-5 px-4 py-4">
        <div>
          <p className="text-pretty text-xs leading-relaxed text-muted">
            {node.description}
          </p>
          {promptRole ? (
            <p className="mt-1 text-pretty text-2xs leading-relaxed text-faint">
              {promptRole.description}
            </p>
          ) : null}
          {state?.detail ? (
            <p className="mt-1 text-2xs text-faint">{state.detail}</p>
          ) : null}
        </div>

        {node.kind === "evaluate" && node.evalId ? (
          <EvalSection
            key={`${run?.id ?? "baseline"}:${node.evalId}`}
            evalId={node.evalId}
            nodeId={node.id}
            run={run}
            mode={runMode}
            workflowMode={workflowMode}
          />
        ) : null}
        {node.id === "manifest" ? <ManifestSection run={run} mode={runMode} /> : null}
        {node.id === "compile" ? (
          <MegaPromptSection run={run} mode={runMode} onSelectNode={onSelectNode} />
        ) : null}
        {node.kind === "generate" ? (
          <GenerateSection
            node={node}
            run={run}
            mode={runMode}
            onSelectNode={onSelectNode}
          />
        ) : null}
        {node.kind === "aggregate" ? (
          <AggregateSection run={run} onSelectNode={onSelectNode} />
        ) : null}
        {node.kind === "gate" && node.id === "gate" ? (
          <GateSection run={run} config={config} workflowMode={workflowMode} />
        ) : null}
        {node.kind === "gate" && node.id === "anchor-gate" ? (
          <AnchorGateSection run={run} mode={runMode} />
        ) : null}
      </div>
    </aside>
  );
}
