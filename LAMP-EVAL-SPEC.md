# Lamp evaluation spec — high-level editing sheet

**Status:** editable product spec. The approved Lamp skin policy and nine-row
scope below are implemented in the app and covered by tests; unchecked items
remain future evaluator work.

**Implementation snapshot:** `codex/flora-prompt-map-ux` working tree, verified
with 90 tests, TypeScript, and a production build on 2026-07-15. The deployed
commit is recorded after release.

**How to use this file:** edit the **Your tweak** line under any evaluation, then
send this file back with “apply the Lamp eval spec.” Keep the stable eval IDs in
backticks; the app, saved grades, and comparisons use them as database keys.

For exact evaluator wording, use `LAMP-EVAL-REVIEW.md`. Operational truth
remains in:

- `lib/prompts/eval-defs.ts` — names, descriptions, thresholds, weights, gates,
  and detailed rubric text.
- `lib/server/lamp-evaluator.ts` — the single whole-video Gemini call and output
  schema.
- `lib/lamp-evaluation.ts` — Lamp applicability, validation, scoring, and the
  critique-to-Final compiler.

---

## 1. What Lamp does

1. Generate **Initial** from the original video and the v1 mega prompt.
2. Verify and restore the original audio deterministically.
3. Compare the complete original and Initial videos in one Gemini evaluation.
4. Turn Initial's concrete violations into a correction list.
5. Generate **Final from the original video again**, using the same mega prompt
   plus those corrections. Final is not chained to Initial's generated-video
   state.
6. Verify audio again, then run the same whole-video evaluation on Final.
7. Put Final in the Grade workspace. The completed Final AI evaluation starts
   hidden and can be revealed without making another AI call.

Lamp always performs one critique and one regeneration. AI scores do not cause
extra loops, select a “best” cut, or block the video from human grading.

**Your tweak — overall flow:**

>

---

## 2. Shared evaluation rules

### Inputs

- One complete original video.
- One complete candidate video: Initial during pass 1, Final during pass 2.
- Original audio is present for playback, but the Gemini critic is instructed
  not to grade audio. The server owns audio verification.
- Lamp has no Look Anchor.

### One Gemini response

The evaluator returns exactly one result for each of the eight applicable
visual checks. Each result contains:

- `evalId`
- score from 0–100
- confidence from 0–1, meaning evidence strength from this single judge
- concise reasoning
- zero or more violations, each with an aspect, severity, description,
  timestamp when available, and an imperative correction

The server—not the model—derives `pass`, `borderline`, or `fail` from the
configured thresholds. Missing or duplicate eval IDs invalidate the response.
A non-passing score with no usable violation stays recorded, but contributes no
correction to Final.

### Corrections

Corrections should:

- identify one problem only;
- say where the problem occurs;
- use an imperative such as **restore**, **remove**, or **stop altering**;
- avoid inventing a target color, pattern, brand, or other positive attribute;
- describe a change the video generator can actually make.

Initial violations are deduplicated by eval and aspect, ordered critical →
major → minor, capped at 12, and inserted verbatim into Final's mega prompt.

**Your tweak — shared evaluator rules:**

>

---

## 3. Approved Lamp evaluation map

“Hard” means hard-gate metadata in the AI score/comparison. It does **not** stop
Lamp from generating Final or prevent human grading.

| Stable ID | Plain-English job | Lamp source | Hard? | Pass | Borderline |
|---|---|---|---:|---:|---:|
| `identity-preservation` | Is this unmistakably the same person throughout? | Gemini whole video | yes | 88 | 75 |
| `skin-texture-age` | Did real skin and apparent age survive without obvious smoothing or added wrinkles? | Gemini whole video | yes | 85 | 70 |
| `appearance-fidelity` | Did hair, clothing, glasses, jewelry, and accessories stay unchanged? | Gemini whole video | yes | 85 | 72 |
| `background-fidelity` | Did the room and every background object stay unchanged? | Gemini whole video | no | 82 | 70 |
| `lighting-quality-delta` | Is the lighting clearly and professionally better—not merely brighter? | Gemini whole video | yes | 80 | 65 |
| `motion-lipsync` | Do pose, gestures, expressions, and mouth timing still match the original? | Gemini whole video | yes | 86 | 74 |
| `temporal-stability` | Is the result steady, without flicker, shimmer, popping, or color drift? | Gemini whole video | no | 80 | 68 |
| `hallucination-artifacts` | Did the generator avoid invented, removed, warped, or melted content? | Gemini whole video | yes | 90 | 80 |
| `audio-integrity` | Is the canonical original audio preserved exactly, or silence preserved? | deterministic server check | yes | 99 | 99 |

