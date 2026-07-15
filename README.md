# Flora + Lamp

This branch keeps the established **Flora** one-pass workflow and adds **Lamp**, a
simpler exact two-pass workflow. A persistent selector on Create chooses the method
for each new single run or batch; the choice is saved with the record so later
review, recovery, grading, and cost displays do not depend on the browser's current
toggle. Legacy records with no method field remain Flora. Repository, route,
storage, and environment-variable names that already begin with `flora` or
`FLORA_` remain unchanged for compatibility.

Each live Lamp run has one fixed, auditable path:

1. Generate an initial video from the complete mega prompt, discard provider
   sound, then restore (or preserve source silence) and verify source audio.
2. Critique that finalized video once, holistically, across the eight applicable
   visual checks, and record the deterministic audio result alongside them.
3. Compile one correction mega prompt from that critique.
4. Generate exactly one final video from the corrected prompt, then repeat the
   same fail-closed source-audio finalization.
5. Evaluate the finalized Final video holistically with the same eight visual
   checks and record its deterministic audio result.
6. Grade the final video as a human. The completed final AI evaluation stays
   hidden by default, can be revealed explicitly at any time in Grade, and is
   compared per check after the human grade is saved.

`temporal-alignment` is currently unavailable because its deterministic live
correlation metric is not implemented. `lighting-match-to-anchor` is inapplicable
because Lamp does not create or condition on a Look Anchor, so that row is absent
from Lamp's AI and human grading contracts. Temporal alignment remains visible to
the human grader as unavailable rather than receiving an invented AI score. Lamp
supports both single runs and server-owned batches; every admitted
batch member executes this same two-generation/two-evaluation contract and enters
the same blind per-video grading flow.

With API keys configured the app selects its live provider adapters. Configuration
alone does not prove that a hosted deployment can complete a provider artifact round
trip. **No paid provider artifact round trip was run while implementing this Lamp
branch**, so verify an explicitly authorized deployment before treating it as
live-functional. Without keys the existing scripted mock adapters remain available as
a provider-free development fallback; their scores are simulated, not model-quality
evidence.

## Quickstart

Prerequisites:

- **Node 22** (`.nvmrc` is the supported local default)
- **ffmpeg** on your PATH (`brew install ffmpeg` on macOS) — used for trimming,
  audio demux/remux, and the side-by-side export
- **API keys** for live mode: copy `.env.local.example` to `.env.local` and add your
  own keys (Google AI Studio needs a paid-tier project for image/video models).
  Without keys the app boots in a provider-free mock rehearsal and spends nothing;
  only server-verified live artifacts enter the grading queue.

```bash
npm install
cp .env.local.example .env.local   # then paste your keys into it
npm run dev
# → http://localhost:3000
```

Costs money when live: Flora authorizes one generation per clip; Lamp authorizes two
video generations, two holistic Gemini evaluation calls, and at most one
SyncNet-triggered Lipsync-2-Pro repair per clip. Single and batch
confirmations show the selected method's complete estimate before starting, and the top
bar tracks journaled actual spend. In local development, videos, evaluations, prompts,
execution state, and grading drafts persist under the gitignored `data/` store.
In a deployed environment they persist to the configured Blob + Postgres storage.

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
   reconnect the project. Existing public run media can still be read through Lamp's gated
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
     image/video models), `SYNCNET_BASE_URL`, `REPLICATE_API_TOKEN`, and
     `ANTHROPIC_API_KEY` (Claude judge). Keep these out of Preview
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
reload, Lamp can discover the deterministic private object and finish ingest without
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

- **Uploads and run identity:** each upload receives a stable run id and is finalized
  into durable media storage before paid work begins. A run skeleton is written to the server
  before analysis. On reload Create checks the finalization receipt for interrupted-looking
  items, so a completed ingest is recovered even if its response was lost. Bytes that were
  only partway through a browser-to-Blob transfer must be sent again; completed uploads and
  prepared run records survive.
