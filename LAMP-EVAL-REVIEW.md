# Lamp Eval Review — rubric & flow editing doc

**Decision status (2026-07-15):** the Lamp skin policy and nine-row Lamp scope
below are approved and implemented in the app. The remaining YOUR NOTES fields
and unchecked high-level spec items are still editable future work.

**How to use this:** every editable piece is in a fenced block below. Edit text directly in this file (or paste replacements back in chat), add notes under any **YOUR NOTES** line, then tell Claude "apply the eval doc". Each block maps to an exact code location (listed with it), so paste-back is mechanical. Nothing here changes the app until applied.

**Where your grades come in:** for each check, note under YOUR NOTES which of your human grades disagreed with the AI (clip + direction, e.g. "AI failed it, I passed it"). That steers whether we edit the rubric text, the thresholds, or the flow.

---

## 1 · The high-level Lamp flow (current)

```
ingest (trim ≤9.9s, downscale >1080p, demux audio)
  └► GENERATION 1  — from the v1 mega prompt (base locks + lighting directive, corrections "(none)")
        └► audio remux + verification (deterministic, $0)
  └► HOLISTIC EVALUATION 1 — ONE Gemini call, both full videos w/ audio, all 8 checks at once
  └► COMPILE v2 PROMPT — eval-1 violations → deduped, severity-ordered corrections (cap 12);
        byte-splice into the persisted v1 prompt's [ACTIVE CORRECTIONS] section
  └► GENERATION 2 — from v2, regenerated FROM THE ORIGINAL (never chained to gen-1)
        └► audio remux + verification
  └► HOLISTIC EVALUATION 2 — same call shape, records deltas vs eval-1
  └► BLIND HUMAN GRADE at /grade — AI final eval hidden until you save or reveal
```

Key properties you might want to change (edit inline / add notes):
- **One critique, one regeneration** — no loop, no best-of. (Flora mode keeps the multi-iteration loop.)
- **Corrections come ONLY from eval-1 violations.** A check that fails with no violations contributes nothing (v2 renders "(none — …)").
- **Gen-2 always runs**, even if eval-1 was all-pass (a second sample under the same prompt).
- **The AI verdicts never gate delivery** — every completed run reaches your blind grade; scores/verdicts are advisory.
- **Judge = Gemini only in Lamp** (`gemini-3.1-pro-preview`, whole-video). The Claude frame-judge is Flora-mode only.
- **Verdict is recomputed from score server-side** (pass/borderline/fail from thresholds below); the model's self-reported verdict is ignored.

**YOUR NOTES (flow):**

---

## 2 · The evaluator preamble (one shared instruction block)

The judge receives this once, before all 8 rubrics. *(File: `lib/server/lamp-evaluator.ts` → `evaluatorPrompt()` intro lines.)*

```text
You are the lamp-holistic-v2 whole-video critic.
Compare the complete original and candidate videos once, then return exactly one result for every listed check.
Judge source fidelity over the entire timeline, including the worst frame. Do not infer a Look Anchor; Lamp has none.
For every violation, write a concise imperative correction that can be inserted directly into the next video-generation prompt.
Any check you score below its pass threshold must include at least one violation naming what failed, with a concrete correction; do not return a below-pass score with an empty violations array.
confidence is 0 to 1 and must describe how strongly the attached evidence supports this single-judge result. Do not treat it as multi-judge agreement.
Return only the listed visual checks. Do not include audio-integrity; the server verifies audio separately.
Return one JSON object with a results array matching the supplied response schema. Do not emit a separate JSON object for each check.
```

**YOUR NOTES (preamble):**

---

## 3 · Thresholds & weights at a glance

Verdict bands: **pass** ≥ passThreshold · **borderline** ≥ borderlineThreshold · **fail** below. Composite = weighted mean of present checks; an iteration "passes" when composite ≥ workflow threshold AND every hard gate passes. Flora retains the shared 11-definition registry; Lamp uses exactly the eight visual checks below plus deterministic audio for a nine-row AI, human, comparison, and UI surface.

| # | check | method | hard gate | weight | pass ≥ | borderline ≥ |
|---|---|---|---|---|---|---|
| 1 | `identity-preservation` | hybrid | YES | 0.14 | 88 | 75 |
| 2 | `skin-texture-age` | hybrid | YES | 0.08 | **85** | **70** |
| 3 | `appearance-fidelity` | dual-llm-judge | YES | 0.12 | 85 | 72 |
| 4 | `background-fidelity` | hybrid | no | 0.12 | 82 | 70 |
| 5 | `lighting-quality-delta` | dual-llm-judge | YES | 0.16 | 80 | 65 |
| 6 | `motion-lipsync` | hybrid | YES | 0.12 | 86 | 74 |
| 7 | `temporal-stability` | hybrid | no | 0.08 | 80 | 68 |
| 8 | `hallucination-artifacts` | dual-llm-judge | YES | 0.06 | 90 | 80 |

The applied Lamp row set is these eight Gemini checks plus `audio-integrity`
(deterministic, always appended: 100/pass when the remuxed audio verifies, else
0/fail). `temporal-alignment` and `lighting-match-to-anchor` remain Flora-only
and are entirely absent from Lamp AI evaluation, human grading, comparison, and
UI. Flora remains an 11-row workflow.

---

## 4 · The eight judged rubrics — exact text the model reads

Each block below is the verbatim per-check text composed into the Lamp judge call (after the frame-grid→whole-video rewrite; the JSON OUTPUT contract is enforced separately by the response schema). Edit the text in place. *(Source: `lib/prompts/eval-defs.ts` promptTemplate for that id; Lamp composition in `lib/server/lamp-evaluator.ts:evaluatorPrompt()`.)*

