"use client";

/**
 * GenerationTheater — the relit slot of the hero while a run is mid-flight.
 * Instead of a flat "generating…" placeholder it narrates the machine: one
 * big plain-English stage line derived from nodeStates, live whole-video check
 * chips as results land, an elapsed clock during generation, and a quiet
 * monospace ticker of the latest engine notes.
 */

import { useEffect, useMemo, useState } from "react";
import type { EvalDefinition, EvalResult, Run } from "@/lib/types";
import { evalDefsForRun } from "@/lib/lamp-evaluation";
import { isLampBackgroundRun } from "@/lib/lamp-background-read";
import { verdictColor } from "@/components/ui";
import { formatUsd } from "@/lib/cost";

// ---------------------------------------------------------------------------
// Stage derivation
// ---------------------------------------------------------------------------

type StageId =
  | "reading"
  | "brief"
  | "videogen"
  | "checks"
  | "decide"
  | "remux";

/** Pipeline nodes in execution order, mapped to plain-English phases. */
const NODE_STAGES: Array<{ id: string; stage: StageId }> = [
  { id: "src", stage: "reading" },
  { id: "ingest", stage: "reading" },
  { id: "compile", stage: "brief" },
  { id: "videogen", stage: "videogen" },
  { id: "eval-identity", stage: "checks" },
  { id: "eval-skin", stage: "checks" },
  { id: "eval-appearance", stage: "checks" },
  { id: "eval-background", stage: "checks" },
  { id: "eval-lighting-delta", stage: "checks" },
  { id: "eval-motion", stage: "checks" },
  { id: "eval-temporal", stage: "checks" },
  { id: "eval-halluc", stage: "checks" },
  { id: "ledger", stage: "decide" },
  { id: "remux", stage: "remux" },
  { id: "eval-audio", stage: "remux" },
];

const BACKGROUND_NODE_STAGES: Array<{ id: string; stage: StageId }> = [
  { id: "plan", stage: "brief" },
  { id: "initial", stage: "videogen" },
  { id: "critique", stage: "checks" },
  { id: "final", stage: "videogen" },
  { id: "review", stage: "decide" },
];

/**
 * The furthest RUNNING node wins; if nothing is running (a beat between
 * nodes), fall back to the furthest settled node so the line never blanks.
 */
export function currentStage(run: Run): StageId {
  const stages = isLampBackgroundRun(run)
    ? BACKGROUND_NODE_STAGES
    : NODE_STAGES;
  let running: StageId | null = null;
  let settled: StageId | null = null;
  for (const { id, stage } of stages) {
    const status = run.nodeStates[id]?.status;
    if (status === "running") running = stage;
    else if (status === "succeeded" || status === "failed") settled = stage;
  }
  return running ?? settled ?? "reading";
}

/**
 * True once the run has reached the checks phase (or moved past it).
 * EvalList uses this so ten rows don't pulse through a 5-minute videogen.
 */
