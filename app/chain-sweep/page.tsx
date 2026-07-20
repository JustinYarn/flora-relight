"use client";

/**
 * Chain sweep board — the ordering-experiment face of Combined V2.
 *
 * A sweep is not a batch: chain runs stay single-clip and individually
 * plan-approved (one explicit spend click per run, per the no-silent-approval
 * law). This board groups every chain run by its source clip so order
 * variants sit side by side, launches new variants of an existing clip, and
 * once detached report cards land, lines their final-stage scores and
 * per-stage composite trajectories up for comparison.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAppStore } from "@/lib/store";
import { formatUsd } from "@/lib/cost";
import {
  defaultLampChainStageOrder,
  lampChainEnabledStages,
  type LampChainStage,
} from "@/lib/lamp-chain";
import { LAMP_CHAIN_EVAL_IDS } from "@/lib/lamp-chain-evaluation";
import { runWorkflowMode } from "@/lib/workflow-mode";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  SectionTitle,
  StatusDot,
} from "@/components/ui";
import type { Run } from "@/lib/types";

const STAGE_SHORT: Record<LampChainStage, string> = {
  background: "BG",
  lamp: "LAMP",
  beautify: "BTY",
  iris: "IRIS",
};

function orderLabel(order: readonly LampChainStage[] | undefined): string {
  if (!order || order.length === 0) return "order unknown";
  return order.map((stage) => STAGE_SHORT[stage]).join(" → ");
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) out.push([item, ...tail]);
  });
  return out;
}

interface ChainProjectionStage {
  stage: number;
  status?: string;
  videoUrl?: string;
  artifact?: {
    stage: number;
    evalResults: Array<{
      evalId: string;
      score: number;
      verdict: string;
      deltaFromPrevious?: number;
    }>;
  };
}

function projectionStages(run: Run): ChainProjectionStage[] {
  const projected = (
    run as Run & { chainExecution?: { stages?: ChainProjectionStage[] } }
  ).chainExecution?.stages;
  if (Array.isArray(projected) && projected.length > 0) return projected;
  // Mock runs carry their detached report card on the iterations directly.
  return run.iterations.map((iteration) => ({
    stage: iteration.index,
    status:
      iteration.evalResults.length > 0
        ? "completed"
        : iteration.generatedVideo
          ? "pending"
          : "not-started",
    artifact:
      iteration.evalResults.length > 0
        ? {
            stage: iteration.index,
            evalResults: iteration.evalResults.map((result) => ({
              evalId: result.evalId,
              score: result.score,
              verdict: result.verdict,
              ...(result.deltaFromPrevious !== undefined
                ? { deltaFromPrevious: result.deltaFromPrevious }
                : {}),
            })),
          }
        : undefined,
  }));
}

function runOrder(run: Run): LampChainStage[] | undefined {
  return run.chainControls?.stageOrder ?? run.chainPlan?.stageOrder;
}

function runStatusLine(run: Run): { label: string; tone: "ok" | "busy" | "warn" } {
  const execution = run.serverExecution;
  const order = runOrder(run);
  const stageCount = order?.length ?? 0;
  if (run.chainPlan && run.chainPlan.aggregate.approval.status === "draft") {
    return { label: "plan review — approve to spend", tone: "warn" };
  }
  if (execution) {
    if (execution.status === "awaiting_review") {
      return { label: "delivered — report card detached", tone: "ok" };
    }
    if (execution.status === "user_action_required") {
      return { label: "paused — approval renewal needed", tone: "warn" };
    }
    if (execution.status === "reconcile_required") {
      return { label: "reconcile required", tone: "warn" };
    }
    if (execution.status === "failed") return { label: "failed", tone: "warn" };
    if (execution.status === "running") {
      return {
        label: `generating stage ${Math.max(1, execution.iteration)}/${stageCount || "?"}`,
        tone: "busy",
      };
    }
    return { label: execution.status, tone: "busy" };
  }
  if (run.status === "awaiting-review" || run.status === "approved") {
    return { label: "delivered — report card detached", tone: "ok" };
  }
  if (run.status === "failed") return { label: "failed", tone: "warn" };
  if (run.status === "running") return { label: "running", tone: "busy" };
  return { label: run.status, tone: "busy" };
}

function stageComposites(run: Run): Array<number | null> {
  const order = runOrder(run) ?? [];
  const stages = projectionStages(run);
  return order.map((_, index) => {
    const fromIteration = run.iterations.find(
      (iteration) => iteration.index === index + 1
    )?.composite?.score;
    if (fromIteration !== undefined) return fromIteration;
    const artifact = stages.find((stage) => stage.stage === index + 1)?.artifact;
    if (!artifact) return null;
    const scores = artifact.evalResults.map((result) => result.score);
    if (scores.length === 0) return null;
    return (
      Math.round(
        (scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10
      ) / 10
    );
  });
}

export default function ChainSweepPage() {
  const runs = useAppStore((s) => s.runs);
  const startRun = useAppStore((s) => s.startRun);
  const hydrated = useAppStore((s) => s.hydrated);
  const mode = useAppStore((s) => s.mode);
  const [launchingKey, setLaunchingKey] = useState<string | null>(null);
  const [variantOrder, setVariantOrder] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const chainRuns = useMemo(
    () => runs.filter((run) => runWorkflowMode(run) === "chain"),
    [runs]
  );

  const groups = useMemo(() => {
    const byClip = new Map<string, Run[]>();
    for (const run of chainRuns) {
      const key = `${run.originalVideo.label}·${run.originalVideo.durationSec.toFixed(2)}`;
      byClip.set(key, [...(byClip.get(key) ?? []), run]);
    }
    return [...byClip.entries()]
      .map(([key, members]) => ({
        key,
        label: members[0]!.originalVideo.label,
        members: members.sort((a, b) => a.createdAt - b.createdAt),
      }))
      .sort(
        (a, b) =>
          (b.members[b.members.length - 1]?.createdAt ?? 0) -
          (a.members[a.members.length - 1]?.createdAt ?? 0)
      );
  }, [chainRuns]);

  const totals = useMemo(() => {
    let estimated = 0;
    let actual = 0;
    for (const run of chainRuns) {
      estimated += run.cost?.estimatedUsd ?? 0;
      actual += run.cost?.actualUsd ?? 0;
    }
    return { estimated, actual };
  }, [chainRuns]);

  const launchVariant = async (group: { key: string; members: Run[] }) => {
    const seed = group.members[0]!;
    const controlsSeed = seed.chainControls;
    if (!controlsSeed) {
      setNotice("This clip's chain controls are missing; start it from Create.");
      return;
    }
    const enabled = lampChainEnabledStages(controlsSeed);
    const selection = variantOrder[group.key];
    const order = selection
      ? (selection.split(",") as LampChainStage[])
      : defaultLampChainStageOrder(controlsSeed);
    const alreadyRan = group.members.some(
      (member) => orderLabel(runOrder(member)) === orderLabel(order)
    );
    setLaunchingKey(group.key);
    setNotice(null);
    try {
      // A fresh run re-ingests the same stored clip: the asset keeps its
      // media URL while the reserved run id is dropped so the server mints a
      // new run around the identical source bytes.
      const { runId: _seedRunId, ...video } = seed.originalVideo;
      await startRun(video, {
        workflowMode: "chain",
        relightIntensity: seed.relightIntensity,
        chainControls: { ...controlsSeed, stageOrder: order },
      });
      setNotice(
        alreadyRan
          ? `Launched a repeat of ${orderLabel(order)} (repeat runs measure judge noise).`
          : `Launched order variant ${orderLabel(order)}. Approve its plan to spend.`
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Variant launch failed."
      );
    } finally {
      setLaunchingKey(null);
    }
    void enabled;
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionTitle>Chain sweep — ordering experiment</SectionTitle>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Combined V2 runs grouped by clip. Each run is one stage order;
            every run keeps its own plan review and explicit spend click.
            Delivery never waits for the report card — scores attach here as
            the detached measurements land.
          </p>
        </div>
        <div className="text-right text-sm">
          <div className="text-muted">
            Sweep spend — estimated {formatUsd(totals.estimated)}
          </div>
          <div className="text-ink">actual {formatUsd(totals.actual)}</div>
          <div className="text-2xs uppercase tracking-wide text-faint">
            {mode === "mock" ? "mock mode — $0 real spend" : "live mode"}
          </div>
        </div>
      </div>

      {notice ? (
        <Card className="border-accent/40 p-3 text-sm text-ink">{notice}</Card>
      ) : null}

      {!hydrated ? (
        <EmptyState title="Loading runs…" />
      ) : groups.length === 0 ? (
        <EmptyState
          title="No chain runs yet"
          hint='Start one from Create with the "Chain" method, then come back here to compare stage orders on the same clip.'
        />
      ) : (
        groups.map((group) => {
          const seedControls = group.members[0]!.chainControls;
          const enabled = seedControls
            ? lampChainEnabledStages(seedControls)
            : [];
          const orderChoices = enabled.length > 0 ? permutations(enabled) : [];
          return (
            <Card key={group.key} className="flex flex-col gap-4 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <SectionTitle>{group.label}</SectionTitle>
                  <Badge>{group.members.length} variant{group.members.length === 1 ? "" : "s"}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    className="rounded border border-edge bg-transparent px-2 py-1 text-xs text-ink"
                    value={
                      variantOrder[group.key] ??
                      (seedControls
                        ? defaultLampChainStageOrder(seedControls).join(",")
                        : "")
                    }
                    onChange={(event) =>
                      setVariantOrder((prev) => ({
                        ...prev,
                        [group.key]: event.target.value,
                      }))
                    }
                  >
                    {orderChoices.map((order) => (
                      <option key={order.join(",")} value={order.join(",")}>
                        {orderLabel(order)}
                      </option>
                    ))}
                  </select>
                  <Button
                    onClick={() => void launchVariant(group)}
                    disabled={launchingKey === group.key || !seedControls}
                  >
                    {launchingKey === group.key
                      ? "Launching…"
                      : "Run this order"}
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                {group.members.map((run) => {
                  const status = runStatusLine(run);
                  const order = runOrder(run);
                  const composites = stageComposites(run);
                  const attached = composites.filter(
                    (value) => value !== null
                  ).length;
                  return (
                    <div
                      key={run.id}
                      className="flex flex-col gap-2 rounded border border-edge p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          href={`/runs/${run.id}`}
                          className="font-mono text-xs text-accent hover:underline"
                        >
                          {run.id}
                        </Link>
                        <div className="flex items-center gap-2 text-xs">
                          <StatusDot
                            status={
                              status.tone === "ok"
                                ? "succeeded"
                                : status.tone === "warn"
                                  ? "failed"
                                  : "running"
                            }
                          />
                          <span className="text-muted">{status.label}</span>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <Badge>{orderLabel(order)}</Badge>
                        <span className="text-faint">
                          report card {attached}/{order?.length ?? 0} stages
                        </span>
                        <span className="text-faint">
                          {formatUsd(run.cost?.actualUsd ?? 0)} actual ·{" "}
                          {formatUsd(run.cost?.estimatedUsd ?? 0)} est
                        </span>
                      </div>
                      <div className="flex items-center gap-1 text-2xs text-muted">
                        {composites.map((score, index) => (
                          <span
                            key={index}
                            className={`rounded px-1.5 py-0.5 ${
                              score === null
                                ? "border border-dashed border-edge text-faint"
                                : "border border-edge text-ink"
                            }`}
                            title={`stage ${index + 1} composite`}
                          >
                            S{index + 1}{" "}
                            {score === null ? "…" : score.toFixed(1)}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              <FinalScoreMatrix members={group.members} />
            </Card>
          );
        })
      )}
    </main>
  );
}

/** Final-stage per-eval scores, order variants side by side. */
function FinalScoreMatrix({ members }: { members: Run[] }) {
  const columns = members
    .map((run) => {
      const order = runOrder(run);
      if (!order) return null;
      const stages = projectionStages(run);
      const finalArtifact = stages.find(
        (stage) => stage.stage === order.length
      )?.artifact;
      if (!finalArtifact) return null;
      return { run, order, finalArtifact };
    })
    .filter(
      (
        column
      ): column is {
        run: Run;
        order: LampChainStage[];
        finalArtifact: NonNullable<ChainProjectionStage["artifact"]>;
      } => column !== null
    );
  if (columns.length === 0) {
    return (
      <p className="text-2xs text-faint">
        Final-stage score matrix appears once at least one variant&apos;s
        detached report card has fully landed.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-xs">
        <thead>
          <tr className="text-2xs uppercase tracking-wide text-faint">
            <th className="py-1 pr-3">Final-stage eval</th>
            {columns.map((column) => (
              <th key={column.run.id} className="py-1 pr-3">
                {orderLabel(column.order)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {LAMP_CHAIN_EVAL_IDS.map((evalId) => (
            <tr key={evalId} className="border-t border-edge/60">
              <td className="py-1 pr-3 text-muted">{evalId}</td>
              {columns.map((column) => {
                const result = column.finalArtifact.evalResults.find(
                  (entry) => entry.evalId === evalId
                );
                return (
                  <td key={column.run.id} className="py-1 pr-3">
                    {result ? (
                      <span
                        className={
                          result.verdict === "pass"
                            ? "text-ink"
                            : result.verdict === "borderline"
                              ? "text-amber-400"
                              : "text-red-400"
                        }
                      >
                        {result.score.toFixed(0)}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
