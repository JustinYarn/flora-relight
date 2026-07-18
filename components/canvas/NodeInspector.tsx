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
  evalDefsForRun,
  isLampRun,
} from "@/lib/lamp-evaluation";
import { LAMP_BACKGROUND_UI_EVAL_DEFS } from "@/lib/lamp-background-read";
import { LAMP_BEAUTIFY_UI_EVAL_DEFS } from "@/lib/lamp-beautify-read";
import { LAMP_IRIS_UI_EVAL_DEFS } from "@/lib/lamp-iris-read";
import {
  lampCombinedDefinitionPrompt,
  lampCombinedUiEvalDefs,
} from "@/lib/lamp-combined-read";
import {
  LAMP_COMBINED_CLEANLINESS_PROFILES,
  lampCombinedCandidateIneligibility,
} from "@/lib/lamp-combined";
import type { LampCombinedCandidateQualificationReceipt } from "@/lib/lamp-combined-candidate";
import {
  lampCombinedCandidateReceiptEligible,
  lampCombinedCandidateReceiptToDeliveryCandidate,
} from "@/lib/lamp-combined-candidate-read";
import {
  lampBackgroundDisplayPrompt,
  sampleApprovedLampBackgroundPlan,
} from "@/lib/lamp-background-display";
import {
  LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT,
  type LampBackgroundCleanupPlan,
} from "@/lib/lamp-background";
import { renderLampBackgroundHolisticEvaluatorPrompt } from "@/lib/lamp-background-evaluation";
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
import {
  isVersionAPlanMode,
  planModeDisplayPrompt,
} from "@/lib/plan-mode-display";
import { runWorkflowMode, workflowModeLabel } from "@/lib/workflow-mode";

type Mode = "mock" | "live";
type Iteration = Run["iterations"][number];

function attemptLabel(workflowMode: WorkflowMode, iteration: number): string {
  if (workflowMode === "combined") return `Take ${iteration}`;
  if (workflowMode === "flora") return `Attempt ${iteration}`;
  if (iteration === 1) return "Initial";
  if (iteration === 2) return "Final";
  return `v${iteration}`;
}

function severityColor(severity: ViolationSeverity): string {
  return severity === "critical"
    ? "var(--fail)"
    : severity === "major"
      ? "var(--borderline)"
      : "var(--faint)";
}

function evalName(id: string): string {
  return (
    LAMP_BACKGROUND_UI_EVAL_DEFS.find((definition) => definition.id === id)
      ?.name ??
    LAMP_BEAUTIFY_UI_EVAL_DEFS.find((definition) => definition.id === id)
      ?.name ??
    LAMP_IRIS_UI_EVAL_DEFS.find((definition) => definition.id === id)?.name ??
    lampCombinedUiEvalDefs().find((definition) => definition.id === id)?.name ??
    LAMP_EVAL_DEFS.find((definition) => definition.id === id)?.name ??
    EVAL_DEFS.find((definition) => definition.id === id)?.name ??
    id
  );
}

function evalDefinitionsForMode(workflowMode: WorkflowMode) {
  if (workflowMode === "lamp") return LAMP_EVAL_DEFS;
  if (workflowMode === "background") return LAMP_BACKGROUND_UI_EVAL_DEFS;
  if (workflowMode === "beautify") return LAMP_BEAUTIFY_UI_EVAL_DEFS;
  if (workflowMode === "iris") return LAMP_IRIS_UI_EVAL_DEFS;
  if (workflowMode === "combined") return lampCombinedUiEvalDefs();
  return EVAL_DEFS;
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
  workflowMode,
  onSelect,
}: {
  attempts: Array<{ iteration: Iteration; result: EvalResult }>;
  selectedIteration: number;
  workflowMode: WorkflowMode;
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
        <span className="text-2xs text-faint">
          {workflowMode === "combined"
            ? "Select a take to trace it"
            : workflowMode === "flora"
              ? "Select an attempt to trace it"
              : "Select Initial or Final to trace it"}
        </span>
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
                {attemptLabel(workflowMode, iteration.index)}
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

function runPromptSource(
  iteration: number,
  workflowMode: WorkflowMode
): string {
  const label = attemptLabel(workflowMode, iteration);
  return `run.iterations · ${label} · megaPrompt.rendered`;
}

function codeCheckSpecificationNote(
  evalId: string,
  workflowMode: WorkflowMode
): string {
  if (evalId === "audio-integrity") {
    if (isVersionAPlanMode(workflowMode) || workflowMode === "combined") {
      return `No model prompt. ${workflowModeLabel(workflowMode)} verifies source-audio restoration and complete timeline agreement deterministically after generation; Audio Integrity is not included in the visual evaluator call.`;
    }
    return "No model prompt. Lamp verifies audio presence, complete source/generated/remuxed timeline agreement, and the restored source-audio fingerprint. Any mismatch fails closed before visual evaluation.";
  }
  if (evalId === "temporal-alignment") {
    return "No model prompt. This planned local correlation check is not implemented in Lamp, so it remains explicitly unavailable rather than receiving a manufactured score.";
  }
  return "No model prompt. This describes the code-check specification; the selected run status and result show whether that procedure actually executed.";
}

function promptViewFor(
  run: Run | undefined,
  iteration: Iteration | undefined,
  selectedWorkflowMode: WorkflowMode
): {
  prompt: MegaPrompt;
  attempt: number;
  runBound: boolean;
  consumed: boolean;
  source: string;
} {
  const workflowMode =
    (run ? runWorkflowMode(run) : undefined) ?? selectedWorkflowMode;
  const planModeView = isVersionAPlanMode(workflowMode)
    ? planModeDisplayPrompt(workflowMode, run, iteration)
    : undefined;
  const definitionPrompt =
    workflowMode === "combined"
      ? lampCombinedDefinitionPrompt(run?.relightIntensity)
      : planModeView
        ? planModeView.prompt
        : initialMegaPrompt(workflowMode);
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
      : {
          ...definitionPrompt,
          corrections: [...definitionPrompt.corrections],
        };
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
      source: runPromptSource(iteration.index, workflowMode),
    };
  }
  const prompt = {
    ...definitionPrompt,
    corrections: [...definitionPrompt.corrections],
  };
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
    runBound: planModeView?.runBound ?? false,
    consumed: false,
    source:
      planModeView?.source ??
      "lib/prompts/mega-prompt.ts",
  };
}

