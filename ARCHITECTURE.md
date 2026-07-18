# Lamp unified studio — Architecture

Updated 2026-07-18. The production-oriented app now starts new work through
five Lamp modes: Lamp, Background, Beautify, Iris, and Combined. Flora remains a
read-only legacy record type. The historical Flora proposal is retained below
because it explains the original eval and structural-safety thinking, but it is
not the current execution graph.

## 0. Current release architecture

### One shell, five separately bound methods

The Create selector is a setup preference, not execution authority. Each run
persists its `workflowMode`; read, review, cost, recovery, grading, and history
resolve from the record. Only an untouched ingest skeleton may be retargeted:
no plan, approval, execution, provider operation, generated iteration, node
progress, review, final artifact, or human grade may exist. After any of those
bindings exists, the mode is immutable.
Existing Lamp methods keep their own prompts, planners, eval registries, and
runtime rules. Unification shares the front door and history without blending
their contracts.

| Mode | Plan gate | Generated artifacts | Delivery authority |
| --- | --- | --- | --- |
| Lamp | Run spend confirmation | Initial + Final | Final |
| Background | Human cleanup-plan approval | Initial + Final, or none for no-op | Final or approved exact-source no-op |
| Beautify | Human enhancement-plan approval | Initial + Final, or none for no-op | Final or approved exact-source no-op |
| Iris | Human gaze-plan approval | Initial + Final, or none for no-op | Server-qualified best of two, or approved exact-source no-op |
| Combined | One aggregate human approval | Take 1 + Take 2, both from source | Human-selected, blindly graded exact candidate |

Only Lamp currently supports batches. The three plan modes remain single-clip,
and Combined is explicitly rejected by the batch route because its per-source
plan, two candidate receipts, human winner choice, and exact grade binding have
no safe batch contract yet.

### Structural laws shared by every current mode

1. **Immutable source:** every paid generation receives the canonical original,
   never pixels or an interaction chain from a prior generation.
2. **Original audio authority:** generated sound is discarded. Remux and digest
   checks bind the source track (or explicit source silence) to the artifact.
3. **Frozen prompts:** generation bytes are persisted before provider admission.
   Read-time reconstruction validates those bytes instead of silently compiling
   with today's renderer.
4. **Exact paid journals:** a stable operation id owns each potentially billed
   request. Completion replays; ambiguity reconciles; neither a tab retry nor a
   deployment may create a second paid call.
5. **Symmetric truth:** server admission and read materialization enforce the
   same source, prompt, plan, operation, and artifact identities.
6. **Current spend grant:** planner and generation grants are separate,
   price-snapshotted, scope-limited, and atomically claimed. A completed journal
   may be reused after approval renewal; an unclaimed expired scope pauses.
7. **Human calibration:** automated evaluations are hidden during blind grading.
   Final human grades are compare-and-swap writes over the exact artifact shown.

### The Combined execution graph

Combined is a fifth prompt product, not sequential execution of the other four
modes. Its aggregate plan composes only enabled planners and assigns mutually
exclusive edit ownership:

- global illumination: relight 0–100;
- approved background targets: cleanliness 1–3;
- approved facial zones: Beautify off or 1–3;
- eyes and eyelids: eye contact off or fixed Presenter P2;
- every unowned region: preservation hard gate.

After one human aggregate approval, the runtime freezes the initial prompt and
runs this bounded graph:

```text
original + frozen prompt -> Take 1 + verified source audio -> holistic eval -> SyncNet
original + same prompt bytes + <=12 ordered corrections -> Take 2
Take 2 + verified source audio -> holistic eval -> SyncNet -> at most one exact repair
eligible Take 1 + eligible Take 2 -> human chooses one -> blind exact-artifact grade
```

