"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Badge, Card, SectionTitle } from "@/components/ui";
import { RELIGHT_BASE_PROMPT } from "@/lib/prompts/base-prompt";
import { MANIFEST_PROMPT } from "@/lib/prompts/manifest";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { initialMegaPrompt } from "@/lib/prompts/mega-prompt";
import type { EvalDefinition, EvalMethod } from "@/lib/types";
import { RELIGHT_WORKFLOW } from "@/lib/workflow-def";

type CheckFilter = "all" | "rubric" | "code";

const METHOD_COLOR: Record<EvalMethod, string> = {
  "dual-llm-judge": "var(--accent)",
  hybrid: "var(--running)",
  deterministic: "var(--muted)",
};

const EVAL_NODE_IDS = new Map(
  RELIGHT_WORKFLOW.nodes.flatMap((node) =>
    node.evalId ? [[node.evalId, node.id] as const] : []
  )
);
const EVAL_ORDER = new Map(
  RELIGHT_WORKFLOW.nodes.flatMap((node, index) =>
    node.evalId ? [[node.evalId, index] as const] : []
  )
);
const ORDERED_EVAL_DEFS = [...EVAL_DEFS].sort(
  (a, b) =>
    (EVAL_ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
    (EVAL_ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER)
);

const FILTERS: Array<{ id: CheckFilter; label: string }> = [
  { id: "all", label: "All checks" },
  { id: "rubric", label: "Rubrics" },
  { id: "code", label: "Code checks" },
];

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

function codeCheckCaveat(evalId: string): string {
  if (evalId === "audio-integrity") {
    return "Target specification, not an exact executable snapshot. The current durable first-cut verifier compares audio-stream MD5 values over the shared minimum duration; Engine node status is the selected-run truth.";
  }
  if (evalId === "temporal-alignment") {
    return "Planned code-check specification. The current durable live first-cut path skips the visual eval loop, including this check; Engine node status is the selected-run truth.";
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
      label: "rubric + planned code",
      color: "var(--running)",
      codeOnly: false,
    };
  }
  return { label: "rubric", color: "var(--accent)", codeOnly: false };
}

function CheckRow({
  def,
  index,
  open,
  onToggle,
}: {
  def: EvalDefinition;
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  const kind = checkKind(def);
  const nodeId = EVAL_NODE_IDS.get(def.id);

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
              ) : (
                <Badge color="var(--faint)">advisory</Badge>
              )}
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
                <DefinitionLine label="Method">{def.method}</DefinitionLine>
                <DefinitionLine label="Weight">
                  <span className="tabular-nums">
                    {def.weight.toFixed(2)} ({Math.round(def.weight * 100)}%)
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
                    {codeCheckCaveat(def.id)}
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
                    This is the rubric in the current source definition. It is not a
                    snapshot of a past run or a provider-specific request.
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
  const mega = useMemo(() => initialMegaPrompt(), []);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CheckFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const base = RELIGHT_BASE_PROMPT;
  const rubricCount = EVAL_DEFS.filter((def) => Boolean(def.promptTemplate)).length;
  const codeCount = EVAL_DEFS.length - rubricCount;

  const filteredDefs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ORDERED_EVAL_DEFS.filter((def) => {
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
  }, [filter, query]);

  return (
    <main className="mx-auto max-w-6xl px-5 pb-16 pt-8">
      <header className="mb-8">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-balance text-lg font-semibold text-ink">
            Prompt &amp; check map
          </h1>
          <Badge color="var(--accent)">current definition</Badge>
        </div>
        <p className="mt-2 max-w-3xl text-pretty text-sm leading-relaxed text-muted">
          See which instructions shape generation, which checks evaluate an
          attempt, and where each check lives in the Engine. Long source text stays
          folded away until you need it.
        </p>
        <p className="mt-2 max-w-3xl text-pretty text-2xs leading-relaxed text-faint">
          This page maps the full-loop definition. In Engine, the selected run&apos;s
          node status shows which stages actually ran; durable live first cuts
          currently skip the anchor and visual-eval loop.
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
          <span id="workflow-map-title">How instructions move through the loop</span>
        </SectionTitle>
        <div className="overflow-x-auto pb-2">
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
              title="Run the checks"
              detail="10 attempt checks; audio gate after delivery."
              nodeId="eval-identity"
            />
            <span className="text-faint" aria-hidden="true">
              →
            </span>
            <FlowNode
              index={4}
              title="Collect fixes"
              detail="Turn reported violations into a deduplicated fix list."
              nodeId="ledger"
            />
            <span className="text-accent" aria-hidden="true">
              ↺
            </span>
            <FlowNode
              index={5}
              title="Compile again"
              detail="Feed active fixes into the next generation brief."
              nodeId="compile"
            />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-faint">
          <span>Side inputs in the full-loop definition:</span>
          <EngineLink nodeId="manifest">scene inventory → eval context</EngineLink>
          <EngineLink nodeId="anchor">Look Anchor → generation</EngineLink>
        </div>
      </section>

      <section className="mb-9" aria-labelledby="prompt-sources-title">
        <SectionTitle>
          <span id="prompt-sources-title">Prompt sources</span>
        </SectionTitle>
        <div className="grid gap-3">
          <SourceDisclosure
            title="Scene inventory prompt"
            description="Current extraction instructions for describing the person, room, camera, and starting light before evaluation."
            badge="prompt"
            badgeColor="var(--running)"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-3xl text-pretty text-xs leading-relaxed text-faint">
                This inventory is intended as evaluation context and is kept out
                of the generation brief so descriptive guesses do not become edit
                instructions. Current live judge requests do not attach it yet.
              </p>
              <EngineLink nodeId="manifest" />
            </div>
            <Pre>{MANIFEST_PROMPT}</Pre>
          </SourceDisclosure>

          <SourceDisclosure
            title="Generation brief compiler"
            description="Current base task, invariant locks, lighting specification, active fixes, and never-do constraints."
            badge="compiler"
            badgeColor="var(--accent)"
          >
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-3xl text-pretty text-xs leading-relaxed text-faint">
                The compiler assembles structured source blocks into a generation
                brief. The example below is the current first-version render with
                an empty fix list, not a historical run snapshot.
              </p>
              <EngineLink nodeId="compile" />
            </div>

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
                <SectionTitle right={<Badge>v{mega.version} · no fixes</Badge>}>
                  Current compiled example
                </SectionTitle>
                <Pre>{mega.rendered}</Pre>
              </div>
            </div>
          </SourceDisclosure>
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
            {EVAL_DEFS.length} total · {rubricCount} rubric-driven · {codeCount} code
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
            Showing {filteredDefs.length} of {EVAL_DEFS.length} checks
            {query || filter !== "all"
              ? ""
              : " · full demo loop: 10 per generation attempt; audio runs after delivery · durable live first cuts currently skip the visual eval loop"}
          </p>
        </Card>

        {filteredDefs.length > 0 ? (
          <div className="space-y-2">
            {filteredDefs.map((def) => (
              <CheckRow
                key={def.id}
                def={def}
                  index={ORDERED_EVAL_DEFS.indexOf(def)}
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
