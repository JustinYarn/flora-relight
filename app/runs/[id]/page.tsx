"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAppStore } from "@/lib/store";
import { useRunDetails } from "@/lib/useRunDetails";
import type { Iteration, Run, RunStatus } from "@/lib/types";
import { isLampRun } from "@/lib/lamp-evaluation";
import { isLampBackgroundRun } from "@/lib/lamp-background-read";
import { workflowForMode } from "@/lib/workflow-def";
import { runWorkflowMode } from "@/lib/workflow-mode";
import { Badge, EmptyState } from "@/components/ui";
import { DownloadSideBySide } from "@/components/review/DownloadSideBySide";
import { RunTabs } from "@/components/review/RunTabs";
import { HeroComparison } from "@/components/review/HeroComparison";
import {
  GenerationTheater,
  evalPhaseReached,
} from "@/components/review/GenerationTheater";
import { VerdictLine } from "@/components/review/VerdictLine";
import { AttemptSwitcher } from "@/components/review/AttemptSwitcher";
import { EvalList } from "@/components/review/EvalList";
import { ReviewActions } from "@/components/review/ReviewActions";
import { LostGenerationRecovery } from "@/components/review/LostGenerationRecovery";
import { WorkflowRail } from "@/components/review/WorkflowRail";
import { evalDefsForRun } from "@/lib/lamp-evaluation";
import { BackgroundPlanReview } from "@/components/review/BackgroundPlanReview";
import { BeautifyPlanReview } from "@/components/review/BeautifyPlanReview";

const STATUS_COLOR: Record<RunStatus, string> = {
  running: "var(--running)",
  "awaiting-review": "var(--borderline)",
  approved: "var(--pass)",
  "needs-changes": "var(--fail)",
  failed: "var(--fail)",
};

const STATUS_LABEL: Record<RunStatus, string> = {
  running: "running",
  "awaiting-review": "needs your review",
  approved: "approved",
  "needs-changes": "needs changes",
  failed: "failed",
};

/** Resolve the evaluation attached to the delivered artifact for either workflow. */
function finalIteration(run: Run): Iteration | undefined {
  const last = run.iterations[run.iterations.length - 1];
  if (isLampRun(run) || isLampBackgroundRun(run)) {
    return run.iterations.find((iteration) => iteration.index === 2) ?? last;
  }

  const bestIndex = run.bestIterationIndex;
  if (bestIndex === undefined) return last;
  return (
    run.iterations.find((iteration) => iteration.index === bestIndex) ??
    run.iterations[bestIndex] ??
    last
  );
}

/**
 * The Review page: two videos + workflow-scoped eval rows. Everything else — prompt
 * evolution, frames, log, pipeline detail — lives one click away in Journey.
 */
