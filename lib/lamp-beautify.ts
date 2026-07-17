/**
 * Lamp Beautify's persisted planning contract.
 *
 * The inverse of Lamp Background: the room is wholesale-locked and the
 * PRIMARY subject receives only human-approved enhancements drawn from a
 * closed catalog. Identity is invariant — an enhancement that reads as a
 * different person is a defect, not a success. Items in `uncertain` are
 * always treated as decline-by-default.
 */

export const LAMP_BEAUTIFY_PLAN_VERSION = "lamp-beautify-plan-v1" as const;

/**
 * The closed enhancement catalog. Plan items, corrections, and evaluation
 * all speak this vocabulary; nothing outside it can ever be authorized.
 */
export const LAMP_BEAUTIFY_CATALOG = [
  "skin-evenness",
  "under-eye-softening",
  "teeth-brightening",
  "eye-clarity",
  "hair-tidy",
] as const;

export type LampBeautifyCategory = (typeof LAMP_BEAUTIFY_CATALOG)[number];

/**
 * The intensity ladder mirrors the Lamp slider: 1 is deniable, 2 is visible
 * side-by-side yet natural in isolation, 3 is clearly camera-groomed while
 * remaining physically plausible.
 */
export type LampBeautifyIntensity = 1 | 2 | 3;

export const LAMP_BEAUTIFY_NO_OP_REGIONS = [
  "skin",
  "under-eyes",
  "teeth",
  "eyes",
  "hair",
] as const;

export type LampBeautifyNoOpRegion =
  (typeof LAMP_BEAUTIFY_NO_OP_REGIONS)[number];

export type LampBeautifyVisiblePeople = "single-person" | "multiple-people";

export interface LampBeautifyEnhanceItem {
  /** One catalog category; each category may be approved at most once. */
  id: LampBeautifyCategory;
  intensity: LampBeautifyIntensity;
  /** Why this enhancement improves on-camera presentation for this source. */
  rationale: string;
  /** What in the source footage motivates it (observed, not invented). */
  evidence: string;
}

export interface LampBeautifyDeclinedItem {
  id: LampBeautifyCategory;
  reason: string;
}

export interface LampBeautifyUncertainItem {
  id: LampBeautifyCategory;
  uncertainty: string;
  /** Uncertainty can never silently become permission to enhance. */
  safeDefault: "decline";
}

export interface LampBeautifyNoOpJustification {
  reasonCode: "already-camera-ready";
  confidence: number;
  summary: string;
  regionEvidence: Array<{
    region: LampBeautifyNoOpRegion;
    finding: string;
  }>;
  whyEnhancementWouldNotImprovePresentation: string;
}

export type LampBeautifyPlanApproval =
  | { status: "draft" }
  | {
      status: "approved";
      approvedAt: number;
      approvedBy: "human";
    };

export interface LampBeautifyPlan {
  version: typeof LAMP_BEAUTIFY_PLAN_VERSION;
  id: string;
  runId: string;
  createdAt: number;
  sourceScope: {
    cameraMotion: "static";
    visiblePeople: LampBeautifyVisiblePeople;
  };
  decision: "enhance" | "exceptional-no-op";
  /** Neutral description of the subject's current on-camera presentation. */
  subjectSummary: string;
  enhance: LampBeautifyEnhanceItem[];
  declined: LampBeautifyDeclinedItem[];
  uncertain: LampBeautifyUncertainItem[];
  noOpJustification?: LampBeautifyNoOpJustification;
  approval: LampBeautifyPlanApproval;
}

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

function requiredCategory(value: unknown, path: string): LampBeautifyCategory {
  if (
    typeof value !== "string" ||
    !LAMP_BEAUTIFY_CATALOG.includes(value as LampBeautifyCategory)
  ) {
    throw new Error(
      `${path} must be one of the closed catalog categories: ${LAMP_BEAUTIFY_CATALOG.join(
        ", "
      )}.`
    );
  }
  return value as LampBeautifyCategory;
}

function canonicalEnhanceItem(
  value: unknown,
  path: string
): LampBeautifyEnhanceItem {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const intensity = value.intensity;
  if (intensity !== 1 && intensity !== 2 && intensity !== 3) {
    throw new Error(`${path}.intensity must be 1, 2, or 3.`);
  }
  return {
    id: requiredCategory(value.id, `${path}.id`),
    intensity,
    rationale: requiredString(value.rationale, `${path}.rationale`, {
      minWords: 4,
    }),
    evidence: requiredString(value.evidence, `${path}.evidence`, {
      minWords: 4,
    }),
  };
}

