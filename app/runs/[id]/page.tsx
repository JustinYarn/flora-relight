"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAppStore } from "@/lib/store";
import { useRunDetails } from "@/lib/useRunDetails";
import type { RunStatus } from "@/lib/types";
import { workflowForMode } from "@/lib/workflow-def";
import {
  isTwoPassWorkflowMode,
  runWorkflowMode,
  workflowModeLabel,
} from "@/lib/workflow-mode";
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
import { IrisPlanReview } from "@/components/review/IrisPlanReview";
import {
  deliveredInitialBestOfTwo,
  deliveredVideoLabel,
} from "@/components/grade/derive";
import {
  DELIVERED_ATTEMPT_KEY,
  reviewAttemptSelection,
} from "@/components/review/attempt-selection";

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

  const workflowMode = runWorkflowMode(run);
  const workflow = workflowForMode(workflowMode);
  const latest = run.iterations[run.iterations.length - 1];
  const twoPassRun = isTwoPassWorkflowMode(workflowMode);
  const planAwaitingApproval =
    (workflowMode === "background" &&
      run.backgroundCleanupPlan?.approval.status === "draft") ||
    (workflowMode === "beautify" &&
      run.beautifyPlan?.approval.status === "draft") ||
    (workflowMode === "iris" &&
      run.irisPlan?.approval.status === "draft");
  // Default to the server-selected delivery; mid-flight, follow the newest stage.
  const autoKey = run.finalVideo || deliveredInitialBestOfTwo(run)
    ? DELIVERED_ATTEMPT_KEY
    : latest
      ? `iter-${latest.index}`
      : null;
  const activeKey = userSelected ?? autoKey;
  const selectedAttempt = reviewAttemptSelection(run, activeKey);
  const selectedIteration = selectedAttempt.iteration;
  const relitVideo = selectedAttempt.video;
  const relitLabel = selectedAttempt.delivered
    ? deliveredVideoLabel(run)
    : selectedIteration
      ? twoPassRun && selectedIteration.index === 1
        ? "INITIAL VIDEO · v1"
        : twoPassRun && selectedIteration.index === 2
          ? "FINAL VIDEO · v2"
          : `VIDEO · v${selectedIteration.index}`
      : `${workflowModeLabel(workflowMode).toUpperCase()} VIDEO`;

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
          <IrisPlanReview run={run} />

          {/* HERO — original next to relit, one shared transport. While the
          selected attempt is still generating, the relit slot becomes the
          generation theater instead of dead air. */}
          <HeroComparison
            original={run.originalVideo}
            relit={relitVideo}
            relitLabel={relitLabel}
            fallback={run.fallback}
            generating={
              run.status === "running" && !planAwaitingApproval ? (
                <GenerationTheater run={run} />
              ) : planAwaitingApproval ? (
                <div className="flex h-full w-full items-center justify-center bg-raised px-6 text-center text-2xs leading-relaxed text-faint">
                  nothing is generating yet — approve the plan above to start
                  the two-pass edit; no provider spend happens until then
                </div>
              ) : undefined
            }
          />

          {planAwaitingApproval ? (
            <p className="mt-4 text-pretty text-xs leading-relaxed text-faint">
              Generation is paused here. Approving the plan above is the only
              action that can authorize the planned edit or a supported
              exact-source no-op.
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
