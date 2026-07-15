import type { EvalDefinition, WorkflowMode } from "@/lib/types";

/**
 * EVAL_DEFS — the rubric library. The intellectual core of the eval loop.
 *
 * Eleven evals, deterministic-first hybrid, judged by two independent vision
 * models (Claude + Gemini). Order, ids, weights, thresholds, and gates are
 * PINNED: the mock scenario and the UI depend on them, and the weights sum to
 * exactly 1.0 (0.02 + 0.02 + 0.14 + 0.08 + 0.12 + 0.12 + 0.16 + 0.08 + 0.12 +
 * 0.08 + 0.06 = 1.00). Composite = weighted mean normalized by the weight of
 * the evals actually present (sum(weight * score) / sum(weight)), so gate-time
 * composites (audio-integrity not yet run) and post-remux composites share the
 * same 0-100 basis; an iteration passes when the composite reaches the
 * workflow threshold AND every hardGate eval passes.
 *
 * Method legend:
 *  - deterministic:   pure code metric, no model call, ever.
 *  - hybrid:          deterministic metric runs FIRST and short-circuits
 *                     catastrophic failures before any judge spend; judges
 *                     then adjudicate the nuanced remainder.
 *  - dual-llm-judge:  Claude and Gemini judge independently on the same
 *                     frames; disagreement drives the confidence meter, and
 *                     low confidence forces "borderline" + human review.
 *
 * Frames are sampled at fixed percentiles PLUS event-picked frames (max
 * optical flow, largest face bbox, max mouth-open) — drift hides in the
 * hardest frames.
 */

/** How judge frames are presented. Shared preamble across comparison rubrics. */
const FRAME_PREAMBLE = `INPUTS
{{BEFORE_FRAMES}} — a contact sheet of frames from the ORIGINAL video, sampled at fixed percentiles of the clip plus event-picked frames (maximum optical flow, largest face bounding box, maximum mouth-open). Each frame is labeled with its timestamp.
{{AFTER_FRAMES}} — frames from the CANDIDATE relit video at the SAME timestamps. The pairs are index-locked: frame i of each set was sampled at the same instant. A temporal-alignment gate has already verified this registration; you may trust it.

You are one of two independent judges (the other is a different model). Do not hedge toward a safe middle score: confidence in this pipeline is MEASURED from judge disagreement, not self-reported, so your job is to score exactly what you see. Inspect the event-picked frames hardest — failures concentrate where motion and expression peak.`;

/**
 * Strict output contract. Identical for every judged eval.
 *
 * INPUT_ERROR note: the team's production schema also carries an INPUT_ERROR
 * status (missing/unreadable video). In this pipeline that condition is
 * handled by the ENGINE before any judge is invoked — a judge never receives
 * a broken input and must never emit anything outside pass/borderline/fail.
 */
const OUTPUT_SCHEMA = `OUTPUT
Respond with STRICT JSON only — no markdown fences, no text before or after the JSON object. Schema:
{
  "score": <integer 0-100>,
  "verdict": "pass" | "borderline" | "fail",
  "violations": [
    {
      "aspect": "<short stable kebab-case slug for the violated aspect, e.g. \\"left-earring\\", \\"wall-shelf\\", \\"jawline\\". Reuse the same slug for the same aspect across iterations — it keys the correction ledger>",
      "severity": "critical" | "major" | "minor",
      "description": "<one or two factual sentences: what is wrong and where>",
      "frameTimestampSec": <number — timestamp of the clearest offending frame>,
      "correction": "<imperative fix per the correction rules below>"
    }
  ],
  "coverage": {
    "start": <boolean>,
    "middle": <boolean>,
    "end": <boolean>,
    "speech": <boolean>,
    "fast_motion": <boolean>
  },
  "reasoning": "<3-6 sentences: what you compared, what you found, why this score>"
}
"violations" must be an empty array when there are none. The verdict must be consistent with your score under this eval's thresholds (stated above).
"coverage" is your inspection proof, not a formality: mark true ONLY the segments you actually examined (clip start / middle / end, frames during speech, frames during fast motion). Any coverage field left false caps your score at this eval's borderline threshold — an uninspected segment cannot be certified as passing.
REVIEW semantics: when a criterion of this rubric is UNOBSERVABLE in the provided material (e.g. no speech frames were sampled, the region is occluded in every frame), do not guess — use verdict "borderline" and state in "reasoning" exactly what could not be observed and why. Borderline routes to human review; a confident score on unobserved evidence is worse than no score.`;

