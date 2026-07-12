"use client";

import { useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/lib/store";
import type { Iteration, Run, RunStatus } from "@/lib/types";
import { Badge, EmptyState } from "@/components/ui";
import { ShareButton } from "@/components/share/ShareButton";
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
import { WorkflowRail } from "@/components/review/WorkflowRail";

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

/** Resolve run.bestIterationIndex against Iteration.index (1-based), with fallbacks. */
function bestIteration(run: Run): Iteration | undefined {
  const last = run.iterations[run.iterations.length - 1];
  const bi = run.bestIterationIndex;
  if (bi === undefined) return last;
  return run.iterations.find((it) => it.index === bi) ?? run.iterations[bi] ?? last;
}

/**
 * The Review page: two videos + eleven flat rows. Everything else — prompt
 * evolution, frames, log, pipeline detail — lives one click away in Journey.
 */
export default function RunReviewPage({ params }: { params: { id: string } }) {
  const run = useAppStore((s) => s.runs.find((r) => r.id === params.id));
  const workflow = useAppStore((s) => s.workflow);
  const submitReview = useAppStore((s) => s.submitReview);
  // null = follow the newest attempt automatically; a string pins the view.
  const [userSelected, setUserSelected] = useState<string | null>(null);

  if (!run) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <EmptyState
          title="Run not found"
          hint="This run may have been deleted, or its id is wrong. Head back to Studio to pick an existing run or upload a new clip."
          action={
            <Link
              href="/"
              className="mt-1 rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition hover:border-faint"
            >
              Back to studio
            </Link>
          }
        />
      </main>
    );
  }

  const latest = run.iterations[run.iterations.length - 1];
  // Default to the final cut when it exists; mid-flight, follow the latest attempt.
  const autoKey = run.finalVideo ? "final" : latest ? `iter-${latest.index}` : null;
  const activeKey = userSelected ?? autoKey;
  const isFinal = activeKey === "final" && Boolean(run.finalVideo);

  const selectedIteration: Iteration | undefined = isFinal
    ? bestIteration(run)
    : (run.iterations.find((it) => `iter-${it.index}` === activeKey) ?? latest);

  const relitVideo = isFinal ? run.finalVideo : selectedIteration?.generatedVideo;
  const relitLabel = isFinal
    ? "RELIT · FINAL"
    : selectedIteration
      ? `RELIT v${selectedIteration.index}`
      : "RELIT";

  const shortId = run.id.length > 12 ? `${run.id.slice(0, 12)}…` : run.id;

  return (
    <main className="mx-auto max-w-5xl px-6 pb-16 pt-6 xl:max-w-6xl">
      {/* SLIM HEADER — one line */}
      <header className="flex flex-wrap items-center gap-3 pb-6">
        <Link href="/" className="text-sm text-muted transition hover:text-ink">
          ← Studio
        </Link>
        <span className="text-sm font-medium text-ink">{run.originalVideo.label}</span>
        <Badge color={STATUS_COLOR[run.status]}>{STATUS_LABEL[run.status]}</Badge>
        <span className="font-mono text-2xs text-faint">{shortId}</span>
        <span className="ml-auto flex items-center gap-3">
          <RunTabs runId={run.id} active="review" />
          <DownloadSideBySide run={run} />
          <ShareButton run={run} />
        </span>
      </header>

      {/* BODY — the review content, plus a slim workflow rail on the right
          (xl screens); the rail stacks below everything on smaller ones. */}
      <div className="xl:flex xl:items-start xl:gap-10">
        <div className="min-w-0 xl:flex-1">
          {/* HERO — original next to relit, one shared transport. While the
          selected attempt is still generating, the relit slot becomes the
          generation theater instead of dead air. */}
          <HeroComparison
            original={run.originalVideo}
            relit={relitVideo}
            relitLabel={relitLabel}
            fallback={run.fallback}
            generating={
              run.status === "running" ? <GenerationTheater run={run} /> : undefined
            }
          />

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
            <AttemptSwitcher run={run} activeKey={activeKey} onSelect={setUserSelected} />
          </div>

          {/* EVALS — eleven flat rows */}
          <EvalList
            iteration={selectedIteration}
            evalsUnderway={run.status !== "running" || evalPhaseReached(run)}
          />

          {/* REVIEW */}
          <div className="mt-6">
            <ReviewActions
              run={run}
              onSubmit={(decision, notes) => submitReview(run.id, decision, notes)}
            />
          </div>
        </div>

        {/* WORKFLOW RAIL — how far along the engine is, at a glance */}
        <aside className="mt-10 border-t border-edge pt-6 xl:sticky xl:top-6 xl:mt-0 xl:w-44 xl:shrink-0 xl:border-t-0 xl:pt-0">
          <WorkflowRail run={run} />
        </aside>
      </div>
    </main>
  );
}
