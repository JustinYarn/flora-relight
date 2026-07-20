"use client";

import Link from "next/link";
import type { Iteration, Run } from "@/lib/types";
import { evalDefsForRun } from "@/lib/lamp-evaluation";
import { isLampBackgroundRun } from "@/lib/lamp-background-read";
import { isLampBeautifyRun } from "@/lib/lamp-beautify-read";
import { isLampIrisRun } from "@/lib/lamp-iris-read";
import { isLampCombinedRun } from "@/lib/lamp-combined-read";
import type { LampChainStage } from "@/lib/lamp-chain";
import { runWorkflowMode } from "@/lib/workflow-mode";

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

const IRIS_STAGES = [
  { id: "plan", label: "Gaze plan" },
  { id: "initial", label: "Initial video" },
  { id: "critique", label: "Contact critique" },
  { id: "final", label: "Final video" },
  { id: "grade", label: "Your grade" },
] as const;

const COMBINED_STAGES = [
  { id: "plan", label: "Combined plan" },
  { id: "initial", label: "Take 1" },
  { id: "critique", label: "Take 1 quality check" },
  { id: "final", label: "Take 2" },
  { id: "grade", label: "Pick + grade winner" },
] as const;

const CHAIN_STAGE_LABELS: Record<LampChainStage, string> = {
  background: "Background",
  lamp: "Lamp",
  beautify: "Beautify",
  iris: "Iris",
};

/** Defensive read of the server GET projection; absent on mock runs. */
function chainProjectionStages(
  run: Run
): Array<{ stage?: number; artifact?: unknown }> {
  const projected = (
    run as Run & { chainExecution?: { stages?: unknown } }
  ).chainExecution?.stages;
  return Array.isArray(projected)
    ? (projected as Array<{ stage?: number; artifact?: unknown }>)
    : [];
}

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

function stateForPlanNode(
  run: Run,
  nodeId: "plan" | "initial" | "critique" | "final"
): StageState {
  const status = run.nodeStates[nodeId]?.status ?? "idle";
  if (
    nodeId === "plan" &&
    (run.combinedPlan?.approval.status === "draft" ||
      run.chainPlan?.aggregate.approval.status === "draft" ||
      run.backgroundCleanupPlan?.approval.status === "draft" ||
      run.beautifyPlan?.approval.status === "draft" ||
      run.irisPlan?.approval.status === "draft")
  ) {
    return "active";
  }
  if (status === "succeeded") return "done";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "running" || status === "queued") return "active";
  return "idle";
}

function planSummary(run: Run): string | null {
  if (run.chainPlan) {
    const plan = run.chainPlan;
    if (plan.aggregate.approval.status !== "approved") {
      return "awaiting your approval";
    }
    return `${plan.stageOrder.length}-stage order approved`;
  }
  if (run.combinedPlan) {
    const plan = run.combinedPlan;
    if (plan.approval.status !== "approved") return "awaiting your approval";
    const optionalScopes = [
      ...(plan.beautify.state === "enabled" ? ["beautify"] : []),
      ...(plan.iris.state === "enabled" ? ["eye contact"] : []),
    ];
    return optionalScopes.length > 0
      ? `background + ${optionalScopes.join(" + ")} approved`
      : "background approved; optional edits locked off";
  }
  if (run.backgroundCleanupPlan) {
    const plan = run.backgroundCleanupPlan;
    if (plan.approval.status !== "approved") return "awaiting your approval";
    if (plan.decision === "exceptional-no-op") {
      return "exceptional no-op approved";
    }
    return `${plan.remove.length} removal target${
      plan.remove.length === 1 ? "" : "s"
    } approved`;
  }
  if (run.beautifyPlan) {
    const plan = run.beautifyPlan;
    if (plan.approval.status !== "approved") return "awaiting your approval";
    if (plan.decision === "exceptional-no-op") {
      return "exceptional no-op approved";
    }
    return `${plan.enhance.length} enhancement${
      plan.enhance.length === 1 ? "" : "s"
    } approved`;
  }
  if (run.irisPlan) {
    const plan = run.irisPlan;
    if (plan.approval.status !== "approved") return "awaiting your approval";
    if (plan.decision === "exceptional-no-op") {
      return "exceptional no-op approved";
    }
    return `${plan.correct.length} gaze correction${
      plan.correct.length === 1 ? "" : "s"
    } approved`;
  }
  return null;
}

/**
 * Lamp's compact progress rail. It intentionally mirrors the product method,
 * not every engine node: v1, one holistic critique, v2, then human grade.
 */
