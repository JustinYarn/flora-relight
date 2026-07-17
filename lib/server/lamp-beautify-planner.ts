import "server-only";

import {
  GEMINI_PRO_MODEL,
  getGemini,
  resolveSourceUrl,
  uploadVideoCached,
} from "@/lib/server/gemini";
import {
  LAMP_BEAUTIFY_GEMINI_MAX_OUTPUT_TOKENS,
  geminiProCostFromUsage,
  requireGeminiProUsage,
} from "@/lib/cost";
import {
  buildLampBeautifyPlan,
  LAMP_BEAUTIFY_ACTIVE_CATALOG,
  LAMP_BEAUTIFY_NO_OP_REGIONS,
  LAMP_BEAUTIFY_PLAN_PROMPT,
  LAMP_BEAUTIFY_PLAN_VERSION,
  parseLampBeautifyPlan,
  type LampBeautifyPlan,
} from "@/lib/lamp-beautify";
import { lampBeautifyPlanOperationId } from "@/lib/lamp-beautify-operations";
import {
  beginPaidOperation,
  completePaidOperation,
  markPaidOperationReconcileRequired,
  paidOperationBlockedMessage,
} from "@/lib/server/paid-operation";
import { getStorage } from "@/lib/server/storage";
import { runWorkflowMode } from "@/lib/workflow-mode";
import type { GeminiProUsageSnapshot } from "@/lib/types";

export const LAMP_BEAUTIFY_PLAN_ARTIFACT_VERSION =
  "lamp-beautify-plan-artifact-v1" as const;

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

interface LampBeautifyPlanArtifactBase {
  version: typeof LAMP_BEAUTIFY_PLAN_ARTIFACT_VERSION;
  usage: GeminiProUsageSnapshot;
  costUsd: number;
}

export type LampBeautifyPlanArtifact =
  | (LampBeautifyPlanArtifactBase & {
      status: "ready";
      plan: LampBeautifyPlan;
    })
  | (LampBeautifyPlanArtifactBase & {
      status: "unsupported";
      sourceScope: ObservedSourceScope;
      reason: string;
    })
  | (LampBeautifyPlanArtifactBase & {
      status: "invalid";
      reason: string;
    });

const ENHANCE_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "intensity", "rationale", "evidence"],
  properties: {
    id: { type: "string", enum: [...LAMP_BEAUTIFY_ACTIVE_CATALOG] },
    intensity: { type: "integer", enum: [1, 2, 3] },
    rationale: { type: "string" },
    evidence: { type: "string" },
  },
} as const;

const DECLINED_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "reason"],
  properties: {
    id: { type: "string", enum: [...LAMP_BEAUTIFY_ACTIVE_CATALOG] },
    reason: { type: "string" },
  },
} as const;

const UNCERTAIN_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "uncertainty", "safeDefault"],
  properties: {
    id: { type: "string", enum: [...LAMP_BEAUTIFY_ACTIVE_CATALOG] },
    uncertainty: { type: "string" },
    safeDefault: { type: "string", enum: ["decline"] },
  },
} as const;

const PLAN_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "sourceScope",
    "decision",
    "subjectSummary",
    "enhance",
    "declined",
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
          enum: ["single-person", "multiple-people", "none", "uncertain"],
        },
      },
    },
    decision: {
      type: "string",
      enum: ["enhance", "exceptional-no-op"],
    },
    subjectSummary: { type: "string" },
    enhance: { type: "array", items: ENHANCE_ITEM_SCHEMA },
    declined: { type: "array", items: DECLINED_ITEM_SCHEMA },
    uncertain: { type: "array", items: UNCERTAIN_ITEM_SCHEMA },
    noOpJustification: {
      type: ["object", "null"],
      additionalProperties: false,
      required: [
        "reasonCode",
        "confidence",
        "summary",
        "regionEvidence",
        "whyEnhancementWouldNotImprovePresentation",
      ],
      properties: {
        reasonCode: {
          type: "string",
          enum: ["already-camera-ready"],
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
                enum: [...LAMP_BEAUTIFY_NO_OP_REGIONS],
              },
              finding: { type: "string" },
            },
          },
        },
        whyEnhancementWouldNotImprovePresentation: { type: "string" },
      },
    },
  },
} as const;

