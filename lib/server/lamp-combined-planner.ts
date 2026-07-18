import "server-only";

import {
  buildLampCombinedPlan,
  hashLampCombinedPlan,
  lampCombinedRequiredPlanners,
  parseLampCombinedControls,
  parseLampCombinedPlan,
  type LampCombinedControls,
  type LampCombinedPlan,
  type LampCombinedPlannerConcern,
} from "@/lib/lamp-combined";
import {
  lampCombinedPlanOperationId,
  lampCombinedPlanOperationIds,
  LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
  LAMP_COMBINED_BEAUTIFY_PLAN_OPERATION_ID,
  LAMP_COMBINED_IRIS_PLAN_OPERATION_ID,
} from "@/lib/lamp-combined-operations";
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

export interface LampCombinedPlanPreparation {
  plan: LampCombinedPlan;
  plannerOperationIds: string[];
  actualPlannerCostUsd: number;
  mock: boolean;
}

function controlsEqual(
  left: LampCombinedControls,
  right: LampCombinedControls
): boolean {
  return (
    left.beautifyLevel === right.beautifyLevel &&
    left.cleanlinessLevel === right.cleanlinessLevel &&
    left.eyeContact === right.eyeContact
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
    `Lamp Combined ${concern} planner journal is missing a ready artifact.`
  );
}

/** Provider-free fixture path used by mock Combined runs and domain tests. */
export function createMockLampCombinedPlan(input: {
  runId: string;
  controls: LampCombinedControls;
  createdAt?: number;
}): LampCombinedPlan {
  const controls = parseLampCombinedControls(input.controls);
  const createdAt = input.createdAt ?? Date.now();
  return buildLampCombinedPlan({
    planId: `lamp-combined-plan-${input.runId}`,
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
  value: LampCombinedPlan,
  runId: string,
  controls: LampCombinedControls
): LampCombinedPlan {
  const plan = parseLampCombinedPlan(value);
  if (plan.runId !== runId || !controlsEqual(plan.controls, controls)) {
    throw new Error(
      "The saved Combined plan does not match this run and exact control set."
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
        workflowMode: "combined",
        operationId: LAMP_COMBINED_BACKGROUND_PLAN_OPERATION_ID,
      })
    );
  }
  if (concern === "beautify") {
    return readyBeautify(
      await runLampBeautifyPlanner(runId, {
        workflowMode: "combined",
        operationId: LAMP_COMBINED_BEAUTIFY_PLAN_OPERATION_ID,
      })
    );
  }
  return readyIris(
    await runLampIrisPlanner(runId, {
      workflowMode: "combined",
      operationId: LAMP_COMBINED_IRIS_PLAN_OPERATION_ID,
    })
  );
}

/**
 * Run exactly the enabled planner calls and fold their drafts into one review
 * artifact. This function never approves the aggregate and never generates.
 */
