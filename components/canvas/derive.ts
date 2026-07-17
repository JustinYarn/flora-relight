/** Pure run-state derivations shared by the Method canvas and progress strip. */

import type {
  NodeRunStatus,
  Run,
  RunConfig,
  WorkflowMode,
} from "@/lib/types";
import { EVAL_STACK_IDS } from "./layout.ts";
import { evalDefsForRun } from "../../lib/lamp-evaluation.ts";
import {
  DEFAULT_WORKFLOW_MODE,
  runWorkflowMode,
} from "../../lib/workflow-mode.ts";

export type StageState = "idle" | "running" | "pass" | "fail" | "skipped";

export interface StageChip {
  id: string;
  label: string;
  symbol: string;
  detail?: string;
  state: StageState;
}

export const STAGE_STATE_COLOR: Record<StageState, string> = {
  idle: "var(--faint)",
  running: "var(--running)",
  pass: "var(--pass)",
  fail: "var(--fail)",
  skipped: "var(--faint)",
};

const SYMBOL: Record<StageState, string> = {
  idle: "—",
  running: "●",
  pass: "✓",
  fail: "✗",
  skipped: "⊘",
};

function statusOf(run: Run | undefined, id: string): NodeRunStatus {
  return run?.nodeStates[id]?.status ?? "idle";
}

export function groupState(run: Run | undefined, ids: readonly string[]): StageState {
  const statuses = ids.map((id) => statusOf(run, id));
  if (statuses.some((status) => status === "failed")) return "fail";
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.every((status) => status === "skipped")) return "skipped";
  if (statuses.every((status) => status === "succeeded" || status === "skipped")) {
    return "pass";
  }
  if (statuses.every((status) => status === "idle")) return "idle";
  return "running";
}

/** Latest composite retained for compatibility with historical run views. */
export function latestComposite(
  run?: Run
): { score: number; passed: boolean } | null {
  if (!run) return null;
  for (let index = run.iterations.length - 1; index >= 0; index -= 1) {
    const composite = run.iterations[index].composite;
    if (composite) return { score: composite.score, passed: composite.passed };
  }
  return null;
}

/** Recover the currently pinned seed from the latest matching run log entry. */
export function currentSeed(run?: Run): number | null {
  if (!run) return null;
  for (let index = run.log.length - 1; index >= 0; index -= 1) {
    const match = run.log[index].message.match(/seed (?:to )?(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Lamp loops back exactly once after Initial evaluation. It never activates a
 * conditional fallback; Final is always the delivered generation.
 */
export function loopContext(run?: Run): {
  loopingBack: boolean;
  fallbackActive: boolean;
} {
  if (!run || run.status !== "running") {
    return { loopingBack: false, fallbackActive: false };
  }
  const initial = run.iterations.find((iteration) => iteration.index === 1);
  const final = run.iterations.find((iteration) => iteration.index === 2);
  const loopingBack =
    Boolean(initial?.generatedVideo) &&
    (initial?.evalResults.filter((result) => result.evalId !== "audio-integrity")
      .length ?? 0) > 0 &&
    !final?.generatedVideo;
  return { loopingBack, fallbackActive: false };
}

const SOURCE_IDS = ["src", "ingest"];
const GENERATE_IDS = ["compile", "videogen", "remux", "eval-audio"];
const EVALUATE_IDS = [...EVAL_STACK_IDS, "ledger"];
const GRADE_IDS = ["review"];

function gradeDetail(run: Run | undefined): string | undefined {
  if (run?.humanGrade) return "human grade saved";
  if (run?.status === "awaiting-review") return "ready for your grade";
  if (run?.review) {
    return run.review.decision === "approved"
      ? "approved"
      : "changes requested";
  }
  return undefined;
}

function deriveBackgroundStageChips(run: Run | undefined): StageChip[] {
  const planState =
    run?.backgroundCleanupPlan?.approval.status === "draft"
      ? "running"
      : groupState(run, ["plan"]);
  const initial = groupState(run, ["initial"]);
  const critique = groupState(run, ["critique"]);
  const final = groupState(run, ["final"]);
  const review =
    run?.humanGrade || run?.review
      ? "pass"
      : run?.status === "awaiting-review"
        ? "running"
        : groupState(run, ["review"]);
  const initialIteration = run?.iterations.find(
    (iteration) => iteration.index === 1
  );
  const visualIds = new Set(
    run
      ? evalDefsForRun(run)
          .filter((definition) => definition.method !== "deterministic")
          .map((definition) => definition.id)
      : []
  );
  const critiqueCount =
    initialIteration?.evalResults.filter((result) =>
      visualIds.has(result.evalId)
    ).length ?? 0;
  const noOp =
    run?.backgroundCleanupPlan?.approval.status === "approved" &&
    run.backgroundCleanupPlan.decision === "exceptional-no-op";

  return [
    {
      id: "plan",
      label: "Cleanup plan",
      state: planState,
      symbol: SYMBOL[planState],
      detail:
        run?.backgroundCleanupPlan?.approval.status === "approved"
          ? noOp
            ? "no-op approved"
            : `${run.backgroundCleanupPlan.remove.length} remove`
          : run?.backgroundCleanupPlan
            ? "awaiting approval"
            : undefined,
    },
    {
      id: "initial",
      label: "Initial",
      state: initial,
      symbol: SYMBOL[initial],
      detail: initial === "skipped" ? "not generated" : undefined,
    },
    {
      id: "critique",
      label: "Critique",
      state: critique,
      symbol: SYMBOL[critique],
      detail:
        critique === "skipped"
          ? "not run"
          : visualIds.size > 0 && critiqueCount > 0
            ? `${critiqueCount}/${visualIds.size} visual`
            : undefined,
    },
    {
      id: "final",
      label: "Final",
      state: final,
      symbol: SYMBOL[final],
      detail:
        final === "skipped" && noOp ? "exact source" : undefined,
    },
    {
      id: "review",
      label: "Human grade",
      state: review,
      symbol: SYMBOL[review],
      detail: gradeDetail(run),
    },
  ];
}

export function deriveStageChips(
  run: Run | undefined,
  _config: RunConfig,
  workflowMode: WorkflowMode = run
    ? runWorkflowMode(run)
    : DEFAULT_WORKFLOW_MODE
): StageChip[] {
  // Kept in the public signature for historical callers; Lamp has no score gate.
  void _config;
  if (workflowMode === "background") {
    return deriveBackgroundStageChips(run);
  }
  const latest = run?.iterations[run.iterations.length - 1];
  const latestVisualCount =
    latest?.evalResults.filter((result) => result.evalId !== "audio-integrity").length ?? 0;

  const source = groupState(run, SOURCE_IDS);
  const generate = groupState(run, GENERATE_IDS);
  const evaluate = groupState(run, EVALUATE_IDS);
  const grade = groupState(run, GRADE_IDS);

  return [
    {
      id: "source",
      label: "Source",
      state: source,
      symbol: SYMBOL[source],
    },
    {
      id: "generate",
      label: "Generate & verify",
      state: generate,
      symbol: SYMBOL[generate],
      detail: latest ? (latest.index === 1 ? "Initial" : "Final") : undefined,
    },
    {
      id: "evaluate",
      label: "Whole-video evaluation",
      state: evaluate,
      symbol: SYMBOL[evaluate],
      detail: latest ? `${latestVisualCount}/8 visual` : undefined,
    },
    {
      id: "grade",
      label: "Human grade",
      state: grade,
      symbol: SYMBOL[grade],
      detail: gradeDetail(run),
    },
  ];
}