Lamp has exactly nine evaluation rows: the eight Gemini results plus
deterministic audio. `temporal-alignment` and `lighting-match-to-anchor` are not
Lamp rows and must not appear in Lamp AI output, human grading, comparison, or
UI. Flora retains its existing 11-row rubric.

---

## 4. The eight Gemini evaluations

### 4.1 `identity-preservation` — Same person

**Core question:** At every point in the clip, is the subject unmistakably the
same human as in the original?

**Looks for:** facial geometry drift, moved or missing identifying marks,
changed age or facial hair, and identity-breaking facial reconstruction.

**Should not punish:** new shadows, brighter or dimmer skin, color-temperature
changes, or catchlights that are explainable by the new lighting.

**Correction goal:** restore the exact affected facial structure or identity
detail without repainting the rest of the person.

**Your tweak:**

>

### 4.2 `skin-texture-age` — Natural skin, no airbrushing

**Core question:** After factoring out exposure, contrast, white balance,
shadow placement, and other lighting effects, does the candidate retain the
source's real skin and apparent age closely enough to feel like the same
untreated person?

**Looks for:** obvious smoothing or airbrushing, erased pores or lines, removed
marks, plastic/waxy rendering, homogenized complexion, perceptible de-aging,
any added wrinkle or crease, and crawling texture.

**Applied Lamp decision:** extremely subtle, localized beautification may pass
only when it is detectable under close A/B inspection, pores, lines, marks, and
age cues remain substantially present, and apparent age is unchanged. Any
added wrinkle, crease, or age line that is not present at the corresponding
source moment fails this check and caps its score at 69. Obvious smoothing,
airbrushing, or perceptible de-aging at normal playback also fails.

**Should not punish:** illumination and color-response changes by themselves,
including brighter or lower-contrast rendering, fainter-but-present texture,
shifted warmth, catchlights, or softer highlight contrast caused by the
intended relight.

**Scoring anchors — pass 85, borderline 70:**

- **95–100:** no cosmetic alteration beyond lighting; structures, marks, and
  age cues remain intact.
- **85–94 — pass:** at most extremely subtle localized softening detectable
  only in close A/B inspection; skin structures remain present, apparent age is
  unchanged, and no wrinkle or crease is added.
- **70–84 — borderline:** localized texture thinning or softening is noticeable
  under deliberate comparison but is not an obvious normal-playback beauty
  filter or de-aging effect; no wrinkle or crease is added.
- **0–69 — fail:** obvious smoothing or airbrushing, broad texture or mark
  removal, plastic/waxy/foundation-like skin, perceptible de-aging, or any added
  wrinkle, crease, or age line. Broad age transformation belongs near 40 or
  lower.

**Correction goal:** restore missing skin structure in a named facial region;
remove smoothing or artificial material response. For invented age detail,
remove the added line while restoring the surrounding source skin without
smoothing it.

**Your tweak:**

>

### 4.3 `appearance-fidelity` — Hair and wardrobe unchanged

**Core question:** Do two independent inventories of the original and candidate
contain the same hair, garments, layers, glasses, jewelry, and accessories?

**Looks for:** anything added, removed, restyled, simplified, or structurally
changed—including intermittent single-frame disappearance.

**Should not punish:** lighting-driven color, saturation, sheen, or shadow
differences on otherwise unchanged hair and fabric.

**Correction goal:** restore or stop altering the affected item in its original
region without naming a guessed color, pattern, or brand.

**Your tweak:**

>

### 4.4 `background-fidelity` — Room unchanged

**Core question:** Is the environment the same room with the same geometry and
objects, changed only by light?

**Looks for:** moved, added, removed, replaced, warped, or texture-changed
background content; altered edges, text, furniture, or room layout.

**Should not punish:** plausible new shadows, gradients, exposure, or color
temperature caused by relighting.

**Correction goal:** restore or remove one affected background element in a
precise region.

**Your tweak:**

>

### 4.5 `lighting-quality-delta` — Lighting clearly better

**Core question:** Does this read as a meaningful professional relight rather
than a near-copy, flat exposure lift, or beauty filter?

**Looks for:** a clear directional key, balanced fill, subject/background
separation, catchlights, natural color, controlled highlights, and a coherent
setup that holds over time.

**Should fail for:** global exposure-only changes, barely perceptible changes,
beauty glow, clipping, heavy color cast, masking halos, or theatrical effects
that do not belong in the room.

**Correction goal:** direct the light—strength, softness, direction, fill,
separation, or highlight control—without changing scene content.

**Your tweak:**

>

### 4.6 `motion-lipsync` — Performance preserved

**Core question:** At matching moments, are pose, gesture, expression, blink,
and mouth shapes identical enough to remain synchronized with the original
audio?