Take 1 is never repaired: a sync failure makes it ineligible. Take 2 may receive
one Lipsync-2-Pro repair, and the repaired journal/artifact hash replaces the raw
generation as that candidate's identity. Because evaluation precedes repair, its
AI evaluation continues to describe the pre-repair generated artifact. No
automatic winner is stored.
`HumanGrade.gradedIteration` plus
`gradedCandidateArtifactIdentityHash` is the delivery authority.

The correction ledger is deterministic and capped at 12. It orders hard-gate
failures first, then ensures at most one correction per enabled concern before
filling remaining slots by stable severity. Final compilation changes only the
version header and correction body of the frozen Take-1 prompt.

### Persistence boundaries

The local fs driver and hosted Blob/Postgres driver implement the same revision
and compare-and-swap contracts for runs, executions, paid operations, plan
approval, spend grants, human grades, and grade drafts. Live Combined approval is
one atomic storage operation: it may not persist an approved aggregate without
its matching grant, nor issue a grant for a different aggregate. Mock Combined is
provider-free and persists approval without a grant. Background, Beautify, and
Iris persist their approved plan and generation grant as separate server-owned
writes rather than one paired atomic mutation.

Combined reads require exact completed planner, generation, evaluation, audio,
SyncNet, and optional repair journals before exposing a candidate as gradeable.
Blind reads hide only the selected candidate's automated evaluation. Reveal is
read-only and never starts a provider. Saved winners are immutable.

Combined paid-work replay is intentionally unsupported in v1. A terminal
`completed` Workflow may receive a settlement-only CAS repair, but only after
the exact aggregate binding and both candidate receipt chains revalidate.
Missing or mismatched proof becomes `reconcile_required`; the route never
guesses or replays a paid operation. See `HANDOFF.md` for current limitations.

---

## Historical Flora design (reference only)

Design document for the relighting pipeline. This is the product's north star: the mock app
approximates it, and the prompts and evals in the repo encode it faithfully. It is the output
of a 4-proposal / 2-judge design panel, synthesized into a single plan.

**The problem.** Take a ~10-second webcam clip with bad lighting and return the same clip with
professional lighting. "Same clip" is the hard part: same person (identity), same performance
(motion, lip movement, timing), same wardrobe and room, same framing, byte-identical audio.
Generative video models are good at inventing and bad at leaving things alone, so the
architecture is organized around one principle:

> **Never trust the model where code can guarantee.** Every property that can be enforced
> structurally (audio, regeneration source, alignment) is enforced structurally. Every property
> that cannot (identity nuance, lighting quality, hallucinated objects) is measured by evals
> with teeth, and the model is steered with compiled — not accumulated — prompts.

---

## 1. Goals and non-goals

### Goals

- **G1 — Professional relight.** The output must be a *meaningful* lighting improvement over
  the input, not a subtle grade. This is enforced by a dedicated hard gate (see §5.5).
- **G2 — Identity lock.** The person in the output is indistinguishable from the person in the
  input on every frame, including the worst frame.
- **G3 — Performance lock.** Motion, gestures, lip-sync, and timing are preserved
  frame-for-frame; the delivered audio is the original stream, untouched.
- **G4 — Scene lock.** Wardrobe, accessories, background objects, and camera framing are
  unchanged except for illumination.
- **G5 — Bounded cost.** Expensive video generation is the last resort, not the iteration
  medium. Cheap stills carry the creative iteration.
- **G6 — Auditable decisions.** Every automatic decision (score, verdict, correction, loop
  action) is inspectable in the review UI, and a human approves every final output.

### Non-goals

- Editing anything other than lighting (no reframing, retiming, background replacement,
  beautification).
- Clips meaningfully longer than ~10 seconds, multi-person scenes, or non-webcam footage
  (the manifest and eval design assume one seated subject, static camera).
- Real-time or interactive-latency processing.
- Fully autonomous shipping — a human review gate is part of the design, not a temporary
  scaffold. Its verdicts also become judge-calibration data (§8).

---

## 2. The two-tier, anchor-first pipeline

The central cost/quality decision: **iterate on stills, propagate to video once.**