- **Run and batch state:** the browser hydrates from paginated server history, while
  live execution truth is stored separately in revisioned `RunExecution` and
  `BatchExecution` records. Both Flora and Lamp batches retain immutable method,
  membership, reservation, and concurrency plans. The UI only accepts non-regressing
  revisions. Canonical source facts, exact prompts,
  spend approval, provider operations, evaluations, and final human grades are protected by
  atomic server updates. A stale browser snapshot cannot move a live execution backwards,
  alter its budget, or erase it. A deleted run id is permanently tombstoned. Normal deletion
  is refused while an execution, Batch membership, or provider journal is active or
  needs reconciliation; a prepared upload with no paid work remains deletable.
- **Human grading:** `/grade` restores and autosaves a revisioned grading draft through
  `/api/grade-drafts`. Compare-and-swap revisions prevent an older tab from silently
  overwriting a newer draft. Final submission also uses compare-and-swap, so a stale grader
  receives a conflict instead of replacing the latest grade. Before that save, normal run
  projections clear Final's AI scores. Grade offers a deliberate, read-only reveal of the
  already-journaled evaluation without rerunning a provider; otherwise it remains hidden.
  The successful grade response materializes the canonical final evaluation for comparison
  across Results, Review, and Journey. A completed video reconstructed
  from the server provider journal remains gradeable even if later browser-side frame/judge
  work failed; the displayed URL and accepted grade refer to that exact journaled artifact.
- **Potentially paid calls:** each selected method receives a server-issued spend approval
  priced from the durable, server-probed ingest—not browser duration or URL metadata.
  Flora authorizes one generation; Lamp authorizes exactly two generations and two
  holistic Gemini evaluations. Every action has a stable
  operation id and durable claim. Completed responses are replayed from the journal; an
  in-flight or ambiguous result fails closed and must be reconciled rather than automatically
  repeating a potentially billed request. If approval expires before an unclaimed later
  operation, the execution pauses in `user_action_required`. Renewing the same exact plan
  requeues the same execution and prompt; completed journals are reused without rebilling.
  Paused runs remain protected from deletion.
- **Durable Lamp runs:** after server-side spend authorization and an atomic operation claim,
  a `RunExecution` Workflow owns initial generation, original-audio remux and verification,
  initial holistic evaluation, correction-prompt compilation, final generation, final audio
  verification, final holistic evaluation, journal settlement, and transition to human
  review. Exact prompts and evaluation artifacts are frozen into durable state. A provider
  handle is never recreated merely because polling or a deployment was interrupted;
  ambiguous work remains reserved and enters reconciliation instead. Recovery polling can
  continue for up to seven days after the initiating tab closes.
- **Durable live batches:** the parent Workflow owns a bounded queue with immutable
  membership, method, concurrency, and integer-microdollar reservations. Flora children
  retain the established one-cut contract. Lamp children run the same exact two-pass
  Workflow as singles, including both audio checks and holistic evaluations. Completed
  operation journals settle actual spend; ambiguous provider work stays reserved and
  enters reconciliation instead of being repeated.

Lamp deliberately replaces the older open-ended graph with a fixed two-pass method. The
initial and final artifacts each receive one holistic AI evaluation across eight applicable
visual checks plus deterministic audio verification. Only the final artifact is presented as
the shipped grading target. No manifest, Look Anchor, anchor-match score, temporal-alignment
score, Claude second judge, pass-gate loop, best-of selection, or fallback is implied. A live
single run no longer depends on an open tab; its durable result is ready for grading, safely
failed before spend, or explicitly waiting for reconciliation.

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
upload flow uses the mock adapters. The badge in the top bar is not decoration. Scripted
videos, critiques, scores, and deterministic-check results are simulations; they do not
measure generated pixels and must not be used to judge model quality. Use mock mode only to
exercise Lamp's two-pass product flow and persistence without spend.

- The first simulated artifact represents the initial mega-prompt generation.
- One simulated holistic critique produces the correction prompt.
- The second simulated artifact is always the final grading target.
- Human grading and AI comparison use the same UI as live mode, but all AI-side evidence is
  clearly labeled simulated.
- In an environment without the API routes, uploads never leave the browser tab: they become
  object URLs and frames are extracted with a local `<canvas>`. With the dev server running,
  uploads persist to `data/runs/<id>/` via `/api/ingest` exactly as in live mode.

## Glossary — plain term ↔ technical term

The UI speaks plain English; the code, prompts, and this README's deeper sections use
the technical vocabulary. Same concepts, one mapping:

| Plain term (what the UI says) | Technical term (what the code says) |
| --- | --- |
| AI score | composite of the applicable evaluation results |
| Initial video | iteration 1 / initial mega-prompt generation |
| Final video | iteration 2 / corrected mega-prompt generation |
| the checks | evals (`EVAL_DEFS`) |
| Generation brief | mega prompt (`MegaPrompt`) |
| Corrections | changes compiled from the first holistic critique |
| Original audio restored | audio remux (bit-exact stream-copy of the ingest audio) |
| needs your review | `awaiting-review` run status |
| Compare with AI | per-check human score versus final AI evaluation |

## Page map

| Route | What it is |
| --- | --- |
| `/` | Create — select Flora or Lamp, then upload one clip or prepare a batch |
| `/library` | The Library — browse every past generation with progressive disclosure |
| `/grade` | Grade — select any finished final cut, score the full human rubric, and optionally reveal its already-saved AI evaluation |
| `/pipeline` | The selected Flora/Lamp Method graph and live run status |
| `/batch` | Flora and Lamp batch progress, spend settlement, and recovery |
| `/prompts` | Prompt library — the base prompt, manifest extractor, all 11 eval rubrics, mega-prompt compiler |
| `/runs/[id]` | Initial/final review — both videos, holistic evals, prompt diff, and review actions |

## Repo map

| Path | Role |
| --- | --- |
| `lib/types.ts` | **The contract.** Every module is written against these types; read this first |
| `lib/util.ts` | Small shared helpers (ids, clamps, formatting, verdict math) |
| `lib/cost.ts` | Cost governance: placeholder `PRICE_TABLE`, est.-live-cost estimators, `formatUsd` |
| `lib/prompts/` | Base prompt, the 11 canonical eval definitions, and the mega-prompt compiler |
| `lib/lamp-evaluation.ts` | Lamp's applicable-eval set, holistic result validation, and correction-prompt compilation |
| `lib/providers/` | Client-safe live/mock adapters for video generation, image generation, and judges |
| `lib/mock/` | The scripted no-keys fallback scenario: per-iteration outcomes, synthetic sample video, mock scene manifest (no UI entry points) |
| `lib/engine.ts` | Browser mock workflow support; live Lamp execution is server-owned |
| `lib/workflow-def.ts` | Lamp graph plus mode-based workflow selection |
| `lib/flora-workflow-def.ts` | Preserved Flora graph and run configuration |
| `lib/frames.ts` | Client-side frame probing/extraction via canvas |
| `lib/store.ts` | Zustand UI/read cache plus the mock-only in-tab batch worker queue |
| `lib/persist.ts` | Browser-to-server run/batch synchronization and retry status |
| `lib/server/storage/` | Local fs or hosted Blob + Postgres persistence drivers |
| `workflows/` | Durable Flora/Lamp runs, dual-mode batch coordination, video finalization, and provider-free Workflow probe |
| `app/api/grade-drafts/` | Revision-checked blind-grading working memory |
| `components/ui.tsx` | Shared UI primitives (cards, badges, meters) |
| `ARCHITECTURE.md` | The full design: pipeline tiers, structural guarantees, eval methodology, loop control |

## The Library

`/library` reads the active storage backend: `data/runs/<runId>/` locally, or Blob +
Postgres when deployed. It shows every persisted generation, newest first, with a
one-line stats strip (total generations, review counts, final AI scores, actual + estimated
spend) and filters (clip search, status chips, live-vs-simulated toggle, sort). Lamp rows
disclose the initial and final videos, the correction prompt derived from the initial
critique, and the available final evaluation results. The temporal-alignment row is marked
unavailable; anchor matching is omitted because it is not part of Lamp's rubric.
Simulated runs are always badged, older Flora records remain readable, and records missing
relit files fall back to the original thumbnail.

## Batch status

Create accepts multiple clips for either method. The server freezes one immutable
`BatchExecution` before dispatch, reserves each admitted member's full worst-case
cost allowance, and runs at most two children concurrently. Flora reserves a
conservative one-cut amount that covers video, input, and thinking usage.
Lamp separately reserves two generations plus two holistic evaluations per member;
it never reuses Flora's smaller reservation. Each Lamp member keeps its own Initial,
Final, evaluation journals, human grade, and per-check AI comparison. Closing
the browser does not pause the queue, and a lost response may enqueue only a
non-paid contender—not duplicate provider work.

