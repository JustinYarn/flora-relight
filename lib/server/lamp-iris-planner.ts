import "server-only";

import {
  GEMINI_PRO_MODEL,
  getGemini,
  resolveSourceUrl,
  uploadVideoCached,
} from "@/lib/server/gemini";
import {
  LAMP_IRIS_GEMINI_MAX_OUTPUT_TOKENS,
  geminiProCostFromUsage,
  requireGeminiProUsage,
} from "@/lib/cost";
import {
  buildLampIrisPlan,
  LAMP_IRIS_ACTIVE_CATALOG,
  LAMP_IRIS_NO_OP_REGIONS,
  LAMP_IRIS_PLAN_PROMPT,
  LAMP_IRIS_PLAN_VERSION,
  parseLampIrisPlan,
  type LampIrisPlan,
} from "@/lib/lamp-iris";
import { lampIrisPlanOperationId } from "@/lib/lamp-iris-operations";
import { LAMP_COMBINED_IRIS_PLAN_OPERATION_ID } from "@/lib/lamp-combined-operations";
import { LAMP_CHAIN_IRIS_PLAN_OPERATION_ID } from "@/lib/lamp-chain-operations";
import {
  beginPaidOperation,
  completePaidOperation,
  markPaidOperationReconcileRequired,
  paidOperationBlockedMessage,
} from "@/lib/server/paid-operation";
import { getStorage } from "@/lib/server/storage";
import { runWorkflowMode } from "@/lib/workflow-mode";
import type { GeminiProUsageSnapshot } from "@/lib/types";

export const LAMP_IRIS_PLAN_ARTIFACT_VERSION =
  "lamp-iris-plan-artifact-v1" as const;

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

interface LampIrisPlanArtifactBase {
  version: typeof LAMP_IRIS_PLAN_ARTIFACT_VERSION;
  usage: GeminiProUsageSnapshot;
  costUsd: number;
}

export type LampIrisPlanArtifact =
  | (LampIrisPlanArtifactBase & {
      status: "ready";
      plan: LampIrisPlan;
    })
  | (LampIrisPlanArtifactBase & {
      status: "unsupported";
      sourceScope: ObservedSourceScope;
      reason: string;
    })
  | (LampIrisPlanArtifactBase & {
      status: "invalid";
      reason: string;
    });

const CORRECT_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "intensity", "rationale", "evidence"],
  properties: {
    id: { type: "string", enum: [...LAMP_IRIS_ACTIVE_CATALOG] },
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
    id: { type: "string", enum: [...LAMP_IRIS_ACTIVE_CATALOG] },
    reason: { type: "string" },
  },
} as const;

const UNCERTAIN_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "uncertainty", "safeDefault"],
  properties: {
    id: { type: "string", enum: [...LAMP_IRIS_ACTIVE_CATALOG] },
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
    "correct",
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
      enum: ["correct", "exceptional-no-op"],
    },
    subjectSummary: { type: "string" },
    correct: { type: "array", items: CORRECT_ITEM_SCHEMA },
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
        "whyCorrectionWouldNotImproveContact",
      ],
      properties: {
        reasonCode: {
          type: "string",
          enum: ["already-holds-contact"],
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
                enum: [...LAMP_IRIS_NO_OP_REGIONS],
              },
              finding: { type: "string" },
            },
          },
        },
        whyCorrectionWouldNotImproveContact: { type: "string" },
      },
    },
  },
} as const;

