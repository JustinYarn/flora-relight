# HANDOFF — Flora + Lamp relight workspace

Written 2026-07-14 for whoever picks up this branch next. Read `README.md` for
product and operator instructions and `ARCHITECTURE.md` for the older Flora
design rationale. This file records the dual-mode Flora/Lamp release contract.

## Current state (2026-07-14)

- **Branch and product name:** the release lives on
  `codex/flora-prompt-map-ux` and presents **Flora + Lamp** as one workspace.
  The repo, deployed project, API paths, persisted records, and environment
  variables keep their existing `flora` / `FLORA_` names for compatibility.
- **Scope:** Create has a persistent method selector. Flora keeps the established
  one-cut live workflow; Lamp runs its exact two-pass method. Both methods accept
  one video or a server-owned batch. Every run and batch persists `workflowMode`;
  missing mode means legacy Flora.
- **Provider truth:** the app has live generation and Gemini-evaluation seams,
  but configured keys are not evidence that a deployment works. No paid provider
  artifact round trip was run during this Lamp implementation session. Do not
  describe the live two-pass path as verified until an explicitly approved test
  completes submission, polling, download, audio remux/verification, both
  evaluations, and final artifact materialization on the target deployment.
- **Local persistence:** every run writes to `data/runs/<runId>/` (`run.json`
  plus source audio/video and generated artifacts). `data/` is gitignored and is
  the local artifact of record. Hosted runs use private Blob + Postgres.
- **Secrets:** provider keys remain in `.env.local` (gitignored). Never echo or
  commit them, and never infer permission for a paid call from their presence.

## The Lamp method

Every new live Lamp run follows the same fixed sequence:

1. Freeze the initial mega prompt and generate **Initial** (iteration 1) from the
   original source video.
2. Restore and verify the original audio.
3. Send the generated video to one holistic Gemini evaluation call covering all
   eight applicable visual checks:
   `identity-preservation`, `skin-texture-age`, `appearance-fidelity`,
   `background-fidelity`, `lighting-quality-delta`, `motion-lipsync`,
   `temporal-stability`, and `hallucination-artifacts`.
4. Record deterministic `audio-integrity` alongside those visual results.
5. Compile exactly one correction mega prompt from the Initial critique.
6. Generate **Final** (iteration 2) from the original source video and corrected
   prompt, then restore and verify the original audio again.
7. Run one final holistic Gemini evaluation across the same eight applicable
   visual checks and record deterministic audio integrity.
8. Present Final for human grading with the completed AI evaluation hidden by
   default. The grader may explicitly reveal that saved evaluation at any time;
   after submission, compare it with the human score for that video, per check.

Final is always the grading target; Lamp does not choose a best-scoring attempt or
loop again. It does not create a manifest or Look Anchor, run a Claude second
judge, gate on a pass threshold, or invoke a fallback.

The canonical human rubric still has 11 rows. Two AI rows intentionally have no
score:

- `temporal-alignment` is **unavailable** because the deterministic live
  correlation metric is not implemented.
- `lighting-match-to-anchor` is **inapplicable** because Lamp has no Look Anchor.

The Grade Results view must preserve those truth boundaries instead of converting
missing results to zero or presenting invented agreement.

## Durability and recovery boundary

- **Upload identity:** each upload receives a stable run id. The browser writes a
  server run skeleton before analysis and can recover a completed ingest receipt
  after a lost response. A partially streamed browser-to-Blob upload still needs
  retransmission; a finalized upload survives reload.
- **Canonical execution:** a revisioned `RunExecution` owns the exact source,
  persisted Initial-prompt bytes, iteration, phase, spend approval, and
  provider-operation bindings. Canonical evaluation 1 deterministically patches
  only the version header and correction section of those persisted bytes; the
  v2 provider journal binds that exact Final prompt across deploys. Browser state
  is a read cache and cannot move execution backwards or replace server evidence.
- **Potentially paid work:** Lamp approval covers exactly two generations and two
  holistic evaluations. Every call has a stable operation id and durable claim.
  Completed results replay from the journal. In-flight or ambiguous outcomes fail
  closed into reconciliation; do not automatically repeat a potentially billed
  request.
- **Approval renewal:** if an exact Lamp grant expires before a later operation is
  claimed, the execution enters `user_action_required`. A fresh exact grant CAS-
  requeues the same execution id and prompt; completed provider journals replay as
  cache hits, and the paused run remains deletion-protected.
- **Workflow ownership:** Vercel Workflow owns provider submission, non-billed
  polling, artifact download, original-audio remux, media verification, both
  holistic evaluations, prompt correction, settlement, and transition to review.
  Closing the browser does not stop an admitted run. Recovery polling may continue
  for up to seven days.
- **Human grading:** `/grade` restores and autosaves a revisioned draft through
  `/api/grade-drafts`. Draft and final submission use compare-and-swap revisions,
  so a stale tab receives a conflict instead of overwriting newer work. The
  journaled Final artifact and final AI evaluation are the comparison target.
  Normal run reads explicitly clear Final's AI projection. An exact-run,
  no-store reveal request can expose that already-saved evidence inside Grade
  without rerunning a provider. A successful human-grade save remains the reveal
  boundary for Review, Journey, Results, and share/read surfaces.
- **Deletion:** deleted run ids are tombstoned. Normal deletion is refused while
  an execution, batch membership, or provider journal is active or needs
  reconciliation.
