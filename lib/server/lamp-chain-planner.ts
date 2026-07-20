import "server-only";

import {
  buildLampChainPlan,
  hashLampChainPlan,
  lampChainRequiredPlanners,
  parseLampChainControls,
  parseLampChainPlan,
  type LampChainControls,
  type LampChainPlan,
} from "@/lib/lamp-chain";
import {
  lampChainPlanOperationId,
  lampChainPlanOperationIds,
  LAMP_CHAIN_BACKGROUND_PLAN_OPERATION_ID,
  LAMP_CHAIN_BEAUTIFY_PLAN_OPERATION_ID,
  LAMP_CHAIN_IRIS_PLAN_OPERATION_ID,
} from "@/lib/lamp-chain-operations";
import type { LampCombinedPlannerConcern } from "@/lib/lamp-combined";
import { createMockLampBackgroundCleanupPlan } from "@/lib/lamp-background";
import { createMockLampBeautifyPlan } from "@/lib/lamp-beautify";
import { createMockLampIrisPlan } from "@/lib/lamp-iris";
import { getStorage } from "@/lib/server/storage";
import {
  isLampBackgroundPlanArtifact,
  lampBackgroundPlanCanonicalInput,
  runLampBackgroundPlanner,
  type LampBackgroundPlanArtifact,
} from "@/lib/server/lamp-background-planner";
import {
  isLampBeautifyPlanArtifact,
  lampBeautifyPlanCanonicalInput,
  runLampBeautifyPlanner,
  type LampBeautifyPlanArtifact,
} from "@/lib/server/lamp-beautify-planner";
import {
  isLampIrisPlanArtifact,
  lampIrisPlanCanonicalInput,
  runLampIrisPlanner,
  type LampIrisPlanArtifact,
} from "@/lib/server/lamp-iris-planner";
import { runWorkflowMode } from "@/lib/workflow-mode";
import { paidOperationInputHash } from "@/lib/server/paid-operation";

type ReadyBackgroundArtifact = Extract<
  LampBackgroundPlanArtifact,
  { status: "ready" }
>;
type ReadyBeautifyArtifact = Extract<
  LampBeautifyPlanArtifact,
  { status: "ready" }
>;
type ReadyIrisArtifact = Extract<LampIrisPlanArtifact, { status: "ready" }>;

export interface LampChainPlanPreparation {
  plan: LampChainPlan;
  plannerOperationIds: string[];
  actualPlannerCostUsd: number;
  mock: boolean;
}

/** Chain equality is the Combined triple plus the exact stage order. */
function chainControlsEqual(
  left: LampChainControls,
  right: LampChainControls
): boolean {
  return (
    left.beautifyLevel === right.beautifyLevel &&
    left.cleanlinessLevel === right.cleanlinessLevel &&
    left.eyeContact === right.eyeContact &&
    left.stageOrder.length === right.stageOrder.length &&
    left.stageOrder.every((stage, index) => stage === right.stageOrder[index])
  );
}

function readyBackground(
  artifact: LampBackgroundPlanArtifact
): ReadyBackgroundArtifact {
  if (artifact.status !== "ready") throw new Error(artifact.reason);
  return artifact;
}

function readyBeautify(
  artifact: LampBeautifyPlanArtifact
): ReadyBeautifyArtifact {
  if (artifact.status !== "ready") throw new Error(artifact.reason);
  return artifact;
}

function readyIris(artifact: LampIrisPlanArtifact): ReadyIrisArtifact {
  if (artifact.status !== "ready") throw new Error(artifact.reason);
  return artifact;
}

function readyPlannerArtifact(
  concern: LampCombinedPlannerConcern,
  value: unknown
): ReadyBackgroundArtifact | ReadyBeautifyArtifact | ReadyIrisArtifact {
  if (
    concern === "background" &&
    isLampBackgroundPlanArtifact(value) &&
    value.status === "ready"
  ) {
    return value;
  }
  if (
    concern === "beautify" &&
    isLampBeautifyPlanArtifact(value) &&
    value.status === "ready"
  ) {
    return value;
  }
  if (
    concern === "iris" &&
    isLampIrisPlanArtifact(value) &&
    value.status === "ready"
  ) {
    return value;
  }
  throw new Error(
    `Lamp Chain ${concern} planner journal is missing a ready artifact.`
  );
}

/** Provider-free fixture path used by mock Chain runs and domain tests. */
export function createMockLampChainPlan(input: {
  runId: string;
  controls: LampChainControls;
  createdAt?: number;
}): LampChainPlan {
  const controls = parseLampChainControls(input.controls);
  const createdAt = input.createdAt ?? Date.now();
  return buildLampChainPlan({
    planId: `lamp-chain-plan-${input.runId}`,
    runId: input.runId,
    createdAt,
    controls,
    backgroundPlan: createMockLampBackgroundCleanupPlan(
      input.runId,
      createdAt
    ),
    ...(controls.beautifyLevel > 0
      ? { beautifyPlan: createMockLampBeautifyPlan(input.runId, createdAt) }
      : {}),
    ...(controls.eyeContact
      ? { irisPlan: createMockLampIrisPlan(input.runId, createdAt) }
      : {}),
  });
}

