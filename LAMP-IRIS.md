# Lamp Iris — eye-contact correction (design + findings contract)

Written 2026-07-17 on `codex/lamp-iris` (stacked on the `codex/lamp-beautify`
lineage, which includes the Lamp Background workflow base). This documents the
third plan-gated Lamp mode: a subject who recorded themselves reading a
script, notes, or a prompter is delivered as the same take holding natural eye
contact with the camera — only the eyes change.

## The product problem

Reading on camera betrays itself entirely through the eyes: a resting gaze
anchored a few degrees off the lens (screen/prompter offset), line-scanning
saccades during speech, and periodic drops to notes. Everything else about the
take is usually fine — which makes this the smallest edit surface of any Lamp
mode, and the one with the sharpest characteristic failure at each end:

- **Undershoot:** the gaze still reads as anchored to reading material — the
  run bought nothing.
- **Overshoot:** a frozen, unblinking, glassy stare — worse than the original
  reading pattern.

The whole design is organized around steering between those two failures.

## What each sibling branch contributed

| Source | Reused in Iris |
|---|---|
| Lamp method (main) | Fixed two-pass contract: Initial → one holistic critique → one compiled correction → Final → blind human grade. Durable Vercel Workflow ownership, exact-once paid-operation journal, audio remux + hash verification. |
| `codex/lamp-background` | Plan-gated architecture (closed catalog, human approval before any generation), the "ring-light lesson" (declined categories never enter generation input), SyncNet post-evaluation gate + at most one Lipsync-2-Pro repair in finalization. |
| `codex/lamp-beautify` | The whole vertical-slice shape (plan/evaluation/read/prompts/planner/evaluator/execution files), draft→approved plan with SHA-256 hash binding, intensity dial whose override is the only human mutation (`plansDifferOnlyByIntensity`), per-band CATEGORY_RECIPES ladder (v3), closed correction-action vocabulary, blind grading with hidden Final AI eval. |
| `codex/lamp-slider-calibration` (LAMP-INTENSITY.md) | The ladder lessons: dynamic range lives in band recipes, not soft adverbs; criteria must judge target-matching in BOTH directions (too weak fails like too strong); measured calibration should steer pass 2. The first two are implemented; the third is the top open gap (see below). |

## The catalog (closed)

- `camera-axis-anchor` — headline. Re-anchor the resting gaze from the
  off-lens reading position to the true lens axis.
- `reading-scan-smoothing` — replace line-tracking saccades during speech with
  calm conversational steadiness.
- `note-glance-bridging` — bridge discrete drops to notes with continued
  contact.

Never proposable, at any intensity: head re-aiming, blink changes, eye
appearance changes (iris/sclera/shape/lashes/brows/catchlights), expression or
mouth changes, anything outside the primary subject's eye region. Blinks are
the loudest lock: every source blink lands at its source timestamp, and no
approved intensity buys a blink.

## The intensity ladder

1 **natural assist** — clear reading patterns calmed; every natural
glance-away and the full blink pattern survive; may still read as occasionally
consulting notes.
2 **presenter** — contact is the steady state through all speech; brief
natural breaks survive at phrase boundaries.
3 **anchor** — near-continuous contact except blinks and momentary natural
micro-breaks; alive, never frozen.

Per-band recipes live in `lib/prompts/lamp-iris.ts` (`CATEGORY_RECIPES`), one
`Target:` per band plus an `Always:` keep-clause — the beautify-v3 /
LAMP-INTENSITY.md structure. The evaluator's GAZE CONTRACT states the same
band expectations with explicit undershoot/overshoot correction actions
(`complete-approved-gaze-correction` / `reduce-gaze-lock`).

## The eval registry (11 checks, weights sum to 1.0, all hard gates)

