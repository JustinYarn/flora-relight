# Lamp relight-strength ladder (slider → prompt + criteria + calibration)

Written 2026-07-16 on `codex/lamp-slider-calibration`. This documents the
second slider design — the first one shipped earlier the same day and was
measured non-functional (evidence below).

## What the slider means now

One 0–100 value (5-point steps) selects a point on a six-band ladder of
designed looks. The value deterministically compiles THREE things:

1. **Generation prompt** — the `[LIGHTING SPECIFICATION]` block carries the
   band's full photographic recipe (style paragraph, key/fill/rim/background
   light/color/mood lines, measurable targets), and the `[NEVER DO]` block is
   band-scoped: the two strength-sensitive negatives (flat-lift ban, stylistic
   -look ban) relax or tighten with the band. Identity, performance, wardrobe,
   background-content, camera, and audio locks are absolute at every value.
2. **Evaluation criteria** — the holistic evaluator prompt opens with an
   INTENSITY CONTRACT (band, targets, allowances, restraints) that every check
   reads, and the `lighting-quality-delta` rubric judges *target matching*:
   too weak for the target is a failure exactly like too strong.
3. **Measured calibration** — before each evaluation the server measures
   region luma deltas (candidate vs source; whole frame, center ≈ subject,
   border ≈ background) with ffmpeg — deterministic, free. The numbers are
   (a) given to the judge as magnitude ground truth and (b) persisted on the
   evaluation artifact, where `compileLampFinalPrompt` compiles them into a
   critical MEASURED CALIBRATION correction, so the Final generation is a
   steered second pass, never a blind re-roll.

The bands:

| Range | Band | Face lift | Key:fill | Background | Character |
|-------|------|-----------|----------|------------|-----------|
| 0–19 | Daylight lift | ~+0.35 stops | ~1.2:1 | ~+0.1 | Near-invisible daylight brightening |
| 20–39 | Soft daylight | ~+0.6 | ~1.5:1 | ~+0.1 | Bright, airy window light |
| 40–59 | Pro video call | ~+0.9 | ~2:1 | ~0 | Polished creator/presenter look |
| 60–79 | Broadcast interview | ~+1.1 | ~2.5:1 | ~−0.3 | Produced interview (75 = historical Lamp) |
| 80–94 | Premium studio | ~+1.25 | ~3.2:1 | ~−0.9 | Sculpted key, defined rim, room ~1 stop down |
| 95–100 | Cinematic hero | ~+1.5 | ~4.2–5:1 | ~−1.5 to −1.8 | Filmic hero interview, moody falloff |

Numeric targets interpolate piecewise-linearly between band anchors, so the
value moves within a band too. Exact `75` still renders the historical Lamp
prompt byte-for-byte — the experiment's control condition — and therefore
carries no strength line; `parseRelightIntensityFromPrompt` returning `null`
means "default".

## Why the first slider failed (measured, live, 2026-07-16)

Two live Lamp runs of the same 9.9s webcam clip, intensity 25 vs 100
(`run_mrnyo0sm_3c9vl`, `run_mrnyhrw6_1euxw`), measured with the same region
luma used above (center region, stops vs source):

| | Initial | Final (shipped) |
|---|---|---|
| Intensity 25 | −0.09 | −0.02 |
| Intensity 100 | −0.12 | −0.02 |

Three compounding causes:

1. **Pinched dynamic range.** Only ~6 soft sentences varied inside a large
   prompt whose fixed negatives forbade the very things a high setting needs
   ("no stylistic look", "never theatrical", "plausibly achievable in the
   room") and demanded what a low setting must not do ("no flat lift — must
   read as a directional key"). Contradictions at both ends → the model
   converged on the same safe middle look at every value.
2. **Sampling variance dominates.** The i100 run's eval-1 passed with no
   usable corrections, so the Final re-ran an identical prompt and regressed
   from an 89-pass Initial (visibly darker/sculpted) to a 55-fail near-copy.
   Back-to-back takes of the same prompt differ by more than the whole
   slider's effect. The Interactions API exposes no seed/temperature, so the
   only steering channel is prompt bytes — hence the measured calibration
   correction, which gives pass 2 a concrete magnitude instruction even when
   the judge found nothing to fix.
3. **Criteria didn't fully scope to the target.** Only one of eight checks was
   intensity-aware; nothing told the other checks that (say) a deliberately
   darkened room at 100 is the product working. The INTENSITY CONTRACT now
   does, while explicitly keeping identity/skin/content checks at full
   strictness.

## Durability notes

- The evaluator version bumped to `lamp-holistic-v4` (prompt shape changed).
  v3/v2 artifacts still validate; v1 stays legacy-optional on usage.
- Measurements live on the persisted evaluation artifact, so Final-prompt
  recompiles (route, coordinator, batch, workflow replay) remain byte-stable
  across deploys. Runs without measurements (older artifacts, measurement
  failure) compile exactly as before — the feature fails open.
- Luma measurement runs before the paid-operation claim because its output is
  part of the judge prompt (canonical input). It touches only local files;
  provider upload still happens strictly after the claim.

## Cost

Unchanged shape: two generations + two evaluations per run. Measurement adds
zero provider cost (four local ffmpeg passes, ~2–4s). Judge prompts grew by
roughly 1–2k tokens (≈ $0.004 per evaluation at Gemini 3.1 Pro input rates).

## Live verification (2026-07-16, same 9.9s source as the failed A/B)

Runs `run_mro4wy4o_1cbrf` (25) and `run_mro55qdr_1zwwo` (100); actual settled
spend $2.34 + $2.37 = $4.71 (estimate was $3.14/run ceiling). Region luma in
stops vs source (global / border≈background):

| Slider | Old-system Final | New Initial | New Final (shipped) |
|--------|-----------------|-------------|---------------------|
| 25 | −0.02 / −0.01 | −0.03 / −0.02 | −0.02 / −0.02 |
| 100 | −0.02 / −0.01 | **−0.80 / −0.91** | **−0.59 / −0.68** |

- Old system: 25 and 100 shipped byte-similar near-copies (Δ ≈ 0.00 stops).
  New system: Δ ≈ 0.57 global / 0.66 background between the same two slider
  values — the shipped output now tracks the slider, and the 100 Final is
  visibly cinematic (darkened room, warm subject, rim separation).
- The criteria half works: at 100, eval 1 failed the aggressive Initial on
  identity/background/hallucination AND flagged `too_weak_for_target` with a
  measurement-grounded correction ("+2 stops face, −1 stop background"); the
  Final repaired fidelity (92/89/94 pass) while keeping most of the look.
  At 25, both near-copy takes were honestly failed `too_weak_for_target`
  (55) — under the old rubric a near-copy could pass eval 1 silently.

Known gaps, in priority order:

1. **The model undershoots magnitude at both ends.** At 25 it ships a
   near-copy (measured +0.0 vs +0.7 target); at 100 it reaches roughly a
   third of the band-6 targets. Prompt-only magnitude control of
   `gemini-omni-flash-preview` is loose, and there is no seed/temperature
   control on the Interactions API. Next levers: calibrate band targets to
   measured model capability (honest targets beat aspirational ones), and/or
   a best-of-two settle policy (ship whichever take scored closer to target —
   the durable machinery already journals both takes and both evaluations).
2. **Center-region proxy is not a face meter.** The center crop includes
   wardrobe and background between the shoulders, so a sculpted look that
   darkens the room reads as a negative center delta even when the face is
   correctly lifted. Good enough to steer magnitude direction; a face-box
   measurement (existing frame-extraction tier) would sharpen it.
3. **Final-vs-Initial variance remains.** The 100 Final drifted 0.2 stops
   brighter than its Initial despite a hold/increase instruction. Same
   best-of-two lever applies.
