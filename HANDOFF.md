# HANDOFF — Lamp unified studio

Updated 2026-07-18 for the `codex/lamp-unification` integration branch. Read
`README.md` for operator setup, `ARCHITECTURE.md` for the current technical
boundaries, and `LAMP-UNIFICATION-BRIEF.md` for the original product brief and
decision history.

## Current product

This is one internal relight studio with five selectable Lamp methods. Lamp is
the default for a new browser. The saved browser preference changes only the
next-run setup. Only an untouched ingest skeleton may be retargeted: no plan,
approval, execution, provider operation, generated iteration, node progress,
review, final artifact, or human grade may exist. After any of those bindings
exists, its `workflowMode` is immutable,
so history, review, grading, costs, and recovery never depend on today's selector.
Legacy Flora records remain readable but Flora cannot start new work.

| Mode | User intent | Controls before generation | Delivery |
| --- | --- | --- | --- |
| Lamp | Source-faithful relight | Relight 0–100 | Fixed Initial → critique → Final |
| Background | Remove approved background clutter | One source-specific cleanup plan | Fixed two-pass Final, or approved exact-source no-op |
| Beautify | Restrained on-camera polish | Approved plan plus level 1–3 | Fixed two-pass Final, or approved exact-source no-op |
| Iris | Improve camera contact | Approved plan plus level 1–3 | Best eligible Initial or Final, or approved exact-source no-op |
| Combined | Apply all enabled concerns in one generation product | Relight 0–100, Beautify off/1–3, cleanliness 1–3, eye contact off/on at Presenter P2 | Up to two qualified candidates; human chooses among eligible takes and blindly grades one exact winner |

Background, Beautify, Iris, and Combined are single-clip workflows. Lamp keeps
the established server-owned batch path. Combined batches are deliberately
rejected: each member would need its own plan, two qualification receipts,
winner choice, and grade binding.

## Combined contract

Combined is not four generated videos chained together. It is one aggregate,
human-approved plan and one frozen prompt product used for exactly two
source-rooted generations:

1. Persist the source, relight intensity, and three Combined controls.
2. Run only the required planners: Background always, Beautify unless off, and
   Iris only when eye contact is on.
3. Reconstruct one aggregate plan from exact completed planner journals and show
   it for one human approval. Approval binds the source, controls, relight value,
   subplans, price snapshot, and worst-case reservation.
4. Generate Take 1 from the immutable original and frozen initial prompt, then
   restore and verify its source-audio binding.
5. Run one complete Combined holistic evaluation of Take 1.
6. Run SyncNet qualification. A failed or unverified Take 1 is ineligible and is
   never repaired.
7. Deterministically select at most 12 corrections: hard-gate failures first,
   then one correction per concern, then remaining findings by stable severity.
8. Generate Take 2 independently from the same original plus the exact frozen
   prompt with only its correction body changed, then restore and verify its
   source-audio binding. It never receives Take 1 pixels or an interaction chain.
9. Run one complete Combined holistic evaluation of Take 2, then run SyncNet
   qualification. It may receive at most one exact Lipsync-2-Pro repair after
   that evaluation; the repaired artifact and its journal become the candidate
   identity, while its AI evaluation continues to describe the pre-repair
   generation.
10. Show both candidates and their eligibility truth on Review. The app never
   auto-picks a winner. A human chooses one eligible take, grades that exact
   artifact with its AI evaluation hidden, and permanently binds the saved grade
   to the candidate iteration and artifact-identity hash.

Disabled optional concerns become explicit preservation hard gates; they are
not silently omitted. Lighting, face zones, background targets, and eyes have
separate region ownership so one concern cannot borrow another concern's edit
permission.

## Safety and spend laws

- **Source-rooted only:** every generation conditions on the original video.
- **Freeze prompt bytes first:** shipped prompt formats are persisted contracts.
  Add a legacy parser/frozen renderer before changing old prompt bytes.
- **Server/read symmetry:** any binding rule added to admission must also be
  enforced by run materialization. Browser state is a cache, never authority.
- **Exact journals:** provider submission, polling, results, evaluations, and
  optional repair use stable operation ids. Completed calls replay; ambiguous
  calls reconcile instead of rebilling.
- **Current approval required:** no paid provider operation starts without a
  non-expired exact grant and matching price snapshot.
- **Estimate before, actual after:** the pre-plan confirmation authorizes only
  the exact required planner calls. For a live Combined run, human aggregate-plan
  approval then atomically mints a separate grant for both generations, both
  evaluations, and at most one Take-2 repair. Confirmed actuals come from
  completed provider journals.
- **Atomicity:** live Combined aggregate approval and generation spend
  authorization use one storage-level compare-and-swap operation. Mock Combined
  persists provider-free approval without a spend grant. Background, Beautify,
  and Iris persist their approved plan and generation grant as separate
  server-owned writes.
- **Node 22 only:** `.nvmrc` and `package.json` are authoritative. Do not test
  with the system Node 18 installation.
- **Never build beside a dev server:** Next dev and build share `.next/` and can
  corrupt one another.

## Persistence and recovery

Local state lives in gitignored `data/`. Hosted state uses private Blob for
media and Postgres for revisioned JSON. `RunExecution`, paid-operation journals,
spend grants, plan approvals, grades, and grading drafts are server-owned.

The Grade workspace autosaves answers plus a Combined candidate selection with
revision compare-and-swap. Returning to bare `/grade` reconstructs the exact
candidate from the durable draft. A deep link such as
`/grade?run=<id>&candidate=1` explicitly overrides an older saved choice and
resets incompatible answers. A successful Combined grade freezes the winner;
later requests cannot swap its iteration or artifact hash.

