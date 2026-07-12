/**
 * The scripted mock trajectories. Everything the mock providers "observe" is
 * scripted here. The classic demo story (DEFAULT_SCENARIO):
 *
 *   Iteration 1 — timid relight: preservation is mostly easy when you barely
 *     change anything, but TWO hard gates go red — the anti-degenerate gate
 *     (lighting-quality-delta) correctly fails the near-copy, and the skin
 *     gate (skin-texture-age) catches subtle cheek smoothing at 76 (< 88).
 *   Iteration 2 — the model overshoots chasing drama and hallucinates a
 *     window on the left wall: the hallucination hard gate fails, and an
 *     18-point judge disagreement on background fidelity drives the
 *     confidence meter low — the demo of measured (not self-reported)
 *     confidence flagging human review.
 *   Iteration 3 — corrections land: better key/fill separation, rim light,
 *     no invented geometry. All gates pass, audio is remuxed, run parks at
 *     awaiting-review.
 *
 * For batch runs, SCENARIO_VARIANTS adds four more stories (clean pass,
 * skin battle, plateau→fallback, hallucination battle) so a board of many
 * clips shows the full outcome spectrum. scenarioForVideo(videoId) picks one
 * deterministically per clip — same clip, same story, every time.
 */

import type {
  MockScenario,
  SceneManifest,
  ScenarioEvalOutcome,
  ScenarioIteration,
  VideoAsset,
} from "@/lib/types";

export const SAMPLE_VIDEO: VideoAsset = {
  id: "video_sample_dim",
  kind: "original",
  url: "/samples/sample-dim.mp4",
  label: "Sample: dim webcam clip",
  durationSec: 10,
  width: 640,
  height: 360,
  hasAudio: true,
};

/**
 * Ground truth for evals — extracted once at ingest, never pasted verbatim
 * into generation prompts (pink-elephant discipline).
 */
export const MOCK_MANIFEST: SceneManifest = {
  person: {
    faceDescriptor:
      "Adult, oval face, medium-warm complexion, dark eyes; no glasses, no facial hair",
    skinTone: "medium-warm, reading desaturated under the current dim source",
    hair: "shoulder-length dark-brown hair, loose, parted slightly off-center",
    clothing: ["navy crew-neck tee"],
    accessories: ["thin silver necklace"],
  },
  background: {
    objects: ["door frame at camera-right edge", "bookshelf edge at camera-left edge"],
    surfaces: "dim beige painted wall, matte finish, no texture features",
    layoutNotes:
      "Plain wall fills most of the frame; the door frame enters from the right edge and a sliver of bookshelf is visible at the left edge. No windows, fixtures, or wall art.",
  },
  camera: {
    framing: "head-and-shoulders, subject slightly left of center",
    angle: "eye-level laptop webcam",
    notes: "Fixed position, mild wide-angle distortion typical of a built-in webcam",
  },
  lightingDiagnosis:
    "Single dim overhead source: face underexposed, flat contrast, mild warm color cast. No key/fill separation and no rim light — the subject merges into the wall.",
};

// ---------------------------------------------------------------------------
// Trajectory
// ---------------------------------------------------------------------------

function outcome(
  evalId: string,
  score: number,
  judgeSpread: number,
  violations: ScenarioEvalOutcome["violations"] = []
): ScenarioEvalOutcome {
  return { evalId, score, judgeSpread, violations };
}