export default function RunReviewPage() {
  const params = useParams<{ id: string }>();
  const run = useRunDetails(params.id);
  const submitReview = useAppStore((s) => s.submitReview);
  // null = follow the newest attempt automatically; a string pins the view.
  const [userSelected, setUserSelected] = useState<string | null>(null);

  if (!run) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <EmptyState
          title="Run not found"
          hint="This run may have been deleted, or its id is wrong. Head back to Create to pick an existing run or upload a new clip."
          action={
            <Link
              href="/"
              className="mt-1 inline-flex min-h-10 items-center rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition-[transform,border-color] duration-150 ease-out hover:border-faint active:scale-[0.96]"
            >
              Back to Create
            </Link>
          }
        />
      </main>
    );
  }

  const workflow = workflowForMode(runWorkflowMode(run));
  const latest = run.iterations[run.iterations.length - 1];
  const lampRun = isLampRun(run);
  const backgroundRun = isLampBackgroundRun(run);
  const twoPassRun = lampRun || backgroundRun;
  const backgroundNoOp =
    backgroundRun &&
    run.backgroundCleanupPlan?.approval.status === "approved" &&
    run.backgroundCleanupPlan.decision === "exceptional-no-op";
  const planAwaitingApproval =
    backgroundRun && run.backgroundCleanupPlan?.approval.status === "draft";
  // Default to the delivered v2 final; mid-flight, follow the newest stage.
  const autoKey = run.finalVideo ? "final" : latest ? `iter-${latest.index}` : null;
  const activeKey = userSelected ?? autoKey;
  const isFinal = activeKey === "final" && Boolean(run.finalVideo);

  const selectedIteration: Iteration | undefined = isFinal
    ? finalIteration(run)
    : (run.iterations.find((it) => `iter-${it.index}` === activeKey) ?? latest);

  const relitVideo = isFinal ? run.finalVideo : selectedIteration?.generatedVideo;
  const relitLabel = isFinal
    ? backgroundNoOp
      ? "EXACT SOURCE · APPROVED NO-OP"
      : `${twoPassRun ? "FINAL VIDEO" : "FLORA VIDEO"}${selectedIteration ? ` · v${selectedIteration.index}` : ""}`
    : selectedIteration
      ? twoPassRun && selectedIteration.index === 1
        ? "INITIAL VIDEO · v1"
        : twoPassRun && selectedIteration.index === 2
          ? "FINAL VIDEO · v2"
          : `VIDEO · v${selectedIteration.index}`
      : backgroundRun
        ? "LAMP BACKGROUND VIDEO"
        : lampRun
          ? "LAMP VIDEO"
        : "FLORA VIDEO";

  const shortId = run.id.length > 12 ? `${run.id.slice(0, 12)}…` : run.id;

  return (
    <main className="mx-auto max-w-5xl px-6 pb-16 pt-6 xl:max-w-6xl">
      {/* SLIM HEADER — one line */}
      <header className="flex flex-wrap items-center gap-3 pb-6">
        <Link
          href="/"
          className="inline-flex min-h-10 items-center text-sm text-muted transition-[color,transform] duration-150 ease-out hover:text-ink active:scale-[0.96]"
        >
          ← Create
        </Link>
        <span className="text-sm font-medium text-ink">{run.originalVideo.label}</span>
        <Badge
          color={run.serverExecution && run.humanGrade ? "var(--pass)" : STATUS_COLOR[run.status]}
        >
          {run.serverExecution && run.humanGrade
            ? "human grade saved"
            : STATUS_LABEL[run.status]}
        </Badge>
        <span className="font-mono text-2xs text-faint">{shortId}</span>
        <span className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:flex-nowrap sm:gap-3">
          <RunTabs runId={run.id} active="review" />
          <DownloadSideBySide run={run} />
        </span>
      </header>

      {/* BODY — the review content, plus a slim workflow rail on the right
          (xl screens); the rail stacks below everything on smaller ones. */}
      <div className="xl:flex xl:items-start xl:gap-10">
        <div className="min-w-0 xl:flex-1">
          <BackgroundPlanReview run={run} />
          <BeautifyPlanReview run={run} />

          {/* HERO — original next to relit, one shared transport. While the
          selected attempt is still generating, the relit slot becomes the
          generation theater instead of dead air. */}
          <HeroComparison
            original={run.originalVideo}
            relit={relitVideo}
            relitLabel={relitLabel}
            fallback={run.fallback}
            generating={
              run.status === "running" && !planAwaitingApproval
                ? <GenerationTheater run={run} />
                : undefined
            }
          />

          {planAwaitingApproval ? (
            <p className="mt-4 text-pretty text-xs leading-relaxed text-faint">
              Generation is paused here. Approving the plan above is the only
              action that can authorize cleanup or the rare exact-source no-op.
            </p>
          ) : (
            <>
              {/* RECOVERY — only for a durable execution stopped in
                  reconcile_required; the provider-lost case gets a safe re-run
                  action, anything else renders as read-only evidence. */}
              <LostGenerationRecovery run={run} />

              {/* VERDICT LINE */}
              <div className="mt-8">
                <VerdictLine
                  run={run}
                  iteration={selectedIteration}
                  threshold={workflow.config.compositePassThreshold}
                />
              </div>

              {/* ATTEMPT SWITCHER */}
              <div className="py-3">
                <AttemptSwitcher
                  run={run}
                  activeKey={activeKey}
                  onSelect={setUserSelected}
                />
              </div>

              {/* EVALS — method-scoped rows */}
              <EvalList
                iteration={selectedIteration}
                definitions={evalDefsForRun(run)}
                evalsUnderway={run.status !== "running" || evalPhaseReached(run)}
              />

              {/* REVIEW */}
            <div className="mt-6">
              <ReviewActions
                run={run}
                onSubmit={(decision, notes) => submitReview(run.id, decision, notes)}
              />
            </div>
            </>
          )}
        </div>

        {/* WORKFLOW RAIL — how far along the engine is, at a glance */}
        <aside className="mt-10 border-t border-edge pt-6 xl:sticky xl:top-6 xl:mt-0 xl:w-44 xl:shrink-0 xl:border-t-0 xl:pt-0">
          <WorkflowRail run={run} />
        </aside>
      </div>
    </main>
  );
}
