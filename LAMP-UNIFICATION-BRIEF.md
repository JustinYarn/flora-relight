# Lamp unification brief — handoff document

> **Status update (2026-07-17):** this is the preserved pre-build decision
> brief. The safety backups, Version A merge, five-mode shell, SyncNet closure,
> Combined Version B implementation, and local data consolidation described
> below have now been implemented on `codex/lamp-unification`. Treat topology,
> pending-state, cost, and “nothing executed” statements as historical context;
> `HANDOFF.md` is the current operating truth.

Written 2026-07-17 by a Claude Code session that audited the repo, dry-ran the merges, and agreed this plan with Justin. This document is self-contained: a fresh chat with no prior context can work from it. Nothing described here has been executed yet — no merges, no new code. Use this doc to (1) answer the open questions in §8, then (2) build Version A, then Version B.

**How to use in a new chat:** paste or attach this file. Also point the chat at the in-repo docs listed in §2. The worktrees in §3 are live checkouts — read code there directly.

---

## 1. The goal (Justin's words, distilled)

1. **Don't merge yet** — the iris branch is still under active treatment (possibly by a parallel session; check `git log` freshness twice, minutes apart, before touching any worktree).
2. **Version A — one app, four doors:** a single UI pushed to the main GitHub app where the home page lets Justin choose between the four workflows (Lamp / Background / Beautify / Iris). The four pipelines stay completely separate — only the front door is unified.
3. **Version B — the one-shot:** upload a video, set everything up front (light intensity slider, beautification level, cleanliness level, eye-contact on/off toggle), hit go once, get **two output videos**, and pick the winner by hand. Built after A.

---

## 2. Project background (one paragraph + where the real docs live)

