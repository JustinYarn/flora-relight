# Server-side media + persistence

Everything lives under `<repo>/data/` — **gitignored, safe to delete to reset**
(next upload recreates it).

```
data/
  uploads/                 transient ingest staging (cleaned per request)
  batches.json             Batch[] (whole-array writes via PUT /api/batches)
  index.json               light run summaries {id, status, createdAt, label}
  runs/<runId>/
    run.json               full Run JSON
    source.mp4             ingested (possibly trimmed) upload
    source-audio.m4a       demuxed original audio (+ sha256 returned at ingest)
    gen-vN.mp4             iteration N generated video
    relit-vN.mp4           iteration N relit/remuxed video
    anchor-vN.png          iteration N look-anchor still
```

**Persistence contract.** The client zustand store stays the source of truth
during a session. After mutations it pushes state here: `PUT /api/runs`
`{ run }` upserts one run's JSON; `PUT /api/batches` `{ batches }` rewrites the
whole batch list. `GET /api/runs` returns `{ runs, batches }` (newest first)
for rehydration after refresh. Media files are **written server-side only**
(ingest + generation download); the client only ever references them by
`/api/media/...` URL. All JSON writes are atomic (tmp + rename). Google
deletes generated files from its servers after ~2 days, so every generation
must be downloaded into the run dir — the `/api/media` URL is the durable one.

**Trim policy.** Omni Flash caps input at `MAX_GEN_SECONDS = 10`. Uploads
longer than that are re-encode trimmed (h264/aac, frame-accurate — stream-copy
trims cut on keyframes and can overshoot) to the first
`TRIM_TARGET_SECONDS = 9.9` seconds. Ingest responds with `trimmed: true` and
`originalDurationSec` so the UI can surface it.

**Range serving.** `GET /api/media/<...path>` serves anything under `data/`
with a strict traversal guard (sanitized `[a-z0-9_-]` run ids, no `..`, no
absolute segments) and full HTTP Range support (206 + `Content-Range` +
`Accept-Ranges`) — `<video>` seeking depends on it. `.json` responses are
`no-store`; media filenames are write-once, so they get a long immutable
cache.
