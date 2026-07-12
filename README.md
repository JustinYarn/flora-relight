# Flora Relight

An internal workflow-pipeline studio for professionally relighting ~10-second
webcam videos with generative models — same person, same performance, same room, studio-grade
light. The app wraps the whole loop: ingest → scene manifest → Look Anchor (relit still) →
video generation → an 11-eval dual-judge gauntlet → automatic prompt correction → human review.
With API keys configured the app runs **live** against the real providers. Without keys it
falls back to **mock mode**: every provider is a scripted stand-in behind the interfaces in
`lib/types.ts` (`lib/mock/`, the mock branch of `lib/providers/`). The mock machinery is a
no-keys fallback only — it has **no UI entry points** (no sample library, no demo buttons);
the engine simply uses the mock adapters when no keys exist.

## Quickstart

Prerequisites:

- **Node >= 20** (the Google GenAI SDK requires it; an `.nvmrc` pins 22 — `nvm use`)
- **ffmpeg** on your PATH (`brew install ffmpeg` on macOS) — used for trimming,
  audio demux/remux, and the side-by-side export
- **API keys** for live mode: copy `.env.local.example` to `.env.local` and add your
  own keys (Google AI Studio needs a paid-tier project for image/video models).
  Without keys the app boots in mock mode — fully clickable, spends nothing.

```bash
npm install
cp .env.local.example .env.local   # then paste your keys into it
npm run dev
# → http://localhost:3000
```

Costs money when live: video generation bills ~$1.00 per 10s clip per attempt, judges a few
cents per check. Every run/batch shows its price in a confirmation dialog before starting,
the top bar tracks actual spend, and batches accept a budget cap. All results (videos,
scores, prompts) persist to the gitignored `data/` folder on your machine — nothing is
uploaded anywhere except the API calls themselves.

## Deploying to Vercel

The repo deploys as a **container-image function** — the `Dockerfile` at the repo root is
picked up automatically — because ingest, videogen remux, and the side-by-side export need a
real ffmpeg binary. Storage swaps by env (`lib/server/storage/`): with
`BLOB_READ_WRITE_TOKEN` + `DATABASE_URL` present the app persists media to **Vercel Blob**
and run/batch JSON to **Neon Postgres**; without them it writes to the local `data/` folder
(fine on your machine, ephemeral in a deployed container — always configure both for a real
deploy).

Prerequisites and setup:

1. **Vercel Pro plan** (~$20/mo) — required for the long-running videogen function
   (`maxDuration: 800` in `vercel.json`; Hobby caps at 300s). At this app's scale the Pro
   plan covers the infrastructure: Blob storage/bandwidth and marketplace Postgres for a
   personal review workload sit inside the plan's included usage, so expect the recurring
   infra bill to stay ≈ the $20/mo plan fee. The real variable spend is the AI APIs
   (~$1 per 10s generation attempt), which the app estimates and tracks in-product.
2. `npm i -g vercel`, then `vercel login` and `vercel link` (create/link the project).
3. **Neon Postgres**: `vercel install neon`, then create a database from the project's
   Storage tab and connect it — this injects `DATABASE_URL` into the environment.
4. **Blob store**: project dashboard → Storage → Create Database → Blob, connect it to the
   project — this injects `BLOB_READ_WRITE_TOKEN`.
5. **Env vars** — add each with `vercel env add <NAME> production`:
   - `FLORA_ACCESS_PASSWORD` — the shared access gate password (middleware + `/gate`).
     Do not deploy without it: every page/API route — including the blob-upload token
     route and the paid AI routes — is open otherwise.
   - `GEMINI_API_KEY` — Google AI Studio key (paid tier for image/video models).
   - `ANTHROPIC_API_KEY` — Claude judge.
6. `vercel deploy --prod`.