- **Dual-mode batches:** the immutable parent plan records the selected method,
  ordered membership, concurrency, and per-member reservation. Flora approvals
  remain one-cut. Lamp members reserve and execute the complete two-generation,
  two-evaluation plan. The parent enqueues child Workflows and settles only
  journaled actuals; ambiguous provider work remains reserved for reconciliation.

## Where everything lives

| What | Where |
| --- | --- |
| Repo (local) | `~/Desktop/claude test flora/flora-relight` |
| Core contract | `lib/types.ts` |
| Canonical 11 eval rubrics | `lib/prompts/eval-defs.ts` |
| Lamp eval set + correction compiler | `lib/lamp-evaluation.ts` |
| Lamp server evaluator | `lib/server/lamp-evaluator.ts` |
| Lamp mega prompts | `lib/prompts/mega-prompt.ts` |
| Cost rates and fixed two-pass estimator | `lib/cost.ts` |
| Durable live run owner | `workflows/durable-relight-run.ts` |
| Run admission/recovery | `lib/server/run-execution-coordinator.ts`, `app/api/runs/recover/` |
| Exact-once paid journal | `lib/server/paid-operation.ts`, `lib/server/storage/` |
| Storage drivers (fs or Blob + Postgres) | `lib/server/storage/` |
| Run artifacts | `data/runs/<runId>/` locally; Blob + Postgres when hosted |
| Blind grading and comparison | `app/grade/`, `components/grade/`, `app/api/grade-drafts/` |
| Provider-free Workflow probe | `workflows/durability-smoke.ts`, `app/api/debug/workflow/` |
| Dual-mode batch owner | `workflows/durable-relight-batch.ts`, `lib/server/batch-execution-coordinator.ts`, `lib/server/batch-contract.ts` |

## Run locally

```bash
cd "~/Desktop/claude test flora/flora-relight"
nvm use          # .nvmrc pins Node 22
npm install
npm run dev      # http://localhost:3000
```

ffmpeg must be on `PATH` (`brew install ffmpeg`). Start the dev server with the
project directory as its working directory or Tailwind and `data/` paths break.
Keys in `.env.local` change provider readiness; their presence does not prove a
functional artifact round trip.

## Deploy and verify without providers

The Vercel project remains `flora-relight` under `justin-5763s-projects`:

```bash
vercel link
vercel deploy --prod
```

Keep the established environment-variable names:

- `FLORA_ACCESS_PASSWORD`
- `FLORA_BLOB_ACCESS=private`
- `BLOB_READ_WRITE_TOKEN`
- `DATABASE_URL`
- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY` (legacy/other evaluation paths; Lamp's holistic evaluator is
  Gemini-only)
- `FLORA_WORKFLOW_SMOKE_ENABLED` (temporary provider-free probe flag)
- `FLORA_FFMPEG_DEBUG_ENABLED` (temporary diagnostics only)

Hosted Preview and Production fail closed unless private Blob, Postgres, ffmpeg,
and the access policy are configured. The access password must be at least 20
characters with no surrounding whitespace; use a random 32+ character value and
protect `/api/gate` with Deployment Protection or an edge/WAF rate limit. Keep
`/.well-known/workflow/*` outside the human password middleware because Vercel's
internal Workflow queue must reach it.

`GET /api/readiness` performs private Blob and database write/read/delete probes
plus an ffmpeg check. It calls no AI provider and uploads no user media. After a
Workflow change, temporarily enable `FLORA_WORKFLOW_SMOKE_ENABLED=1`, redeploy,
and run the signed-in probe documented in README. It verifies the Workflow control
plane, private storage, writable scratch, and a synthetic ffmpeg
encode/demux/remux/probe. Remove the flag and redeploy immediately afterward.

Neither readiness nor the Workflow smoke proves Lamp's paid provider path.

## Next work (priority order)

1. Finish local automated validation with Node 22: tests, lint, typecheck, and a
   production build. Exercise the UI with mock/provider-free data, including
   Initial/Final switching, hidden-by-default grading, optional AI reveal,
   final-AI comparison, and the two missing
   AI rows.
2. Deploy the exact branch SHA to a protected environment and run readiness plus
   the provider-free Workflow smoke. Record the source SHA and results.
3. Only with explicit authorization, run one non-sensitive short clip through the
   live two-pass path. Confirm exactly two generations and two holistic evaluations,
   original-audio verification both times, reload recovery, durable Final selection,
   independent grading, optional AI reveal, final-AI comparison, and journaled cost.
4. Calibrate the eight visual rubrics using accumulated human-versus-final-AI
   disagreements. Do not hide missing temporal-alignment or anchor-match evidence.
5. Run an explicitly approved small Lamp batch after the single-video round trip.
   Confirm per-member two-pass journals, hidden-by-default AI evidence, bounded concurrency,
   budget skips, reload recovery, and final batch settlement.

## Cost and approval truth

`lib/cost.ts` is the source of truth. A Lamp estimate is the sum of two Omni
video-to-video generations, two Gemini holistic evaluation calls, and local ffmpeg
work. Show that complete estimate and obtain confirmation before any paid call.
Completed actuals come from the server journal; `reconcile_required` may represent
an unknown upstream charge and must stay visibly unresolved. Never treat a browser
estimate, configured key, green build, readiness probe, or provider-free smoke as
permission or evidence for a paid provider round trip.
