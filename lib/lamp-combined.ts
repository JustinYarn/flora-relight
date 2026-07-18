/**
 * Pure domain contracts for Lamp Combined.
 *
 * Combined is one two-pass generation product, not four chained workflows.
 * Its aggregate plan binds the three planning concerns to one run and one
 * approval click. Relight strength deliberately stays on Run and is validated
 * beside (rather than copied into) this plan.
 */

import {
  approveLampBackgroundCleanupPlan,
  hashLampBackgroundCleanupPlan,
  parseLampBackgroundCleanupPlan,
  type LampBackgroundCleanupPlan,
} from "./lamp-background.ts";
import {
  applyLampBeautifyIntensityOverride,
  approveLampBeautifyPlan,
  hashLampBeautifyPlan,
  parseLampBeautifyPlan,
  type LampBeautifyPlan,
} from "./lamp-beautify.ts";
import {
  applyLampIrisIntensityOverride,
  approveLampIrisPlan,
  hashLampIrisPlan,
  parseLampIrisPlan,
  type LampIrisPlan,
} from "./lamp-iris.ts";
import type { ViolationSeverity } from "./types.ts";

export const LAMP_COMBINED_LABEL = "Combined" as const;
export const LAMP_COMBINED_PLAN_VERSION = "lamp-combined-plan-v1" as const;
export const LAMP_COMBINED_PRESENTER_INTENSITY = 2 as const;
export const LAMP_COMBINED_MAX_CORRECTIONS = 12 as const;

export type LampCombinedRelightIntensity = number;
export type LampCombinedBeautifyLevel = 0 | 1 | 2 | 3;
export type LampCombinedCleanlinessLevel = 1 | 2 | 3;

export interface LampCombinedControls {
  beautifyLevel: LampCombinedBeautifyLevel;
  cleanlinessLevel: LampCombinedCleanlinessLevel;
  eyeContact: boolean;
}

export const LAMP_COMBINED_CLEANLINESS_PROFILES = {
  1: {
    label: "Tidy",
    executionDirective:
      "Use the smallest practical edit footprint to remove the approved targets and keep surrounding source pixels as untouched as possible.",
    scopeRule:
      "Minimal execution footprint inside the same human-approved removal targets.",
  },
  2: {
    label: "Clean",
    executionDirective:
      "Remove every approved target completely and naturally while preserving all unapproved room content and the original composition.",
    scopeRule:
      "Complete target removal inside the same human-approved removal targets.",
  },
  3: {
    label: "Studio-clean",
    executionDirective:
      "Apply maximum temporal and inpainting thoroughness inside each approved target footprint, without extending the cleanup into neighboring objects or redesigning the room.",
    scopeRule:
      "Maximum thoroughness inside the same human-approved target footprints.",
  },
} as const satisfies Record<
  LampCombinedCleanlinessLevel,
  { label: string; executionDirective: string; scopeRule: string }
>;

export type LampCombinedPlanApproval =
  | { status: "draft" }
  | {
      status: "approved";
      approvedAt: number;
      approvedBy: "human";
    };

export type LampCombinedBeautifySubplan =
  | { state: "disabled"; reason: "control-off" }
  | { state: "enabled"; plan: LampBeautifyPlan };

export type LampCombinedIrisSubplan =
  | { state: "disabled"; reason: "control-off" }
  | {
      state: "enabled";
      intensity: typeof LAMP_COMBINED_PRESENTER_INTENSITY;
      plan: LampIrisPlan;
    };