export function lampBeautifyPlanCanonicalInput(sourceUrl: string): unknown {
  return {
    version: LAMP_BEAUTIFY_PLAN_VERSION,
    model: GEMINI_PRO_MODEL,
    sourceUrl,
    prompt: LAMP_BEAUTIFY_PLAN_PROMPT,
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
    !["single-person", "multiple-people", "none", "uncertain"].includes(
      String(visiblePeople)
    )
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
}): LampBeautifyPlanArtifact {
  if (!isRecord(input.raw)) {
    return {
      version: LAMP_BEAUTIFY_PLAN_ARTIFACT_VERSION,
      status: "invalid",
      reason: "The planner returned an invalid response envelope.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
  const observed = sourceScope(input.raw.sourceScope);
  if (!observed) {
    return {
      version: LAMP_BEAUTIFY_PLAN_ARTIFACT_VERSION,
      status: "invalid",
      reason: "The planner did not report a valid source-scope assessment.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
  // Multiple people are in scope — only the primary subject is enhanced and
  // everyone else is fully locked. A moving camera or a scene without a
  // clearly visible person refuses.
  if (
    observed.cameraMotion !== "static" ||
    (observed.visiblePeople !== "single-person" &&
      observed.visiblePeople !== "multiple-people")
  ) {
    return {
      version: LAMP_BEAUTIFY_PLAN_ARTIFACT_VERSION,
      status: "unsupported",
      sourceScope: observed,
      reason:
        observed.cameraMotion !== "static"
          ? "Lamp Beautify v1 supports only a static camera."
          : "Lamp Beautify v1 requires at least one clearly visible person in the source.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
  const raw = { ...input.raw };
  if (raw.noOpJustification === null) {
    delete raw.noOpJustification;
  }
  try {
    const plan = buildLampBeautifyPlan({
      raw,
      planId: `lamp-beautify-plan-${input.runId}`,
      runId: input.runId,
      createdAt: input.createdAt,
    });
    return {
      version: LAMP_BEAUTIFY_PLAN_ARTIFACT_VERSION,
      status: "ready",
      plan,
      usage: input.usage,
      costUsd: input.costUsd,
    };
  } catch (error) {
    return {
      version: LAMP_BEAUTIFY_PLAN_ARTIFACT_VERSION,
      status: "invalid",
      reason:
        error instanceof Error
          ? error.message
          : "The planner returned an invalid enhancement plan.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
}

export function isLampBeautifyPlanArtifact(
  value: unknown
): value is LampBeautifyPlanArtifact {
  if (
    !isRecord(value) ||
    value.version !== LAMP_BEAUTIFY_PLAN_ARTIFACT_VERSION ||
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
        parseLampBeautifyPlan(value.plan).version ===
        LAMP_BEAUTIFY_PLAN_VERSION
      );
    } catch {
      return false;
    }
  }
  return typeof value.reason === "string" && value.reason.length > 0;
}

export async function runLampBeautifyPlanner(
  runId: string
): Promise<LampBeautifyPlanArtifact> {
  const storage = getStorage();
  const run = await storage.getRun(runId);
  if (!run) throw new Error("Run not found for Lamp Beautify planning.");
  if (runWorkflowMode(run) !== "beautify") {
    throw new Error("Only Lamp Beautify runs may create an enhancement plan.");
  }
  const operationId = lampBeautifyPlanOperationId();
  const claim = await beginPaidOperation({
    run,
    id: operationId,
    provider: "gemini",
    kind: "plan",
    canonicalInput: lampBeautifyPlanCanonicalInput(run.originalVideo.url),
  });
  if (claim.state === "cached") {
    if (!isLampBeautifyPlanArtifact(claim.operation.result)) {
      throw new Error("Cached Lamp Beautify plan has an invalid artifact.");
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
            { text: LAMP_BEAUTIFY_PLAN_PROMPT },
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
        maxOutputTokens: LAMP_BEAUTIFY_GEMINI_MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        responseJsonSchema: PLAN_RESPONSE_SCHEMA,
      },
    });
    if (!response.text) {
      throw new Error("Lamp Beautify planner returned no content.");
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
        : "Lamp Beautify planning returned an ambiguous result."
    );
    throw error;
  }
}