function canonicalDeclinedItem(
  value: unknown,
  path: string
): LampBeautifyDeclinedItem {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return {
    id: requiredCategory(value.id, `${path}.id`),
    reason: requiredString(value.reason, `${path}.reason`, { minWords: 3 }),
  };
}

function canonicalUncertainItem(
  value: unknown,
  path: string
): LampBeautifyUncertainItem {
  if (!isRecord(value) || value.safeDefault !== "decline") {
    throw new Error(`${path}.safeDefault must be "decline".`);
  }
  return {
    id: requiredCategory(value.id, `${path}.id`),
    uncertainty: requiredString(value.uncertainty, `${path}.uncertainty`, {
      minWords: 3,
    }),
    safeDefault: "decline",
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
  return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
}

function canonicalNoOpJustification(
  value: unknown
): LampBeautifyNoOpJustification {
  if (!isRecord(value)) {
    throw new Error("noOpJustification is required for an exceptional no-op.");
  }
  if (value.reasonCode !== "already-camera-ready") {
    throw new Error(
      'noOpJustification.reasonCode must be "already-camera-ready".'
    );
  }
  if (
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0.95 ||
    value.confidence > 1
  ) {
    throw new Error("noOpJustification.confidence must be between 0.95 and 1.");
  }
  if (!Array.isArray(value.regionEvidence)) {
    throw new Error("noOpJustification.regionEvidence must be an array.");
  }
  const regionEvidence = value.regionEvidence.map((entry, index) => {
    if (
      !isRecord(entry) ||
      !LAMP_BEAUTIFY_NO_OP_REGIONS.includes(
        entry.region as LampBeautifyNoOpRegion
      )
    ) {
      throw new Error(
        `noOpJustification.regionEvidence[${index}].region is invalid.`
      );
    }
    return {
      region: entry.region as LampBeautifyNoOpRegion,
      finding: requiredString(
        entry.finding,
        `noOpJustification.regionEvidence[${index}].finding`,
        { minWords: 4 }
      ),
    };
  });
  const seenRegions = new Set(regionEvidence.map((entry) => entry.region));
  const missingRegions = LAMP_BEAUTIFY_NO_OP_REGIONS.filter(
    (region) => !seenRegions.has(region)
  );
  if (missingRegions.length > 0 || seenRegions.size !== regionEvidence.length) {
    throw new Error(
      `Exceptional no-op evidence must cover each required region exactly once; missing: ${
        missingRegions.join(", ") || "none"
      }.`
    );
  }
  return {
    reasonCode: "already-camera-ready",
    confidence: value.confidence,
    summary: requiredString(value.summary, "noOpJustification.summary", {
      minWords: 20,
    }),
    regionEvidence,
    whyEnhancementWouldNotImprovePresentation: requiredString(
      value.whyEnhancementWouldNotImprovePresentation,
      "noOpJustification.whyEnhancementWouldNotImprovePresentation",
      { minWords: 12 }
    ),
  };
}

function assertUniqueCategories(plan: {
  enhance: LampBeautifyEnhanceItem[];
  declined: LampBeautifyDeclinedItem[];
  uncertain: LampBeautifyUncertainItem[];
}): void {
  const seen = new Set<string>();
  for (const items of [plan.enhance, plan.declined, plan.uncertain] as const) {
    for (const item of items) {
      if (seen.has(item.id)) {
        throw new Error(
          `Catalog category "${item.id}" appears in more than one classification.`
        );
      }
      seen.add(item.id);
    }
  }
}

/**
 * Convert an untrusted planning-model response into the canonical persisted
 * draft. This function never grants approval.
 */
export function buildLampBeautifyPlan(input: {
  raw: unknown;
  planId: string;
  runId: string;
  createdAt: number;
}): LampBeautifyPlan {
  if (!isRecord(input.raw)) {
    throw new Error("Lamp Beautify planner returned an invalid envelope.");
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
      "Lamp Beautify v1 supports only static-camera source videos with at least one clearly visible person."
    );
  }
  const visiblePeople = input.raw.sourceScope
    .visiblePeople as LampBeautifyVisiblePeople;
  if (
    input.raw.decision !== "enhance" &&
    input.raw.decision !== "exceptional-no-op"
  ) {
    throw new Error(
      'Beautify-plan decision must be "enhance" or "exceptional-no-op".'
    );
  }

  const enhance = canonicalArray(
    input.raw.enhance,
    "enhance",
    canonicalEnhanceItem
  );
  const declined = canonicalArray(
    input.raw.declined,
    "declined",
    canonicalDeclinedItem
  );
  const uncertain = canonicalArray(
    input.raw.uncertain,
    "uncertain",
    canonicalUncertainItem
  );
  assertUniqueCategories({ enhance, declined, uncertain });

  const decision = input.raw.decision;
  let noOpJustification: LampBeautifyNoOpJustification | undefined;
  if (decision === "enhance") {
    if (enhance.length === 0) {
      throw new Error(
        "An enhance decision requires at least one approved enhancement; unchanged output is not the default."
      );
    }
    if (input.raw.noOpJustification !== undefined) {
      throw new Error(
        "An enhance decision cannot carry an exceptional no-op justification."
      );
    }
  } else {
    if (enhance.length > 0) {
      throw new Error("An exceptional no-op cannot contain enhancements.");
    }
    if (uncertain.length > 0) {
      throw new Error(
        "An exceptional no-op cannot rely on unresolved uncertain items."
      );
    }
    noOpJustification = canonicalNoOpJustification(input.raw.noOpJustification);
  }

  return {
    version: LAMP_BEAUTIFY_PLAN_VERSION,
    id: planId,
    runId,
    createdAt: input.createdAt,
    sourceScope: {
      cameraMotion: "static",
      visiblePeople,
    },
    decision,
    subjectSummary: requiredString(input.raw.subjectSummary, "subjectSummary"),
    enhance,
    declined,
    uncertain,
    ...(noOpJustification ? { noOpJustification } : {}),
    approval: { status: "draft" },
  };
}

