# Lamp Chain — Combined Version 2 (the sequential experiment)

Written 2026-07-20 on branch `codex/lamp-combined-v2` (worktree
`flora-relight-combined-v2`, dev port 3005, launch config `combined-v2`).
Built from the unification tip (5e352e0) that already carries all four modes
plus Combined V1.

## 1. What Version 2 is

Combined V1 answers "four asks at once" with ONE region-fenced prompt and one
two-pass run. Version 2 asks the opposite question: what happens when the
asks run as **modules in sequence**?

- The original clip enters the pipeline **once** (stage 1).
- Each enabled concern is its own **single-pass generation**: Background
  cleanup, Lamp relight, Beautify, Iris — 2 to 4 stages depending on
  controls.
- Stage N conditions on **stage N−1's delivered cut**, not on the original.
- The final stage's cut is **delivered immediately** on structural proof.
- **Every evaluation is detached**: judge calls, SyncNet, luma, and gaze all
  run *after* delivery, as measurement journals that can never hold, repair,
  or un-deliver the artifact.
- There is **no correction pass and no repair** anywhere in the chain.

Two things are under test, exactly as scoped: (1) whether the modular
"original enters once" approach can compete with V1's single combined
generation, and (2) whether the **eval system itself is trustworthy** —
detached report cards land after delivery and are compared against blind
human grades instead of steering anything.

## 2. Laws kept, law suspended

| Structural law | Status in Chain |
| --- | --- |
| Regenerate-from-original | **Suspended on purpose — this is the experiment.** Stage inputs are prior stage outputs. |
| Original audio authority | **Kept, per stage.** Every stage's cut gets the canonical source track remuxed and hash-verified (`relit-v{n}.mp4`); the stored `source.mp4`/`source-audio.m4a` pair is seeded at stage 1 and never overwritten. |
| Frozen prompts | **Kept.** All stage prompts compile at approval into one envelope (`lamp-chain-stage-prompt-v1`), the serialized envelope is the execution's `renderedPrompt`/`inputHash`, and reads byte-validate against a fresh compile. |
| Exact paid journals | **Kept.** One `video-generation:{n}` claim per stage; one `judge:{n}:lamp-chain-holistic:gemini` claim per detached stage eval. |
| One human spend gate | **Kept.** One aggregate plan review (subplans + **stage order**) mints scope `chain_plan` / `chain_sequence`; the sequence grant authorizes exactly N generations + N detached evals and **never** a Lipsync repair. |
| Blind grading | **Kept, stronger.** The human can grade before any AI eval exists at all. |

Stage prompts are **byte-identical to their standalone modes** (Lamp at the
same intensity, Beautify/Iris from the same approved subplans). The only
exception: the Background stage appends one clearly-marked
`[CHAIN CLEANLINESS DIRECTIVE]` block, because cleanliness is a
Combined-family control with no standalone expression. Chaining is therefore
the only experimental variable. The model is never told its input might be a
prior generation (pink-elephant discipline).

## 3. Shape of a run

```
upload → controls (relight 0–100, cleanliness 1–3, beautify off/1–3,
         eye contact on/off) + STAGE ORDER picker
       → enabled planners run once against the ORIGINAL (~$0.01–0.04)
       → ONE plan review: subplans + order strip + ConfirmSpend
       → stage 1 (from source) → stage 2 (from stage 1's cut) → … → stage N
       → DELIVERED (awaiting review; gradeable immediately)
       → detached report card: per stage, one holistic judge call vs the
         ORIGINAL + SyncNet/luma/gaze measurements, attaching as they land
```

Key mechanics:

- **Stage order is approved identity.** It lives inside the chain plan hash
  (`hashLampChainPlan`), so reordering invalidates the presented approval
  hash exactly like editing a subplan would.
- **Delivery = structural proof only.** Per stage: completed generation
  journal + verified (or explicitly silent) canonical audio, journaled as an
  append-only `chainStageReceipts` entry on the execution record. Settlement
  requires the full contiguous trail; the record then parks at
  `awaiting_review` and never mutates again.
