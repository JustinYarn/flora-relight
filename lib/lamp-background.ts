/**
 * Lamp Background's persisted planning contract.
 *
 * Planning is deliberately separate from generation. A vision model may
 * propose a draft, but only a human-approved plan can enter the prompt
 * compiler. Items in `uncertain` are always treated as preserve-by-default.
 */

export const LAMP_BACKGROUND_CLEANUP_PLAN_VERSION =
  "lamp-background-cleanup-plan-v1" as const;

export const LAMP_BACKGROUND_NO_OP_REGIONS = [
  "camera-left",
  "camera-right",
  "behind-subject",
  "desk-foreground",
  "frame-edges",
] as const;

export type LampBackgroundNoOpRegion =
  (typeof LAMP_BACKGROUND_NO_OP_REGIONS)[number];

export type LampBackgroundTemporalVisibility =
  | "persistent"
  | "intermittent"
  | "partially-occluded";

export interface LampBackgroundPlanItem {
  /** Stable kebab-case id used by evaluation and correction compilation. */
  id: string;
  /** Plain-English object or clutter-group name. */
  label: string;
  /** Camera-relative location that stays useful across the full clip. */
  location: string;
  /** Why this classification is appropriate for a presentable background. */
  rationale: string;
  temporalVisibility: LampBackgroundTemporalVisibility;
}

export interface LampBackgroundRemovalTarget
  extends LampBackgroundPlanItem {
  /**
   * V1 may remove only content that is never held, touched, or actively used
   * by the subject at any point in the source clip.
   */
  subjectInteraction: "none-observed";
}

export type LampBackgroundPreserveItem = LampBackgroundPlanItem;

export interface LampBackgroundUncertainItem
  extends LampBackgroundPlanItem {
  uncertainty: string;
  /** Uncertainty can never silently become permission to remove. */
  safeDefault: "preserve";
}

export interface LampBackgroundNoOpJustification {
  reasonCode: "already-presentation-ready";
  /**
   * Self-reported confidence is not proof, but a high floor makes an
   * exceptional no-op an explicit assertion instead of a casual fallback.
   */
  confidence: number;
  summary: string;
  regionEvidence: Array<{
    region: LampBackgroundNoOpRegion;
    finding: string;
  }>;
  whyRemovalWouldNotImprovePresentation: string;
}

export type LampBackgroundPlanApproval =
  | { status: "draft" }
  | {
      status: "approved";
      approvedAt: number;
      approvedBy: "human";
    };

/**
 * One clearly visible person is the floor, not the ceiling: additional people
 * are allowed and every person is protected wholesale. Only the camera must
 * be static.
 */
export type LampBackgroundVisiblePeople =
  | "single-person"
  | "multiple-people";

export interface LampBackgroundCleanupPlan {
  version: typeof LAMP_BACKGROUND_CLEANUP_PLAN_VERSION;
  id: string;
  runId: string;
  createdAt: number;
  sourceScope: {
    cameraMotion: "static";
    visiblePeople: LampBackgroundVisiblePeople;
  };
  /**
   * `exceptional-no-op` is intentionally difficult to produce. It means the
   * exact source should pass through without a generative edit.
   */
  decision: "cleanup" | "exceptional-no-op";
  sceneSummary: string;
  remove: LampBackgroundRemovalTarget[];
  preserve: LampBackgroundPreserveItem[];
  uncertain: LampBackgroundUncertainItem[];
  noOpJustification?: LampBackgroundNoOpJustification;
  approval: LampBackgroundPlanApproval;
}

const TEMPORAL_VISIBILITIES: LampBackgroundTemporalVisibility[] = [
  "persistent",
  "intermittent",
  "partially-occluded",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  path: string,
  options: { minWords?: number } = {}
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  const result = value.trim();
  if (
    options.minWords !== undefined &&
    result.split(/\s+/).filter(Boolean).length < options.minWords
  ) {
    throw new Error(
      `${path} must contain at least ${options.minWords} substantive words.`
    );
  }
  return result;
}