### 4.1 · `identity-preservation` — Same person

| method | hard gate | weight | pass ≥ | borderline ≥ |
|---|---|---|---|---|
| hybrid | YES | 0.14 | 88 | 75 |

*Plain-language purpose:* Makes sure the person in the new video is unmistakably the same person as in the original, in every single frame.

*Field notes:* Live signal (07-15 control experiment): a plain gamma/brightness lift on the same person scored 75–95 — mild sensitivity to global tone shifts (bt3_01 dropped to 75 borderline purely from the lift).

```text
Protocol: compare both complete videos over their full timelines.

ROLE
You are a forensic identity examiner for a video relighting pipeline. A generative model was instructed to change ONLY the lighting of a webcam video. Your job: verify that the person in the output is the same human being as in the input, in every frame, with no drift in facial structure or skin detail.

WHAT TO INSPECT — across corresponding moments
For each corresponding moment, compare:
1. Facial geometry: eye spacing and shape, nose bridge and tip, jawline, chin, cheekbone structure, ear shape, forehead proportion.
2. Skin detail: moles, scars, freckles, wrinkles, and blemishes — both PRESENCE and POSITION. A mole that moved is as serious as a mole that vanished.
3. Apparent age and facial hair: no de-aging, no beard densification or thinning.
4. Skin texture: pores and fine lines must survive. Systematic smoothing or "beautification" is an identity violation even when the person remains recognizable — it is the most common failure mode of generative relighting.
Judge the WORST pair, not the average: identity is gated on the minimum. One off-identity frame fails a 10-second clip, because one frame is all a viewer needs to notice.

LIGHTING-EXPLAINABLE DIFFERENCES ARE NOT VIOLATIONS
This is a relighting task. New shadows across the face, brighter or dimmer skin rendering, a shifted color temperature, catchlights appearing in the eyes — all expected, none of them violations. The distinction: illumination changes how the face is LIT; a violation changes what the face IS. Shadow falling differently on the same nose: fine. A subtly different nose: violation.

SCORING ANCHORS
- 95: Same person beyond any doubt in every pair, including the hardest challenging motion and speech moments. All differences are strictly lighting-explainable. Skin texture fully intact.
- 75: Same person overall, but one or two frames show mild feature drift (a jawline that reads slightly different under a heavy shadow, minor texture loss on the shadow side) that a careful viewer might catch.
- 40: A frame exists where the face reads as a different or heavily altered person — or the whole clip shows systematic beautification/smoothing. Automatic fail territory.

Thresholds for this eval: pass ≥ 88, borderline ≥ 75, else fail.

CORRECTION-WRITING RULES
Each "correction" string is inserted verbatim into the next generation prompt's ACTIVE CORRECTIONS section. Therefore:
- Imperative and self-contained: it must make sense with zero surrounding context. "Restore the original object on the shelf camera-left; remove the added item."
- Region-scoped: say WHERE (camera-left, upper-right corner, on the desk, along the jawline) and WHAT KIND of thing, so the fix cannot bleed into other regions.
- NEVER name a color, pattern, brand, or attribute in order to re-assert it. Positively naming an attribute invites the model to repaint exactly that attribute, and bakes your own perception errors into the prompt. Phrase every fix as restore / remove / stop-altering.
    BAD:  "Keep the shirt red." / "Make sure the earring is gold."
    GOOD: "Stop altering the garment on the upper body; reproduce it exactly as in the source video." / "Restore the small accessory at the subject's left ear exactly as in the source video."
- One correction per distinct aspect. Never bundle two fixes into one string.
For identity, corrections must be scoped to the facial region and phrased as restore/stop, e.g. "Stop altering the shape of the subject's nose; reproduce the facial structure exactly as in the source video." or "Restore natural skin texture on the subject's face; remove all smoothing."
```

**YOUR NOTES (identity-preservation):**

---

### 4.2 · `skin-texture-age` — Natural skin (no airbrushing) — **APPROVED LAMP POLICY**

> **Applied decision (07-15):** brightness is OK. Global exposure/gamma/tone lifts are the product working, and reduced pore *contrast* under brighter rendering is not itself a violation. Pass/borderline is 85/70. Extremely subtle localized beautification may pass only when it is visible under close A/B inspection, skin structures and age cues remain substantially present, and apparent age is unchanged. Any added wrinkle, crease, or age line fails and caps the score at 69. Obvious smoothing, airbrushing, or perceptible de-aging also fails.

| method | hard gate | weight | pass ≥ | borderline ≥ |
|---|---|---|---|---|
| hybrid | YES | 0.08 | **85** | **70** |

*Plain-language purpose:* Checks that skin still looks real and the same apparent age. It tolerates only extremely subtle localized beautification detectable under close A/B inspection; it rejects obvious airbrushing, perceptible de-aging, and any invented wrinkle or crease. Explicitly NOT a brightness check.

*Field notes:* The applied policy follows the 07-15 control experiment, where 2 of 3 exposure-lifted (otherwise identical) clips false-failed as "smoothing" at 40. Global tonal change is now a stated non-violation.

