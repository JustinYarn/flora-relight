# HANDOFF — Flora Relight session handoff

Written 2026-07-13 for whoever (human or AI session) picks this project up next.
Read `README.md` for product-level docs and `ARCHITECTURE.md` for the design
rationale; this file is the "where were we" note.

## Current state (2026-07-13)

- **The app is live-wired and working.** Real Omni Flash video-to-video
  (`gemini-omni-flash-preview` via the Interactions API), real Gemini
  video-native judge + Claude frame-grid judge (structured outputs verified on
  both), server routes under `app/api/live/*`. First real relit clips confirmed
  audio-bit-identical. Without keys the app falls back to mock mode.
- **Local persistence**: every run writes to `data/runs/<runId>/` (`run.json`
  plus `source.mp4`, `source-audio.m4a`, `relit-vN.mp4`, `anchor-vN.jpg`, …).
  `data/` is gitignored — it is the artifact of record on this machine.
- **GitHub**: public repo at `github.com/JustinYarn/flora-relight`.
  Branches: `main` (current) and `vercel-prep` — **vercel-prep is merged into
  main as of 2026-07-13**; the worktree at `../flora-relight-vercel` is now
  redundant.
- **Vercel deployment**: production at **https://flora-relight.vercel.app**
  (project `flora-relight`, org `justin-5763s-projects`). Container-image
  function (the root `Dockerfile` ships ffmpeg). Shared password gate via
  `FLORA_ACCESS_PASSWORD` (middleware + `/gate`). Note: on the Hobby plan the
  300s function cap can kill >5-minute generations — the Pro plan
  (`maxDuration: 800` in `vercel.json`) is the intended target.
- **Storage driver architecture** (`lib/server/storage/`): env-selected seam.
  With `BLOB_READ_WRITE_TOKEN` + `DATABASE_URL` present → media to **Vercel
  Blob** (store `flora-relight-media`, public, iad1) and run/batch JSON to
  **Neon Postgres** (`neon-alizarin-window`). Without them → local `data/`.
  Cloud ingest is a two-step client-direct-to-Blob upload (see README).
- **New this session**: the **/grade** tab — blind human grading of every run
  with a real relit cut (5-point scale per check + a ship-it call, stored as
  `Run.humanGrade`) and a "Compare with AI" view (agreement %, per-check score
  gaps, biggest disagreements ranked by score-gap × AI-confidence). The
  **Batch nav entry was removed** by request; `/batch` itself is still
  routable. Nav is now Studio · Library · Grade · Engine · Rubrics.
- **Secrets**: both API keys (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) live in
  `.env.local` (gitignored). Never echo or commit them.

## Where everything lives

| What | Where |
| --- | --- |
| Repo (local) | `~/Desktop/claude test flora/flora-relight` |
| Core contract (read first) | `lib/types.ts` |
| The 11 eval rubrics | `lib/prompts/eval-defs.ts` |
| Engine / store / persistence sync | `lib/engine.ts`, `lib/store.ts`, `lib/persist.ts` |
| Live provider routes | `app/api/live/*` (cost real money — never call casually) |
| Storage drivers (fs ↔ blob+db) | `lib/server/storage/` |
| Run artifacts | `data/runs/<runId>/` (local) / Blob + Neon (deployed) |
| Human grading + calibration | `app/grade/`, `components/grade/` |
| Cost rate card + estimators | `lib/cost.ts` |

## Run locally

```bash
cd "~/Desktop/claude test flora/flora-relight"
nvm use          # .nvmrc pins Node 22 — the GenAI SDK needs >= 20
npm install
npm run dev      # → http://localhost:3000
```

ffmpeg must be on PATH (`brew install ffmpeg`). The dev server **must be
started with the project dir as cwd** or Tailwind and the `data/` paths break.
Keys in `.env.local` flip the app to live mode automatically (`/api/live/health`).

## Deploy

```bash
vercel link            # once — project flora-relight, org justin-5763s-projects
vercel deploy --prod   # from the repo root; Dockerfile is picked up automatically
```

Env vars needed in production: `FLORA_ACCESS_PASSWORD`, `GEMINI_API_KEY`,
`ANTHROPIC_API_KEY`, plus the storage pair `BLOB_READ_WRITE_TOKEN` /
`DATABASE_URL` (injected by connecting the Blob store and Neon from the
project's Storage tab). Full walkthrough in README → "Deploying to Vercel".

## Open work items (priority order)

1. **Interruption-proof runs.** The engine runs client-side and dies with the
   tab — a reload orphans an in-flight run mid-generation. History: repeated
   "signal aborted" failures during judging; a judge pool + per-call retry
   landed and fixed the flakiness, but **reload-survival has not been built**
   (needs server-side or resumable run state; runs currently park as failed).
2. **50-clip batch test.** The whole point of the tool — still pending. Run
   ~50 clips through `/` (multi-drop → batch), review in `/batch` + `/library`.
   Mind the budget cap field; estimate ≈ $4/clip-run (see cost table).
3. **Judge calibration workflow** via the new `/grade` tab: blind-grade the
   batch, then use "Compare with AI" (biggest disagreements, sorted by
   confidence-weighted gap) to refine the judge rubrics (`/prompts`) and the
   generation brief.
4. **Release Arbiter node** — a final-artifact re-verify gate before ship
   (re-run the gates on the actual remuxed final file), from Justin's original
   Flora graph.
5. **Veo 1080p quality path** — optional higher-res generation path
   (current output 720p24); price it in `lib/cost.ts` first.
6. **Local `data/` → cloud migration script** — one-shot uploader for the
   existing local runs into Blob + Neon so the deployed app sees history.

## Cost table (verified rates, 2026-07-11 — `lib/cost.ts` is source of truth)

| Item | Rate | Notes |
| --- | --- | --- |
| Omni Flash video-to-video | $0.10 / output second | ≈ $1.00 per 10s clip per attempt |
| Gemini image edit (Look Anchor relight) | $0.07 / image | Stage A, per anchor attempt |
| Gemini judge call (video-native) | $0.02 / call | per eval per iteration |
| Gemini manifest extraction | $0.02 / call | once per run |
| Claude judge call (frame-grid) | $0.04 / call | per eval per iteration |
| ffmpeg trim/demux/remux | $0 | local by construction |
| **Typical full run** | **≈ $4** | pre-flight estimate shown before every run |

**Cost-transparency rule (standing, non-negotiable):** before ANY paid API
work, show the spend estimate and get confirmation; while it runs, surface
actuals as they accrue; afterwards, report the total. The app enforces this
(confirm-spend dialogs, `Run.cost` ledger, batch budget caps) — sessions
operating the app or its APIs directly must do the same.