function generationBriefNote(
  mode: Mode,
  runBound: boolean,
  consumed: boolean,
  workflowMode: WorkflowMode
): string {
  if (!runBound) {
    if (workflowMode === "combined") {
      return "Definition-only Combined overview. Exact provider bytes exist only after one source-specific aggregate plan is approved and frozen.";
    }
    if (isVersionAPlanMode(workflowMode)) {
      return `Definition-only ${workflowModeLabel(workflowMode)} brief compiled from a clearly labeled synthetic approved plan. It is not attached to a real video.`;
    }
    return "This is the current baseline render before a run adds any eval-driven fixes. It is an example, not a historical request.";
  }
  if (!consumed) {
    if (workflowMode === "combined") {
      return "These exact Lamp Combined prompt bytes are bound to the selected run and approved aggregate plan. Provider consumption is not confirmed yet.";
    }
    if (isVersionAPlanMode(workflowMode)) {
      return `These exact ${workflowModeLabel(workflowMode)} prompt bytes are bound to the selected run or its approved plan. Provider consumption is not confirmed yet.`;
    }
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
  const effectiveMode = run ? runWorkflowMode(run) : workflowMode;
  const lamp = effectiveMode === "lamp";
  const planMode =
    isVersionAPlanMode(effectiveMode) || effectiveMode === "combined";
  const definitions = run
    ? evalDefsForRun(run)
    : evalDefinitionsForMode(effectiveMode);
  const definition =
    definitions.find((item) => item.id === evalId) ?? getEvalDef(evalId);
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
  const promptView = promptViewFor(run, focusIteration, workflowMode);
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
  const focusAttempt = focusResult?.iteration ?? promptView.attempt;
  const focusVideoLabel = attemptLabel(effectiveMode, focusAttempt);
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
            : `${attemptLabel(effectiveMode, focusResult.iteration)} result · no later brief compiled`
          : transitionParts.length > 0
            ? `${transitionParts.join(" · ")} in brief v${nextIteration.megaPrompt.version}`
            : focusResult.verdict === "pass"
              ? `Passed · no prompt change in brief v${nextIteration.megaPrompt.version}`
              : `No actionable correction recorded · no prompt change in brief v${nextIteration.megaPrompt.version}`;

  const decisionValue: ReactNode = focusResult ? (
    <span className="inline-flex items-center gap-2">
      {attemptLabel(effectiveMode, focusResult.iteration)} ·{" "}
      {Math.round(focusResult.score)}
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
              workflowMode={effectiveMode}
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
                  ? `Generation brief v${brief.version} · ${attemptLabel(effectiveMode, promptView.attempt)}`
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
              ? `Generation brief v${brief.version} for ${attemptLabel(effectiveMode, promptView.attempt)}`
              : `Baseline generation brief v${brief.version}`
        }
        text={brief.rendered}
        note={
          isAudio
            ? "Shown only as delivery context. Audio Integrity reads the remuxed and ingest audio digests; it does not receive or interpret this generation prompt."
            : generationBriefNote(
                mode,
                promptView.runBound,
                promptView.consumed,
                workflowMode
              )
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
            ? planMode
              ? `This is today's code-owned ${workflowModeLabel(effectiveMode)} rubric. Its visual rubrics are composed into one approved-plan-bound Gemini request over the complete source and candidate videos. Historical rubric text is not archived per run.`
              : lamp
              ? "This is today's code-owned Lamp rubric. Lamp sends all eight visual rubrics in one Gemini request over the complete source and candidate videos. Historical rubric text is not archived per run."
              : "This is today's code-owned Flora rubric. Historical rubric text is not archived per run."
            : codeCheckSpecificationNote(evalId, workflowMode)
        }
        source={
          effectiveMode === "background"
            ? "lib/lamp-background-evaluation.ts"
            : effectiveMode === "beautify"
              ? "lib/lamp-beautify-evaluation.ts"
              : effectiveMode === "iris"
                ? "lib/lamp-iris-evaluation.ts"
                : effectiveMode === "combined"
                  ? "lib/lamp-combined-evaluation.ts"
            : lamp && evalId === "skin-texture-age"
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
            Audio Integrity was skipped because no verified{" "}
            {effectiveMode === "combined"
              ? "take"
              : effectiveMode === "flora"
                ? "attempt"
                : "Final delivery"}{" "}
            was available. No mega-prompt change was produced.
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
            video to see one set of findings feed the next generation brief.
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

function backgroundPlanContext(run?: Run): {
  visiblePlan: LampBackgroundCleanupPlan;
  promptPlan: LampBackgroundCleanupPlan;
  visiblePlanIsSample: boolean;
  promptIsSample: boolean;
} {
  const backgroundRun = run?.workflowMode === "background" ? run : undefined;
  const promptView = lampBackgroundDisplayPrompt(backgroundRun);
  return {
    visiblePlan:
      backgroundRun?.backgroundCleanupPlan ??
      sampleApprovedLampBackgroundPlan(),
    promptPlan: promptView.promptPlan,
    visiblePlanIsSample: backgroundRun?.backgroundCleanupPlan === undefined,
    promptIsSample: promptView.sample,
  };
}

function BackgroundPlanSection({ run }: { run?: Run }) {
  const context = backgroundPlanContext(run);
  const plan = context.visiblePlan;
  return (
    <>
      <section>
        <SectionTitle>Planning contract</SectionTitle>
        <PromptTrace
          items={[
            {
              label: "Input",
              value: "The complete source timeline",
              color: "var(--faint)",
            },
            {
              label: "Planning prompt",
              value: "Classify remove, preserve, uncertain, or a rare exceptional no-op",
              color: "var(--running)",
            },
            {
              label: "Output",
              value: "A validated source-specific draft plan",
              color: "var(--borderline)",
            },
            {
              label: "Human gate",
              value: "Generation remains blocked until this exact plan is approved",
              color: "var(--accent)",
            },
          ]}
        />
      </section>

      <section>
        <SectionTitle
          right={
            <Badge
              color={
                context.visiblePlanIsSample
                  ? "var(--muted)"
                  : plan.approval.status === "approved"
                    ? "var(--pass)"
                    : "var(--borderline)"
              }
            >
              {context.visiblePlanIsSample
                ? "definition sample"
                : plan.approval.status}
            </Badge>
          }
        >
          Plan in view
        </SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Fact label="Decision" value={plan.decision} />
          <Fact
            label="Scope"
            value={`${plan.sourceScope.cameraMotion} · ${plan.sourceScope.visiblePeople}`}
          />
          <Fact label="Remove" value={plan.remove.length} />
          <Fact
            label="Protected"
            value={plan.preserve.length + plan.uncertain.length}
          />
        </div>
        <p className="mt-2 text-pretty text-xs leading-relaxed text-muted">
          {plan.sceneSummary}
        </p>
        {plan.approval.status === "draft" ? (
          <p className="mt-2 rounded-lg bg-raised px-3 py-2.5 text-pretty text-2xs leading-relaxed text-borderline shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            This is the selected run&apos;s real draft. It is visible for review but
            is not yet legal generation input.
          </p>
        ) : null}
      </section>

      <PromptDisclosure
        eyebrow="CURRENT PLANNING PROMPT"
        title="Whole-video cleanup-plan analyzer"
        text={LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT}
        note="This model call may propose classifications only. Validation and explicit human approval remain separate gates."
        source="lib/lamp-background.ts · LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT"
        testId="background-plan-prompt-disclosure"
      />

      <PromptDisclosure
        eyebrow={
          context.visiblePlanIsSample
            ? "DEFINITION SAMPLE"
            : plan.approval.status === "approved"
              ? "RUN-APPROVED PLAN"
              : "RUN DRAFT PLAN"
        }
        title="Remove / preserve / uncertain contract"
        text={JSON.stringify(plan, null, 2)}
        note={
          context.visiblePlanIsSample
            ? "Clearly synthetic approved plan used only to make definition-only prompt views concrete."
            : plan.approval.status === "approved"
              ? "This exact source-specific plan is the edit authorization bound into generation and evaluation."
              : "This source-specific proposal is not bound into generation until the user approves it."
        }
        source={
          context.visiblePlanIsSample
            ? "lib/lamp-background-display.ts · sampleApprovedLampBackgroundPlan"
            : "run.backgroundCleanupPlan"
        }
        testId="background-plan-json-disclosure"
      />
    </>
  );
}

function BackgroundCritiqueSection({
  run,
  onSelectNode,
}: {
  run?: Run;
  onSelectNode: (nodeId: string) => void;
}) {
  const context = backgroundPlanContext(run);
  const promptPlan = context.promptPlan;
  const exceptionalNoOp =
    !context.promptIsSample &&
    promptPlan.decision === "exceptional-no-op";
  return (
    <>
      <section>
        <SectionTitle>Whole-video evaluation handoff</SectionTitle>
        <PromptTrace
          items={[
            {
              label: "Inputs",
              value: "Complete source + complete candidate at the same timeline",
              color: "var(--faint)",
            },
            {
              label: "Authorization",
              value: context.promptIsSample
                ? "Clearly labeled sample approved cleanup plan"
                : "Selected run's approved cleanup plan",
              color: "var(--accent)",
            },
            {
              label: "One model call",
              value: exceptionalNoOp
                ? "Skipped · the exact source was delivered without a generated candidate"
                : "Nine independent visual checks with closed correction actions",
              color: "var(--running)",
            },
            {
              label: "Code append",
              value: exceptionalNoOp
                ? "No generated delivery needed a new evaluation"
                : "Deterministic Audio Integrity becomes the tenth result",
              color: "var(--pass)",
            },
          ]}
        />
      </section>

      <PromptDisclosure
        eyebrow={
          exceptionalNoOp
            ? "DEFINITION · NOT RUN FOR SELECTED NO-OP"
            : context.promptIsSample
            ? "DEFINITION-ONLY EVALUATOR"
            : "APPROVED-PLAN-BOUND EVALUATOR"
        }
        title="Holistic Lamp Background evaluation prompt"
        text={renderLampBackgroundHolisticEvaluatorPrompt(promptPlan)}
        note={
          exceptionalNoOp
            ? "The evaluator definition is shown for inspection, but the selected exceptional no-op produced no candidate and did not run this AI evaluation."
            : context.promptIsSample
            ? "This exact evaluator shape uses the definition sample because no approved run plan is available."
            : "This evaluator prompt is rendered against the selected run's approved cleanup plan."
        }
        source="lib/lamp-background-evaluation.ts · renderLampBackgroundHolisticEvaluatorPrompt"
        testId="background-evaluator-prompt-disclosure"
      />

      <section>
        <SectionTitle
          right={
            <Badge>
              {LAMP_BACKGROUND_UI_EVAL_DEFS.length} active definitions
            </Badge>
          }
        >
          Checks composed here
        </SectionTitle>
        <div className="space-y-2">
          {LAMP_BACKGROUND_UI_EVAL_DEFS.map((definition, index) => (
            <details
              key={definition.id}
              className="group rounded-lg bg-raised shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
            >
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
                <span className="w-5 text-right font-[family-name:var(--font-geist-mono)] text-2xs tabular-nums text-faint">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-ink">
                    {definition.name}
                  </span>
                  <span className="block font-[family-name:var(--font-geist-mono)] text-[10px] text-faint">
                    {definition.id}
                  </span>
                </span>
                <Badge
                  color={
                    definition.method === "deterministic"
                      ? "var(--muted)"
                      : "var(--running)"
                  }
                >
                  {definition.method === "deterministic"
                    ? "code"
                    : "visual rubric"}
                </Badge>
                <span
                  className="text-base text-faint transition-transform group-open:rotate-90"
                  aria-hidden="true"
                >
                  ›
                </span>
              </summary>
              <div className="border-t border-edge p-3">
                <p className="text-pretty text-xs leading-relaxed text-muted">
                  {definition.description}
                </p>
                <p className="mt-2 text-2xs tabular-nums text-faint">
                  pass ≥ {definition.passThreshold} · borderline ≥{" "}
                  {definition.borderlineThreshold} · weight{" "}
                  {definition.weight.toFixed(2)}
                </p>
                <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-canvas p-2.5 font-[family-name:var(--font-geist-mono)] text-2xs leading-relaxed text-muted">
                  {definition.promptTemplate ||
                    definition.deterministicNote ||
                    "No definition text is available."}
                </pre>
              </div>
            </details>
          ))}
        </div>
      </section>

      <button
        type="button"
        onClick={() => onSelectNode("final")}
        className="inline-flex min-h-10 items-center text-xs text-faint transition-colors duration-150 hover:text-ink"
      >
        Inspect the Final prompt created from structured findings →
      </button>
    </>
  );
}

function MegaPromptSection({
  run,
  mode,
  workflowMode,
  onSelectNode,
}: {
  run?: Run;
  mode: Mode;
  workflowMode: WorkflowMode;
  onSelectNode: (nodeId: string) => void;
}) {
  const iteration = run?.iterations[run.iterations.length - 1];
  const promptView = promptViewFor(run, iteration, workflowMode);
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
        note={generationBriefNote(
          mode,
          promptView.runBound,
          promptView.consumed,
          workflowMode
        )}
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
  workflowMode,
  onSelectNode,
}: {
  node: PipelineNode;
  run?: Run;
  mode: Mode;
  workflowMode: WorkflowMode;
  onSelectNode: (nodeId: string) => void;
}) {
  const planMode =
    isVersionAPlanMode(workflowMode) || workflowMode === "combined";
  const requestedPlanAttempt =
    node.id === "initial" ? 1 : node.id === "final" ? 2 : undefined;
  const iteration =
    planMode && requestedPlanAttempt
      ? run?.iterations.find(
          (candidate) => candidate.index === requestedPlanAttempt
        )
      : run?.iterations[run.iterations.length - 1];
  const promptView = promptViewFor(run, iteration, workflowMode);
  const megaPrompt = promptView.prompt;
  const exceptionalNoOp =
    workflowMode === "background"
      ? run?.backgroundCleanupPlan?.approval.status === "approved" &&
        run.backgroundCleanupPlan.decision === "exceptional-no-op"
      : workflowMode === "beautify"
        ? run?.beautifyPlan?.approval.status === "approved" &&
          run.beautifyPlan.decision === "exceptional-no-op"
        : workflowMode === "iris"
          ? run?.irisPlan?.approval.status === "approved" &&
            run.irisPlan.decision === "exceptional-no-op"
          : false;
  const videoLabel =
    exceptionalNoOp
      ? "Exceptional no-op"
      : attemptLabel(
          workflowMode,
          requestedPlanAttempt ?? promptView.attempt
        );
  const requestedPromptMissing =
    planMode &&
    Boolean(run) &&
    node.id === "final" &&
    iteration === undefined;
  const outputKind =
    workflowMode === "background"
      ? "background-cleanup"
      : workflowMode === "beautify"
        ? "touch-up"
      : workflowMode === "iris"
          ? "eye-contact"
          : workflowMode === "combined"
            ? "combined"
          : "relit";

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
              value: `${planMode ? `Approved-plan ${workflowModeLabel(workflowMode)} prompt` : "Mega prompt"} v${megaPrompt.version}`,
              color: "var(--accent)",
            },
            {
              label: "Correction context",
              value:
                exceptionalNoOp
                  ? "None · the approved plan bypasses generation"
                  : videoLabel === "Take 1"
                    ? "None · this is the first source-rooted take"
                  : workflowMode === "flora" && promptView.attempt === 1
                    ? "None · this is the first historical attempt"
                  : workflowMode === "flora"
                    ? `Every actionable finding from ${attemptLabel(workflowMode, Math.max(1, promptView.attempt - 1))}`
                  : videoLabel === "Initial"
                  ? "None · this is the Initial generation"
                  : requestedPromptMissing
                    ? workflowMode === "combined"
                      ? "Waiting · the Take 1 evaluation has not compiled Take 2 yet"
                      : "Waiting · the Initial critique has not compiled Final yet"
                    : workflowMode === "combined"
                      ? "The bounded, severity-ordered findings from Take 1"
                      : "Every actionable finding from the Initial critique",
              color: "var(--running)",
            },
            {
              label: "Output",
              value: exceptionalNoOp
                ? "Exact source delivery · generation skipped"
                : `${videoLabel} ${outputKind} video`,
              color: "var(--pass)",
            },
          ]}
        />
      </section>
      <PromptDisclosure
        eyebrow={promptView.runBound ? "RUN-BOUND GENERATION PROMPT" : "CURRENT BASELINE"}
        title={
          exceptionalNoOp
            ? "Approved exact-source delivery instruction"
            : requestedPromptMissing
            ? `Latest available ${workflowModeLabel(workflowMode)} brief · ${workflowMode === "combined" ? "Take 2" : "Final"} not compiled yet`
            : promptView.runBound
            ? `${promptView.consumed ? "Prompt consumed" : "Prompt bound"} for ${videoLabel}`
            : `Mega prompt for ${attemptLabel(workflowMode, promptView.attempt)}`
        }
        text={megaPrompt.rendered}
        note={generationBriefNote(
          mode,
          promptView.runBound,
          promptView.consumed,
          workflowMode
        )}
        source={promptView.source}
        testId="video-generation-prompt-disclosure"
      />
      {exceptionalNoOp ? (
        <p className="text-pretty text-2xs leading-relaxed text-borderline">
          The selected plan is the rare strict no-op. This node was bypassed:
          no candidate video or AI evaluation was created.
        </p>
      ) : null}
      {requestedPromptMissing ? (
        <p className="text-pretty text-2xs leading-relaxed text-borderline">
          The selected run has no saved {workflowMode === "combined" ? "Take 2" : "Final"} prompt yet. The disclosure above
          shows the latest available approved-plan-bound brief as
          context and does not claim the second prompt was compiled or consumed.
        </p>
      ) : null}
      {planMode ? (
        <button
          type="button"
          onClick={() => onSelectNode("plan")}
          className="inline-flex min-h-10 items-center text-xs text-faint transition-colors duration-150 hover:text-ink"
        >
          Inspect the approved plan →
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onSelectNode("compile")}
          className="inline-flex min-h-10 items-center text-xs text-faint transition-colors duration-150 hover:text-ink"
        >
          Open the mega-prompt compiler →
        </button>
      )}
    </>
  );
}

