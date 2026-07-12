"use client";

/**
 * WorkflowRail — a compact vertical mirror of the engine graph for the Review
 * page's right rail: the six stage lanes in plain English, one dot each,
 * joined by a line that fills as stages complete. Answers "how far along is
 * it?" without leaving the page; the full canvas stays one click away.
 *
 * Terminal runs keep the rail rendered — all-green (or a failed dot) is the
 * record of how the run ended, and the props: { run } contract means it
 * live-updates through the same store subscription as everything else.
 */

import Link from "next/link";
import type { NodeRunStatus, Run } from "@/lib/types";
import { useAppStore } from "@/lib/store";

type StageState = "idle" | "active" | "done" | "failed";

/** The six stages, mirroring the pipeline canvas lanes (components/canvas). */
const STAGES: { id: string; label: string; nodeIds: string[] }[] = [
  { id: "ingest", label: "Ingest", nodeIds: ["src", "ingest", "manifest"] },
  { id: "anchor", label: "Approve the look", nodeIds: ["anchor", "anchor-gate"] },
  { id: "generate", label: "Generate", nodeIds: ["compile", "videogen", "conform"] },
  {
    id: "checks",
    label: "The 10 checks",
    nodeIds: [
      "sample",
      "eval-align",
      "eval-identity",
      "eval-skin",
      "eval-appearance",
      "eval-background",
      "eval-lighting-delta",
      "eval-lighting-anchor",
      "eval-motion",
      "eval-temporal",
      "eval-halluc",
    ],
  },
  { id: "decide", label: "Decide", nodeIds: ["ledger", "gate"] },
  { id: "deliver", label: "Deliver", nodeIds: ["remux", "eval-audio", "review"] },
];

/** Checks judged per attempt (the post-remux audio check is not one of them). */
const CHECKS_PER_ITERATION = 10;

/** Collapse one stage's node statuses into a single dot state. */
function stageState(run: Run, nodeIds: string[]): StageState {
  const statuses: NodeRunStatus[] = nodeIds.map(
    (id) => run.nodeStates[id]?.status ?? "idle"
  );
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "running" || s === "queued")) return "active";
  if (statuses.every((s) => s === "succeeded" || s === "skipped")) return "done";
  return "idle";
}

const DOT_COLOR: Record<StageState, string> = {
  idle: "var(--edge)",
  active: "var(--running)",
  done: "var(--pass)",
  failed: "var(--fail)",
};

const LABEL_CLASS: Record<StageState, string> = {
  idle: "text-faint",
  active: "text-ink",
  done: "text-muted",
  failed: "text-fail",
};

export function WorkflowRail({ run }: { run: Run }) {
  const maxIterations = useAppStore((s) => s.workflow.config.maxIterations);

  const states = STAGES.map((stage) => stageState(run, stage.nodeIds));
  // "stage X of 6" — the furthest stage the run has reached (last non-idle).
  let reached = 0;
  states.forEach((state, i) => {
    if (state !== "idle") reached = i;
  });

  const latest = run.iterations[run.iterations.length - 1];
  const attempt = latest?.index ?? 1;
  const checksLanded = latest
    ? Math.min(
        CHECKS_PER_ITERATION,
        latest.evalResults.filter((r) => r.evalId !== "audio-integrity").length
      )
    : null;

  return (
    <nav aria-label="Pipeline progress">
      <p className="text-2xs tabular-nums text-faint">
        attempt {attempt} of {maxIterations} · stage {reached + 1} of{" "}
        {STAGES.length}
      </p>

      <ol className="mt-3">
        {STAGES.map((stage, i) => {
          const state = states[i];
          return (
            <li
              key={stage.id}
              className="relative flex items-start gap-2.5 pb-5 last:pb-0"
            >
              {/* Connector to the next dot — fills pass-green once this stage is done. */}
              {i < STAGES.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 left-[3px] top-3.5 w-px transition-colors duration-500"
                  style={{
                    background: state === "done" ? "var(--pass)" : "var(--edge)",
                  }}
                />
              ) : null}
              <span
                className={`relative mt-1 h-[7px] w-[7px] shrink-0 rounded-full ${
                  state === "active" ? "status-pulse" : ""
                }`}
                style={{ background: DOT_COLOR[state] }}
              />
              <span
                className={`flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs leading-snug ${LABEL_CLASS[state]}`}
              >
                {stage.label}
                {stage.id === "checks" && checksLanded !== null ? (
                  <span className="rounded-full bg-raised px-1.5 py-px text-2xs tabular-nums text-muted">
                    {checksLanded}/{CHECKS_PER_ITERATION}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      <Link
        href="/pipeline"
        className="mt-4 inline-block text-2xs text-faint transition hover:text-ink"
      >
        Full engine graph →
      </Link>
    </nav>
  );
}
