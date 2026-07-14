/** Pure Lamp run-state derivations shared by the Method canvas and progress strip. */

import type { NodeRunStatus, Run, RunConfig } from "@/lib/types";
import { EVAL_STACK_IDS } from "@/components/canvas/layout";

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

export function deriveStageChips(
  run: Run | undefined,
  _config: RunConfig
): StageChip[] {
  // Kept in the public signature for historical callers; Lamp has no score gate.
  void _config;
  const latest = run?.iterations[run.iterations.length - 1];
  const latestVisualCount =
    latest?.evalResults.filter((result) => result.evalId !== "audio-integrity").length ?? 0;

  const source = groupState(run, SOURCE_IDS);
  const generate = groupState(run, GENERATE_IDS);
  const evaluate = groupState(run, EVALUATE_IDS);
  const grade = groupState(run, GRADE_IDS);

  let gradeDetail: string | undefined;
  if (run?.status === "awaiting-review") gradeDetail = "ready for your grade";
  else if (run?.review) {
    gradeDetail = run.review.decision === "approved" ? "approved" : "changes requested";
  }

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
      detail: gradeDetail,
    },
  ];
}