function combinedCandidateReceipt(
  run: Run | undefined,
  iteration: 1 | 2
): LampCombinedCandidateQualificationReceipt | undefined {
  return iteration === 1
    ? run?.serverExecution?.combinedCandidateReceipts?.initial
    : run?.serverExecution?.combinedCandidateReceipts?.final;
}

function combinedIneligibilityLabel(
  receipt: LampCombinedCandidateQualificationReceipt
): string | null {
  const reason = lampCombinedCandidateIneligibility(
    lampCombinedCandidateReceiptToDeliveryCandidate(receipt)
  );
  if (reason === "generation-incomplete") return "generation incomplete";
  if (reason === "audio-unverified") return "audio unverified";
  if (reason === "sync-failed") return "sync failed";
  if (reason === "sync-unverified") return "sync unverified";
  if (reason === "evaluation-incomplete") return "evaluation incomplete";
  return null;
}

function combinedAudioLabel(
  receipt: LampCombinedCandidateQualificationReceipt
): string {
  if (receipt.audio.outcome === "verified") return "source audio verified";
  if (receipt.audio.outcome === "silent_source") return "silent source";
  return "source audio unverified";
}

function combinedSyncLabel(
  receipt: LampCombinedCandidateQualificationReceipt
): string {
  const sync = receipt.repair?.sync ?? receipt.sync;
  if (sync.outcome === "passed") {
    return receipt.repair ? "passed after one repair" : "passed";
  }
  if (sync.outcome === "not_required") return "not required · silent source";
  if (sync.outcome === "failed") return "failed";
  return "not run · audio unverified";
}