```text
Protocol: compare both complete videos over their full timelines.

ROLE
You are a skin-rendering examiner for a video relighting pipeline. A generative model was instructed to change ONLY illumination and color response. Your job: verify that the SKIN ITSELF — its structures, marks, and apparent age — survived closely enough to feel like the same untreated person. Identity-preservation asks "same human?"; you ask "same skin and apparent age?" You are NOT a brightness, contrast, or exposure examiner: tonal change is the product working, and this check must never punish it.

BRIGHTNESS IS EXPECTED — FACTOR OUT TONE COMPLETELY, THEN JUDGE PRESENCE
The candidate is SUPPOSED to be brighter and differently graded: lifted midtones, lifted shadow sides, warmer or cooler color, new catchlights, shifted specular placement, and globally reduced apparent texture contrast under brighter, softer light are ALL expected, correct outcomes — none of them are violations, alone or together. Pore fields, fine lines, and marks legitimately read softer under a brighter key; that is optics, not smoothing.
Judge primarily by PRESENCE, POSITION, and APPARENT AGE rather than contrast strength. After mentally normalizing the tone difference, ask whether the same structures remain in the same places and whether the person reads the same age. A pore field that reads fainter but is still present and correctly placed is fine. Extremely subtle localized softening may pass when it is detectable only under close A/B inspection, structures and marks remain substantially present, and apparent age is unchanged. This tolerance never permits invented age detail: after ruling out a shadow or contrast explanation, any wrinkle, crease, or age line absent from the corresponding source moment is a fail and caps the score at 69.

WHAT TO INSPECT — region by region
Sweep: forehead, both cheeks, nose, under-eyes, mouth area, chin, jaw, ears, neck, hairline. For each region compare:
1. Structure presence: pores, fine lines, and source wrinkles remain substantially present and correctly placed at whatever contrast the new tone produces. Extremely subtle localized thinning may pass under the rule above; obvious removal or relocation fails.
2. Marks and facial hair: every blemish, mole, freckle, scar, and hair of stubble/brow present at original density and position — no thinning, no cleanup, no densification. (Marks are tone-independent: a mole does not disappear because the light got brighter.)
3. Complexion character: natural color variation (redness patches, uneven tone) may shift with grading but must not be homogenized into a uniform, foundation-like finish.
4. Apparent age: age cues and skin laxity remain unchanged. Perceptible de-aging fails. Any added wrinkle, crease, or age line not present at the corresponding source moment fails and caps the score at 69.
5. Skin material: skin still reads as skin — diffuse with subtle specularity — not as a plastic, waxy, or uniformly glowing 3D render. (A brighter highlight is fine; a highlight with no texture inside it is not.)
Inspect speech, blink, and head-turn moments on BOTH the highlight side and shadow side of the face.

WHAT TO DETECT — real failure modes (use these slugs)
obvious_beautification (structures visibly erased), smoothing (a region's structures gone, not merely fainter), plastic_or_waxy, mark_removal (blemish/mole/freckle cleanup), added_wrinkles (automatic fail; score cap 69), apparent-age shift (perceptible de-aging or aging), texture_crawl (structures re-rendering pair to pair instead of persisting), makeup-like color (homogenized foundation finish).
EXPLICIT NON-FAILURES — never report these: globally brighter or lower-contrast rendering; fainter-but-present pore fields; lifted shadow detail; changed white balance or warmth; new or stronger catchlights; softer highlight roll-off. When in doubt whether a difference is tone or structure, it is tone — score it as passing and note the doubt in reasoning.

SCORING ANCHORS
- 95–100: No cosmetic alteration beyond lighting; structures, marks, and age cues remain intact. Includes candidates that read visibly softer or brighter overall for lighting-explainable reasons.
- 85–94 — PASS: At most extremely subtle localized beautification detectable only in close A/B inspection. Skin structures and marks remain substantially present, apparent age is unchanged, and no wrinkle or crease is added.
- 70–84 — BORDERLINE: Localized texture thinning or softening is noticeable under deliberate comparison but is not an obvious beauty-filter or de-aging effect at normal playback. No wrinkle or crease is added.
- 0–69 — FAIL: Obvious smoothing or airbrushing, broad texture or mark removal, plastic/waxy/foundation-like skin, perceptible de-aging, or any added wrinkle, crease, or age line. Broad age transformation belongs near 40 or lower.

Thresholds for this eval: pass ≥ 85, borderline ≥ 70, else fail.

CORRECTION-WRITING RULES
Each "correction" string is inserted verbatim into the next generation prompt's ACTIVE CORRECTIONS section. Therefore:
- Imperative and self-contained: it must make sense with zero surrounding context. "Restore the original object on the shelf camera-left; remove the added item."
- Region-scoped: say WHERE (camera-left, upper-right corner, on the desk, along the jawline) and WHAT KIND of thing, so the fix cannot bleed into other regions.
- NEVER name a color, pattern, brand, or attribute in order to re-assert it. Positively naming an attribute invites the model to repaint exactly that attribute, and bakes your own perception errors into the prompt. Phrase every fix as restore / remove / stop-altering.
    BAD:  "Keep the shirt red." / "Make sure the earring is gold."
    GOOD: "Stop altering the garment on the upper body; reproduce it exactly as in the source video." / "Restore the small accessory at the subject's left ear exactly as in the source video."
- One correction per distinct aspect. Never bundle two fixes into one string.
For skin, corrections must be region-scoped imperatives that restore structures without naming target attributes: "Restore the pore structure and fine lines on both cheeks; do not erase skin detail." / "Restore the natural skin marks on the forehead exactly as in the source video; remove all cleanup." / "Render skin as diffuse with subtle specularity; remove the plastic, uniform finish on the nose and forehead." / "Remove the invented age line in the named facial region; restore the surrounding source skin without smoothing it."
```

**YOUR NOTES (skin-texture-age):**

---

### 4.3 · `appearance-fidelity` — Hair & clothing unchanged

| method | hard gate | weight | pass ≥ | borderline ≥ |
|---|---|---|---|---|
| dual-llm-judge | YES | 0.12 | 85 | 72 |

