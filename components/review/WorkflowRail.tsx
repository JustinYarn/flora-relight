"use client";

import Link from "next/link";
import type { Iteration, Run } from "@/lib/types";
import { evalDefsForRun } from "@/lib/lamp-evaluation";
import { isLampBackgroundRun } from "@/lib/lamp-background-read";
import { isLampBeautifyRun } from "@/lib/lamp-beautify-read";

type StageState = "idle" | "active" | "done" | "failed" | "skipped";

const LAMP_STAGES = [
  { id: "initial", label: "Initial video" },
  { id: "critique", label: "Whole-video critique" },
  { id: "final", label: "Final video" },
  { id: "grade", label: "Your grade" },
] as const;

const BACKGROUND_STAGES = [
  { id: "plan", label: "Cleanup plan" },
  { id: "initial", label: "Initial video" },
  { id: "critique", label: "Cleanup critique" },
  { id: "final", label: "Final video" },
  { id: "grade", label: "Your grade" },
] as const;

const BEAUTIFY_STAGES = [
  { id: "plan", label: "Enhancement plan" },
  { id: "initial", label: "Initial video" },
  { id: "critique", label: "Touch-up critique" },
  { id: "final", label: "Final video" },
  { id: "grade", label: "Your grade" },
] as const;

const DOT_COLOR: Record<StageState, string> = {
  idle: "var(--edge)",
  active: "var(--running)",
  done: "var(--pass)",
  failed: "var(--fail)",
  skipped: "var(--faint)",
};

const LABEL_CLASS: Record<StageState, string> = {
  idle: "text-faint",
  active: "text-ink",
  done: "text-muted",
  failed: "text-fail",
  skipped: "text-faint",
};

function availableEvalCount(iteration: Iteration | undefined, run: Run): number {
  const evalIds = new Set(evalDefsForRun(run).map((definition) => definition.id));
  return (
    iteration?.evalResults.filter((result) => evalIds.has(result.evalId)).length ?? 0
  );
}

function stateForBackgroundNode(
  run: Run,
  nodeId: "plan" | "initial" | "critique" | "final"
): StageState {
  const status = run.nodeStates[nodeId]?.status ?? "idle";
  if (
    nodeId === "plan" &&
    (run.backgroundCleanupPlan?.approval.status === "draft" ||
      run.beautifyPlan?.approval.status === "draft")
  ) {
    return "active";
  }
  if (status === "succeeded") return "done";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "running" || status === "queued") return "active";
  return "idle";
}

/**
 * Lamp's compact progress rail. It intentionally mirrors the product method,
 * not every engine node: v1, one holistic critique, v2, then human grade.
 */
export function WorkflowRail({ run }: { run: Run }) {
  const beautify = isLampBeautifyRun(run);
  const background = isLampBackgroundRun(run) || beautify;
  const stages = beautify
    ? BEAUTIFY_STAGES
    : background
      ? BACKGROUND_STAGES
      : LAMP_STAGES;
  const initial =
    run.iterations.find((iteration) => iteration.index === 1) ?? run.iterations[0];
  const final =
    run.iterations.find((iteration) => iteration.index === 2) ??
    (run.iterations.length > 1 ? run.iterations.at(-1) : undefined);
  const initialCritiqueCount = availableEvalCount(initial, run);
  const finalEvalCount = availableEvalCount(final, run);

  const gradeState: StageState = run.humanGrade
    ? "done"
    : run.status === "awaiting-review" || Boolean(run.finalVideo)
      ? "active"
      : "idle";
  const states: StageState[] = background
    ? [
        stateForBackgroundNode(run, "plan"),
        stateForBackgroundNode(run, "initial"),
        stateForBackgroundNode(run, "critique"),
        stateForBackgroundNode(run, "final"),
        gradeState,
      ]
    : [
        initial?.generatedVideo
          ? "done"
          : run.status === "running"
            ? "active"
            : run.status === "failed"
              ? "failed"
              : "idle",
        final
          ? "done"
          : initialCritiqueCount > 0 && run.status === "running"
            ? "active"
            : run.status === "failed" && Boolean(initial?.generatedVideo)
              ? "failed"
              : "idle",
        run.finalVideo || final?.generatedVideo
          ? "done"
          : final && run.status === "running"
            ? "active"
            : "idle",
        gradeState,
      ];

  let reached = 0;
  states.forEach((state, index) => {
    if (state !== "idle") reached = index;
  });

  return (
    <nav
      aria-label={`${
        beautify ? "Lamp Beautify" : background ? "Lamp Background" : "Lamp"
      } progress`}
    >
      <p className="text-2xs tabular-nums text-faint">
        step {reached + 1} of {stages.length}
      </p>

      <ol className="mt-3">
        {stages.map((stage, index) => {
          const state = states[index];
          return (
            <li
              key={stage.id}
              className="relative flex items-start gap-2.5 pb-5 last:pb-0"
            >
              {index < stages.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 left-[3px] top-3.5 w-px transition-[background-color] duration-300 ease-out"
                  style={{
                    background:
                      state === "done" ? "var(--pass)" : "var(--edge)",
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
                className={`min-w-0 text-pretty text-xs leading-snug ${LABEL_CLASS[state]}`}
              >
                {stage.label}
                {stage.id === "plan" && run.backgroundCleanupPlan ? (
                  <span className="mt-1 block text-2xs text-faint">
                    {run.backgroundCleanupPlan.approval.status === "approved"
                      ? run.backgroundCleanupPlan.decision ===
                        "exceptional-no-op"
                        ? "exceptional no-op approved"
                        : `${run.backgroundCleanupPlan.remove.length} removal target${
                            run.backgroundCleanupPlan.remove.length === 1
                              ? ""
                              : "s"
                          } approved`
                      : "awaiting your approval"}
                  </span>
                ) : null}
                {stage.id === "critique" && initialCritiqueCount > 0 ? (
                  <span className="mt-1 block text-2xs tabular-nums text-faint">
                    {initialCritiqueCount} results returned
                  </span>
                ) : null}
                {stage.id === "final" && finalEvalCount > 0 ? (
                  <span className="mt-1 block text-2xs tabular-nums text-faint">
                    {finalEvalCount} final results available
                  </span>
                ) : null}
                {background && state === "skipped" ? (
                  <span className="mt-1 block text-2xs text-faint">
                    {stage.id === "final"
                      ? "exact source delivered"
                      : "not run for approved no-op"}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      <Link
        href="/pipeline"
        className="mt-3 inline-flex min-h-10 items-center text-2xs text-faint transition-[color,transform] duration-150 ease-out hover:text-ink active:scale-[0.96]"
      >
        Inspect the engine →
      </Link>
    </nav>
  );
}
