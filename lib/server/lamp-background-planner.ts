import "server-only";

import {
  GEMINI_PRO_MODEL,
  getGemini,
  resolveSourceUrl,
  uploadVideoCached,
} from "@/lib/server/gemini";
import {
  LAMP_BACKGROUND_GEMINI_MAX_OUTPUT_TOKENS,
  geminiProCostFromUsage,
  requireGeminiProUsage,
} from "@/lib/cost";
import {
  buildLampBackgroundCleanupPlan,
  LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT,
  LAMP_BACKGROUND_CLEANUP_PLAN_VERSION,
  parseLampBackgroundCleanupPlan,
  type LampBackgroundCleanupPlan,
} from "@/lib/lamp-background";
import { lampBackgroundPlanOperationId } from "@/lib/lamp-background-operations";
import { LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID } from "@/lib/lamp-combined-operations";
import {
  beginPaidOperation,
  completePaidOperation,
  markPaidOperationReconcileRequired,
  paidOperationBlockedMessage,
} from "@/lib/server/paid-operation";
import { getStorage } from "@/lib/server/storage";
import { runWorkflowMode } from "@/lib/workflow-mode";
import type { GeminiProUsageSnapshot } from "@/lib/types";

export const LAMP_BACKGROUND_PLAN_ARTIFACT_VERSION =
  "lamp-background-plan-artifact-v1" as const;

type ObservedCameraMotion = "static" | "moving" | "uncertain";
type ObservedPeople =
  | "single-person"
  | "multiple-people"
  | "none"
  | "uncertain";

interface ObservedSourceScope {
  cameraMotion: ObservedCameraMotion;
  visiblePeople: ObservedPeople;
}

interface LampBackgroundPlanArtifactBase {
  version: typeof LAMP_BACKGROUND_PLAN_ARTIFACT_VERSION;
  usage: GeminiProUsageSnapshot;
  costUsd: number;
}

export type LampBackgroundPlanArtifact =
  | (LampBackgroundPlanArtifactBase & {
      status: "ready";
      plan: LampBackgroundCleanupPlan;
    })
  | (LampBackgroundPlanArtifactBase & {
      status: "unsupported";
      sourceScope: ObservedSourceScope;
      reason: string;
    })
  | (LampBackgroundPlanArtifactBase & {
      status: "invalid";
      reason: string;
    });

const PLAN_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "label",
    "location",
    "rationale",
    "temporalVisibility",
  ],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    location: { type: "string" },
    rationale: { type: "string" },
    temporalVisibility: {
      type: "string",
      enum: ["persistent", "intermittent", "partially-occluded"],
    },
  },
} as const;

const PLAN_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "sourceScope",
    "decision",
    "sceneSummary",
    "remove",
    "preserve",
    "uncertain",
    "noOpJustification",
  ],
  properties: {
    sourceScope: {
      type: "object",
      additionalProperties: false,
      required: ["cameraMotion", "visiblePeople"],
      properties: {
        cameraMotion: {
          type: "string",
          enum: ["static", "moving", "uncertain"],
        },
        visiblePeople: {
          type: "string",
          enum: [
            "single-person",
            "multiple-people",
            "none",
            "uncertain",
          ],
        },
      },
    },
    decision: {
      type: "string",
      enum: ["cleanup", "exceptional-no-op"],
    },
    sceneSummary: { type: "string" },
    remove: {
      type: "array",
      items: {
        ...PLAN_ITEM_SCHEMA,
        required: [...PLAN_ITEM_SCHEMA.required, "subjectInteraction"],
        properties: {
          ...PLAN_ITEM_SCHEMA.properties,
          subjectInteraction: {
            type: "string",
            enum: ["none-observed"],
          },
        },
      },
    },
    preserve: { type: "array", items: PLAN_ITEM_SCHEMA },
    uncertain: {
      type: "array",
      items: {
        ...PLAN_ITEM_SCHEMA,
        required: [
          ...PLAN_ITEM_SCHEMA.required,
          "uncertainty",
          "safeDefault",
        ],
        properties: {
          ...PLAN_ITEM_SCHEMA.properties,
          uncertainty: { type: "string" },
          safeDefault: { type: "string", enum: ["preserve"] },
        },
      },
    },
    noOpJustification: {
      type: ["object", "null"],
      additionalProperties: false,
      required: [
        "reasonCode",
        "confidence",
        "summary",
        "regionEvidence",
        "whyRemovalWouldNotImprovePresentation",
      ],
      properties: {
        reasonCode: {
          type: "string",
          enum: ["already-presentation-ready"],
        },
        confidence: { type: "number" },
        summary: { type: "string" },
        regionEvidence: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["region", "finding"],
            properties: {
              region: {
                type: "string",
                enum: [
                  "camera-left",
                  "camera-right",
                  "behind-subject",
                  "desk-foreground",
                  "frame-edges",
                ],
              },
              finding: { type: "string" },
            },
          },
        },
        whyRemovalWouldNotImprovePresentation: { type: "string" },
      },
    },
  },
} as const;

