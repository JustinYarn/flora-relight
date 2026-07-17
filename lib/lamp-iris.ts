/**
 * Lamp Iris's persisted planning contract.
 *
 * The scope inverse of both siblings: Background edits the room, Beautify
 * edits the subject's presentation — Iris edits ONLY gaze direction (and the
 * minimal eyelid pose that direction implies) so a subject reading a script
 * holds natural eye contact with the camera. Everything else, including every
 * blink, the head pose, the mouth, and speech articulation, is invariant.
 * Items in `uncertain` are always treated as decline-by-default.
 */

export const LAMP_IRIS_PLAN_VERSION = "lamp-iris-plan-v1" as const;

/**
 * The closed gaze-correction catalog. Plan items, corrections, and evaluation
 * all speak this vocabulary; nothing outside it can ever be authorized.
 */
export const LAMP_IRIS_CATALOG = [
  "camera-axis-anchor",
  "reading-scan-smoothing",
  "note-glance-bridging",
] as const;

export type LampIrisCategory = (typeof LAMP_IRIS_CATALOG)[number];

/** What the planner may propose today — currently the full catalog. */
export const LAMP_IRIS_ACTIVE_CATALOG = [
  "camera-axis-anchor",
  "reading-scan-smoothing",
  "note-glance-bridging",
] as const;

export type LampIrisActiveCategory =
  (typeof LAMP_IRIS_ACTIVE_CATALOG)[number];

/**
 * The intensity ladder mirrors the Lamp slider: 1 corrects only what clearly
 * reads as script-reading and keeps every natural glance-away, 2 holds
 * presenter-grade contact through speech, 3 is broadcast-anchor contact —
 * and at every level a frozen stare is overshoot, exactly like a near-copy
 * is undershoot.
 */
export type LampIrisIntensity = 1 | 2 | 3;

export const LAMP_IRIS_NO_OP_REGIONS = [
  "camera-axis",
  "reading-pattern",
  "glances",
  "blinks",
  "overall-contact",
] as const;

export type LampIrisNoOpRegion = (typeof LAMP_IRIS_NO_OP_REGIONS)[number];

export type LampIrisVisiblePeople = "single-person" | "multiple-people";

export interface LampIrisCorrectItem {
  /** One catalog category; each category may be approved at most once. */
  id: LampIrisCategory;
  intensity: LampIrisIntensity;
  /** Why this correction improves on-camera contact for this source. */
  rationale: string;
  /** What in the source footage motivates it (observed, not invented). */
  evidence: string;
}

export interface LampIrisDeclinedItem {
  id: LampIrisCategory;
  reason: string;
}

export interface LampIrisUncertainItem {
  id: LampIrisCategory;
  uncertainty: string;
  /** Uncertainty can never silently become permission to correct. */
  safeDefault: "decline";
}

export interface LampIrisNoOpJustification {
  reasonCode: "already-holds-contact";
  confidence: number;
  summary: string;
  regionEvidence: Array<{
    region: LampIrisNoOpRegion;
    finding: string;
  }>;
  whyCorrectionWouldNotImproveContact: string;
}

export type LampIrisPlanApproval =
  | { status: "draft" }
  | {
      status: "approved";
      approvedAt: number;
      approvedBy: "human";
    };

