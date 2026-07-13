# Flora Relight

An internal workflow-pipeline studio for professionally relighting ~10-second
webcam videos with generative models — same person, same performance, same room, studio-grade
light. The app wraps the whole loop: ingest → scene manifest → Look Anchor (relit still) →
video generation → an 11-eval dual-judge gauntlet → automatic prompt correction → human review.
With API keys configured the app selects its **live** provider adapters. Configuration alone
does not prove that a particular hosted deployment can complete a provider artifact round
trip; verify the deployment as described below before treating it as live-functional.
Without keys it falls back to **mock mode**: every provider is a scripted stand-in behind the
interfaces in `lib/types.ts` (`lib/mock/`, the mock branch of `lib/providers/`). The mock
machinery is a no-keys fallback only — it has **no UI entry points** (no sample library, no
demo buttons); the engine simply uses the mock adapters when no keys exist.

## Quickstart

Prerequisites:

- **Node 22** (`.nvmrc` is the supported local default)
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
the top bar tracks actual spend, and batches accept a budget cap. In local development,
results (videos, scores, prompts, and grading drafts) persist under the gitignored `data/`
store. In a deployed environment they persist to the configured Blob + Postgres storage.

## Deploying to Vercel

The repo deploys as a standard Next.js project. `ffmpeg-static` is bundled into the
serverless route traces by `next.config.mjs`, supplying the real media binary needed by
ingest, video finalization, and side-by-side export. Storage swaps by env
(`lib/server/storage/`): with
`BLOB_READ_WRITE_TOKEN` + `DATABASE_URL` + `FLORA_BLOB_ACCESS=private` present the app
persists media to a **private Vercel Blob store** and run/batch JSON to **Neon Postgres**.
Hosted production fails closed when any part is missing or access is not explicitly private;
local development may use the `data/` folder.

Prerequisites and setup:

1. Use **Node 22**, enable **Fluid Compute**, and deploy as a normal Next.js project. The
   `workflow` adapter in `next.config.mjs` generates the `/.well-known/workflow/*` control
   plane. Those routes must remain reachable by Vercel's internal queue requests; the
   password middleware intentionally excludes them.
2. `npm i -g vercel`, then `vercel login` and `vercel link` (create/link the project).
3. **Neon Postgres**: `vercel install neon`, then create a database from the project's
   Storage tab and connect it — this injects `DATABASE_URL` into the environment.
4. **Private Blob store**: project dashboard → Storage → Create Database → Blob, choose
   **Private**, and connect it to the project — this injects `BLOB_READ_WRITE_TOKEN`.
   Vercel cannot change an existing public store to private: create a new private store and
   reconnect the project. Existing public run media can still be read through Flora's gated
   proxy during migration, but every new upload and generated artifact uses the private store.
5. **Environment scopes** — Preview is hosted and fails closed just like Production.
   Connect the private Blob and Neon integrations to **Preview + Production**, then set:
   - **Preview + Production:** `FLORA_ACCESS_PASSWORD` — the shared access gate password
     (middleware + `/gate`).
     Hosted deployments require at least 20 characters with no surrounding whitespace;
     use a randomly generated 32+ character value. Missing or weak configuration fails
     closed. Protect `/api/gate` with Vercel Deployment Protection or another edge/WAF
     rate limit; an in-memory application counter is not reliable across serverless instances.
   - **Preview + Production:** `FLORA_BLOB_ACCESS=private` — required explicit access policy.
     Set this only after the connected `BLOB_READ_WRITE_TOKEN` belongs to the new private
     store. Both environments also need their private-store token and database URL from the
     scoped integrations.
   - **Production only by default:** `GEMINI_API_KEY` (Google AI Studio, paid tier for
     image/video models) and `ANTHROPIC_API_KEY` (Claude judge). Keep these out of Preview
     during provider-free deployment validation; add them to another environment only for
     an explicitly approved provider test.
   With the CLI, add a value separately for each intended scope, for example
   `vercel env add FLORA_ACCESS_PASSWORD preview` and then `... production`.
6. `vercel deploy --prod`.

