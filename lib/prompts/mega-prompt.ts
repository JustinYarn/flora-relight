import type {
  Correction,
  EvalResult,
  MegaPrompt,
  RelightBasePrompt,
  Violation,
  ViolationSeverity,
} from "@/lib/types";
import { RELIGHT_BASE_PROMPT } from "./base-prompt";

/**
 * The Mega Prompt COMPILER.
 *
 * The prompt sent to the video model is never hand-edited and never
 * accumulates prose. It is compiled deterministically from structured state:
 *
 *   [immutable base: task + locks] + [lighting directive] +
 *   [active corrections from the constraint ledger] + [negative constraints]
 *
 * Same state → same bytes. This is what makes iteration debuggable: any two
 * iterations' prompts diff cleanly, and a correction's effect can be isolated
 * (the seed is pinned while refining for exactly this reason; it rotates only
 * when the same violation survives two consecutive iterations).
 *
 * CONSTRAINT LEDGER RULES (implemented in nextMegaPrompt):
 * - One canonical correction per (sourceEvalId + violation.aspect). The
 *   correction id IS the ledger key, so dedupe is id equality and the
 *   compiler stays deterministic.
 * - Corrections whose (evalId + aspect) no longer appears in the latest
 *   results are marked resolved and DROP OUT of the rendered prompt — stale
 *   instructions cause drift ("pink elephant" in reverse).
 * - Active corrections are ordered critical > major > minor and capped at
 *   MAX_ACTIVE_CORRECTIONS; overflow is dropped silently (log-worthy in a
 *   real system, but the cap always wins — a 40-clause prompt is noise).
 * - Future-real: a clause that resolves and then REAPPEARS gets frozen into
 *   the base block and triggers seed rotation. The mock simply re-activates it.
 */

const MAX_ACTIVE_CORRECTIONS = 12;

const SEVERITY_RANK: Record<ViolationSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

/** Deterministic ledger key: one correction per (evalId + aspect). */
function ledgerId(evalId: string, aspect: string): string {
  const slug = aspect.trim().toLowerCase().replace(/\s+/g, "-");
  return `corr:${evalId}:${slug}`;
}

/** The lighting directive is derived from the base spec — single source of truth. */
function lightingDirectiveFrom(base: RelightBasePrompt): string {
  const l = base.lighting;
  return [
    `Style: ${l.style}`,
    `Key light: ${l.keyLight}`,
    `Fill light: ${l.fillLight}`,
    `Rim light: ${l.rimLight}`,
    `Color temperature: ${l.colorTemperature}`,
    `Mood: ${l.mood}`,
  ].join("\n");
}

/** Iteration 1: base + lighting, empty ledger. */
export function initialMegaPrompt(): MegaPrompt {
  const mp: MegaPrompt = {
    version: 1,
    base: RELIGHT_BASE_PROMPT,
    lightingDirective: lightingDirectiveFrom(RELIGHT_BASE_PROMPT),
    corrections: [],
    rendered: "",
  };
  mp.rendered = renderMegaPrompt(mp);
  return mp;
}

/**
 * Fold one iteration's eval results into the ledger and compile the next
 * prompt. Pure with respect to its inputs: neither `prev` nor `results` is
 * mutated.
 */
export function nextMegaPrompt(prev: MegaPrompt, results: EvalResult[]): MegaPrompt {
  const version = prev.version + 1;

  // 1. Index the latest violations by ledger key, keeping the most severe
  //    violation when several judges/frames report the same aspect.
  const latest = new Map<string, { evalId: string; violation: Violation }>();
  for (const result of results) {
    for (const violation of result.violations) {
      if (!violation.correction || !violation.correction.trim()) continue; // nothing usable to compile
      const key = ledgerId(result.evalId, violation.aspect);
      const existing = latest.get(key);
      if (
        !existing ||
        SEVERITY_RANK[violation.severity] < SEVERITY_RANK[existing.violation.severity]
      ) {
        latest.set(key, { evalId: result.evalId, violation });
      }
    }
  }

  // 2. Carry the ledger forward. A prior correction whose aspect is still
  //    reported stays active (instruction/severity refreshed to the latest
  //    observation); one that is no longer reported is marked resolved.
  const carried: Correction[] = prev.corrections.map((c) => {
    const live = latest.get(c.id);
    if (live) {
      return {
        ...c,
        resolved: false,
        severity: live.violation.severity,
        instruction: live.violation.correction,
      };
    }
    return c.resolved ? c : { ...c, resolved: true };
  });

  // 3. Admit new ledger entries for violations not seen before.
  const known = new Set(carried.map((c) => c.id));
  const admitted: Correction[] = [];
  latest.forEach(({ evalId, violation }, key) => {
    if (known.has(key)) return;
    admitted.push({
      id: key,
      sourceEvalId: evalId,
      severity: violation.severity,
      instruction: violation.correction,
      addedAtIteration: version,
      resolved: false,
    });
  });

  // 4. Order active corrections critical > major > minor (older first within
  //    a tier, id as the final deterministic tiebreaker) and cap silently.
  const active = [...carried, ...admitted]
    .filter((c) => !c.resolved)
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.addedAtIteration - b.addedAtIteration ||
        a.id.localeCompare(b.id)
    )
    .slice(0, MAX_ACTIVE_CORRECTIONS);

  const activeIds = new Set(active.map((c) => c.id));
  const resolved = carried.filter((c) => c.resolved && !activeIds.has(c.id));

  const mp: MegaPrompt = {
    version,
    base: prev.base,
    lightingDirective: prev.lightingDirective,
    corrections: [...active, ...resolved],
    rendered: "",
  };
  mp.rendered = renderMegaPrompt(mp);
  return mp;
}

/**
 * Deterministic serialization. Renders ONLY unresolved corrections — resolved
 * clauses drop out so the prompt never accretes stale instructions.
 */
export function renderMegaPrompt(mp: MegaPrompt): string {
  const { base } = mp;

  const locks = [
    `IDENTITY — ${base.locks.identity}`,
    `PERFORMANCE — ${base.locks.performance}`,
    `WARDROBE — ${base.locks.wardrobe}`,
    `BACKGROUND — ${base.locks.background}`,
    `CAMERA — ${base.locks.camera}`,
    `AUDIO — ${base.locks.audio}`,
  ].join("\n");

  const activeCorrections = mp.corrections.filter((c) => !c.resolved);
  const correctionsBlock =
    activeCorrections.length === 0
      ? "(none — first iteration or all prior findings resolved)"
      : activeCorrections
          .map((c, i) => `${i + 1}. [${c.severity.toUpperCase()}] ${c.instruction}`)
          .join("\n");

  const negatives = base.negative.map((n) => `- ${n}`).join("\n");

  return [
    `=== FLORA RELIGHT MEGA PROMPT v${mp.version} ===`,
    "",
    "[TASK]",
    base.task,
    "",
    "[INVARIANT LOCKS]",
    locks,
    "",
    "[LIGHTING SPECIFICATION]",
    mp.lightingDirective,
    "",
    "[ACTIVE CORRECTIONS FROM EVALUATION]",
    correctionsBlock,
    "",
    "[NEVER DO]",
    negatives,
  ].join("\n");
}