Combined paid-work replay remains intentionally disabled and fail-closed for
v1. When Workflow is terminal `completed`, the recovery route may perform one
settlement-only repair after revalidating the exact aggregate plan, both
generation/evaluation/audio/SyncNet receipts, and immutable prompt bindings.
Incomplete or mismatched proof is sealed `reconcile_required`; no provider work
is restarted. Every other Combined adoption attempt returns a safe conflict.

Deletion is refused while a run, provider journal, reconciliation, or active
batch membership owns the record. Deleted ids remain tombstoned.

## Consolidated local data

The four pre-unification data roots were checksum-inventoried, copied, and
validated into this worktree's `data/` without modifying the originals:

- 47 runs
- 38 durable run executions
- 2 grading workspaces (`default` and `lamp-slider-calibration-v1`)
- 0 batches
- 0 divergent or identical file collisions

Verified source backups and their per-file SHA-256 manifest live at:

`/Users/justinyarn/Desktop/claude test flora/lamp-unification-backups/lamp-data-2026-07-18T04-53-58-717Z`

The merge script is `scripts/consolidate-lamp-data.mjs`. Dry run is the default;
`--apply` requires a backup root and refuses an existing destination.

## Important code map

| Concern | Canonical path |
| --- | --- |
| Shared contracts | `lib/types.ts` |
| Mode parsing/default/labels | `lib/workflow-mode.ts` |
| Five workflow graphs | `lib/workflow-def.ts` plus the mode-specific `*-workflow-def.ts` files |
| Combined controls, plan, and parser | `lib/lamp-combined.ts` |
| Combined frozen prompts | `lib/prompts/lamp-combined.ts` |
| Combined evaluator/correction ordering | `lib/lamp-combined-evaluation.ts` |
| Candidate receipt and artifact identity | `lib/lamp-combined-candidate.ts` |
| Planner and aggregate approval | `lib/server/lamp-combined-planner.ts`, `lib/server/lamp-combined-approval.ts` |
| Candidate qualification | `lib/server/lamp-combined-candidate-qualification.ts` |
| Runtime execution binding | `lib/server/lamp-combined-execution.ts` |
| Paid orchestration | `workflows/durable-relight-run.ts` |
| Admission/read/grade authority | `app/api/runs/route.ts` |
| Atomic Combined approval | `app/api/combined-plan/approve/route.ts`, `lib/server/storage/lamp-combined-approval.ts` |
| Cost estimates and reservations | `lib/cost.ts` |
| Create controls | `components/shell/WorkflowModeSelector.tsx`, `app/page.tsx` |
| Review and winner choice | `components/review/CombinedPlanReview.tsx`, `components/review/CombinedWinnerPicker.tsx` |
| Blind grade and resume | `components/grade/`, `app/api/grade-drafts/` |
| Safe data consolidation | `scripts/consolidate-lamp-data.mjs` |

## Branch and rollback points

Integration worktree:

`/Users/justinyarn/Desktop/claude test flora/flora-relight-unification`

Integration branch: `codex/lamp-unification`.

Each original branch tip was pushed and tagged before integration:

- `safety-pre-unification-20260717-slider` at `c4e1d8a`
- `safety-pre-unification-20260717-background` at `5c985a6`
- `safety-pre-unification-20260717-beautify` at `e103d74`
- `safety-pre-unification-20260717-iris` at `fb9abea`

The original worktrees and their data roots remain intact.

## Validation and release sequence

Run with Node 22:

```bash
nvm use
npm test
npx tsc --noEmit --pretty false
npm run build
```

The July 18 local release gate passes 288/288 provider-free tests, TypeScript,
lint with zero warnings, and the 19-page production build on Node 22. Hands-on
browser QA covered all five Create modes, the consolidated 47-run history,
Grade/Results, Rubrics, Engine, and a zero-key Combined rehearsal through plan
approval, both preview takes, comparison, the preview-only grading guard, and
reload resume. Paid mode smokes, hosted readiness/Workflow smoke, and exact-
commit deployment remain release gates. Passing tests or configured keys are
not provider verification.

Release order:

1. Finish production build with no dev server running.
2. Run provider-free UI checks for all five modes, including Combined draft
   approval, candidate comparison, winner-only grading, reload resume, history,
   and disabled batch/recovery behavior.
3. Commit the exact tested tree.
4. Immediately before any paid smoke, show the current estimate. Run modes
   sequentially and stop on the first failure; record journaled actuals.
5. Deploy that exact tested commit—no opportunistic edits between test and push.
6. Verify the deployed Git SHA, readiness, private storage, Workflow smoke, and
   gated internal access.

## Honest limitations

- Combined has not yet completed a paid provider artifact round trip in this
  unification branch.
- Combined batch execution is unsupported and rejected explicitly.
- Combined automatic provider replay/restart is intentionally unsupported.
  A terminal completed Workflow may repair settlement from exact saved proof
  only; every other recovery case fails closed without replaying providers.
- Mock Combined candidates are preview-only. They cannot produce a trusted human
  grade because they have no provider artifact, audio, SyncNet, or evaluation
  receipt.
- Simulated Initial and Final artifacts in the other mock modes also stay out of
  the blind Grade workspace and use ordinary Review. An approved exact-source
  no-op is the provider-free grading exception.
- This is an internal tool behind an access gate, not a public product surface.