**Cloud uploads are two-step.** Deployed Vercel functions cap request bodies at 4.5MB, so
the local multipart `/api/ingest` cannot receive videos in production. When the blob driver
is active the browser instead: (1) asks `POST /api/ingest/token` (gate-cookie
authenticated) for a client token and streams the file **directly to Vercel Blob**
(`upload()` from `@vercel/blob/client`; `uploads/` prefix, video/* only, 500MB cap), then
(2) calls `POST /api/ingest/finalize`, which downloads the blob to scratch, runs the exact
same probe → auto-trim → audio-demux pipeline as local ingest, persists
`source.mp4`/`source-audio.m4a` under a new run id, and deletes the raw upload. The client
picks its path automatically from `GET /api/storage/info` (`fs` → multipart, `blob` →
client upload); local dev with no blob envs is byte-for-byte unchanged.

## What MOCK MODE means

Mock mode is the no-keys fallback — you land in it only when the server reports no API keys
(`/api/live/health`). There is no way to start a mock/sample run from the UI; the same
upload flows just execute against the mock adapters. The badge in the top bar is not
decoration. In mock mode:

- **Runs replay a scripted 3-iteration trajectory** (`lib/mock/scenario.ts`), chosen to
  exercise every interesting code path:
  - **Iteration 1** relights too timidly and **fails two hard gates**: the lighting-drama
    gate (`lighting-quality-delta`) — the anti-degenerate check that stops the model from
    just handing the input back — and the skin gate (`skin-texture-age`), which catches
    subtle cheek smoothing.
  - **Iteration 2** relights well but **hallucinates a window** into the background
    (`hallucination-artifacts` fails) and one eval shows a **judge-disagreement /
    low-confidence flag** — the two mock judges land far apart, the confidence meter drops,
    and the eval is flagged for human attention.
  - **Iteration 3 passes**: composite over threshold, all hard gates green, run lands in
    *awaiting review*.
- **The "generated" video is the original clip with a CSS filter on top** (see
  `VideoAsset.simulatedFilter`). It is labeled as simulated wherever it appears. No pixels
  are actually generated.
- **Identity, audio, and temporal guarantees are simulated.** The scripted scores *depict*
  what the deterministic metrics (face embeddings, audio hashes, alignment correlation)
  would report; in mock mode nothing measures real pixels. Do not use mock output to judge
  model quality — use it to judge the *pipeline*.
- In an environment without the API routes, uploads never leave the browser tab: they become
  object URLs and frames are extracted with a local `<canvas>`. With the dev server running,
  uploads persist to `data/runs/<id>/` via `/api/ingest` exactly as in live mode.

## Glossary — plain term ↔ technical term

The UI speaks plain English; the code, prompts, and this README's deeper sections use
the technical vocabulary. Same concepts, one mapping:

| Plain term (what the UI says) | Technical term (what the code says) |
| --- | --- |
| Overall score | composite (weighted mean of eval scores) |
| must pass | hard gate (`hardGate: true` eval) |
| the checks / the 10 checks | evals / the eval gauntlet (`EVAL_DEFS`) |
| Generation brief vN | mega prompt vN (`MegaPrompt`) |
| Fix list / fixes | constraint ledger / corrections |
| Original audio restored | audio remux (bit-exact stream-copy of the ingest audio) |
| Scene inventory | scene manifest (`SceneManifest`) |
| Look Anchor (target lighting photo) | look anchor — the approved relit still |
| attempt | iteration |
| needs your review | `awaiting-review` run status |
| safe fallback (lighting copied onto original pixels) | color-transfer fallback |
| Average score / Average confidence | mean composite / mean judge confidence |

## Page map

| Route | What it is |
| --- | --- |
| `/` | Studio — hero, new-run dropzone (drop one clip for a run, several for a batch), runs table |
| `/library` | The Library — browse every past generation with progressive disclosure |
| `/pipeline` | The workflow canvas — the node graph of the pipeline with live run status |
| `/batch` | Batch review board — queue many clips at once, watch the worker pool drain them, approve inline |
| `/prompts` | Prompt library — the base prompt, manifest extractor, all 11 eval rubrics, mega-prompt compiler |
| `/runs/[id]` | Run review — iterations, eval scorecards, judge verdicts, prompt diffs, approve / needs-changes |

## Repo map

| Path | Role |
| --- | --- |
| `lib/types.ts` | **The contract.** Every module is written against these types; read this first |
| `lib/util.ts` | Small shared helpers (ids, clamps, formatting, verdict math) |
| `lib/cost.ts` | Cost governance: placeholder `PRICE_TABLE`, est.-live-cost estimators, `formatUsd` |
| `lib/prompts/` | Base prompt, manifest-extraction prompt, the 11 eval definitions, the mega-prompt compiler |
| `lib/providers/` | `VideoGenProvider` / `ImageGenProvider` / `VisionJudgeProvider` implementations — mock today, real later |
| `lib/mock/` | The scripted no-keys fallback scenario: per-iteration outcomes, synthetic sample video, mock scene manifest (no UI entry points) |
| `lib/engine.ts` | `runWorkflow()` — executes the graph, drives iterations, aggregates evals, updates the store |
| `lib/workflow-def.ts` | `RELIGHT_WORKFLOW` — the default pipeline graph + run config |
| `lib/frames.ts` | Client-side frame probing/extraction via canvas |
| `lib/store.ts` | Zustand store: runs, batches, review actions |
| `components/ui.tsx` | Shared UI primitives (cards, badges, meters) |
| `ARCHITECTURE.md` | The full design: pipeline tiers, structural guarantees, eval methodology, loop control |

## The Library

`/library` is the reader over the on-disk run store (`data/runs/<runId>/run.json` plus the
media files next to it): every generation the studio has ever produced, newest first, with a
one-line stats strip (total generations, review counts, average Overall score of shipped
cuts, actual + estimated spend) and filters (clip search, status chips, live-vs-simulated
toggle, sort). Rows disclose progressively: collapsed — before/after thumbnails, status,
Overall score, attempts, cost; expanded — side-by-side players, per-attempt chips, the 11
checks, the fix list that drove the final attempt, and inline approve / request-changes;
per-check — both judges' scores, reasoning, and violations with fix text. Simulated (mock)
runs are always badged, and runs missing relit files fall back to the original thumbnail.

## Sharing results

Every run page has a **Share snapshot** button. It compiles that run into a single,
fully self-contained HTML file (`relight-review-<id>.html`) and downloads it: the clip is
embedded as a base64 data URI (~40 MB cap), alongside the original-vs-relit comparison, the
composite verdict, and all 11 eval rows with scores, confidence, and violations. No server,
no tracking, no dependencies — the file opens anywhere and is the product. In mock mode the
"relit" side is the embedded original replayed through the winning iteration's simulated CSS
filter and is labeled as such; when real generation lands, the actual generated video gets
embedded instead. The snapshot exists so teammates can judge whether the evaluations match
their expectations of the video: each eval row carries agree/disagree toggles and a free-text
note, and a **Copy feedback summary** bar composes the whole review (clip, composite,
per-eval verdicts, reviewer reads, notes) into plain text on the clipboard, ready to paste
back to the team.

## Mass automation (batch runs)

`/batch` is the answer to "run this against everything." **Batches start from the Studio
dropzone**: drop (or pick) several clips at once and each is ingested sequentially through
`/api/ingest` (with per-file progress and per-file error reporting — one bad clip never
aborts the set; over-long clips are auto-trimmed to the 10s model cap and the trim count is
surfaced). You then get **one spend confirmation** listing every clip with its per-clip
estimate, the batch total (`estimateBatch`), and an optional **budget cap** field before
anything runs. Confirming calls `startBatch(videos, name, { budgetUsd })` in `lib/store.ts`,
which creates one run per clip and drains them through a bounded worker queue —
**at most 2 engines in flight**; the rest sit visibly queued ("waiting for a worker slot")
until a slot frees. The board shows aggregate stats for the whole batch (completion,
pass-first-try rate, fallback count, mean composite, the hard gate that failed most, mean
judge confidence) over a grid of live clip cards with gate-failure chips, low-confidence and
fallback flags, and inline approve. In mock mode each clip deterministically replays one of
five scripted trajectories (`scenarioForVideo()` in `lib/mock/scenario.ts`), so a multi-clip
batch exercises the entire outcome spectrum on one screen.

The bounded queue is not a mock convenience; it is the production shape. Real Omni calls are
rate-limited and each video generation costs real money, so batch throughput will always be
"N workers against a rate limit and a budget", never "fire everything at once." The batch
board is the human half of that story: automation produces candidates at machine speed,
reviewers consume them from a single queue, and every verdict feeds back into the system.
Scaling this up looks like:

- **Folder-scale input** — point the same `startBatch` contract at a directory of 50+ clips;
  worker count becomes a config knob bounded by Omni rate limits and the per-batch cost budget.
- **Per-run artifact directories** — original, approved anchor, every iteration's generation,
  eval JSON, and the final remux written per run id, so any batch member is auditable offline.
- **Nightly cron sweep** — re-run a fixed clip corpus against the current prompt + eval
  registry and diff composites against the previous sweep: regression detection for prompt
  and threshold changes.
- **Judge calibration for free** — every approve / needs-changes on the board is a labeled
  example (judges said X, human said Y) that accumulates toward per-eval threshold re-tuning.
- **CLI + watch folder (future)** — `relight batch ./clips --workers 4` for scripted sweeps,
  and a watch-folder mode that queues clips as they land.

## Cost governance

The standing rule is "always know what is being spent." `lib/cost.ts` is the single source
of price truth, and every future paid call routes through it — the layer exists *before* any
live wiring so going live cannot outrun the accounting.

- **The price table is verified-or-flagged.** Each rate in `PRICE_TABLE` (Omni video seconds,
  Gemini image edits / judge / manifest calls, Claude judge calls, local ffmpeg at $0) carries
  a `verified` flag and a verification date; any rate still `verified: false` must be updated
  from the provider's primary pricing docs before it is trusted.
- **Estimates are shown everywhere *before* actions.** The estimators are driven by the real
  registry/config (`EVAL_DEFS`, `RELIGHT_WORKFLOW.config`), never hardcoded counts: the
  single-run and batch spend-confirmation dialogs, the batch board, the run review verdict
  line, and a top-bar "est. session" chip all show the estimated live cost up front. In mock
  mode nothing costs money, so every figure is an **est. live cost** — what the action WOULD
  cost against real APIs — and is always labeled est/actual, never a raw number.
- **Every run keeps a cost ledger.** `Run.cost` records a pre-flight `estimatedUsd` plus one
  item per provider call as the engine executes; the run log closes with an
  "Est. live cost for this run" line. In mock mode all items are `estimated: true` and
  `actualUsd` stays $0.
- **Batches can carry a budget cap.** `startBatch(videos, name, { budgetUsd })` makes the
  worker queue check projected spend before dispatching each run; once the next run's
  estimate would break the cap, remaining runs are skipped (failed with a "budget reached"
  log entry and a "budget cap" badge on the board) instead of dispatched.
- **When live mode lands, actuals accrue through the same ledger.** The real adapters flip
  ledger items to `estimated: false` and accumulate `actualUsd` — the UI keeps the same
  est/actual framing, and the budget gate starts guarding real dollars.

## Wiring real APIs later

The architecture is built so that going live touches **only `lib/providers/`**:

1. **Implement the three provider interfaces** (defined in `lib/types.ts`):
   - `VideoGenProvider` → the Omni video model. Receives the original video, the compiled
     mega prompt, the approved anchor frame as conditioning, and a seed. Note the interface
     deliberately does not accept audio.
   - `ImageGenProvider` → Gemini image relighting for the Tier-1 Look Anchor.
   - `VisionJudgeProvider` × 2 → Claude and Gemini as independent vision judges, each
     receiving an eval rubric plus before/after frames and returning a `JudgeVerdict`.
2. **Add an ffmpeg service** (local binary or sidecar) for the media plumbing the browser
   cannot do: demux audio at ingest, hash it, conform/inspect the generated video,
   stream-copy remux audio onto the winner, and real (non-canvas) frame extraction.
3. **Swap the deterministic metric stubs** for real ones (face-embedding similarity,
   masked SSIM, landmark correlation, flicker) as they come online — they slot in behind
   the same `EvalResult` shape.
4. Flip `getProviders("mock")` to `getProviders("live")` in the engine call site.

Everything else — the store, the engine loop, the eval registry and thresholds, the
mega-prompt compiler, all UI — is designed to remain unchanged.

## Honest limitations

This is a demo-quality internal tool. The *methodology* (eval design, prompt compilation,
loop control) is production thinking; the *measurements* in mock mode are scripted. Any
guarantee you see in the UI about identity preservation or audio integrity is, today, a
simulation of what the real deterministic checks will enforce.