export function WorkflowRail({ run }: { run: Run }) {
  const chain = runWorkflowMode(run) === "chain";
  const combined = isLampCombinedRun(run);
  const iris = isLampIrisRun(run);
  const beautify = isLampBeautifyRun(run);
  const background = isLampBackgroundRun(run) || beautify || iris;
  const planFirst = combined || background;
  const chainOrder: LampChainStage[] = chain
    ? run.chainPlan?.stageOrder ?? run.chainControls?.stageOrder ?? []
    : [];
  const stages: ReadonlyArray<{ id: string; label: string }> = chain
    ? [
        { id: "plan", label: "Ordered chain plan" },
        ...chainOrder.map((kind, index) => ({
          id: `stage-${index + 1}`,
          label: `Stage ${index + 1} · ${CHAIN_STAGE_LABELS[kind]}`,
        })),
        { id: "deliver", label: "Delivered cut" },
        { id: "report", label: "Detached report card" },
        { id: "grade", label: "Your grade" },
      ]
    : combined
    ? COMBINED_STAGES
    : iris
      ? IRIS_STAGES
      : beautify
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
  const savedPlanSummary = planSummary(run);

  const gradeState: StageState = run.humanGrade
    ? "done"
    : run.status === "awaiting-review" || Boolean(run.finalVideo)
      ? "active"
      : "idle";

  // Chain progress: per-stage chips from the durable execution record —
  // append-only stage receipts, the live iteration/phase, and the mock
  // engine's stage nodes — then delivery, then the detached report card.
  const execution = run.serverExecution;
  const receipts = execution?.chainStageReceipts ?? [];
  const chainStageStates: StageState[] = chainOrder.map((_, index) => {
    const stage = index + 1;
    const node = run.nodeStates[`stage-${stage}`]?.status;
    if (node === "succeeded") return "done";
    if (node === "failed") return "failed";
    if (node === "running" || node === "queued") return "active";
    if (receipts.some((receipt) => receipt.stage === stage)) return "done";
    if (run.iterations.find((item) => item.index === stage)?.generatedVideo) {
      return "done";
    }
    if (execution?.iteration === stage) {
      if (execution.status === "failed") return "failed";
      if (
        execution.status === "running" &&
        (execution.phase === "video_generation" ||
          execution.phase === "preparing")
      ) {
        return "active";
      }
    }
    return "idle";
  });
  const chainDelivered =
    Boolean(run.finalVideo) ||
    run.status === "awaiting-review" ||
    run.status === "approved" ||
    execution?.status === "awaiting_review";
  const deliverNode = run.nodeStates.deliver?.status;
  const chainDeliverState: StageState = chainDelivered
    ? "done"
    : deliverNode === "failed"
      ? "failed"
      : deliverNode === "running" ||
          (execution?.status === "running" &&
            execution.phase === "finalizing")
        ? "active"
        : "idle";
  const chainProjected = chain ? chainProjectionStages(run) : [];
  const chainAttached = chainOrder.filter((_, index) => {
    const stage = index + 1;
    const iteration = run.iterations.find((item) => item.index === stage);
    if ((iteration?.evalResults.length ?? 0) > 0) return true;
    return chainProjected.some(
      (item) => item.stage === stage && item.artifact !== undefined
    );
  }).length;
  const chainReportState: StageState =
    chainOrder.length > 0 && chainAttached === chainOrder.length
      ? "done"
      : run.nodeStates.report?.status === "succeeded"
        ? "done"
        : chainAttached > 0 ||
            run.nodeStates.report?.status === "running" ||
            chainDelivered
          ? "active"
          : "idle";

  const states: StageState[] = chain
    ? [
        stateForPlanNode(run, "plan"),
        ...chainStageStates,
        chainDeliverState,
        chainReportState,
        gradeState,
      ]
    : planFirst
    ? [
        stateForPlanNode(run, "plan"),
        stateForPlanNode(run, "initial"),
        stateForPlanNode(run, "critique"),
        stateForPlanNode(run, "final"),
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
        chain
          ? "Lamp Chain"
          : combined
          ? "Lamp Combined"
          : iris
            ? "Lamp Iris"
            : beautify
              ? "Lamp Beautify"
              : background
                ? "Lamp Background"
                : "Lamp"
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
                {stage.id === "plan" && savedPlanSummary ? (
                  <span className="mt-1 block text-2xs text-faint">
                    {savedPlanSummary}
                  </span>
                ) : null}
                {chain &&
                stage.id.startsWith("stage-") &&
                state !== "idle" &&
                run.nodeStates[stage.id]?.detail ? (
                  <span className="mt-1 block text-2xs text-faint">
                    {run.nodeStates[stage.id]?.detail}
                  </span>
                ) : null}
                {chain && stage.id === "report" && chainOrder.length > 0 ? (
                  <span className="mt-1 block text-2xs tabular-nums text-faint">
                    {chainAttached}/{chainOrder.length} stage measurements
                    attached
                  </span>
                ) : null}
                {stage.id === "critique" && initialCritiqueCount > 0 ? (
                  <span className="mt-1 block text-2xs tabular-nums text-faint">
                    {initialCritiqueCount} results returned
                  </span>
                ) : null}
                {stage.id === "final" && finalEvalCount > 0 ? (
                  <span className="mt-1 block text-2xs tabular-nums text-faint">
                    {finalEvalCount} {combined ? "Take 2" : "final"} results available
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
