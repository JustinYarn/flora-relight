# Lamp Slider Lab

This experiment lives on `codex/lamp-slider-calibration`, branched from
`9071296` (`main` and `codex/flora-prompt-map-ux` at the time of branching).

## What stays unchanged

- Lamp still runs the same Initial → critique → Final workflow.
- The AI still returns its existing continuous 0–100 scores.
- The canonical five-button human Grade and `Run.humanGrade` stay unchanged.
- No new workflow mode, provider call, generation step, or spend path is added.

## What the lab adds

Open **Grade → Slider lab** to rate the same nine Lamp rows numerically.

- The eight visual checks use integer sliders from 0 through 100.
- `audio-integrity` stays binary at 0 or 100.
- AI scores remain hidden until every row for that clip has a human value.
- Reveal reads the already-saved Final evaluation; it does not rerun the AI.
- The comparison shows the exact lighting gap, mean absolute gap, and largest
  raw human-versus-AI gap even when both sides land in the same verdict band.

The lighting row uses these visible anchors:

| Value | Meaning |
| ---: | --- |
| 0 | worse |
| 40 | unchanged / no meaningful relight |
| 65 | meaningful but incomplete |
| 80 | clearly and professionally better |
| 100 | exceptional transformation |

## Data isolation

Slider answers autosave to the revisioned draft id
`lamp-slider-calibration-v1`. They never call the canonical `/api/runs` grade
write and never replace `Run.humanGrade`, change run status, or alter the normal
Grade queue.

The draft retains a hidden five-point compatibility bucket so it can reuse the
existing durable draft store:

| Exact slider score | Compatibility point |
| ---: | ---: |
| 0–39 | 1 |
| 40–64 | 2 |
| 65–79 | 3 |
| 80–94 | 4 |
| 95–100 | 5 |

All Slider Lab displays and comparisons use the exact 0–100 value, not the
compatibility point.