function canonicalItem(
  value: unknown,
  path: string
): LampBackgroundPlanItem {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const id = requiredString(value.id, `${path}.id`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error(`${path}.id must be a kebab-case identifier.`);
  }
  if (!TEMPORAL_VISIBILITIES.includes(
    value.temporalVisibility as LampBackgroundTemporalVisibility
  )) {
    throw new Error(`${path}.temporalVisibility is invalid.`);
  }
  return {
    id,
    label: requiredString(value.label, `${path}.label`),
    location: requiredString(value.location, `${path}.location`),
    rationale: requiredString(value.rationale, `${path}.rationale`),
    temporalVisibility:
      value.temporalVisibility as LampBackgroundTemporalVisibility,
  };
}

function canonicalRemovalTarget(
  value: unknown,
  path: string
): LampBackgroundRemovalTarget {
  if (!isRecord(value) || value.subjectInteraction !== "none-observed") {
    throw new Error(
      `${path}.subjectInteraction must be "none-observed"; held, touched, or actively used objects cannot be removal targets.`
    );
  }
  return {
    ...canonicalItem(value, path),
    subjectInteraction: "none-observed",
  };
}

function canonicalUncertainItem(
  value: unknown,
  path: string
): LampBackgroundUncertainItem {
  if (!isRecord(value) || value.safeDefault !== "preserve") {
    throw new Error(`${path}.safeDefault must be "preserve".`);
  }
  return {
    ...canonicalItem(value, path),
    uncertainty: requiredString(value.uncertainty, `${path}.uncertainty`),
    safeDefault: "preserve",
  };
}

function canonicalArray<T>(
  value: unknown,
  path: string,
  canonicalize: (item: unknown, itemPath: string) => T
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value.map((item, index) =>
    canonicalize(item, `${path}[${index}]`)
  );
}

function canonicalNoOpJustification(
  value: unknown
): LampBackgroundNoOpJustification {
  if (!isRecord(value)) {
    throw new Error(
      "noOpJustification is required for an exceptional no-op."
    );
  }
  if (value.reasonCode !== "already-presentation-ready") {
    throw new Error(
      'noOpJustification.reasonCode must be "already-presentation-ready".'
    );
  }
  if (
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0.95 ||
    value.confidence > 1
  ) {
    throw new Error(
      "noOpJustification.confidence must be between 0.95 and 1."
    );
  }
  if (!Array.isArray(value.regionEvidence)) {
    throw new Error("noOpJustification.regionEvidence must be an array.");
  }
  const regionEvidence = value.regionEvidence.map((entry, index) => {
    if (
      !isRecord(entry) ||
      !LAMP_BACKGROUND_NO_OP_REGIONS.includes(
        entry.region as LampBackgroundNoOpRegion
      )
    ) {
      throw new Error(
        `noOpJustification.regionEvidence[${index}].region is invalid.`
      );
    }
    return {
      region: entry.region as LampBackgroundNoOpRegion,
      finding: requiredString(
        entry.finding,
        `noOpJustification.regionEvidence[${index}].finding`,
        { minWords: 4 }
      ),
    };
  });
  const seenRegions = new Set(regionEvidence.map((entry) => entry.region));
  const missingRegions = LAMP_BACKGROUND_NO_OP_REGIONS.filter(
    (region) => !seenRegions.has(region)
  );
  if (
    missingRegions.length > 0 ||
    seenRegions.size !== regionEvidence.length
  ) {
    throw new Error(
      `Exceptional no-op evidence must cover each required region exactly once; missing: ${
        missingRegions.join(", ") || "none"
      }.`
    );
  }
  return {
    reasonCode: "already-presentation-ready",
    confidence: value.confidence,
    summary: requiredString(value.summary, "noOpJustification.summary", {
      minWords: 20,
    }),
    regionEvidence,
    whyRemovalWouldNotImprovePresentation: requiredString(
      value.whyRemovalWouldNotImprovePresentation,
      "noOpJustification.whyRemovalWouldNotImprovePresentation",
      { minWords: 12 }
    ),
  };
}

function assertUniqueClassifications(plan: {
  remove: LampBackgroundRemovalTarget[];
  preserve: LampBackgroundPreserveItem[];
  uncertain: LampBackgroundUncertainItem[];
}): void {
  const seen = new Set<string>();
  for (const [classification, items] of [
    ["remove", plan.remove],
    ["preserve", plan.preserve],
    ["uncertain", plan.uncertain],
  ] as const) {
    for (const item of items) {
      if (seen.has(item.id)) {
        throw new Error(
          `Cleanup-plan item id "${item.id}" appears in more than one classification.`
        );
      }
      seen.add(item.id);
      if (classification === "remove" && item.id.startsWith("preserve-")) {
        throw new Error(
          `Removal target "${item.id}" uses a misleading preserve-prefixed id.`
        );
      }
    }
  }
}

