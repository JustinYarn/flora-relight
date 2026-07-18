"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Badge, Card, SectionTitle } from "@/components/ui";
import { MANIFEST_PROMPT } from "@/lib/prompts/manifest";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { initialMegaPrompt } from "@/lib/prompts/mega-prompt";
import { useAppStore } from "@/lib/store";
import type { EvalDefinition, EvalMethod, WorkflowMode } from "@/lib/types";
import { workflowForMode } from "@/lib/workflow-def";
import { LAMP_EVAL_DEFS } from "@/lib/lamp-evaluation";
import { LAMP_BACKGROUND_UI_EVAL_DEFS } from "@/lib/lamp-background-read";
import { LAMP_BEAUTIFY_UI_EVAL_DEFS } from "@/lib/lamp-beautify-read";
import { LAMP_IRIS_UI_EVAL_DEFS } from "@/lib/lamp-iris-read";
import {
  lampBackgroundDisplayPrompt,
  sampleApprovedLampBackgroundPlan,
} from "@/lib/lamp-background-display";
import {
  LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT,
  type LampBackgroundCleanupPlan,
} from "@/lib/lamp-background";
import { renderLampBackgroundHolisticEvaluatorPrompt } from "@/lib/lamp-background-evaluation";
import { LAMP_BEAUTIFY_PLAN_PROMPT } from "@/lib/lamp-beautify";
import { LAMP_IRIS_PLAN_PROMPT } from "@/lib/lamp-iris";
import {
  isVersionAPlanMode,
  lampBeautifyDisplayPrompt,
  lampIrisDisplayPrompt,
} from "@/lib/plan-mode-display";
import { runWorkflowMode, workflowModeLabel } from "@/lib/workflow-mode";

type CheckFilter = "all" | "rubric" | "code";

const METHOD_COLOR: Record<EvalMethod, string> = {
  "dual-llm-judge": "var(--accent)",
  hybrid: "var(--running)",
  deterministic: "var(--muted)",
};

const FILTERS: Array<{ id: CheckFilter; label: string }> = [
  { id: "all", label: "All checks" },
  { id: "rubric", label: "Rubrics" },
  { id: "code", label: "Code checks" },
];

function definitionsForMode(workflowMode: WorkflowMode): EvalDefinition[] {
  if (workflowMode === "lamp") return LAMP_EVAL_DEFS;
  if (workflowMode === "background") return LAMP_BACKGROUND_UI_EVAL_DEFS;
  if (workflowMode === "beautify") return LAMP_BEAUTIFY_UI_EVAL_DEFS;
  if (workflowMode === "iris") return LAMP_IRIS_UI_EVAL_DEFS;
  return EVAL_DEFS;
}

function planningPromptForMode(workflowMode: WorkflowMode): string | undefined {
  if (workflowMode === "background") return LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT;
  if (workflowMode === "beautify") return LAMP_BEAUTIFY_PLAN_PROMPT;
  if (workflowMode === "iris") return LAMP_IRIS_PLAN_PROMPT;
  return undefined;
}

function planEditLabel(workflowMode: WorkflowMode): string {
  if (workflowMode === "background") return "cleanup";
  if (workflowMode === "beautify") return "enhancement";
  if (workflowMode === "iris") return "gaze correction";
  return "edit";
}

function Pre({ children }: { children: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label="Prompt or rubric source text"
      className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-canvas p-4 font-[family-name:var(--font-geist-mono)] text-xs leading-relaxed text-muted focus:outline-none focus:ring-2 focus:ring-accent"
    >
      {children}
    </pre>
  );
}

function codeCheckCaveat(evalId: string, workflowMode: WorkflowMode): string {
  if (evalId === "audio-integrity") {
    if (isVersionAPlanMode(workflowMode)) {
      return `${workflowModeLabel(workflowMode)} restores and verifies source audio on each generated cut. Audio is deterministic and never part of the visual model request.`;
    }
    return workflowMode === "lamp"
      ? "Lamp verifies the restored original audio after each generation. This broader specification remains reference material; the selected run's node status is the operational truth."
      : "Flora verifies the restored original audio on the selected delivery. The selected run's node status is the operational truth.";
  }
  return "Code-check specification. Open the Engine node to see whether it actually ran on the selected run.";
}

function EngineLink({ nodeId, children }: { nodeId: string; children?: ReactNode }) {
  return (
    <Link
      href={`/pipeline?node=${encodeURIComponent(nodeId)}`}
      className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border border-edge px-3 text-xs font-medium text-muted transition-colors duration-150 hover:border-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {children ?? "Open in Engine"}
      <span className="ml-1.5" aria-hidden="true">
        ↗
      </span>
    </Link>
  );
}