**Tier 1 (cheap, creative).** Relight ONE reference frame with the image model to produce a
**Look Anchor**. Run still-level checks against it (identity, wardrobe, background, skin tone,
lighting drama). Iterate at this tier — image generations are orders of magnitude cheaper and
faster than video — until the look is approved.

**Tier 2 (expensive, mechanical).** The video model is deliberately **demoted from creative
relighter to lighting propagator**. It receives:

- the **original video** as structural conditioning (motion, identity, layout),
- the **approved anchor** as first-frame / look conditioning (the lighting target),
- a **compiled prompt** (§4) whose only creative instruction is the lighting directive,
- a **pinned seed** (§4.4).

Giving the video model a fully specified target instead of a creative brief minimizes both
cost (fewer video attempts) and hallucination surface (nothing is left for it to invent).

### Stages

| # | Stage | What happens | Rationale |
|---|-------|--------------|-----------|
| 1 | **Ingest** | Probe the clip; demux audio and SHA-256 it; extract reference frames. | Everything downstream needs frames; audio leaves the generative path here and never returns to it. |
| 2 | **Manifest** | Vision model extracts a structured `SceneManifest`: person (face, skin tone, hair, clothing, accessories), background inventory, camera, and a lighting diagnosis. | One-time ground truth for evals. Extracted *before* any generation so no generated artifact can contaminate it. |
| 3 | **Anchor (Tier 1)** | Image model relights the reference frame; still-level checks loop until the Look Anchor is approved. | Creative iteration at still prices; the video model never sees an unvetted look. |
| 4 | **Generate (Tier 2)** | Video model propagates the anchor's lighting across the original video (original + anchor + compiled prompt + pinned seed). | The propagation framing gives the model the least possible room to invent. |
| 5 | **Align gate** | Deterministic temporal-alignment check (§3.3) before any comparison eval runs. | If frame N doesn't correspond to frame N, every index-locked comparison silently lies. |
| 6 | **Evaluate ×11** | The full registry (§5): deterministic metrics first with short-circuit, then dual-LLM-judged evals on percentile + event-picked frames. | Catastrophic failures are caught for pennies before judge spend; subjective calls get two independent judges and a measured confidence. |
| 7 | **Aggregate & gate** | Composite = Σ(weight × score). Pass ⇔ composite ≥ 75 AND every hard-gate eval passes. | A weighted average must never launder a critical failure; hard gates are non-negotiable regardless of the mean. |
| 8 | **Correct & loop** | Failed/borderline evals distill into ledger corrections; the mega prompt recompiles; regenerate **from the original** (§3.2). Loop control in §6. | Corrections are structured deltas, not accumulated prose — the prompt cannot drift. |
| 9 | **Finalize** | Take the **best** iteration by gated composite (never the last); stream-copy remux the original audio; re-hash and verify. If no iteration passed the gates, apply the color-transfer fallback (§3.4). | The loop can regress; best-of makes regression harmless. Audio equality is verified by hash, not by trust. |
| 10 | **Review** | Human reviews the winner side-by-side with evidence (scores, violations, judge disagreements, frames), approves or requests changes. | Final quality bar, and the source of judge-calibration labels (§8). |

---

## 3. Structural guarantees

Properties enforced by code, not by prompting or judging.

### 3.1 Audio never enters the generative path

Audio is demuxed at ingest and SHA-256 hashed. The winning video gets the original stream
remuxed on via stream copy (no re-encode), then the output's audio stream is re-extracted,
re-hashed, and compared. **The `VideoGenProvider` interface literally does not accept audio** —
the guarantee is in the type system, not in a convention. The `audio-integrity` eval is
therefore a verification of plumbing, not a judgment call: hash equality or fail.

### 3.2 Regenerate always from the original