/**
 * Convert an untrusted planning-model response into the canonical persisted
 * draft. This function never grants approval.
 */
export function buildLampBackgroundCleanupPlan(input: {
  raw: unknown;
  planId: string;
  runId: string;
  createdAt: number;
}): LampBackgroundCleanupPlan {
  if (!isRecord(input.raw)) {
    throw new Error("Lamp Background planner returned an invalid envelope.");
  }
  const planId = requiredString(input.planId, "planId");
  const runId = requiredString(input.runId, "runId");
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error("createdAt must be a non-negative integer timestamp.");
  }
  if (
    !isRecord(input.raw.sourceScope) ||
    input.raw.sourceScope.cameraMotion !== "static" ||
    (input.raw.sourceScope.visiblePeople !== "single-person" &&
      input.raw.sourceScope.visiblePeople !== "multiple-people")
  ) {
    throw new Error(
      "Lamp Background v1 supports only static-camera source videos with at least one clearly visible person."
    );
  }
  const visiblePeople = input.raw.sourceScope
    .visiblePeople as LampBackgroundVisiblePeople;
  if (
    input.raw.decision !== "cleanup" &&
    input.raw.decision !== "exceptional-no-op"
  ) {
    throw new Error(
      'Cleanup-plan decision must be "cleanup" or "exceptional-no-op".'
    );
  }

  const remove = canonicalArray(
    input.raw.remove,
    "remove",
    canonicalRemovalTarget
  );
  const preserve = canonicalArray(
    input.raw.preserve,
    "preserve",
    canonicalItem
  );
  const uncertain = canonicalArray(
    input.raw.uncertain,
    "uncertain",
    canonicalUncertainItem
  );
  assertUniqueClassifications({ remove, preserve, uncertain });

  const decision = input.raw.decision;
  let noOpJustification: LampBackgroundNoOpJustification | undefined;
  if (decision === "cleanup") {
    if (remove.length === 0) {
      throw new Error(
        "A cleanup decision requires at least one approved removal target; unchanged output is not the default."
      );
    }
    if (input.raw.noOpJustification !== undefined) {
      throw new Error(
        "A cleanup decision cannot carry an exceptional no-op justification."
      );
    }
  } else {
    if (remove.length > 0) {
      throw new Error(
        "An exceptional no-op cannot contain removal targets."
      );
    }
    if (uncertain.length > 0) {
      throw new Error(
        "An exceptional no-op cannot rely on unresolved uncertain items."
      );
    }
    if (preserve.length === 0) {
      throw new Error(
        "An exceptional no-op must identify at least one background element it intentionally preserves."
      );
    }
    noOpJustification = canonicalNoOpJustification(
      input.raw.noOpJustification
    );
  }

  return {
    version: LAMP_BACKGROUND_CLEANUP_PLAN_VERSION,
    id: planId,
    runId,
    createdAt: input.createdAt,
    sourceScope: {
      cameraMotion: "static",
      visiblePeople,
    },
    decision,
    sceneSummary: requiredString(input.raw.sceneSummary, "sceneSummary"),
    remove,
    preserve,
    uncertain,
    ...(noOpJustification ? { noOpJustification } : {}),
    approval: { status: "draft" },
  };
}

