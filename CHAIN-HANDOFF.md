# Lamp Chain (Combined V2) — build handoff

Written 2026-07-20. **Read `LAMP-CHAIN.md` first** — it is the design/product
document (what Chain is, the laws, cost tables, the ordering-experiment
discussion). This file is the *build state*: what is finished, what is not,
and exactly how to finish it.

A fresh chat with no prior context can work from these two files alone.

---

## 0. TL;DR for the next agent

> **UPDATE 2026-07-20 (later session): THE BUILD IS COMPLETE.** Everything in
> §4.1 and §4.2 below is implemented and committed (`3fb3267`); §4.3 ($0
> verification) is done end-to-end in the browser in mock mode — order picker,
> ChainPlanReview approval, deliver-first proven live (run DELIVERED and
> gradeable at 0/4 measurements; report card attached 0→4 afterwards),
> ChainEvalReport drift deltas, and `/chain-sweep` grouping two order variants
> (H0 vs H2) of one clip with the final-stage matrix. `npx tsc --noEmit`
> clean; `npm test` **304/304**. A code review confirmed and fixed 11 findings
> (4 critical/major: PUT chain-field protection, live-chain read-model
> delivery surfacing, grade-CTA predicate). Mock demo runs persist in `data/`
> (`run_mrtjxj3u` H0, `run_mrtk7cb4` H2). A `combined-v2-mock` launch config
> (provider keys blanked → mock mode, same port 3005) was added beside
> `combined-v2` in the parent `.claude/launch.json`. **Remaining: §4.4 paid
> smoke — blocked on Justin's answers to §6.** Sections below are kept as
> written for spec/reference.

Version 2 ("Lamp Chain") is a new fifth-and-a-half workflow mode where the
original clip enters the pipeline **once** and each enabled concern runs as
its own **single-pass generation over the previous stage's output**. The
finished video is **delivered immediately** on structural proof; **all
evaluation is detached** and attaches afterwards.

**Backend is complete and green. Two pieces remain: the API-route arms in
`app/api/runs/route.ts`, and the UI surfaces.** Both are specced in §4 below.

Current state: `npx tsc --noEmit` → **1 error** (`app/page.tsx:200`,
MODE_COPY missing `chain` — first thing §4.2 fixes). `npm test` → **303/303
pass**, including 16 new chain tests.

---

## 1. Environment

| Thing | Value |
| --- | --- |
| Worktree | `/Users/justinyarn/Desktop/claude test flora/flora-relight-combined-v2` |
| Branch | `codex/lamp-combined-v2` (branched from `codex/lamp-unification` @ `5e352e0`) |
| Dev server | launch config **`combined-v2`**, port **3005** (`.claude/launch.json` at the parent dir) |
| Node | 22 via nvm (`~/.nvm/versions/node/v22.23.0/bin/node`) — system PATH has 18, which breaks |
| Typecheck | `npx tsc --noEmit` (there is **no** `tsc` npm script; type-checking otherwise rides `next build`) |
| Tests | `npm test` (node:test + `--experimental-strip-types` over `tests/*.test.ts`) |
| Secrets | `.env.local` already copied into this worktree. **Never echo it.** |

**⚠ The work is currently UNCOMMITTED** (see `git status`). Nothing has been
pushed. If you want a clean restore point before continuing:

```
git add -A && git commit -m "feat: Lamp Chain (Combined V2) backend + sweep board"
```

**Ops laws** (learned expensively, see `LAMP-UNIFICATION-BRIEF.md` §9):
never `npm run build` while a dev server runs (shared `.next/` corrupts);
the worktree path contains a space (node-gyp breaks on it); new native/wasm
server deps must join `serverExternalPackages` in `next.config.mjs`.

**Parallel-session etiquette:** sibling worktrees exist for the other
branches. `flora-relight-unification` had a live session editing it on
07-20 — do not touch it. One builder per worktree.

---

## 2. What Chain is (30-second version)

```
upload → controls (relight 0–100, cleanliness 1–3, beautify off/1–3,
         eye contact on/off) + STAGE ORDER picker
       → enabled planners run once against the ORIGINAL (~$0.01–0.04)
       → ONE plan review (subplans + order strip + ConfirmSpend)
       → stage 1 (from source) → stage 2 (from stage 1's cut) → … → stage N
       → DELIVERED (awaiting_review; gradeable immediately, zero evals needed)
       → detached report card: per stage, one holistic judge call vs the
         ORIGINAL + SyncNet/luma/gaze, attaching as each lands
```

Three decisions that are settled — **do not relitigate**:

1. **Chain suspends the regenerate-from-original law on purpose.** That is
   the experiment. Every other structural law (original-audio remux + hash
   per stage, frozen prompts, exact paid journals, one human spend gate)
   still holds. See `LAMP-CHAIN.md` §2.
2. **Stage prompts are byte-identical to their standalone modes** (verified
   by test). Only the Background stage appends one marked
   `[CHAIN CLEANLINESS DIRECTIVE]` block, because cleanliness has no
   standalone expression. Chaining is therefore the *only* variable.
3. **Chain is a sibling orchestrator, not a stretch of Combined.** Combined
   hard-codes exactly-two-generations in ~15 places (types, op-ids, settle,
   UI). Chain got its own durable branch, receipts, and failure recorder.

---

## 3. What is DONE (all green)

### Domain (pure, no server deps)
| File | Contains |
| --- | --- |
| `lib/lamp-chain.ts` | `LampChainPlan` (`{version, stageOrder, aggregate: LampCombinedPlan}`), `LampChainControls` (Combined triple + `stageOrder`), build/parse/approve/hash, `assertLampChainPlanBinding`, `lampChainEnabledStages`, `lampChainConcernsAfterStage`, `lampChainDeliveryIneligibility` |
| `lib/lamp-chain-operations.ts` | `plan:lamp-chain:{concern}:gemini`, `judge:{stage}:lamp-chain-holistic:gemini` |
| `lib/lamp-chain-evaluation.ts` | Detached eval contracts. Reuses Combined's 11 eval ids/weights/thresholds **on purpose** (final-stage artifact is rubric-identical to a V1 Combined eval → directly comparable). Adds the *pending-concern* rule: an enabled-but-not-yet-executed concern judges as a **hard preservation gate**. `buildLampChainEvaluationArtifact`, `parseLampChainEvaluationArtifact`, `lampChainEvalDefinitions(plan, stage)`, `lampChainStageComposite` |
| `lib/lamp-chain-candidate.ts` | `LampChainStageReceipt` = generation proof + audio qualification **only** (no eval, no sync, no repair — evals are detached). Builder throws on unverified audio. |
| `lib/prompts/lamp-chain.ts` | `compileLampChainStagePrompts`, the frozen `LampChainPromptEnvelope` (lineage `lamp-chain-stage-prompt-v1`), byte-validating parser |
| `lib/chain-workflow-def.ts` | `CHAIN_WORKFLOW` graph (plan → stage 1–4 → deliver → detached report) |