export interface LampIrisPlan {
  version: typeof LAMP_IRIS_PLAN_VERSION;
  id: string;
  runId: string;
  createdAt: number;
  sourceScope: {
    cameraMotion: "static";
    visiblePeople: LampIrisVisiblePeople;
  };
  decision: "correct" | "exceptional-no-op";
  /** Neutral description of the subject and their observed gaze behavior. */
  subjectSummary: string;
  correct: LampIrisCorrectItem[];
  declined: LampIrisDeclinedItem[];
  uncertain: LampIrisUncertainItem[];
  noOpJustification?: LampIrisNoOpJustification;
  approval: LampIrisPlanApproval;
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

function requiredCategory(value: unknown, path: string): LampIrisCategory {
  if (
    typeof value !== "string" ||
    !LAMP_IRIS_CATALOG.includes(value as LampIrisCategory)
  ) {
    throw new Error(
      `${path} must be one of the closed catalog categories: ${LAMP_IRIS_CATALOG.join(
        ", "
      )}.`
    );
  }
  return value as LampIrisCategory;
}

function canonicalCorrectItem(
  value: unknown,
  path: string
): LampIrisCorrectItem {
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
): LampIrisDeclinedItem {
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
): LampIrisUncertainItem {
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
): LampIrisNoOpJustification {
  if (!isRecord(value)) {
    throw new Error("noOpJustification is required for an exceptional no-op.");
  }
  if (value.reasonCode !== "already-holds-contact") {
    throw new Error(
      'noOpJustification.reasonCode must be "already-holds-contact".'
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
      !LAMP_IRIS_NO_OP_REGIONS.includes(entry.region as LampIrisNoOpRegion)
    ) {
      throw new Error(
        `noOpJustification.regionEvidence[${index}].region is invalid.`
      );
    }
    return {
      region: entry.region as LampIrisNoOpRegion,
      finding: requiredString(
        entry.finding,
        `noOpJustification.regionEvidence[${index}].finding`,
        { minWords: 4 }
      ),
    };
  });
  const seenRegions = new Set(regionEvidence.map((entry) => entry.region));
  const missingRegions = LAMP_IRIS_NO_OP_REGIONS.filter(
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
    reasonCode: "already-holds-contact",
    confidence: value.confidence,
    summary: requiredString(value.summary, "noOpJustification.summary", {
      minWords: 20,
    }),
    regionEvidence,
    whyCorrectionWouldNotImproveContact: requiredString(
      value.whyCorrectionWouldNotImproveContact,
      "noOpJustification.whyCorrectionWouldNotImproveContact",
      { minWords: 12 }
    ),
  };
}