Iteration N+1 conditions on the ORIGINAL video, never on generation N. Generation-on-generation
would compound identity drift, detail loss, and codec artifacts; regenerating from the source
makes compounding drift structurally impossible. Corrections carry forward through the prompt
ledger (§4.2) — state lives in the prompt, not in the pixels.

### 3.3 Temporal-alignment hard gate before any comparison

Every comparison eval assumes original frame *t* corresponds to generated frame *t*. That
assumption is verified, not presumed: per-frame perceptual-hash / edge-map correlation is
computed across a ±3-frame sliding offset, and the correlation must peak at offset 0 (with
duration and frame count within tolerance). If a generated clip is retimed, dropped a frame, or
padded, alignment fails, all downstream comparison evals are skipped, and the iteration fails
fast — otherwise identity, motion, and stability scores would be confidently wrong.

### 3.4 Terminal fallback: color transfer onto original pixels

If the video loop exhausts (§6) without any iteration passing the gates, we do not ship a
gate-failing generation and do not ship nothing. Instead: estimate a **temporally smoothed gain
map / 3D LUT** from the best generation's lighting, and apply it to the ORIGINAL pixels.
Identity, motion, background, and audio are then *mathematically exact* — the only transformed
quantity is color/illumination. The ceiling is lower (a LUT cannot add a rim light or move
shadows), so fallback output is always explicitly labeled in the review UI and the run record
(`Run.fallback`). Reviewers judge it as what it is: a safe grade, not a relight.

### 3.5 Best-of tracking

The loop returns the best iteration by gated composite (hard-gate-passing iterations strictly
dominate non-passing ones), never the most recent. A late-loop regression can never degrade the
shipped artifact.

---

## 4. The prompting system

Anti-hallucination is mostly a *state management* problem. Long-lived, hand-amended prompts rot:
duplicated clauses, stale corrections, and contradictions accumulate, and the model's behavior
becomes a function of prompt history rather than of intent.

### 4.1 The mega prompt is a compiler, not a document

The prompt sent to the video model is **deterministically compiled from structured state**:

```
[ immutable task + locks ]           ← RELIGHT_BASE_PROMPT, never edited
[ lighting directive ]               ← from the manifest's lighting diagnosis + approved anchor
[ active corrections ]               ← rendered from the constraint ledger (§4.2)
[ negative constraints ]             ← base never-do list
```

Same state → same bytes. Nobody appends prose to a prompt; they mutate the ledger and the
prompt recompiles. This makes prompt diffs between iterations meaningful and reviewable
(the run UI shows them), and makes "what changed?" always answerable.

### 4.2 The constraint ledger

- Each eval violation maps to **one canonical corrective clause** (imperative, self-contained,
  region-scoped).
- Clauses are **deduped** (same violation from both judges → one clause), **severity-ordered**
  (critical → major → minor), and **capped at 12** — beyond that, instructions dilute each
  other and compliance drops.
- A violation that no longer appears in the next iteration's evals is marked **RESOLVED** and
  its clause **drops out** of the next compiled prompt. Prompts shrink when things get fixed.
- **Oscillation rule:** a clause that resolves and then *reappears* is frozen into the base
  block (it has proven load-bearing) and triggers seed rotation (§4.4) — the violation is
  treated as seed-correlated rather than instruction-correlated.

### 4.3 Pink-elephant discipline

Never name mutable attributes positively. "Keep the red shirt red" does two bad things: it
invites the model to attend to (and repaint) the shirt, and it bakes any captioning error into
every subsequent prompt. Instead, corrections and locks are **region-scoped prohibitions**:
"Do not alter any garment, object, or surface; change illumination only." / "Restore the plain
wall camera-left; remove the added window."

The Scene Manifest — the detailed inventory of what's actually in the frame — is ground truth
for **evals**, not prompt filler. The generation prompt stays attribute-blind on purpose;
the eval layer is where specificity lives.

### 4.4 Seed policy

- **Pin the seed while refining.** With the seed fixed, an output change between iterations is
  attributable to the prompt change — the loop can actually learn what its corrections do.