*Plain-language purpose:* Checks that hair, clothes, glasses, and jewelry all stay exactly as they were — nothing appears, disappears, or changes.

*Field notes:* No live accuracy signal yet — blind-inventory protocol untested against your grades.

```text
Protocol: compare both complete videos over their full timelines.

ROLE
You are a wardrobe continuity supervisor for a video relighting pipeline. A generative model was instructed to change ONLY the lighting. Your job: verify that the subject's hair and everything they wear survived exactly — via a BLIND INVENTORY protocol designed so that nothing primes you about what to look for.

BLIND-INVENTORY PROTOCOL — follow the steps in strict order
STEP 1 — Inspect the complete ORIGINAL video attached first ONLY. Write (internally) a complete inventory of the subject's appearance: hair (length, texture, style, parting), every garment and layer (item type, where worn, construction — collar type, sleeve length, closures — and pattern GEOMETRY: note that a pattern exists and its structure, e.g. "horizontal stripes", "small repeating motif"), and every accessory (glasses, earrings, necklaces, headphones, watch, lanyard, pins, hat). Note locations: left ear, right wrist, around the neck.
STEP 2 — Set the before-inventory aside. Inspect the complete CANDIDATE video attached second ONLY and build a second inventory to the identical standard, independently, as if you had never seen the first set.
STEP 3 — Diff the two inventories item by item. Every discrepancy becomes a candidate violation: items missing from the after-inventory, items present only in the after-inventory, items whose category or construction changed, hair whose length/texture/style changed, pattern geometry that simplified or transformed.
The blind protocol matters: diffing two independent inventories catches vanished items that a "check whether X is still there" prompt would never surface.

LIGHTING-EXPLAINABLE DIFFERENCES ARE NOT VIOLATIONS
Relighting legitimately changes how fabric and hair LOOK: brighter or deeper colors, shifted saturation, new sheen or highlights on hair, shadow bands across a garment. None of these are violations. Violations are STRUCTURAL: a striped garment becoming solid, an earring vanishing, glasses appearing, a collar changing type, hair becoming shorter or straighter. Rule of thumb: if the difference survives imagining both frames under the same light, it is a violation.

SCORING ANCHORS
- 95: The two inventories match item-for-item; hair identical in structure; every visual difference is lighting-explainable.
- 75: All items present, but one item shows drift beyond lighting — pattern geometry subtly simplified, an accessory intermittently missing in a single frame, hair texture partially altered.
- 40: An item added or removed outright, a garment's category or construction changed, or hair restyled. Hard-gate failure territory.

Thresholds for this eval: pass ≥ 85, borderline ≥ 72, else fail.

CORRECTION-WRITING RULES
Each "correction" string is inserted verbatim into the next generation prompt's ACTIVE CORRECTIONS section. Therefore:
- Imperative and self-contained: it must make sense with zero surrounding context. "Restore the original object on the shelf camera-left; remove the added item."
- Region-scoped: say WHERE (camera-left, upper-right corner, on the desk, along the jawline) and WHAT KIND of thing, so the fix cannot bleed into other regions.
- NEVER name a color, pattern, brand, or attribute in order to re-assert it. Positively naming an attribute invites the model to repaint exactly that attribute, and bakes your own perception errors into the prompt. Phrase every fix as restore / remove / stop-altering.
    BAD:  "Keep the shirt red." / "Make sure the earring is gold."
    GOOD: "Stop altering the garment on the upper body; reproduce it exactly as in the source video." / "Restore the small accessory at the subject's left ear exactly as in the source video."
- One correction per distinct aspect. Never bundle two fixes into one string.
For appearance, corrections name the item's KIND and LOCATION, never its color or pattern: "Restore the accessory at the subject's left ear exactly as in the source video." / "Stop altering the pattern of the garment on the upper body; reproduce its structure exactly from the source video."
```

**YOUR NOTES (appearance-fidelity):**

---

### 4.4 · `background-fidelity` — Room unchanged

| method | hard gate | weight | pass ≥ | borderline ≥ |
|---|---|---|---|---|
| hybrid | no | 0.12 | 82 | 70 |

*Plain-language purpose:* Makes sure the room behind the person stays the same — nothing added, removed, moved, or swapped, only lit differently.

*Field notes:* No live accuracy signal yet.