interface CombinedQualificationSnapshot {
  label: string;
  detail: string;
  color: string;
  eligible: boolean;
  receipt?: LampCombinedCandidateQualificationReceipt;
}

function combinedQualificationSnapshot(
  run: Run | undefined,
  mode: Mode,
  iteration: 1 | 2
): CombinedQualificationSnapshot {
  const receipt = combinedCandidateReceipt(run, iteration);
  if (receipt) {
    const eligible = lampCombinedCandidateReceiptEligible(receipt);
    const reason = combinedIneligibilityLabel(receipt);
    return {
      label: eligible ? "Eligible" : "Not eligible",
      detail: eligible
        ? "Eligible from the saved qualification receipt."
        : `The saved receipt fails closed: ${reason ?? "qualification incomplete"}.`,
      color: eligible ? "var(--pass)" : "var(--fail)",
      eligible,
      receipt,
    };
  }

  if (!run) {
    return {
      label: "Definition only",
      detail: "Select a Combined run to inspect its recorded candidate evidence.",
      color: "var(--faint)",
      eligible: false,
    };
  }

  if (mode === "mock") {
    return {
      label: "Preview only",
      detail:
        "This demo candidate has no provider, audio, sync, or evaluation qualification receipt.",
      color: "var(--accent)",
      eligible: false,
    };
  }

  const generated = run.iterations.some(
    (candidate) =>
      candidate.index === iteration && Boolean(candidate.generatedVideo)
  );
  return {
    label: generated ? "Qualification pending" : "Not generated yet",
    detail: generated
      ? "A candidate is visible in run state, but its qualification receipt is not recorded, so it is not yet selectable as a winner."
      : "Qualification starts only after this take is generated and evaluated.",
    color: generated ? "var(--borderline)" : "var(--faint)",
    eligible: false,
  };
}

