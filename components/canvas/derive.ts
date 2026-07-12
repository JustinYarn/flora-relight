/**
 * Pure run-state derivations shared by the pipeline canvas (live edges,
 * follow mode, node extras) and the stage progress strip. No React here.
 */

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

/** Collapse a group of node statuses into one stage-level state. */
export function groupState(run: Run | undefined, ids: string[]): StageState {
  const statuses = ids.map((id) => statusOf(run, id));
  if (statuses.some((s) => s === "failed")) return "fail";
  if (statuses.some((s) => s === "running")) return "running";
  if (statuses.every((s) => s === "skipped")) return "skipped";
  if (statuses.every((s) => s === "succeeded" || s === "skipped")) return "pass";
  if (statuses.every((s) => s === "idle")) return "idle";
  return "running"; // partial progress / queued for the next loop pass
}

/** Latest composite across iterations, newest first. */
export function latestComposite(
  run?: Run
): { score: number; passed: boolean } | null {
  if (!run) return null;
  for (let i = run.iterations.length - 1; i >= 0; i -= 1) {
    const c = run.iterations[i].composite;
    if (c) return { score: c.score, passed: c.passed };
  }
  return null;
}

/**
 * The seed currently pinned by the engine, recovered from the run log
 * ("seed 133742 pinned" / "rotating seed to 141661"). Scans newest first.
 */
export function currentSeed(run?: Run): number | null {
  if (!run) return null;
  for (let i = run.log.length - 1; i >= 0; i -= 1) {
    const m = run.log[i].message.match(/seed (?:to )?(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Is a loop-back actually happening right now (gate failed, next iteration
 * about to start), and has the run routed to the color-transfer fallback?
 */
export function loopContext(run?: Run): {
  loopingBack: boolean;
  fallbackActive: boolean;
} {
  if (!run) return { loopingBack: false, fallbackActive: false };
  const fb = statusOf(run, "fallback");
  const fallbackActive = fb === "running" || fb === "succeeded";
  const last = run.iterations[run.iterations.length - 1];
  const gate = statusOf(run, "gate");
  const loopingBack =
    run.status === "running" &&
    !fallbackActive &&
    last !== undefined &&
    last.status === "failed" &&
    (gate === "failed" || gate === "queued");
  return { loopingBack, fallbackActive };
}

/** Node groups per stage chip (mirrors the canvas lanes). */
const INGEST_IDS = ["src", "ingest", "manifest"];
const ANCHOR_IDS = ["anchor", "anchor-gate"];
const GENERATE_IDS = ["compile", "videogen", "conform"];
const EVAL_IDS = ["sample", ...EVAL_STACK_IDS];
const DELIVER_IDS = ["remux", "eval-audio", "review"];

/** Number of checks run inside the gauntlet each iteration (audio runs post-remux). */
const CHECKS_PER_ITERATION = 10;

/**
 * One chip per stage lane, in plain words — the at-a-glance answer to
 * "what is happening right now".
 */
export function deriveStageChips(
  run: Run | undefined,
  config: RunConfig
): StageChip[] {
  const { loopingBack, fallbackActive } = loopContext(run);
  const last =
    run && run.iterations.length > 0
      ? run.iterations[run.iterations.length - 1]
      : undefined;

  const chips: StageChip[] = [];

  const ingest = groupState(run, INGEST_IDS);
  chips.push({
    id: "ingest",
    label: "Read clip",
    state: ingest,
    symbol: SYMBOL[ingest],
  });

  const anchor = groupState(run, ANCHOR_IDS);
  chips.push({ id: "anchor", label: "Anchor", state: anchor, symbol: SYMBOL[anchor] });

  const gen = groupState(run, GENERATE_IDS);
  chips.push({
    id: "generate",
    label: "Generate",
    state: gen,
    symbol: SYMBOL[gen],
    detail: last ? `v${last.index}` : undefined,
  });

  const evals = groupState(run, EVAL_IDS);
  const evalsDone = last
    ? last.evalResults.filter((r) => r.evalId !== "audio-integrity").length
    : 0;
  chips.push({
    id: "evals",
    label: "Checks",
    state: evals,
    symbol: SYMBOL[evals],
    detail: last ? `${evalsDone}/${CHECKS_PER_ITERATION}` : undefined,
  });

  const composite = latestComposite(run);
  const gateStatus = statusOf(run, "gate");
  let gateState: StageState;
  let gateDetail: string | undefined;
  if (gateStatus === "succeeded") {
    gateState = "pass";
    gateDetail = composite
      ? `${composite.score} ≥ ${config.compositePassThreshold}`
      : undefined;
  } else if (gateStatus === "failed" || fallbackActive) {
    gateState = "fail";
    gateDetail = loopingBack
      ? "→ retrying"
      : fallbackActive
        ? "→ safe fallback"
        : composite
          ? `${composite.score} < ${config.compositePassThreshold}`
          : undefined;
  } else {
    const g = groupState(run, ["ledger", "gate"]);
    gateState = g === "pass" ? "running" : g;
    gateDetail = g === "running" ? "deciding" : undefined;
  }
  chips.push({
    id: "gate",
    label: "Decision",
    state: gateState,
    symbol: SYMBOL[gateState],
    detail: gateDetail,
  });

  const deliver = groupState(run, DELIVER_IDS);
  let deliverDetail: string | undefined;
  if (run?.status === "awaiting-review") deliverDetail = "needs your review";
  else if (run?.review)
    deliverDetail =
      run.review.decision === "approved" ? "approved" : "changes requested";
  chips.push({
    id: "deliver",
    label: "Deliver",
    state: deliver,
    symbol: SYMBOL[deliver],
    detail: deliverDetail,
  });

  return chips;
}