export function lampBackgroundPlanCanonicalInput(sourceUrl: string): unknown {
  return {
    version: LAMP_BACKGROUND_CLEANUP_PLAN_VERSION,
    model: GEMINI_PRO_MODEL,
    sourceUrl,
    prompt: LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT,
    responseSchema: PLAN_RESPONSE_SCHEMA,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceScope(value: unknown): ObservedSourceScope | null {
  if (!isRecord(value)) return null;
  const cameraMotion = value.cameraMotion;
  const visiblePeople = value.visiblePeople;
  if (
    !["static", "moving", "uncertain"].includes(String(cameraMotion)) ||
    ![
      "single-person",
      "multiple-people",
      "none",
      "uncertain",
    ].includes(String(visiblePeople))
  ) {
    return null;
  }
  return {
    cameraMotion: cameraMotion as ObservedCameraMotion,
    visiblePeople: visiblePeople as ObservedPeople,
  };
}

function artifactFromResponse(input: {
  raw: unknown;
  runId: string;
  createdAt: number;
  usage: GeminiProUsageSnapshot;
  costUsd: number;
}): LampBackgroundPlanArtifact {
  if (!isRecord(input.raw)) {
    return {
      version: LAMP_BACKGROUND_PLAN_ARTIFACT_VERSION,
      status: "invalid",
      reason: "The planner returned an invalid response envelope.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
  const observed = sourceScope(input.raw.sourceScope);
  if (!observed) {
    return {
      version: LAMP_BACKGROUND_PLAN_ARTIFACT_VERSION,
      status: "invalid",
      reason: "The planner did not report a valid source-scope assessment.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
  // Multiple people are in scope — every person is preserve-locked wholesale.
  // Only a moving camera or a scene without a clearly visible person refuses.
  if (
    observed.cameraMotion !== "static" ||
    (observed.visiblePeople !== "single-person" &&
      observed.visiblePeople !== "multiple-people")
  ) {
    return {
      version: LAMP_BACKGROUND_PLAN_ARTIFACT_VERSION,
      status: "unsupported",
      sourceScope: observed,
      reason:
        observed.cameraMotion !== "static"
          ? "Lamp Background v1 supports only a static camera."
          : "Lamp Background v1 requires at least one clearly visible person in the source.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
  const raw = { ...input.raw };
  if (raw.noOpJustification === null) {
    delete raw.noOpJustification;
  }
  try {
    const plan = buildLampBackgroundCleanupPlan({
      raw,
      planId: `lamp-background-plan-${input.runId}`,
      runId: input.runId,
      createdAt: input.createdAt,
    });
    return {
      version: LAMP_BACKGROUND_PLAN_ARTIFACT_VERSION,
      status: "ready",
      plan,
      usage: input.usage,
      costUsd: input.costUsd,
    };
  } catch (error) {
    return {
      version: LAMP_BACKGROUND_PLAN_ARTIFACT_VERSION,
      status: "invalid",
      reason:
        error instanceof Error
          ? error.message
          : "The planner returned an invalid cleanup plan.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
}

export function isLampBackgroundPlanArtifact(
  value: unknown
): value is LampBackgroundPlanArtifact {
  if (
    !isRecord(value) ||
    value.version !== LAMP_BACKGROUND_PLAN_ARTIFACT_VERSION ||
    !["ready", "unsupported", "invalid"].includes(String(value.status)) ||
    !isRecord(value.usage) ||
    !Number.isSafeInteger(value.usage.promptTokenCount) ||
    !Number.isSafeInteger(value.usage.candidatesTokenCount) ||
    typeof value.costUsd !== "number" ||
    !Number.isFinite(value.costUsd) ||
    value.costUsd < 0
  ) {
    return false;
  }
  if (value.status === "ready") {
    try {
      return (
        parseLampBackgroundCleanupPlan(value.plan).version ===
        LAMP_BACKGROUND_CLEANUP_PLAN_VERSION
      );
    } catch {
      return false;
    }
  }
  return typeof value.reason === "string" && value.reason.length > 0;
}

export async function runLampBackgroundPlanner(
  runId: string,
  combined?: {
    workflowMode: "combined";
    operationId: typeof LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID;
  }
): Promise<LampBackgroundPlanArtifact> {
  const storage = getStorage();
  const run = await storage.getRun(runId);
  if (!run) throw new Error("Run not found for Lamp Background planning.");
  const expectedMode = combined?.workflowMode ?? "background";
  if (runWorkflowMode(run) !== expectedMode) {
    throw new Error(
      combined
        ? "Only Lamp Combined runs may create this Combined cleanup subplan."
        : "Only Lamp Background runs may create a cleanup plan."
    );
  }
  const operationId = combined?.operationId ?? lampBackgroundPlanOperationId();
  const claim = await beginPaidOperation({
    run,
    id: operationId,
    provider: "gemini",
    kind: "plan",
    canonicalInput: lampBackgroundPlanCanonicalInput(
      run.originalVideo.url
    ),
  });
  if (claim.state === "cached") {
    if (!isLampBackgroundPlanArtifact(claim.operation.result)) {
      throw new Error("Cached Lamp Background plan has an invalid artifact.");
    }
    return claim.operation.result;
  }
  if (claim.state === "blocked") {
    throw new Error(paidOperationBlockedMessage(claim));
  }

  try {
    const sourcePath = await resolveSourceUrl(run.originalVideo.url);
    const upload = await uploadVideoCached(sourcePath);
    const response = await getGemini().models.generateContent({
      model: GEMINI_PRO_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: LAMP_BACKGROUND_CLEANUP_PLAN_PROMPT },
            {
              fileData: {
                fileUri: upload.uri,
                mimeType: "video/mp4",
              },
            },
          ],
        },
      ],
      config: {
        httpOptions: { retryOptions: { attempts: 1 } },
        maxOutputTokens: LAMP_BACKGROUND_GEMINI_MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        responseJsonSchema: PLAN_RESPONSE_SCHEMA,
      },
    });
    if (!response.text) {
      throw new Error("Lamp Background planner returned no content.");
    }
    const usage = requireGeminiProUsage(response.usageMetadata);
    const costUsd = geminiProCostFromUsage(usage);
    const artifact = artifactFromResponse({
      raw: JSON.parse(response.text),
      runId,
      createdAt: claim.operation.startedAt,
      usage,
      costUsd,
    });
    return completePaidOperation(claim.operation, artifact);
  } catch (error) {
    await markPaidOperationReconcileRequired(
      claim.operation,
      error instanceof Error
        ? error.message
        : "Lamp Background planning returned an ambiguous result."
    );
    throw error;
  }
}