```text
Protocol: compare both complete videos over their full timelines.

ROLE
You are a set continuity supervisor for a video relighting pipeline. A generative model was instructed to change ONLY the lighting. Your job: verify the environment behind and around the subject is the same physical room, with special care NOT to punish legitimate relighting effects.

WHAT TO INSPECT — across corresponding moments, region by region
Sweep each pair systematically: upper-left, upper-right, camera-left of subject, camera-right of subject, desk/foreground. For each region compare:
1. Object presence and position: furniture, shelves, books, plants, cables, mugs, wall art, doors, windows.
2. Object identity: the same KIND of object in the same place (a mug that became a can is a violation even in the same spot).
3. Surface integrity: wall texture, wood grain, fabric weave — replaced or hallucinated texture is a violation.
4. Geometry: straight edges staying straight, shelf lines not warping, no melting or bending near the subject's silhouette (a common generative failure zone).
5. Content of framed items and windows: a picture whose content changed, a window whose view changed.

LIGHTING-EXPLAINABLE DIFFERENCES ARE NOT VIOLATIONS — this matters most here
Relighting SHOULD visibly change the background: shadows move, deepen, or soften; surfaces brighten or dim; color temperature shifts across walls; a rim light may add a soft gradient or glow on the back wall; new shadows may be cast BY existing objects. Punishing these would punish the product working as intended. A violation must be a change to the room itself, not to its illumination. Before recording any violation, ask: "could this exact difference be produced by changing the lights in this room, touching nothing?" If yes, it is not a violation.

SCORING ANCHORS
- 95: Every object, surface, and edge accounted for in every pair; all differences pass the "same room, new lights" test.
- 75: Room intact, but one region shows drift beyond lighting — an object's fine detail rewritten, mild texture hallucination on a wall area, slight geometry wobble near the subject's edge.
- 40: An object added, removed, or replaced; a region of the background repainted or rebuilt; window or picture content changed.

Thresholds for this eval: pass ≥ 82, borderline ≥ 70, else fail.

CORRECTION-WRITING RULES
Each "correction" string is inserted verbatim into the next generation prompt's ACTIVE CORRECTIONS section. Therefore:
- Imperative and self-contained: it must make sense with zero surrounding context. "Restore the original object on the shelf camera-left; remove the added item."
- Region-scoped: say WHERE (camera-left, upper-right corner, on the desk, along the jawline) and WHAT KIND of thing, so the fix cannot bleed into other regions.
- NEVER name a color, pattern, brand, or attribute in order to re-assert it. Positively naming an attribute invites the model to repaint exactly that attribute, and bakes your own perception errors into the prompt. Phrase every fix as restore / remove / stop-altering.
    BAD:  "Keep the shirt red." / "Make sure the earring is gold."
    GOOD: "Stop altering the garment on the upper body; reproduce it exactly as in the source video." / "Restore the small accessory at the subject's left ear exactly as in the source video."
- One correction per distinct aspect. Never bundle two fixes into one string.
For background, corrections are region-scoped restore/remove instructions: "Restore the original objects on the shelf camera-left; remove anything not present in the source video." / "Stop altering the wall surface behind the subject's right shoulder; reproduce it exactly as in the source video."
```

**YOUR NOTES (background-fidelity):**

---

### 4.5 · `lighting-quality-delta` — Lighting clearly better

| method | hard gate | weight | pass ≥ | borderline ≥ |
|---|---|---|---|---|
| dual-llm-judge | YES | 0.16 | 80 | 65 |

*Plain-language purpose:* The whole point: the new lighting must look clearly and professionally better than the original — handing back a near-copy counts as failure.

*Field notes:* ✓ Live signal (07-15 control experiment): correctly trashed (20–40) exposure-lifted copies — the anti-degenerate gate catches 'just brightened' as not-real-relighting. Working as designed.

```text
Protocol: compare both complete videos over their full timelines.

ROLE
You are a director of photography reviewing a professional relight of a webcam video. Every other eval in this pipeline protects what must NOT change; this one judges the thing that MUST: is the candidate's lighting a dramatic, professional improvement over the ORIGINAL?

ANTI-DEGENERATE GATE — read first
If the AFTER frames are visually a near-copy of the BEFORE frames — the same flat webcam lighting, no perceptible relight — the score MUST be below 40, no matter how clean the output is. A near-copy of the input would ace every preservation eval in this pipeline; this eval is the hard gate that blocks that trivial fixed point. "No meaningful relight" is total failure of the product's purpose, and it must be scored as such.

WHAT TO INSPECT — across corresponding moments
Compare each pair against the target: subtle three-point professional lighting believable in a webcam setting.
1. Key modelling: is there now a clear broad, soft, gently directional key (target: ~45° camera-left, slightly above eye level)? Does the face show gentle dimensional modelling with a soft shadow edge, instead of flat frontal illumination?
2. Face lift: estimate how many stops the facial MIDTONES (forehead, both cheeks, chin) were lifted vs the original. Target: 1.0–1.25 stops, enough that the face reads as professionally lit at normal viewing size. Report your estimate in "estimated_face_lift_stops" (see schema extension); null only if the face is unobservable.
3. Directional shaping, not exposure: a flat GLOBAL exposure increase must NOT count as directional shaping — if the face and background lifted by the same amount with no new key-to-shadow structure, that is the "global_exposure_only" failure, scored as if barely relit.
4. Fill balance: are shadows lifted enough to keep detail (target key-to-fill around 2:1 to 3:1) with natural falloff and the key-to-shadow difference preserved, without flattening the modelling?
5. Separation: is there rim/hair light tracing the hair and shoulders, visually separating subject from background?
6. Eyes: natural catchlights present?
7. Color: skin rendered natural and healthy in a consistent 4800-5600K neutral-to-subtly-warm range; whites clean, no color cast?
8. Exposure and roll-off: face correctly exposed with gradual highlight roll-off and full highlight detail — no blown highlights on the forehead, no crushed shadow side?
9. Believability: does it read as a well-produced interview achievable in this room — or as a theatrical effect pasted on?
Consistency counts: one coherent lighting treatment must hold across ALL frames, including the event-picked ones, not just the flattering ones — stable exposure, direction, fill ratio, and white balance from first frame to last.

NAMED FAILURE FLAGS — use these slugs as violation aspects where they fit
global_exposure_only (uniform brightness lift instead of a directional key), too_subtle (the relight is imperceptible at normal viewing size / face lift well under 1.0 stops), beauty_glow (the "improvement" is a diffusion/bloom effect on skin rather than lighting), over_warm (color pushed past subtly-warm into an orange cast), clipping (highlight detail destroyed on the face), halo_or_masking (a visible matte edge, glow seam, or masking boundary around the subject where the relight was applied).

SCORING ANCHORS
- 95: Dramatic, unmistakable transformation. Clear soft directional key, balanced fill, visible rim separation, clean catchlights, natural skin, perfect exposure — before/after looks like amateur webcam vs produced interview, and it holds in every frame.
- 75: Clearly better than the original, but incomplete: improved exposure and some directionality, yet weak subject-background separation, timid contrast, or an improvement that fades in some frames.
- 40: Barely changed from the original (see anti-degenerate gate), or changed for the worse — blown highlights, harsh unflattering shadows, a color cast, or a theatrical look that breaks webcam believability.

Thresholds for this eval: pass ≥ 80, borderline ≥ 65, else fail.

CORRECTION-WRITING RULES
Each "correction" string is inserted verbatim into the next generation prompt's ACTIVE CORRECTIONS section. Therefore:
- Imperative and self-contained: it must make sense with zero surrounding context. "Restore the original object on the shelf camera-left; remove the added item."
- Region-scoped: say WHERE (camera-left, upper-right corner, on the desk, along the jawline) and WHAT KIND of thing, so the fix cannot bleed into other regions.
- NEVER name a color, pattern, brand, or attribute in order to re-assert it. Positively naming an attribute invites the model to repaint exactly that attribute, and bakes your own perception errors into the prompt. Phrase every fix as restore / remove / stop-altering.
    BAD:  "Keep the shirt red." / "Make sure the earring is gold."
    GOOD: "Stop altering the garment on the upper body; reproduce it exactly as in the source video." / "Restore the small accessory at the subject's left ear exactly as in the source video."
- One correction per distinct aspect. Never bundle two fixes into one string.
For lighting quality, corrections direct the LIGHT, not the content: "Increase the strength and softness of the key light from camera-left; the face currently reads flat." / "Add subject-background separation with a subtle rim light on hair and shoulders." / "Reduce the highlight intensity on the subject's forehead; it is currently clipping."
```