/** Re-validate a persisted JSON value before it is trusted by the compiler. */
export function parseLampBackgroundCleanupPlan(
  value: unknown
): LampBackgroundCleanupPlan {
  if (
    !isRecord(value) ||
    value.version !== LAMP_BACKGROUND_CLEANUP_PLAN_VERSION
  ) {
    throw new Error("Unknown Lamp Background cleanup-plan version.");
  }
  const draft = buildLampBackgroundCleanupPlan({
    raw: value,
    planId: requiredString(value.id, "id"),
    runId: requiredString(value.runId, "runId"),
    createdAt:
      typeof value.createdAt === "number" ? value.createdAt : Number.NaN,
  });
  if (!isRecord(value.approval) || value.approval.status === "draft") {
    return draft;
  }
  if (
    value.approval.status !== "approved" ||
    value.approval.approvedBy !== "human" ||
    !Number.isSafeInteger(value.approval.approvedAt) ||
    (value.approval.approvedAt as number) < draft.createdAt
  ) {
    throw new Error("Persisted cleanup-plan approval is invalid.");
  }
  return {
    ...draft,
    approval: {
      status: "approved",
      approvedBy: "human",
      approvedAt: value.approval.approvedAt as number,
    },
  };
}

export function isLampBackgroundCleanupPlan(
  value: unknown
): value is LampBackgroundCleanupPlan {
  try {
    parseLampBackgroundCleanupPlan(value);
    return true;
  } catch {
    return false;
  }
}

/** The approval step is explicit and cannot be synthesized by the planner. */
export function approveLampBackgroundCleanupPlan(
  plan: LampBackgroundCleanupPlan,
  approvedAt: number
): LampBackgroundCleanupPlan {
  const canonical = parseLampBackgroundCleanupPlan(plan);
  if (!Number.isSafeInteger(approvedAt) || approvedAt < canonical.createdAt) {
    throw new Error(
      "approvedAt must be an integer timestamp at or after plan creation."
    );
  }
  return {
    ...canonical,
    approval: {
      status: "approved",
      approvedBy: "human",
      approvedAt,
    },
  };
}

export function lampBackgroundPlanRequiresGeneration(
  plan: LampBackgroundCleanupPlan
): boolean {
  return parseLampBackgroundCleanupPlan(plan).decision === "cleanup";
}

function approvalHashProjection(plan: LampBackgroundCleanupPlan): unknown {
  return {
    version: plan.version,
    id: plan.id,
    runId: plan.runId,
    createdAt: plan.createdAt,
    sourceScope: plan.sourceScope,
    decision: plan.decision,
    sceneSummary: plan.sceneSummary,
    remove: plan.remove,
    preserve: plan.preserve,
    uncertain: plan.uncertain,
    ...(plan.noOpJustification
      ? { noOpJustification: plan.noOpJustification }
      : {}),
  };
}

/**
 * Stable SHA-256 binding for approval requests. Approval state is excluded so
 * the draft and its approved copy share the same content hash.
 */