export async function prepareLampCombinedPlan(input: {
  runId: string;
  controls: LampCombinedControls;
  mock: boolean;
}): Promise<LampCombinedPlanPreparation> {
  const controls = parseLampCombinedControls(input.controls);
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (!run) throw new Error("Run not found for Lamp Combined planning.");
  if (runWorkflowMode(run) !== "combined") {
    throw new Error("Only Lamp Combined runs may create an aggregate plan.");
  }
  if (!controlsEqual(parseLampCombinedControls(run.combinedControls), controls)) {
    throw new Error("Lamp Combined controls changed before planning.");
  }
  if (run.combinedPlan) {
    const plan = assertExistingDraft(run.combinedPlan, run.id, controls);
    let actualPlannerCostUsd = 0;
    if (!input.mock) {
      await assertLampCombinedPlannerJournals({
        runId: run.id,
        controls,
        plan,
      });
      const concerns = lampCombinedRequiredPlanners(controls);
      const operations = await Promise.all(
        lampCombinedPlanOperationIds(controls).map((operationId) =>
          storage.getPaidOperation(run.id, operationId)
        )
      );
      const artifacts = operations.map((operation, index) => {
        if (operation?.status !== "completed") {
          throw new Error(
            "A live Combined plan cannot bypass its completed planner journals."
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
      plannerOperationIds: lampCombinedPlanOperationIds(controls),
      actualPlannerCostUsd,
      mock: input.mock,
    };
  }
  if (input.mock) {
    return {
      plan: createMockLampCombinedPlan({ runId: run.id, controls }),
      plannerOperationIds: [],
      actualPlannerCostUsd: 0,
      mock: true,
    };
  }

  const concerns = lampCombinedRequiredPlanners(controls);
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
  const plan = buildLampCombinedPlan({
    planId: `lamp-combined-plan-${run.id}`,
    runId: run.id,
    createdAt,
    controls,
    backgroundPlan: background.plan,
    ...(beautify ? { beautifyPlan: beautify.plan } : {}),
    ...(iris ? { irisPlan: iris.plan } : {}),
  });
  return {
    plan,
    plannerOperationIds: concerns.map((concern) =>
      lampCombinedPlanOperationId(concern)
    ),
    actualPlannerCostUsd: artifacts.reduce(
      (sum, artifact) => sum + artifact.costUsd,
      0
    ),
    mock: false,
  };
}

/** Verify that every enabled planner journal is completed and type-safe. */
export async function assertLampCombinedPlannerJournals(input: {
  runId: string;
  controls: LampCombinedControls;
  plan?: LampCombinedPlan;
}): Promise<void> {
  const controls = parseLampCombinedControls(input.controls);
  const storage = getStorage();
  const run = await storage.getRun(input.runId);
  if (
    !run ||
    runWorkflowMode(run) !== "combined" ||
    !controlsEqual(parseLampCombinedControls(run.combinedControls), controls)
  ) {
    throw new Error(
      "Lamp Combined planner journals are not bound to this exact run and controls."
    );
  }
  const concerns = lampCombinedRequiredPlanners(controls);
  const artifacts = new Map<
    LampCombinedPlannerConcern,
    ReadyBackgroundArtifact | ReadyBeautifyArtifact | ReadyIrisArtifact
  >();
  for (const concern of concerns) {
    const operationId = lampCombinedPlanOperationId(concern);
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
        `Lamp Combined planner journal ${operationId} is missing or invalid.`
      );
    }
    artifacts.set(concern, readyPlannerArtifact(concern, operation.result));
  }
  for (const disabledConcern of (["beautify", "iris"] as const).filter(
    (concern) => !concerns.includes(concern)
  )) {
    const disabledOperationId = lampCombinedPlanOperationId(disabledConcern);
    if (await storage.getPaidOperation(input.runId, disabledOperationId)) {
      throw new Error(
        `Lamp Combined disabled planner journal ${disabledOperationId} must not exist.`
      );
    }
  }
  if (input.plan) {
    const aggregate = assertExistingDraft(input.plan, input.runId, controls);
    const background = artifacts.get("background") as ReadyBackgroundArtifact;
    const beautify = artifacts.get("beautify") as
      | ReadyBeautifyArtifact
      | undefined;
    const iris = artifacts.get("iris") as ReadyIrisArtifact | undefined;
    const reconstructed = buildLampCombinedPlan({
      planId: aggregate.id,
      runId: aggregate.runId,
      createdAt: aggregate.createdAt,
      controls,
      backgroundPlan: background.plan,
      ...(beautify ? { beautifyPlan: beautify.plan } : {}),
      ...(iris ? { irisPlan: iris.plan } : {}),
    });
    const [aggregateHash, reconstructedHash] = await Promise.all([
      hashLampCombinedPlan(aggregate),
      hashLampCombinedPlan(reconstructed),
    ]);
    if (aggregateHash !== reconstructedHash) {
      throw new Error(
        "Lamp Combined aggregate does not match its exact planner journals."
      );
    }
  }
}