- **Rotate only when the same violation survives two consecutive iterations** (or on the
  oscillation rule above). At that point the failure is judged seed-correlated, and rotation
  is the cheapest remaining lever.

---

## 5. The eval architecture

### 5.1 The registry

Eleven evals, pinned — ids, order, and numbers are contractual (the mock scenario and the UI
depend on them). Weights sum to exactly 1.0.

| id | name | category | method | hardGate | weight | pass | borderline |
|---|---|---|---|---|---|---|---|
| `audio-integrity` | Audio Integrity | audio | deterministic | **yes** | 0.02 | 99 | 99 |
| `temporal-alignment` | Temporal Alignment | temporal | deterministic | **yes** | 0.02 | 95 | 85 |
| `identity-preservation` | Identity Preservation | identity | hybrid | **yes** | 0.14 | 88 | 75 |
| `skin-texture-age` | Skin Texture & Apparent Age | identity | hybrid | **yes** | 0.08 | 88 | 75 |
| `appearance-fidelity` | Hair, Wardrobe & Accessories | appearance | dual-llm-judge | **yes** | 0.12 | 85 | 72 |
| `background-fidelity` | Background Fidelity | background | hybrid | no | 0.12 | 82 | 70 |
| `lighting-quality-delta` | Lighting Improvement vs Original | lighting | dual-llm-judge | **yes** | 0.16 | 80 | 65 |
| `lighting-match-to-anchor` | Anchor Look Match | lighting | dual-llm-judge | no | 0.08 | 78 | 65 |
| `motion-lipsync` | Motion & Lip-Sync | motion | hybrid | **yes** | 0.12 | 86 | 74 |
| `temporal-stability` | Temporal Stability | temporal | hybrid | no | 0.08 | 80 | 68 |
| `hallucination-artifacts` | Hallucination & Artifact Scan | hallucination | dual-llm-judge | **yes** | 0.06 | 90 | 80 |

`skin-texture-age` splits off from identity on purpose: identity asks "same human being?",
the skin gate asks "same skin, at the same strength?" — judges factor out illumination and
color response, then verify complexion, pores, fine lines, marks, facial hair, highlight
roll-off, and apparent age against the source. It exists because beautification is the failure
mode a composite average is most likely to launder: a subtly smoothed face often *raises*
aesthetic scores while destroying source fidelity.

**Composite = Σ(weight × score).** An iteration passes when composite ≥ 75
(`config.compositePassThreshold`) **and** every hard-gate eval's verdict is `pass`. The small
weights on `audio-integrity` and `temporal-alignment` are intentional: they contribute almost
nothing to the mean because their power is the gate — they are binary plumbing checks, and a
high weight would let them mask (or be masked by) perceptual scores.

### 5.2 Deterministic-first with short-circuit

Deterministic metrics run **before** any LLM judge and short-circuit catastrophic failures —
no judge tokens are spent scoring the aesthetics of a clip whose audio was re-encoded or whose
frames are misaligned. The future-real metric suite:

- **Identity:** ArcFace (or equivalent) face-embedding cosine similarity, gated on the
  **worst frame** — both `min` and `mean` must clear thresholds. Identity failures are
  transient; a mean hides them.
- **Background:** person-masked SSIM per tile, with **suspicious-tile adjudication** — only
  low-SSIM tiles are escalated to a judge, which classifies each as "lighting-explainable"
  (shadows moved, as intended) vs "object change" (a fail). Code finds candidates; judges only
  disambiguate.
- **Lip-sync:** mouth-landmark trajectory correlation between original and generated video —
  valid *precisely because* the delivered audio IS the original stream, so matching the
  original's mouth motion is matching the audio.
- **Stability:** flicker metric (frame-to-frame luminance/chroma variance outside of motion)
  plus **hue-histogram EMD trend across iterations** to catch slow color drift the human eye
  normalizes away.

### 5.3 Dual LLM judges, event-picked frames