export function evalPhaseReached(run: Run): boolean {
  const stage = currentStage(run);
  return (
    stage === "checks" || stage === "decide" || stage === "remux"
  );
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

/** mm:ss for the videogen elapsed clock. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function CheckChips({
  results,
  definitions,
}: {
  results: EvalResult[];
  definitions: readonly EvalDefinition[];
}) {
  const landed = definitions.map((def) => ({
    def,
    result: results.find((r) => r.evalId === def.id),
  })).filter(
    (
      x
    ): x is {
      def: EvalDefinition;
      result: EvalResult;
    } => Boolean(x.result)
  );
  if (landed.length === 0) return null;
  return (
    <div className="flex max-w-md flex-wrap items-center justify-center gap-1.5">
      {landed.map(({ def, result }) => (
        <span
          key={def.id}
          className="flex items-center gap-1.5 rounded-full border border-edge px-2 py-0.5 text-2xs text-muted"
          style={{ background: "color-mix(in srgb, var(--canvas) 72%, transparent)" }}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: verdictColor(result.verdict) }}
          />
          {def.name}
          <span
            className="font-semibold tabular-nums"
            style={{ color: verdictColor(result.verdict) }}
          >
            {Math.round(result.score)}
          </span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The theater
// ---------------------------------------------------------------------------

export function GenerationTheater({ run }: { run: Run }) {
  const stage = currentStage(run);
  const background = isLampBackgroundRun(run);
  const wholeVideoCheckDefs = evalDefsForRun(run).filter(
    (definition) => definition.method !== "deterministic"
  );
  const pausedForApproval =
    run.serverExecution?.status === "user_action_required";
  const latest = run.iterations[run.iterations.length - 1];
  const attempt =
    run.nodeStates.final?.status === "running" ||
    run.nodeStates.final?.status === "succeeded"
      ? 2
      : (latest?.index ?? 1);

  // Videogen elapsed clock, ticking from the stage's own log entry.
  const videogenStartAt = useMemo(() => {
    for (let i = run.log.length - 1; i >= 0; i -= 1) {
      if (
        run.log[i].nodeId === "videogen" ||
        run.log[i].nodeId === "initial" ||
        run.log[i].nodeId === "final"
      ) {
        return run.log[i].at;
      }
    }
    return null;
  }, [run.log]);
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    if (stage !== "videogen") return;
    const timer = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage]);

  // "Attempt N failed K checks — compiling fixes…" when the gate sent us back.
  const previous =
    stage === "brief" && attempt >= 2
      ? run.iterations.find((it) => it.index === attempt - 1)
      : undefined;
  const prevFailedChecks = previous
    ? Math.max(
        previous.evalResults.filter((r) => r.verdict === "fail").length,
        previous.composite?.hardGateFailures.length ?? 0
      )
    : 0;

  let headline: string;
  let subline: string | null = null;
  switch (stage) {
    case "reading":
      headline = "Preparing the source video…";
      subline = "the original remains the reference for both generations";
      break;
    case "brief":
      if (previous) {
        headline = `The initial critique found ${prevFailedChecks} failed check${
          prevFailedChecks === 1 ? "" : "s"
        } — compiling the final prompt…`;
        subline = "the whole-video feedback gets one correction pass";
      } else {
        headline = background
          ? "Locking the approved cleanup plan…"
          : "Compiling the mega prompt…";
        subline = background
          ? "only approved removal targets may change"
          : "what may change and what must remain source-faithful";
      }
      break;
    case "videogen":
      headline =
        attempt >= 2
          ? "Regenerating the final video from the original…"
          : "Generating the initial video from the mega prompt…";
      subline = null; // rendered below with the elapsed clock
      break;
    case "checks":
      headline =
        attempt >= 2
          ? "Evaluating the final video as one complete result…"
          : "Critiquing the initial video as one complete result…";
      subline = null; // rendered below with the live count
      break;
    case "decide":
      headline =
        attempt >= 2
          ? "Saving the final AI evaluation…"
          : "Turning the critique into one final revision…";
      subline = `${background ? "Lamp Background" : "Lamp"} stops after the fixed second generation`;
      break;
    case "remux":
      headline = "Restoring and verifying the original audio…";
      subline = "provider sound is discarded; the canonical source track is verified";
      break;
  }
  if (pausedForApproval) {
    headline = `${background ? "Lamp Background" : "Lamp"} is safely paused for approval`;
    subline =
      "return to Create to renew the exact plan; completed provider work will be reused";
  }

  const landedCount = wholeVideoCheckDefs.filter((def) =>
    latest?.evalResults.some((r) => r.evalId === def.id)
  ).length;

  const notes = run.log.slice(-3);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-surface">
      {/* Lamp pass + live spend, top-right. */}
      <div className="absolute right-2 top-2 z-10 text-right text-2xs tabular-nums text-faint">
        {attempt >= 2 ? "final" : "initial"} video · v{attempt}
        {run.cost ? (
          <span>
            {" · "}
            {run.live
              ? `spent so far ${formatUsd(run.cost.actualUsd)}`
              : "mock — $0.00 spent"}
          </span>
        ) : null}
      </div>

      {/* Center stage. */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium leading-snug text-ink sm:text-base">
          {headline}
        </p>

        {stage === "videogen" && !pausedForApproval ? (
          <>
            <p className="text-2xs tabular-nums text-muted">
              typically 1–7 minutes
              {videogenStartAt !== null
                ? ` · ${fmtElapsed(nowTs - videogenStartAt)} elapsed`
                : ""}
            </p>
            <div className="mt-1 h-0.5 w-44 overflow-hidden rounded-full bg-raised">
              <div
                className="theater-sweep h-full w-2/5 rounded-full"
                style={{
                  background:
                    "linear-gradient(90deg, transparent, var(--running), transparent)",
                }}
              />
            </div>
          </>
        ) : null}

        {stage === "checks" && !pausedForApproval ? (
          <>
            <p className="text-2xs tabular-nums text-muted">
              {landedCount} of {wholeVideoCheckDefs.length} applicable visual
              results returned
            </p>
            {latest ? (
              <CheckChips
                results={latest.evalResults}
                definitions={wholeVideoCheckDefs}
              />
            ) : null}
          </>
        ) : null}

        {subline ? <p className="text-2xs text-muted">{subline}</p> : null}
      </div>

      {/* Engine notes — the honest raw feed for the curious. */}
      {notes.length > 0 ? (
        <div className="relative z-10 shrink-0 space-y-0.5 px-3 pb-2 text-left font-mono text-2xs text-faint">
          {notes.map((entry, i) => (
            <p
              key={`${entry.at}-${i}`}
              className="truncate"
              style={{ opacity: 0.4 + (i / Math.max(1, notes.length - 1)) * 0.6 }}
              title={entry.message}
            >
              {entry.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