/** Rules for writing corrections — each string is compiled VERBATIM into the next generation prompt. */
const CORRECTION_RULES = `CORRECTION-WRITING RULES
Each "correction" string is inserted verbatim into the next generation prompt's ACTIVE CORRECTIONS section. Therefore:
- Imperative and self-contained: it must make sense with zero surrounding context. "Restore the original object on the shelf camera-left; remove the added item."
- Region-scoped: say WHERE (camera-left, upper-right corner, on the desk, along the jawline) and WHAT KIND of thing, so the fix cannot bleed into other regions.
- NEVER name a color, pattern, brand, or attribute in order to re-assert it. Positively naming an attribute invites the model to repaint exactly that attribute, and bakes your own perception errors into the prompt. Phrase every fix as restore / remove / stop-altering.
    BAD:  "Keep the shirt red." / "Make sure the earring is gold."
    GOOD: "Stop altering the garment on the upper body; reproduce it exactly as in the source video." / "Restore the small accessory at the subject's left ear exactly as in the source video."
- One correction per distinct aspect. Never bundle two fixes into one string.`;

export const EVAL_DEFS: EvalDefinition[] = [
  // -------------------------------------------------------------------------
  // 1. audio-integrity — deterministic, hard gate
  // -------------------------------------------------------------------------
  {
    id: "audio-integrity",
    name: "Source audio preserved",
    category: "audio",
    description:
      "Confirms each generated cut delivers the canonical source track unchanged, or stays silent when the source is silent; provider-generated sound is never delivered.",
    method: "deterministic",
    hardGate: true,
    weight: 0.02,
    passThreshold: 99,
    borderlineThreshold: 99,
    promptTemplate: "",
    deterministicNote:
      "No model grades this check. Ingest extracts a canonical source track (stream-copy when container-compatible; one ingest transcode otherwise). After each generation, Lamp discards provider sound and stream-copies that canonical track onto the candidate, or strips all audio when the source is silent. It then requires matching audio presence, raw/final/source timeline agreement within 50 ms, and matching source/final audio-bitstream MD5 over the aligned complete timeline. Score is binary: 100 only when every invariant passes; 0 otherwise. A failure stops before the paid visual evaluation, so it cannot become gradeable.",
  },

  // -------------------------------------------------------------------------
  // 2. temporal-alignment — deterministic, hard gate
  // -------------------------------------------------------------------------
  {
    id: "temporal-alignment",
    name: "Timing matches",
    category: "temporal",
    description:
      "Checks that the new video lines up with the original frame for frame — nothing sped up, slowed down, or shifted in time.",
    method: "deterministic",
    hardGate: true,
    weight: 0.02,
    passThreshold: 95,
    borderlineThreshold: 85,
    promptTemplate: "",
    deterministicNote:
      "Protocol: video-native — this check consumes both full videos; no judge and no frame grid. No prompt — pure code. Per-frame perceptual hash (pHash) and edge-map correlation are computed between original and candidate across a sliding offset of ±3 frames. The correlation curve must peak at offset 0: a peak at any nonzero offset means the candidate was retimed, or dropped/duplicated frames, and every index-locked frame-pair comparison downstream would compare the wrong instants without anyone noticing. Runs BEFORE all comparison evals as their precondition. Score: 100 when the peak sits at offset 0 with a clear margin over neighbors; degraded as the margin narrows (ambiguous registration); 0 when the peak is off-zero. Hard gate.",
  },

  // -------------------------------------------------------------------------
  // 3. identity-preservation — hybrid, hard gate
  // -------------------------------------------------------------------------
  {
    id: "identity-preservation",
    name: "Same person",
    category: "identity",
    description:
      "Makes sure the person in the new video is unmistakably the same person as in the original, in every single frame.",
    method: "hybrid",
    hardGate: true,
    weight: 0.14,
    passThreshold: 88,
    borderlineThreshold: 75,
    promptTemplate: `Protocol: frame-grid — you receive matched stills (index-locked before/after frame pairs), not full videos.

ROLE
You are a forensic identity examiner for a video relighting pipeline. A generative model was instructed to change ONLY the lighting of a webcam video. Your job: verify that the person in the output is the same human being as in the input, in every frame, with no drift in facial structure or skin detail.

${FRAME_PREAMBLE}

WHAT TO INSPECT — frame-pair by frame-pair
For each index-locked pair, compare:
1. Facial geometry: eye spacing and shape, nose bridge and tip, jawline, chin, cheekbone structure, ear shape, forehead proportion.
2. Skin detail: moles, scars, freckles, wrinkles, and blemishes — both PRESENCE and POSITION. A mole that moved is as serious as a mole that vanished.
3. Apparent age and facial hair: no de-aging, no beard densification or thinning.
4. Skin texture: pores and fine lines must survive. Systematic smoothing or "beautification" is an identity violation even when the person remains recognizable — it is the most common failure mode of generative relighting.
Judge the WORST pair, not the average: identity is gated on the minimum. One off-identity frame fails a 10-second clip, because one frame is all a viewer needs to notice.

LIGHTING-EXPLAINABLE DIFFERENCES ARE NOT VIOLATIONS
This is a relighting task. New shadows across the face, brighter or dimmer skin rendering, a shifted color temperature, catchlights appearing in the eyes — all expected, none of them violations. The distinction: illumination changes how the face is LIT; a violation changes what the face IS. Shadow falling differently on the same nose: fine. A subtly different nose: violation.

SCORING ANCHORS
- 95: Same person beyond any doubt in every pair, including the hardest event-picked frames. All differences are strictly lighting-explainable. Skin texture fully intact.
- 75: Same person overall, but one or two frames show mild feature drift (a jawline that reads slightly different under a heavy shadow, minor texture loss on the shadow side) that a careful viewer might catch.
- 40: A frame exists where the face reads as a different or heavily altered person — or the whole clip shows systematic beautification/smoothing. Automatic fail territory.

Thresholds for this eval: pass ≥ 88, borderline ≥ 75, else fail.

${CORRECTION_RULES}
For identity, corrections must be scoped to the facial region and phrased as restore/stop, e.g. "Stop altering the shape of the subject's nose; reproduce the facial structure exactly as in the source video." or "Restore natural skin texture on the subject's face; remove all smoothing."

${OUTPUT_SCHEMA}`,
    deterministicNote:
      "Future-real deterministic tier (runs first): ArcFace face-embedding cosine similarity computed per sampled frame against embeddings from the original. Gated on the WORST frame — both min AND mean similarity must clear threshold, because a single off-identity frame breaks the clip. A deterministic catastrophic failure (min similarity below floor) short-circuits to fail with zero judge spend; otherwise both LLM judges run the rubric above to catch what embeddings miss (texture smoothing, mark deletion).",
  },

  // -------------------------------------------------------------------------
  // 4. skin-texture-age — hybrid, hard gate
  // -------------------------------------------------------------------------
  {
    id: "skin-texture-age",
    name: "Natural skin (no airbrushing)",
    category: "identity",
    description:
      "Checks that skin still looks real — pores, lines, freckles, and age all kept exactly as they were, with no airbrushed or beautified finish.",
    method: "hybrid",
    hardGate: true,
    weight: 0.08,
    passThreshold: 88,
    borderlineThreshold: 75,
    promptTemplate: `Protocol: frame-grid — you receive matched stills (index-locked before/after frame pairs), not full videos.

ROLE
You are a skin-rendering examiner for a video relighting pipeline. A generative model was instructed to change ONLY illumination and color response. Your job: verify that the SKIN ITSELF — its structure, texture, marks, and apparent age — survived at original strength. This is the eval that catches the model quietly "improving" the person: identity-preservation asks "same human?"; you ask "same skin, at the same strength?" — a subtler and more common failure.

${FRAME_PREAMBLE}

FACTOR OUT THE LIGHT FIRST
Illumination and color response are PERMITTED differences; judge the underlying skin structure after factoring them out. Before comparing any pair, mentally normalize: brighter midtones, a lifted shadow side, warmer color, new catchlight-driven sparkle in the eyes, shifted specular placement on the forehead or nose — all are the product working. Then ask of what remains: is this the same skin? A pore field that dims under softer light is fine; a pore field that VANISHES is not.

WHAT TO INSPECT — region by region, in every pair
Sweep each of these regions explicitly: forehead, both cheeks, nose, under-eyes, mouth area, chin, jaw, ears, neck, and hairline. For each region compare:
1. Complexion fidelity: the same underlying complexion and undertone, with natural color variation (redness patches, uneven tone) preserved — not homogenized into an even, makeup-like finish.
2. Texture retention: pores, fine lines, and microcontrast at ORIGINAL strength. Systematic softening reads as "filtered" at normal viewing size even when no single frame looks wrong.
3. Marks and facial hair: every blemish, mole, freckle, scar, and hair of stubble/brow present at original density and position — no thinning, no cleanup, no densification.
4. Apparent age: wrinkle depth, skin laxity, under-eye character unchanged. De-aging AND artificial aging (added wrinkles from over-sharpened texture) are both violations.
5. Highlight roll-off: a natural matte-to-satin response with gradual roll-off — not plastic, waxy, glossy, or "beauty glow" rendering; not clipped-flat highlight patches.
6. Reflectance character: skin should still read as skin — diffuse with subtle specularity — not as a smoothed 3D render.
Inspect across the clip's events: speech frames, blink frames, head-turn frames, and BOTH the highlight side and shadow-side frames of the face. Smoothing hides on the bright side; invented texture hides in the shadows.

WHAT TO DETECT — the canonical failure modes (use these slugs as violation aspects where they fit)
beautification, smoothing, plastic_or_waxy (plastic highlights / waxy finish), added_wrinkles, apparent-age shift (either direction), texture_crawl (texture that re-renders pair to pair instead of persisting), local glow (a beautifying halo on cheeks or forehead), makeup-like color (homogenized, foundation-like tone), invented_catchlights (eye sparkle with no plausible source in the stated lighting setup).

SCORING ANCHORS
- 95: Source skin at original strength under the new light — every region's pores, lines, marks, and age character intact in every pair, including highlight-side frames; differences are strictly illumination and color response.
- 75: Subtle smoothing visible at normal viewing size — one or two regions (typically cheeks or forehead) read slightly "filtered", or highlight roll-off turns faintly waxy on the bright side, though the person's age and marks survive.
- 40: Obvious beautification or apparent-age shift — pore fields erased, blemishes cleaned up, wrinkles removed or invented, a foundation-like complexion, or plastic/waxy highlight rendering across the face.

Thresholds for this eval: pass ≥ 88, borderline ≥ 75, else fail.

${CORRECTION_RULES}
For skin, corrections must be region-scoped imperatives that restore strength without naming target attributes: "Restore pore-level texture on both cheeks; do not smooth or de-age." / "Restore the natural skin marks on the forehead exactly as in the source video; remove all cleanup." / "Render the highlight on the nose and forehead with a gradual matte-to-satin roll-off; remove the waxy specular rendering."

${OUTPUT_SCHEMA}`,
    deterministicNote:
      "Future-real deterministic tier (runs first): face-region high-frequency energy ratio plus pore-scale texture correlation vs the source, computed after photometric normalization (so the lighting change itself does not register as texture change). Flags when texture energy drops more than 10% on any face region — a drop that large is smoothing, not lighting. Deterministic flag short-circuits to the judges with the offending regions named; judges adjudicate beautification, waxiness, and apparent-age shift that energy metrics cannot see.",
  },

  // -------------------------------------------------------------------------
  // 5. appearance-fidelity — dual-llm-judge, hard gate
  // -------------------------------------------------------------------------
  {
    id: "appearance-fidelity",
    name: "Hair & clothing unchanged",
    category: "appearance",
    description:
      "Checks that hair, clothes, glasses, and jewelry all stay exactly as they were — nothing appears, disappears, or changes.",
    method: "dual-llm-judge",
    hardGate: true,
    weight: 0.12,
    passThreshold: 85,
    borderlineThreshold: 72,
    promptTemplate: `Protocol: frame-grid — you receive matched stills (index-locked before/after frame pairs), not full videos.

ROLE
You are a wardrobe continuity supervisor for a video relighting pipeline. A generative model was instructed to change ONLY the lighting. Your job: verify that the subject's hair and everything they wear survived exactly — via a BLIND INVENTORY protocol designed so that nothing primes you about what to look for.

${FRAME_PREAMBLE}

BLIND-INVENTORY PROTOCOL — follow the steps in strict order
STEP 1 — Inspect {{BEFORE_FRAMES}} ONLY. Write (internally) a complete inventory of the subject's appearance: hair (length, texture, style, parting), every garment and layer (item type, where worn, construction — collar type, sleeve length, closures — and pattern GEOMETRY: note that a pattern exists and its structure, e.g. "horizontal stripes", "small repeating motif"), and every accessory (glasses, earrings, necklaces, headphones, watch, lanyard, pins, hat). Note locations: left ear, right wrist, around the neck.
STEP 2 — Set the before-inventory aside. Inspect {{AFTER_FRAMES}} ONLY and build a second inventory to the identical standard, independently, as if you had never seen the first set.
STEP 3 — Diff the two inventories item by item. Every discrepancy becomes a candidate violation: items missing from the after-inventory, items present only in the after-inventory, items whose category or construction changed, hair whose length/texture/style changed, pattern geometry that simplified or transformed.
The blind protocol matters: diffing two independent inventories catches vanished items that a "check whether X is still there" prompt would never surface.

LIGHTING-EXPLAINABLE DIFFERENCES ARE NOT VIOLATIONS
Relighting legitimately changes how fabric and hair LOOK: brighter or deeper colors, shifted saturation, new sheen or highlights on hair, shadow bands across a garment. None of these are violations. Violations are STRUCTURAL: a striped garment becoming solid, an earring vanishing, glasses appearing, a collar changing type, hair becoming shorter or straighter. Rule of thumb: if the difference survives imagining both frames under the same light, it is a violation.

SCORING ANCHORS
- 95: The two inventories match item-for-item; hair identical in structure; every visual difference is lighting-explainable.
- 75: All items present, but one item shows drift beyond lighting — pattern geometry subtly simplified, an accessory intermittently missing in a single frame, hair texture partially altered.
- 40: An item added or removed outright, a garment's category or construction changed, or hair restyled. Hard-gate failure territory.

Thresholds for this eval: pass ≥ 85, borderline ≥ 72, else fail.

${CORRECTION_RULES}
For appearance, corrections name the item's KIND and LOCATION, never its color or pattern: "Restore the accessory at the subject's left ear exactly as in the source video." / "Stop altering the pattern of the garment on the upper body; reproduce its structure exactly from the source video."

${OUTPUT_SCHEMA}`,
  },

  // -------------------------------------------------------------------------
  // 6. background-fidelity — hybrid, soft
  // -------------------------------------------------------------------------
  {
    id: "background-fidelity",
    name: "Room unchanged",
    category: "background",
    description:
      "Makes sure the room behind the person stays the same — nothing added, removed, moved, or swapped, only lit differently.",
    method: "hybrid",
    hardGate: false,
    weight: 0.12,
    passThreshold: 82,
    borderlineThreshold: 70,
    promptTemplate: `Protocol: frame-grid — you receive matched stills (index-locked before/after frame pairs), not full videos.

ROLE
You are a set continuity supervisor for a video relighting pipeline. A generative model was instructed to change ONLY the lighting. Your job: verify the environment behind and around the subject is the same physical room, with special care NOT to punish legitimate relighting effects.

${FRAME_PREAMBLE}

WHAT TO INSPECT — frame-pair by frame-pair, region by region
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

${CORRECTION_RULES}
For background, corrections are region-scoped restore/remove instructions: "Restore the original objects on the shelf camera-left; remove anything not present in the source video." / "Stop altering the wall surface behind the subject's right shoulder; reproduce it exactly as in the source video."

${OUTPUT_SCHEMA}`,
    deterministicNote:
      "Future-real deterministic tier (runs first): person-masked background SSIM computed per frame-pair on a tile grid. Tiles with high SSIM are auto-cleared with zero judge spend; only SUSPICIOUS low-SSIM tiles are escalated to the LLM judges for adjudication — 'lighting-explainable (shadow moved, surface brightened) vs object change (thing added/removed/replaced)'. Judge cost scales with suspicion, not with video length.",
  },

  // -------------------------------------------------------------------------
  // 7. lighting-quality-delta — dual-llm-judge, hard gate
  // -------------------------------------------------------------------------
  {
    id: "lighting-quality-delta",
    name: "Lighting clearly better",
    category: "lighting",
    description:
      "The whole point: the new lighting must look clearly and professionally better than the original — handing back a near-copy counts as failure.",
    method: "dual-llm-judge",
    hardGate: true,
    weight: 0.16,
    passThreshold: 80,
    borderlineThreshold: 65,
    promptTemplate: `Protocol: either — this rubric works on matched stills (frame-grid) or on both full videos (video-native); judge whatever material you are given.

ROLE
You are a director of photography reviewing a professional relight of a webcam video. Every other eval in this pipeline protects what must NOT change; this one judges the thing that MUST: is the candidate's lighting a dramatic, professional improvement over the ORIGINAL?

${FRAME_PREAMBLE}

ANTI-DEGENERATE GATE — read first
If the AFTER frames are visually a near-copy of the BEFORE frames — the same flat webcam lighting, no perceptible relight — the score MUST be below 40, no matter how clean the output is. A near-copy of the input would ace every preservation eval in this pipeline; this eval is the hard gate that blocks that trivial fixed point. "No meaningful relight" is total failure of the product's purpose, and it must be scored as such.

WHAT TO INSPECT — frame-pair by frame-pair
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

${CORRECTION_RULES}
For lighting quality, corrections direct the LIGHT, not the content: "Increase the strength and softness of the key light from camera-left; the face currently reads flat." / "Add subject-background separation with a subtle rim light on hair and shoulders." / "Reduce the highlight intensity on the subject's forehead; it is currently clipping."

${OUTPUT_SCHEMA}

SCHEMA EXTENSION — this eval only
Add one additional top-level field to the JSON object:
  "estimated_face_lift_stops": <number | null>
Your best estimate of the facial-midtone lift vs the original, in photographic stops (target 1.0–1.25). Use null ONLY when the face cannot be observed well enough to estimate. An estimate near 0 with a high score is self-contradictory; an estimate far above 1.25 should show up as clipping or believability violations.`,
  },

  // -------------------------------------------------------------------------
  // 8. lighting-match-to-anchor — dual-llm-judge, soft
  // -------------------------------------------------------------------------
  {
    id: "lighting-match-to-anchor",
    name: "Matches approved look",
    category: "lighting",
    description:
      "Checks that the whole video carries the same lighting as the approved target lighting photo, from the first frame to the last.",
    method: "dual-llm-judge",
    hardGate: false,
    weight: 0.08,
    passThreshold: 78,
    borderlineThreshold: 65,
    promptTemplate: `Protocol: either — this rubric works on matched stills (frame-grid) or on the anchor plus the full candidate video (video-native); judge whatever material you are given.

ROLE
You are a lighting continuity supervisor. In this pipeline, the creative lighting decision was already made and APPROVED at the still-image stage: a single relit "Look Anchor" frame. The video model's only job was to propagate that approved look across the whole clip. You judge propagation fidelity — NOT whether the look is good (a separate eval owns that), but whether the video carries the SAME look that was signed off.

INPUTS
{{BEFORE_FRAMES}} — frames from the ORIGINAL (pre-relight) video at fixed percentiles plus event-picked frames, each labeled with its timestamp. These show the starting point only — they are NOT the target look.
ANCHOR — the approved LOOK ANCHOR still, delivered as a separate, explicitly labeled reference image (anchorFrameDataUrl). THIS is the look that was signed off.
{{AFTER_FRAMES}} — frames from the candidate relit video at the same timestamps, each labeled with its timestamp. Compare each AFTER frame's lighting against the ANCHOR reference, not against the BEFORE frames.

You are one of two independent judges. Do not hedge toward the middle: confidence is measured from judge disagreement, so score exactly what you see.

WHAT TO INSPECT — every video frame against the anchor
For each AFTER frame, compare its lighting to the anchor across:
1. Key direction: does light arrive from the same side and elevation, with shadows falling the same way on nose and jaw?
2. Shadow quality: same softness of shadow edge, same depth of the shadow side.
3. Contrast ratio: the same key-to-fill balance — not brighter-flatter, not moodier-harsher.
4. Color temperature: the same warmth on skin and background, with no drift toward cooler or warmer.
5. Rim/separation: the same edge light presence on hair and shoulders.
6. Background luminance: the environment lit to the same level and gradient as in the anchor.
Also judge CONSISTENCY OF THE MATCH across time: a clip that matches the anchor at the start and drifts away by the end fails propagation even if the average is close.

WHAT NOT TO PUNISH
The subject moves; the anchor is one frozen instant. Shadows shifting naturally as the head turns, or a catchlight moving with the eyes, are correct propagation, not mismatch. Judge the LIGHTING SETUP the frame implies, not pixel equality with the anchor.

SCORING ANCHORS
- 95: Every frame reads as the anchor's lighting setup filmed in motion — same key direction, contrast, temperature, separation, background level, from first frame to last.
- 75: The look is recognizably the anchor's, but drifts — contrast flattening in some frames, mild temperature wander, or rim light that comes and goes.
- 40: The video's lighting is a materially different setup from the approved anchor (different key side, different mood, different temperature) — approval was rendered meaningless.

Thresholds for this eval: pass ≥ 78, borderline ≥ 65, else fail.

${CORRECTION_RULES}
For anchor match, corrections steer propagation back to the approved look without naming content attributes: "Match the key light direction of the approved anchor frame; light currently arrives from the wrong side in the second half of the clip." / "Hold the anchor frame's color temperature constant across the entire clip; the final seconds drift cooler."

${OUTPUT_SCHEMA}`,
  },

  // -------------------------------------------------------------------------
  // 9. motion-lipsync — hybrid, hard gate
  // -------------------------------------------------------------------------
  {
    id: "motion-lipsync",
    name: "Movement & lips in sync",
    category: "motion",
    description:
      "Every gesture and mouth movement must happen at exactly the same moment as in the original, so lips still match the real audio.",
    method: "hybrid",
    hardGate: true,
    weight: 0.12,
    passThreshold: 86,
    borderlineThreshold: 74,
    promptTemplate: `Protocol: frame-grid today — matched stills at fixed + event-picked timestamps; full-motion certification is delegated to the deterministic tier described in deterministicNote. When video-native judging lands (Gemini video input), this rubric upgrades to receiving both full clips.

ROLE
You are a motion fidelity examiner for a video relighting pipeline. The model was instructed to copy the performance exactly and change only the light. Because the final deliverable carries the ORIGINAL audio remuxed bit-for-bit, any deviation in mouth movement becomes a visible lip-sync error against real speech — this is a hard gate.

${FRAME_PREAMBLE}

WHAT TO INSPECT — frame-pair by frame-pair
For each index-locked pair, verify the performance is IDENTICAL:
1. Pose: head position and rotation, shoulder line, torso lean — matched at each timestamp.
2. Mouth shape: the degree of mouth opening, lip posture, and visible teeth/tongue must match the original at the same timestamp. Treat mouth shapes as viseme snapshots: an "ah" that became an "mm" at the same instant is a lip-sync violation.
3. Eyes and brows: blink state (open/closed/mid-blink), gaze direction, eyebrow position at each timestamp.
4. Gesture: hand positions and any mid-gesture trajectory implied across consecutive samples — no damping, exaggeration, or re-animation.
5. Timing: nothing may lead or lag — an expression arriving one sample early is a re-timing violation.
The event-picked frames (max optical flow, max mouth-open) are your hardest evidence — motion errors concentrate exactly there. Inspect them with the most care.

LIGHTING-EXPLAINABLE DIFFERENCES ARE NOT VIOLATIONS
Shadows sweeping across the face as the head turns under the new key light, changed specularity on lips or teeth, darker or brighter rendering of the mouth interior — all expected. The geometry and timing of the motion is what must match, not its illumination.

SCORING ANCHORS
- 95: Every pair pose-identical; mouth shape matches the original at every timestamp including max-mouth-open; blinks and gestures land at exactly the same instants.
- 75: Motion matches overall, but one or two pairs show mild mouth-shape mismatch (slightly wrong opening degree) or a subtly damped gesture that would read as soft lip-sync drift.
- 40: Visible re-animation: a gesture retimed or missing, mouth shapes that no longer track the original's speech pattern, blinks invented or deleted. Unshippable with the real audio.

Thresholds for this eval: pass ≥ 86, borderline ≥ 74, else fail.

${CORRECTION_RULES}
For motion, corrections are stop/restore directives about movement, never about appearance: "Do not modify the subject's mouth movements in any way; copy them frame-exact from the source video." / "Restore the exact timing and trajectory of the subject's hand gesture near {timestamp}; do not smooth or re-animate it."

${OUTPUT_SCHEMA}`,
    deterministicNote:
      "Future-real deterministic tier (runs first): mouth-landmark trajectory correlation between original and candidate across the clip — valid as a lip-sync metric precisely because the delivered audio IS the original stream, so the original mouth trajectory is ground truth. Supplemented by dense optical-flow field comparison for gross body motion. Low trajectory correlation short-circuits to fail before any judge spend; judges adjudicate the subtle remainder.",
  },

  // -------------------------------------------------------------------------
  // 10. temporal-stability — hybrid, soft
  // -------------------------------------------------------------------------
  {
    id: "temporal-stability",
    name: "No flicker",
    category: "temporal",
    description:
      "The relit video must hold steady from start to finish — no flickering, shimmering, wandering light, or colors slowly drifting.",
    method: "hybrid",
    hardGate: false,
    weight: 0.08,
    passThreshold: 80,
    borderlineThreshold: 68,
    promptTemplate: `Protocol: frame-grid today (matched stills at fixed + event-picked timestamps); flicker and drift live between frames, so full-motion certification is delegated to the deterministic tier described in deterministicNote. When video-native judging lands (Gemini video input), this rubric upgrades to receiving both full clips.

ROLE
You are a temporal stability examiner for a video relighting pipeline. Unlike the comparison evals, your primary subject is the CANDIDATE SEQUENCE ITSELF, viewed as a timeline: generative video models commonly produce frames that are individually plausible but unstable in sequence.

${FRAME_PREAMBLE}
For this eval, read {{AFTER_FRAMES}} primarily as a TIME SERIES (they are ordered by timestamp), and use {{BEFORE_FRAMES}} as the stability baseline — the original is temporally stable by construction, so any inter-frame variation present in the after set but absent in the before set at the same timestamps is model-introduced.

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

${CORRECTION_RULES}
For stability, corrections demand constancy: "Hold the lighting setup perfectly constant across the entire clip; brightness currently pulses around {timestamp}." / "Stop re-rendering the texture of the background region camera-right; keep it identical across frames."

${OUTPUT_SCHEMA}`,
    deterministicNote:
      "Future-real deterministic tier (runs first): a flicker metric — frame-to-frame luma/chroma variance measured on static regions (identified via the original's motion mask) — plus hue-histogram Earth Mover's Distance tracked ACROSS ITERATIONS to catch slow color drift that per-frame and per-iteration checks miss. Gross flicker short-circuits to fail before judge spend.",
  },

  // -------------------------------------------------------------------------
  // 11. hallucination-artifacts — dual-llm-judge, hard gate
  // -------------------------------------------------------------------------
  {
    id: "hallucination-artifacts",
    name: "Nothing invented",
    category: "hallucination",
    description:
      "Scans for anything the AI made up — warped hands, melted textures, ghost limbs, or objects and text that were never in the room.",
    method: "dual-llm-judge",
    hardGate: true,
    weight: 0.06,
    passThreshold: 90,
    borderlineThreshold: 80,
    promptTemplate: `Protocol: frame-grid — you receive matched stills (index-locked before/after frame pairs), not full videos.

ROLE
You are a generative-artifact inspector. Your specialty: defects that comparison-based evals structurally miss, because they only look where the original directs their attention. You look everywhere.

${FRAME_PREAMBLE}

PART 1 — COMPARISON-FREE SCAN (primary)
Inspect {{AFTER_FRAMES}} ALONE, one frame at a time, as if you had never seen the original. For EACH frame, sweep fully before moving to the next — generative artifacts are frequently single-frame events that vanish by the next sample:
1. Hands and fingers: wrong counts, warped or fused fingers, hands merging with objects or clothing.
2. Body coherence: ghost or duplicated limbs, impossible joint angles, a second partial face or figure anywhere in frame.
3. Texture integrity: melted, smeared, or "dream-like" patches on skin, fabric, or surfaces.
4. Geometry: edges that bend where they should be straight, objects fused into each other, physically impossible reflections or shadows (a shadow with no caster, a caster with no shadow).
5. Invented content: objects, text-like glyphs, logos, watermarks, or UI fragments that a webcam would not produce — and specifically any VISIBLE light fixture (lamp, softbox, ring light, new window): the relight must arrive as illumination only, never as rendered equipment.
6. Frame edges and the subject's silhouette boundary: the two zones where generators most often smear.

PART 2 — ADDED/REMOVED-OBJECT SWEEP (secondary)
Now compare against {{BEFORE_FRAMES}}: one deliberate pass over each pair asking a single question — is anything present in one set and absent in the other? This catches confident, clean-looking insertions and deletions that the comparison-free scan can rationalize as plausible.

SEVERITY GUIDANCE
Any anatomical artifact (hands, limbs, faces) is CRITICAL regardless of how brief. Added/removed objects and invented fixtures or text are CRITICAL to MAJOR. Localized single-frame texture smears are MAJOR to MINOR. This eval's thresholds are strict by design (pass ≥ 90): a single vivid artifact destroys viewer trust in the whole clip.

NOTE ON LIGHTING
New shadows, glows, gradients, and highlights ARE the product working. A shadow is only a violation when it is physically impossible (no caster) — not when it is merely new.

SCORING ANCHORS
- 95: Clean sweep — every frame free of anatomical, textural, geometric, and invented-content artifacts; the object sweep finds nothing added or removed.
- 75: One subtle, non-anatomical single-frame artifact (a brief texture smear in a background corner) that most viewers would miss. Sits below the pass bar by design.
- 40: Any warped hand, ghost limb, duplicated feature, invented object, visible added light fixture, or text-like hallucination — in even one frame.

Thresholds for this eval: pass ≥ 90, borderline ≥ 80, else fail.

${CORRECTION_RULES}
For hallucinations, corrections are remove/stop directives pinned to a region: "Remove the invented object in the lower-right corner of the frame; nothing is present there in the source video." / "Stop distorting the subject's right hand around {timestamp}; reproduce it exactly as in the source video." / "Remove the visible light fixture at the top edge of the frame; the relight must not render its own equipment."

${OUTPUT_SCHEMA}`,
  },
];

/** Look up an eval definition by id. Throws on unknown ids — a wrong id is a programming error, not a runtime condition. */
export function getEvalDef(id: string): EvalDefinition {
  const def = EVAL_DEFS.find((d) => d.id === id);
  if (!def) {
    throw new Error(
      `Unknown eval id "${id}". Known ids: ${EVAL_DEFS.map((d) => d.id).join(", ")}`
    );
  }
  return def;
}

/** Rubric rows that a human can truthfully grade for the selected workflow. */
export function humanGradeEvalDefsForMode(
  workflowMode: WorkflowMode
): EvalDefinition[] {
  return workflowMode === "lamp"
    ? EVAL_DEFS.filter(
        (definition) => definition.id !== "lighting-match-to-anchor"
      )
    : EVAL_DEFS;
}