Subjective evals are judged **independently by Claude and Gemini** against the same rubric
(`EvalDefinition.promptTemplate`). Frames are sampled at fixed percentiles **plus event-picked
frames**: maximum optical flow, largest face bounding box, maximum mouth-open. Drift hides in
the hardest frames; percentile sampling alone systematically misses them.

**Blind-inventory protocol for appearance:** each judge independently lists garments and
accessories for the original and the candidate; code diffs the four lists. No judge is primed
with what to look for, so a vanished earring is caught by disagreement between inventories
rather than depending on someone thinking to ask about earrings.

### 5.4 Confidence is measured, not self-reported

Models are miscalibrated about their own certainty, so we never ask. Confidence is derived
from **judge disagreement** (score distance between Claude and Gemini), and — future-real —
**position-swap duplicate trials** (same judgment with before/after order flipped; an
order-sensitive verdict is an unreliable verdict). Low confidence forces the eval's verdict to
at most `borderline` and flags it for human review. The confidence meter in the UI renders
exactly this quantity.

### 5.5 The anti-degenerate gate

Every preservation eval has a trivial fixed point: **return the input unchanged** and ace
identity, appearance, background, motion, and stability. `lighting-quality-delta` exists to
make that fixed point a failure — it scores lighting improvement **versus the original**, and
it is a hard gate. A near-copy of a dim input scores near zero here and the iteration fails
regardless of its other nines. (The mock scenario's iteration 1 demonstrates exactly this
failure mode.)

### 5.6 Fault-injection fixtures (future CI)

An eval that has never caught its target defect is a decoration. Every eval must demonstrably
catch its defect class against injected faults, runnable in mock mode as CI:

- shirt recolor → `appearance-fidelity` fails
- vanished earring → blind inventory diff catches it
- retimed clip (±2 frames) → `temporal-alignment` gate fails
- re-encoded audio → `audio-integrity` hash mismatch
- added background object → `background-fidelity` / `hallucination-artifacts` fail
- identity swap on 5 frames → worst-frame identity gate fails

### 5.7 Regression handling and judge noise

Judge scores are noisy; reacting to noise makes the loop thrash. A score delta only counts as
a real regression (and only then does the controller react — new correction, severity bump)
when it exceeds the noise floor: **max(5 points, 1.5σ)**, with σ calibrated per-eval from
repeated trials on identical inputs (future-real; the mock uses the 5-point floor).

### 5.8 Team reference checks → registry mapping

The team's production experiments run seven checks. Every one of them is covered by the
registry; the granularity differs because the registry separates deterministic plumbing from
judged perception:

| Team check | Registry eval id(s) |
|---|---|
| `timing_audio_technical` | `temporal-alignment` + `audio-integrity` + `motion-lipsync` (spans all three: registration, bit-exact audio, and viseme/gesture timing) |
| `skin_texture_age` | `skin-texture-age` |
| `identity_performance` | `identity-preservation` (the performance/timing half is carried by `motion-lipsync`, shared with `timing_audio_technical`) |
| `hair_clothing` | `appearance-fidelity` |
| `lighting_studio_quality` | `lighting-quality-delta` + `lighting-match-to-anchor` (improvement vs original, and propagation fidelity to the approved anchor) |
| `scene_camera_preservation` | `background-fidelity` + `hallucination-artifacts` (the camera lock itself is enforced in the base prompt and verified inside both sweeps) |
| `temporal_stability` | `temporal-stability` |

Adopted from the team's schema: per-violation `correction` strings (their
`revision_instruction`), a required `coverage` object ({start, middle, end, speech,
fast_motion}) proving what the judge actually inspected, `estimated_face_lift_stops` with the
1.0–1.25-stop target on the lighting rubric, and the named lighting flags
(`global_exposure_only`, `too_subtle`, `beauty_glow`, `over_warm`, `clipping`,
`halo_or_masking`). Their `INPUT_ERROR` status is handled by the engine before judges run;
their `REVIEW` status maps to the registry's `borderline` verdict.