**YOUR NOTES (lighting-quality-delta):**

---

### 4.6 · `motion-lipsync` — Movement & lips in sync

| method | hard gate | weight | pass ≥ | borderline ≥ |
|---|---|---|---|---|
| hybrid | YES | 0.12 | 86 | 74 |

*Plain-language purpose:* Every gesture and mouth movement must happen at exactly the same moment as in the original, so lips still match the real audio.

*Field notes:* ✓ Live signal (07-15 control experiment): 95/95/98 on ground-truth-perfect pairs (exposure-lifted copies, identical audio) — does NOT false-fail on dim footage. Its fails on real generations were likely genuine drift. Audio note: both videos reach the judge WITH audio; the candidate carries the bit-identical remuxed original track.

```text
Protocol: compare both complete videos over their full timelines.

ROLE
You are a motion fidelity examiner for a video relighting pipeline. The model was instructed to copy the performance exactly and change only the light. Because the final deliverable carries the ORIGINAL audio remuxed bit-for-bit, any deviation in mouth movement becomes a visible lip-sync error against real speech — this is a hard gate.

WHAT TO INSPECT — across corresponding moments
For each corresponding moment, verify the performance is IDENTICAL:
1. Pose: head position and rotation, shoulder line, torso lean — matched at each timestamp.
2. Mouth shape: the degree of mouth opening, lip posture, and visible teeth/tongue must match the original at the same timestamp. Treat mouth shapes as viseme snapshots: an "ah" that became an "mm" at the same instant is a lip-sync violation.
3. Eyes and brows: blink state (open/closed/mid-blink), gaze direction, eyebrow position at each timestamp.
4. Gesture: hand positions and any mid-gesture trajectory implied across consecutive samples — no damping, exaggeration, or re-animation.
5. Timing: nothing may lead or lag — an expression arriving one sample early is a re-timing violation.
The challenging motion and speech moments (max optical flow, max mouth-open) are your hardest evidence — motion errors concentrate exactly there. Inspect them with the most care.

LIGHTING-EXPLAINABLE DIFFERENCES ARE NOT VIOLATIONS
Shadows sweeping across the face as the head turns under the new key light, changed specularity on lips or teeth, darker or brighter rendering of the mouth interior — all expected. The geometry and timing of the motion is what must match, not its illumination.

SCORING ANCHORS
- 95: Every pair pose-identical; mouth shape matches the original at every timestamp including max-mouth-open; blinks and gestures land at exactly the same instants.
- 75: Motion matches overall, but one or two pairs show mild mouth-shape mismatch (slightly wrong opening degree) or a subtly damped gesture that would read as soft lip-sync drift.
- 40: Visible re-animation: a gesture retimed or missing, mouth shapes that no longer track the original's speech pattern, blinks invented or deleted. Unshippable with the real audio.

Thresholds for this eval: pass ≥ 86, borderline ≥ 74, else fail.

CORRECTION-WRITING RULES
Each "correction" string is inserted verbatim into the next generation prompt's ACTIVE CORRECTIONS section. Therefore:
- Imperative and self-contained: it must make sense with zero surrounding context. "Restore the original object on the shelf camera-left; remove the added item."
- Region-scoped: say WHERE (camera-left, upper-right corner, on the desk, along the jawline) and WHAT KIND of thing, so the fix cannot bleed into other regions.
- NEVER name a color, pattern, brand, or attribute in order to re-assert it. Positively naming an attribute invites the model to repaint exactly that attribute, and bakes your own perception errors into the prompt. Phrase every fix as restore / remove / stop-altering.
    BAD:  "Keep the shirt red." / "Make sure the earring is gold."
    GOOD: "Stop altering the garment on the upper body; reproduce it exactly as in the source video." / "Restore the small accessory at the subject's left ear exactly as in the source video."
- One correction per distinct aspect. Never bundle two fixes into one string.
For motion, corrections are stop/restore directives about movement, never about appearance: "Do not modify the subject's mouth movements in any way; copy them frame-exact from the source video." / "Restore the exact timing and trajectory of the subject's hand gesture near {timestamp}; do not smooth or re-animate it."
```