**Cloud uploads are two-step.** Deployed Vercel functions cap request bodies at 4.5MB, so
the local multipart `/api/ingest` cannot receive videos in production. When the blob driver
is active the browser instead: (1) asks `POST /api/ingest/token` (gate-cookie
authenticated and same-origin checked) for a client token and streams the file **directly to
private Vercel Blob** (`upload()` from `@vercel/blob/client`; deterministic run-owned
`uploads/` path, multipart, video/* only, 150MB cap), then (2) calls
`POST /api/ingest/finalize` with only the reserved run id. The server resolves and
authenticates the private object, downloads it to scratch, and runs the exact
same probe → auto-trim → audio-demux pipeline as local ingest, persists
`source.mp4`/`source-audio.m4a` under the client's reserved run id, and then makes a
best-effort deletion of the redundant raw upload. A cleanup failure is logged but does not
invalidate the committed ingest receipt, so the raw object may require later operator cleanup.
The client picks its path automatically from `GET /api/storage/info` (`fs` → multipart,
`blob` → client upload); local dev with no blob envs is unchanged. A signed Blob completion
callback and the pre-token durable reservation close the upload/finalize crash gap: after a
reload, Flora can discover the deterministic private object and finish ingest without
exposing its provider URL.

`GET /api/readiness` does more than inspect environment-variable presence in hosted mode: it
performs a small private-Blob and Postgres write/read/delete round trip (cached for 60 seconds)
plus the ffmpeg check. `ready: true` therefore proves the configured storage backends were
reachable at that moment, without calling an AI provider or uploading user media.
`storage.readinessStatus` and `storage.ready` are the effective post-probe result;
`storage.configurationStatus` (and the backward-compatible `storage.status` alias) describe
configuration only. The response also reports the Vercel Git SHA/ref when those system
variables are available, so an authenticated operator can verify the deployed source.

### Hosted durability and working memory

The hosted app now has several independent persistence boundaries:

- **Uploads and run identity:** a multi-file selection is recorded as a batch draft before
  transfer begins, each file receives a stable run id, and every successful upload is
  finalized into durable media storage. A run skeleton is written to the server before the
  browser starts analysis. On reload the Studio checks the finalization receipt for any
  interrupted-looking item, so a completed server ingest is recovered even if its response
  was lost. Bytes that were only partway through a browser-to-Blob transfer must be sent
  again; completed uploads and prepared run records survive.
- **Run and batch state:** the browser hydrates from paginated server history, but live
  execution truth is stored separately in revisioned `RunExecution` and `BatchExecution`
  records. The UI only accepts non-regressing revisions and polls once per selected batch,
  rather than starting one poller per clip. Canonical source facts, immutable execution
  membership, exact prompts, spend approval, provider operations, and final human grades are
  protected by atomic server updates. A stale browser snapshot cannot move a live execution
  backwards, alter its budget, or erase it. A deleted run id is permanently tombstoned, so an
  already-open tab cannot resurrect it or reset its billing history. Normal deletion is
  refused while an execution, active Batch membership, or provider journal is active or
  needs reconciliation; a prepared upload with no paid work remains deletable.
- **Blind grading:** `/grade` restores and autosaves a revisioned grading draft through
  `/api/grade-drafts`. Compare-and-swap revisions prevent an older tab from silently
  overwriting a newer draft. Final submission also uses compare-and-swap, so a stale grader
  receives a conflict instead of replacing the latest grade. A completed video reconstructed
  from the server provider journal remains gradeable even if later browser-side frame/judge
  work failed; the displayed URL and accepted grade refer to that exact journaled artifact.
- **Potentially paid calls:** manifest, Look Anchor, each configured judge slot, and video
  generation all require a valid server-issued spend approval priced from the durable,
  server-probed ingest—not browser duration or URL metadata. Every action has a stable
  operation id and durable claim. Completed synchronous responses are replayed from the
  journal; an in-flight or ambiguous result fails closed and must be reconciled rather than
  automatically repeating a potentially billed request.
- **Durable live first cuts:** after server-side spend authorization and an atomic operation
  claim, a `RunExecution` Workflow owns the provider submission, non-billed polling,
  generated-file download, original-audio remux, verification, journal settlement, and the
  transition to human review. The exact rendered prompt is frozen into the execution record.
  A provider handle is never recreated merely because a poll or deployment was interrupted;
  ambiguous work remains reserved and enters reconciliation instead. Recovery polling can
  continue for up to seven days after the initiating tab closes.
- **Durable live batches:** one immutable `BatchExecution` freezes the ordered members,
  server-owned concurrency of exactly 2, prompt, and integer micro-dollar budget plan before
  dispatch. A parent Workflow admits only reserved members and starts durable child
  `RunExecution` workflows up
  to two at a time. Its exact member/source/prompt/cost approvals are anchored to admission
  and remain valid for the seven-day recovery window; a retry cannot roll that window
  forward. Refreshing, closing the tab, or retrying a lost start
  response does not create a second paid attempt. Terminal and reconciliation states remain
  visible after reload, and a lost final batch-status write is repaired on the next start
  retry.

The live production milestone is intentionally narrower than the product's full evaluation
design: it creates **one canonical relit first cut**, restores and verifies the original
audio, and then hands that artifact to the human grader. It does not claim that the manifest,
Look Anchor, 11-check dual-judge gauntlet, gates, or automatic correction loop ran. Those
stages remain available in the scripted mock engine for product exploration, but the browser
engine refuses live execution. Live single runs and batches no longer depend on an open tab;
their durable result is either ready for grading, safely failed before spend, or explicitly
waiting for reconciliation.

### Provider-free Workflow deployment test

`GET /api/readiness` proves the configured storage backend and ffmpeg binary only. It does
not exercise Vercel's Workflow queue and it never calls an AI provider. The gated smoke also
creates a tiny synthetic clip inside Workflow scratch, encodes it, demuxes/remuxes its audio,
and probes the result. It uses no uploaded media and makes no provider call. Run it after
deploying a Workflow change:

1. Temporarily set `FLORA_WORKFLOW_SMOKE_ENABLED=1` for the target environment and redeploy.
2. Sign in to the deployed app, open the browser console on that origin, and run:

   ```js
   const token = `smoke_${Date.now()}`;
   const started = await fetch("/api/debug/workflow", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ token }),
   }).then(async (response) => {
     if (!response.ok) throw new Error(await response.text());
     return response.json();
   });

   const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
   let probe;
   // Allow up to two minutes: a cold Workflow worker can take longer than a
   // normal warm invocation even when the deployment is healthy.
   for (let attempt = 0; attempt < 60; attempt += 1) {
     await new Promise((resolve) => setTimeout(resolve, 2_000));
     const response = await fetch(
       `/api/debug/workflow?id=${encodeURIComponent(started.workflowRunId)}`
     );
     if (!response.ok) throw new Error(await response.text());
     probe = await response.json();
     if (terminalStatuses.has(probe.status)) break;
   }

   if (!probe || !terminalStatuses.has(probe.status)) {
     throw new Error("Workflow smoke timed out before reaching a terminal state.");
   }
   if (probe.status !== "completed") {
     throw new Error(`Workflow smoke ended with status: ${probe.status}`);
   }

   const result = probe.result;
   const media = result?.runtime?.mediaTransform;
   const expect = (condition, message) => {
     if (!condition) throw new Error(`Workflow smoke assertion failed: ${message}`);
   };
   expect(result?.token === token, "token mismatch");
   expect(
     JSON.stringify(result?.checkpoints) === JSON.stringify(["started", "completed"]),
     "checkpoint mismatch"
   );
   expect(result?.runtime?.ready === true, "runtime not ready");
   expect(result?.runtime?.durable === true, "storage is not durable");
   expect(result?.runtime?.ffmpegReady === true, "ffmpeg unavailable");
   expect(result?.runtime?.storageDriver === "blob", "Blob driver not active");
   expect(result?.runtime?.storageVerification === "verified", "storage probe not verified");
   expect(media?.binarySource === "bundled", "bundled ffmpeg was not used");
   expect(media?.scratchWritable === true, "scratch is not writable");
   expect(media?.encoded === true, "encode failed");
   expect(media?.audioDemuxed === true, "audio demux failed");
   expect(media?.remuxed === true, "audio remux failed");
   expect(media?.probed === true, "final probe failed");
   expect(media?.width === 64 && media?.height === 64, "unexpected frame dimensions");
   expect(media?.hasAudio === true, "final clip has no audio");
   expect(media?.durationMs >= 250 && media?.durationMs <= 1_500, "unexpected duration");
   expect(media?.outputBytes > 0 && media?.outputBytes <= 524_288, "unexpected output size");
   probe;
   ```

3. The loop polls every two seconds for up to 120 seconds, stops on every terminal
   status, and throws unless the completed result passes all storage, packaged-ffmpeg,
   encode, audio-demux/remux, probe, dimension, duration, and output-size assertions.
   That result proves the Workflow step could execute the same provider-free storage
   round trip used by `/api/readiness`; it starts no AI-provider call and reads or
   uploads no user media.
4. Set the flag back to `0` (or remove it) and redeploy. Do not leave the debug starter
   enabled in production.

A successful smoke test proves the Workflow control plane plus provider-free storage and
ffmpeg availability inside a Workflow step. Treat provider keys as
`configured_unverified` until a separate, explicitly approved server-side artifact
submission/poll/download test succeeds. Never use the smoke test as permission for a paid
provider call.

The detailed `/api/debug/ffmpeg` route is separately disabled by default. If deployment
diagnosis requires it, set `FLORA_FFMPEG_DEBUG_ENABLED=1`, redeploy, inspect it while signed
in, then remove the flag and redeploy immediately; its operator report contains local process
paths and low-level execution details.

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
| `/grade` | Grade — blind-grade the before/after cuts on the same 11 checks (5-point scale + ship call), then "Compare with AI" for agreement stats, score gaps, and the biggest disagreements |
| `/pipeline` | The workflow canvas — the node graph of the pipeline with live run status |
| `/batch` | Batch review board — queue many clips at once, watch the worker pool drain them, approve inline. No nav entry (removed by request) — still routable by URL |
| `/prompts` | Prompt library — the base prompt, manifest extractor, all 11 eval rubrics, mega-prompt compiler |
| `/runs/[id]` | Run review — iterations, eval scorecards, judge verdicts, prompt diffs, approve / needs-changes |

## Repo map

| Path | Role |
| --- | --- |
| `lib/types.ts` | **The contract.** Every module is written against these types; read this first |
| `lib/util.ts` | Small shared helpers (ids, clamps, formatting, verdict math) |
| `lib/cost.ts` | Cost governance: placeholder `PRICE_TABLE`, est.-live-cost estimators, `formatUsd` |
| `lib/prompts/` | Base prompt, manifest-extraction prompt, the 11 eval definitions, the mega-prompt compiler |
| `lib/providers/` | Client-safe live/mock adapters for video generation, image generation, and judges |
| `lib/mock/` | The scripted no-keys fallback scenario: per-iteration outcomes, synthetic sample video, mock scene manifest (no UI entry points) |
| `lib/engine.ts` | `runWorkflow()` — executes the graph, drives iterations, aggregates evals, updates the store |
| `lib/workflow-def.ts` | `RELIGHT_WORKFLOW` — the default pipeline graph + run config |
| `lib/frames.ts` | Client-side frame probing/extraction via canvas |
| `lib/store.ts` | Zustand UI/read cache plus the mock-only in-tab batch worker queue |
| `lib/persist.ts` | Browser-to-server run/batch synchronization and retry status |
| `lib/server/storage/` | Local fs or hosted Blob + Postgres persistence drivers |
| `workflows/` | Durable live run/batch coordination, video finalization, and provider-free Workflow probe |
| `app/api/grade-drafts/` | Revision-checked blind-grading working memory |
| `components/ui.tsx` | Shared UI primitives (cards, badges, meters) |
| `ARCHITECTURE.md` | The full design: pipeline tiers, structural guarantees, eval methodology, loop control |

## The Library

`/library` reads the active storage backend: `data/runs/<runId>/` locally, or Blob +
Postgres when deployed. It shows every persisted generation, newest first, with a
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
the active local or direct-to-Blob path (with per-file progress and per-file error reporting
— one bad clip never aborts the set; over-long clips are auto-trimmed to the 10s model cap
and the trim count is surfaced). You then get **one spend confirmation** listing every clip
with its per-clip estimate, the batch total (`estimateBatch`), and an optional **budget cap**
field before anything runs. Confirming creates one server-persisted run skeleton per clip. In
live mode the server then freezes one `BatchExecution`: ordered membership, exact first-cut
prompt, server-owned concurrency of 2, and a hard integer micro-dollar reservation plan. A
durable parent Workflow starts at most two child run workflows at once, regardless of browser
or persisted batch input; the rest remain durably queued. A budget that cannot admit every
clip marks the
remainder `skipped_budget` before any provider operation is authorized. The board restores
this state after refresh and uses one batch poll plus targeted member refreshes.

Every admitted live member produces one audio-verified first cut for manual grading. There
are no automatic live judge or correction attempts in this milestone. In mock mode only,
`lib/store.ts` runs the original browser worker queue and each clip deterministically replays
one of five scripted full-pipeline trajectories (`scenarioForVideo()` in
`lib/mock/scenario.ts`). Scaling the surrounding batch product further looks like:

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
- **Live batches have a hard server-owned budget cap.** Before dispatch, the server reserves
  the maximum cost of one 10-second first cut for each admitted member using integer
  micro-dollars. Reserved plus settled spend cannot exceed the frozen cap. Completion settles
  the journaled actual from the raw provider output duration before audio remux can shorten
  the delivered artifact; an ambiguous provider outcome keeps its reservation instead of
  freeing money for another call. Mock batches retain the in-tab planning guardrail because
  they cannot spend anything.
- **In live mode, confirmed actuals come from server journals.** Completed manifest, anchor,
  judge, and video operations materialize their recorded costs into the displayed ledger
  after an interruption; a browser snapshot cannot forge or erase those confirmed items.
  An operation sealed as `reconcile_required` may have charged upstream but has no confirmed
  result/cost yet, so the confirmed numeric actual can be a lower bound until manual
  reconciliation. The batch summary keeps that amount visibly reserved rather than reporting
  it as available budget.

## Live API boundaries

Live and mock implementations share the interfaces in `lib/types.ts`; provider secrets and
media plumbing stay on server routes:

1. **Provider interfaces:**
   - `VideoGenProvider` → the Omni video model. Receives the original video, the compiled
     mega prompt, the approved anchor frame as conditioning, and a seed. The interface
     deliberately does not accept audio.
   - `ImageGenProvider` → Gemini image relighting for the Tier-1 Look Anchor.
   - `VisionJudgeProvider` × 2 → Claude and Gemini as independent vision judges, each
     receiving an eval rubric plus before/after evidence and returning a `JudgeVerdict`.
2. **Server media service:** ffmpeg handles ingest probing/trimming, audio demux/remux,
   generated-video inspection, verification, and exports. `ffmpeg-static` is traced into
   hosted functions; local development may use the installed binary.
3. **Paid-operation boundary:** all configured live provider calls require server-issued
   approval and atomically claim a stable operation id. Ambiguous outcomes are sealed for
   reconciliation; the app never assumes that an HTTP error means a paid request is safe to
   repeat.
4. **Remaining deterministic metric work:** real face-embedding similarity, masked SSIM,
   landmark correlation, and flicker checks can replace the current stubs behind the same
   `EvalResult` shape.
5. `/api/live/health` selects live mode when the Gemini first-cut provider is configured and
   reports the broader evaluation capability separately. That selection is a configuration
   fact, not proof that any provider/model is functional in the current deployment.

The eval registry, thresholds, mega-prompt compiler, and UI still share contracts across live
and mock modes. The execution owners are intentionally different: Vercel Workflow owns live
first cuts and batches; the Zustand/browser engine is mock-only.

## Honest limitations

This is an internal, still-hardening tool. The *methodology* (eval design, prompt
compilation, loop control) is production thinking; the *measurements* in mock mode are
scripted. Any guarantee shown while mock mode is active depicts what the real checks should
enforce, not a pixel measurement. Hosted live orchestration currently stops after one durable,
audio-verified first cut per admitted run; it does not run or claim the automated evaluation
and correction loop. A configured key, a passing build, or a provider-free Workflow smoke
test must not be described as a successful paid-provider artifact round trip.
