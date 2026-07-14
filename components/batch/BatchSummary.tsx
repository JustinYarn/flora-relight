"use client";

/**
 * Aggregate header for one batch — the mission-control readout: throughput,
 * first-try pass rate, fallbacks, mean shipped quality, the eval gate that
 * hurt the most across the whole batch, and mean judge confidence.
 */

import type { ReactNode } from "react";
import {
  Badge,
  Card,
  ConfidenceMeter,
  ScoreMeter,
  SectionTitle,
} from "@/components/ui";
import { getEvalDef } from "@/lib/prompts/eval-defs";
import { formatUsd } from "@/lib/cost";
import type { Batch, BatchExecutionSummary, Run, Verdict } from "@/lib/types";

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-2xs uppercase tracking-[0.14em] text-faint">
        {label}
      </span>
      <span className="text-2xl font-semibold leading-none tabular-nums text-ink">
        {value}
      </span>
      {sub ?? null}
    </div>
  );
}

/** The composite the run would ship: best iteration first, else latest scored. */
function shippedComposite(run: Run): number | undefined {
  const best =
    run.bestIterationIndex !== undefined
      ? run.iterations.find((it) => it.index === run.bestIterationIndex)
      : undefined;
  if (best?.composite) return best.composite.score;
  return [...run.iterations].reverse().find((it) => it.composite)?.composite
    ?.score;
}

const TERMINAL: ReadonlyArray<Run["status"]> = [
  "awaiting-review",
  "approved",
  "needs-changes",
  "failed",
];

const BATCH_STATUS_META: Record<
  Batch["status"],
  { color: string; label: string }
> = {
  uploading: { color: "var(--running)", label: "preparing uploads" },
  ready: { color: "var(--borderline)", label: "uploaded · ready to start" },
  running: { color: "var(--running)", label: "working through the queue" },
  done: { color: "var(--pass)", label: "batch done" },
  failed: { color: "var(--fail)", label: "upload preparation failed" },
};