function CombinedPlanSection({ run }: { run?: Run }) {
  const plan = run?.combinedPlan;
  if (!run) {
    return (
      <section>
        <SectionTitle>Aggregate plan evidence</SectionTitle>
        <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
          Definition only. A selected run adds one source-specific aggregate
          plan, its human approval state, enabled subplans, and saved planner
          journal references.
        </p>
      </section>
    );
  }
  if (!plan) {
    return (
      <section>
        <SectionTitle>Aggregate plan evidence</SectionTitle>
        <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
          This run does not have a saved Combined plan yet. No generation scope
          or human approval is claimed here.
        </p>
      </section>
    );
  }

  const cleanliness =
    LAMP_COMBINED_CLEANLINESS_PROFILES[plan.controls.cleanlinessLevel];
  const plannerReferences =
    run.serverExecution?.combinedPlanOperationIds?.length ?? 0;
  const approval = plan.approval.status === "approved";

  return (
    <>
      <section>
        <SectionTitle
          right={
            <Badge color={approval ? "var(--pass)" : "var(--borderline)"}>
              {approval ? "human approved" : "draft"}
            </Badge>
          }
        >
          Saved aggregate scope
        </SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Fact
            label="Relight"
            value={
              typeof run.relightIntensity === "number"
                ? `${run.relightIntensity}/100`
                : "not bound on this run"
            }
          />
          <Fact
            label="Background"
            value={`${cleanliness.label} · ${plan.backgroundPlan.remove.length} remove · ${plan.backgroundPlan.preserve.length} preserve · ${plan.backgroundPlan.uncertain.length} uncertain`}
          />
          <Fact
            label="Beautify"
            value={
              plan.beautify.state === "enabled"
                ? `level ${plan.controls.beautifyLevel} · ${plan.beautify.plan.enhance.length} approved`
                : "off · no beautify scope"
            }
          />
          <Fact
            label="Eye contact"
            value={
              plan.iris.state === "enabled"
                ? `Presenter 2 · ${plan.iris.plan.correct.length} approved`
                : "off · no Iris scope"
            }
          />
          <div className="col-span-2">
            <Fact
              label="Planner journals"
              value={`${plannerReferences} saved reference${plannerReferences === 1 ? "" : "s"}`}
            />
          </div>
        </div>
      </section>
      <p className="text-pretty text-2xs leading-relaxed text-faint">
        Saved references show what this run retained; this panel does not replay
        planner calls or infer missing journal evidence. Cleanliness changes
        execution thoroughness inside the approved removal targets, not the target set.
      </p>
    </>
  );
}