Flora Relight (repo `github.com/JustinYarn/flora-relight`, Next.js 14 + React Flow + zustand, dark internal-tool UI) started as a video relighting studio: turn a ~10s poorly-lit webcam clip into a professionally-lit version while keeping person/audio/background/wardrobe/motion identical. Video generation = "Omni" (Google Veo-3.1-class via Gemini Interactions API, ~$1.12/gen); judging = Gemini + Claude. Flora (the original iterative mode) was retired 2026-07-16 — **Lamp** (fixed two-pass: Initial gen → holistic eval → compiled correction → Final gen → SyncNet lip-sync gate → eval-2 → blind human grading at /grade) is the product. Prod deploys automatically when `main` is pushed (Vercel, https://flora-relight.vercel.app, password gate). A typical paid run costs ~$2.30–2.40 (two gens + two token-priced evals); planning calls are ~$0.02–0.04.

**In-repo docs the builder should read** (at each worktree root):
- `ARCHITECTURE.md` — core design (anchor-first, structural guarantees, mega-prompt compiler)
- `HANDOFF.md` — ops/deploy authority
- `LAMP-INTENSITY.md` (slider worktree) — the 0–100 relight-strength ladder design + measured calibration
- `LAMP-IRIS.md` (iris worktree) — eye-contact product design, GazeMeter, best-of-two
- `LAMP-EVAL-REVIEW.md` — evaluator rubric review

---

## 3. Repo state: four worktrees, four branches, exact topology

All four directories under `Desktop/claude test flora/` are **git worktrees of one repo** (not copies). All committed, all clean, **none pushed** — origin only has `main`. `main` (9071296) == `origin/main` == prod.

| Worktree | Branch | Tip | Port |
|---|---|---|---|
| `flora-relight` | `codex/lamp-slider-calibration` | c4e1d8a | 3000 (has `.env.local` with keys — never echo them) |
| `flora-relight-lamp-background` | `codex/lamp-background` | 5c985a6 | 3001 (detached server) |
| `flora-relight-lamp-beautify` | `codex/lamp-beautify` | 23e416a | 3002 (detached server) |
| `flora-relight-lamp-iris` | `codex/lamp-iris` | 5a0145e | 3003 (launch config "lamp-iris") |

**Topology — three of the four are stacked, verified by merge-base:**

```
main (9071296, = prod)
│
├── codex/lamp-slider-calibration   3 commits, fully independent
│      330c229 → ffc5184 → c4e1d8a (relight-strength slider made real; live-verified)
│
└── 07d0fc0 "Lamp Background cleanup workflow"        ← shared root of the other three
     │
     ├── codex/lamp-background      +5c985a6 only (truthful hero placeholder, 1 file +8/−3)
     │
     └── beautify trunk: 2b5daec → 8c135c7 → dedd961 → e17dc32 → f93e52c → d6ba601
         (Beautify workflow → intensity dial → warmth v2 → intensity ladder v3)
          ├── codex/lamp-beautify   +11 commits (prompt gens 4–9: clean-generation,
          │                          steady-state, transformation-first, glow-up
          │                          re-anchor, region fence, lighting latitude)
          └── codex/lamp-iris       +7 commits (Iris workflow, prompt gens 1–3,
                                     GazeMeter, best-of-two) — forked at d6ba601
```

Consequences: merging iris automatically brings background's root commit and beautify's first six commits (you cannot ship Iris without the touch-up-dial trunk). Background's only unique content beyond the trunk is one 8-line fix. Beautify's gens 4–9 are beautify-only.

**Conflict map (from `git merge-tree --write-tree` dry runs, no side effects):**
- `beautify + iris`: **CLEAN** — zero conflicts.
- `slider + any of the other three`: **11 conflicted files**, all core plumbing: `app/api/runs/route.ts`, `app/page.tsx`, `components/shell/WorkflowModeSelector.tsx`, `lib/engine.ts`, `lib/lamp-evaluation.ts`, `lib/prompts/mega-prompt.ts`, `lib/run-factory.ts`, `lib/server/run-execution-coordinator.ts`, `lib/server/storage/run-execution.ts`, `lib/store.ts`, `lib/types.ts`.
- `background's 5c985a6 + beautify or iris`: **1 small conflict** in `app/runs/[id]/page.tsx`.

**Merge order that minimizes conflict work** (one real conflict session instead of two): integration branch off main → merge background (fast-forward) → beautify (1 small conflict) → iris (clean, maybe same page.tsx spot) → **slider LAST** (the 11-file session).

Important: the slider's relight-strength system and the trunk's touch-up/contact dials are **different controls that rewired the same files** — the conflict resolution must keep BOTH working (see §4). They are not duplicates.

---

## 4. Finding 1 — there is no mode switcher anywhere (Version A's real work)

When Flora was retired (07-16), `setWorkflowMode` and the saved mode preference were **deleted**; `WorkflowModeSelector` became a static description panel. Every feature branch then: (a) appended its mode to the `WorkflowMode` union in `lib/types.ts` (~line 385), (b) hard-coded its own `DEFAULT_WORKFLOW_MODE` in `lib/workflow-mode.ts:3` (`background` / `beautify` / `iris`; slider branch keeps `lamp`), and (c) rewrote the same static panel to describe only itself. **No branch has an interactive selector.** Today these are four single-purpose apps; a naive merge produces one app stuck in whichever mode wins the conflict.

**What must be built (the Version A UX spec Justin approved in mockup form):**
- An interactive 4-mode switcher (tabs: Lamp / Background / Beautify / Iris) replacing the static panel. Reintroduce a `setWorkflowMode` store action + persisted per-browser preference. Flora stays retired (not a tab; legacy Flora records still render via `runWorkflowMode`).
- Scaffolding that already exists: the iris branch's `MODE_COPY` map (`app/page.tsx:160-194`) has eyebrow/title/description for all modes; per-mode flow-rail arrays (`LAMP_FLOW`/`BACKGROUND_FLOW`/`BEAUTIFY_FLOW`/`IRIS_FLOW`) exist; all plan-review components are additive.
- The switcher drives three things: hero/setup copy, **upload rules** (Lamp = multiple clips + batches; the three plan modes = one clip at a time by design — `/api/batches/start` 409s plan modes), and **which control renders where**:
  - **Lamp**: pre-upload 0–100 relight-strength slider (from the slider branch: lives in the selector component with `relightIntensity` props, mounted `app/page.tsx:1112-1115`; six bands defined in `lib/relight-intensity.ts` — Daylight lift / Soft daylight / Pro video call / Broadcast interview / Premium studio / Cinematic hero; **exactly 75 = byte-identical control prompt**; measured-calibration correction on pass 2).
  - **Background**: no dial. Plan review (`BackgroundPlanReview`) with Remove / Preserve / Uncertain columns + hash-bound approve + ConfirmSpend.
  - **Beautify**: 1–3 dial *inside* plan review (`BeautifyPlanReview.tsx:296-326`, radiogroup: As planned / 1 Polished / 2 Elevated / 3 Glow-up; override applies one level to all approved items).
  - **Iris**: 1–3 dial inside plan review (`IrisPlanReview.tsx`: As planned / 1 Natural assist / 2 Presenter / 3 Anchor). Delivery may ship the Initial take labeled "v1 · BEST OF TWO" (selection in `app/api/runs/route.ts:2249-2317` on the iris branch).
- Default mode on open: Justin hasn't picked yet (§8 Q1).

**Known UI bugs to fix during the merge:**
1. Beautify branch's selector panel still says "Lamp Background" (copy-paste leftover, `WorkflowModeSelector.tsx:20/27` on that branch) — dies naturally when the panel becomes a switcher.
2. Beautify per-item chips use `INTENSITY_LABEL` = "subtle / noticeable / polished" (`BeautifyPlanReview.tsx:26-30`) while the dial says "Polished / Elevated / Glow-up" (dial was relabeled in prompt gen 7; chips weren't).
3. Iris cost-estimate rows leak "cleanup" wording into the iris breakdown (actual rows are labeled right).
4. Pre-existing: "FLORA VIDEO" label leak on the pair player.

---

## 5. Finding 2 — SyncNet gate: original P0 fixed, but the fix opened a new fail-open (must close during the A merge)

Context: SyncNet is the lip-sync quality gate; after both paid generations it scores the Final and can trigger at most one paid Lipsync-2-Pro repair. The 07-16 P0 (absolute conf≥4 gate killed runs whose *source* scores low; gate ran before eval-2 so judge-2 was lost) **was genuinely fixed and live-proven** (source-relative verdict `v2SyncVerdict`, repair skip when source is below bar, eval-2 moved before the gate, `syncBaseline` persisted; proven by run_bg01_049's rerun). The admission config gate (`v2SyncConfigIssue`, `lib/server/v2-sync-config.ts`) is sound: all three approve/start routes refuse paid runs with broken config (503, pre-spend).

**The new hole (introduced by the eval-2-before-gate reorder, lives in trunk commit 07d0fc0 → affects background, beautify, AND iris):** if the SyncNet *service* is unreachable (down, or a well-formed-but-dead `SYNCNET_BASE_URL`) at the candidate-analysis step — i.e. after ~$4 of spend — the retries exhaust, the step throws, and **no lipsync operation was ever journaled** (a clean candidate PASS also journals nothing). `recordExecutionFailure` at `workflows/durable-relight-run.ts:2068-2083` then hits its `lipsync === null` clause, classifies the run `two_pass_completed`, and it **settles to awaiting-review with unverified lip-sync, the error cleared**. "Passed clean" and "never ran" are indistinguishable. The same blind spot is mirrored in `settleLampExecution` (~:1772), `settleBackgroundExecution` (~:1849), and `repairCompletedRunExecution` (`lib/server/run-execution-coordinator.ts` ~:189). On `main`, the old ordering (gate before eval-2) made this fail closed — the reorder is what opened it.

**Fix spec (small, do it on the integration branch so it lands everywhere at once):** journal a positive candidate-sync verdict on clean pass (or an explicit skip reason, e.g. silent source), and change all four guards: `lipsync === null` **without a recorded candidate verdict** ⇒ `reconcile_required` (hold, don't ship), not `two_pass_completed`.

---

## 6. Version A plan (phases)

0. **Wait for iris to go quiet** (parallel-session etiquette: `git log` + `git status` twice, minutes apart).
1. **Git merges** on an integration branch off `main`, order: background → beautify → iris → slider last (§3 conflict map). Resolution intent for the 11-file session: keep both control systems (slider + dials) fully wired.
2. **Build the mode switcher** + per-mode control scoping + fix the four copy bugs (§4).
3. **Close the SyncNet fail-open** (§5).
4. **Data consolidation** (or grade-first — §8 Q3): each worktree has its own `data/` dir that git does NOT merge. Pending state as of 07-17: :3001 has runs 040 + 049-rerun gradeable **plus Justin's own clip-043 run still waiting for HIS approve click**; :3002 has by05 (plan ready to dial+approve) + graded queue; :3003 has the iris runs (mrpas6x9 etc.). Consolidating = copying run dirs / batches / paid-operations / tombstones into the surviving worktree (JSON merges need care; tombstoned ids are permanently non-reusable).
5. **Free verification**: merged test-suite union (each branch is ~119–181 tests, additive), `tsc`, lint, build, mock ($0) runs through all four modes on one server.
6. **Optional paid smoke**: one live run per mode ≈ $2.30–2.40 each, ≈ **$9.40 all four** — fits the ~$20–21/hr rolling provider spend allowance. Per Justin's standing rule: show estimates before, actuals after, running totals during any paid work.
7. **Push** = prod auto-deploy of all four modes. Note: beautify gens 8–9 and iris gen 3 have never had a live paid run (prompt layers only affect NEW runs — low risk, but it's a decision, §8 Q4). Then optionally delete merged branches + extra worktrees.

---

## 7. Version B design — the one-shot combined mode

**Goal:** upload → set light slider (0–100) + beautify level (off/1–3) + cleanliness level + eye-contact toggle → one confirm → two output videos → human picks the winner.

**Chaining is ruled out (Justin asked which order would make sense — answer: don't chain).** Every workflow obeys the law that generation conditions on the ORIGINAL video (interaction chaining was removed 07-14 as a root-cause fix). Chaining 4 workflows means each stage generates from the previous stage's AI output: up to 8 generations deep, identity drift + artifacts compounding, ~$9.20–9.60 and ~20 min per clip, and each stage's evaluator judging the previous stage's artifacts. The model already undershoots and "redecorates" doing ONE concern. (If someone ever insists on chaining anyway, the only sane order is Background → Lamp → Beautify → Iris: scene first, then global light, then face, then eyes. But don't.)

**The right shape: ONE combined prompt, one two-pass workflow (~$2.30–2.40/run, same as any single mode).** All four prompt systems are deterministic compilers over locks/permissions, and their locks contradict each other pairwise (beautify locks lighting, lamp changes it; background locks the person, beautify changes the face). Version B = a **unified lock matrix with region-fenced ownership**:
- lighting → owned by the relight slider band recipe
- the four facial zones → owned by beautify (its gen-8 fence)
- background objects → owned by the cleanup plan
- eyes/eyelids → owned by iris
- everything else (identity, hair, wardrobe, camera/lens/framing/DoF, audio, other people) → hard-locked

Precedent that proves the pattern: beautify gen 8 (region fence — "pressure stays inside the four facial zones") and gen 9 (lighting-latitude carve-out threaded through every lock layer) are exactly this move, done pairwise. B does it four-way.

**Structure decisions:**
- B is a **fifth `workflowMode`** (e.g. `combo`) in the same app — a fifth tab, not a second deployment (pending §8 Q5). Built AFTER Version A because it needs all four prompt systems in one tree.
- New prompt product with its **own frozen-generation lineage from day 1** (persisted-format law, §9).
- Combined evaluator registry: per-concern hard gates + per-control intensity contracts. Watch the mega-prompt **constraint-ledger cap of 12** — four concerns now COMPETE for correction slots on pass 2; a priority ordering across concerns is needed (severity-ordered dedup already exists).
- **Planner + one consolidated review screen**: the three plan-modes' planners still run (~$0.02–0.04 total), but their proposals render on ONE review screen with ONE approve click = one spend gate. Do NOT silently auto-approve — plans are generation-steering text (a mislabeled preserve-item once hallucinated a ring light). A "trust mode" full-auto toggle can come later, clearly labeled.
- **Controls mapping:** light slider reuses `lib/relight-intensity.ts` bands; beautify level reuses the catalog + 1–3 ladder (off = no beautify block); **cleanliness level is a NEW concept** — background today is plan-only with no level (needs definition, §8 Q7); eye-contact toggle = iris block on/off (strength when on: §8 Q6).
- **Two outputs, human picks — nearly free:** the two-pass workflow already produces two takes, iris already has `deliveredIteration` best-of-two machinery and every surface labels "v1 · best of two", and the pair player exists. B shows BOTH takes side by side at grade time and persists the human's choice as the delivered iteration.

**Central risk (be honest about it):** stacking four asks in one generation may exceed Omni Flash's obedience budget — it undershoots ladders and reaches for its "glamour prior" doing single concerns. Levers that exist: the correction pass, the luma meter (deterministic relight measurement), the GazeMeter (deterministic gaze measurement), and per-concern hard gates. Expect paid calibration runs at ~$2.30 each; the lesson from 9 beautify generations applies — *every amplitude increase needs an equal-and-opposite scoping fence*.

---

## 8. Open questions — answer these before building

1. **Default mode** when the app opens: Lamp (founding product) or Background (recent daily driver)? Preference persists per browser either way.
2. **Switcher shape**: tab row (per the approved mockup) or something quieter (dropdown)?
3. **Local data**: consolidate the three sibling worktrees' `data/` dirs into the surviving app as a merge phase, or finish grading/approving on the per-branch servers first? (Reminder: clip-043 run on :3001 still awaits Justin's approve click.)
4. **Prod timing**: push right after free verification, or hold until beautify gen-9 / iris gen-3 get one live proving run each (~$2.35 each)?
5. **Version B as a fifth mode** in the same app — confirmed? Or literally a second deployed app?
6. **Eye-contact toggle ON** = fixed strength (Presenter, band 2) or planner-chosen per clip?
7. **Cleanliness levels**: define 1–3 (e.g. 1 = obvious clutter only … 3 = full staging), or keep it planner-driven (toggle: clean / don't clean)?
8. **SyncNet fix timing**: inside the A merge (recommended — merging is what propagates the hole) — confirm?
9. Paid smoke after A (~$9.40 for all four modes) — yes/no?

---

## 9. Laws and gotchas the builder MUST respect (learned the hard way; violating these has cost real money)

1. **Regenerate-from-original**: no interaction chaining; every generation conditions on the original video only.
2. **Freeze-first**: before rewriting ANY shipped prompt text (base prompts, plan blocks, correction vocabulary, final-prompt compiles), freeze the current form as LEGACY_Vn in its own commit. Read paths recompile against persisted bytes — six separate incidents prove that changing a renderer without a frozen legacy form breaks or 500s every existing run.
3. **Both-sides mirror**: any change to plan-binding/divergence rules must land in BOTH the server validator AND the read-side binding (runs-route projection), or healthy runs render as reconcile_required.
4. **Canonical-input rule**: deterministic measurements (luma, gaze) run BEFORE the paid judge claim so they're part of the claimed input.
5. **No journal release primitive**: never leave an in_progress claim intending to retry later — retry inside the claim or seal it.
6. **New-mode enqueue-gate checklist** (every new mode tripped some of these live as 502s): (a) spend-approval scope whitelist + `authorizedWorstCase` + `assertPaidOperationAuthorized` per-scope blocks; (b) run-execution-coordinator `reusableApproval` ladder; (c) `lib/server/storage/run-execution.ts` plan-first identity prefix check; (d) grade-save: PATCH `requiredEvalIds` per-mode + `executionOwnsArtifact` branch; (e) batch-route 409 behavior for plan modes.
7. **Cost transparency (standing rule)**: show spend estimates before, actuals after, and running totals during any paid API work. Provider has a rolling spend allowance ≈ $20–21/hr — duty-cycle paid runs; a run killed by the wall burns money.
8. **Secrets**: API keys live in `.env.local` (main worktree; copy file-to-file, never echo). Vercel env adds must be run by Justin (`vercel env add` stores literal quotes if piped — strip them).
9. **Ops**: NEVER `npm run build` while a dev server runs (shared `.next/` corrupts — kill server, `rm -rf .next`, rebuild, restart detached via nohup). Node must come from nvm (repo pins 22; system PATH has 18). The worktree path contains a SPACE — node-gyp breaks on it (gaze-meter uses an absolute-path require workaround; recheck on dependency bumps). New server deps with native/wasm guts must join `serverExternalPackages` in next.config + restart. Batch ids must be lowercase. Prod runs inspectable via `npx workflow inspect run|steps -r <wrun_id> -b vercel -e production -j --decrypt`.
10. **Parallel sessions are real** (Codex + multiple Claude sessions have all committed to these worktrees): before repo surgery, check `git log` freshness and `git status` twice a few minutes apart. One builder per worktree at a time.

---

## 10. Current pending state (as of 2026-07-17 evening)

- Grade queues: :3001 has 040 + 049-rerun; :3002 has beautify runs (by05 plan ready to dial+approve); :3003 has iris runs (mrpas6x9 graded via API with a placeholder automated grade — Justin should overwrite from /grade).
- Justin's clip-043 run on :3001 is paused at plan approval, waiting for his click.
- Not yet live-proven: beautify prompt gens 8–9 (~$2.35 tests both), iris gen 3 (no run has generated on it).
- Two iris runs (mrpcip87, mrpcr36f) hold `reconcile_required` as billing evidence (~$1.20 each, provider flake at Final gen) — kept deliberately.
- Iris was the most recently active worktree — assume a parallel session may still own it until verified quiet.