- **Detached evals are cumulative-contract judgments vs the ORIGINAL.** At
  stage i, concerns already executed are targets; enabled-but-not-yet-run
  concerns judge as **hard preservation gates** ("pending") — a pending-gate
  failure is *eager leakage* (a stage doing a later stage's job). The
  registry ids, weights, and thresholds are Combined's, so the final-stage
  artifact is rubric-identical to a V1 holistic eval and directly comparable.
- **Per-eval `deltaFromPrevious` across stages is the drift trajectory** —
  the primary instrument of the ordering experiment.
- **SyncNet is measurement, not gate.** A dead SyncNet service cannot block
  or misclassify a chain run; a missing measurement is visible in the report
  card as exactly that.

## 4. Eval-validity test (the second half of the assignment)

Because delivery never waits for evals, every chain run yields a clean
comparison pair:

1. Justin blind-grades the delivered cut at `/grade` (the full 11-row rubric,
   same ids as Combined; AI evals hidden and possibly not even computed yet).
2. The detached report card lands on the same rubric ids.
3. Agreement per eval id (human verdict vs judge verdict, score gaps) is the
   eval-validity measurement — collected without the evals ever having
   steered the artifact, which removes the usual circularity.

## 5. The sweep board (batch-test version)

`/chain-sweep` groups every chain run by source clip:

- one card per clip, one row per **order variant** (status, spend actual vs
  estimated, report-card progress, per-stage composite chips);
- "Run this order" launches a new variant of the same clip (any permutation
  of the enabled stages; repeats are allowed and labeled as judge-noise
  measurements);
- a **final-stage score matrix** (eval id × order variant) appears as report
  cards complete — the ordering experiment's summary table;
- sweep-wide estimated/actual spend totals at the top (standing
  cost-transparency rule).

Chain deliberately stays out of `/api/batches/start` (single-clip 409, like
the plan modes): every chain run keeps its own plan review and explicit
spend click. The sweep board is the multi-clip face, not a silent fan-out.

## 6. Costs (standing rule: estimates before, actuals after, totals during)

Per ~10s clip, from the verified price table (gen ≈ $1.04–1.12 each incl.
input tokens; judge call ≈ $0.03–0.08; planner pair ≈ $0.01–0.04):

| Run shape | Generations | Detached evals | Planners | Est. total |
| --- | --- | --- | --- | --- |
| 2-stage chain (BG+Lamp) | 2 × ~$1.08 | 2 × ~$0.05 | 1 | **≈ $2.30–2.50** |
| 3-stage chain | 3 × ~$1.08 | 3 × ~$0.05 | 2 | **≈ $3.40–3.70** |
| 4-stage chain (all on) | 4 × ~$1.08 | 4 × ~$0.05 | 3 | **≈ $4.50–4.90** |
| V1 Combined (reference) | 2 × ~$1.08 | 2 × ~$0.05 | 1–3 | ≈ $2.30–2.40 |

No Lipsync-2-Pro line ever (chain never repairs). SyncNet/luma/gaze are $0.

Sweep math: 1 clip × 2 orders (4-stage) ≈ **$9.0–9.8** · 2 clips × 2 orders
≈ **$18–20**, which is a full hour of the ~$20–21/hr rolling provider
allowance — run sweeps serially, one chain at a time (a 4-stage chain is
~8–15 min of wall clock, so sequential sweeps self-pace under the cap).

ConfirmSpend shows the exact per-run ladder before any grant is minted; the
sweep header keeps the running totals.

## 7. Ordering hierarchy — what reduces compounding noise (discussion)

Each chained generation is a lossy re-render: the model re-synthesizes every
pixel, not just its assigned concern. So every stage charges two taxes on
regions it should leave alone: generic re-render noise (texture softening,
micro identity drift) and concern-specific collateral (a relight
re-interprets shadows everywhere; beautify's glamour prior leaks outside the
face). Two principles fall out:

- **P1 — fragile signals go last.** Facial micro-texture, eye geometry,
  lip-sync integrity degrade a little with every downstream re-render; the
  edits humans scrutinize hardest should pass through the fewest.
- **P2 — global transforms go early.** Scene-wide edits (cleanup, relight)
  should happen while the input is closest to source pixels, and later
  stages then only need to *preserve* them — models preserve present state
  far better than they execute large transforms on degraded input.
- Corollary: **light is scene-state.** Relight after face work re-renders
  (and can undo) the delicate facial edits; relight before face work means
  beautify/iris operate under the delivered illumination — the film-crew
  order: dress the set, light it, makeup, then direct the eyes.

**Default hypothesis H0: `Background → Lamp → Beautify → Iris`**
(scene → light → face → eyes) — the same order the unification brief called
the "only sane" one. Competing hypotheses the sweep can test cheaply:

- **H1 Lamp-first** (`Lamp → Background → …`): gives the flagship relight
  the true original. Risk: cleanup-after-relight must inpaint removal
  footprints *under dramatic light* — reconstruction under hard shadows is
  the most hallucination-prone inpainting there is.
- **H2 Eyes-before-face** (`… → Iris → Beautify`): tests whether beautify
  re-breaks gaze. Expected to lose: beautify re-renders more fragile facial
  area than iris does, so putting it after iris maximizes damage to the most
  fragile completed work.
- **H3 Depth beats order**: a 2-stage chain (Background+Lamp only, face
  concerns off) versus 4 stages — if generic re-render drift dominates
  concern collateral, shorter chains beat any ordering of longer ones, and
  the practical answer becomes "chain at most 2, then stop."

What the instruments measure, per position: cumulative drift vs original
(identity / motion-lipsync / temporal-hallucination score trajectories and
their `deltaFromPrevious`), per-stage concern delivery (did stage i land its
target), **eager leakage** (pending-gate failures = a stage doing a later
stage's job early), **undo damage** (a completed concern's target score
dropping after a later stage), and the SyncNet/luma/gaze trajectories.
Expect SyncNet confidence to decline monotonically per re-render — the
question is the slope, and whether any order keeps the final cut above the
source-relative bar.

Honest priors, stated before data: V1 Combined should beat 4-stage chains on
identity and sync (2 re-renders vs 4); chains should beat V1 on **per-concern
completeness** (each stage's full obedience budget serves one ask — V1's
central risk was exceeding the model's obedience budget with four asks). The
interesting outcome is the crossover: if H0-ordered chains hold drift low
enough while winning completeness, modularization earns its cost; if drift
swamps completeness by stage 3, the hybrid (V1-style combined scene+light
pass, then a short face chain) becomes the next experiment — it's expressible
today as a 2-stage chain after a Combined run, or motivates a first-class
hybrid mode.

## 8. What exists on this branch

- Domain: `lib/lamp-chain.ts`, `lib/lamp-chain-operations.ts`,
  `lib/lamp-chain-evaluation.ts`, `lib/lamp-chain-candidate.ts`,
  `lib/prompts/lamp-chain.ts`, `lib/chain-workflow-def.ts`
- Server: `lib/server/lamp-chain-{planner,approval,evaluator,source}.ts`,
  chain arms in `spend-approval`, `run-execution-coordinator`,
  `storage/run-execution`, `run-execution-resume`, widened planner unions
- Durable workflow: `durableLampChainRun` in
  `workflows/durable-relight-run.ts` (sequential stages → receipts → settle
  → detached measurement tail; chain-shaped failure recorder)
- Routes: `app/api/chain-plan/approve/route.ts` + chain arms in
  `app/api/runs/route.ts` (POST/GET/PATCH) + batch-route 409
- UI: mode tile + controls + order picker, `ChainPlanReview`, stage rail,
  `ChainEvalReport`, `/chain-sweep` board, nav link
- Mock: provider-free chain rehearsal in `lib/engine.ts` proving
  deliver-first ordering (delivery lands, then the report card attaches)
- Tests: `tests/lamp-chain.test.ts`, `tests/lamp-chain-cost-auth.test.ts`
  (16 cases: order hashing, byte-parity prompts, pending gates, drift
  deltas, replay protection, spend scopes, sequential auth, receipt
  immutability, settle invariants)

## 9. Known experimental caveats (by design)

1. Plans are computed once against the ORIGINAL; a late cleanup stage may
   re-attend to an already-clean region (pink-elephant risk) — measured by
   the eager-leakage/hallucination rows, not patched away.
2. Errors freeze in: with no correction pass, an early stage's artifact is
   carried (and possibly amplified) downstream. That is the cost of
   modularity this experiment prices.
3. Delivery is sync-ungated: the delivered cut's lip-sync is measured after
   the fact and labeled, never repaired. Structural audio identity is still
   hash-enforced per stage.
4. Chain approvals bind the control triple; order binds via the plan hash on
   the execution record (spend ceilings don't depend on order, execution
   identity does).
