# HANDOFF — Flora Relight session handoff

Written 2026-07-13 for whoever (human or AI session) picks this project up next.
Read `README.md` for product-level docs and `ARCHITECTURE.md` for the design
rationale; this file is the "where were we" note.

## Current state (2026-07-13)

- **The app has live provider adapters.** Real Omni Flash video-to-video
  (`gemini-omni-flash-preview` via the Interactions API), real Gemini
  video-native judge + Claude frame-grid judge, with server routes under
  `app/api/live/*`. Earlier local/session testing produced real relit clips with
  audio-bit-identical output. Do not transfer that result to a new hosted
  deployment: configured keys remain unverified there until the Workflow smoke
  test and a separately authorized provider artifact round trip pass. Without
  keys the app falls back to mock mode.
- **Local persistence**: every run writes to `data/runs/<runId>/` (`run.json`
  plus `source.mp4`, `source-audio.m4a`, `relit-vN.mp4`, `anchor-vN.jpg`, …).
  `data/` is gitignored — it is the artifact of record on this machine.
- **GitHub**: public repo at `github.com/JustinYarn/flora-relight`.
  Branches: `main` (current) and `vercel-prep` — **vercel-prep is merged into
  main as of 2026-07-13**; the worktree at `../flora-relight-vercel` is now
  redundant.
- **Vercel deployment target**: the existing production URL is
  **https://flora-relight.vercel.app** (project `flora-relight`, org
  `justin-5763s-projects`). The current working tree is a standard Next.js
  deployment with `ffmpeg-static` included by output-file tracing and a shared
  password gate via `FLORA_ACCESS_PASSWORD` (middleware + `/gate`). Once this
  working tree is deployed, a guarded route starts the background Gemini
  interaction once; Vercel Workflow owns its non-billed polling, download,
  original-audio remux, verification, and operation-journal completion. Do not
  assume the existing hosted revision includes or has verified this path.
- **Storage driver architecture** (`lib/server/storage/`): env-selected seam.
  Hosted media now requires a **new private Vercel Blob store** plus Neon:
  `BLOB_READ_WRITE_TOKEN` + `DATABASE_URL` + `FLORA_BLOB_ACCESS=private`.
  The former `flora-relight-media` store is public and cannot be converted in
  place; do not reconnect its token for the hardened deployment. Create and
  connect a private store, then set the explicit access variable. Existing
  public entries remain readable only through Flora's authenticated proxy
  during migration; all new media is private. Without complete cloud config,
  local development uses `data/` but hosted production fails closed.
  Cloud ingest is a two-step client-direct-to-private-Blob upload (see README).
  `/api/readiness` earns hosted readiness through private Blob and database
  write/read/delete probes plus ffmpeg, rather than env presence alone.
- **New this session**: the **/grade** tab — blind human grading of every run
  with a real relit cut (5-point scale per check + a ship-it call, stored as
  `Run.humanGrade`) and a "Compare with AI" view (agreement %, per-check score
  gaps, biggest disagreements ranked by score-gap × AI-confidence). The
  **Batch nav entry was removed** by request; `/batch` itself is still
  routable. Nav is now Studio · Library · Grade · Engine · Rubrics.
- **Production-hardening in the working tree**: canonical ingest/run IDs;
  durable pre-upload batch drafts plus ingest-receipt recovery; server-persisted
  run skeletons before any processing begins; independent monotonic batch records
  with an atomic start winner; compact paginated history; revisioned single-run
  and batch execution records; immutable exact prompts and batch membership;
  server-owned first-cut Workflows with a seven-day recovery window; admission-bound
  seven-day batch approvals (single approvals remain 24 hours); a hard
  micro-dollar batch reservation ledger and server-fixed concurrency of two;
  revisioned autosaved grading drafts and conflict-safe final grades; persistent
  client retry; exact-once journals for every potentially paid provider action;
  single-owner Workflow enqueue and leased video finalization; truthful readiness
  gating; server-probed approval inputs; and permanent run deletion tombstones.
  These changes must be committed/deployed before production behavior changes.
- **Durability boundary**: completed uploads, run skeletons, batch drafts, run
  history, exact execution inputs, provider-operation handles/results, paid-call
  claims/responses, batch reservations, and revisioned `/grade` drafts are
  server-persisted. Vercel Workflow owns each live first-cut run and the live
  batch dispatcher, including provider polling, artifact finalization, audio
  remux/verification, settlement, and transition to human review. Closing the
  tab does not stop admitted live work. The production milestone deliberately
  stops there: manifest, Look Anchor, judges, gates, correction decisions, and
  later iterations do **not** run in the live Workflow. `lib/engine.ts` and its
  browser batch queue are now mock-only. Do not describe a first cut as having
  passed the 11 automated checks.
- **Secrets**: both API keys (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) live in
  `.env.local` (gitignored). Never echo or commit them.

## Where everything lives