function FlowNode({
  index,
  title,
  detail,
  nodeId,
}: {
  index: number;
  title: string;
  detail: string;
  nodeId: string;
}) {
  return (
    <Link
      href={`/pipeline?node=${encodeURIComponent(nodeId)}`}
      className="group flex w-40 shrink-0 items-start gap-3 rounded-xl border border-edge bg-surface p-3 text-left transition-[border-color,box-shadow] duration-150 hover:border-faint hover:shadow-[0_1px_2px_rgba(0,0,0,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-raised font-[family-name:var(--font-geist-mono)] text-2xs tabular-nums text-faint">
        {index}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-ink transition-colors duration-150 group-hover:text-accent">
          {title}
        </span>
        <span className="mt-0.5 block text-pretty text-2xs leading-relaxed text-faint">
          {detail}
        </span>
      </span>
    </Link>
  );
}

function SourceDisclosure({
  title,
  description,
  badge,
  badgeColor,
  children,
}: {
  title: string;
  description: string;
  badge: string;
  badgeColor: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-xl border border-edge bg-surface open:shadow-[0_1px_2px_rgba(0,0,0,0.08)]">
      <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">{title}</span>
            <Badge color={badgeColor}>{badge}</Badge>
          </span>
          <span className="mt-1 block text-pretty text-xs leading-relaxed text-muted">
            {description}
          </span>
        </span>
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center text-lg text-faint transition-transform duration-200 ease-out group-open:rotate-90"
          aria-hidden="true"
        >
          ›
        </span>
      </summary>
      <div className="border-t border-edge p-4">{children}</div>
    </details>
  );
}

function DefinitionLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-edge py-2.5 last:border-0 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
        {label}
      </dt>
      <dd className="text-pretty text-xs leading-relaxed text-muted">{children}</dd>
    </div>
  );
}