Two deliberate deltas from the team's checks:

1. **No fixed ≥95–97 pass bars.** Fixed near-ceiling thresholds are brittle under judge score
   noise — a clip flapping between 94 and 96 across runs flip-flops the loop without the
   underlying video changing. The registry keeps strict per-eval bars but pairs them with
   **measured dual-judge confidence** (§5.4): near-threshold or judge-disagreed results route
   to human REVIEW instead of oscillating the controller.
2. **Coverage booleans adopted wholesale.** The `coverage` object from the team's schema is
   required in every judged rubric to catch lazy judging: any segment the judge did not
   actually inspect (start/middle/end/speech/fast-motion) caps the score at the borderline
   threshold — an uninspected segment cannot be certified as passing.

---

## 6. Loop control

- **Max 4 iterations** (`config.maxIterations`). Tier-1 anchor iteration is where budget is
  spent freely; Tier-2 video iterations are strictly bounded.
- **Early exit** the moment an iteration passes composite + all hard gates.
- **Plateau detection:** if composite improvement < `config.plateauMinDelta` for 2 consecutive
  iterations, stop — more spend is not buying quality. Route to human review as *plateaued*
  with the best iteration so far.
- **Oscillation detection:** a violation that resolves and reappears freezes its corrective
  clause into the base block and rotates the seed (§4.2, §4.4). Two controllers fighting each
  other (fix A breaks B, fix B breaks A) is detected the same way and ends the loop.
- **Terminal outcomes:** pass → review; plateau/max-iterations with a gate-passing best →
  review (best-of); no gate-passing iteration at all → color-transfer fallback (§3.4) →
  review, labeled.

---

## 7. Mocked today vs real later

The boundary is the provider interfaces in `lib/types.ts`. Everything left of them is real
now; everything right of them is scripted.

| Concern | Mock today | Real later |
| --- | --- | --- |
| Video generation | Original clip + CSS filter (`simulatedFilter`), scripted latency | Omni video model via `VideoGenProvider` (original + anchor conditioning + seed) |
| Look Anchor (still relight) | Reference frame re-rendered through a CSS filter | Gemini image model via `ImageGenProvider` |
| Vision judging | Two mock judges jitter around scripted scores with scripted spread | Claude + Gemini via `VisionJudgeProvider`, real rubric prompts, real frames |
| Scene manifest | Hardcoded `MOCK_MANIFEST` for the sample clip | Vision extraction at ingest using `MANIFEST_PROMPT` |
| Deterministic metrics | Scripted scores depicting what metrics would report | ArcFace similarity, masked SSIM, landmark correlation, flicker, hash checks |
| Audio path | Simulated: score is scripted, no real demux | ffmpeg demux → SHA-256 → stream-copy remux → re-hash verify |
| Temporal alignment | Scripted pass | pHash/edge correlation over ±3-frame offsets |
| Frame extraction | Browser canvas (`lib/frames.ts`) | ffmpeg server-side extraction (canvas stays for UI thumbnails) |
| Confidence | Derived from scripted judge spread — the *mechanism* is real | Same mechanism on real judges + position-swap duplicate trials |
| Color-transfer fallback | Represented in state (`Run.fallback`), labeled in UI | Real gain-map / 3D LUT estimation and application |
| Mega-prompt compiler | **Real** — actual compiler over actual ledger state | Unchanged |
| Eval registry, thresholds, gating, composite | **Real** — actual math | Unchanged (thresholds re-tuned on real data) |
| Loop control (plateau, oscillation, best-of) | **Real** — actual controller logic | Unchanged |
| Store, engine, UI | **Real** | Unchanged |

---

## 8. Open questions for the team

