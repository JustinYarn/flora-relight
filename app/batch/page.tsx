"use client";

/**
 * Batch review board — the mass-automation face of the tool. Point the
 * pipeline at N clips, get a live mission-control grid: a bounded worker
 * queue (concurrency 2 — real Omni calls are rate-limited) drains the runs
 * while every card updates in place, and finished clips park here as a
 * review queue with inline approve.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAppStore } from "@/lib/store";
import { formatClock } from "@/lib/util";
import { BatchRunCard } from "@/components/batch/BatchRunCard";
import { BatchSummary } from "@/components/batch/BatchSummary";
import {
  Button,
  Card,
  EmptyState,
  SectionTitle,
  StatusDot,
} from "@/components/ui";
import type { Run } from "@/lib/types";

export default function BatchPage() {
  const batches = useAppStore((s) => s.batches);
  const runs = useAppStore((s) => s.runs);
  const submitReview = useAppStore((s) => s.submitReview);
  const workflow = useAppStore((s) => s.workflow);

  // null = follow the newest batch automatically; an id pins the view.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const batch = batches.find((b) => b.id === selectedId) ?? batches[0];

  const batchRuns = useMemo(() => {
    if (!batch) return [] as Run[];
    return batch.runIds
      .map((id) => runs.find((r) => r.id === id))
      .filter((r): r is Run => r !== undefined);
  }, [batch, runs]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Batch runs</h1>
          <p className="mt-1 max-w-xl text-2xs leading-relaxed text-faint">
            Point the pipeline at many clips at once. Runs go through a small
            queue — a couple at a time, the same shape as real rate limits —
            and land here for you to review.
          </p>
        </div>
      </header>

      {!batch ? (
        <EmptyState
          title="No batches yet"
          hint="Upload clips in Studio — drop several at once to launch a batch. Runs drain through the worker queue two at a time, then park here for you to review."
          action={
            <Link href="/">
              <Button>Go to Studio</Button>
            </Link>
          }
        />
      ) : (
        <>
          {batches.length > 1 ? (
            <div className="flex flex-wrap gap-2">
              {batches.map((b) => {
                const active = b.id === batch.id;
                return (
                  <button
                    key={b.id}
                    onClick={() => setSelectedId(b.id)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                      active
                        ? "border-accent bg-accent-soft text-ink"
                        : "border-edge bg-surface text-muted hover:border-faint hover:text-ink"
                    }`}
                  >
                    <StatusDot
                      status={b.status === "running" ? "running" : "succeeded"}
                    />
                    <span>{b.name}</span>
                    <span className="tabular-nums text-faint">
                      {formatClock(b.createdAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <BatchSummary
            batch={batch}
            runs={batchRuns}
            passThreshold={workflow.config.compositePassThreshold}
          />

          <Card className="p-5">
            <SectionTitle
              right={
                <span className="text-2xs tabular-nums text-faint">
                  {batchRuns.length} {batchRuns.length === 1 ? "clip" : "clips"}{" "}
                  · {batch.concurrency} worker slots
                </span>
              }
            >
              Clips
            </SectionTitle>
            {batchRuns.length === 0 ? (
              <EmptyState
                title="This batch has no runs"
                hint="Its runs may have been deleted. Upload clips in Studio — drop several at once — to launch a fresh batch."
              />
            ) : (
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
                {batchRuns.map((run) => (
                  <BatchRunCard
                    key={run.id}
                    run={run}
                    maxIterations={workflow.config.maxIterations}
                    passThreshold={workflow.config.compositePassThreshold}
                    onApprove={(runId) => submitReview(runId, "approved", "")}
                  />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
