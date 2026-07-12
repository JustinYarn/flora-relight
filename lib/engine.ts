"use client";

/**
 * Run engine: executes RELIGHT_WORKFLOW against the mock providers and
 * drives the zustand store immutably so the canvas and inspector live-update.
 *
 * Structure mirrors the real pipeline:
 *   ingest (audio hashed out of the generative path) → manifest → Stage A
 *   look anchor → per-iteration loop (compile → generate → conform/align →
 *   sample → 9 dual-judged visual evals → ledger → gate) → remux + audio
 *   check → human review. Exhaustion routes to the color-transfer fallback.
 */

import { useAppStore } from "@/lib/store";
import { getProviders, type LiveRunContext } from "@/lib/providers";
import { postJson } from "@/lib/providers/live-gemini";
import {
  encodeScenarioIteration,
  getScenarioIteration,
  getScenarioOutcome,
  MOCK_MANIFEST,
} from "@/lib/mock/scenario";
import { RELIGHT_WORKFLOW } from "@/lib/workflow-def";
import { estimateRun, formatUsd, judgeCallUsd, PRICE_TABLE } from "@/lib/cost";
import { getEvalDef } from "@/lib/prompts/eval-defs";
import { RELIGHT_BASE_PROMPT } from "@/lib/prompts/base-prompt";
import { initialMegaPrompt, nextMegaPrompt } from "@/lib/prompts/mega-prompt";
import { extractFrames } from "@/lib/frames";
import { clamp, LOW_CONFIDENCE, sleep, uid, verdictFor } from "@/lib/util";
import type {
  EvalDefinition,
  EvalResult,
  FrameSample,
  Iteration,
  JudgeRequest,
  JudgeVerdict,
  MegaPrompt,
  NodeRunStatus,
  Run,
  RunLogEntry,
  ScenarioEvalOutcome,
  SceneManifest,
  VideoAsset,
  Violation,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Store plumbing (every write replaces the Run with a fresh copy)
// ---------------------------------------------------------------------------

function mutateRun(runId: string, fn: (draft: Run) => void): void {
  useAppStore.setState((state) => ({
    runs: state.runs.map((r) => {
      if (r.id !== runId) return r;
      const draft = structuredClone(r);
      fn(draft);
      return draft;
    }),
  }));
}

function getRun(runId: string): Run | undefined {
  return useAppStore.getState().runs.find((r) => r.id === runId);
}

function log(
  runId: string,
  level: RunLogEntry["level"],
  message: string,
  nodeId?: string
): void {
  mutateRun(runId, (r) => {
    r.log.push({ at: Date.now(), nodeId, level, message });
  });
}

function setNode(
  runId: string,
  nodeId: string,
  status: NodeRunStatus,
  detail?: string
): void {
  mutateRun(runId, (r) => {
    r.nodeStates[nodeId] = { nodeId, status, detail };
  });
}

function patchIteration(
  runId: string,
  index: number,
  fn: (it: Iteration) => void
): void {
  mutateRun(runId, (r) => {
    const it = r.iterations.find((x) => x.index === index);
    if (it) fn(it);
  });
}

function pushEvalResult(runId: string, index: number, result: EvalResult): void {
  patchIteration(runId, index, (it) => {
    it.evalResults.push(result);
  });
}

/**
 * Record provider calls in the run's cost ledger. MOCK MODE: these are
 * would-be costs — every item lands with estimated:true and actualUsd stays
 * 0. LIVE MODE: this is the single place the real adapters will flip — push
 * the same items with estimated:false and accrue r.cost.actualUsd += usd as
 * each billed call returns.
 */
function recordCost(
  runId: string,
  ...entries: Array<{ label: string; usd: number }>
): void {
  mutateRun(runId, (r) => {
    if (!r.cost) return;
    for (const e of entries) r.cost.items.push({ ...e, estimated: true });
  });
}

/** LIVE MODE: real billed spend — items land estimated:false and accrue actualUsd. */
function recordActualCost(
  runId: string,
  ...entries: Array<{ label: string; usd: number }>
): void {
  mutateRun(runId, (r) => {
    if (!r.cost) return;
    for (const e of entries) {
      r.cost.items.push({ ...e, estimated: false });
      r.cost.actualUsd += e.usd;
    }
  });
}

/** Best-of tracking: the loop returns the best iteration, never the last. */
function updateBestIteration(runId: string): void {
  mutateRun(runId, (r) => {
    let best: number | undefined;
    let bestScore = -Infinity;
    for (const it of r.iterations) {
      if (it.composite && it.composite.score > bestScore) {
        bestScore = it.composite.score;
        best = it.index;
      }
    }
    r.bestIterationIndex = best;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic fake SHA-256 hex — stands in for the real ffmpeg/crypto hash. */
function pseudoSha256(seedStr: string): string {
  let h = 2166136261;
  let out = "";
  for (let i = 0; out.length < 64; i++) {
    h ^= seedStr.charCodeAt(i % seedStr.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    out += (h & 0xff).toString(16).padStart(2, "0");
  }
  return out.slice(0, 64);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Short, safe error text for run logs (no stacks, no env details). */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * LIVE MODE Stage-A instruction: derived from the immutable base prompt —
 * the task framing plus the full lighting specification, scoped to a single
 * frame. The Scene Manifest is deliberately NOT rendered here (pink-elephant
 * discipline, same as the video prompt).
 */
function liveAnchorInstruction(): string {
  const l = RELIGHT_BASE_PROMPT.lighting;
  return [
    `Relight this single video frame. ${RELIGHT_BASE_PROMPT.task}`,
    "",
    "Apply exactly this lighting specification:",
    `Style: ${l.style}`,
    `Key light: ${l.keyLight}`,
    `Fill light: ${l.fillLight}`,
    `Rim light: ${l.rimLight}`,
    `Color temperature: ${l.colorTemperature}`,
    `Mood: ${l.mood}`,
    "",
    "Change illumination and color response only — do not alter the person, wardrobe, background, or framing.",
  ].join("\n");
}

/** Merge N judge verdicts into one EvalResult (measured confidence). */
function aggregateJudges(
  def: EvalDefinition,
  iteration: number,
  judgeVerdicts: JudgeVerdict[],
  prevResults: EvalResult[]
): EvalResult {
  const score = round1(
    judgeVerdicts.reduce((sum, v) => sum + v.score, 0) / judgeVerdicts.length
  );
  const scores = judgeVerdicts.map((v) => v.score);
  const spread =
    judgeVerdicts.length > 1 ? Math.max(...scores) - Math.min(...scores) : 0;
  const confidence = clamp(1 - spread / 25, 0.15, 0.98);

  // Union of violations, deduped by aspect (Claude reports all, Gemini drops minors).
  const seen = new Set<string>();
  const violations: Violation[] = [];
  for (const v of judgeVerdicts.flatMap((jv) => jv.violations)) {
    if (!seen.has(v.aspect)) {
      seen.add(v.aspect);
      violations.push(v);
    }
  }

  let verdict = verdictFor(score, def.passThreshold, def.borderlineThreshold);
  // Low measured confidence can never upgrade a fail, but it demotes a pass:
  // when the judges disagree this much, a human should look.
  if (confidence < LOW_CONFIDENCE && verdict === "pass") verdict = "borderline";

  const prev = prevResults.find((r) => r.evalId === def.id);
  return {
    evalId: def.id,
    iteration,
    verdicts: judgeVerdicts,
    score,
    confidence,
    verdict,
    violations,
    deltaFromPrevious: prev ? round1(score - prev.score) : undefined,
  };
}

/** Deterministic eval (temporal-alignment, audio-integrity): no judges, confidence 1. */
function deterministicResult(
  evalId: string,
  iteration: number,
  outcome: ScenarioEvalOutcome | undefined,
  prevResults: EvalResult[]
): EvalResult {
  const def = getEvalDef(evalId);
  const score = outcome?.score ?? 100;
  const prev = prevResults.find((r) => r.evalId === evalId);
  return {
    evalId,
    iteration,
    verdicts: [],
    score,
    confidence: 1,
    verdict: verdictFor(score, def.passThreshold, def.borderlineThreshold),
    violations: outcome ? outcome.violations.map((v) => ({ ...v })) : [],
    deltaFromPrevious: prev ? round1(score - prev.score) : undefined,
  };
}

/**
 * Weighted-mean composite, normalized by the weight actually present, so
 * gate-time composites (audio-integrity absent — 0.98 of total weight) and
 * post-remux composites (all evals present) are on the same 0-100 basis.
 */
function computeComposite(results: EvalResult[]): {
  score: number;
  hardGateFailures: string[];
} {
  let weighted = 0;
  let totalWeight = 0;
  const hardGateFailures: string[] = [];
  for (const r of results) {
    const def = getEvalDef(r.evalId);
    weighted += def.weight * r.score;
    totalWeight += def.weight;
    if (def.hardGate && r.verdict !== "pass") hardGateFailures.push(r.evalId);
  }
  return {
    score: round1(totalWeight > 0 ? weighted / totalWeight : 0),
    hardGateFailures,
  };
}

const VISUAL_EVALS: Array<{ nodeId: string; evalId: string }> = [
  { nodeId: "eval-identity", evalId: "identity-preservation" },
  { nodeId: "eval-skin", evalId: "skin-texture-age" },
  { nodeId: "eval-appearance", evalId: "appearance-fidelity" },
  { nodeId: "eval-background", evalId: "background-fidelity" },
  { nodeId: "eval-lighting-delta", evalId: "lighting-quality-delta" },
  { nodeId: "eval-lighting-anchor", evalId: "lighting-match-to-anchor" },
  { nodeId: "eval-motion", evalId: "motion-lipsync" },
  { nodeId: "eval-temporal", evalId: "temporal-stability" },
  { nodeId: "eval-halluc", evalId: "hallucination-artifacts" },
];

/** Nodes reset to "queued" when the gate feeds corrections back. */
const LOOP_NODES = [
  "compile",
  "videogen",
  "conform",
  "eval-align",
  "sample",
  ...VISUAL_EVALS.map((e) => e.nodeId),
  "ledger",
  "gate",
];

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export async function runWorkflow(
  runId: string,
  opts?: { instant?: boolean }
): Promise<void> {
  const instant = opts?.instant === true;
  const pace = async (minMs = 400, maxMs = 900): Promise<void> => {
    if (!instant) await sleep(minMs + Math.random() * (maxMs - minMs));
  };

  const run0 = getRun(runId);
  if (!run0) return;
  const original = run0.originalVideo;
  const config = RELIGHT_WORKFLOW.config;
  // The instant demo run is mock by definition (synthetic clip, zero-latency
  // replay); everything else follows the store's hydrated mode.
  const mode: "mock" | "live" = instant ? "mock" : useAppStore.getState().mode;
  const live = mode === "live";
  const liveCtx: LiveRunContext | undefined = live
    ? {
        runId,
        beforeUrl: original.url,
        onCost: (label, usd) => recordActualCost(runId, { label, usd }),
      }
    : undefined;
  const providers = live
    ? getProviders("live", { live: liveCtx })
    : getProviders("mock", { instant });

  // Fail BEFORE any paid call: the video model accepts at most 10s. Clips that
  // went through /api/ingest are auto-trimmed to 9.9s; anything else (or a bad
  // probe) must be caught here, not after the anchor has already billed.
  if (live && original.durationSec > 10.05) {
    log(
      runId,
      "error",
      `Clip is ${original.durationSec.toFixed(2)}s — the video model accepts at most 10s. ` +
        `Upload it through the Studio dropzone so it gets auto-trimmed, then run again. ` +
        `Nothing was spent on this run.`
    );
    mutateRun(runId, (r) => {
      r.status = "failed";
    });
    return;
  }
  /** Live mode: per-iteration audio verification results from the videogen route. */
  const audioVerifiedByIteration = new Map<number, boolean>();
  // Per-video scripted story: scenarioForVideo(original.id) picks the variant.
  // Batch runs execute concurrently, so the variant travels to the shared mock
  // providers INSIDE the iteration number (see lib/mock/scenario.ts) instead
  // of through shared mutable state. enc(i) for the classic variant equals i.
  const enc = (iteration: number): number =>
    encodeScenarioIteration(original.id, iteration);

  // Cost ledger: the pre-flight estimate of what this run WOULD cost against
  // live APIs. Items accrue at each provider call site below via recordCost().
  mutateRun(runId, (r) => {
    if (live) r.live = true;
    r.cost = {
      estimatedUsd: estimateRun(original.durationSec).totalUsd,
      actualUsd: 0,
      items: [],
    };
  });

  try {
    // --- src -------------------------------------------------------------
    setNode(runId, "src", "running");
    log(
      runId,
      "info",
      `Source locked: ${original.label} — ${original.durationSec.toFixed(1)}s, ${original.width}×${original.height}, audio ${original.hasAudio ? "present" : "absent"}`,
      "src"
    );
    await pace(250, 500);
    setNode(
      runId,
      "src",
      "succeeded",
      `${original.durationSec.toFixed(0)}s · ${original.width}×${original.height}`
    );

    // --- ingest & demux ----------------------------------------------------
    setNode(runId, "ingest", "running");
    await pace();
    let audioHash = "";
    if (live) {
      log(
        runId,
        "info",
        "Audio path sealed: the generative API never receives audio — the original stream is demuxed server-side, remuxed after generation, and verified bit-exact per iteration",
        "ingest"
      );
      setNode(runId, "ingest", "succeeded", "audio sealed out of gen path");
    } else {
      audioHash = pseudoSha256(`${original.id}:audio-stream`);
      log(
        runId,
        "info",
        `Audio demuxed and hashed — SHA-256 ${audioHash.slice(0, 16)}… (stream is sealed out of the generative path)`,
        "ingest"
      );
      setNode(runId, "ingest", "succeeded", "audio split + hashed");
    }

    // --- scene manifest ----------------------------------------------------
    setNode(runId, "manifest", "running");
    await pace();
    if (live) {
      try {
        const res = await postJson<{ manifest: SceneManifest; costUsd: number }>(
          "/api/live/manifest",
          { sourceUrl: original.url },
          4 * 60_000
        );
        mutateRun(runId, (r) => {
          r.manifest = res.manifest;
        });
        recordActualCost(runId, {
          label: "Scene manifest extraction (Gemini)",
          usd: res.costUsd,
        });
        const m = res.manifest;
        log(
          runId,
          "info",
          `Scene manifest extracted by Gemini — ${(m.person?.clothing?.length ?? 0) + (m.person?.accessories?.length ?? 0)} wardrobe items, ${m.background?.objects?.length ?? 0} background objects. Ground truth for evals, not prompt filler.`,
          "manifest"
        );
      } catch (err) {
        // Manifest is eval ground truth, not a generation input — a failed
        // extraction degrades evals but should not kill the run.
        log(
          runId,
          "warn",
          `Live manifest extraction failed (${errText(err)}) — falling back to the mock manifest and continuing`,
          "manifest"
        );
        mutateRun(runId, (r) => {
          r.manifest = MOCK_MANIFEST;
        });
      }
      setNode(runId, "manifest", "succeeded", "inventory locked");
    } else {
      mutateRun(runId, (r) => {
        r.manifest = MOCK_MANIFEST;
      });
      recordCost(runId, {
        label: "Scene manifest extraction (Gemini)",
        usd: PRICE_TABLE.geminiManifestPerCall.usd,
      });
      log(
        runId,
        "info",
        `Scene manifest extracted — ${MOCK_MANIFEST.person.clothing.length + MOCK_MANIFEST.person.accessories.length} wardrobe items, ${MOCK_MANIFEST.background.objects.length} background objects. Ground truth for evals, not prompt filler.`,
        "manifest"
      );
      setNode(runId, "manifest", "succeeded", "inventory locked");
    }

    // --- Stage A: look anchor ------------------------------------------------
    let anchorDataUrl: string | undefined;
    if (config.keyframeFirst && live) {
      const anchorT = config.frameTimestamps[0] ?? 0.5;
      setNode(runId, "anchor", "running");
      log(runId, "info", `Stage A: extracting reference frame at t=${anchorT}s`, "anchor");
      let refFrameDataUrl: string | undefined;
      try {
        const [refFrame] = await extractFrames(original.url, [anchorT]);
        refFrameDataUrl = refFrame?.dataUrl;
      } catch {
        refFrameDataUrl = undefined;
      }
      if (refFrameDataUrl) {
        // A live relight failure is a real provider error — let it fail the
        // run (no silent fallback mid-run). Cost accrues via liveCtx.onCost.
        const relit = await providers.imageGen.relight({
          frameDataUrl: refFrameDataUrl,
          prompt: liveAnchorInstruction(),
          iteration: 1,
        });
        anchorDataUrl = relit.imageDataUrl;
        log(
          runId,
          "info",
          `Look Anchor rendered LIVE by Gemini image edit in ${(relit.latencyMs / 1000).toFixed(1)}s — cheap iteration before any video spend`,
          "anchor"
        );
        setNode(runId, "anchor", "succeeded", "look anchor ready");
      } else {
        log(
          runId,
          "warn",
          "Frame extraction unavailable in this environment — continuing without an anchor (no still-tier conditioning or anchor-match reference)",
          "anchor"
        );
        setNode(runId, "anchor", "succeeded", "no anchor — continuing");
      }

      // --- anchor gate ---------------------------------------------------------
      setNode(runId, "anchor-gate", "running");
      await pace();
      log(
        runId,
        "info",
        "anchor auto-approved — still-tier anchor judge not yet implemented in live mode (TODO)",
        "anchor-gate"
      );
      setNode(runId, "anchor-gate", "succeeded", "auto-approved");
    } else if (config.keyframeFirst) {
      setNode(runId, "anchor", "running");
      log(runId, "info", "Stage A: extracting reference frame at t=0.5s", "anchor");
      try {
        const [refFrame] = await extractFrames(original.url, [0.5]);
        if (refFrame?.dataUrl) {
          const relit = await providers.imageGen.relight({
            frameDataUrl: refFrame.dataUrl,
            prompt:
              "Relight this frame to a soft three-point studio look. Change illumination only — do not alter the person, wardrobe, background, or framing.",
            iteration: enc(1),
          });
          anchorDataUrl = relit.imageDataUrl;
        }
      } catch {
        log(
          runId,
          "warn",
          "Frame extraction unavailable — continuing without an anchor preview (mock)",
          "anchor"
        );
      }
      recordCost(runId, {
        label: "Look Anchor relight (Gemini image edit)",
        usd: PRICE_TABLE.geminiImageEditPerImage.usd,
      });
      log(
        runId,
        "info",
        "Look Anchor rendered at still tier (Gemini mock) — cheap iteration before any video spend",
        "anchor"
      );
      setNode(runId, "anchor", "succeeded", "look anchor ready");

      // --- anchor gate ---------------------------------------------------------
      setNode(runId, "anchor-gate", "running");
      await pace();
      recordCost(runId, {
        label: "Anchor check (still-tier judge)",
        usd: PRICE_TABLE.geminiJudgePerCall.usd,
      });
      log(runId, "info", "anchor approved — identity verified at still tier", "anchor-gate");
      setNode(runId, "anchor-gate", "succeeded", "approved");
    } else {
      setNode(runId, "anchor", "skipped");
      setNode(runId, "anchor-gate", "skipped");
      log(
        runId,
        "info",
        "Stage A disabled by config — generating without anchor conditioning",
        "anchor"
      );
    }

    // --- iteration loop --------------------------------------------------------
    let beforeFramesCache: FrameSample[] | undefined;
    let seed = 133742; // pinned while refining; rotated only on repeated violations
    let prevMegaPrompt: MegaPrompt | undefined;
    let prevResults: EvalResult[] = [];
    let prevComposite: number | undefined;
    let plateauStrikes = 0;
    let passedIteration: number | undefined;
    let exhaustReason: string | undefined;

    for (let i = 1; i <= config.maxIterations; i++) {
      const scenarioIter = live ? null : getScenarioIteration(enc(i));

      // compile
      setNode(runId, "compile", "running");
      const megaPrompt =
        i === 1 || !prevMegaPrompt
          ? initialMegaPrompt()
          : nextMegaPrompt(prevMegaPrompt, prevResults);
      const activeCorrections = megaPrompt.corrections.filter((c) => !c.resolved).length;
      mutateRun(runId, (r) => {
        r.iterations.push({
          index: i,
          megaPrompt,
          relitKeyframeDataUrl: anchorDataUrl,
          beforeFrames: [],
          afterFrames: [],
          evalResults: [],
          status: "running",
        });
      });
      log(
        runId,
        "info",
        `Mega prompt v${megaPrompt.version} compiled — ${activeCorrections} active correction${activeCorrections === 1 ? "" : "s"} from the constraint ledger`,
        "compile"
      );
      await pace();
      setNode(runId, "compile", "succeeded", `v${megaPrompt.version} · ${activeCorrections} corrections`);

      // videogen
      setNode(runId, "videogen", "running", `iteration ${i} · seed ${seed}`);
      log(
        runId,
        "info",
        live
          ? `Omni Flash generating iteration ${i} LIVE — regenerating from the ORIGINAL video${liveCtx?.videoInteractionId ? `, chained to the previous generation turn (${liveCtx.videoInteractionId.slice(0, 12)}…)` : ""}. This blocks for 1-7 minutes.`
          : `Omni (mock) generating iteration ${i} — regenerating from the ORIGINAL video, seed ${seed} pinned${anchorDataUrl ? ", anchor as first-frame conditioning" : ""}`,
        "videogen"
      );
      const gen = await providers.videoGen.generate({
        originalVideo: original,
        megaPrompt,
        conditioningFrameDataUrl: anchorDataUrl,
        seed,
        iteration: live ? i : enc(i),
      });
      // The mock echoes the encoded iteration in its label — restore the
      // human-facing 1-based index before storing. Live labels are correct.
      const genVideo: VideoAsset = live
        ? gen.video
        : { ...gen.video, label: `Omni generation v${i}` };
      patchIteration(runId, i, (it) => {
        it.generatedVideo = genVideo;
        // Live: THIS iteration's videogen interaction id — the next
        // iteration's correction turn chains on it (anchor chain is separate).
        if (live && liveCtx?.lastVideogen) {
          it.interactionId = liveCtx.lastVideogen.interactionId;
        }
      });
      if (live) {
        const verified = liveCtx?.lastVideogen?.audioVerified ?? false;
        audioVerifiedByIteration.set(i, verified);
        log(
          runId,
          "info",
          `Generation v${i} returned in ${(gen.latencyMs / 1000).toFixed(1)}s — model audio discarded, original audio remuxed server-side (${verified ? "stream verified bit-exact" : "stream verification FAILED — audio gate will go red"})`,
          "videogen"
        );
      } else {
        recordCost(runId, {
          label: `Video generation v${i} (${original.durationSec.toFixed(0)}s)`,
          usd: original.durationSec * PRICE_TABLE.omniFlashPerOutputSecond.usd,
        });
        log(
          runId,
          "info",
          `Generation v${i} returned in ${(gen.latencyMs / 1000).toFixed(1)}s (no audio track — by construction)`,
          "videogen"
        );
      }
      setNode(runId, "videogen", "succeeded", `v${i} · ${(gen.latencyMs / 1000).toFixed(1)}s`);

      // conform
      setNode(runId, "conform", "running");
      await pace();
      log(runId, "info", "Stream conformed — fps, timebase, and dimensions normalized", "conform");
      setNode(runId, "conform", "succeeded", "indices comparable");

      // deterministic temporal-alignment gate (before any comparison eval)
      setNode(runId, "eval-align", "running");
      await pace(200, 400);
      const alignResult = deterministicResult(
        "temporal-alignment",
        i,
        live ? undefined : getScenarioOutcome(enc(i), "temporal-alignment"),
        prevResults
      );
      pushEvalResult(runId, i, alignResult);
      log(
        runId,
        live ? "warn" : "info",
        live
          ? `Temporal alignment: deterministic alignment metric not yet implemented — assumed aligned (TODO). Scored ${alignResult.score} pending the pHash/edge-correlation implementation.`
          : `Temporal alignment: pHash/edge correlation peaks at offset 0 — score ${alignResult.score}. Index-locked comparisons are trustworthy.`,
        "eval-align"
      );
      setNode(
        runId,
        "eval-align",
        alignResult.verdict === "pass" ? "succeeded" : "failed",
        `${alignResult.score} · ${alignResult.verdict}`
      );

      // sample
      setNode(runId, "sample", "running");
      let beforeFrames: FrameSample[] = config.frameTimestamps.map((t) => ({
        timestampSec: t,
      }));
      let afterFrames: FrameSample[] = config.frameTimestamps.map((t) => ({
        timestampSec: t,
      }));
      try {
        if (!beforeFramesCache) {
          beforeFramesCache = await extractFrames(original.url, config.frameTimestamps);
        }
        beforeFrames = beforeFramesCache.map((f) => ({ ...f }));
        // Live: sample the ACTUAL generated file — no CSS filter simulation.
        afterFrames = live
          ? await extractFrames(genVideo.url, config.frameTimestamps)
          : await extractFrames(
              original.url,
              config.frameTimestamps,
              scenarioIter?.simulatedFilter
            );
      } catch {
        log(
          runId,
          "warn",
          "Frame extraction unavailable in this environment — evals proceed on timestamps only",
          "sample"
        );
      }
      patchIteration(runId, i, (it) => {
        it.beforeFrames = beforeFrames;
        it.afterFrames = afterFrames;
      });
      log(
        runId,
        "info",
        `Sampled ${config.frameTimestamps.length} matched before/after frame pairs at fixed percentiles`,
        "sample"
      );
      setNode(runId, "sample", "succeeded", `${config.frameTimestamps.length}×2 frames`);

      // 9 visual evals, dual-judged, staggered
      if (live && liveCtx) liveCtx.afterUrl = genVideo.url;
      for (const { nodeId } of VISUAL_EVALS) setNode(runId, nodeId, "queued");
      const iterationResults: EvalResult[] = [alignResult];
      /** Hard-gate checks that could not be judged at all — forces human review. */
      const unjudgedGates: string[] = [];
      // Live judging runs through a small worker pool: 18 simultaneous judge
      // fetches stampede the dev server, queue behind the shared video upload,
      // and blow the fetch timeout — one slow judge must never cost the run.
      const evalQueue = VISUAL_EVALS.map(
        (entry, k) => [k, entry] as [number, { nodeId: string; evalId: string }]
      );
      const POOL = live ? 3 : VISUAL_EVALS.length;
      const judgeOnce = async (
        j: (typeof config.judges)[number],
        req: JudgeRequest
      ) => {
        try {
          return await providers.judges[j].judge(req);
        } catch {
          // one retry — transient timeouts under load are the common case
          try {
            return await providers.judges[j].judge(req);
          } catch (err) {
            log(
              runId,
              "warn",
              `${j} judge failed twice on ${req.evalDef.name} (${err instanceof Error ? err.message : "error"}) — continuing without it`
            );
            return null;
          }
        }
      };
      const runOneEval = async ({ nodeId, evalId }: { nodeId: string; evalId: string }, k: number) => {
          if (!instant) await sleep(150 * k + 200 + Math.random() * 300);
          setNode(runId, nodeId, "running");
          const def = getEvalDef(evalId);
          const req = {
            evalDef: def,
            iteration: live ? i : enc(i),
            beforeFrames,
            afterFrames,
            // Approved Stage-A look for THIS iteration — the labeled reference
            // input the lighting-match-to-anchor rubric judges against.
            anchorFrameDataUrl: anchorDataUrl,
          };
          const judgeVerdicts = (
            await Promise.all(config.judges.map((j) => judgeOnce(j, req)))
          ).filter((v): v is NonNullable<typeof v> => v !== null);
          if (judgeVerdicts.length === 0) {
            if (def.hardGate) unjudgedGates.push(def.name);
            log(
              runId,
              "error",
              `${def.name}: no judge could score this check — it will need your eyes`,
              nodeId
            );
            setNode(runId, nodeId, "failed", "unjudged");
            return;
          }
          // Live: actual judge spend accrues inside the providers (ctx.onCost).
          if (!live) {
            recordCost(
              runId,
              ...config.judges.map((j) => ({
                label: `${def.name} — ${j} judge (v${i})`,
                usd: judgeCallUsd(j),
              }))
            );
          }
          const result = aggregateJudges(def, i, judgeVerdicts, prevResults);
          if (judgeVerdicts.length < config.judges.length) {
            // Single-judge verdict: no disagreement signal exists, so confidence
            // must read as "needs a human", never as unanimous certainty.
            result.confidence = Math.min(result.confidence, 0.3);
          }
          iterationResults.push(result);
          pushEvalResult(runId, i, result);
          if (result.confidence < LOW_CONFIDENCE) {
            const judgeScores = judgeVerdicts.map((v) => v.score);
            const spread = Math.max(...judgeScores) - Math.min(...judgeScores);
            log(
              runId,
              "warn",
              judgeVerdicts.length < config.judges.length
                ? `${def.name}: scored by only ${judgeVerdicts.length} of ${config.judges.length} judges — flagged for human review`
                : `Judges disagree on ${def.name} by ${spread.toFixed(0)} pts — confidence ${(result.confidence * 100).toFixed(0)}%, flagged for human review`,
              nodeId
            );
          }
          setNode(
            runId,
            nodeId,
            result.verdict === "fail" ? "failed" : "succeeded",
            `${Math.round(result.score)} · ${result.verdict}`
          );
      };
      const workers = Array.from({ length: Math.min(POOL, evalQueue.length) }, async () => {
        for (;;) {
          const next = evalQueue.shift();
          if (!next) return;
          const [k, entry] = next;
          await runOneEval(entry, k);
        }
      });
      await Promise.all(workers);

      // ledger
      setNode(runId, "ledger", "running");
      await pace(300, 600);
      const allViolations = iterationResults.flatMap((r) => r.violations);
      const bySeverity = (s: Violation["severity"]) =>
        allViolations.filter((v) => v.severity === s).length;
      log(
        runId,
        "info",
        `Constraint ledger updated — ${allViolations.length} violation${allViolations.length === 1 ? "" : "s"} (${bySeverity("critical")} critical, ${bySeverity("major")} major, ${bySeverity("minor")} minor), deduped to canonical corrective clauses`,
        "ledger"
      );
      setNode(runId, "ledger", "succeeded", `${allViolations.length} violations`);

      // gate
      setNode(runId, "gate", "running");
      await pace(300, 600);
      const composite = computeComposite(iterationResults);
      const passed =
        composite.score >= config.compositePassThreshold &&
        composite.hardGateFailures.length === 0;
      patchIteration(runId, i, (it) => {
        it.composite = {
          score: composite.score,
          passed,
          hardGateFailures: composite.hardGateFailures,
        };
        it.status = passed ? "passed" : "failed";
      });
      updateBestIteration(runId);

      if (passed) {
        log(
          runId,
          "info",
          `Gate PASSED — composite ${composite.score} ≥ ${config.compositePassThreshold} and every hard gate green`,
          "gate"
        );
        setNode(runId, "gate", "succeeded", `composite ${composite.score}`);
        passedIteration = i;
        prevMegaPrompt = megaPrompt;
        prevResults = iterationResults;
        break;
      }

      // Judge outage on a must-pass check: neither passing nor another paid
      // attempt is honest — a human decides. Ship the best cut so far to review.
      if (unjudgedGates.length > 0) {
        log(
          runId,
          "warn",
          `${unjudgedGates.length} must-pass check${unjudgedGates.length === 1 ? "" : "s"} could not be judged (${unjudgedGates.join(", ")}) — stopping the loop and routing this attempt to your review instead of spending on another attempt`,
          "gate"
        );
        setNode(runId, "gate", "failed", "unjudged checks — needs your review");
        prevMegaPrompt = megaPrompt;
        prevResults = iterationResults;
        passedIteration = i; // ship this attempt to review, honestly labeled
        break;
      }

      const failMsg = composite.hardGateFailures.length
        ? `hard gate${composite.hardGateFailures.length === 1 ? "" : "s"} red: ${composite.hardGateFailures.join(", ")}`
        : `composite ${composite.score} below ${config.compositePassThreshold}`;
      log(runId, "warn", `Gate FAILED — ${failMsg} (composite ${composite.score})`, "gate");
      setNode(runId, "gate", "failed", `composite ${composite.score}`);

      // plateau detection
      if (prevComposite !== undefined) {
        if (composite.score - prevComposite < config.plateauMinDelta) {
          plateauStrikes += 1;
        } else {
          plateauStrikes = 0;
        }
      }

      // seed policy: rotate only when the same violation survives two iterations
      if (i >= 2) {
        const prevAspects = new Set(
          prevResults.flatMap((r) => r.violations.map((v) => v.aspect))
        );
        const survivor = allViolations.find((v) => prevAspects.has(v.aspect));
        if (survivor) {
          seed += 7919;
          log(
            runId,
            "warn",
            `Violation "${survivor.aspect}" survived two consecutive iterations — rotating seed to ${seed}`,
            "gate"
          );
        }
      }

      prevComposite = composite.score;
      prevMegaPrompt = megaPrompt;
      prevResults = iterationResults;

      if (plateauStrikes >= 2) {
        exhaustReason = `Composite plateaued — improvement below ${config.plateauMinDelta} pts for two consecutive iterations`;
        break;
      }
      if (i >= config.maxIterations) {
        exhaustReason = `Iteration budget exhausted (${config.maxIterations}/${config.maxIterations}) without passing every hard gate`;
        break;
      }

      // feedback loop animation: gate stays red for a beat, then the loop resets
      const clauseCount = allViolations.length;
      log(
        runId,
        "info",
        `${clauseCount} corrective clause${clauseCount === 1 ? "" : "s"} queued for mega prompt v${i + 1} — regenerating from the ORIGINAL video, never from a previous generation`,
        "gate"
      );
      await pace(500, 800);
      for (const nodeId of LOOP_NODES) setNode(runId, nodeId, "queued");
    }

    // --- terminal paths -------------------------------------------------------
    if (passedIteration !== undefined) {
      // remux
      setNode(runId, "remux", "running");
      await pace();
      const winner = getRun(runId)?.iterations.find((it) => it.index === passedIteration);
      const winnerVideo: VideoAsset = winner?.generatedVideo ?? {
        ...original,
        id: uid("video"),
        kind: "generated",
      };
      const finalVideo: VideoAsset = {
        ...winnerVideo,
        id: uid("video"),
        kind: "final",
        hasAudio: true,
        label: "Final — original audio remuxed",
      };
      mutateRun(runId, (r) => {
        r.finalVideo = finalVideo;
      });
      const winnerAudioVerified = audioVerifiedByIteration.get(passedIteration) ?? false;
      if (live) {
        recordActualCost(runId, {
          label: "Audio remux (ffmpeg, local)",
          usd: PRICE_TABLE.audioRemuxFfmpeg.usd,
        });
        log(
          runId,
          winnerAudioVerified ? "info" : "warn",
          winnerAudioVerified
            ? `Original audio stream-copied onto generation v${passedIteration} during the server-side remux — audio stream MD5 verified bit-exact against the demuxed source`
            : `Original audio remuxed onto generation v${passedIteration}, but the audio stream MD5 did NOT match the source — the audio-integrity gate will go red`,
          "remux"
        );
        setNode(
          runId,
          "remux",
          "succeeded",
          winnerAudioVerified ? "stream verified" : "verification failed"
        );
      } else {
        recordCost(runId, {
          label: "Audio remux (ffmpeg, local)",
          usd: PRICE_TABLE.audioRemuxFfmpeg.usd,
        });
        log(
          runId,
          "info",
          `Original audio stream-copied onto generation v${passedIteration} — re-hash matches ingest: SHA-256 ${audioHash.slice(0, 16)}…`,
          "remux"
        );
        setNode(runId, "remux", "succeeded", "hash verified");
      }

      // deterministic audio-integrity check
      setNode(runId, "eval-audio", "running");
      await pace(200, 400);
      const audioResult = deterministicResult(
        "audio-integrity",
        passedIteration,
        live
          ? {
              evalId: "audio-integrity",
              score: winnerAudioVerified ? 100 : 0,
              judgeSpread: 0,
              violations: winnerAudioVerified
                ? []
                : [
                    {
                      aspect: "audio-stream",
                      severity: "critical",
                      description:
                        "Post-remux audio stream digest does not match the demuxed source audio.",
                      correction:
                        "Re-run the remux from the original source audio via stream copy; do not re-encode.",
                    },
                  ],
            }
          : getScenarioOutcome(enc(passedIteration), "audio-integrity"),
        []
      );
      pushEvalResult(runId, passedIteration, audioResult);
      // fold the audio weight into the winning iteration's composite
      const winnerResults =
        getRun(runId)?.iterations.find((it) => it.index === passedIteration)?.evalResults ??
        [];
      const finalComposite = computeComposite(winnerResults);
      patchIteration(runId, passedIteration, (it) => {
        it.composite = {
          score: finalComposite.score,
          passed:
            finalComposite.score >= config.compositePassThreshold &&
            finalComposite.hardGateFailures.length === 0,
          hardGateFailures: finalComposite.hardGateFailures,
        };
      });
      updateBestIteration(runId);
      log(
        runId,
        live && audioResult.score < 100 ? "warn" : "info",
        live
          ? `Audio integrity: stream MD5 comparison ${audioResult.score >= 100 ? "matched bit-for-bit" : "MISMATCHED"} — score ${audioResult.score}, confidence 100%`
          : `Audio integrity: bit-exact hash match — score ${audioResult.score}, confidence 100%`,
        "eval-audio"
      );
      setNode(runId, "eval-audio", "succeeded", `${audioResult.score} · ${audioResult.verdict}`);

      setNode(runId, "fallback", "skipped");
      setNode(runId, "review", "running", "awaiting reviewer");
      mutateRun(runId, (r) => {
        r.status = "awaiting-review";
      });
      log(
        runId,
        "info",
        `Run complete after ${passedIteration} iteration${passedIteration === 1 ? "" : "s"} — best iteration v${passedIteration}, routed to human review`,
        "review"
      );
    } else {
      // color-transfer fallback
      const reason = exhaustReason ?? "Loop ended without a passing iteration";
      setNode(runId, "fallback", "running");
      await pace();
      const bestIndex = getRun(runId)?.bestIterationIndex;
      const best = getRun(runId)?.iterations.find((it) => it.index === bestIndex);
      mutateRun(runId, (r) => {
        r.fallback = { applied: true, reason };
        const source = best?.generatedVideo ?? original;
        r.finalVideo = {
          ...source,
          id: uid("video"),
          kind: "final",
          hasAudio: true,
          label: live
            ? `Fallback — best iteration v${bestIndex ?? "?"} (color transfer not yet implemented live)`
            : "Fallback — color transfer onto original pixels",
        };
      });
      log(
        runId,
        "warn",
        live
          ? `${reason} — color-transfer fallback is not yet implemented in live mode (TODO); shipping the best iteration's relit video (v${bestIndex ?? "?"}, original audio already remuxed) for human review.`
          : `${reason} — applying temporally smoothed color transfer from best iteration (v${bestIndex ?? "?"}) onto ORIGINAL pixels. Identity/motion/background mathematically exact; drama ceiling lower.`,
        "fallback"
      );
      setNode(
        runId,
        "fallback",
        "succeeded",
        live ? "best iteration shipped (TODO)" : "color transfer applied"
      );
      setNode(runId, "remux", "skipped");
      setNode(runId, "eval-audio", "skipped");
      setNode(runId, "review", "running", "awaiting reviewer");
      mutateRun(runId, (r) => {
        r.status = "awaiting-review";
      });
      log(
        runId,
        "info",
        "Fallback routed to human review — output is labeled as color-transfer, not generative",
        "review"
      );
    }

    // Cost readout. Mock: what the run WOULD have cost. Live: what it DID.
    const settled = getRun(runId);
    if (settled?.cost) {
      if (live) {
        log(
          runId,
          "info",
          `Actual live spend for this run: ${formatUsd(settled.cost.actualUsd)} (${settled.cost.items.length} billed provider calls; pre-flight estimate was ${formatUsd(settled.cost.estimatedUsd)})`
        );
      } else {
        const wouldBeUsd = settled.cost.items.reduce((sum, it) => sum + it.usd, 0);
        log(
          runId,
          "info",
          `Est. live cost for this run: ${formatUsd(wouldBeUsd)} (${settled.cost.items.length} provider calls) — actual spend in mock mode: $0.00`
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(runId, "error", `Pipeline error: ${message}`);
    mutateRun(runId, (r) => {
      r.status = "failed";
      for (const ns of Object.values(r.nodeStates)) {
        if (ns.status === "running") ns.status = "failed";
        else if (ns.status === "queued") ns.status = "idle";
      }
      const current = r.iterations[r.iterations.length - 1];
      if (current && current.status === "running") current.status = "failed";
    });
  }
}
