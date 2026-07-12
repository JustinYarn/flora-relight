"use client";

/**
 * Journey — ONE video's story through the machine, told as a storyboard:
 * a horizontal chain of the steps this run actually took, plus a single
 * detail panel answering "what changed at this step". The abstract engine
 * graph lives at /pipeline; this page never duplicates it.
 */

import { useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/lib/store";
import type { RunStatus } from "@/lib/types";
import { Badge, EmptyState } from "@/components/ui";
import { ShareButton } from "@/components/share/ShareButton";
import { buildJourneySteps } from "@/components/journey/chain";
import { JourneyChain } from "@/components/journey/JourneyChain";
import { StepDetail } from "@/components/journey/StepDetail";

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

export default function RunJourneyPage({ params }: { params: { id: string } }) {
  const run = useAppStore((s) => s.runs.find((r) => r.id === params.id));
  const threshold = useAppStore((s) => s.workflow.config.compositePassThreshold);
  // null = follow the newest step automatically; a string pins the panel.
  const [pinned, setPinned] = useState<string | null>(null);

  if (!run) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-10">
        <EmptyState
          title="Run not found"
          hint="Runs live in memory in mock mode — they are scoped to this browser session and disappear on reload. Head back to the studio to replay the demo run or start a new one."
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

  const steps = buildJourneySteps(run);
  const activeStep =
    (pinned ? steps.find((s) => s.id === pinned) : undefined) ??
    steps[steps.length - 1];

  return (
    <main className="mx-auto max-w-6xl px-6 pb-16 pt-6">
      {/* HEADER */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            aria-label="Back to studio"
            className="rounded-lg border border-edge bg-surface px-2.5 py-1 text-sm text-muted transition hover:border-faint hover:text-ink"
          >
            ←
          </Link>
          <h1 className="truncate text-sm font-medium text-ink">
            {run.originalVideo.label}
          </h1>
          <Badge color={STATUS_COLOR[run.status]}>{STATUS_LABEL[run.status]}</Badge>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-edge p-0.5">
            <Link
              href={`/runs/${run.id}`}
              className="rounded-md px-3 py-1 text-sm text-muted transition hover:text-ink"
            >
              Review
            </Link>
            <Link
              href={`/runs/${run.id}/journey`}
              className="rounded-md bg-raised px-3 py-1 text-sm text-ink"
            >
              Journey
            </Link>
          </div>
          <ShareButton run={run} />
        </div>
      </header>

      {/* THE CHAIN */}
      <section className="mt-10">
        <JourneyChain
          steps={steps}
          activeId={activeStep.id}
          onSelect={setPinned}
          live={run.status === "running"}
        />
        <p className="mt-2 text-2xs text-faint">
          Click a step to see what changed there.
        </p>
      </section>

      {/* DETAIL PANEL */}
      <section className="mt-8 border-t border-edge pt-8">
        <StepDetail run={run} step={activeStep} threshold={threshold} />
      </section>

      {/* FOOTER */}
      <footer className="mt-16 border-t border-edge pt-5">
        <Link
          href="/pipeline"
          className="text-2xs text-faint transition hover:text-muted"
        >
          See the full engine graph →
        </Link>
      </footer>
    </main>
  );
}
