"use client";

import type {
  EvalResult,
  PipelineNode,
  Run,
  RunConfig,
  ViolationSeverity,
} from "@/lib/types";
import { EVAL_DEFS, getEvalDef } from "@/lib/prompts/eval-defs";
import { formatTime } from "@/lib/util";
import {
  Badge,
  ConfidenceMeter,
  KV,
  ScoreMeter,
  SectionTitle,
  StatusDot,
  VerdictBadge,
} from "@/components/ui";
import { kindColor, PROVIDER_MODELS } from "@/components/canvas/PipelineNode";

function severityColor(s: ViolationSeverity): string {
  return s === "critical"
    ? "var(--fail)"
    : s === "major"
      ? "var(--borderline)"
      : "var(--faint)";
}

function DeltaChip({ delta }: { delta: number }) {
  const positive = delta >= 0;
  return (
    <span
      className="text-2xs font-semibold tabular-nums"
      style={{ color: positive ? "var(--pass)" : "var(--fail)" }}
      title="Score change vs previous attempt"
    >
      {positive ? "+" : ""}
      {delta.toFixed(1)}
    </span>
  );
}

/** Most recent result for an eval, scanning iterations newest → oldest. */
function latestResultFor(run: Run | undefined, evalId: string): EvalResult | null {
  if (!run) return null;
  for (let i = run.iterations.length - 1; i >= 0; i -= 1) {
    const found = run.iterations[i].evalResults.find(
      (r) => r.evalId === evalId
    );
    if (found) return found;
  }
  return null;
}