**YOUR NOTES (motion-lipsync):**

---

### 4.7 · `temporal-stability` — No flicker

| method | hard gate | weight | pass ≥ | borderline ≥ |
|---|---|---|---|---|
| hybrid | no | 0.08 | 80 | 68 |

*Plain-language purpose:* The relit video must hold steady from start to finish — no flickering, shimmering, wandering light, or colors slowly drifting.

*Field notes:* Note: in Lamp's whole-video mode the judge sees full clips, so flicker/drift are directly observable (the frame-grid caveat in the original template no longer applies).

```text
Protocol: compare both complete videos over their full timelines.

ROLE
You are a temporal stability examiner for a video relighting pipeline. Unlike the comparison evals, your primary subject is the CANDIDATE SEQUENCE ITSELF, viewed as a timeline: generative video models commonly produce frames that are individually plausible but unstable in sequence.

INPUTS
the complete ORIGINAL video attached first — a contact sheet of frames from the ORIGINAL video, sampled at fixed percentiles of the clip plus challenging motion and speech moments (maximum optical flow, largest face bounding box, maximum mouth-open). Each frame is labeled with its timestamp.
the complete CANDIDATE video attached second — compare corresponding moments by their source timeline. Lamp has no separate temporal-alignment score or gate; do not emit one.

You are one of two independent judges (the other is a different model). Do not hedge toward a safe middle score: confidence in this pipeline is MEASURED from judge disagreement, not self-reported, so your job is to score exactly what you see. Inspect the challenging motion and speech moments hardest — failures concentrate where motion and expression peak.
For this eval, read the complete CANDIDATE video attached second primarily as a TIME SERIES (they are ordered by timestamp), and use the complete ORIGINAL video attached first as the stability baseline — the original is temporally stable by construction, so any inter-frame variation present in the after set but absent in the before set at the same timestamps is model-introduced.

WHAT TO INSPECT — across the AFTER sequence
1. Exposure flicker: overall or regional brightness pumping between consecutive samples that the original does not show.
2. Lighting wander: the key light's direction, softness, or contrast changing over the clip without a scene reason.
3. Color drift: color temperature or a hue slowly sliding across the clip (compare the first and last samples directly — slow drift hides between neighbors).
4. Texture shimmer / boiling: static regions (walls, furniture, garment fabric) whose fine texture re-renders differently sample to sample.
5. Popping: shadows, highlights, or small details that appear/disappear abruptly between consecutive samples.
6. Edge stability: the subject's silhouette boundary staying crisp and consistent rather than crawling.

WHAT NOT TO PUNISH
Variation with a scene cause: the subject moving (shadows correctly shift), auto-exposure-like changes present in the ORIGINAL at the same timestamps, or compression noise inherited from the source. If the before sequence shows the same instability at the same timestamps, it is not model-introduced.

SCORING ANCHORS
- 95: The after sequence is as steady as the original — consistent exposure, fixed lighting setup, stable textures and edges from first sample to last; first vs last frames match in temperature and contrast.
- 75: Stable overall, but with noticeable minor instability — a subtle brightness pump between two samples, mild texture shimmer on one background region, or a slight temperature shift detectable between first and last frames.
- 40: Distracting instability: visible flicker across multiple samples, the lighting setup wandering mid-clip, or boiling textures that would immediately read as "AI video" to a viewer.

Thresholds for this eval: pass ≥ 80, borderline ≥ 68, else fail.

CORRECTION-WRITING RULES
Each "correction" string is inserted verbatim into the next generation prompt's ACTIVE CORRECTIONS section. Therefore:
- Imperative and self-contained: it must make sense with zero surrounding context. "Restore the original object on the shelf camera-left; remove the added item."
- Region-scoped: say WHERE (camera-left, upper-right corner, on the desk, along the jawline) and WHAT KIND of thing, so the fix cannot bleed into other regions.
- NEVER name a color, pattern, brand, or attribute in order to re-assert it. Positively naming an attribute invites the model to repaint exactly that attribute, and bakes your own perception errors into the prompt. Phrase every fix as restore / remove / stop-altering.
    BAD:  "Keep the shirt red." / "Make sure the earring is gold."
    GOOD: "Stop altering the garment on the upper body; reproduce it exactly as in the source video." / "Restore the small accessory at the subject's left ear exactly as in the source video."
- One correction per distinct aspect. Never bundle two fixes into one string.
For stability, corrections demand constancy: "Hold the lighting setup perfectly constant across the entire clip; brightness currently pulses around {timestamp}." / "Stop re-rendering the texture of the background region camera-right; keep it identical across frames."
```

**YOUR NOTES (temporal-stability):**

---

### 4.8 · `hallucination-artifacts` — Nothing invented

| method | hard gate | weight | pass ≥ | borderline ≥ |
|---|---|---|---|---|
| dual-llm-judge | YES | 0.06 | 90 | 80 |

*Plain-language purpose:* Scans for anything the AI made up — warped hands, melted textures, ghost limbs, or objects and text that were never in the room.

*Field notes:* No live accuracy signal yet. Strictest thresholds in the set (pass ≥ 90) by design.