function assertExistingDraft(
  value: LampChainPlan,
  runId: string,
  controls: LampChainControls
): LampChainPlan {
  const plan = parseLampChainPlan(value);
  if (
    plan.aggregate.runId !== runId ||
    !chainControlsEqual(
      { ...plan.aggregate.controls, stageOrder: plan.stageOrder },
      controls
    )
  ) {
    throw new Error(
      "The saved Chain plan does not match this run and exact control set."
    );
  }
  return plan;
}

async function runEnabledPlanner(
  concern: LampCombinedPlannerConcern,
  runId: string
): Promise<
  ReadyBackgroundArtifact | ReadyBeautifyArtifact | ReadyIrisArtifact
> {
  if (concern === "background") {
    return readyBackground(
      await runLampBackgroundPlanner(runId, {
        workflowMode: "chain",
        operationId: LAMP_CHAIN_BACKGROUND_PLAN_OPERATION_ID,
      })
    );
  }
  if (concern === "beautify") {
    return readyBeautify(
      await runLampBeautifyPlanner(runId, {
        workflowMode: "chain",
        operationId: LAMP_CHAIN_BEAUTIFY_PLAN_OPERATION_ID,
      })
    );
  }
  return readyIris(
    await runLampIrisPlanner(runId, {
      workflowMode: "chain",
      operationId: LAMP_CHAIN_IRIS_PLAN_OPERATION_ID,
    })
  );
}

/**
 * Persist a freshly folded aggregate. A concurrent identical planning request
 * may have stored its fold first; the stored draft wins so both callers hand
 * one hash to review.
 */
async function persistChainPlan(
  runId: string,
  controls: LampChainControls,
  plan: LampChainPlan
): Promise<LampChainPlan> {
  const storage = getStorage();
  const current = await storage.getRun(runId);
  if (
    !current ||
    runWorkflowMode(current) !== "chain" ||
    !chainControlsEqual(parseLampChainControls(current.chainControls), controls)
  ) {
    throw new Error(
      "Lamp Chain run changed while its aggregate draft was being saved."
    );
  }
  if (current.chainPlan) {
    return assertExistingDraft(current.chainPlan, runId, controls);
  }
  await storage.putRun({ ...current, chainPlan: plan });
  return plan;
}

/**
 * Run exactly the enabled planner calls and fold their drafts into one
 * order-bearing review artifact. This function never approves the aggregate
 * and never generates.
 */
export async function prepareLampChainPlan(input: {
  runId: string;
  controls: LampChainControls;
  mock: boolean;
}): Promise<LampChainPlanPreparation> {
  const controls = parseLampChainControls(input.controls);
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (!run) throw new Error("Run not found for Lamp Chain planning.");
  if (runWorkflowMode(run) !== "chain") {
    throw new Error("Only Lamp Chain runs may create a chain plan.");
  }
  if (!chainControlsEqual(parseLampChainControls(run.chainControls), controls)) {
    throw new Error("Lamp Chain controls changed before planning.");
  }
  if (run.chainPlan) {
    const plan = assertExistingDraft(run.chainPlan, run.id, controls);
    let actualPlannerCostUsd = 0;
    if (!input.mock) {
      await assertLampChainPlannerJournals({
        runId: run.id,
        controls,
        plan,
      });
      const concerns = lampChainRequiredPlanners(controls);
      const operations = await Promise.all(
        lampChainPlanOperationIds(controls).map((operationId) =>
          storage.getPaidOperation(run.id, operationId)
        )
      );
      const artifacts = operations.map((operation, index) => {
        if (operation?.status !== "completed") {
          throw new Error(
            "A live Chain plan cannot bypass its completed planner journals."
          );
        }
        return readyPlannerArtifact(concerns[index]!, operation.result);
      });
      actualPlannerCostUsd = artifacts.reduce(
        (sum, artifact) => sum + artifact.costUsd,
        0
      );
    }
    return {
      plan,
      plannerOperationIds: lampChainPlanOperationIds(controls),
      actualPlannerCostUsd,
      mock: input.mock,
    };
  }
  if (input.mock) {
    const plan = await persistChainPlan(
      run.id,
      controls,
      createMockLampChainPlan({ runId: run.id, controls })
    );
    return {
      plan,
      plannerOperationIds: [],
      actualPlannerCostUsd: 0,
      mock: true,
    };
  }

  const concerns = lampChainRequiredPlanners(controls);
  const artifacts = await Promise.all(
    concerns.map((concern) => runEnabledPlanner(concern, run.id))
  );
  const byConcern = new Map(
    concerns.map((concern, index) => [concern, artifacts[index]!])
  );
  const background = byConcern.get("background") as ReadyBackgroundArtifact;
  const beautify = byConcern.get("beautify") as
    | ReadyBeautifyArtifact
    | undefined;
  const iris = byConcern.get("iris") as ReadyIrisArtifact | undefined;
  const createdAt = Math.max(Date.now(), ...artifacts.map((item) => item.plan.createdAt));
  const plan = await persistChainPlan(
    run.id,
    controls,
    buildLampChainPlan({
      planId: `lamp-chain-plan-${run.id}`,
      runId: run.id,
      createdAt,
      controls,
      backgroundPlan: background.plan,
      ...(beautify ? { beautifyPlan: beautify.plan } : {}),
      ...(iris ? { irisPlan: iris.plan } : {}),
    })
  );
  return {
    plan,
    plannerOperationIds: concerns.map((concern) =>
      lampChainPlanOperationId(concern)
    ),
    actualPlannerCostUsd: artifacts.reduce(
      (sum, artifact) => sum + artifact.costUsd,
      0
    ),
    mock: false,
  };
}