function CleanupPlanDefinition({
  plan,
  sample,
}: {
  plan: LampBackgroundCleanupPlan;
  sample: boolean;
}) {
  return (
    <div className="rounded-lg bg-raised p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{plan.sceneSummary}</p>
          <p className="mt-1 font-[family-name:var(--font-geist-mono)] text-2xs text-faint">
            {plan.id}
          </p>
        </div>
        <Badge
          color={
            sample
              ? "var(--muted)"
              : plan.approval.status === "approved"
                ? "var(--pass)"
                : "var(--borderline)"
          }
        >
          {sample
            ? "sample approved plan"
            : plan.approval.status === "approved"
              ? "run-approved plan"
              : "run draft · not generation-authorized"}
        </Badge>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {[
          {
            title: "Remove",
            items: plan.remove,
            note: "Only these items are authorized to disappear.",
          },
          {
            title: "Preserve",
            items: plan.preserve,
            note: "These elements must stay source-faithful.",
          },
          {
            title: "Uncertain",
            items: plan.uncertain,
            note: "Every uncertain item defaults to preserve.",
          },
        ].map((group) => (
          <section key={group.title} className="rounded-lg bg-canvas p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-ink">{group.title}</h3>
              <span className="text-2xs tabular-nums text-faint">
                {group.items.length}
              </span>
            </div>
            <p className="mt-1 text-pretty text-2xs leading-relaxed text-faint">
              {group.note}
            </p>
            <ul className="mt-2 space-y-2">
              {group.items.map((item) => (
                <li key={item.id} className="text-pretty text-xs leading-relaxed text-muted">
                  <span className="font-medium text-ink">{item.label}</span>
                  <span className="block text-2xs text-faint">{item.location}</span>
                </li>
              ))}
              {group.items.length === 0 ? (
                <li className="text-2xs text-faint">None.</li>
              ) : null}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function checkKind(def: EvalDefinition): {
  label: string;
  color: string;
  codeOnly: boolean;
} {
  if (!def.promptTemplate) {
    return { label: "code check", color: "var(--muted)", codeOnly: true };
  }
  if (def.method === "hybrid") {
    return {
      label: "holistic rubric",
      color: "var(--running)",
      codeOnly: false,
    };
  }
  return { label: "rubric", color: "var(--accent)", codeOnly: false };
}

function CheckRow({
  def,
  index,
  nodeId,
  workflowMode,
  open,
  onToggle,
}: {
  def: EvalDefinition;
  index: number;
  nodeId?: string;
  workflowMode: WorkflowMode;
  open: boolean;
  onToggle: () => void;
}) {
  const kind = checkKind(def);

  return (
    <article
      className="rounded-xl border bg-surface transition-[border-color,box-shadow] duration-150"
      style={{
        borderColor: open ? "var(--faint)" : "var(--edge)",
        boxShadow: open ? "0 1px 2px rgba(0, 0, 0, 0.08)" : "none",
      }}
    >
      <div className="flex items-stretch gap-1 p-1.5 sm:gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-h-14 min-w-0 flex-1 items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="mt-0.5 w-5 shrink-0 text-right font-[family-name:var(--font-geist-mono)] text-2xs tabular-nums text-faint">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">{def.name}</span>
              <Badge color={kind.color}>{kind.label}</Badge>
              {def.hardGate ? (
                <Badge color="var(--fail)">must pass</Badge>
              ) : null}
              {!def.hardGate ? <Badge color="var(--faint)">advisory</Badge> : null}
            </span>
            <span className="mt-1 block text-pretty text-xs leading-relaxed text-muted">
              {def.description}
            </span>
          </span>
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center text-lg text-faint transition-transform duration-200 ease-out ${
              open ? "rotate-90" : ""
            }`}
            aria-hidden="true"
          >
            ›
          </span>
        </button>
        {nodeId ? (
          <div className="hidden items-center pr-1 sm:flex">
            <EngineLink nodeId={nodeId}>Engine node</EngineLink>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="border-t border-edge p-4">
          <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
            <div>
              <SectionTitle>Definition</SectionTitle>
              <dl>
                <DefinitionLine label="ID">
                  <span className="font-[family-name:var(--font-geist-mono)] text-2xs">
                    {def.id}
                  </span>
                </DefinitionLine>
                <DefinitionLine label="Category">{def.category}</DefinitionLine>
                <DefinitionLine label="Method">
                  {isVersionAPlanMode(workflowMode) &&
                  def.method !== "deterministic"
                    ? "holistic Gemini · one shared request"
                    : def.method}
                </DefinitionLine>
                <DefinitionLine label="Weight">
                  <span className="tabular-nums">
                    {def.weight.toFixed(2)} (
                    {Math.round(
                      (def.weight /
                        definitionsForMode(workflowMode).reduce(
                          (sum, d) => sum + d.weight,
                          0
                        )) *
                        100
                    )}
                    % of composite)
                  </span>
                </DefinitionLine>
                <DefinitionLine label="Pass">
                  <span className="tabular-nums text-pass">≥ {def.passThreshold}</span>
                </DefinitionLine>
                <DefinitionLine label="Borderline">
                  <span className="tabular-nums text-borderline">
                    ≥ {def.borderlineThreshold}
                  </span>
                </DefinitionLine>
              </dl>
              {nodeId ? (
                <div className="mt-3 sm:hidden">
                  <EngineLink nodeId={nodeId} />
                </div>
              ) : null}
            </div>

            <div className="min-w-0">
              {kind.codeOnly ? (
                <>
                  <SectionTitle right={<Badge color="var(--muted)">no model prompt</Badge>}>
                    Code-check specification
                  </SectionTitle>
                  <p className="mb-3 text-pretty text-xs leading-relaxed text-faint">
                    {codeCheckCaveat(def.id, workflowMode)}
                  </p>
                  <div className="rounded-lg bg-raised p-4 text-pretty text-xs leading-relaxed text-muted">
                    {def.deterministicNote ?? "No code-check description is available."}
                  </div>
                </>
              ) : (
                <>
                  <SectionTitle right={<Badge color={METHOD_COLOR[def.method]}>current source</Badge>}>
                    Current canonical rubric
                  </SectionTitle>
                  <p className="mb-3 text-pretty text-xs leading-relaxed text-faint">
                    {isVersionAPlanMode(workflowMode)
                      ? `This is the canonical ${workflowModeLabel(workflowMode)} criterion library. Its visual rubrics are composed into one approved-plan-bound whole-video Gemini request; Audio Integrity remains deterministic.`
                      : workflowMode === "lamp"
                      ? "This is the canonical criterion library. Lamp removes the older frame-grid input/output boilerplate and composes the applicable criteria into one full-video Gemini request. It is not a snapshot of a past run."
                      : "This is the canonical criterion library used by Flora's full-loop evaluation path. It is current source text, not a snapshot of a past run."}
                  </p>
                  <Pre>{def.promptTemplate}</Pre>
                  {def.deterministicNote ? (
                    <details className="group mt-3 rounded-lg border border-edge bg-raised">
                      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-3 text-xs font-medium text-muted transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
                        Code-assisted tier
                        <span
                          className="text-base text-faint transition-transform duration-200 ease-out group-open:rotate-90"
                          aria-hidden="true"
                        >
                          ›
                        </span>
                      </summary>
                      <p className="border-t border-edge p-3 text-pretty text-xs leading-relaxed text-muted">
                        {def.deterministicNote}
                      </p>
                    </details>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export default function PromptsPage() {
  const workflowMode = useAppStore((state) => state.workflowMode);
  const runs = useAppStore((state) => state.runs);
  const [selectedPlanRunId, setSelectedPlanRunId] = useState<
    string | null
  >(null);
  const planModeRuns = useMemo(
    () =>
      isVersionAPlanMode(workflowMode)
        ? runs.filter((run) => runWorkflowMode(run) === workflowMode)
        : [],
    [runs, workflowMode]
  );
  const selectedPlanRun = useMemo(
    () =>
      planModeRuns.find((run) => run.id === selectedPlanRunId) ??
      planModeRuns[0],
    [planModeRuns, selectedPlanRunId]
  );
  const modeMap = useMemo(() => {
    const workflow = workflowForMode(workflowMode);
    const definitions = definitionsForMode(workflowMode);
    const evalNodeIds =
      isVersionAPlanMode(workflowMode)
        ? new Map(
            definitions.map(
              (definition) => [definition.id, "critique"] as const
            )
          )
        : new Map(
            workflow.nodes.flatMap((node) =>
              node.evalId ? [[node.evalId, node.id] as const] : []
            )
          );
    const evalOrder = new Map(
      workflow.nodes.flatMap((node, index) =>
        node.evalId ? [[node.evalId, index] as const] : []
      )
    );
    const orderedEvalDefs = [...definitions].sort(
      (a, b) =>
        (evalOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (evalOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    );
    return { workflow, evalNodeIds, orderedEvalDefs };
  }, [workflowMode]);
  const backgroundPromptView = useMemo(
    () =>
      lampBackgroundDisplayPrompt(
        workflowMode === "background" ? selectedPlanRun : undefined
      ),
    [selectedPlanRun, workflowMode]
  );
  const beautifyPromptView = useMemo(
    () =>
      lampBeautifyDisplayPrompt(
        workflowMode === "beautify" ? selectedPlanRun : undefined
      ),
    [selectedPlanRun, workflowMode]
  );
  const irisPromptView = useMemo(
    () =>
      lampIrisDisplayPrompt(
        workflowMode === "iris" ? selectedPlanRun : undefined
      ),
    [selectedPlanRun, workflowMode]
  );
  const mega = useMemo(() => {
    if (workflowMode === "background") return backgroundPromptView.prompt;
    if (workflowMode === "beautify") return beautifyPromptView.prompt;
    if (workflowMode === "iris") return irisPromptView.prompt;
    return initialMegaPrompt(workflowMode);
  }, [
    backgroundPromptView.prompt,
    beautifyPromptView.prompt,
    irisPromptView.prompt,
    workflowMode,
  ]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CheckFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const base = mega.base;
  const isLamp = workflowMode === "lamp";
  const isBackground = workflowMode === "background";
  const isBeautify = workflowMode === "beautify";
  const isIris = workflowMode === "iris";
  const isPlanMode = isVersionAPlanMode(workflowMode);
  const activePlanPromptView = isBackground
    ? backgroundPromptView
    : isBeautify
      ? beautifyPromptView
      : isIris
        ? irisPromptView
        : undefined;
  const selectedBackgroundRun = isBackground ? selectedPlanRun : undefined;
  const planningPrompt = planningPromptForMode(workflowMode);
  const editLabel = planEditLabel(workflowMode);
  const modeLabel = workflowModeLabel(workflowMode);
  const visibleBackgroundPlan =
    selectedBackgroundRun?.backgroundCleanupPlan ??
    sampleApprovedLampBackgroundPlan();
  const visibleBackgroundPlanIsSample =
    selectedBackgroundRun?.backgroundCleanupPlan === undefined;
  const generationBackgroundPlanIsSample = backgroundPromptView.sample;
  const selectedBackgroundNoOp =
    isBackground &&
    !backgroundPromptView.sample &&
    backgroundPromptView.promptPlan.decision === "exceptional-no-op";
  const selectedPlanNoOp =
    isPlanMode &&
    activePlanPromptView?.sample === false &&
    activePlanPromptView.prompt.rendered.startsWith(
      `=== ${modeLabel.toUpperCase()} APPROVED EXCEPTIONAL NO-OP ===`
    );
  const rubricCount = modeMap.orderedEvalDefs.filter(
    (definition) => definition.promptTemplate
  ).length;
  const codeCheckCount = modeMap.orderedEvalDefs.length - rubricCount;

  const filteredDefs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return modeMap.orderedEvalDefs.filter((def) => {
      const codeOnly = !def.promptTemplate;
      if (filter === "rubric" && codeOnly) return false;
      if (filter === "code" && !codeOnly) return false;
      if (!needle) return true;
      return [
        def.name,
        def.id,
        def.category,
        def.method,
        def.description,
        def.promptTemplate,
        def.deterministicNote ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [filter, modeMap.orderedEvalDefs, query]);

  return (
    <main className="mx-auto max-w-6xl px-5 pb-16 pt-8">
      <header className="mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <h1 className="text-balance text-lg font-semibold text-ink">
              Prompt &amp; check map
            </h1>
            <Badge color="var(--accent)">
              {isPlanMode && activePlanPromptView?.runBound
                ? "run-bound prompt"
                : "current definition"}
            </Badge>
          </div>
          {isPlanMode && planModeRuns.length > 0 ? (
            <label className="flex items-center gap-2 text-2xs text-faint">
              {modeLabel} run
              <select
                value={selectedPlanRun?.id ?? ""}
                onChange={(event) =>
                  setSelectedPlanRunId(event.target.value || null)
                }
                className="min-h-10 rounded-lg border border-edge bg-raised px-2.5 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {planModeRuns.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.originalVideo.label} · {run.status}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <p className="mt-2 max-w-3xl text-pretty text-sm leading-relaxed text-muted">
          {isPlanMode
            ? `Inspect ${modeLabel}'s planning instruction, exact approved-plan-bound ${editLabel} brief, and mode-specific evaluation definitions.`
            : isLamp
            ? "See the mega prompt and evaluation criteria behind Lamp's fixed Initial → critique → Final method. Long source text stays folded away until you need it."
            : "See the mega prompt and evaluation criteria behind Flora's full iterative relight method. Long source text stays folded away until you need it."}
        </p>
        <p className="mt-2 max-w-3xl text-pretty text-2xs leading-relaxed text-faint">
          {isPlanMode
            ? activePlanPromptView?.sample
              ? `No generation-authorized ${modeLabel} run is selected, so this definition view uses a clearly labeled synthetic approved plan. ${rubricCount} visual checks run together; Audio Integrity is deterministic.`
              : `The brief below prefers the selected run's exact saved iteration prompt and approved plan. ${rubricCount} visual checks run together; Audio Integrity is deterministic.`
            : isLamp
            ? "Each generated video gets one whole-video evaluation covering eight visual rubrics plus deterministic audio."
            : "Flora's 11-row method combines nine visual rubrics with deterministic timing and audio checks."}
        </p>
      </header>

      <section className="mb-9" aria-labelledby="workflow-map-title">
        <SectionTitle
          right={
            <span className="text-2xs text-faint">
              definition map · select a node to continue in Engine
            </span>
          }
        >
          <span id="workflow-map-title">
            How instructions move through {modeLabel}
          </span>
        </SectionTitle>
        <div className="overflow-x-auto pb-2">
          {isPlanMode ? (
            <div className="flex min-w-max items-center gap-2">
              <FlowNode
                index={1}
                title={
                  isBackground
                    ? "Plan the cleanup"
                    : isBeautify
                      ? "Plan enhancements"
                      : "Plan eye contact"
                }
                detail={`Inspect the full source and classify approved, declined, and uncertain ${editLabel} items.`}
                nodeId="plan"
              />
              <span className="text-faint" aria-hidden="true">
                →
              </span>
              <FlowNode
                index={2}
                title="Approve the plan"
                detail="A human freezes the exact edit authorization before generation."
                nodeId="plan"
              />
              <span className="text-faint" aria-hidden="true">
                →
              </span>
              <FlowNode
                index={3}
                title="Generate Initial"
                detail={`Apply only the approved ${editLabel} plan to the immutable source.`}
                nodeId="initial"
              />
              <span className="text-faint" aria-hidden="true">
                →
              </span>
              <FlowNode
                index={4}
                title={`Critique the ${editLabel}`}
                detail={`Run ${rubricCount} plan-bound visual checks and deterministic audio.`}
                nodeId="critique"
              />
              <span className="text-accent" aria-hidden="true">
                ↺
              </span>
              <FlowNode
                index={5}
                title="Generate Final"
                detail="Regenerate once from source with structured corrections."
                nodeId="final"
              />
            </div>
          ) : isLamp ? (
            <div className="flex min-w-max items-center gap-2">
              <FlowNode
                index={1}
                title="Compile the brief"
                detail="Combine base instructions, lighting, and active fixes."
                nodeId="compile"
              />
              <span className="text-faint" aria-hidden="true">
                →
              </span>
              <FlowNode
                index={2}
                title="Generate a candidate"
                detail="Send the run-bound brief with the source video."
                nodeId="videogen"
              />
              <span className="text-faint" aria-hidden="true">
                →
              </span>
              <FlowNode
                index={3}
                title="Critique the whole video"
                detail="Eight visual results return together; audio is appended deterministically."
                nodeId="eval-identity"
              />
              <span className="text-faint" aria-hidden="true">
                →
              </span>
              <FlowNode
                index={4}
                title="Collect every fix"
                detail="Turn all actionable findings into one correction set."
                nodeId="ledger"
              />
              <span className="text-accent" aria-hidden="true">
                ↺
              </span>
              <FlowNode
                index={5}
                title="Generate Final"
                detail="Compile once, regenerate once, then evaluate the final."
                nodeId="compile"
              />
            </div>
          ) : (
            <div className="flex min-w-max items-center gap-2">
              <FlowNode
                index={1}
                title="Inventory the scene"
                detail="Extract protected people, wardrobe, room, and camera facts."
                nodeId="manifest"
              />
              <span className="text-faint" aria-hidden="true">
                →
              </span>
              <FlowNode
                index={2}
                title="Approve a Look Anchor"
                detail="Choose the still-image lighting target before video spend."
                nodeId="anchor"
              />
              <span className="text-faint" aria-hidden="true">
                →
              </span>
              <FlowNode
                index={3}
                title="Compile and generate"
                detail="Bind the source, approved look, locks, and active fixes."
                nodeId="compile"
              />
              <span className="text-faint" aria-hidden="true">
                →
              </span>
              <FlowNode
                index={4}
                title="Run all checks"
                detail="Score timing, fidelity, lighting, motion, stability, and audio."
                nodeId="eval-identity"
              />
              <span className="text-accent" aria-hidden="true">
                ↺
              </span>
              <FlowNode
                index={5}
                title="Gate, fix, or deliver"
                detail="Retry from source with corrections, then select the delivery."
                nodeId="gate"
              />
            </div>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-faint">
          <span>
            {isBackground
              ? "Lamp Background has no relighting stage, scene-manifest extractor, or open-ended retry loop. The approved cleanup plan is the edit boundary."
              : isPlanMode
              ? `${modeLabel} has no relighting stage, scene-manifest extractor, or open-ended retry loop. Its approved ${editLabel} plan is the edit boundary.`
              : isLamp
              ? "Lamp evaluates the complete source and candidate directly; it does not create a scene manifest or Look Anchor."
              : "Flora extracts a scene inventory, approves a Look Anchor, and retains its full 11-check evaluation loop."}
          </span>
        </div>
      </section>

      <section className="mb-9" aria-labelledby="prompt-sources-title">
        <SectionTitle>
          <span id="prompt-sources-title">Prompt sources</span>
        </SectionTitle>
        <div className="grid gap-3">
          {isPlanMode && planningPrompt ? (
            <SourceDisclosure
              title={`${modeLabel} plan analyzer`}
              description={`Current whole-video planning instruction that proposes bounded ${editLabel} work or the rare exceptional no-op.`}
              badge="planning prompt"
              badgeColor="var(--running)"
            >
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-3xl text-pretty text-xs leading-relaxed text-faint">
                  This prompt can propose a draft only. It cannot authorize
                  generation; the user must approve the exact source-specific
                  plan first.
                </p>
                <EngineLink nodeId="plan" />
              </div>
              {isBackground ? (
                <div className="mb-4">
                  <CleanupPlanDefinition
                    plan={visibleBackgroundPlan}
                    sample={visibleBackgroundPlanIsSample}
                  />
                </div>
              ) : null}
              <Pre>{planningPrompt}</Pre>
            </SourceDisclosure>
          ) : (
            <SourceDisclosure
              title={isLamp ? "Scene inventory reference" : "Scene inventory extractor"}
              description={
                isLamp
                  ? "Legacy full-loop extraction instructions retained for reference; Lamp does not run this stage."
                  : "Current extraction instructions Flora runs before its Look Anchor and video loop."
              }
              badge={isLamp ? "not used by Lamp" : "used by Flora"}
              badgeColor={isLamp ? "var(--faint)" : "var(--running)"}
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-3xl text-pretty text-xs leading-relaxed text-faint">
                  {isLamp
                    ? "Lamp compares the complete source and candidate videos directly. This older inventory definition remains readable for historical runs but is not sent to generation or evaluation in Lamp."
                    : "Flora sends this prompt once to create the scene inventory that protects source content through its anchor and iterative video loop."}
                </p>
                {isLamp ? (
                  <span className="inline-flex min-h-10 items-center text-2xs text-faint">
                    Legacy reference only
                  </span>
                ) : (
                  <EngineLink nodeId="manifest" />
                )}
              </div>
              <Pre>{MANIFEST_PROMPT}</Pre>
            </SourceDisclosure>
          )}

          <SourceDisclosure
            title={
              isPlanMode
                ? selectedPlanNoOp
                  ? "Approved exceptional no-op delivery"
                  : `Approved-plan-bound ${editLabel} brief`
                : "Generation brief compiler"
            }
            description={
              isPlanMode
                ? selectedPlanNoOp
                  ? `The selected run delivers the exact source unchanged; no ${editLabel} generation or Final AI evaluation is authorized.`
                  : `The exact ${editLabel} authorization, preservation locks, structured corrections, and never-do constraints.`
                : "Current base task, invariant locks, lighting specification, active fixes, and never-do constraints."
            }
            badge="compiler"
            badgeColor="var(--accent)"
          >
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-3xl text-pretty text-xs leading-relaxed text-faint">
                {isPlanMode
                  ? selectedPlanNoOp
                    ? "This is the selected run's saved exceptional no-op instruction. It records that the exact source is the delivery and does not claim a generation occurred."
                    : activePlanPromptView?.sample
                    ? `This definition-only example is compiled from a clearly labeled synthetic approved ${editLabel} plan. It is not attached to a real video.`
                    : `These are the selected run's exact saved ${editLabel}-prompt bytes when an iteration exists; otherwise they are compiled from its approved plan.`
                  : "The compiler assembles structured source blocks into a generation brief. The example below is the current first-version render with an empty fix list, not a historical run snapshot."}
              </p>
              <EngineLink nodeId={isPlanMode ? "initial" : "compile"} />
            </div>

            {isBackground ? (
              <div className="mb-5">
                <SectionTitle>Plan bound into this prompt</SectionTitle>
                <CleanupPlanDefinition
                  plan={backgroundPromptView.promptPlan}
                  sample={generationBackgroundPlanIsSample}
                />
              </div>
            ) : null}

            <div className="grid gap-5 lg:grid-cols-2">
              <div className="min-w-0">
                <SectionTitle>Base instructions</SectionTitle>
                <dl className="rounded-lg bg-raised px-3">
                  <DefinitionLine label="Task">{base.task}</DefinitionLine>
                  <DefinitionLine label="Identity">{base.locks.identity}</DefinitionLine>
                  <DefinitionLine label="Performance">
                    {base.locks.performance}
                  </DefinitionLine>
                  <DefinitionLine label="Wardrobe">{base.locks.wardrobe}</DefinitionLine>
                  <DefinitionLine label="Background">
                    {base.locks.background}
                  </DefinitionLine>
                  <DefinitionLine label="Camera">{base.locks.camera}</DefinitionLine>
                  <DefinitionLine label="Audio">{base.locks.audio}</DefinitionLine>
                  <DefinitionLine label="Lighting style">
                    {base.lighting.style}
                  </DefinitionLine>
                  <DefinitionLine label="Key light">
                    {base.lighting.keyLight}
                  </DefinitionLine>
                  <DefinitionLine label="Fill light">
                    {base.lighting.fillLight}
                  </DefinitionLine>
                  <DefinitionLine label="Rim light">
                    {base.lighting.rimLight}
                  </DefinitionLine>
                  <DefinitionLine label="Color temp">
                    {base.lighting.colorTemperature}
                  </DefinitionLine>
                  <DefinitionLine label="Mood">{base.lighting.mood}</DefinitionLine>
                </dl>
                <div className="mt-4">
                  <SectionTitle>Never do</SectionTitle>
                  <ul className="rounded-lg bg-raised px-3 py-2">
                    {base.negative.map((item) => (
                      <li
                        key={item}
                        className="flex gap-2 border-b border-edge py-2 text-pretty text-xs leading-relaxed text-muted last:border-0"
                      >
                        <span className="text-fail" aria-hidden="true">
                          ×
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="min-w-0">
                <SectionTitle
                  right={
                    <Badge>
                      v{mega.version}
                      {isPlanMode
                        ? activePlanPromptView?.runBound
                          ? " · run bound"
                          : " · sample"
                        : " · no fixes"}
                    </Badge>
                  }
                >
                  {isPlanMode
                    ? selectedPlanNoOp
                      ? "Exact-source delivery instruction"
                      : `${modeLabel} prompt sent to generation`
                    : "Current compiled example"}
                </SectionTitle>
                <Pre>{mega.rendered}</Pre>
                {isPlanMode && activePlanPromptView ? (
                  <p className="mt-2 font-[family-name:var(--font-geist-mono)] text-2xs text-faint">
                    source · {activePlanPromptView.source}
                  </p>
                ) : null}
              </div>
            </div>
          </SourceDisclosure>

          {isBackground ? (
            <SourceDisclosure
              title="Whole-video cleanup evaluator"
              description={
                selectedBackgroundNoOp
                  ? "Definition retained for inspection. The selected exceptional no-op run did not generate a candidate or run a Final AI evaluation."
                  : "One approved-plan-bound request composes all nine visual rubrics; deterministic Audio Integrity is appended separately."
              }
              badge={
                selectedBackgroundNoOp
                  ? "not run for selected no-op"
                  : "holistic evaluator"
              }
              badgeColor={
                selectedBackgroundNoOp ? "var(--faint)" : "var(--running)"
              }
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-3xl text-pretty text-xs leading-relaxed text-faint">
                  The evaluator receives the complete source, the complete
                  candidate, and the exact approved plan used below. It may emit
                  only structured correction actions tied to that plan.
                </p>
                <EngineLink nodeId="critique" />
              </div>
              <Pre>
                {renderLampBackgroundHolisticEvaluatorPrompt(
                  backgroundPromptView.promptPlan
                )}
              </Pre>
            </SourceDisclosure>
          ) : null}
        </div>
      </section>

      <section id="checks" aria-labelledby="checks-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <SectionTitle>
              <span id="checks-title">Checks</span>
            </SectionTitle>
            <p className="-mt-1 text-pretty text-xs leading-relaxed text-faint">
              Open one check at a time to inspect its thresholds and current source
              definition.
            </p>
          </div>
          <Badge>
            {modeMap.orderedEvalDefs.length} active · {rubricCount} visual rubrics ·{" "}
            {codeCheckCount} code {codeCheckCount === 1 ? "check" : "checks"}
          </Badge>
        </div>

        <Card className="mb-4 p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search checks and rubrics</span>
              <span
                className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted"
                aria-hidden="true"
              >
                ⌕
              </span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search names, categories, IDs, or rubric text…"
                className="min-h-10 w-full rounded-lg border border-edge bg-raised py-2 pl-9 pr-3 text-sm text-ink placeholder:text-faint transition-[border-color,box-shadow] duration-150 focus:border-faint focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </label>
            <div className="flex flex-wrap gap-1.5" aria-label="Filter checks">
              {FILTERS.map((item) => {
                const active = filter === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setFilter(item.id)}
                    aria-pressed={active}
                    className="min-h-10 rounded-lg border px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    style={
                      active
                        ? {
                            color: "var(--ink)",
                            borderColor: "var(--faint)",
                            background: "var(--raised)",
                          }
                        : {
                            color: "var(--muted)",
                            borderColor: "var(--edge)",
                            background: "transparent",
                          }
                    }
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="mt-2 text-2xs tabular-nums text-faint" role="status">
            Showing {filteredDefs.length} of {modeMap.orderedEvalDefs.length} checks
            {query || filter !== "all"
              ? ""
              : isPlanMode
                ? ` · ${modeLabel} returns ${rubricCount} visual results together and appends deterministic audio`
                : isLamp
                ? " · Lamp returns 8 visual results together and appends deterministic audio"
                : " · Flora retains 9 visual rubrics and 2 deterministic checks"}
          </p>
        </Card>

        {filteredDefs.length > 0 ? (
          <div className="space-y-2">
            {filteredDefs.map((def) => (
              <CheckRow
                key={def.id}
                def={def}
                index={modeMap.orderedEvalDefs.indexOf(def)}
                nodeId={modeMap.evalNodeIds.get(def.id)}
                workflowMode={workflowMode}
                open={openId === def.id}
                onToggle={() =>
                  setOpenId((current) => (current === def.id ? null : def.id))
                }
              />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-edge py-12 text-center">
            <p className="text-sm text-muted">No checks match this search.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
              className="mt-2 min-h-10 rounded-lg px-3 text-xs font-medium text-accent transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Clear search and filters
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