/** Re-validate a persisted JSON value before it is trusted by the compiler. */
export function parseLampBeautifyPlan(value: unknown): LampBeautifyPlan {
  if (!isRecord(value) || value.version !== LAMP_BEAUTIFY_PLAN_VERSION) {
    throw new Error("Unknown Lamp Beautify plan version.");
  }
  const draft = buildLampBeautifyPlan({
    raw: value,
    planId: requiredString(value.id, "id"),
    runId: requiredString(value.runId, "runId"),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Number.NaN,
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
    throw new Error("Persisted beautify-plan approval is invalid.");
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

export function isLampBeautifyPlan(value: unknown): value is LampBeautifyPlan {
  try {
    parseLampBeautifyPlan(value);
    return true;
  } catch {
    return false;
  }
}

/** The approval step is explicit and cannot be synthesized by the planner. */
export function approveLampBeautifyPlan(
  plan: LampBeautifyPlan,
  approvedAt: number
): LampBeautifyPlan {
  const canonical = parseLampBeautifyPlan(plan);
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

export function lampBeautifyPlanRequiresGeneration(
  plan: LampBeautifyPlan
): boolean {
  return parseLampBeautifyPlan(plan).decision === "enhance";
}

function approvalHashProjection(plan: LampBeautifyPlan): unknown {
  return {
    version: plan.version,
    id: plan.id,
    runId: plan.runId,
    createdAt: plan.createdAt,
    sourceScope: plan.sourceScope,
    decision: plan.decision,
    subjectSummary: plan.subjectSummary,
    enhance: plan.enhance,
    declined: plan.declined,
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
export async function hashLampBeautifyPlan(
  plan: LampBeautifyPlan
): Promise<string> {
  const canonical = parseLampBeautifyPlan(plan);
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
export function createMockLampBeautifyPlan(
  runId: string,
  createdAt: number
): LampBeautifyPlan {
  return buildLampBeautifyPlan({
    planId: `lamp-beautify-plan-${runId}`,
    runId,
    createdAt,
    raw: {
      sourceScope: {
        cameraMotion: "static",
        visiblePeople: "single-person",
      },
      decision: "enhance",
      subjectSummary:
        "Static single-person webcam framing with ordinary on-camera presentation and mild temporary shine.",
      enhance: [
        {
          id: "skin-evenness",
          intensity: 1,
          rationale:
            "Reducing temporary shine reads as better-rested without changing the person.",
          evidence: "Mild forehead shine is visible under the key light.",
        },
      ],
      declined: [
        {
          id: "teeth-brightening",
          reason: "Teeth are barely visible while speaking.",
        },
      ],
      uncertain: [],
    },
  });
}

/**
 * Prompt used to create the draft plan. The provider response is still
 * untrusted until `buildLampBeautifyPlan` validates it.
 */
export const LAMP_BEAUTIFY_PLAN_PROMPT = `You are the planning stage for Lamp Beautify, a source-faithful on-camera touch-up workflow for short static-camera webcam or interview videos.

GOAL
Infer that the user chose this workflow because they want to look professionally camera-ready while remaining unmistakably themselves. Inspect the COMPLETE source timeline and propose bounded enhancement whenever it would genuinely improve on-camera presentation. The catalog is closed:
- skin-evenness: reduce temporary blemishes, shine, or irritation. Pores, texture, permanent marks, moles, freckles, scars, and apparent age always remain.
- under-eye-softening: subtly reduce dark circles or puffiness without erasing natural contours.
- teeth-brightening: mild natural whitening within plausible enamel tones.
- eye-clarity: slightly reduce visible redness and brighten sclera within realism.
- hair-tidy: tame stray flyaways only; the hairstyle itself never changes.

INTENSITY
Each approved item carries intensity 1, 2, or 3:
1 subtle — barely perceptible, deniable.
2 balanced — noticeable side-by-side, natural in isolation.
3 polished — clearly groomed for camera, still physically plausible.
Choose the lowest intensity that achieves a presentable result. Reserve 3 for pronounced issues.

SAFETY BOUNDARY
- Only the PRIMARY subject may be enhanced. Every other visible person is fully protected and never enhanced.
- Never propose face reshaping, slimming, eye enlargement, nose or jaw changes, skin-tone shifts, de-aging, makeup invention, hairstyle changes, or wardrobe changes — these are outside the catalog and impossible to authorize.
- Permanent identity features (moles, scars, freckles, wrinkles consistent with age, facial hair pattern) are never removal targets under any category.
- The background, lighting, camera, framing, performance, and audio are completely out of scope for this workflow.
- Anything you cannot establish confidently goes in uncertain with safeDefault "decline".
- This v1 workflow supports only a static camera with at least one clearly visible person.

NO-OP IS EXCEPTIONAL
Do not choose exceptional-no-op merely because improvements would be subtle. Choose enhance whenever at least one catalog item at intensity 1 would make the subject read as better prepared for camera. An exceptional no-op is valid only when the subject is already fully camera-ready in every catalog region.

OUTPUT
Respond with strict JSON only. Use this schema:
{
  "sourceScope": {
    "cameraMotion": "static" | "moving" | "uncertain",
    "visiblePeople": "single-person" | "multiple-people" | "none" | "uncertain"
  },
  "decision": "enhance" | "exceptional-no-op",
  "subjectSummary": "<neutral summary of the subject's current on-camera presentation>",
  "enhance": [
    {
      "id": "<catalog category>",
      "intensity": 1 | 2 | 3,
      "rationale": "<why this improves presentation>",
      "evidence": "<what in the source motivates it>"
    }
  ],
  "declined": [
    { "id": "<catalog category>", "reason": "<why it is not needed>" }
  ],
  "uncertain": [
    {
      "id": "<catalog category>",
      "uncertainty": "<what cannot be established safely>",
      "safeDefault": "decline"
    }
  ],
  "noOpJustification": {
    "reasonCode": "already-camera-ready",
    "confidence": <number from 0.95 to 1>,
    "summary": "<at least 20 words explaining why this rare exception is warranted>",
    "regionEvidence": [
      { "region": "skin", "finding": "<specific finding>" },
      { "region": "under-eyes", "finding": "<specific finding>" },
      { "region": "teeth", "finding": "<specific finding>" },
      { "region": "eyes", "finding": "<specific finding>" },
      { "region": "hair", "finding": "<specific finding>" }
    ],
    "whyEnhancementWouldNotImprovePresentation": "<at least 12 words>"
  }
}

Report the observed sourceScope honestly. Lamp Beautify v1 will reject a moving camera and scenes where no person is clearly visible; single-person and multiple-people scenes are both supported. For enhance, set noOpJustification to null and include at least one catalog item. For exceptional-no-op, provide the justification object, keep enhance and uncertain empty, and include all five regionEvidence entries exactly once.`;