/** Verify that every enabled planner journal is completed and type-safe. */
export async function assertLampChainPlannerJournals(input: {
  runId: string;
  controls: LampChainControls;
  plan?: LampChainPlan;
}): Promise<void> {
  const controls = parseLampChainControls(input.controls);
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (
    !run ||
    runWorkflowMode(run) !== "chain" ||
    !chainControlsEqual(parseLampChainControls(run.chainControls), controls)
  ) {
    throw new Error(
      "Lamp Chain planner journals are not bound to this exact run and controls."
    );
  }
  const concerns = lampChainRequiredPlanners(controls);
  const artifacts = new Map<
    LampCombinedPlannerConcern,
    ReadyBackgroundArtifact | ReadyBeautifyArtifact | ReadyIrisArtifact
  >();
  for (const concern of concerns) {
    const operationId = lampChainPlanOperationId(concern);
    const operation = await storage.getPaidOperation(input.runId, operationId);
    const canonicalInput =
      concern === "background"
        ? lampBackgroundPlanCanonicalInput(run.originalVideo.url)
        : concern === "beautify"
          ? lampBeautifyPlanCanonicalInput(run.originalVideo.url)
          : lampIrisPlanCanonicalInput(run.originalVideo.url);
    if (
      operation?.status !== "completed" ||
      operation.id !== operationId ||
      operation.runId !== run.id ||
      operation.provider !== "gemini" ||
      operation.kind !== "plan" ||
      operation.inputHash !==
        paidOperationInputHash({ operationId, payload: canonicalInput })
    ) {
      throw new Error(
        `Lamp Chain planner journal ${operationId} is missing or invalid.`
      );
    }
    artifacts.set(concern, readyPlannerArtifact(concern, operation.result));
  }
  for (const disabledConcern of (["beautify", "iris"] as const).filter(
    (concern) => !concerns.includes(concern)
  )) {
    const disabledOperationId = lampChainPlanOperationId(disabledConcern);
    if (await storage.getPaidOperation(input.runId, disabledOperationId)) {
      throw new Error(
        `Lamp Chain disabled planner journal ${disabledOperationId} must not exist.`
      );
    }
  }
  if (input.plan) {
    const presented = assertExistingDraft(input.plan, input.runId, controls);
    if (!run.chainPlan) {
      throw new Error("Lamp Chain aggregate is not persisted on this run.");
    }
    const stored = assertExistingDraft(run.chainPlan, input.runId, controls);
    const background = artifacts.get("background") as ReadyBackgroundArtifact;
    const beautify = artifacts.get("beautify") as
      | ReadyBeautifyArtifact
      | undefined;
    const iris = artifacts.get("iris") as ReadyIrisArtifact | undefined;
    const reconstructed = buildLampChainPlan({
      planId: stored.aggregate.id,
      runId: stored.aggregate.runId,
      createdAt: stored.aggregate.createdAt,
      controls,
      backgroundPlan: background.plan,
      ...(beautify ? { beautifyPlan: beautify.plan } : {}),
      ...(iris ? { irisPlan: iris.plan } : {}),
    });
    const [presentedHash, storedHash, reconstructedHash] = await Promise.all([
      hashLampChainPlan(presented),
      hashLampChainPlan(stored),
      hashLampChainPlan(reconstructed),
    ]);
    if (storedHash !== reconstructedHash || presentedHash !== storedHash) {
      throw new Error(
        "Lamp Chain aggregate does not match its exact planner journals."
      );
    }
  }
}