function CombinedCandidateQualificationSection({
  run,
  mode,
  iteration,
}: {
  run?: Run;
  mode: Mode;
  iteration: 1 | 2;
}) {
  const snapshot = combinedQualificationSnapshot(run, mode, iteration);
  const receipt = snapshot.receipt;
  return (
    <section>
      <SectionTitle right={<Badge color={snapshot.color}>{snapshot.label}</Badge>}>
        {attemptLabel("combined", iteration)} qualification
      </SectionTitle>
      <p className="mb-3 text-pretty text-xs leading-relaxed text-muted">
        {snapshot.detail}
      </p>
      {receipt ? (
        <div className="grid grid-cols-2 gap-2">
          <Fact
            label="Generation journal"
            value={
              <span className="break-all font-[family-name:var(--font-geist-mono)] text-2xs">
                {receipt.generation.operationId}
              </span>
            }
          />
          <Fact
            label="Evaluation journal"
            value={
              <span className="break-all font-[family-name:var(--font-geist-mono)] text-2xs">
                {receipt.evaluation.operationId}
              </span>
            }
          />
          <Fact label="Source audio" value={combinedAudioLabel(receipt)} />
          <Fact label="Effective sync" value={combinedSyncLabel(receipt)} />
          <div className="col-span-2">
            <Fact
              label="Receipt recorded"
              value={new Date(receipt.recordedAt).toISOString()}
            />
          </div>
        </div>
      ) : null}
      {receipt ? (
        <p className="mt-2 text-pretty text-2xs leading-relaxed text-faint">
          Eligibility is computed from this saved immutable receipt. The
          inspector does not independently replay either provider interaction.
        </p>
      ) : null}
    </section>
  );
}

