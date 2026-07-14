"use client";

/**
 * Batch review board — the mass-automation face of the tool. Point the
 * pipeline at N clips, get a live mission-control grid: durable server-owned
 * first cuts use a bounded Workflow queue, while the no-spend mock keeps its
 * browser queue. Finished clips park here as a human review queue.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { isBatchQueueActive, useAppStore } from "@/lib/store";
import { summarizeBatchRecovery } from "@/lib/batch-recovery";
import { useBatchExecution } from "@/lib/useBatchExecution";
import { formatClock } from "@/lib/util";
import { BatchRunCard } from "@/components/batch/BatchRunCard";
import { BatchSummary } from "@/components/batch/BatchSummary";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  SectionTitle,
  StatusDot,
} from "@/components/ui";
import type { Run } from "@/lib/types";
import { workflowModeLabel } from "@/lib/workflow-mode";

export default function BatchPage() {
  const batches = useAppStore((s) => s.batches);
  const batchExecutions = useAppStore((s) => s.batchExecutions);
  const runs = useAppStore((s) => s.runs);
  const submitReview = useAppStore((s) => s.submitReview);
  const resumeBatch = useAppStore((s) => s.resumeBatch);
  const startBatchFromDraft = useAppStore((s) => s.startBatchFromDraft);
  const workflow = useAppStore((s) => s.workflow);
  const hydrated = useAppStore((s) => s.hydrated);
  const mode = useAppStore((s) => s.mode);

  // null = follow the newest batch automatically; an id pins the view.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [resumeNotice, setResumeNotice] = useState<{
    batchId: string;
    error: boolean;
    message: string;
  } | null>(null);
  const batch = batches.find((b) => b.id === selectedId) ?? batches[0];
  const execution = useBatchExecution(batch?.id);
  const serverOwned = execution !== undefined;

  const batchRuns = useMemo(() => {
    if (!batch) return [] as Run[];
    return batch.runIds
      .map((id) => runs.find((r) => r.id === id))
      .filter((r): r is Run => r !== undefined);
  }, [batch, runs]);

  const recovery = useMemo(
    () => (batch ? summarizeBatchRecovery(batch, batchRuns) : null),
    [batch, batchRuns]
  );
  const queueActive = batch ? isBatchQueueActive(batch.id) : false;
  const memberByRunId = useMemo(
    () => new Map(execution?.members.map((member) => [member.runId, member]) ?? []),
    [execution]
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Batch runs</h1>
          <p className="mt-1 max-w-xl text-2xs leading-relaxed text-faint">
            Send many clips through a bounded server queue. Flora delivers one
            review-ready cut per source; Lamp completes its exact two-pass method
            before each Final enters per-video grading.
          </p>
        </div>
      </header>

      {!batch ? (
        <EmptyState
          title="No batches yet"
          hint="Choose multiple videos on Create, select Flora or Lamp, then review the batch cost before launch."
          action={
            <Link href="/">
              <Button>Go to Create</Button>
            </Link>
          }
        />
      ) : (
        <>
          {batches.length > 1 ? (
            <div className="flex flex-wrap gap-2">
              {batches.map((b) => {
                const active = b.id === batch.id;
                const tabExecution = batchExecutions[b.id];
                return (
                  <button
                    key={b.id}
                    onClick={() => setSelectedId(b.id)}
                    className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-[transform,color,background-color,border-color] duration-150 ease-out active:scale-[0.96] ${
                      active
                        ? "border-accent bg-accent-soft text-ink"
                        : "border-edge bg-surface text-muted hover:border-faint hover:text-ink"
                    }`}
                  >
                    <StatusDot
                      status={
                        tabExecution?.status === "queued" ||
                        tabExecution?.status === "running" ||
                        b.status === "uploading" ||
                        b.status === "running"
                          ? "running"
                          : tabExecution?.status === "failed" || b.status === "failed"
                            ? "failed"
                            : "succeeded"
                      }
                    />
                    <span>{b.name}</span>
                    <Badge color={b.workflowMode === "lamp" ? "var(--accent)" : "var(--muted)"}>
                      {workflowModeLabel(b.workflowMode ?? "flora")}
                    </Badge>
                    <span className="tabular-nums text-faint">
                      {formatClock(b.createdAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {hydrated &&
          batch.status === "running" &&
          recovery &&
          !queueActive ? (
            <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-ink">
                  {execution?.status === "user_action_required"
                    ? "Lamp batch paused for renewed approval"
                    : serverOwned && recovery.queued > 0
                    ? execution?.status === "failed"
                      ? "Batch stopped with an item needing attention"
                      : execution?.status === "queued"
                        ? "Saved batch is waiting for server dispatch"
                      : "Server-owned batch is saved"
                    : recovery.queued > 0
                    ? "Saved queue can be resumed"
                    : "Already-started clips are protected"}
                </p>
                <p className="mt-1 max-w-3xl text-2xs leading-relaxed text-faint">
                  {execution?.status === "user_action_required"
                    ? "The original approval window expired before every Final was complete. Confirm again to continue only the paused clips from their existing provider journals; completed work will not be billed twice."
                    : recovery.queued > 0
                    ? serverOwned
                      ? `${recovery.queued} ${recovery.queued === 1 ? "clip is" : "clips are"} saved in the durable queue. The server dispatches at most ${batch.concurrency} at a time, and this tab can close without pausing or replaying paid work.`
                      : `${recovery.queued} untouched ${recovery.queued === 1 ? "clip is" : "clips are"} still saved and waiting. Resume starts only those mock queue entries.`
                    : "There are no untouched queue entries to restart."}
                  {recovery.protected > 0
                    ? ` ${recovery.protected} already-started ${recovery.protected === 1 ? "clip is" : "clips are"} protected from replay.`
                    : ""}
                  {recovery.missing > 0
                    ? ` ${recovery.missing} referenced ${recovery.missing === 1 ? "run is" : "runs are"} missing and cannot be resumed.`
                    : ""}
                  {serverOwned && execution?.status === "queued"
                    ? " Retrying uses the same confirmed immutable plan; it does not widen the approved Lamp or Flora method."
                    : ""}
                </p>
                {resumeNotice?.batchId === batch.id ? (
                  <p
                    className={`mt-2 text-2xs ${resumeNotice.error ? "text-fail" : "text-muted"}`}
                  >
                    {resumeNotice.message}
                  </p>
                ) : null}
              </div>
              {serverOwned && execution?.status === "user_action_required" ? (
                <Button
                  disabled={resumingId === batch.id}
                  onClick={() => {
                    setResumingId(batch.id);
                    setResumeNotice(null);
                    void startBatchFromDraft(batch.id, {
                      // A fresh, explicit approval epoch is required before a
                      // paused Lamp child may start its remaining paid step.
                      approveLiveSpend: true,
                    })
                      .then(() => {
                        setResumeNotice({
                          batchId: batch.id,
                          error: false,
                          message:
                            "Lamp was re-approved. Paused clips will continue from their existing durable journals without replaying completed paid work.",
                        });
                      })
                      .catch((error: unknown) => {
                        setResumeNotice({
                          batchId: batch.id,
                          error: true,
                          message:
                            error instanceof Error
                              ? error.message
                              : "The Lamp batch approval could not be renewed.",
                        });
                      })
                      .finally(() => setResumingId(null));
                  }}
                >
                  {resumingId === batch.id
                    ? "Renewing approval…"
                    : "Renew Lamp approval"}
                </Button>
              ) : serverOwned && execution?.status === "queued" ? (
                <Button
                  disabled={resumingId === batch.id}
                  onClick={() => {
                    setResumingId(batch.id);
                    setResumeNotice(null);
                    void startBatchFromDraft(batch.id, {
                      // This is an explicit retry of the already-confirmed,
                      // immutable first-cut plan. The route reuses its durable
                      // approvals and exactly-once child execution claims.
                      approveLiveSpend: true,
                    })
                      .then(() => {
                        setResumeNotice({
                          batchId: batch.id,
                          error: false,
                          message:
                            "The saved server dispatch was submitted again. Existing execution claims prevent duplicate provider work.",
                        });
                      })
                      .catch((error: unknown) => {
                        setResumeNotice({
                          batchId: batch.id,
                          error: true,
                          message:
                            error instanceof Error
                              ? error.message
                              : "The saved server dispatch could not be retried.",
                        });
                      })
                      .finally(() => setResumingId(null));
                  }}
                >
                  {resumingId === batch.id
                    ? "Retrying dispatch…"
                    : "Retry confirmed dispatch"}
                </Button>
              ) : recovery.queued > 0 && !serverOwned && mode === "mock" ? (
                <Button
                  disabled={resumingId === batch.id}
                  onClick={() => {
                    setResumingId(batch.id);
                    setResumeNotice(null);
                    void resumeBatch(batch.id)
                      .then((result) => {
                        setResumeNotice({
                          batchId: batch.id,
                          error: false,
                          message: result.alreadyActive
                            ? "This queue is already active in this tab."
                            : `Recovery started for ${result.resumed} saved ${result.resumed === 1 ? "clip" : "clips"}. Keep this tab open while the browser-owned checks finish.`,
                        });
                      })
                      .catch((error: unknown) => {
                        setResumeNotice({
                          batchId: batch.id,
                          error: true,
                          message:
                            error instanceof Error
                              ? error.message
                              : "The saved queue could not be resumed.",
                        });
                      })
                      .finally(() => setResumingId(null));
                  }}
                >
                  {resumingId === batch.id
                    ? "Resuming…"
                    : `Resume ${recovery.queued} saved ${recovery.queued === 1 ? "clip" : "clips"}`}
                </Button>
              ) : null}
            </Card>
          ) : null}

          <BatchSummary
            batch={batch}
            runs={batchRuns}
            execution={execution}
            passThreshold={workflow.config.compositePassThreshold}
          />

          <Card className="p-5">
            <SectionTitle
              right={
                <span className="text-2xs tabular-nums text-faint">
                  {batchRuns.length} {batchRuns.length === 1 ? "clip" : "clips"}{" "}
                  · {batch.concurrency} {serverOwned ? "server" : "worker"} slots
                </span>
              }
            >
              Clips
            </SectionTitle>
            {batchRuns.length === 0 ? (
              <EmptyState
                title={
                  batch.status === "ready"
                    ? "Uploads ready to launch"
                    : batch.status === "uploading"
                      ? "Uploads are still being prepared"
                      : "This batch has no runs"
                }
                hint={
                  batch.status === "ready"
                    ? "Return to Create to review this prepared mock batch without uploading again."
                    : batch.status === "uploading"
                      ? "If the upload tab was interrupted, return to Create to inspect or restart the unfinished selection."
                      : "Its runs may have been deleted. Return to Create to prepare another mock batch."
                }
                action={
                  batch.status === "ready" || batch.status === "uploading" ? (
                    <Link href="/">
                      <Button>Return to Create</Button>
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
                {batchRuns.map((run) => (
                  <BatchRunCard
                    key={run.id}
                    run={run}
                    member={memberByRunId.get(run.id)}
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
