# Server-side media + persistence

In local development everything lives under `<repo>/data/` — **gitignored,
safe to delete to reset** (the next upload recreates it). Hosted deployments use
a private Blob store for media and Postgres for records; they must never fall
back to this local directory.

```
data/
  uploads/                 transient ingest staging (cleaned per request)
  batches.json             Batch[] (monotonic merges via PUT /api/batches)
  batch-executions/        revisioned server-owned live batch state
  run-executions/          revisioned server-owned live first-cut state
  grade-drafts.json        revisioned human-grading working memory
  index.json               light run summaries {id, status, createdAt, label}
  runs/<runId>/
    run.json               full Run JSON
    paid-operations.json   exact-once paid-call claims/results
    source.mp4             ingested (possibly trimmed) upload
    source-audio.m4a       demuxed original audio (+ sha256 returned at ingest)
    gen-vN.mp4             iteration N generated video
    relit-vN.mp4           iteration N relit/remuxed video
    anchor-vN.png          iteration N look-anchor still
```

**Persistence contract.** The Zustand store is a browser read cache and the
execution owner only for no-spend mock runs. Browser `PUT /api/runs` and
`PUT /api/batches` preserve prototype/upload state but cannot overwrite canonical
source facts, server approvals, provider journals, execution records, or final
human grades. Live first cuts use compare-and-swap `RunExecution` records; live
batches use compare-and-swap `BatchExecution` records with immutable membership,
prompt, concurrency, and budget. `GET /api/runs` returns paginated runs plus
batches and first-page execution summaries for refresh recovery. Media files are
**written server-side only** (ingest + generation download); the client only ever
references them by `/api/media/...` URL. Local JSON writes are atomic (tmp +
rename); hosted records use Postgres transactions/CAS. Google deletes generated
files from its servers after a limited retention window, so every successful
generation is downloaded into durable media storage before it becomes gradeable.

**Trim policy.** Omni Flash caps input at `MAX_GEN_SECONDS = 10`. Uploads
longer than that are re-encode trimmed (h264/aac, frame-accurate — stream-copy
trims cut on keyframes and can overshoot) to the first
`TRIM_TARGET_SECONDS = 9.9` seconds. Ingest responds with `trimmed: true` and
`originalDurationSec` so the UI can surface it.

**Range serving.** `GET /api/media/<...path>` is gate-authenticated and uses a
strict traversal guard (sanitized `[a-z0-9_-]` run ids, no `..`, no absolute
segments). Local files stream directly; hosted private objects stream through
authenticated `@vercel/blob` `get()` calls. Both paths preserve single Range
requests (206 + `Content-Range` + `Accept-Ranges`) so `<video>` seeking works.
Responses use `private, no-cache`, revalidating access instead of exposing or
redirecting to provider URLs. Legacy public-store entries remain readable
through the same proxy during migration.