export function lampIrisPlanCanonicalInput(sourceUrl: string): unknown {
  return {
    version: LAMP_IRIS_PLAN_VERSION,
    model: GEMINI_PRO_MODEL,
    sourceUrl,
    prompt: LAMP_IRIS_PLAN_PROMPT,
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
}): LampIrisPlanArtifact {
  if (!isRecord(input.raw)) {
    return {
      version: LAMP_IRIS_PLAN_ARTIFACT_VERSION,
      status: "invalid",
      reason: "The planner returned an invalid response envelope.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
  const observed = sourceScope(input.raw.sourceScope);
  if (!observed) {
    return {
      version: LAMP_IRIS_PLAN_ARTIFACT_VERSION,
      status: "invalid",
      reason: "The planner did not report a valid source-scope assessment.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
  // Multiple people are in scope — only the primary subject is corrected and
  // everyone else is fully locked. A moving camera or a scene without a
  // clearly visible person refuses.
  if (
    observed.cameraMotion !== "static" ||
    (observed.visiblePeople !== "single-person" &&
      observed.visiblePeople !== "multiple-people")
  ) {
    return {
      version: LAMP_IRIS_PLAN_ARTIFACT_VERSION,
      status: "unsupported",
      sourceScope: observed,
      reason:
        observed.cameraMotion !== "static"
          ? "Lamp Iris v1 supports only a static camera."
          : "Lamp Iris v1 requires at least one clearly visible person in the source.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
  const raw = { ...input.raw };
  if (raw.noOpJustification === null) {
    delete raw.noOpJustification;
  }
  try {
    const plan = buildLampIrisPlan({
      raw,
      planId: `lamp-iris-plan-${input.runId}`,
      runId: input.runId,
      createdAt: input.createdAt,
    });
    return {
      version: LAMP_IRIS_PLAN_ARTIFACT_VERSION,
      status: "ready",
      plan,
      usage: input.usage,
      costUsd: input.costUsd,
    };
  } catch (error) {
    return {
      version: LAMP_IRIS_PLAN_ARTIFACT_VERSION,
      status: "invalid",
      reason:
        error instanceof Error
          ? error.message
          : "The planner returned an invalid gaze-correction plan.",
      usage: input.usage,
      costUsd: input.costUsd,
    };
  }
}

export function isLampIrisPlanArtifact(
  value: unknown
): value is LampIrisPlanArtifact {
  if (
    !isRecord(value) ||
    value.version !== LAMP_IRIS_PLAN_ARTIFACT_VERSION ||
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
        parseLampIrisPlan(value.plan).version ===
        LAMP_IRIS_PLAN_VERSION
      );
    } catch {
      return false;
    }
  }
  return typeof value.reason === "string" && value.reason.length > 0;
}

export async function runLampIrisPlanner(
  runId: string,
  combined?: {
    workflowMode: "combined" | "chain";
    operationId:
      | typeof LAMP_COMBINED_IRIS_PLAN_OPERATION_ID
      | typeof LAMP_CHAIN_IRIS_PLAN_OPERATION_ID;
  }
): Promise<LampIrisPlanArtifact> {
  const storage = getStorage();
  const run = await storage.getRun(runId);
  if (!run) throw new Error("Run not found for Lamp Iris planning.");
  const expectedMode = combined?.workflowMode ?? "iris";
  if (runWorkflowMode(run) !== expectedMode) {
    throw new Error(
      combined
        ? "Only Lamp Combined runs may create this Combined gaze subplan."
        : "Only Lamp Iris runs may create a gaze-correction plan."
    );
  }
  const operationId = combined?.operationId ?? lampIrisPlanOperationId();
  const claim = await beginPaidOperation({
    run,
    id: operationId,
    provider: "gemini",
    kind: "plan",
    canonicalInput: lampIrisPlanCanonicalInput(run.originalVideo.url),
  });
  if (claim.state === "cached") {
    if (!isLampIrisPlanArtifact(claim.operation.result)) {
      throw new Error("Cached Lamp Iris plan has an invalid artifact.");
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
            { text: LAMP_IRIS_PLAN_PROMPT },
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
        maxOutputTokens: LAMP_IRIS_GEMINI_MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        responseJsonSchema: PLAN_RESPONSE_SCHEMA,
      },
    });
    if (!response.text) {
      throw new Error("Lamp Iris planner returned no content.");
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
        : "Lamp Iris planning returned an ambiguous result."
    );
    throw error;
  }
}