## Cost governance

The standing rule is "always know what is being spent." `lib/cost.ts` is the single source
of price truth, and every paid call routes through a durable approval and operation journal.

- **The price table is verified-or-flagged.** Each rate in `PRICE_TABLE` carries a `verified`
  flag and verification date. Lamp's estimate uses two Omni video generations, two Gemini
  holistic evaluation calls, and local ffmpeg work. Any unverified rate must be checked
  against the provider's primary pricing docs before it is trusted.
- **Estimates are shown everywhere *before* actions.** The estimators are driven by the real
  Lamp contract: exactly two generations and two holistic evaluations. The single-run spend
  confirmation, run review, and session summary show the estimated live cost up front. In
  mock mode nothing costs money, so every figure is an **est. live cost** and is labeled
  estimated rather than actual.
- **Every run keeps a cost ledger.** `Run.cost` records a pre-flight `estimatedUsd` plus one
  item per provider call as the engine executes; the run log closes with an
  "Est. live cost for this run" line. In mock mode all items are `estimated: true` and
  `actualUsd` stays $0.
- **Approvals match the selected method.** Flora grants cover one generation. Lamp grants
  cover both video generations and both holistic evaluations before dispatch. Batch grants
  are also bound to the immutable batch id and per-member reservation; a Flora reservation
  can never authorize Lamp's larger two-pass plan.
- **In live mode, confirmed actuals come from server journals.** Completed holistic-evaluation
  and video operations materialize their recorded costs into the displayed ledger after an
  interruption; a browser snapshot cannot forge or erase those confirmed items.
  An operation sealed as `reconcile_required` may have charged upstream but has no confirmed
  result or cost yet, so the confirmed numeric actual can be a lower bound until manual
  reconciliation.

## Live API boundaries

Live and mock implementations share the interfaces in `lib/types.ts`; provider secrets and
media plumbing stay on server routes:

1. **Generation:** the Omni video model receives the original video and the exact Lamp mega
   prompt. Iteration 1 uses the initial prompt; iteration 2 uses the one correction prompt
   compiled from the first holistic evaluation. No Look Anchor is created or supplied.
2. **Holistic evaluation:** one Gemini call evaluates all eight applicable visual rubrics for
   each generated video. The server validates that the response contains the complete
   applicable set. Original-audio integrity is recorded separately from deterministic media
   verification. Temporal alignment remains unavailable; anchor matching is not part of
   Lamp's rubric because Lamp has no Look Anchor.
3. **Server media service:** ffmpeg handles ingest probing/trimming, audio demux/remux,
   generated-video inspection, verification, and exports. `ffmpeg-static` is traced into
   hosted functions; local development may use the installed binary.
4. **Paid-operation boundary:** all configured live provider calls require server-issued
   approval and atomically claim a stable operation id. Ambiguous outcomes are sealed for
   reconciliation; the app never assumes that an HTTP error means a paid request is safe to
   repeat.
5. **Human calibration:** the grader scores the final video with the journaled AI evidence
   hidden by default. An explicit control can reveal that saved evidence without a new
   provider call. After submission, Results compares the human scores with it per video and
   per check; unavailable AI rows stay unavailable.
6. `/api/live/health` selects live mode when the generation provider is configured and
   reports the broader evaluation capability separately. That selection is a configuration
   fact, not proof that any provider/model is functional in the current deployment.

The eval registry, mega-prompt compiler, and UI share contracts across live and mock modes.
Vercel Workflow owns live Flora and Lamp runs plus their batch queues; the Zustand/browser
engine is mock-only.

## Honest limitations

This is an internal, still-hardening tool. The *methodology* (eval design, prompt
compilation, fixed two-pass correction, and human calibration) is production thinking; the
*measurements* in mock mode are scripted. Any guarantee shown while mock mode is active depicts what the real checks should
enforce, not a pixel measurement. Lamp does not currently produce an AI temporal-alignment
score or anchor-match score, and it does not use a second judge, iterative pass gate, best-of
selection, or fallback. This implementation session did not run a
paid provider artifact round trip. A configured key, passing build, or provider-free Workflow
smoke must not be described as proof that the live two-pass path works end to end.