```text
Protocol: compare both complete videos over their full timelines.

ROLE
You are a generative-artifact inspector. Your specialty: defects that comparison-based evals structurally miss, because they only look where the original directs their attention. You look everywhere.

PART 1 — COMPARISON-FREE SCAN (primary)
Inspect the complete CANDIDATE video attached second ALONE, one frame at a time, as if you had never seen the original. For EACH frame, sweep fully before moving to the next — generative artifacts are frequently single-frame events that vanish by the next sample:
1. Hands and fingers: wrong counts, warped or fused fingers, hands merging with objects or clothing.
2. Body coherence: ghost or duplicated limbs, impossible joint angles, a second partial face or figure anywhere in frame.
3. Texture integrity: melted, smeared, or "dream-like" patches on skin, fabric, or surfaces.
4. Geometry: edges that bend where they should be straight, objects fused into each other, physically impossible reflections or shadows (a shadow with no caster, a caster with no shadow).
5. Invented content: objects, text-like glyphs, logos, watermarks, or UI fragments that a webcam would not produce — and specifically any VISIBLE light fixture (lamp, softbox, ring light, new window): the relight must arrive as illumination only, never as rendered equipment.
6. Frame edges and the subject's silhouette boundary: the two zones where generators most often smear.

PART 2 — ADDED/REMOVED-OBJECT SWEEP (secondary)
Now compare against the complete ORIGINAL video attached first: one deliberate pass over each pair asking a single question — is anything present in one set and absent in the other? This catches confident, clean-looking insertions and deletions that the comparison-free scan can rationalize as plausible.

SEVERITY GUIDANCE
Any anatomical artifact (hands, limbs, faces) is CRITICAL regardless of how brief. Added/removed objects and invented fixtures or text are CRITICAL to MAJOR. Localized single-frame texture smears are MAJOR to MINOR. This eval's thresholds are strict by design (pass ≥ 90): a single vivid artifact destroys viewer trust in the whole clip.

NOTE ON LIGHTING
New shadows, glows, gradients, and highlights ARE the product working. A shadow is only a violation when it is physically impossible (no caster) — not when it is merely new.

SCORING ANCHORS
- 95: Clean sweep — every frame free of anatomical, textural, geometric, and invented-content artifacts; the object sweep finds nothing added or removed.
- 75: One subtle, non-anatomical single-frame artifact (a brief texture smear in a background corner) that most viewers would miss. Sits below the pass bar by design.
- 40: Any warped hand, ghost limb, duplicated feature, invented object, visible added light fixture, or text-like hallucination — in even one frame.

Thresholds for this eval: pass ≥ 90, borderline ≥ 80, else fail.

CORRECTION-WRITING RULES
Each "correction" string is inserted verbatim into the next generation prompt's ACTIVE CORRECTIONS section. Therefore:
- Imperative and self-contained: it must make sense with zero surrounding context. "Restore the original object on the shelf camera-left; remove the added item."
- Region-scoped: say WHERE (camera-left, upper-right corner, on the desk, along the jawline) and WHAT KIND of thing, so the fix cannot bleed into other regions.
- NEVER name a color, pattern, brand, or attribute in order to re-assert it. Positively naming an attribute invites the model to repaint exactly that attribute, and bakes your own perception errors into the prompt. Phrase every fix as restore / remove / stop-altering.
    BAD:  "Keep the shirt red." / "Make sure the earring is gold."
    GOOD: "Stop altering the garment on the upper body; reproduce it exactly as in the source video." / "Restore the small accessory at the subject's left ear exactly as in the source video."
- One correction per distinct aspect. Never bundle two fixes into one string.
For hallucinations, corrections are remove/stop directives pinned to a region: "Remove the invented object in the lower-right corner of the frame; nothing is present there in the source video." / "Stop distorting the subject's right hand around {timestamp}; reproduce it exactly as in the source video." / "Remove the visible light fixture at the top edge of the frame; the relight must not render its own equipment."
```

**YOUR NOTES (hallucination-artifacts):**

---

## 5 · How violations become the v2 prompt (correction mechanics)

1. Every violation's `correction` string is taken **verbatim** (empty/missing corrections are skipped).
2. Keyed `corr:<evalId>:<aspect-slug>` — same aspect across iterations dedupes, keeping the most severe.
3. Ordered critical > major > minor, **silently capped at 12** active corrections.
4. Spliced into the persisted v1 prompt between `[ACTIVE CORRECTIONS FROM EVALUATION]` and `[NEVER DO]` — everything else byte-identical. Empty list renders `(none — first iteration or all prior findings resolved)`.

*(Files: `lib/prompts/mega-prompt.ts:nextMegaPrompt`, `lib/lamp-evaluation.ts:compileLampFinalPrompt`.)*

The generation prompt's immutable base (the "locks") lives in `lib/prompts/base-prompt.ts` — region-scoped prohibitions for identity/performance/wardrobe/background/camera/audio, pink-elephant discipline (never name a mutable attribute positively). Say the word if you want those lock texts inlined here for editing too.

**YOUR NOTES (corrections / base prompt):**

---

## 6 · Paste-back map (what edits land where)

| You edit | Claude applies to | Caveats |
|---|---|---|
| Rubric text (§4 blocks) | `lib/prompts/eval-defs.ts` promptTemplate for shared policy; the approved skin policy requires a Lamp-only override | New evaluator text ⇒ new paid-op input hashes (affects new runs only); do not change Flora's skin policy implicitly |
| Preamble (§2) | `lib/server/lamp-evaluator.ts:evaluatorPrompt()` | same as above |
| Thresholds / weights / gates (§3) | shared values live in `lib/prompts/eval-defs.ts`; Lamp-only overrides belong in the Lamp evaluation policy | weights must remain internally consistent; ids are pinned (UI/mock depend on them); Lamp skin 85/70 must not alter Flora |
| Flow changes (§1) | `workflows/durable-relight-run.ts` + related | anything touching generations/spend gets the full test+review treatment before any paid run |
