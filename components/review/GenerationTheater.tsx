"use client";

/**
 * GenerationTheater — the relit slot of the hero while a run is mid-flight.
 * Instead of a flat "generating…" placeholder it narrates the machine: one
 * big plain-English stage line derived from nodeStates, the Look Anchor as a
 * backdrop the moment it exists, live check-chips as eval results land, an
 * elapsed clock during video generation, and a quiet monospace ticker of the
 * last few engine notes. Mission control, not a loading gif.
 */

import { useEffect, useMemo, useState } from "react";
import type { EvalResult, Run } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { verdictColor } from "@/components/ui";
import { formatUsd } from "@/lib/cost";

// ---------------------------------------------------------------------------
// Stage derivation
// ---------------------------------------------------------------------------

type StageId =
  | "reading"
  | "anchor"
  | "brief"
  | "videogen"
  | "checks"
  | "decide"
  | "fallback"
  | "remux";

/** Pipeline nodes in execution order, mapped to plain-English phases. */
const NODE_STAGES: Array<{ id: string; stage: StageId }> = [
  { id: "src", stage: "reading" },
  { id: "ingest", stage: "reading" },
  { id: "manifest", stage: "reading" },
  { id: "anchor", stage: "anchor" },
  { id: "anchor-gate", stage: "anchor" },
  { id: "compile", stage: "brief" },
  { id: "videogen", stage: "videogen" },
  { id: "conform", stage: "checks" },
  { id: "eval-align", stage: "checks" },
  { id: "sample", stage: "checks" },
  { id: "eval-identity", stage: "checks" },
  { id: "eval-skin", stage: "checks" },
  { id: "eval-appearance", stage: "checks" },
  { id: "eval-background", stage: "checks" },
  { id: "eval-lighting-delta", stage: "checks" },
  { id: "eval-lighting-anchor", stage: "checks" },
  { id: "eval-motion", stage: "checks" },
  { id: "eval-temporal", stage: "checks" },
  { id: "eval-halluc", stage: "checks" },
  { id: "ledger", stage: "decide" },
  { id: "gate", stage: "decide" },
  { id: "fallback", stage: "fallback" },
  { id: "remux", stage: "remux" },
  { id: "eval-audio", stage: "remux" },
];

/**
 * The furthest RUNNING node wins; if nothing is running (a beat between
 * nodes), fall back to the furthest settled node so the line never blanks.
 */
export function currentStage(run: Run): StageId {
  let running: StageId | null = null;
  let settled: StageId | null = null;
  for (const { id, stage } of NODE_STAGES) {
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
    stage === "checks" || stage === "decide" || stage === "fallback" || stage === "remux"
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

/** Checks judged at gate time: everything except the post-remux audio check. */
const GATE_CHECK_DEFS = EVAL_DEFS.filter((d) => d.id !== "audio-integrity");

function CheckChips({ results }: { results: EvalResult[] }) {
  const landed = GATE_CHECK_DEFS.map((def) => ({
    def,
    result: results.find((r) => r.evalId === def.id),
  })).filter((x): x is { def: (typeof GATE_CHECK_DEFS)[number]; result: EvalResult } =>
    Boolean(x.result)
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
  const maxIterations = useAppStore((s) => s.workflow.config.maxIterations);

  const stage = currentStage(run);
  const latest = run.iterations[run.iterations.length - 1];
  const attempt = latest?.index ?? 1;
  const anchorUrl = latest?.relitKeyframeDataUrl;

  // Videogen elapsed clock, ticking from the stage's own log entry.
  const videogenStartAt = useMemo(() => {
    for (let i = run.log.length - 1; i >= 0; i -= 1) {
      if (run.log[i].nodeId === "videogen") return run.log[i].at;
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
  const prevFailedChecks = previous?.composite?.passed === false
    ? Math.max(
        previous.evalResults.filter((r) => r.verdict === "fail").length,
        previous.composite.hardGateFailures.length
      )
    : 0;

  let headline: string;
  let subline: string | null = null;
  switch (stage) {
    case "reading":
      headline = "Reading the scene…";
      subline = "taking the inventory every check will judge against";
      break;
    case "anchor":
      headline = "Designing the light on one photo…";
      subline = anchorUrl
        ? "this still is the look the whole video must match"
        : "one cheap still before any video spend";
      break;
    case "brief":
      if (previous && previous.composite && !previous.composite.passed) {
        headline = `Attempt ${previous.index} failed ${prevFailedChecks} check${
          prevFailedChecks === 1 ? "" : "s"
        } — compiling fixes into brief v${attempt}…`;
        subline = "what went wrong becomes explicit instructions, nothing else changes";
      } else {
        headline = "Compiling the generation brief…";
        subline = "what must change, what must not — one exact set of instructions";
      }
      break;
    case "videogen":
      headline = "Omni Flash is repainting every frame under the approved light…";
      subline = null; // rendered below with the elapsed clock
      break;
    case "checks":
      headline = "The 10 checks are watching both videos…";
      subline = null; // rendered below with the live count
      break;
    case "decide":
      headline = "Deciding: ship it or fix and retry…";
      subline = "every must-pass check has to be green";
      break;
    case "fallback":
      headline = "Applying the safe fallback — your original pixels, new lighting…";
      subline = "generation couldn't pass every check, so nothing is regenerated";
      break;
    case "remux":
      headline = "Restoring your original audio…";
      subline = "stream-copied back and verified bit-for-bit";
      break;
  }

  const landedCount = GATE_CHECK_DEFS.filter((def) =>
    latest?.evalResults.some((r) => r.evalId === def.id)
  ).length;

  const notes = run.log.slice(-3);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-surface">
      {/* Look Anchor teaser — the backdrop the moment it exists. */}
      {anchorUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- pipeline artifact, not an optimizable asset */}
          <img
            src={anchorUrl}
            alt="approved look anchor"
            className={`absolute inset-0 h-full w-full object-cover ${
              stage === "anchor" ? "opacity-60" : "opacity-30"
            }`}
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to top, var(--canvas) 8%, color-mix(in srgb, var(--canvas) 55%, transparent) 55%, color-mix(in srgb, var(--canvas) 35%, transparent))",
            }}
          />
        </>
      ) : null}

      {/* Attempt + live spend, top-right (the RELIT tag owns top-left). */}
      <div className="absolute right-2 top-2 z-10 text-right text-2xs tabular-nums text-faint">
        attempt {attempt} of {maxIterations}
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

        {stage === "videogen" ? (
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

        {stage === "checks" ? (
          <>
            <p className="text-2xs tabular-nums text-muted">
              {landedCount} of {GATE_CHECK_DEFS.length} verdicts in
            </p>
            {latest ? <CheckChips results={latest.evalResults} /> : null}
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