export function BatchSummary({
  batch,
  runs,
  execution,
  passThreshold,
}: {
  batch: Batch;
  runs: Run[];
  execution?: BatchExecutionSummary;
  passThreshold: number;
}) {
  const total = runs.length;
  const completed = runs.filter((r) => TERMINAL.includes(r.status)).length;

  const passFirstTry = runs.filter(
    (r) => r.iterations.find((it) => it.index === 1)?.composite?.passed === true
  ).length;

  const fallbacks = runs.filter((r) => r.fallback?.applied).length;

  const composites = runs
    .map(shippedComposite)
    .filter((s): s is number => s !== undefined);
  const meanComposite =
    composites.length > 0
      ? Math.round(
          (composites.reduce((a, b) => a + b, 0) / composites.length) * 10
        ) / 10
      : undefined;
  const meanVerdict: Verdict =
    meanComposite === undefined
      ? "fail"
      : meanComposite >= passThreshold
        ? "pass"
        : meanComposite >= passThreshold - 10
          ? "borderline"
          : "fail";

  // Worst gate: the hard-gate eval that failed the most iterations batch-wide.
  const gateFailCounts = new Map<string, number>();
  for (const run of runs) {
    for (const it of run.iterations) {
      for (const evalId of it.composite?.hardGateFailures ?? []) {
        gateFailCounts.set(evalId, (gateFailCounts.get(evalId) ?? 0) + 1);
      }
    }
  }
  let worstGate: { evalId: string; count: number } | undefined;
  gateFailCounts.forEach((count, evalId) => {
    if (!worstGate || count > worstGate.count) worstGate = { evalId, count };
  });

  const confidences = runs.flatMap((r) => {
    const latest = r.iterations[r.iterations.length - 1];
    return (latest?.evalResults ?? []).map((res) => res.confidence);
  });
  const meanConfidence =
    confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : undefined;

  // Est. live spend: sum of the member runs' pre-flight estimates. Budget-
  // skipped runs never start, so they carry no estimate and don't count.
  const estimatedSpendUsd = runs.reduce(
    (sum, r) => sum + (r.cost?.estimatedUsd ?? 0),
    0
  );
  const batchMeta = BATCH_STATUS_META[batch.status];

  if (execution) {
    const lamp = execution.workflowMode === "lamp";
    const count = (
      state: BatchExecutionSummary["members"][number]["state"]
    ): number =>
      execution.members.filter((member) => member.state === state).length;
    const awaitingMembers = execution.members.filter(
      (member) => member.state === "awaiting_review"
    );
    const runById = new Map(runs.map((run) => [run.id, run]));
    const graded = awaitingMembers.filter(
      (member) => runById.get(member.runId)?.humanGrade !== undefined
    ).length;
    const ready = awaitingMembers.length - graded;
    const skipped = count("skipped_budget");
    const failed = count("failed");
    const reconcile = count("reconcile_required");
    const queued = count("queued");
    const running = count("running");
    const approvalRequired = count("user_action_required");
    const settled = awaitingMembers.length + skipped + failed;
    const executionMeta =
      execution.status === "done"
        ? { color: "var(--pass)", label: "batch settled" }
        : execution.status === "failed"
          ? { color: "var(--borderline)", label: "needs reconciliation" }
          : execution.status === "user_action_required"
            ? { color: "var(--borderline)", label: "approval required" }
            : {
                color: "var(--running)",
                label: lamp ? "running Lamp two-pass" : "generating Flora cuts",
              };

    return (
      <Card className="p-5">
        <SectionTitle
          right={
            <Badge color={executionMeta.color}>
              {executionMeta.label}
              {execution.status === "running"
                ? ` · ${execution.concurrency} at a time`
                : ""}
            </Badge>
          }
        >
          {batch.name}
        </SectionTitle>
        <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-4 xl:grid-cols-7">
          <Stat
            label="Settled clips"
            value={
              <>
                {settled}
                <span className="text-base font-normal text-faint">
                  /{execution.members.length}
                </span>
              </>
            }
            sub={
              <span className="text-2xs text-faint">
                {running} running · {queued} queued
                {approvalRequired > 0 ? ` · ${approvalRequired} paused` : ""}
              </span>
            }
          />
          <Stat
            label="Ready to grade"
            value={ready}
            sub={
              <span className="text-2xs text-faint">
                {lamp ? "blind Lamp Finals" : "canonical Flora cuts"}
              </span>
            }
          />
          <Stat
            label="Human grades"
            value={graded}
            sub={<span className="text-2xs text-faint">saved responses</span>}
          />
          <Stat
            label="Skipped by cap"
            value={skipped}
            sub={<span className="text-2xs text-faint">no provider call</span>}
          />
          <Stat
            label="Needs attention"
            value={failed + reconcile}
            sub={
              <span className="text-2xs text-faint">
                {reconcile} awaiting reconciliation
              </span>
            }
          />
          <Stat
            label="Confirmed spend"
            value={formatUsd(execution.settledMicros / 1_000_000)}
            sub={
              <span className="text-2xs tabular-nums text-faint">
                {formatUsd(execution.reservedMicros / 1_000_000)} reserved · {formatUsd(execution.budgetLimitMicros / 1_000_000)} cap
              </span>
            }
          />
          <Stat
            label="Quality checks"
            value="—"
            sub={<span className="text-2xs text-faint">human grading only</span>}
          />
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <SectionTitle
        right={
          <Badge
            color={batchMeta.color}
          >
            {batchMeta.label}
            {batch.status === "running"
              ? ` · ${batch.concurrency} at a time`
              : ""}
          </Badge>
        }
      >
        {batch.name}
      </SectionTitle>
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-4 xl:grid-cols-7">
        <Stat
          label="Clips"
          value={
            <>
              {completed}
              <span className="text-base font-normal text-faint">/{total}</span>
            </>
          }
          sub={<span className="text-2xs text-faint">completed</span>}
        />
        <Stat
          label="Pass first try"
          value={passFirstTry}
          sub={<span className="text-2xs text-faint">first attempt clean</span>}
        />
        <Stat
          label="Safe fallbacks"
          value={
            <span className={fallbacks > 0 ? "text-borderline" : undefined}>
              {fallbacks}
            </span>
          }
          sub={
            <span
              className="text-2xs text-faint"
              title="safe fallback (lighting copied onto original pixels via color transfer)"
            >
              lighting copied onto original
            </span>
          }
        />
        <Stat
          label="Average score"
          value={meanComposite ?? "—"}
          sub={
            meanComposite !== undefined ? (
              <ScoreMeter score={meanComposite} verdict={meanVerdict} />
            ) : (
              <span className="text-2xs text-faint">no scores yet</span>
            )
          }
        />
        <div className="flex flex-col gap-1.5">
          <span
            className="text-2xs uppercase tracking-[0.14em] text-faint"
            title="the must-pass check that failed most often across the batch"
          >
            Most common failure
          </span>
          {worstGate ? (
            <>
              <span className="text-sm font-semibold leading-snug text-ink">
                {getEvalDef(worstGate.evalId).name}
              </span>
              <span className="text-2xs text-faint">
                failed {worstGate.count}× across the batch
              </span>
            </>
          ) : (
            <span className="text-2xl font-semibold leading-none text-ink">—</span>
          )}
        </div>
        <Stat
          label="Est. live spend"
          value={
            <span
              title="What this batch would cost against live APIs — mock mode spends $0"
            >
              {formatUsd(estimatedSpendUsd)}
            </span>
          }
          sub={
            <span className="text-2xs tabular-nums text-faint">
              actual in mock: $0.00
              {batch.budgetUsd !== undefined
                ? ` · cap ${formatUsd(batch.budgetUsd)}`
                : ""}
            </span>
          }
        />
        <Stat
          label="Average confidence"
          value={
            meanConfidence !== undefined
              ? `${Math.round(meanConfidence * 100)}%`
              : "—"
          }
          sub={
            meanConfidence !== undefined ? (
              <ConfidenceMeter confidence={meanConfidence} />
            ) : (
              <span className="text-2xs text-faint">no evals yet</span>
            )
          }
        />
      </div>
    </Card>
  );
}