| id | weight | what it protects |
|---|---|---|
| `identity-preservation` | 0.14 | same human, worst frame |
| `gaze-adherence` | 0.15 | plan followed, target-matching both directions (anti-degenerate: a near-copy fails here) |
| `gaze-naturalness` | 0.13 | the anti-uncanny gate: blinks at source timestamps, living micro-texture, no dead stare, natural convergence |
| `eye-region-fidelity` | 0.10 | same eyes — direction is the only change |
| `motion-lipsync` | 0.12 | product-critical: script audio is the source track; phonemes frame-accurate; head never re-aims |
| `outside-eye-fidelity` | 0.08 | no smuggled touch-up (beautify's job, not authorized here) |
| `background-integrity` | 0.08 | room untouched |
| `other-people-untouched` | 0.04 | only the primary subject's gaze |
| `lighting-camera-fidelity` | 0.04 | no relight/reframe |
| `gaze-temporal-stability` | 0.08 | no correction flicker/popping |
| `audio-integrity` | 0.04 | deterministic remux + hash, 100 or 0 |

`motion-lipsync` passes at 90 (stricter than beautify's 88) because the
subject is reading: the delivered audio IS the script performance, and any
mouth drift is immediately audible-visible. The SyncNet gate in shared
finalization backs this check deterministically and can trigger one
Lipsync-2-Pro repair.

## Cost shape

Identical to Beautify: one Gemini plan call (`iris_plan` approval scope), then
two Omni generations + two holistic Gemini evaluations under one
`iris_two_pass` approval. Estimators in `lib/cost.ts`
(`estimateLampIrisPlan`, `estimateLampIrisTwoPass`) delegate to the shared
shapes; the complete estimate is shown and confirmed before any paid call.
Slider-calibration live runs measured ~$2.3–2.4 settled per two-pass run on a
~10s clip; expect the same order here.

## Mocked today vs real later

- Demo runs use `createMockLampIrisPlan` (deliberately a draft — mock
  execution still stops for explicit human approval) and the browser mock
  engine; a demo run can never authorize live generation (same fail-closed
  check and wording as Beautify).
- The holistic judge carries all gaze checks today. **No deterministic gaze
  metric exists yet** — see gap 1.

## Known gaps, in priority order

1. **GazeMeter — measured calibration for pass 2 (the LAMP-INTENSITY.md
   third leg).** The relight slider only became real when free ffmpeg luma
   measurement grounded the judge and steered the Final prompt. The iris
   analog: per-frame on-lens fraction, mean angular gaze offset, and blink
   count/timestamps (e.g. MediaPipe FaceMesh or L2CS-Net via the existing
   Replicate client), persisted on the evaluation artifact and compiled into
   a MEASURED CALIBRATION correction. Blink-count delta (|Δ| > 1 fails)
   should also become a deterministic check row alongside audio-integrity.
2. **No live provider round trip has been run.** The live two-pass path is
   unverified for iris; do not describe it as working until an explicitly
   approved test completes both generations, both evaluations, audio
   verification, SyncNet, and settlement (HANDOFF.md provider-truth rule).
   Whether prompt-only steering of `gemini-omni-flash-preview` can redirect
   gaze at all — and hold blinks while doing it — is THE experiment this
   branch exists to run.
3. **Truthful pre-approval placeholder** (`codex/lamp-background` commit
   `5c985a6`) is not in this lineage; pick it up in the unified-app merge.
4. **Batch support** mirrors Beautify's status (single-clip plan-first flow;
   full batch contract not wired).

## Contact anchor — absolute "at the viewer" measurement (2026-07-17)

"Directly at the viewer through the screen" is not a geometric property a
single video exposes: it depends on where the camera sat relative to the
screen in that recording setup, and the near-lens difference (~2-5° of gaze)
is below the noise floor of generic gaze estimators (validated: a
reading-just-below-lens source measured indistinguishably from camera-contact
presenters on both Human's gaze bearing and 640px iris landmarks). The
working answer is **per-clip self-calibration**: a script-reader's own lens
glances leave a tight lifted cluster in the irisY trace, and
`lampIrisContactAnchor` takes that cluster's median as THIS setup's true
contact position. The meter persists `irisYTrace` + `contactAnchorY`
(optional, additive), the comparison reports signed `offsetFromContact`
(below = short of contact, above = past it) + `onContactFraction`, the judge
block carries the numbers, and the pass-2 calibration correction steers to
the measured position in either direction. No glances → fail-open (the
mrpas6x9 clip, whose planner said "no baseline contact to break away from",
correctly measures anchor: none). Precision behind it: two-pass landmarking
(locate at 640px, re-landmark a native-resolution face crop capped at
1024px), byte-deterministic and ~3 s/video.

## Provider content-filter constraint (learned live 2026-07-17)

The provider runs an **asynchronous content filter over the whole prompt
after admitting the create**. A rejected prompt is indistinguishable from a
lost generation from the outside: `interactions.create` returns an id, then
every read 400s — for a policy block the body says `Input blocked … The
prompt contains sensitive words that violate Google's Generative AI
Prohibited Use policy`. Four consecutive Finals (both gen-2 live runs and
both gen-3 live runs) were killed this way while every Initial passed; the
delta was exactly the correction-escalation wording. Blocked phrasings —
frozen verbatim in `renderLegacyLampIrisCorrectionV2/V3` and pinned out of
the current vocabulary by test — included "that output failed this
workflow's one job", "the person watching must feel looked in the eye",
"plainly different … in a same-frame comparison". Rules for all future
prompt work in this mode:

- State the required edit and its visibility bar in plain technical
  vocabulary. Never blame a prior output; never describe effects on the
  person watching; never frame the edit as producing a difference that
  survives a comparison.
- When a Final seals with the lost-interaction signature, `interactions.get`
  the dead id directly (free) before blaming the spend allowance — the 400
  body names a policy block explicitly.
- A policy-blocked create generates zero output seconds; the burned cost is
  the Initial + its evaluation (~$1.05), not the Final.

## Merge notes for the unified app

This branch stacks on `codex/lamp-beautify` (which contains the Background
workflow base commit `07d0fc0`), so merging `codex/lamp-iris` brings the
Beautify lineage with it. Remaining to unify afterward:
`codex/lamp-background` tip (`5c985a6`, placeholder fix) and
`codex/lamp-slider-calibration` (relight slider + measurement plumbing —
independent of this lineage; its measurement seam is what gap 1 wants to
reuse).