function assertUniqueCategories(plan: {
  correct: LampIrisCorrectItem[];
  declined: LampIrisDeclinedItem[];
  uncertain: LampIrisUncertainItem[];
}): void {
  const seen = new Set<string>();
  for (const items of [plan.correct, plan.declined, plan.uncertain] as const) {
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
export function buildLampIrisPlan(input: {
  raw: unknown;
  planId: string;
  runId: string;
  createdAt: number;
}): LampIrisPlan {
  if (!isRecord(input.raw)) {
    throw new Error("Lamp Iris planner returned an invalid envelope.");
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
      "Lamp Iris v1 supports only static-camera source videos with at least one clearly visible person."
    );
  }
  const visiblePeople = input.raw.sourceScope
    .visiblePeople as LampIrisVisiblePeople;
  if (
    input.raw.decision !== "correct" &&
    input.raw.decision !== "exceptional-no-op"
  ) {
    throw new Error(
      'Iris-plan decision must be "correct" or "exceptional-no-op".'
    );
  }

  const correct = canonicalArray(
    input.raw.correct,
    "correct",
    canonicalCorrectItem
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
  assertUniqueCategories({ correct, declined, uncertain });

  const decision = input.raw.decision;
  let noOpJustification: LampIrisNoOpJustification | undefined;
  if (decision === "correct") {
    if (correct.length === 0) {
      throw new Error(
        "A correct decision requires at least one approved gaze correction; unchanged output is not the default."
      );
    }
    if (input.raw.noOpJustification !== undefined) {
      throw new Error(
        "A correct decision cannot carry an exceptional no-op justification."
      );
    }
  } else {
    if (correct.length > 0) {
      throw new Error("An exceptional no-op cannot contain corrections.");
    }
    if (uncertain.length > 0) {
      throw new Error(
        "An exceptional no-op cannot rely on unresolved uncertain items."
      );
    }
    noOpJustification = canonicalNoOpJustification(input.raw.noOpJustification);
  }

  return {
    version: LAMP_IRIS_PLAN_VERSION,
    id: planId,
    runId,
    createdAt: input.createdAt,
    sourceScope: {
      cameraMotion: "static",
      visiblePeople,
    },
    decision,
    subjectSummary: requiredString(input.raw.subjectSummary, "subjectSummary"),
    correct,
    declined,
    uncertain,
    ...(noOpJustification ? { noOpJustification } : {}),
    approval: { status: "draft" },
  };
}

/** Re-validate a persisted JSON value before it is trusted by the compiler. */
export function parseLampIrisPlan(value: unknown): LampIrisPlan {
  if (!isRecord(value) || value.version !== LAMP_IRIS_PLAN_VERSION) {
    throw new Error("Unknown Lamp Iris plan version.");
  }
  const draft = buildLampIrisPlan({
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
    throw new Error("Persisted iris-plan approval is invalid.");
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

export function isLampIrisPlan(value: unknown): value is LampIrisPlan {
  try {
    parseLampIrisPlan(value);
    return true;
  } catch {
    return false;
  }
}

/** The approval step is explicit and cannot be synthesized by the planner. */
export function approveLampIrisPlan(
  plan: LampIrisPlan,
  approvedAt: number
): LampIrisPlan {
  const canonical = parseLampIrisPlan(plan);
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

export function lampIrisPlanRequiresGeneration(plan: LampIrisPlan): boolean {
  return parseLampIrisPlan(plan).decision === "correct";
}

/**
 * The slider: one human-chosen level overrides every approved correction's
 * intensity before approval. It can dial planner-proposed work up or down,
 * and can never add a category, touch declined or uncertain entries, or
 * change anything else — the binding check below enforces exactly that.
 */
export function applyLampIrisIntensityOverride(
  plan: LampIrisPlan,
  intensity: LampIrisIntensity
): LampIrisPlan {
  const canonical = parseLampIrisPlan(plan);
  if (canonical.decision !== "correct") {
    throw new Error("An intensity override applies only to a correct decision.");
  }
  if (intensity !== 1 && intensity !== 2 && intensity !== 3) {
    throw new Error("Intensity override must be 1, 2, or 3.");
  }
  return {
    ...canonical,
    correct: canonical.correct.map((item) => ({ ...item, intensity })),
  };
}

function intensityNeutralProjection(plan: LampIrisPlan): unknown {
  const canonical = parseLampIrisPlan(plan);
  return {
    version: canonical.version,
    id: canonical.id,
    runId: canonical.runId,
    createdAt: canonical.createdAt,
    sourceScope: canonical.sourceScope,
    decision: canonical.decision,
    subjectSummary: canonical.subjectSummary,
    correct: canonical.correct.map((item) => ({ ...item, intensity: 1 })),
    declined: canonical.declined,
    uncertain: canonical.uncertain,
    ...(canonical.noOpJustification
      ? { noOpJustification: canonical.noOpJustification }
      : {}),
  };
}

/**
 * True when two plans are the same contract apart from approved-item
 * intensities — the only difference a human slider is allowed to introduce
 * between the planner's immutable draft and the approved copy.
 */
export function lampIrisPlansDifferOnlyByIntensity(
  a: LampIrisPlan,
  b: LampIrisPlan
): boolean {
  try {
    return (
      JSON.stringify(intensityNeutralProjection(a)) ===
      JSON.stringify(intensityNeutralProjection(b))
    );
  } catch {
    return false;
  }
}

function approvalHashProjection(plan: LampIrisPlan): unknown {
  return {
    version: plan.version,
    id: plan.id,
    runId: plan.runId,
    createdAt: plan.createdAt,
    sourceScope: plan.sourceScope,
    decision: plan.decision,
    subjectSummary: plan.subjectSummary,
    correct: plan.correct,
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
export async function hashLampIrisPlan(plan: LampIrisPlan): Promise<string> {
  const canonical = parseLampIrisPlan(plan);
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
export function createMockLampIrisPlan(
  runId: string,
  createdAt: number
): LampIrisPlan {
  return buildLampIrisPlan({
    planId: `lamp-iris-plan-${runId}`,
    runId,
    createdAt,
    raw: {
      sourceScope: {
        cameraMotion: "static",
        visiblePeople: "single-person",
      },
      decision: "correct",
      subjectSummary:
        "Static single-person webcam framing; the subject reads from material near the lens and the gaze anchors slightly below camera with periodic drops to notes.",
      correct: [
        {
          id: "camera-axis-anchor",
          intensity: 2,
          rationale:
            "Re-anchoring the resting gaze to the lens restores conversational presence.",
          evidence:
            "The gaze rests a few degrees below the lens for most of the take.",
        },
        {
          id: "note-glance-bridging",
          intensity: 2,
          rationale:
            "Bridging the recurring note-drops keeps contact through complete sentences.",
          evidence:
            "The eyes drop toward off-screen notes at several sentence starts.",
        },
      ],
      declined: [
        {
          id: "reading-scan-smoothing",
          reason: "No horizontal line-scanning pattern is visible in the take.",
        },
      ],
      uncertain: [],
    },
  });
}

/**
 * Prompt used to create the draft plan. The provider response is still
 * untrusted until `buildLampIrisPlan` validates it.
 */
export const LAMP_IRIS_PLAN_PROMPT = `You are the planning stage for Lamp Iris, a source-faithful eye-contact correction workflow for short static-camera webcam or interview videos.

GOAL
Infer that the user chose this workflow because they recorded themselves reading from a script, notes, or a teleprompter, and they want the delivered clip to read as natural eye contact with the camera — the same person, the same performance, the same take, with ONLY the gaze corrected. Inspect the COMPLETE source timeline, characterize where the eyes actually look and when, and propose bounded correction whenever it would genuinely lift on-camera contact. The catalog is closed:
- camera-axis-anchor: the headline correction. The subject's resting gaze anchors somewhere off the lens axis — a screen below or beside the camera, a prompter, printed notes — and the correction re-anchors that resting gaze to the true lens axis so the default state is contact.
- reading-scan-smoothing: while speaking, the eyes visibly track lines of text (horizontal scanning saccades, row-to-row drops). The correction replaces the scanning pattern with calm conversational steadiness toward the lens.
- note-glance-bridging: the eyes leave the camera in discrete glances — down or aside to notes — and return. The correction bridges those glances with continued contact so sentences are delivered to the viewer, not to the notes.

WHAT IS NEVER PROPOSABLE
Only gaze direction and the minimal eyelid pose implied by that direction may change. The head is never re-aimed and the body never re-posed. Blinks are sacred: every source blink stays at its source timestamp and no blink is added or removed. The mouth, speech articulation, and lip-sync are untouched. Expression, skin, hair, wardrobe, other people, the background, lighting, framing, and audio are all outside this workflow and impossible to authorize.

INTENSITY
Each approved item carries intensity 1, 2, or 3:
1 natural assist — correct only what clearly reads as script-reading; every natural glance-away, thinking look, and the full blink pattern survive. The subject may still read as occasionally consulting notes.
2 presenter — contact is the steady state through all spoken passages; brief natural breaks at phrase boundaries survive. Reads as a well-rehearsed presenter.
3 anchor — broadcast-anchor contact: eyes on the lens through effectively the whole take except blinks and momentary natural micro-breaks. Still alive, never a fixed stare.
The user chose this workflow because the reading pattern is distracting — an invisible result wastes the run. Default to intensity 2 on proposed items; reserve 1 for sources with only mild patterns and 3 for sources the user clearly recorded as to-camera pieces.
Overshoot is as real a failure as undershoot: a frozen, unblinking, glassy stare is worse than the original reading pattern.

SAFETY BOUNDARY
- Only the PRIMARY subject's gaze may be corrected. Every other visible person is fully protected.
- Iris color and texture, sclera, eye shape and size, lashes, brows, and catchlight character remain exactly as filmed — direction is the only permitted change, with natural eyelid travel.
- Anything you cannot establish confidently goes in uncertain with safeDefault "decline".
- This v1 workflow supports only a static camera with at least one clearly visible person.

NO-OP IS EXCEPTIONAL
Do not choose exceptional-no-op merely because the reading pattern is mild. Choose correct whenever at least one catalog item at intensity 1 would make the subject read as more present to the viewer. An exceptional no-op is valid only when the subject already holds natural, alive camera contact for essentially the whole take.

OUTPUT
Respond with strict JSON only. Use this schema:
{
  "sourceScope": {
    "cameraMotion": "static" | "moving" | "uncertain",
    "visiblePeople": "single-person" | "multiple-people" | "none" | "uncertain"
  },
  "decision": "correct" | "exceptional-no-op",
  "subjectSummary": "<neutral summary of the subject and where their gaze actually goes across the take>",
  "correct": [
    {
      "id": "<catalog category>",
      "intensity": 1 | 2 | 3,
      "rationale": "<why this correction improves on-camera contact>",
      "evidence": "<the observed gaze behavior that motivates it>"
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
    "reasonCode": "already-holds-contact",
    "confidence": <number from 0.95 to 1>,
    "summary": "<at least 20 words explaining why this rare exception is warranted>",
    "regionEvidence": [
      { "region": "camera-axis", "finding": "<specific finding>" },
      { "region": "reading-pattern", "finding": "<specific finding>" },
      { "region": "glances", "finding": "<specific finding>" },
      { "region": "blinks", "finding": "<specific finding>" },
      { "region": "overall-contact", "finding": "<specific finding>" }
    ],
    "whyCorrectionWouldNotImproveContact": "<at least 12 words>"
  }
}

Report the observed sourceScope honestly. Lamp Iris v1 will reject a moving camera and scenes where no person is clearly visible; single-person and multiple-people scenes are both supported. For correct, set noOpJustification to null and include at least one catalog item. For exceptional-no-op, provide the justification object, keep correct and uncertain empty, and include all five regionEvidence entries exactly once.`;