function EvalSection({ evalId, run }: { evalId: string; run?: Run }) {
  const def = getEvalDef(evalId);
  const perIteration =
    run?.iterations
      .map((it) => ({
        index: it.index,
        result: it.evalResults.find((r) => r.evalId === evalId),
      }))
      .filter(
        (x): x is { index: number; result: EvalResult } => Boolean(x.result)
      ) ?? [];

  return (
    <>
      <section>
        <SectionTitle>What this check is</SectionTitle>
        <KV k="Method" v={def.method} />
        <KV
          k="Must pass"
          v={
            def.hardGate ? (
              <Badge color="var(--fail)">
                <span title="must pass (hard gate) — failing it fails the attempt">
                  yes
                </span>
              </Badge>
            ) : (
              <Badge>
                <span title="advisory — counts toward the Overall score only">
                  no — advisory
                </span>
              </Badge>
            )
          }
        />
        <KV k="Weight" v={`${Math.round(def.weight * 100)}%`} />
        <KV k="Pass at" v={`≥ ${def.passThreshold}`} />
        <KV k="Borderline at" v={`≥ ${def.borderlineThreshold}`} />
        {def.deterministicNote ? (
          <p className="mt-2 rounded-lg bg-raised px-3 py-2 text-2xs leading-relaxed text-muted">
            {def.deterministicNote}
          </p>
        ) : null}
      </section>

      {def.promptTemplate ? (
        <section>
          <SectionTitle>Judge instructions</SectionTitle>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-edge bg-raised p-3 text-2xs leading-relaxed text-muted">
            {def.promptTemplate}
          </pre>
        </section>
      ) : null}

      {perIteration.length > 0 ? (
        <section>
          <SectionTitle>Results by attempt</SectionTitle>
          <div className="flex flex-col gap-3">
            {perIteration.map(({ index, result }) => (
              <div
                key={index}
                className="rounded-lg border border-edge bg-raised p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
                    Attempt {index}
                  </span>
                  <div className="flex items-center gap-2">
                    {typeof result.deltaFromPrevious === "number" ? (
                      <DeltaChip delta={result.deltaFromPrevious} />
                    ) : null}
                    <VerdictBadge verdict={result.verdict} />
                  </div>
                </div>
                <ScoreMeter score={result.score} verdict={result.verdict} />
                <div className="mt-2">
                  <ConfidenceMeter confidence={result.confidence} />
                </div>
                {result.violations.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1.5 border-t border-edge pt-2">
                    {result.violations.map((v, i) => (
                      <li
                        key={i}
                        className="text-2xs leading-relaxed text-muted"
                      >
                        <span
                          className="font-semibold uppercase"
                          style={{ color: severityColor(v.severity) }}
                        >
                          {v.severity}
                        </span>
                        {" · "}
                        <span className="text-ink">{v.aspect}</span>
                        {typeof v.frameTimestampSec === "number" ? (
                          <span className="text-faint">
                            {" "}
                            @ {formatTime(v.frameTimestampSec)}
                          </span>
                        ) : null}
                        {" — "}
                        {v.description}
                        <span className="block text-faint">
                          fix: {v.correction}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : run ? (
        <p className="text-2xs text-faint">
          No results for this eval in the selected run yet.
        </p>
      ) : null}
    </>
  );
}

function GenerateSection({ node, run }: { node: PipelineNode; run?: Run }) {
  const isVideoGen =
    node.providerId === "omni" || node.id.toLowerCase().includes("video");
  const latest =
    run && run.iterations.length > 0
      ? run.iterations[run.iterations.length - 1]
      : undefined;
  const activeCorrections = latest
    ? latest.megaPrompt.corrections.filter((c) => !c.resolved).length
    : 0;

  return (
    <>
      <section>
        <SectionTitle>Provider</SectionTitle>
        <KV
          k="Provider"
          v={node.providerId ?? "—"}
        />
        <KV
          k="Model"
          v={
            <span className="font-mono text-xs">
              {node.providerId ? PROVIDER_MODELS[node.providerId] : "—"}
            </span>
          }
        />
        <KV k="Mode" v={<Badge color="var(--accent)">MOCK</Badge>} />
      </section>

      {isVideoGen && latest ? (
        <section>
          <SectionTitle
            right={
              <span className="text-2xs tabular-nums text-faint">
                {activeCorrections} fix{activeCorrections === 1 ? "" : "es"} on
                the list
              </span>
            }
          >
            <span title={`Generation brief v${latest.megaPrompt.version} (mega prompt)`}>
              Generation brief · v{latest.megaPrompt.version}
            </span>
          </SectionTitle>
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-edge bg-raised p-3 text-2xs leading-relaxed text-muted">
            {latest.megaPrompt.rendered}
          </pre>
        </section>
      ) : null}
      {isVideoGen && !latest ? (
        <p className="text-2xs text-faint">
          The full generation brief appears here once the selected run reaches
          its first attempt.
        </p>
      ) : null}
    </>
  );
}

function AggregateSection({ run }: { run?: Run }) {
  const composites =
    run?.iterations.flatMap((it) =>
      it.composite ? [{ index: it.index, composite: it.composite }] : []
    ) ?? [];
  if (composites.length === 0) {
    return (
      <p className="text-2xs text-faint">
        Overall scores appear here per attempt once the checks finish.
      </p>
    );
  }
  return (
    <section>
      <SectionTitle>Overall score by attempt</SectionTitle>
      <div className="flex flex-col gap-2.5">
        {composites.map(({ index, composite }) => (
          <div key={index}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
                Attempt {index}
              </span>
              <VerdictBadge verdict={composite.passed ? "pass" : "fail"} />
            </div>
            <ScoreMeter
              score={composite.score}
              verdict={composite.passed ? "pass" : "fail"}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function GateSection({ run, config }: { run?: Run; config: RunConfig }) {
  const hardGates = EVAL_DEFS.filter((d) => d.hardGate);
  let latestComposite: { index: number; score: number; passed: boolean } | null =
    null;
  if (run) {
    for (let i = run.iterations.length - 1; i >= 0; i -= 1) {
      const c = run.iterations[i].composite;
      if (c) {
        latestComposite = {
          index: run.iterations[i].index,
          score: c.score,
          passed: c.passed,
        };
        break;
      }
    }
  }

  return (
    <>
      <section>
        <SectionTitle>Pass rule</SectionTitle>
        <p className="text-xs leading-relaxed text-muted">
          An attempt passes when the Overall score reaches{" "}
          {config.compositePassThreshold} or higher AND every must-pass check
          passes. Anything less writes the fixes into the next generation brief
          (up to {config.maxIterations} attempts), then goes to human review.
        </p>
      </section>

      {latestComposite ? (
        <section>
          <SectionTitle>Current overall score</SectionTitle>
          <ScoreMeter
            score={latestComposite.score}
            verdict={latestComposite.passed ? "pass" : "fail"}
          />
          <p className="mt-1 text-2xs text-faint">
            Attempt {latestComposite.index} ·{" "}
            {latestComposite.passed ? "passed" : "held back"} · needs{" "}
            {config.compositePassThreshold} to pass
          </p>
        </section>
      ) : null}

      <section>
        <SectionTitle>Must-pass checklist</SectionTitle>
        <div className="flex flex-col">
          {hardGates.map((d) => {
            const res = latestResultFor(run, d.id);
            return (
              <div
                key={d.id}
                className="flex items-center justify-between gap-2 border-b border-edge py-1.5 last:border-b-0"
              >
                <span className="text-xs text-muted">{d.name}</span>
                {res ? (
                  <VerdictBadge verdict={res.verdict} />
                ) : (
                  <span className="text-2xs text-faint">pending</span>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

/**
 * Still-tier approval gate ("anchor-gate" node). Deliberately NOT the
 * iteration gate's pass rule / composite / hard-gate checklist — this gate
 * approves the relit anchor frame at the image tier.
 */
function AnchorGateSection({ run }: { run?: Run }) {
  const current =
    run && run.iterations.length > 0
      ? run.iterations[run.iterations.length - 1]
      : undefined;
  const keyframe = current?.relitKeyframeDataUrl;

  return (
    <section>
      <SectionTitle>Approving the lighting photo</SectionTitle>
      <p className="text-xs leading-relaxed text-muted">
        The target lighting photo must pass the same-person, clothing, room, and
        skin checks before any video is generated — the cheap step happens first.
      </p>
      {keyframe ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={keyframe}
          alt="Relit anchor keyframe for the current iteration"
          className="mt-2 w-40 rounded-lg border border-edge"
        />
      ) : null}
    </section>
  );
}

export function NodeInspector({
  node,
  run,
  config,
  onClose,
}: {
  node: PipelineNode;
  run?: Run;
  config: RunConfig;
  onClose: () => void;
}) {
  const state = run?.nodeStates[node.id];

  return (
    <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-l border-edge bg-surface">
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-edge bg-surface px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge color={kindColor(node.kind)}>{node.kind}</Badge>
            {state ? (
              <span className="flex items-center gap-1.5 text-2xs text-faint">
                <StatusDot status={state.status} />
                {state.status}
              </span>
            ) : null}
          </div>
          <h3 className="mt-1.5 truncate text-sm font-semibold text-ink">
            {node.label}
          </h3>
        </div>
        <button
          onClick={onClose}
          aria-label="Close inspector"
          className="rounded-md border border-edge px-2 py-0.5 text-xs text-muted transition hover:border-faint hover:text-ink"
        >
          ×
        </button>
      </div>

      <div className="flex flex-col gap-5 px-4 py-4">
        <p className="text-xs leading-relaxed text-muted">{node.description}</p>
        {state?.detail ? (
          <p className="-mt-3 text-2xs text-faint">{state.detail}</p>
        ) : null}

        {node.kind === "evaluate" && node.evalId ? (
          <EvalSection evalId={node.evalId} run={run} />
        ) : null}
        {node.kind === "generate" ? (
          <GenerateSection node={node} run={run} />
        ) : null}
        {node.kind === "aggregate" ? <AggregateSection run={run} /> : null}
        {node.kind === "gate" && node.id === "gate" ? (
          <GateSection run={run} config={config} />
        ) : null}
        {node.kind === "gate" && node.id === "anchor-gate" ? (
          <AnchorGateSection run={run} />
        ) : null}
      </div>
    </aside>
  );
}