export interface LampCombinedPlan {
  version: typeof LAMP_COMBINED_PLAN_VERSION;
  id: string;
  runId: string;
  createdAt: number;
  /** Relight intensity is intentionally absent; it remains a separate Run field. */
  controls: LampCombinedControls;
  backgroundPlan: LampBackgroundCleanupPlan;
  beautify: LampCombinedBeautifySubplan;
  iris: LampCombinedIrisSubplan;
  approval: LampCombinedPlanApproval;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function nonNegativeTimestamp(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative integer timestamp.`);
  }
  return value as number;
}

export function parseLampCombinedRelightIntensity(
  value: unknown
): LampCombinedRelightIntensity {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100) {
    throw new Error("Lamp Combined relight intensity must be an integer from 0 through 100.");
  }
  return value as number;
}

export function parseLampCombinedControls(value: unknown): LampCombinedControls {
  if (!isRecord(value)) {
    throw new Error("Lamp Combined controls must be an object.");
  }
  if (
    value.beautifyLevel !== 0 &&
    value.beautifyLevel !== 1 &&
    value.beautifyLevel !== 2 &&
    value.beautifyLevel !== 3
  ) {
    throw new Error("Lamp Combined beautify level must be 0, 1, 2, or 3.");
  }
  if (
    value.cleanlinessLevel !== 1 &&
    value.cleanlinessLevel !== 2 &&
    value.cleanlinessLevel !== 3
  ) {
    throw new Error("Lamp Combined cleanliness level must be 1, 2, or 3.");
  }
  if (typeof value.eyeContact !== "boolean") {
    throw new Error("Lamp Combined eye-contact control must be boolean.");
  }
  return {
    beautifyLevel: value.beautifyLevel,
    cleanlinessLevel: value.cleanlinessLevel,
    eyeContact: value.eyeContact,
  };
}

export type LampCombinedPlannerConcern = "background" | "beautify" | "iris";

/** The caller uses this list to avoid even invoking disabled planners. */
export function lampCombinedRequiredPlanners(
  controls: unknown
): LampCombinedPlannerConcern[] {
  const canonical = parseLampCombinedControls(controls);
  return [
    "background",
    ...(canonical.beautifyLevel === 0 ? [] : (["beautify"] as const)),
    ...(canonical.eyeContact ? (["iris"] as const) : []),
  ];
}

function assertDraftApproval(
  plan: { approval: { status: string } },
  path: string
): void {
  if (plan.approval.status !== "draft") {
    throw new Error(`${path} must be a draft before aggregate approval.`);
  }
}

function assertSubplanBinding(
  plan: { runId: string; createdAt: number },
  runId: string,
  aggregateCreatedAt: number,
  path: string
): void {
  if (plan.runId !== runId) {
    throw new Error(`${path} belongs to a different run.`);
  }
  if (plan.createdAt > aggregateCreatedAt) {
    throw new Error(`${path} cannot be newer than its aggregate plan.`);
  }
}

function applyBeautifyControl(
  plan: LampBeautifyPlan,
  level: Exclude<LampCombinedBeautifyLevel, 0>
): LampBeautifyPlan {
  return plan.decision === "enhance"
    ? applyLampBeautifyIntensityOverride(plan, level)
    : plan;
}

function applyIrisControl(plan: LampIrisPlan): LampIrisPlan {
  return plan.decision === "correct"
    ? applyLampIrisIntensityOverride(plan, LAMP_COMBINED_PRESENTER_INTENSITY)
    : plan;
}

export function buildLampCombinedPlan(input: {
  planId: string;
  runId: string;
  createdAt: number;
  controls: unknown;
  backgroundPlan: unknown;
  beautifyPlan?: unknown;
  irisPlan?: unknown;
}): LampCombinedPlan {
  const id = requiredString(input.planId, "planId");
  const runId = requiredString(input.runId, "runId");
  const createdAt = nonNegativeTimestamp(input.createdAt, "createdAt");
  const controls = parseLampCombinedControls(input.controls);

  const backgroundPlan = parseLampBackgroundCleanupPlan(input.backgroundPlan);
  assertDraftApproval(backgroundPlan, "backgroundPlan");
  assertSubplanBinding(backgroundPlan, runId, createdAt, "backgroundPlan");

  let beautify: LampCombinedBeautifySubplan;
  if (controls.beautifyLevel === 0) {
    if (input.beautifyPlan !== undefined) {
      throw new Error(
        "Beautify is off; its planner must be skipped and no subplan may be supplied."
      );
    }
    beautify = { state: "disabled", reason: "control-off" };
  } else {
    if (input.beautifyPlan === undefined) {
      throw new Error("Beautify is enabled and requires a planner subplan.");
    }
    const parsed = parseLampBeautifyPlan(input.beautifyPlan);
    assertDraftApproval(parsed, "beautify.plan");
    assertSubplanBinding(parsed, runId, createdAt, "beautify.plan");
    beautify = {
      state: "enabled",
      plan: applyBeautifyControl(parsed, controls.beautifyLevel),
    };
  }

  let iris: LampCombinedIrisSubplan;
  if (!controls.eyeContact) {
    if (input.irisPlan !== undefined) {
      throw new Error(
        "Eye contact is off; its planner must be skipped and no iris subplan may be supplied."
      );
    }
    iris = { state: "disabled", reason: "control-off" };
  } else {
    if (input.irisPlan === undefined) {
      throw new Error("Eye contact is enabled and requires an iris planner subplan.");
    }
    const parsed = parseLampIrisPlan(input.irisPlan);
    assertDraftApproval(parsed, "iris.plan");
    assertSubplanBinding(parsed, runId, createdAt, "iris.plan");
    iris = {
      state: "enabled",
      intensity: LAMP_COMBINED_PRESENTER_INTENSITY,
      plan: applyIrisControl(parsed),
    };
  }

  return parseLampCombinedPlan({
    version: LAMP_COMBINED_PLAN_VERSION,
    id,
    runId,
    createdAt,
    controls,
    backgroundPlan,
    beautify,
    iris,
    approval: { status: "draft" },
  });
}

function parseBeautifySubplan(
  value: unknown,
  controls: LampCombinedControls,
  runId: string,
  createdAt: number
): LampCombinedBeautifySubplan {
  if (!isRecord(value)) {
    throw new Error("Lamp Combined beautify subplan state is invalid.");
  }
  if (controls.beautifyLevel === 0) {
    if (
      value.state !== "disabled" ||
      value.reason !== "control-off" ||
      "plan" in value
    ) {
      throw new Error("Beautify-off plans must explicitly store a disabled subplan.");
    }
    return { state: "disabled", reason: "control-off" };
  }
  if (value.state !== "enabled" || !("plan" in value)) {
    throw new Error("Enabled Beautify controls require an enabled subplan.");
  }
  const plan = parseLampBeautifyPlan(value.plan);
  assertSubplanBinding(plan, runId, createdAt, "beautify.plan");
  if (
    plan.decision === "enhance" &&
    plan.enhance.some((item) => item.intensity !== controls.beautifyLevel)
  ) {
    throw new Error("Beautify subplan intensities do not match the bound control.");
  }
  return { state: "enabled", plan };
}

function parseIrisSubplan(
  value: unknown,
  controls: LampCombinedControls,
  runId: string,
  createdAt: number
): LampCombinedIrisSubplan {
  if (!isRecord(value)) {
    throw new Error("Lamp Combined iris subplan state is invalid.");
  }
  if (!controls.eyeContact) {
    if (
      value.state !== "disabled" ||
      value.reason !== "control-off" ||
      "plan" in value
    ) {
      throw new Error("Eye-contact-off plans must explicitly store a disabled subplan.");
    }
    return { state: "disabled", reason: "control-off" };
  }
  if (
    value.state !== "enabled" ||
    value.intensity !== LAMP_COMBINED_PRESENTER_INTENSITY ||
    !("plan" in value)
  ) {
    throw new Error("Enabled eye contact requires a Presenter-intensity iris subplan.");
  }
  const plan = parseLampIrisPlan(value.plan);
  assertSubplanBinding(plan, runId, createdAt, "iris.plan");
  if (
    plan.decision === "correct" &&
    plan.correct.some(
      (item) => item.intensity !== LAMP_COMBINED_PRESENTER_INTENSITY
    )
  ) {
    throw new Error("Iris subplan intensity must remain fixed at Presenter level 2.");
  }
  return {
    state: "enabled",
    intensity: LAMP_COMBINED_PRESENTER_INTENSITY,
    plan,
  };
}

function parseAggregateApproval(
  value: unknown,
  createdAt: number
): LampCombinedPlanApproval {
  if (!isRecord(value)) {
    throw new Error("Lamp Combined aggregate approval is missing.");
  }
  if (value.status === "draft") return { status: "draft" };
  if (
    value.status !== "approved" ||
    value.approvedBy !== "human" ||
    !Number.isSafeInteger(value.approvedAt) ||
    (value.approvedAt as number) < createdAt
  ) {
    throw new Error("Lamp Combined aggregate approval is invalid.");
  }
  return {
    status: "approved",
    approvedBy: "human",
    approvedAt: value.approvedAt as number,
  };
}

function assertApprovalCoherence(plan: LampCombinedPlan): void {
  const nested = [
    plan.backgroundPlan.approval,
    ...(plan.beautify.state === "enabled" ? [plan.beautify.plan.approval] : []),
    ...(plan.iris.state === "enabled" ? [plan.iris.plan.approval] : []),
  ];
  if (plan.approval.status === "draft") {
    if (nested.some((approval) => approval.status !== "draft")) {
      throw new Error("A draft aggregate cannot contain an approved subplan.");
    }
    return;
  }
  const approvedAt = plan.approval.approvedAt;
  if (
    nested.some(
      (approval) =>
        approval.status !== "approved" ||
        approval.approvedAt !== approvedAt
    )
  ) {
    throw new Error(
      "Aggregate and enabled subplans must share one human approval timestamp."
    );
  }
}

/** Re-validate persisted aggregate JSON before it is trusted. */
export function parseLampCombinedPlan(value: unknown): LampCombinedPlan {
  if (!isRecord(value) || value.version !== LAMP_COMBINED_PLAN_VERSION) {
    throw new Error("Unknown Lamp Combined plan version.");
  }
  const id = requiredString(value.id, "id");
  const runId = requiredString(value.runId, "runId");
  const createdAt = nonNegativeTimestamp(value.createdAt, "createdAt");
  const controls = parseLampCombinedControls(value.controls);
  const backgroundPlan = parseLampBackgroundCleanupPlan(value.backgroundPlan);
  assertSubplanBinding(backgroundPlan, runId, createdAt, "backgroundPlan");
  const beautify = parseBeautifySubplan(
    value.beautify,
    controls,
    runId,
    createdAt
  );
  const iris = parseIrisSubplan(value.iris, controls, runId, createdAt);
  const approval = parseAggregateApproval(value.approval, createdAt);
  const canonical: LampCombinedPlan = {
    version: LAMP_COMBINED_PLAN_VERSION,
    id,
    runId,
    createdAt,
    controls,
    backgroundPlan,
    beautify,
    iris,
    approval,
  };
  assertApprovalCoherence(canonical);
  return canonical;
}

/** One click approves every enabled subplan and the aggregate at one instant. */
export function approveLampCombinedPlan(
  plan: LampCombinedPlan,
  approvedAt: number
): LampCombinedPlan {
  const canonical = parseLampCombinedPlan(plan);
  if (canonical.approval.status !== "draft") {
    throw new Error("Lamp Combined plan has already been approved.");
  }
  nonNegativeTimestamp(approvedAt, "approvedAt");
  if (approvedAt < canonical.createdAt) {
    throw new Error("approvedAt cannot be earlier than aggregate plan creation.");
  }
  return parseLampCombinedPlan({
    ...canonical,
    backgroundPlan: approveLampBackgroundCleanupPlan(
      canonical.backgroundPlan,
      approvedAt
    ),
    beautify:
      canonical.beautify.state === "enabled"
        ? {
            state: "enabled",
            plan: approveLampBeautifyPlan(canonical.beautify.plan, approvedAt),
          }
        : canonical.beautify,
    iris:
      canonical.iris.state === "enabled"
        ? {
            state: "enabled",
            intensity: LAMP_COMBINED_PRESENTER_INTENSITY,
            plan: approveLampIrisPlan(canonical.iris.plan, approvedAt),
          }
        : canonical.iris,
    approval: {
      status: "approved",
      approvedBy: "human",
      approvedAt,
    },
  });
}

/**
 * Stable SHA-256 approval binding. Existing subplan hashes already omit their
 * approval metadata; the aggregate projection omits its approval metadata too.
 */
export async function hashLampCombinedPlan(
  plan: LampCombinedPlan
): Promise<string> {
  const canonical = parseLampCombinedPlan(plan);
  const [backgroundHash, beautifyHash, irisHash] = await Promise.all([
    hashLampBackgroundCleanupPlan(canonical.backgroundPlan),
    canonical.beautify.state === "enabled"
      ? hashLampBeautifyPlan(canonical.beautify.plan)
      : Promise.resolve(null),
    canonical.iris.state === "enabled"
      ? hashLampIrisPlan(canonical.iris.plan)
      : Promise.resolve(null),
  ]);
  const projection = {
    version: canonical.version,
    id: canonical.id,
    runId: canonical.runId,
    createdAt: canonical.createdAt,
    controls: canonical.controls,
    backgroundPlanHash: backgroundHash,
    beautify:
      canonical.beautify.state === "enabled"
        ? { state: "enabled", planHash: beautifyHash }
        : canonical.beautify,
    iris:
      canonical.iris.state === "enabled"
        ? {
            state: "enabled",
            intensity: LAMP_COMBINED_PRESENTER_INTENSITY,
            planHash: irisHash,
          }
        : canonical.iris,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(projection));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Validate the run id, mutable run controls, and separately stored relight
 * intensity against the immutable aggregate plan before execution.
 */
export function assertLampCombinedPlanBinding(
  plan: LampCombinedPlan,
  binding: {
    runId: unknown;
    relightIntensity: unknown;
    controls: unknown;
  }
): LampCombinedPlan {
  const canonical = parseLampCombinedPlan(plan);
  const runId = requiredString(binding.runId, "binding.runId");
  const controls = parseLampCombinedControls(binding.controls);
  parseLampCombinedRelightIntensity(binding.relightIntensity);
  if (canonical.runId !== runId) {
    throw new Error("Lamp Combined aggregate plan is bound to a different run.");
  }
  if (
    canonical.controls.beautifyLevel !== controls.beautifyLevel ||
    canonical.controls.cleanlinessLevel !== controls.cleanlinessLevel ||
    canonical.controls.eyeContact !== controls.eyeContact
  ) {
    throw new Error("Lamp Combined run controls no longer match the approved plan.");
  }
  return canonical;
}

export interface LampCombinedBackgroundExecutionScope {
  cleanupPlanId: string;
  cleanlinessLevel: LampCombinedCleanlinessLevel;
  targetFootprints: Array<{ id: string; label: string; location: string }>;
  executionDirective: string;
  mayAddRemovalTargets: false;
  mayRedecorate: false;
}

/** Cleanliness changes execution amplitude, never the approved target set. */
export function lampCombinedBackgroundExecutionScope(
  plan: LampCombinedPlan
): LampCombinedBackgroundExecutionScope {
  const canonical = parseLampCombinedPlan(plan);
  if (canonical.approval.status !== "approved") {
    throw new Error("Background execution requires the approved aggregate plan.");
  }
  const profile =
    LAMP_COMBINED_CLEANLINESS_PROFILES[canonical.controls.cleanlinessLevel];
  return {
    cleanupPlanId: canonical.backgroundPlan.id,
    cleanlinessLevel: canonical.controls.cleanlinessLevel,
    targetFootprints: canonical.backgroundPlan.remove.map(
      ({ id, label, location }) => ({ id, label, location })
    ),
    executionDirective: profile.executionDirective,
    mayAddRemovalTargets: false,
    mayRedecorate: false,
  };
}

export type LampCombinedEditConcern =
  | "lighting"
  | "background"
  | "beautify"
  | "iris";
export type LampCombinedCorrectionConcern =
  | LampCombinedEditConcern
  | "preservation"
  | "audio-sync";

export interface LampCombinedCorrectionCandidate {
  id: string;
  concern: LampCombinedCorrectionConcern;
  severity: ViolationSeverity;
  hardGate: boolean;
  instruction: string;
}

export const LAMP_COMBINED_CONCERN_ORDER = [
  "lighting",
  "background",
  "beautify",
  "iris",
] as const satisfies readonly LampCombinedEditConcern[];

export function lampCombinedEnabledConcerns(
  controls: unknown
): LampCombinedEditConcern[] {
  const canonical = parseLampCombinedControls(controls);
  return [
    "lighting",
    "background",
    ...(canonical.beautifyLevel === 0 ? [] : (["beautify"] as const)),
    ...(canonical.eyeContact ? (["iris"] as const) : []),
  ];
}

const SEVERITY_RANK: Record<ViolationSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

/**
 * Select the pass-two correction ledger deterministically: hard gates first,
 * then coverage for each enabled concern, then remaining severity order.
 */
export function selectLampCombinedCorrections(
  candidates: readonly LampCombinedCorrectionCandidate[],
  controls: unknown
): LampCombinedCorrectionCandidate[] {
  const enabledConcerns = lampCombinedEnabledConcerns(controls);
  const validated = candidates.map((candidate, index) => {
    const id = requiredString(candidate.id, `candidates[${index}].id`);
    const instruction = requiredString(
      candidate.instruction,
      `candidates[${index}].instruction`
    );
    if (!(candidate.severity in SEVERITY_RANK)) {
      throw new Error(`candidates[${index}].severity is invalid.`);
    }
    if (
      ![
        "lighting",
        "background",
        "beautify",
        "iris",
        "preservation",
        "audio-sync",
      ].includes(candidate.concern)
    ) {
      throw new Error(`candidates[${index}].concern is invalid.`);
    }
    if (typeof candidate.hardGate !== "boolean") {
      throw new Error(`candidates[${index}].hardGate must be boolean.`);
    }
    return { ...candidate, id, instruction, index };
  });
  const byId = new Map<string, (typeof validated)[number]>();
  for (const candidate of validated) {
    const existing = byId.get(candidate.id);
    if (
      !existing ||
      (candidate.hardGate && !existing.hardGate) ||
      (candidate.hardGate === existing.hardGate &&
        SEVERITY_RANK[candidate.severity] < SEVERITY_RANK[existing.severity])
    ) {
      // Preserve first appearance as the stable tie-break even if a stronger
      // duplicate supplies the canonical payload.
      byId.set(candidate.id, {
        ...candidate,
        index: existing?.index ?? candidate.index,
      });
    }
  }
  const ranked = [...byId.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.index - b.index
  );
  const selected: typeof ranked = [];
  const selectedIds = new Set<string>();
  const add = (candidate: (typeof ranked)[number] | undefined): void => {
    if (
      candidate &&
      selected.length < LAMP_COMBINED_MAX_CORRECTIONS &&
      !selectedIds.has(candidate.id)
    ) {
      selected.push(candidate);
      selectedIds.add(candidate.id);
    }
  };

  for (const candidate of ranked) {
    if (candidate.hardGate) add(candidate);
  }
  for (const concern of LAMP_COMBINED_CONCERN_ORDER) {
    if (!enabledConcerns.includes(concern)) continue;
    if (selected.some((candidate) => candidate.concern === concern)) continue;
    add(
      ranked.find(
        (candidate) =>
          candidate.concern === concern && !selectedIds.has(candidate.id)
      )
    );
  }
  for (const candidate of ranked) add(candidate);

  return selected.map(({ index: _index, ...candidate }) => candidate);
}

export type LampCombinedIteration = 1 | 2;
export type LampCombinedCandidateIneligibility =
  | "generation-incomplete"
  | "audio-unverified"
  | "sync-failed"
  | "sync-unverified"
  | "evaluation-incomplete";

export interface LampCombinedDeliveryCandidate {
  iteration: LampCombinedIteration;
  generationComplete: boolean;
  audioStatus: "verified" | "silent-source" | "failed" | "unverified";
  syncStatus: "pass" | "not-required" | "fail" | "unverified";
  evaluationComplete: boolean;
}

export function lampCombinedCandidateIneligibility(
  candidate: LampCombinedDeliveryCandidate
): LampCombinedCandidateIneligibility | null {
  if (!candidate.generationComplete) return "generation-incomplete";
  if (
    candidate.audioStatus !== "verified" &&
    candidate.audioStatus !== "silent-source"
  ) {
    return "audio-unverified";
  }
  if (candidate.syncStatus === "fail") return "sync-failed";
  if (
    candidate.syncStatus !== "pass" &&
    candidate.syncStatus !== "not-required"
  ) {
    return "sync-unverified";
  }
  if (!candidate.evaluationComplete) return "evaluation-incomplete";
  return null;
}

/** V1 is never repaired; only V2 may consume the single repair attempt. */
export function lampCombinedMayAttemptSyncRepair(input: {
  iteration: LampCombinedIteration;
  previousRepairAttempts: number;
}): boolean {
  return input.iteration === 2 && input.previousRepairAttempts === 0;
}

export interface LampCombinedWinnerChoice {
  iteration: LampCombinedIteration;
  chosenAt: number;
  chosenBy: "human";
}

export function chooseLampCombinedWinner(
  candidates: readonly LampCombinedDeliveryCandidate[],
  choice: LampCombinedWinnerChoice
): LampCombinedWinnerChoice {
  if (choice.chosenBy !== "human") {
    throw new Error("Lamp Combined winner must be chosen by a human.");
  }
  nonNegativeTimestamp(choice.chosenAt, "choice.chosenAt");
  const matching = candidates.filter(
    (candidate) => candidate.iteration === choice.iteration
  );
  if (matching.length !== 1) {
    throw new Error("Winner choice must identify exactly one generated take.");
  }
  const reason = lampCombinedCandidateIneligibility(matching[0]!);
  if (reason !== null) {
    throw new Error(`The chosen Lamp Combined take is ineligible: ${reason}.`);
  }
  return {
    iteration: choice.iteration,
    chosenAt: choice.chosenAt,
    chosenBy: "human",
  };
}

/** Grade submission is scoped to the single human-selected winner. */
export function assertLampCombinedGradeTarget(
  winner: LampCombinedWinnerChoice,
  gradedIteration: LampCombinedIteration
): void {
  if (winner.iteration !== gradedIteration) {
    throw new Error("Only the human-selected Lamp Combined winner may be graded.");
  }
}