**Looks for:** re-timed or re-animated motion, altered mouth shapes, invented or
missing blinks, damped/exaggerated gestures, and lead/lag against the source.

**Should not punish:** shadow movement, changed lip/teeth specularity, or mouth
brightness differences caused by the relight.

**Correction goal:** restore the exact motion or mouth trajectory around the
affected moment; never solve motion errors by changing appearance.

**Your tweak:**

>

### 4.7 `temporal-stability` — No flicker

**Core question:** Does the candidate remain visually stable as a continuous
video?

**Looks for:** exposure pumping, wandering light direction, color drift,
texture shimmer/boiling, popping details, and crawling silhouette edges.

**Should not punish:** changes already present in the original or variations
with a real scene cause, such as the subject moving under a fixed light.

**Current wording issue:** part of the shared rubric still describes contact
sheets and two judges even though Lamp supplies complete videos to one Gemini
critic. The high-level intent is correct, but the Lamp-native prompt should be
cleaned up before relying on this score at batch scale.

**Correction goal:** hold the affected light, color, texture, or edge treatment
constant across the complete clip.

**Your tweak:**

>

### 4.8 `hallucination-artifacts` — Nothing invented

**Core question:** Is every candidate frame physically coherent and faithful,
with no generator-created content?

**Looks for:** warped hands, ghost limbs, duplicated features, melted textures,
impossible geometry or reflections, invented text/objects/fixtures, removed
objects, and edge smearing.

**Should not punish:** new but physically plausible shadows, highlights, glows,
or gradients—the relight itself must be allowed to exist.

**Correction goal:** remove the invented content or stop the localized
distortion, pinned to a region and timestamp when possible.

**Your tweak:**

>

---

## 5. The deterministic ninth row

### `audio-integrity` — deterministic and active

The server discards provider sound, restores the canonical source audio (or
preserves source silence), checks audio presence, verifies complete timeline
agreement within tolerance, and compares the aligned audio bitstream. It is
binary: 100 or 0. A failure stops before the paid visual evaluation.

**Your tweak:**

>

Lamp has no additional unavailable or placeholder rows. Temporal alignment and
anchor matching remain part of Flora's 11-row rubric only; they are entirely
absent from Lamp AI evaluation, human grading, comparison, and UI.

---

## 6. Human grading and AI comparison

- The Lamp human grader answers the same nine rows listed in §3, including
  deterministic audio, plus **Would you ship it?** Flora continues to use 11
  rows.
- Human grades use one universal five-point scale:
  - 5 — perfect → 95 / pass
  - 4 — minor issues → 85 / pass
  - 3 — noticeable → 72 / borderline
  - 2 — clear problems → 55 / fail
  - 1 — badly wrong → 30 / fail
- Those human verdicts do not use each AI eval's individual threshold.
- Final AI results start hidden. Revealing them reads the stored result only.
- Saved Lamp comparisons use exactly the same nine-row set; there are no
  unavailable or inapplicable Lamp placeholders.

**Your tweak — human grading and comparison:**

>

---

## 7. Decisions to settle before a paid batch

- [x] Apply the final Lamp skin policy: pass/borderline 85/70, permit only
      extremely subtle localized beautification under close A/B with age cues
      intact, and fail/cap at 69 any added wrinkle or crease.
- [x] Use exactly nine Lamp rows, including deterministic audio; keep temporal
      alignment and anchor matching exclusively in Flora's 11-row rubric.
- [ ] Clean the Lamp temporal-stability prompt so it describes full videos and
      one Gemini judge accurately.
- [ ] Remove or formally support `estimated_face_lift_stops`; the lighting
      rubric currently requests it while Lamp's strict result schema rejects
      unknown fields.
- [ ] Replace brittle regex rewrites of Flora frame-grid prompts with explicit
      Lamp-native whole-video rubric text.
- [ ] Confirm the remaining thresholds, weights, and which scoring rows should
      be marked hard.
- [ ] Remove the nonexistent “approved anchor” language from Lamp's generation
      brief while keeping Flora's actual Look Anchor behavior unchanged.
- [ ] Version and snapshot the evaluator text for a run so Initial and Final
      cannot be judged under different rubrics if code changes mid-run.
- [x] Apply the approved skin and nine-row scope edits to code and run all
      non-paid tests.
- [ ] Run one paid single-video smoke test before starting a batch.

## 8. Change log

| Date | Spec revision | Applied commit | Notes |
|---|---|---|---|
| 2026-07-15 | Initial high-level editing sheet | not applied | Pre-decision Lamp baseline. |
| 2026-07-15 | Approved skin policy and nine-row Lamp scope | implemented; deploy pending | Skin is 85/70 with a strict added-wrinkle fail; Lamp excludes temporal alignment and anchor matching everywhere while Flora remains 11 rows. |