const ITERATION_1: ScenarioIteration = {
  simulatedFilter: "brightness(1.12) contrast(1.05)",
  keyframeFilter: "brightness(1.35) contrast(1.15) saturate(1.08)",
  videoGenLatencyMs: 4000,
  outcomes: [
    outcome("identity-preservation", 93, 6),
    outcome("skin-texture-age", 76, 10, [
      {
        aspect: "cheek texture smoothing",
        severity: "major",
        description:
          "subtle skin smoothing on both cheeks — pore detail reduced relative to source at matched timestamps",
        frameTimestampSec: 5,
        correction:
          "Restore pore-level skin texture on both cheeks at original strength; do not smooth, soften, or de-age any facial region",
      },
    ]),
    outcome("appearance-fidelity", 90, 8),
    outcome("background-fidelity", 87, 9),
    outcome("lighting-quality-delta", 58, 6, [
      {
        aspect: "key-fill separation",
        severity: "major",
        description:
          "key-fill separation absent — face still lit by single flat frontal source",
        correction:
          "Increase key-to-fill contrast: soften but strengthen the camera-left key, drop fill by one stop",
      },
      {
        aspect: "rim light",
        severity: "major",
        description: "no rim/hair light — subject merges with background",
        correction:
          "Add a subtle warm rim light from behind-left to separate subject from the wall",
      },
    ]),
    outcome("lighting-match-to-anchor", 70, 12, [
      {
        aspect: "anchor match",
        severity: "minor",
        description: "generated look is dimmer and flatter than the approved anchor",
        correction:
          "Match the approved anchor frame's key intensity and direction exactly",
      },
    ]),
    outcome("motion-lipsync", 91, 7),
    outcome("temporal-stability", 82, 14, [
      {
        aspect: "wall-shadow flicker",
        severity: "minor",
        description: "wall-shadow flicker between ~3–6s",
        frameTimestampSec: 4.5,
        correction:
          "Keep background illumination constant across frames; no pulsing on the wall",
      },
    ]),
    outcome("hallucination-artifacts", 96, 4),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

const ITERATION_2: ScenarioIteration = {
  simulatedFilter: "brightness(1.22) contrast(1.10) saturate(1.06)",
  keyframeFilter: "brightness(1.35) contrast(1.15) saturate(1.08)",
  videoGenLatencyMs: 3500,
  outcomes: [
    outcome("identity-preservation", 91, 8),
    outcome("skin-texture-age", 90, 7),
    outcome("appearance-fidelity", 88, 9),
    outcome("background-fidelity", 74, 18, [
      {
        aspect: "left wall geometry",
        severity: "major",
        description:
          "bright window-shaped rectangle appeared on the camera-left wall — not present in source",
        frameTimestampSec: 5,
        correction:
          "Remove the added window-like shape; restore the plain wall exactly as in the source video",
      },
    ]),
    outcome("lighting-quality-delta", 83, 7),
    outcome("lighting-match-to-anchor", 84, 8),
    outcome("motion-lipsync", 90, 6),
    outcome("temporal-stability", 88, 9),
    outcome("hallucination-artifacts", 72, 16, [
      {
        aspect: "hallucinated window",
        severity: "critical",
        description: "new object hallucinated: window with light bloom on left wall",
        frameTimestampSec: 5,
        correction:
          "Do not introduce any new objects, openings, or light fixtures; the wall must remain unbroken",
      },
    ]),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 97, 0),
  ],
};

const ITERATION_3: ScenarioIteration = {
  simulatedFilter: "brightness(1.26) contrast(1.12) saturate(1.05)",
  keyframeFilter: "brightness(1.35) contrast(1.15) saturate(1.08)",
  videoGenLatencyMs: 3000,
  outcomes: [
    outcome("identity-preservation", 92, 5),
    outcome("skin-texture-age", 93, 4),
    outcome("appearance-fidelity", 91, 6),
    outcome("background-fidelity", 90, 7),
    outcome("lighting-quality-delta", 88, 6),
    outcome("lighting-match-to-anchor", 87, 7),
    outcome("motion-lipsync", 92, 5),
    outcome("temporal-stability", 89, 8),
    outcome("hallucination-artifacts", 95, 3),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

export const DEFAULT_SCENARIO: MockScenario = {
  name: "Dim webcam → studio relight (3-iteration convergence)",
  description:
    "Iteration 1 under-relights and trips two hard gates — the anti-degenerate lighting gate and the skin-texture gate (subtle cheek smoothing); iteration 2 overshoots and hallucinates a window (hallucination gate fails, judge disagreement drives background confidence low); iteration 3 lands the corrections and passes every gate.",
  iterations: [ITERATION_1, ITERATION_2, ITERATION_3],
};

// ---------------------------------------------------------------------------
// Variant: clean-pass — one timid iteration, then a textbook relight.
// Iter 1 fails ONLY the anti-degenerate lighting gate (72, borderline);
// iter 2 passes everything. Composites ≈ 87, 92.
// ---------------------------------------------------------------------------

const CLEAN_PASS_1: ScenarioIteration = {
  simulatedFilter: "brightness(1.18) contrast(1.07) saturate(1.02)",
  keyframeFilter: "brightness(1.33) contrast(1.14) saturate(1.07)",
  videoGenLatencyMs: 3600,
  outcomes: [
    outcome("identity-preservation", 93, 5),
    outcome("skin-texture-age", 91, 6),
    outcome("appearance-fidelity", 92, 7),
    outcome("background-fidelity", 86, 8),
    outcome("lighting-quality-delta", 72, 9, [
      {
        aspect: "key strength",
        severity: "major",
        description:
          "the relight is real but timid — facial midtones read roughly half a stop under the 1.0–1.25-stop target and modelling stays soft",
        frameTimestampSec: 2.5,
        correction:
          "Raise the key light intensity from camera-left by about half a stop; keep the current direction and softness",
      },
    ]),
    outcome("lighting-match-to-anchor", 81, 10),
    outcome("motion-lipsync", 93, 6),
    outcome("temporal-stability", 83, 9),
    outcome("hallucination-artifacts", 95, 4),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

const CLEAN_PASS_2: ScenarioIteration = {
  simulatedFilter: "brightness(1.27) contrast(1.13) saturate(1.05)",
  keyframeFilter: "brightness(1.33) contrast(1.14) saturate(1.07)",
  videoGenLatencyMs: 3100,
  outcomes: [
    outcome("identity-preservation", 95, 4),
    outcome("skin-texture-age", 93, 5),
    outcome("appearance-fidelity", 94, 6),
    outcome("background-fidelity", 92, 7),
    outcome("lighting-quality-delta", 86, 8),
    outcome("lighting-match-to-anchor", 88, 6),
    outcome("motion-lipsync", 94, 5),
    outcome("temporal-stability", 90, 7),
    outcome("hallucination-artifacts", 96, 4),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

const CLEAN_PASS_SCENARIO: MockScenario = {
  name: "Slightly timid start → textbook pass (2 iterations)",
  description:
    "Iteration 1 relights for real but lands half a stop shy of the drama target — only the anti-degenerate lighting gate goes red; one correction later, iteration 2 passes every gate with a composite in the low 90s.",
  iterations: [CLEAN_PASS_1, CLEAN_PASS_2],
};

// ---------------------------------------------------------------------------
// Variant: skin-battle — beautification is the adversary.
// skin-texture-age: 62 fail → 79 borderline (still under the 88 gate) →
// 91 pass. Lighting clears its gate from iteration 2 onward.
// ---------------------------------------------------------------------------

const SKIN_BATTLE_1: ScenarioIteration = {
  simulatedFilter: "brightness(1.22) contrast(1.06) saturate(1.08) blur(0.4px)",
  keyframeFilter: "brightness(1.34) contrast(1.13) saturate(1.06)",
  videoGenLatencyMs: 4200,
  outcomes: [
    outcome("identity-preservation", 90, 7),
    outcome("skin-texture-age", 62, 12, [
      {
        aspect: "cheek pore loss",
        severity: "critical",
        description:
          "pore fields on both cheeks are erased — the skin reads as an even, foundation-like finish at every sampled timestamp",
        frameTimestampSec: 2.5,
        correction:
          "Restore pore-level texture on both cheeks at original strength; remove all smoothing and cleanup",
      },
      {
        aspect: "waxy highlight",
        severity: "major",
        description:
          "forehead and nose highlights render plastic and waxy — specular patches clip flat instead of rolling off",
        frameTimestampSec: 5,
        correction:
          "Render the highlights on the forehead and nose with a gradual matte-to-satin roll-off; remove the waxy specular rendering",
      },
      {
        aspect: "under-eye cleanup",
        severity: "major",
        description:
          "under-eye fine lines present in the source do not survive — the region is smoothed into a younger read",
        correction:
          "Restore the natural under-eye fine lines exactly as in the source video; do not de-age any facial region",
      },
    ]),
    outcome("appearance-fidelity", 89, 8),
    outcome("background-fidelity", 88, 7),
    outcome("lighting-quality-delta", 70, 9, [
      {
        aspect: "key-fill separation",
        severity: "major",
        description:
          "face is brighter but still lit near-flat — key-to-fill contrast sits well under the 2:1 target",
        correction:
          "Increase key-to-fill contrast: strengthen the camera-left key and drop the fill by one stop",
      },
    ]),
    outcome("lighting-match-to-anchor", 75, 11, [
      {
        aspect: "anchor match",
        severity: "minor",
        description: "generated look is softer and flatter than the approved anchor",
        correction:
          "Match the approved anchor frame's key intensity and direction exactly",
      },
    ]),
    outcome("motion-lipsync", 90, 6),
    outcome("temporal-stability", 78, 16, [
      {
        aspect: "cheek texture crawl",
        severity: "minor",
        description:
          "what little skin texture remains re-renders between consecutive samples on the cheek region",
        frameTimestampSec: 6,
        correction:
          "Keep skin texture identical across frames; stop re-rendering it sample to sample",
      },
    ]),
    outcome("hallucination-artifacts", 93, 5),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 97, 0),
  ],
};

const SKIN_BATTLE_2: ScenarioIteration = {
  simulatedFilter: "brightness(1.24) contrast(1.10) saturate(1.06) blur(0.2px)",
  keyframeFilter: "brightness(1.34) contrast(1.13) saturate(1.06)",
  videoGenLatencyMs: 3700,
  outcomes: [
    outcome("identity-preservation", 92, 6),
    outcome("skin-texture-age", 79, 10, [
      {
        aspect: "cheek pore loss",
        severity: "major",
        description:
          "pore texture partially returned, but both cheeks still read slightly filtered at normal viewing size — under the 88 gate",
        frameTimestampSec: 5,
        correction:
          "Restore pore-level texture on both cheeks at original strength; do not soften any facial region",
      },
    ]),
    outcome("appearance-fidelity", 90, 7),
    outcome("background-fidelity", 89, 6),
    outcome("lighting-quality-delta", 83, 7),
    outcome("lighting-match-to-anchor", 82, 8),
    outcome("motion-lipsync", 91, 5),
    outcome("temporal-stability", 87, 8),
    outcome("hallucination-artifacts", 94, 4),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

const SKIN_BATTLE_3: ScenarioIteration = {
  simulatedFilter: "brightness(1.26) contrast(1.12) saturate(1.05)",
  keyframeFilter: "brightness(1.34) contrast(1.13) saturate(1.06)",
  videoGenLatencyMs: 3200,
  outcomes: [
    outcome("identity-preservation", 93, 5),
    outcome("skin-texture-age", 91, 5),
    outcome("appearance-fidelity", 92, 6),
    outcome("background-fidelity", 90, 6),
    outcome("lighting-quality-delta", 85, 6),
    outcome("lighting-match-to-anchor", 85, 7),
    outcome("motion-lipsync", 92, 5),
    outcome("temporal-stability", 88, 7),
    outcome("hallucination-artifacts", 95, 3),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

const SKIN_BATTLE_SCENARIO: MockScenario = {
  name: "Beautification battle (3 iterations)",
  description:
    "The model keeps 'improving' the person: iteration 1 ships waxy cheeks and erased pores (skin gate 62, hard fail), iteration 2 claws back to 79 — still under the 88 gate — and iteration 3 finally ships source-strength skin at 91. Lighting clears its gate from iteration 2.",
  iterations: [SKIN_BATTLE_1, SKIN_BATTLE_2, SKIN_BATTLE_3],
};

// ---------------------------------------------------------------------------
// Variant: plateau-fallback — the loop that never gets there.
// lighting-quality-delta goes 58 → 74 → 76 → 77, never clearing the 80 gate,
// while composite improvements shrink below plateauMinDelta — the engine
// exhausts and applies the color-transfer fallback (best-of iteration 4).
// ---------------------------------------------------------------------------

const PLATEAU_1: ScenarioIteration = {
  simulatedFilter: "brightness(1.08) contrast(1.03)",
  keyframeFilter: "brightness(1.30) contrast(1.12) saturate(1.06)",
  videoGenLatencyMs: 4100,
  outcomes: [
    outcome("identity-preservation", 91, 6),
    outcome("skin-texture-age", 82, 11, [
      {
        aspect: "cheek softening",
        severity: "minor",
        description:
          "mild softening on the shadow-side cheek — texture survives but reads slightly filtered",
        correction:
          "Restore pore-level texture on the shadow-side cheek at original strength; do not smooth any facial region",
      },
    ]),
    outcome("appearance-fidelity", 88, 8),
    outcome("background-fidelity", 86, 9),
    outcome("lighting-quality-delta", 58, 7, [
      {
        aspect: "key-fill separation",
        severity: "major",
        description:
          "key-fill separation absent — the face is lifted globally with no new directional structure",
        correction:
          "Increase key-to-fill contrast: build a soft camera-left key and drop the fill by one stop",
      },
      {
        aspect: "rim light",
        severity: "major",
        description: "no rim/hair light — subject merges with the wall behind",
        correction:
          "Add a subtle warm rim light from behind-left to separate subject from the wall",
      },
    ]),
    outcome("lighting-match-to-anchor", 68, 12, [
      {
        aspect: "anchor match",
        severity: "major",
        description: "generated look is dimmer and far flatter than the approved anchor",
        correction:
          "Match the approved anchor frame's key intensity and direction exactly",
      },
    ]),
    outcome("motion-lipsync", 89, 7),
    outcome("temporal-stability", 80, 11),
    outcome("hallucination-artifacts", 94, 5),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 97, 0),
  ],
};

const PLATEAU_2: ScenarioIteration = {
  simulatedFilter: "brightness(1.14) contrast(1.05)",
  keyframeFilter: "brightness(1.30) contrast(1.12) saturate(1.06)",
  videoGenLatencyMs: 3800,
  outcomes: [
    outcome("identity-preservation", 92, 5),
    outcome("skin-texture-age", 90, 6),
    outcome("appearance-fidelity", 90, 7),
    outcome("background-fidelity", 88, 7),
    outcome("lighting-quality-delta", 74, 8, [
      {
        aspect: "key-fill separation",
        severity: "major",
        description:
          "key is stronger but the fill remains high — modelling reads shallow, well short of the 2:1 target",
        correction:
          "Drop the fill by a further stop to deepen key-to-fill contrast; keep detail in the shadow side",
      },
    ]),
    outcome("lighting-match-to-anchor", 78, 9),
    outcome("motion-lipsync", 91, 6),
    outcome("temporal-stability", 84, 9),
    outcome("hallucination-artifacts", 95, 4),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

const PLATEAU_3: ScenarioIteration = {
  simulatedFilter: "brightness(1.16) contrast(1.06)",
  keyframeFilter: "brightness(1.30) contrast(1.12) saturate(1.06)",
  videoGenLatencyMs: 3600,
  outcomes: [
    outcome("identity-preservation", 92, 5),
    outcome("skin-texture-age", 91, 5),
    outcome("appearance-fidelity", 91, 6),
    outcome("background-fidelity", 89, 6),
    outcome("lighting-quality-delta", 76, 17, [
      {
        aspect: "key-fill separation",
        severity: "major",
        description:
          "contrast gain has stalled — face modelling is nearly unchanged from the previous attempt",
        correction:
          "Increase the strength and softness of the camera-left key decisively; the face still reads flat",
      },
    ]),
    outcome("lighting-match-to-anchor", 80, 8),
    outcome("motion-lipsync", 91, 5),
    outcome("temporal-stability", 85, 8),
    outcome("hallucination-artifacts", 95, 4),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

const PLATEAU_4: ScenarioIteration = {
  simulatedFilter: "brightness(1.17) contrast(1.06) saturate(1.02)",
  keyframeFilter: "brightness(1.30) contrast(1.12) saturate(1.06)",
  videoGenLatencyMs: 3500,
  outcomes: [
    outcome("identity-preservation", 93, 5),
    outcome("skin-texture-age", 91, 5),
    outcome("appearance-fidelity", 91, 6),
    outcome("background-fidelity", 89, 6),
    outcome("lighting-quality-delta", 77, 8, [
      {
        aspect: "key-fill separation",
        severity: "major",
        description:
          "another marginal change — the model keeps converging to the same shallow-key look regardless of corrections",
        correction:
          "Increase key-to-fill contrast decisively; the current look repeats the previous iteration",
      },
    ]),
    outcome("lighting-match-to-anchor", 81, 8),
    outcome("motion-lipsync", 92, 5),
    outcome("temporal-stability", 85, 8),
    outcome("hallucination-artifacts", 96, 3),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

const PLATEAU_FALLBACK_SCENARIO: MockScenario = {
  name: "Lighting plateau → color-transfer fallback (4 iterations)",
  description:
    "Preservation is excellent from iteration 2, but the drama never arrives: lighting-quality-delta crawls 58 → 74 → 76 → 77 and never clears the 80 gate while composite improvements shrink below the plateau threshold. The loop stops spending, applies the color-transfer fallback onto original pixels, and routes to review — labeled.",
  iterations: [PLATEAU_1, PLATEAU_2, PLATEAU_3, PLATEAU_4],
};

// ---------------------------------------------------------------------------
// Variant: hallucination-battle — whack-a-mole with invented geometry.
// hallucination-artifacts: 55 (added plant) → 68 (plant gone, new shelf
// artifact) → 84 (faint remnant, still under the 90 gate) → 94 pass.
// ---------------------------------------------------------------------------

const HALLUC_1: ScenarioIteration = {
  simulatedFilter: "brightness(1.30) contrast(1.16) saturate(1.12)",
  keyframeFilter: "brightness(1.35) contrast(1.15) saturate(1.09)",
  videoGenLatencyMs: 4300,
  outcomes: [
    outcome("identity-preservation", 92, 6),
    outcome("skin-texture-age", 89, 7),
    outcome("appearance-fidelity", 90, 7),
    outcome("background-fidelity", 78, 16, [
      {
        aspect: "desk region repaint",
        severity: "major",
        description:
          "the desk surface camera-right is partially repainted around an object that does not exist in the source",
        frameTimestampSec: 4,
        correction:
          "Restore the desk surface camera-right exactly as in the source video",
      },
    ]),
    outcome("lighting-quality-delta", 76, 9, [
      {
        aspect: "separation hold",
        severity: "minor",
        description:
          "rim light is present but weak — subject-background separation fades in the mid-clip frames",
        correction:
          "Strengthen the rim light on hair and shoulders and hold it across the full clip",
      },
    ]),
    outcome("lighting-match-to-anchor", 79, 10),
    outcome("motion-lipsync", 90, 6),
    outcome("temporal-stability", 83, 9),
    outcome("hallucination-artifacts", 55, 13, [
      {
        aspect: "hallucinated plant",
        severity: "critical",
        description:
          "a potted plant appeared on the desk at camera-right — no such object exists in the source",
        frameTimestampSec: 4,
        correction:
          "Remove the invented object on the desk camera-right; nothing is present there in the source video",
      },
    ]),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 97, 0),
  ],
};

const HALLUC_2: ScenarioIteration = {
  simulatedFilter: "brightness(1.28) contrast(1.14) saturate(1.08)",
  keyframeFilter: "brightness(1.35) contrast(1.15) saturate(1.09)",
  videoGenLatencyMs: 3900,
  outcomes: [
    outcome("identity-preservation", 92, 5),
    outcome("skin-texture-age", 90, 6),
    outcome("appearance-fidelity", 91, 6),
    outcome("background-fidelity", 84, 9, [
      {
        aspect: "left wall texture",
        severity: "minor",
        description:
          "wall texture camera-left is subtly rewritten in the region around the added structure",
        correction:
          "Stop altering the wall surface camera-left; reproduce it exactly as in the source video",
      },
    ]),
    outcome("lighting-quality-delta", 83, 7),
    outcome("lighting-match-to-anchor", 83, 8),
    outcome("motion-lipsync", 91, 5),
    outcome("temporal-stability", 86, 8),
    outcome("hallucination-artifacts", 68, 11, [
      {
        aspect: "shelf artifact",
        severity: "critical",
        description:
          "the invented plant is gone, but a small shelf-like ledge now protrudes from the wall camera-left",
        frameTimestampSec: 6,
        correction:
          "Remove the added shelf-like structure on the camera-left wall; the wall must remain unbroken",
      },
    ]),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

const HALLUC_3: ScenarioIteration = {
  simulatedFilter: "brightness(1.27) contrast(1.13) saturate(1.06)",
  keyframeFilter: "brightness(1.35) contrast(1.15) saturate(1.09)",
  videoGenLatencyMs: 3400,
  outcomes: [
    outcome("identity-preservation", 93, 5),
    outcome("skin-texture-age", 91, 5),
    outcome("appearance-fidelity", 92, 5),
    outcome("background-fidelity", 88, 7),
    outcome("lighting-quality-delta", 84, 6),
    outcome("lighting-match-to-anchor", 85, 7),
    outcome("motion-lipsync", 92, 5),
    outcome("temporal-stability", 88, 7),
    outcome("hallucination-artifacts", 84, 10, [
      {
        aspect: "shelf artifact",
        severity: "major",
        description:
          "a faint ridge remains where the shelf artifact was — visible as a shadow line on the camera-left wall",
        frameTimestampSec: 6,
        correction:
          "Restore the camera-left wall to a perfectly flat surface as in the source video; remove the residual ridge and its shadow line",
      },
    ]),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

const HALLUC_4: ScenarioIteration = {
  simulatedFilter: "brightness(1.26) contrast(1.12) saturate(1.05)",
  keyframeFilter: "brightness(1.35) contrast(1.15) saturate(1.09)",
  videoGenLatencyMs: 3000,
  outcomes: [
    outcome("identity-preservation", 93, 4),
    outcome("skin-texture-age", 92, 5),
    outcome("appearance-fidelity", 92, 5),
    outcome("background-fidelity", 90, 6),
    outcome("lighting-quality-delta", 86, 6),
    outcome("lighting-match-to-anchor", 86, 6),
    outcome("motion-lipsync", 93, 4),
    outcome("temporal-stability", 89, 6),
    outcome("hallucination-artifacts", 94, 4),
    outcome("audio-integrity", 100, 0),
    outcome("temporal-alignment", 98, 0),
  ],
};

const HALLUCINATION_BATTLE_SCENARIO: MockScenario = {
  name: "Hallucination whack-a-mole (4 iterations)",
  description:
    "The model relights beautifully and invents furniture while doing it: an added desk plant (55, hard fail), then a shelf-like wall artifact (68), then a residual ridge (84 — still under the strict 90 gate), and finally a clean sweep at 94 on the last budgeted iteration.",
  iterations: [HALLUC_1, HALLUC_2, HALLUC_3, HALLUC_4],
};

// ---------------------------------------------------------------------------
// Variant registry + per-video selection
// ---------------------------------------------------------------------------

/**
 * All scripted stories, classic first (index 0). Order matters: the index is
 * part of the encoded-iteration scheme below, and index 0 keeps plain
 * (unencoded) iteration numbers mapping to the classic demo trajectory.
 */
export const SCENARIO_VARIANTS: MockScenario[] = [
  DEFAULT_SCENARIO,
  CLEAN_PASS_SCENARIO,
  SKIN_BATTLE_SCENARIO,
  PLATEAU_FALLBACK_SCENARIO,
  HALLUCINATION_BATTLE_SCENARIO,
];

/**
 * Salted djb2-xor hash. The salt is tuned so the five bundled sample clips
 * (lib/mock/samples.ts) spread across all five variants — a full-library
 * batch demonstrates the complete outcome spectrum. Deterministic: the same
 * clip id always replays the same story.
 */
const SCENARIO_SALT = "gaffer";

function scenarioIndexForVideo(videoId: string): number {
  // The legacy demo clip keeps its classic 3-iteration trajectory.
  if (videoId === SAMPLE_VIDEO.id) return 0;
  const key = SCENARIO_SALT + videoId;
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(h, 33) ^ key.charCodeAt(i)) >>> 0;
  }
  return h % SCENARIO_VARIANTS.length;
}

/** Deterministic scripted story for a clip — same id, same story, always. */
export function scenarioForVideo(videoId: string): MockScenario {
  return SCENARIO_VARIANTS[scenarioIndexForVideo(videoId)];
}

// ---------------------------------------------------------------------------
// Lookup helpers (used by the mock providers and the engine)
// ---------------------------------------------------------------------------

/**
 * Encoded iterations: the mock providers (lib/providers/*) look scenario data
 * up by iteration number alone, but batch runs execute CONCURRENTLY with
 * different per-video scenarios — shared mutable "current scenario" state
 * would race. Instead the variant index rides inside the iteration number the
 * engine passes to providers: encoded = variantIndex * 100 + iteration.
 * Plain values (< 100) keep decoding to the classic DEFAULT_SCENARIO, so
 * every pre-batch caller behaves exactly as before.
 */
const SCENARIO_ITERATION_STRIDE = 100;

/** Pack a run's scenario variant into the iteration number sent to providers. */
export function encodeScenarioIteration(videoId: string, iteration: number): number {
  return scenarioIndexForVideo(videoId) * SCENARIO_ITERATION_STRIDE + iteration;
}

/**
 * Scenario iteration for a (possibly encoded) 1-based index, clamped to the
 * variant's scripted range.
 */
export function getScenarioIteration(iteration: number): ScenarioIteration {
  const variantIndex = Math.floor(iteration / SCENARIO_ITERATION_STRIDE);
  const scenario = SCENARIO_VARIANTS[variantIndex] ?? DEFAULT_SCENARIO;
  const iter = iteration % SCENARIO_ITERATION_STRIDE;
  const idx = Math.min(Math.max(iter, 1), scenario.iterations.length) - 1;
  return scenario.iterations[idx];
}

/** Scripted outcome for one eval in one (possibly encoded) iteration, if any. */
export function getScenarioOutcome(
  iteration: number,
  evalId: string
): ScenarioEvalOutcome | undefined {
  return getScenarioIteration(iteration).outcomes.find((o) => o.evalId === evalId);
}