function CombinedCritiqueSection({
  run,
  onSelectNode,
}: {
  run?: Run;
  onSelectNode: (nodeId: string) => void;
}) {
  const visualDefinitions = (run ? evalDefsForRun(run) : lampCombinedUiEvalDefs()).filter(
    (definition) => definition.method !== "deterministic"
  );
  const visualIds = new Set(visualDefinitions.map((definition) => definition.id));
  const take1 = run?.iterations.find((iteration) => iteration.index === 1);
  const take2 = run?.iterations.find((iteration) => iteration.index === 2);
  const visualResults =
    take1?.evalResults.filter((result) => visualIds.has(result.evalId)) ?? [];
  const corrections =
    take2?.megaPrompt.corrections.filter((correction) => !correction.resolved) ?? [];
  const evaluationReceipt = combinedCandidateReceipt(run, 1)?.evaluation;

  return (
    <>
      <section>
        <SectionTitle>Saved critique handoff</SectionTitle>
        <PromptTrace
          items={[
            {
              label: "Take 1 results",
              value: run
                ? `${visualResults.length}/${visualDefinitions.length} visual result records in run state`
                : `${visualDefinitions.length} current visual definitions · no run selected`,
              color: visualResults.length > 0 ? "var(--running)" : "var(--faint)",
            },
            {
              label: "Evaluation journal",
              value: evaluationReceipt
                ? `Saved reference · ${evaluationReceipt.operationId}`
                : run?.live
                  ? "No Take 1 qualification receipt recorded yet"
                  : run
                    ? "Demo preview · no provider evaluation receipt"
                    : "No run selected",
              color: evaluationReceipt ? "var(--pass)" : "var(--faint)",
            },
            {
              label: "Take 2 brief",
              value: take2
                ? `${corrections.length} active correction${corrections.length === 1 ? "" : "s"} saved · cap 12`
                : "Not compiled in the selected run yet",
              color: take2 ? "var(--borderline)" : "var(--faint)",
            },
          ]}
        />
      </section>
      <section>
        <SectionTitle
          right={
            <Badge color={corrections.length > 0 ? "var(--borderline)" : undefined}>
              {corrections.length}/12
            </Badge>
          }
        >
          Corrections compiled into Take 2
        </SectionTitle>
        {corrections.length > 0 ? (
          <ol className="space-y-2">
            {corrections.map((correction, index) => (
              <li
                key={correction.id}
                className="rounded-lg bg-raised p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-2xs tabular-nums text-faint">
                    {index + 1}
                  </span>
                  <Badge color={severityColor(correction.severity)}>
                    {correction.severity}
                  </Badge>
                  <span className="text-2xs text-faint">
                    {evalName(correction.sourceEvalId)}
                  </span>
                </div>
                <p className="mt-2 text-pretty text-xs leading-relaxed text-ink">
                  {correction.instruction}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-lg bg-raised px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            {take2
              ? "The saved Take 2 brief has no active correction entries."
              : "No Take 2 correction ledger is saved yet."}
          </p>
        )}
        <p className="mt-2 text-pretty text-2xs leading-relaxed text-faint">
          This is the saved run projection only. Missing results or receipts are
          left missing; the inspector does not infer a completed provider trace.
        </p>
      </section>
      <button
        type="button"
        onClick={() => onSelectNode("final")}
        className="inline-flex min-h-10 items-center text-xs text-faint transition-colors duration-150 hover:text-ink"
      >
        Inspect the Take 2 brief →
      </button>
    </>
  );
}

function CombinedReviewSection({ run, mode }: { run?: Run; mode: Mode }) {
  const snapshots = ([1, 2] as const).map((iteration) => ({
    iteration,
    snapshot: combinedQualificationSnapshot(run, mode, iteration),
  }));
  const eligibleCount = snapshots.filter(({ snapshot }) => snapshot.eligible).length;
  const grade = run?.humanGrade;
  const winner = grade?.gradedIteration;
  const winnerLabel = winner
    ? `${attemptLabel("combined", winner)} saved by the human grader`
    : grade
      ? "Grade saved without a Combined winner reference"
      : "No winner saved yet";

  return (
    <>
      <section>
        <SectionTitle>Winner record</SectionTitle>
        <PromptTrace
          items={[
            {
              label: "Eligible pool",
              value: run
                ? `${eligibleCount}/2 takes eligible from saved receipts`
                : "No run selected",
              color: eligibleCount > 0 ? "var(--pass)" : "var(--faint)",
            },
            {
              label: mode === "mock" ? "Saved demo winner" : "Human winner",
              value: winnerLabel,
              color: winner ? "var(--accent)" : grade ? "var(--borderline)" : "var(--faint)",
            },
            {
              label: "Winner binding",
              value: winner
                ? grade?.gradedCandidateArtifactIdentityHash
                  ? "Exact candidate artifact identity recorded"
                  : "Winner iteration recorded · artifact identity absent on this record"
                : "Nothing is auto-selected",
              color: grade?.gradedCandidateArtifactIdentityHash
                ? "var(--pass)"
                : "var(--faint)",
            },
            {
              label: "Human verdict",
              value: grade ? (grade.shipIt ? "Ship it" : "Do not ship") : "Not graded yet",
              color: grade
                ? grade.shipIt
                  ? "var(--pass)"
                  : "var(--fail)"
                : "var(--faint)",
            },
          ]}
        />
      </section>
      <section>
        <SectionTitle>Candidate qualification</SectionTitle>
        <div className="grid gap-2 sm:grid-cols-2">
          {snapshots.map(({ iteration, snapshot }) => (
            <div
              key={iteration}
              className="rounded-lg bg-raised p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-ink">
                  {attemptLabel("combined", iteration)}
                </p>
                <Badge color={snapshot.color}>{snapshot.label}</Badge>
              </div>
              <p className="mt-2 text-pretty text-2xs leading-relaxed text-muted">
                {snapshot.detail}
              </p>
              {winner === iteration ? (
                <p className="mt-2 text-2xs font-semibold text-accent">
                  Saved winner
                </p>
              ) : null}
            </div>
          ))}
        </div>
        <p className="mt-2 text-pretty text-2xs leading-relaxed text-faint">
          The engine never picks a winner from scores. A person chooses one
          eligible take, then the saved grade stays bound to that exact candidate.
        </p>
      </section>
    </>
  );
}

function AggregateSection({
  run,
  workflowMode,
  onSelectNode,
}: {
  run?: Run;
  workflowMode: WorkflowMode;
  onSelectNode: (nodeId: string) => void;
}) {
  const visualDefinitions = (run
    ? evalDefsForRun(run)
    : evalDefinitionsForMode(workflowMode)
  ).filter((definition) => definition.method !== "deterministic");
  const visualIds = new Set(visualDefinitions.map((definition) => definition.id));
  const summaries =
    run?.iterations.map((iteration) => {
      const visual = iteration.evalResults.filter((result) =>
        visualIds.has(result.evalId)
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
              value: "Every visual result returned together for the whole video",
              color: "var(--running)",
            },
            {
              label: workflowMode === "flora" ? "After an attempt" : "After Initial",
              value:
                workflowMode === "flora"
                  ? "Consolidates actionable findings into the next attempt's correction set"
                  : "Consolidates every actionable finding into one correction set",
              color: "var(--borderline)",
            },
            {
              label: workflowMode === "flora" ? "At delivery" : "After Final",
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
                  {workflowMode === "flora"
                    ? `${attemptLabel(workflowMode, index)} evaluation`
                    : index === 1
                      ? "Initial critique"
                      : "Final evaluation"}
                </p>
                <div className="mt-1 flex items-baseline justify-between gap-3">
                  <span className="text-lg font-semibold tabular-nums text-ink">
                    {average ?? "—"}
                  </span>
                  <span className="text-2xs tabular-nums text-faint">
                    {count}/{visualDefinitions.length} visual results
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
        {workflowMode === "flora"
          ? "Inspect the next prompt these fixes create →"
          : "Inspect the Final prompt these fixes create →"}
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
  const inspectorRun =
    run && runWorkflowMode(run) === workflowMode ? run : undefined;
  const state = inspectorRun?.nodeStates[node.id];
  const planModePromptRole =
    !isVersionAPlanMode(workflowMode) && workflowMode !== "combined"
      ? null
      : node.id === "plan"
        ? {
            label: "planning prompt",
            color: "var(--running)",
            description:
              `Proposes the source-specific ${workflowModeLabel(workflowMode)} plan; it cannot approve itself.`,
          }
        : node.id === "initial" || node.id === "final"
          ? {
              label: "approved-plan prompt",
              color: "var(--accent)",
              description:
                `Consumes an approved-plan-bound ${workflowModeLabel(workflowMode)} brief with every out-of-scope region locked.`,
            }
          : node.id === "critique"
            ? {
                label: "plan-bound rubrics",
                color: "var(--running)",
              description:
                  "Composes the mode's visual checks into one approved-plan-bound whole-video evaluator; audio is deterministic.",
              }
            : null;
  const promptRole =
    planModePromptRole ?? promptRoleForNode(node, workflowMode);
  const runMode: Mode = inspectorRun
    ? inspectorRun.live
      ? "live"
      : "mock"
    : mode;
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
            run={inspectorRun}
            mode={runMode}
            workflowMode={workflowMode}
          />
        ) : null}
        {node.id === "plan" && workflowMode === "background" ? (
          <BackgroundPlanSection run={inspectorRun} />
        ) : null}
        {node.id === "plan" && workflowMode === "combined" ? (
          <CombinedPlanSection run={inspectorRun} />
        ) : null}
        {node.id === "critique" && workflowMode === "background" ? (
          <BackgroundCritiqueSection
            run={inspectorRun}
            onSelectNode={onSelectNode}
          />
        ) : null}
        {node.id === "critique" && workflowMode === "combined" ? (
          <CombinedCritiqueSection
            run={inspectorRun}
            onSelectNode={onSelectNode}
          />
        ) : null}
        {node.id === "manifest" ? (
          <ManifestSection run={inspectorRun} mode={runMode} />
        ) : null}
        {node.id === "compile" ? (
          <MegaPromptSection
            run={inspectorRun}
            mode={runMode}
            workflowMode={workflowMode}
            onSelectNode={onSelectNode}
          />
        ) : null}
        {node.kind === "generate" ? (
          <>
            <GenerateSection
              node={node}
              run={inspectorRun}
              mode={runMode}
              workflowMode={workflowMode}
              onSelectNode={onSelectNode}
            />
            {workflowMode === "combined" &&
            (node.id === "initial" || node.id === "final") ? (
              <CombinedCandidateQualificationSection
                run={inspectorRun}
                mode={runMode}
                iteration={node.id === "initial" ? 1 : 2}
              />
            ) : null}
          </>
        ) : null}
        {node.kind === "aggregate" ? (
          <AggregateSection
            run={inspectorRun}
            workflowMode={workflowMode}
            onSelectNode={onSelectNode}
          />
        ) : null}
        {node.id === "review" && workflowMode === "combined" ? (
          <CombinedReviewSection run={inspectorRun} mode={runMode} />
        ) : null}
        {node.kind === "gate" && node.id === "gate" ? (
          <GateSection
            run={inspectorRun}
            config={config}
            workflowMode={workflowMode}
          />
        ) : null}
        {node.kind === "gate" && node.id === "anchor-gate" ? (
          <AnchorGateSection run={inspectorRun} mode={runMode} />
        ) : null}
      </div>
    </aside>
  );
}
