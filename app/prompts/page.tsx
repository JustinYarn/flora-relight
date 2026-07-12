"use client";

import { useMemo } from "react";
import { Badge, Card, KV, SectionTitle } from "@/components/ui";
import { RELIGHT_BASE_PROMPT } from "@/lib/prompts/base-prompt";
import { MANIFEST_PROMPT } from "@/lib/prompts/manifest";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { initialMegaPrompt } from "@/lib/prompts/mega-prompt";
import type { EvalDefinition, EvalMethod } from "@/lib/types";

/* ------------------------------------------------------------------------ */

const METHOD_COLOR: Record<EvalMethod, string> = {
  "dual-llm-judge": "var(--accent)",
  hybrid: "var(--running)",
  deterministic: "var(--muted)",
};

const MEGA_SECTIONS: { tag: string; what: string; why: string }[] = [
  {
    tag: "[TASK]",
    what: "Immutable propagator framing.",
    why: "The video model is a lighting propagator between two ground truths — the original video (structure, motion, timing) and the approved anchor frame (the light). It is told the test for every change: if a difference is not explainable purely as illumination, do not make it.",
  },
  {
    tag: "[INVARIANT LOCKS]",
    what: "Region-scoped prohibitions: identity, performance, wardrobe, background, camera, audio.",
    why: "Pink-elephant discipline — we never name a mutable attribute positively (“keep the red shirt red” invites repainting the shirt and bakes caption errors into every later iteration). Locks say what may not change, scoped by region.",
  },
  {
    tag: "[LIGHTING SPECIFICATION]",
    what: "The one thing allowed to change, derived from the base spec.",
    why: "A professional three-point studio brief: soft key ~45° camera-left slightly above eye level, gentle fill, subtle rim for separation, 4800–5600K, flattering contrast — cinematic but believable for a webcam setting.",
  },
  {
    tag: "[ACTIVE CORRECTIONS FROM EVALUATION]",
    what: "The fix list (constraint ledger) — numbered, unresolved fixes only.",
    why: "Each eval violation maps to ONE canonical corrective clause keyed by (eval id + aspect); deduped, ordered critical > major > minor, capped at 12. Resolved violations DROP OUT of the next prompt, so it never accretes stale prose. A clause that resolves then reappears gets frozen into the base block and triggers seed rotation.",
  },
  {
    tag: "[NEVER DO]",
    what: "Negative constraints rendered verbatim from the base prompt.",
    why: "No added/removed objects, no visible light fixtures, no background replacement, no skin smoothing, no reframing, no retiming, no text or watermarks, no style transfer.",
  },
];

/* ------------------------------------------------------------------------ */

function Pre({ children }: { children: string }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-canvas p-4 font-[family-name:var(--font-geist-mono)] text-xs leading-relaxed text-muted">
      {children}
    </pre>
  );
}

function LongKV({ k, v }: { k: string; v: string }) {
  // KV right-aligns its value; long prose reads better left-aligned inside a block.
  return (
    <KV k={k} v={<span className="block text-left text-xs leading-relaxed text-muted">{v}</span>} />
  );
}