export async function hashLampBackgroundCleanupPlan(
  plan: LampBackgroundCleanupPlan
): Promise<string> {
  const canonical = parseLampBackgroundCleanupPlan(plan);
  const bytes = new TextEncoder().encode(
    JSON.stringify(approvalHashProjection(canonical))
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Provider-free fixture for the browser mock. It deliberately remains a draft
 * so mock execution must still stop for explicit human approval.
 */
export function createMockLampBackgroundCleanupPlan(
  runId: string,
  createdAt: number
): LampBackgroundCleanupPlan {
  return buildLampBackgroundCleanupPlan({
    planId: `lamp-background-plan-${runId}`,
    runId,
    createdAt,
    raw: {
      sourceScope: {
        cameraMotion: "static",
        visiblePeople: "single-person",
      },
      decision: "cleanup",
      sceneSummary:
        "Static single-person interview framing with an ordinary room background and a visible desk or foreground surface.",
      remove: [
        {
          id: "loose-desk-clutter",
          label: "small loose visual-clutter group",
          location: "desk or foreground surface camera-right",
          rationale:
            "Removing the temporary loose cluster makes the background read as tidier without redesigning the room.",
          temporalVisibility: "persistent",
          subjectInteraction: "none-observed",
        },
      ],
      preserve: [
        {
          id: "room-structure",
          label: "architecture, fixed furniture, and meaningful room elements",
          location: "throughout the background",
          rationale:
            "These elements establish the source room and must remain source-faithful.",
          temporalVisibility: "persistent",
        },
        {
          id: "subject-active-items",
          label: "anything held, touched, worn, or actively used",
          location: "on or immediately around the subject",
          rationale:
            "Subject interaction makes these elements part of the protected performance.",
          temporalVisibility: "intermittent",
        },
      ],
      uncertain: [],
    },
  });
}

/**
 * Prompt used to create the draft plan. The provider response is still
 * untrusted until `buildLampBackgroundCleanupPlan` validates it.
 */
export const LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT = `You are the planning stage for Lamp Background, a source-faithful cleanup workflow for short static-camera, single-person interview or webcam videos.

GOAL
Infer that the user chose this workflow because they want a visibly tidier, more intentional, professionally presentable background. Inspect the COMPLETE source timeline and propose meaningful cleanup whenever real visual clutter exists. Search broadly: desk and foreground surfaces, loose cables, cups, packaging, scattered papers, small stray objects, visually noisy clusters, frame-edge intrusions, and other temporary clutter may all be removal candidates. A cluster may be one target when its boundary is clear.

SAFETY BOUNDARY
- "Background" includes desks and foreground surfaces outside the subject.
- Never target any person — the primary presenter or anyone else visible at any moment, in full or in part — nor anything anyone wears, holds, touches, or actively uses, nor architecture, fixed furniture, wall art, windows, screens, reflections, pets, or moving objects.
- When more than one person is visible, add a preserve entry for each additional person's region so their protection is explicit.
- An object that any visible person might own, use, or reach during the clip goes in uncertain with safeDefault "preserve".
- Meaningful personal objects default to preserve.
- Anything ambiguous or intermittently occluded goes in uncertain with safeDefault "preserve".
- This v1 workflow supports only a static camera with at least one clearly visible person. One or more people may be visible; every person is fully protected.

NO-OP IS EXCEPTIONAL
Do not choose exceptional-no-op merely because cleanup is subtle, because an item is hard to inpaint, or because you are uncertain. Choose cleanup whenever at least one safe removal would make the frame more presentable. An exceptional no-op is valid only when the background is already presentation-ready, every required region has been inspected, no unresolved uncertainty remains, and removing anything would make the scene less faithful without improving presentation.

OUTPUT
Respond with strict JSON only. Use this schema:
{
  "sourceScope": {
    "cameraMotion": "static" | "moving" | "uncertain",
    "visiblePeople": "single-person" | "multiple-people" | "none" | "uncertain"
  },
  "decision": "cleanup" | "exceptional-no-op",
  "sceneSummary": "<neutral whole-scene summary>",
  "remove": [
    {
      "id": "<stable kebab-case id>",
      "label": "<plain-English target or clutter group>",
      "location": "<camera-relative location>",
      "rationale": "<why removal improves presentation>",
      "temporalVisibility": "persistent" | "intermittent" | "partially-occluded",
      "subjectInteraction": "none-observed"
    }
  ],
  "preserve": [
    {
      "id": "<stable kebab-case id>",
      "label": "<element to protect>",
      "location": "<camera-relative location>",
      "rationale": "<why it is meaningful, fixed, or compositionally appropriate>",
      "temporalVisibility": "persistent" | "intermittent" | "partially-occluded"
    }
  ],
  "uncertain": [
    {
      "id": "<stable kebab-case id>",
      "label": "<ambiguous element>",
      "location": "<camera-relative location>",
      "rationale": "<why it might look like clutter>",
      "temporalVisibility": "persistent" | "intermittent" | "partially-occluded",
      "uncertainty": "<what cannot be established safely>",
      "safeDefault": "preserve"
    }
  ],
  "noOpJustification": {
    "reasonCode": "already-presentation-ready",
    "confidence": <number from 0.95 to 1>,
    "summary": "<at least 20 words explaining why this rare exception is warranted>",
    "regionEvidence": [
      { "region": "camera-left", "finding": "<specific finding>" },
      { "region": "camera-right", "finding": "<specific finding>" },
      { "region": "behind-subject", "finding": "<specific finding>" },
      { "region": "desk-foreground", "finding": "<specific finding>" },
      { "region": "frame-edges", "finding": "<specific finding>" }
    ],
    "whyRemovalWouldNotImprovePresentation": "<at least 12 words>"
  }
}

Report the observed sourceScope honestly. Lamp Background v1 will reject a moving camera and scenes where no person is clearly visible; single-person and multiple-people scenes are both supported. For cleanup, set noOpJustification to null and include at least one remove target. For exceptional-no-op, provide the justification object, keep remove and uncertain empty, and include all five regionEvidence entries exactly once.`;