1. **Omni's conditioning surface.** The Tier-2 design assumes the video model accepts
   (a) a source video as structural conditioning, (b) a first-frame / look image, and ideally
   (c) a denoise-strength-like knob and (d) seed pinning. Which of these does Omni actually
   expose? If first-frame conditioning is unavailable, the anchor becomes prompt-only guidance
   and Tier 1's value drops sharply — we should know before building the adapter. If seeds
   can't be pinned, §4.4's attribution logic needs a rethink (e.g. best-of-N per iteration).
2. **Lip-sync metric choice.** Mouth-landmark trajectory correlation is cheap and
   audio-independent, but insensitive to inner-mouth detail (teeth/tongue hallucination).
   Do we add a SyncNet-style audio-visual embedding score, at the cost of a heavier
   dependency, or is landmark correlation + the motion judge enough?
3. **Judge calibration from review verdicts.** Every human review decision is a labeled
   example (judges said X, reviewer said Y). How do we close that loop — periodic threshold
   re-tuning per eval? Per-judge bias offsets? At what sample size do we trust it?
4. **σ calibration cost.** Per-eval noise floors (§5.7) require repeated judge trials on
   identical inputs. How many trials per eval per model version, and do we re-run on every
   judge-model upgrade?
5. **Fallback drama floor.** The color-transfer fallback guarantees fidelity but caps
   lighting improvement. Is there a minimum `lighting-quality-delta` below which we'd rather
   ship *nothing* than ship the fallback? Product call, not engineering.
6. **Anchor approval in Tier 1.** Today's design auto-approves the anchor via still-level
   checks. Should a human approve the Look Anchor before any video spend (one extra review
   touchpoint, large cost saving on bad looks)?

---

## 9. Mass automation

A single run proves the loop; the product only matters at fleet scale — "point it at every
clip we shot this week." The unit of automation is the **batch**: `startBatch()` creates one
independent run per clip and drains them through a **bounded worker queue** (2 slots in the
mock). The bound is the design, not a demo simplification: real Omni calls are rate-limited
and each video generation has a real unit cost, so production throughput is always *N workers
against a rate limit and a cost budget*. Runs waiting for a slot are first-class state — they
exist immediately, log "waiting for a worker slot", and appear on the board as queued — so
the queue itself is observable, not hidden inside a scheduler. Runs share nothing: in mock
mode each clip's scripted trajectory travels with the run (`scenarioForVideo`, threaded
through the provider calls), which doubles as proof that concurrent runs cannot contaminate
each other's state — the same isolation property the real adapters will need.

The batch review board (`/batch`) is the human half of the throughput equation. Automation
produces candidates at machine speed; a reviewer consumes them from one queue with the
aggregate picture on top — pass-first-try rate, fallback count, mean composite, the hard gate
that failed most across the sweep, mean judge confidence — and per-clip evidence one click
away. Every approve / needs-changes verdict is a labeled example against the judges' scores,
which is exactly the calibration data question 3 in §8 needs; batch review is how that
dataset accumulates without anyone doing extra work.

Scaling the mock's shape into production:

- **Workers as a budget knob.** `Batch.concurrency` maps to "how many Omni jobs may run
  concurrently under the current rate limit and spend ceiling" — tuned per sweep, not
  hardcoded.
- **Per-run artifact directories.** Original, approved anchor, per-iteration generations and
  eval JSON, final remux — written under the run id so any batch member is auditable offline
  and re-judgeable later.
- **Nightly cron sweep.** Re-run a pinned clip corpus against the current prompts/thresholds
  and diff composites sweep-over-sweep: regression detection for prompt and registry changes.
- **CLI and watch folder.** `relight batch ./clips --workers 4` for scripted sweeps; a
  watch-folder mode that queues clips as they arrive, so "drop files in, review in the
  morning" becomes the default workflow.
- **Terminal semantics.** A batch is "done" when every member run settles
  (awaiting-review / approved / needs-changes / failed) — done means *ready for humans*,
  never *shipped*; the review gate of §1 G6 is unchanged at any scale.