| What | Where |
| --- | --- |
| Repo (local) | `~/Desktop/claude test flora/flora-relight` |
| Core contract (read first) | `lib/types.ts` |
| The 11 eval rubrics | `lib/prompts/eval-defs.ts` |
| Mock engine / UI store / persistence sync | `lib/engine.ts`, `lib/store.ts`, `lib/persist.ts` |
| Live provider routes | `app/api/live/*` (cost real money — never call casually) |
| Storage drivers (fs ↔ blob+db) | `lib/server/storage/` |
| Run artifacts | `data/runs/<runId>/` (local) / Blob + Neon (deployed) |
| Durable live run + batch owners | `workflows/durable-relight-{run,batch}.ts`, `lib/server/{run,batch}-execution-coordinator.ts` |
| Workflow-owned video start/poll/finalize | `workflows/durable-video-generation.ts`, `lib/server/video-generation-start.ts`, `app/api/live/videogen/poll/` (direct HTTP start is retired) |
| Exact-once paid-call journal | `lib/server/paid-operation.ts`, `lib/server/storage/` |
| Provider-free Workflow probe | `workflows/durability-smoke.ts`, `app/api/debug/workflow/` |
| Human grading + revisioned drafts | `app/grade/`, `components/grade/`, `app/api/grade-drafts/` |
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
vercel deploy --prod   # from the repo root
```

Env vars needed in production: `FLORA_ACCESS_PASSWORD`, `GEMINI_API_KEY`,
`ANTHROPIC_API_KEY`, plus `BLOB_READ_WRITE_TOKEN`, `DATABASE_URL`, and
`FLORA_BLOB_ACCESS=private` (after connecting a newly created **private** Blob
store and Neon from the project's Storage tab). The access password must be 20+ characters with no
surrounding whitespace; use a random 32+ character value and configure Vercel
Deployment Protection or an edge/WAF rate limit for `/api/gate`. Full
walkthrough in README → "Deploying to Vercel".
Use Node 22 and keep `/.well-known/workflow/*` outside the human password gate;
those generated routes receive Vercel's internal queue traffic.

After deploying Workflow changes, temporarily set
`FLORA_WORKFLOW_SMOKE_ENABLED=1`, redeploy, and run the signed-in browser-console
probe in README → "Provider-free Workflow deployment test". Poll for up to 120
seconds (every two seconds) so a cold Workflow worker is not mistaken for a
failure. A completed result
with `['started', 'completed']`, `runtime.ready: true`, and a successful
`runtime.mediaTransform` proves the queue/control plane, private storage, writable
scratch, and a synthetic ffmpeg encode/audio demux/remux/probe from inside a Workflow
step, without reading user media or calling a provider. Set the flag back to `0` and
redeploy immediately.
Neither `/api/readiness` nor this smoke proves a paid provider path.

## Open work items (priority order)

1. **Deploy and verify the durable control plane.** The production URL still
   runs an older commit. Commit/reconcile the shared working tree, deploy it,
   check `/api/readiness`, and run the provider-free Workflow smoke with the
   temporary flag. That proves storage, ffmpeg, and Workflow routing only. Do
   not infer a paid provider round trip from a green build or smoke probe.
2. **Small, explicitly approved live validation before scale.** After the
   provider-free checks, authorize one non-sensitive clip and confirm the full
   server path: submission, long poll, download, original-audio verification,
   reload recovery, batch settlement, and appearance in `/grade`. Then test a
   very small batch under an explicit cap before attempting ~50 clips. No paid
   validation has been run for this working tree.
3. **Judge calibration workflow** via the new `/grade` tab: blind-grade the
   batch, then use "Compare with AI" (biggest disagreements, sorted by
   confidence-weighted gap) to refine the judge rubrics (`/prompts`) and the
   generation brief.
4. **Decide whether to productionize the automated loop.** The durable live
   milestone intentionally generates one first cut for human grading. If the
   manifest, Look Anchor, 11-check judges, gates, and corrections should run
   live, implement them as explicit server Workflow stages with their own CAS
   state and spend approvals; do not re-enable the browser live engine.
5. **Release Arbiter node** — a final-artifact re-verify gate before ship
   (re-run the gates on the actual remuxed final file), from Justin's original
   Flora graph.
6. **Veo 1080p quality path** — optional higher-res generation path
   (current output 720p24); price it in `lib/cost.ts` first.
7. **Local `data/` → cloud migration script** — one-shot uploader for the
   existing local runs into Blob + Neon so the deployed app sees history.

## Cost table (verified rates, 2026-07-11 — `lib/cost.ts` is source of truth)

| Item | Rate | Notes |
| --- | --- | --- |
| Omni Flash video-to-video | $0.10 / output second | ≈ $1.00 per 10s clip per attempt |
| Gemini image edit (Look Anchor relight) | $0.13 / image | Stage A, per anchor attempt |
| Gemini judge call (video-native) | $0.02 / call | per eval per iteration |
| Gemini manifest extraction | $0.02 / call | once per run |
| Claude judge call (frame-grid) | $0.12 / call | per eval per iteration |
| ffmpeg trim/demux/remux | $0 | local by construction |
| **Typical full run** | **≈ $4** | pre-flight estimate shown before every run |

**Cost-transparency rule (standing, non-negotiable):** before ANY paid API
work, show the spend estimate and get confirmation; while it runs, surface
actuals as they accrue; afterwards, report the total. Manifest, anchor, every
configured judge slot, and video creation require a server-persisted approval
plus a stable operation claim; ambiguous outcomes have no automatic paid retry.
Completed operation costs are rebuilt from server journals. A
`reconcile_required` operation can represent an unknown upstream charge and is
not included in the confirmed numeric actual until reconciled; add an explicit
potential-charge warning to the UI before describing that number as a hard total.
Live batches reserve the maximum first-cut cost atomically in integer
micro-dollars before dispatch; reserved plus settled spend cannot exceed the
frozen cap. Confirmed cost uses the raw provider output duration before remux;
an over-cap output is sealed for reconciliation. Ambiguous provider work keeps
its reservation until reconciled.
Mock batches retain only the browser planning guardrail because they spend $0.
Sessions operating the app or its APIs directly must preserve the same approval
boundary.