function EvalCard({ def, index }: { def: EvalDefinition; index: number }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-6 text-right font-[family-name:var(--font-geist-mono)] text-xs tabular-nums text-faint">
          {index + 1}
        </span>
        <h3 className="text-sm font-semibold text-ink">{def.name}</h3>
        <Badge>{def.category}</Badge>
        <Badge color={METHOD_COLOR[def.method]}>{def.method}</Badge>
        {def.hardGate ? (
          <Badge color="var(--fail)">
            <span title="must pass (hard gate) — failing this check fails the attempt">
              must pass
            </span>
          </Badge>
        ) : (
          <Badge color="var(--faint)">
            <span title="advisory (soft) — counts toward the Overall score only">
              advisory
            </span>
          </Badge>
        )}
        <span className="ml-auto font-[family-name:var(--font-geist-mono)] text-2xs tabular-nums text-faint">
          {def.id}
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted">{def.description}</p>

      <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-edge bg-raised px-3 py-2">
        <div>
          <div className="text-2xs uppercase tracking-wider text-faint">Weight</div>
          <div className="text-sm font-semibold tabular-nums text-ink">
            {def.weight.toFixed(2)}
            <span className="ml-1 text-2xs font-normal text-faint">
              ({Math.round(def.weight * 100)}%)
            </span>
          </div>
        </div>
        <div>
          <div className="text-2xs uppercase tracking-wider text-faint">Pass</div>
          <div className="text-sm font-semibold tabular-nums text-pass">
            &ge; {def.passThreshold}
          </div>
        </div>
        <div>
          <div className="text-2xs uppercase tracking-wider text-faint">Borderline</div>
          <div className="text-sm font-semibold tabular-nums text-borderline">
            &ge; {def.borderlineThreshold}
          </div>
        </div>
      </div>

      {def.promptTemplate ? (
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-2xs font-semibold uppercase tracking-[0.14em] text-accent hover:brightness-110">
            Full judge rubric
          </summary>
          <div className="mt-2">
            <Pre>{def.promptTemplate}</Pre>
          </div>
        </details>
      ) : (
        <p className="mt-3 text-2xs text-faint">
          Checked automatically by code — no judge prompt, no model involved.
        </p>
      )}

      {def.deterministicNote ? (
        <div className="mt-3 rounded-lg border border-edge bg-canvas p-3">
          <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.14em] text-running">
            Deterministic tier (future-real metric)
          </div>
          <p className="text-xs leading-relaxed text-muted">{def.deterministicNote}</p>
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------------ */

export default function PromptsPage() {
  const mega = useMemo(() => initialMegaPrompt(), []);
  const totalWeight = useMemo(
    () => EVAL_DEFS.reduce((sum, d) => sum + d.weight, 0),
    []
  );
  const base = RELIGHT_BASE_PROMPT;

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <header className="mb-8">
        <h1 className="text-lg font-semibold text-ink">Prompt Library</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted">
          The exact prompts and rubrics the pipeline uses — in mock mode today,
          against real Omni / Gemini / Claude adapters later. Everything here is
          compiled from structured state, never hand-edited: this page is the
          methodology, rendered.
        </p>
      </header>

      {/* (a) Mega prompt compiler ------------------------------------------ */}
      <section className="mb-10">
        <SectionTitle
          right={
            <Badge color="var(--accent)">deterministic compiler</Badge>
          }
        >
          How the generation brief (mega prompt) compiles
        </SectionTitle>
        <Card className="p-4">
          <p className="text-xs leading-relaxed text-muted">
            The generation prompt is a pure function of structured state:{" "}
            <span className="text-ink">
              immutable base + lighting directive + constraint ledger + negatives
            </span>
            . Same state compiles to the same bytes, so any two iterations&apos;
            prompts diff cleanly and a correction&apos;s effect can be isolated.
            The seed is pinned while refining for the same reason; it rotates
            only when the same violation survives two consecutive iterations.
          </p>
          <div className="mt-4 space-y-3">
            {MEGA_SECTIONS.map((s) => (
              <div key={s.tag} className="rounded-lg border border-edge bg-raised p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-[family-name:var(--font-geist-mono)] text-xs font-semibold text-accent">
                    {s.tag}
                  </span>
                  <span className="text-xs text-ink">{s.what}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted">{s.why}</p>
              </div>
            ))}
          </div>
        </Card>

        <div className="mt-4">
          <SectionTitle
            right={<Badge>version {mega.version} · 0 fixes</Badge>}
          >
            Live render — the brief before any fixes (initialMegaPrompt())
          </SectionTitle>
          <Card className="p-4">
            <Pre>{mega.rendered}</Pre>
          </Card>
        </div>
      </section>

      {/* (b) Base prompt --------------------------------------------------- */}
      <section className="mb-10">
        <SectionTitle right={<Badge>immutable across iterations</Badge>}>
          Base prompt — locks &amp; lighting spec
        </SectionTitle>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold text-ink">Invariant locks</h3>
            <p className="mb-2 text-2xs leading-relaxed text-faint">
              Region-scoped prohibitions — what the model must copy exactly.
              Never phrased as positive attributes (pink-elephant discipline).
            </p>
            <div className="divide-y divide-edge">
              <LongKV k="identity" v={base.locks.identity} />
              <LongKV k="performance" v={base.locks.performance} />
              <LongKV k="wardrobe" v={base.locks.wardrobe} />
              <LongKV k="background" v={base.locks.background} />
              <LongKV k="camera" v={base.locks.camera} />
              <LongKV k="audio" v={base.locks.audio} />
            </div>
          </Card>
          <div className="space-y-4">
            <Card className="p-4">
              <h3 className="mb-2 text-sm font-semibold text-ink">
                Lighting specification
              </h3>
              <p className="mb-2 text-2xs leading-relaxed text-faint">
                The one permitted change: a three-point professional studio
                setup, believable in a webcam room.
              </p>
              <div className="divide-y divide-edge">
                <LongKV k="style" v={base.lighting.style} />
                <LongKV k="key light" v={base.lighting.keyLight} />
                <LongKV k="fill light" v={base.lighting.fillLight} />
                <LongKV k="rim light" v={base.lighting.rimLight} />
                <LongKV k="color temp" v={base.lighting.colorTemperature} />
                <LongKV k="mood" v={base.lighting.mood} />
              </div>
            </Card>
            <Card className="p-4">
              <h3 className="mb-2 text-sm font-semibold text-ink">Never do</h3>
              <ul className="space-y-1.5">
                {base.negative.map((n) => (
                  <li key={n} className="flex gap-2 text-xs leading-relaxed text-muted">
                    <span className="text-fail">×</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      </section>

      {/* (c) Manifest prompt ----------------------------------------------- */}
      <section className="mb-10">
        <SectionTitle
          right={<Badge color="var(--running)">runs once, when the clip is read</Badge>}
        >
          Scene inventory extraction (manifest)
        </SectionTitle>
        <Card className="p-4">
          <p className="mb-3 text-xs leading-relaxed text-muted">
            Before any generation, a vision model extracts a structured
            inventory of the scene as strict JSON. The manifest is{" "}
            <span className="text-ink">eval ground truth</span> — it is what
            judges check vanished earrings and repainted walls against. It is
            deliberately <span className="text-ink">never rendered into
            generation prompts</span>: naming &quot;the red shirt&quot; invites
            the model to repaint it, and would bake any captioning error into
            every subsequent iteration.
          </p>
          <details>
            <summary className="cursor-pointer select-none text-2xs font-semibold uppercase tracking-[0.14em] text-accent hover:brightness-110">
              Full extraction prompt
            </summary>
            <div className="mt-2">
              <Pre>{MANIFEST_PROMPT}</Pre>
            </div>
          </details>
        </Card>
      </section>

      {/* (d) Eval registry -------------------------------------------------- */}
      <section>
        <SectionTitle
          right={
            <Badge>
              {EVAL_DEFS.length} checks · weights sum {totalWeight.toFixed(2)}
            </Badge>
          }
        >
          The 11 checks (eval registry)
        </SectionTitle>
        <Card className="mb-4 p-4">
          <p className="text-xs leading-relaxed text-muted">
            Overall score (composite) = &Sigma; (weight × score). An attempt
            passes when the Overall score reaches the workflow threshold (75){" "}
            <span className="text-ink">and every must-pass check passes</span> —
            a high composite cannot buy back a broken identity or a hallucinated
            hand. Deterministic metrics run first and short-circuit catastrophic
            failures before any judge spend; the LLM-judged evals run on Claude
            and Gemini independently, and{" "}
            <span className="text-ink">confidence is measured from judge
            disagreement</span>, never self-reported — low agreement forces
            borderline and flags the result for human review. Frames are sampled
            at fixed percentiles plus event-picked frames (max optical flow,
            largest face, max mouth-open), because drift hides in the hardest
            frames.
          </p>
        </Card>
        <div className="space-y-4">
          {EVAL_DEFS.map((def, i) => (
            <EvalCard key={def.id} def={def} index={i} />
          ))}
        </div>
        <p className="mt-4 text-2xs leading-relaxed text-faint">
          Future CI: fault-injection fixtures — every eval must demonstrably
          catch its target defect class (shirt recolor, vanished earring,
          retimed clip, re-encoded audio) in mock mode before it gates real
          runs. Regressions only count when the score delta exceeds judge noise
          (max of 5 points or 1.5&sigma; calibrated from repeated trials).
        </p>
      </section>
    </div>
  );
}