### Server
| File | Contains |
| --- | --- |
| `lib/server/lamp-chain-planner.ts` | `prepareLampChainPlan`, `createMockLampChainPlan`, `assertLampChainPlannerJournals` |
| `lib/server/lamp-chain-approval.ts` | `approveLampChainPlanForRun` (plan-mode CAS persistence pattern, not Combined's atomic driver method) |
| `lib/server/lamp-chain-evaluator.ts` | `runLampChainStageEvaluation` — judges stage N's output **against the ORIGINAL**; meters (luma/gaze/SyncNet) collected **before** the paid claim (canonical-input law); SyncNet failure → `undefined` + warn, never a gate |
| `lib/server/lamp-chain-source.ts` | `prepareLampChainStageStart(runId, stage)` — **the chaining mechanism.** Stage 1 = canonical original (also seeds the immutable `source.mp4`/`source-audio.m4a` so audio law holds for the whole chain); stage N>1 uploads `relit-v{N-1}.mp4` |

### Shared-file edits (chain arms added)
- `lib/types.ts` — `WorkflowMode` += `"chain"`; scopes += `chain_plan` / `chain_sequence`; `Run.chainControls`, `Run.chainPlan`; `RunExecution.chainStageReceipts`
- `lib/workflow-mode.ts` — `LAMP_CHAIN_EXECUTION_PREFIX = "lamp-chain:"`, parse/labels/`workflowModeFromExecutionId`/`isLampChainExecutionId`
- `lib/cost.ts` — `estimateLampChainPlan`, `estimateLampChainSequence`, `lampChainStageCount`, reservations (no Lipsync line, ever)
- `lib/server/spend-approval.ts` — both scopes through all six enforcement points; `chain_sequence.maxIterations` = **stage count** (2–4, not 2); authorizes N generations + N stage evals and **explicitly refuses a Lipsync repair**; `hasReusableLampChain{,Plan}Approval`
- `lib/server/storage/run-execution.ts` — chain identity invariants, receipt contiguity/immutability, delivery requires the **full** receipt trail
- `lib/server/run-execution-coordinator.ts` — chain single-run guard, plan-binding validation (incl. envelope byte-validation), both approval ladders, and `repairCompletedRunExecution` **returns early for chain** (the workflow owns its own settlement repair)
- `lib/server/run-execution-resume.ts` — all four pause/renew/acknowledge helpers widened to admit chain
- `lib/server/lamp-{background,beautify,iris}-planner.ts` — mode unions widened to `"combined" | "chain"`
- `lib/workflow-def.ts`, `lib/run-factory.ts` — registration + relight binding

### Durable workflow — `workflows/durable-relight-run.ts`
Dispatch fork at `:203`. The orchestrator section starts at `:4020`:
- `durableLampChainRun` — loops stages, then `settleChainExecution`, **then**
  `runChainDetachedEvaluations`. Delivery is committed before any eval runs.
- `enterChainGenerationPhase*` — stage k follows stage k−1's
  `video_generation` phase directly (no `evaluating` phase between stages)
- `prepareChainAttempt` → `prepareLampChainStageStart` (the chained input)
- `appendChainStageReceiptStep` — append-only, contiguous, CAS
- `settleChainExecution` — re-proves every receipt against exact journals +
  frozen stage prompts, then settles
- `runChainDetachedEvaluations` — per-stage failures contained; delivery is
  never revisited
- `recordChainExecutionFailure` — chain-shaped classifier; `chain_completed`
  when every receipt exists (evals are irrelevant to delivery)

Generic iteration-typed helpers were widened `1|2 → number`
(`readGenerationCheckpoint`, `startAttempt`, `assertGenerationOwner`,
`pollAttempt` callers, `settleExecutionRecord`, …). Phase-transition helpers
for the two-pass modes kept their `1|2` types.

### Routes / client / UI (partial)
- `app/api/chain-plan/approve/route.ts` — **done.** Validates, re-asserts
  planner journals, mints `chain_sequence`, enqueues with the serialized
  envelope as `renderedPrompt`. **Deliberately does NOT gate on
  `v2SyncConfigIssue`** (SyncNet is detached measurement for chain).
- `lib/store.ts` — **done.** `chainControls` threaded through `startRun`;
  `approveChainPlan` action (live + mock paths).
- `lib/engine.ts` — **done.** `runLampChainMockWorkflow`: provider-free
  rehearsal that proves the deliver-first ordering (delivery lands, *then*
  the report card attaches per stage).
- `app/chain-sweep/page.tsx` + nav link — **done.** The batch-test surface:
  groups chain runs by clip, one row per order variant, "Run this order"
  launcher (any permutation), per-stage composite chips, final-stage score
  matrix (eval id × order), sweep spend totals.

### Tests — `tests/lamp-chain.test.ts`, `tests/lamp-chain-cost-auth.test.ts`
16 cases: order permutation validation, order-bearing plan hash, binding,
cumulative concerns, delivery eligibility, **byte-parity of stage prompts vs
standalone modes**, envelope freeze/tamper rejection, pending-gate
contracts, drift deltas + replay protection, stage-scoped op ids, cost
scaling, scope authorization (incl. "never a repair"), sequential generation
auth, receipt binding, and storage settle/immutability invariants.

---

## 4. What is NOT done

Two subagents were mid-task when the account hit its usage limit. **Neither
wrote any files** — `app/api/runs/route.ts` is untouched and no chain UI
components exist. Both specs below are complete; follow the Combined
implementation as the template in every case.

### 4.1 API-route arms — `app/api/runs/route.ts` (+ 2 small files)

Mirror the Combined arms exactly; grep `combined` in this file to find each
site. Combined anchors are approximate line numbers at time of writing.

**a. POST — accept and validate `chainControls`** (~:3683-3741 is Combined's
controls block). Parse with `parseLampChainControls`; require
`relightIntensity` for chain as Combined does. Reject
`approveLiveSpend === true` direct-start (chain must go through plan
review). Live-start path requires an existing approved `run.chainPlan` and
`existing.live === true` (~:3826-3840).

**b. `prepareLampChainAggregate` helper** mirroring
`prepareLampCombinedAggregate` (~:545-602): calls `prepareLampChainPlan`
(live) / `createMockLampChainPlan` (mock), persists `run.chainControls` +
`run.chainPlan` + `live`, returns `actualPlannerCostUsd`; response carries
`planReviewRequired` + `costEstimate: estimateLampChainPlan(controls)`. Wire
it at both prepare call sites (~:4123-4144 and ~:4301-4324).

**c. Retarget guards** (~:3930-3955, ~:4045-4052): changing `chainControls`
— **including `stageOrder` array inequality** — on a non-pristine chain run
is refused; retarget deletes the stale `run.chainPlan`.

**d. Run-record binding**: set `run.chainControls` on create (~:4196-4198);
mint `spendApproval` with scope `"chain_plan"` and the **triple** via
`lampChainCombinedControls(controls)` (~:4005-4008, :4213-4216).

**e. GET projection — add `chainExecution`.** Shape (the sweep board and
`ChainEvalReport` already read defensively against exactly this):

```ts
chainExecution?: {
  stageOrder: LampChainStage[];
  stages: Array<{
    stage: number;                  // 1-based
    stageKind: LampChainStage;
    status: "pending" | "completed" | "invalid" | "not-started";
    videoUrl?: string;              // from video-generation:{stage} result
    artifact?: LampChainEvaluationArtifact;   // when the judge journal completed
    costUsd?: number;
  }>;
}
```
Read each stage's video from the `video-generation:{stage}` provider
operation result; read each detached eval from paid operation
`lampChainEvaluationOperationId(stage)`, parsed with
`parseLampChainEvaluationArtifact` (tolerate parse failure → `"invalid"`).
**A missing eval is `"pending"`, never an error.** Apply the same
blind-grading hiding rule Combined uses (`hidden` in
`mergeLampCombinedEvaluationResults`, ~:1846-1854).

**f. PATCH grade-save** (~:4558-4762). Add chain to mode detection *before*
the lamp fallback. `requiredEvalIds` for chain = `LAMP_CHAIN_EVAL_IDS`.
`executionOwnsArtifact` chain branch: `status === "awaiting_review"` AND the
receipt trail is complete (length === `JSON.parse(execution.renderedPrompt)
.stagePrompts.length`) AND the final receipt's
`generation.artifactIdentityHash` matches the graded artifact.
**CRITICAL: do NOT require any evaluation artifact to exist.** Grading a
chain run with zero evals persisted must work — that is the whole point.
Chain's delivered iteration is always the final stage (like lamp's "always
2", but `= stageCount`).

**g. `app/api/batches/start/route.ts`** — add a chain 409 mirroring
Combined's (~:346-354): single-clip only; message should point at the chain
sweep board for multi-clip experiments.

**h. `app/api/grade-drafts/route.ts`** — verify the `EVAL_IDS` union
(~:34-41) covers chain. Chain reuses Combined's 11 id strings, so if the
union is built from `LAMP_COMBINED_EVAL_IDS` it already passes — confirm,
don't guess.

### 4.2 UI surfaces

**Start here (fixes the one tsc error): `app/page.tsx` MODE_COPY** (~:200)
— add a `chain` entry (eyebrow `"COMBINED V2"`, title `"Chain"`, one-sentence
description: sequential per-concern stages, order configurable, delivered
first, report card after). Then:

- **Cost dispatch arms** (~:253-255 `estimateWorkflowRun`, ~:273-275
  `workflowReservationUsd`) → `estimateLampChainPlan` /
  `estimateLampChainSequence` / `lampChainPlanReservationUsd` /
  `lampChainSequenceReservationUsd`.
- **`CHAIN_FLOW` rail array** mirroring `COMBINED_FLOW`.
- **Upload rules**: chain is single-clip like the plan modes — add it
  wherever plan modes gate multi-upload.
- **Default controls when chain is selected**: `{beautifyLevel: 0,
  cleanlinessLevel: 2, eyeContact: false, stageOrder:
  defaultLampChainStageOrder(...)}`, threaded to `startRun({chainControls})`
  — the store already accepts it.

- **`components/shell/WorkflowModeSelector.tsx`**: chain `MODE_OPTION`
  (label "Chain", hint "Combined V2 — sequential stages"); when selected,
  render Combined's controls block **plus a stage-order picker** — vertical
  list of enabled stages with up/down buttons per row (no drag dependency)
  and a "Default order" reset.

- **`components/review/ChainPlanReview.tsx`** (new): mirror
  `CombinedPlanReview.tsx` — subplans, an ORDER strip
  ("1 Background → 2 Lamp → …"), cost rows from `estimateLampChainSequence`,
  hash-bound approve (`hashLampChainPlan`) POSTing to
  `/api/chain-plan/approve`. ConfirmSpend lines: per-stage generation rows +
  detached eval rows + the line *"Delivery does not wait for evaluations;
  the report card attaches afterwards."* Button: "Approve chain & start".
  Mount it where `CombinedPlanReview` mounts, keyed on
  `runWorkflowMode(run) === "chain"` + a draft `run.chainPlan`.

- **Stage rail**: per-stage progress chips driven by `run.serverExecution`
  (`iteration`, `phase`, `chainStageReceipts`) — study how `WorkflowRail`
  derives Combined progress.

- **`components/review/ChainEvalReport.tsx`** (new): the detached report
  card. Per stage: composite + hard-gate failures
  (`lampChainStageComposite`), per-eval score with delta arrows
  (`identity 92 ↓3`), states pending/completed/invalid. Data source is the
  GET `chainExecution` projection from §4.1e. Must degrade gracefully:
  when evals are hidden or absent, say *"report card hidden until grading is
  saved"* / *"measuring…"* — never an error state.

- **Sweep check**: grep `'"combined"'` across `components/` and non-API
  `app/` for exhaustive switches that would now miss `"chain"`.

### 4.3 Then verify (all $0)

1. `npx tsc --noEmit` → clean
2. `npm test` → 303+ pass
3. `preview_start` config **`combined-v2`** (port 3005) → create a chain run
   in **mock** mode → approve the plan → confirm in the browser that
   **delivery lands before the report card attaches**, then that per-stage
   scores fill in. Screenshot it.
4. Mock a second run of the same clip with a different order → confirm
   `/chain-sweep` groups them and the final-stage matrix renders.

### 4.4 Only after all of the above: paid smoke

Per the standing cost-transparency rule — estimate before, actual after,
running total during. Cheapest meaningful proof is a **2-stage chain
(≈$2.30–2.50)**; a 4-stage is ≈$4.50–4.90. A 2-order sweep on one clip at
4 stages is ≈$9–10. Provider allowance is ~$20–21/hr rolling — run chains
serially. Do not start paid work without showing Justin the estimate first.

---

## 5. Things that will bite you

1. **`renderedPrompt` for chain is a serialized JSON envelope**, not prompt
   text. `inputHash` is its SHA-256. Storage validates it parses, has
   lineage `lamp-chain-stage-prompt-v1`, and holds 2–4 stage prompts.
2. **`chain_sequence.maxIterations` is the stage count (2–4)**, unlike every
   other two-pass scope which is exactly 2. Code that assumes `maxIterations
   === 2` means "two-pass" will be wrong for chain.
3. **`isTwoPassWorkflowMode(mode)` returns FALSE for chain** — intentional.
   Shared plumbing that needs chain admitted uses
   `isLampChainExecutionId(executionId)` instead. If you add chain to a
   shared code path, check which predicate that path uses.
4. **Chain forbids Combined's fields** at the storage layer
   (`deliveredIteration`, `candidateSyncVerdict`,
   `combinedCandidateReceipts`) and vice versa. Assertion errors here mean
   you set a field on the wrong mode.
5. **`repairCompletedRunExecution` early-returns for chain.** Chain
   settlement repair lives in the durable workflow's own failure path. Don't
   add chain reconstruction to the coordinator.
6. **The audio law still binds every stage.** `prepareLampChainStageStart`
   changes only the *generation input*; finalization still remuxes and
   hash-verifies the canonical original audio onto every stage's cut.
7. **Freeze-first law**: before editing any shipped prompt text, freeze the
   current form as `LEGACY_Vn` in its own commit. Chain is on its day-1
   lineage — if you change stage-prompt rendering after a real run has
   stored one, you must freeze first or every existing run 500s on read.

---

## 6. Open questions for Justin

1. **Default stage order in the UI** — `LAMP_CHAIN_DEFAULT_STAGE_ORDER` is
   Background → Lamp → Beautify → Iris (H0, reasoned in `LAMP-CHAIN.md` §7).
   Ship that as the default, or start neutral and force an explicit choice?
2. **Sweep approval ergonomics** — every chain run currently keeps its own
   plan review + spend click (no silent auto-approve, by law). Is a
   grouped "approve all variants for this clip" affordance wanted later,
   clearly labeled, or is per-run friction correct for an experiment?
3. **First paid run shape** — 2-stage (≈$2.40, cheapest proof the chaining
   mechanism works end to end) or straight to a 4-stage H0 run (≈$4.70, the
   real product shape)?
4. **V1-vs-V2 comparison run** — worth spending ≈$2.35 on a Combined V1 run
   of the same clip as the control condition? The final-stage chain artifact
   is rubric-identical to a V1 eval specifically so this comparison is
   apples-to-apples.
5. **Hybrid (H3)** — if drift dominates by stage 3, the follow-up is a
   Combined-style scene+light pass then a short face chain. Worth
   scaffolding now or waiting for data?
