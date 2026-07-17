/**
 * The Journey step model: ONE run's actual story, flattened into a
 * left-to-right chain — not the abstract engine graph (that lives at
 * /pipeline). Steps are derived from live run state, so the chain's tail
 * grows as the engine executes.
 */

import type {
  Correction,
  FrameSample,
  Iteration,
  NodeRunStatus,
  Run,
} from "@/lib/types";
import { isTwoPassWorkflowMode, runWorkflowMode } from "@/lib/workflow-mode";

/** Visual tone of a chain step — drives tile accents and connector colors. */
export type StepTone = "running" | "pass" | "fail" | "warn" | "neutral";

interface StepBase {
  id: string;
  /** 2–3 word tile label. */
  label: string;
  /** Tiny secondary line under the label. */
  sub?: string;
  tone: StepTone;
  /** Frame thumbnail (canvas data URL) when one exists. */
  thumb?: string;
  /** Fallback glyph rendered when there is no thumbnail. */
  glyph: string;
}

export type JourneyStep =
  | (StepBase & { kind: "source" })
  | (StepBase & { kind: "manifest" })
  | (StepBase & { kind: "anchor" })
  | (StepBase & { kind: "attempt"; iteration: Iteration })
  | (StepBase & {
      kind: "corrections";
      prev: Iteration;
      next: Iteration;
      added: Correction[];
      resolved: Correction[];
    })
  | (StepBase & { kind: "fallback" })
  | (StepBase & { kind: "remux" })
  | (StepBase & { kind: "review" });

export function toneColor(tone: StepTone): string {
  switch (tone) {
    case "running":
      return "var(--running)";
    case "pass":
      return "var(--pass)";
    case "fail":
      return "var(--fail)";
    case "warn":
      return "var(--borderline)";
    default:
      return "var(--faint)";
  }
}

export function firstDataUrl(frames?: FrameSample[]): string | undefined {
  return frames?.find((f) => f.dataUrl)?.dataUrl;
}

function nodeTone(s: NodeRunStatus): StepTone {
  if (s === "running") return "running";
  if (s === "succeeded") return "pass";
  if (s === "failed") return "fail";
  return "neutral";
}

/**
 * Ledger diff between two adjacent attempts: clauses ADDED for `next`
 * (admitted at its prompt version) and clauses RESOLVED at that point
 * (active in `prev`, marked resolved in `next`).
 */
export function correctionsDiff(
  prev: Iteration,
  next: Iteration
): { added: Correction[]; resolved: Correction[] } {
  const mp = next.megaPrompt;
  const added = mp.corrections.filter(
    (c) => !c.resolved && c.addedAtIteration === mp.version
  );
  const resolved = mp.corrections.filter(
    (c) =>
      c.resolved &&
      prev.megaPrompt.corrections.some((p) => p.id === c.id && !p.resolved)
  );
  return { added, resolved };
}

/** Build the chain from live run state — steps appear as the engine reaches them. */
export function buildJourneySteps(run: Run): JourneyStep[] {
  const steps: JourneyStep[] = [];
  const twoPass = isTwoPassWorkflowMode(runWorkflowMode(run));
  const backgroundNoOp =
    runWorkflowMode(run) === "background" &&
    run.backgroundCleanupPlan?.approval.status === "approved" &&
    run.backgroundCleanupPlan.decision === "exceptional-no-op";
  const status = (nodeId: string): NodeRunStatus =>
    run.nodeStates[nodeId]?.status ?? "idle";
  const started = (nodeId: string): boolean => {
    const s = status(nodeId);
    return s === "running" || s === "succeeded" || s === "failed";
  };

  const firstIter = run.iterations[0] as Iteration | undefined;

  // Source (src + ingest folded into one quiet tile)
  steps.push({
    kind: "source",
    id: "source",
    label: "Source",
    sub: `${run.originalVideo.durationSec.toFixed(0)}s · ${run.originalVideo.width}×${run.originalVideo.height}`,
    tone:
      status("src") === "running" || status("ingest") === "running"
        ? "running"
        : status("src") === "succeeded"
          ? "pass"
          : "neutral",
    thumb: firstDataUrl(firstIter?.beforeFrames),
    glyph: "▸",
  });

  if (started("manifest")) {
    steps.push({
      kind: "manifest",
      id: "manifest",
      label: "Scene inventory",
      sub: "what's in the shot",
      tone: nodeTone(status("manifest")),
      glyph: "≡",
    });
  }

  if (started("anchor")) {
    steps.push({
      kind: "anchor",
      id: "anchor",
      label: "Look Anchor",
      sub:
        status("anchor-gate") === "succeeded"
          ? "approved lighting photo"
          : "target lighting photo",
      tone:
        status("anchor") === "running" || status("anchor-gate") === "running"
          ? "running"
          : status("anchor") === "failed" || status("anchor-gate") === "failed"
            ? "fail"
            : status("anchor") === "succeeded"
              ? "pass"
              : "neutral",
      thumb: firstIter?.relitKeyframeDataUrl,
      glyph: "◈",
    });
  }

  const ordered = [...run.iterations].sort((a, b) => a.index - b.index);
  for (const it of ordered) {
    const lampAudioVerified = it.evalResults.some(
      (result) => result.evalId === "audio-integrity" && result.verdict === "pass"
    );
    const prev = ordered.find((p) => p.index === it.index - 1);
    if (prev) {
      const { added, resolved } = correctionsDiff(prev, it);
      steps.push({
        kind: "corrections",
        id: `corrections-${it.index}`,
        label: added.length > 0 ? `Fixes +${added.length}` : "Fixes",
        sub:
          resolved.length > 0
            ? `${resolved.length} fixed`
            : added.length > 0
              ? "fix list updated"
              : "carried forward",
        tone: "neutral",
        glyph: added.length > 0 ? `+${added.length}` : "±0",
        prev,
        next: it,
        added,
        resolved,
      });
    }
    steps.push({
      kind: "attempt",
      id: `attempt-${it.index}`,
      label:
        backgroundNoOp
          ? "Exact source"
          : twoPass
          ? it.index === 1
            ? "Initial"
            : it.index === 2
              ? "Final"
              : `Video v${it.index}`
          : `Attempt v${it.index}`,
      sub:
        backgroundNoOp
          ? "approved no-op · no AI evaluation"
          : twoPass
          ? it.composite
            ? `${lampAudioVerified ? "audio verified · " : ""}${it.index === 1 ? "critique" : "final AI"} ${it.composite.score}`
            : it.generatedVideo
              ? "waiting for whole-video evaluation"
              : "generating…"
          : it.composite
            ? `score ${it.composite.score}`
            : it.status === "ungraded"
              ? "awaiting your grade"
              : "generating…",
      tone:
        it.status === "running"
          ? "running"
          : it.status === "passed"
            ? "pass"
            : it.status === "ungraded"
              ? "warn"
              : "fail",
      thumb: firstDataUrl(it.afterFrames) ?? it.relitKeyframeDataUrl,
      glyph: "▶",
      iteration: it,
    });
  }

  if (run.fallback?.applied || status("fallback") === "running") {
    steps.push({
      kind: "fallback",
      id: "fallback",
      label: "Safe fallback",
      sub: "lighting copied over",
      tone: status("fallback") === "running" ? "running" : "warn",
      glyph: "≈",
    });
  }

  // Each Lamp Initial/Final tile represents its complete fixed pass:
  // generation -> source-audio finalization -> holistic evaluation. A single
  // trailing remux tile would falsely imply audio happens only after Final.
  if (started("remux") && !twoPass) {
    steps.push({
      kind: "remux",
      id: "remux",
      label: "Audio restored",
      sub:
        "original track verified",
      tone: nodeTone(status("remux")),
      glyph: "∿",
    });
  }

  if (started("review")) {
    steps.push({
      kind: "review",
      id: "review",
      label: "Review",
      sub: run.review
        ? run.review.decision === "approved"
          ? "approved"
          : "needs changes"
        : "needs your review",
      tone: run.review
        ? run.review.decision === "approved"
          ? "pass"
          : "fail"
        : "warn",
      glyph: "⚑",
    });
  }

  return steps;
}
