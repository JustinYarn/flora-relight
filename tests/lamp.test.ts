import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildLampEvaluationArtifact,
  compileLampFinalPrompt,
  evalDefsForRun,
  getLampEvalDef,
  isLampEvaluationArtifact,
  lampCompositeForResults,
  lampWholeVideoRubric,
  projectLampEvaluationForRead,
  LAMP_EVAL_DEFS,
  LAMP_EVAL_IDS,
  LAMP_EVALUATOR_VERSION,
  LAMP_LEGACY_EVALUATOR_VERSION,
  LAMP_VISUAL_EVAL_DEFS,
  type LampEvaluationArtifact,
} from "../lib/lamp-evaluation.ts";
import { EVAL_DEFS, getEvalDef } from "../lib/prompts/eval-defs.ts";
import {
  estimateLampRun,
  LAMP_EVALUATION_COUNT,
  LAMP_GENERATION_COUNT,
  PRICE_TABLE,
} from "../lib/cost.ts";
import { initialMegaPrompt } from "../lib/prompts/mega-prompt.ts";
import { LAMP_RELIGHT_BASE_PROMPT } from "../lib/prompts/base-prompt.ts";
import {
  collectComparisons,
  aiPassRatePct,
  finalLampIteration,
  isGradeable,
  needsLampHumanGrade,
} from "../components/grade/derive.ts";
import type { BatchExecution, Run, VideoAsset } from "../lib/types.ts";
import {
  isLampApprovalReplayTransition,
  LAMP_USER_ACTION_REQUIRED_PREFIX,
  requeueLampExecutionAfterApproval,
} from "../lib/server/run-execution-resume.ts";
import type { RunExecution } from "../lib/types.ts";
import {
  batchApprovalScope,
  batchCompletionIteration,
  batchExecutionId,
  batchMemberExecutionId,
  batchMaximumIterations,
  normalizedWorkflowMode,
} from "../lib/server/batch-contract.ts";
import {
  microsToUsd,
  planBatchBudget,
} from "../lib/server/batch-budget.ts";
import {
  assertPaidOperationAuthorized,
  createSpendApproval,
  hasReusableLampApproval,
  lampMaximumMicros,
} from "../lib/server/spend-approval.ts";
import { LIPSYNC_OPERATION_ID } from "../lib/v2-sync.ts";
import {
  assertBatchExecutionTransition,
  assertNewBatchExecution,
} from "../lib/server/storage/batch-execution.ts";
import { confirmedLampBatchActualMicros } from "../lib/server/lamp-batch-accounting.ts";
import {
  isLampBatchApprovalReplayTransition,
  LAMP_BATCH_USER_ACTION_REQUIRED_PREFIX,
  requeueLampBatchExecutionAfterApproval,
} from "../lib/server/batch-execution-resume.ts";

const EXPECTED_VISUAL_EVAL_IDS = [
  "identity-preservation",
  "skin-texture-age",
  "appearance-fidelity",
  "background-fidelity",
  "lighting-quality-delta",
  "motion-lipsync",
  "temporal-stability",
  "hallucination-artifacts",
] as const;

const GEMINI_USAGE = {
  promptTokenCount: 10_000,
  candidatesTokenCount: 1_000,
  thoughtsTokenCount: 500,
  totalTokenCount: 11_500,
};

function rawVisualResults() {
  return EXPECTED_VISUAL_EVAL_IDS.map((evalId, index) => ({
    evalId,
    score: 80 + index,
    confidence: 0.9,
    violations: [
      {
        aspect: `fixture-aspect-${index + 1}`,
        severity: index === 0 ? "critical" : "major",
        description: `Fixture finding ${index + 1}`,
        correction: `Apply fixture correction ${index + 1}.`,
      },
    ],
    reasoning: `Fixture reasoning ${index + 1}.`,
  }));
}

test("Lamp rejects a holistic evaluation with a missing visual check", () => {
  const results = rawVisualResults();
  results.pop();

  assert.throws(
    () =>
      buildLampEvaluationArtifact({
        raw: { results },
        iteration: 1,
        audioVerified: true,
        usage: GEMINI_USAGE,
        costUsd: 0.02,
      }),
    /omitted required checks: hallucination-artifacts/
  );
});

test("Lamp rejects a holistic evaluation with a duplicate visual check", () => {
  const results = rawVisualResults();
  results.push({ ...results[0] });

  assert.throws(
    () =>
      buildLampEvaluationArtifact({
        raw: { results },
        iteration: 1,
        audioVerified: true,
        usage: GEMINI_USAGE,
        costUsd: 0.02,
      }),
    /duplicate result identity-preservation/
  );
});

test("Lamp accepts a non-passing check without an actionable correction", () => {
  const results = rawVisualResults();
  results[0] = { ...results[0], score: 40, violations: [] };

  const artifact = buildLampEvaluationArtifact({
    raw: { results },
    iteration: 1,
    audioVerified: true,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });

  const unactionable = artifact.evalResults.find(
    (result) => result.evalId === "identity-preservation"
  );
  assert.equal(unactionable?.verdict, "fail");
  assert.equal(unactionable?.score, 40);
  assert.deepEqual(unactionable?.violations, []);

  // The violationless fail contributes no correction; every other fixture
  // correction still compiles into the one v2 prompt.
  const finalPrompt = compileLampFinalPrompt(
    initialMegaPrompt().rendered,
    artifact
  );
  assert.equal(
    finalPrompt.corrections.filter((correction) => !correction.resolved).length,
    EXPECTED_VISUAL_EVAL_IDS.length - 1
  );
  assert.doesNotMatch(finalPrompt.rendered, /Apply fixture correction 1\./);
});

test("Lamp compiles a valid v2 prompt when no check yields any correction", () => {
  const results = rawVisualResults().map((result) => ({
    ...result,
    score: 40,
    violations: [],
  }));

  const artifact = buildLampEvaluationArtifact({
    raw: { results },
    iteration: 1,
    audioVerified: true,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });
  assert.ok(
    artifact.evalResults
      .filter((result) => result.evalId !== "audio-integrity")
      .every((result) => result.verdict === "fail")
  );

  const finalPrompt = compileLampFinalPrompt(
    initialMegaPrompt().rendered,
    artifact
  );
  assert.equal(finalPrompt.version, 2);
  assert.match(finalPrompt.rendered, /LAMP RELIGHT MEGA PROMPT v2/);
  assert.match(
    finalPrompt.rendered,
    /\(none — first iteration or all prior findings resolved\)/
  );
  assert.equal(
    finalPrompt.corrections.filter((correction) => !correction.resolved).length,
    0
  );
});

test("Lamp accepts exactly eight visual results and appends verified audio", () => {
  assert.equal(LAMP_VISUAL_EVAL_DEFS.length, 8);
  assert.deepEqual(
    LAMP_VISUAL_EVAL_DEFS.map((definition) => definition.id),
    EXPECTED_VISUAL_EVAL_IDS
  );

  const artifact = buildLampEvaluationArtifact({
    raw: { results: rawVisualResults() },
    iteration: 1,
    audioVerified: true,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });

  assert.equal(artifact.evalResults.length, 9);
  assert.deepEqual(
    artifact.evalResults.map((result) => result.evalId),
    [...EXPECTED_VISUAL_EVAL_IDS, "audio-integrity"]
  );
  assert.equal(artifact.evalResults.at(-1)?.score, 100);
  assert.equal(artifact.evalResults.at(-1)?.verdict, "pass");
  assert.ok(artifact.evalResults.every((result) => result.iteration === 1));
});

test("Lamp owns exactly nine grading rows while Flora retains eleven", () => {
  assert.equal(LAMP_EVAL_DEFS.length, 9);
  assert.deepEqual(
    LAMP_EVAL_DEFS.map((definition) => definition.id),
    LAMP_EVAL_IDS
  );
  assert.equal(LAMP_EVAL_DEFS.some((definition) => definition.id === "temporal-alignment"), false);
  assert.equal(
    LAMP_EVAL_DEFS.some(
      (definition) => definition.id === "lighting-match-to-anchor"
    ),
    false
  );
  assert.equal(EVAL_DEFS.length, 11);
  assert.equal(EVAL_DEFS.some((definition) => definition.id === "temporal-alignment"), true);
  assert.equal(
    EVAL_DEFS.some((definition) => definition.id === "lighting-match-to-anchor"),
    true
  );
});

test("Lamp whole-video rubrics contain no retired Lamp checks", () => {
  const rendered = LAMP_VISUAL_EVAL_DEFS.map(lampWholeVideoRubric).join("\n");
  assert.doesNotMatch(rendered, /temporal-alignment/);
  assert.doesNotMatch(rendered, /lighting-match-to-anchor/);
  assert.doesNotMatch(rendered, /^INPUTS$/m);
  assert.doesNotMatch(rendered, /^OUTPUT$/m);
});

test("Lamp skin allows only extremely subtle beautification at 85/70 boundaries", () => {
  const expected = new Map([
    [85, "pass"],
    [84, "borderline"],
    [70, "borderline"],
    [69, "fail"],
  ]);
  for (const [score, verdict] of expected) {
    const artifact = buildLampEvaluationArtifact({
      raw: {
        results: rawVisualResults().map((result) => ({
          ...result,
          score: result.evalId === "skin-texture-age" ? score : 100,
          violations: [],
        })),
      },
      iteration: 1,
      audioVerified: true,
      usage: GEMINI_USAGE,
      costUsd: 0.02,
    });
    const skin = artifact.evalResults.find(
      (result) => result.evalId === "skin-texture-age"
    );
    assert.equal(skin?.verdict, verdict, `score ${score}`);
    const composite = lampCompositeForResults(artifact.evalResults);
    assert.equal(
      composite?.hardGateFailures.includes("skin-texture-age"),
      score < 85,
      `score ${score}`
    );
  }

  const skin = getLampEvalDef("skin-texture-age");
  assert.equal(skin.passThreshold, 85);
  assert.equal(skin.borderlineThreshold, 70);
  assert.match(skin.promptTemplate, /PRESENCE and POSITION/);
  assert.match(skin.promptTemplate, /Brighter or lower-contrast skin/);
  assert.match(skin.promptTemplate, /any added wrinkle, crease, or age line/i);
  assert.equal(getEvalDef("skin-texture-age").passThreshold, 88);
  assert.equal(getEvalDef("skin-texture-age").borderlineThreshold, 75);

  for (const aspect of [
    "added_wrinkles",
    "added-forehead-wrinkle",
    "new-crease",
    "added-age-line",
  ]) {
    const inconsistentAddedWrinkle = buildLampEvaluationArtifact({
      raw: {
        results: rawVisualResults().map((result) =>
          result.evalId === "skin-texture-age"
            ? {
                ...result,
                score: 99,
                violations: [
                  {
                    aspect,
                    severity: "major",
                    description: "A new forehead crease appears in the candidate.",
                    correction: "Remove the invented forehead crease.",
                  },
                ],
              }
            : { ...result, score: 100, violations: [] }
        ),
      },
      iteration: 1,
      audioVerified: true,
      usage: GEMINI_USAGE,
      costUsd: 0.02,
    });
    const cappedSkin = inconsistentAddedWrinkle.evalResults.find(
      (result) => result.evalId === "skin-texture-age"
    );
    assert.equal(cappedSkin?.score, 69, aspect);
    assert.equal(cappedSkin?.verdict, "fail", aspect);
  }

  const removedWrinkle = buildLampEvaluationArtifact({
    raw: {
      results: rawVisualResults().map((result) =>
        result.evalId === "skin-texture-age"
          ? {
              ...result,
              score: 90,
              violations: [
                {
                  aspect: "removed-wrinkles",
                  severity: "minor",
                  description: "A source wrinkle is slightly softened.",
                  correction: "Restore the source wrinkle subtly.",
                },
              ],
            }
          : { ...result, score: 100, violations: [] }
      ),
    },
    iteration: 1,
    audioVerified: true,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });
  assert.equal(
    removedWrinkle.evalResults.find(
      (result) => result.evalId === "skin-texture-age"
    )?.score,
    90
  );
});

test("Lamp v2 reads legacy v1 artifacts through the current nine-check policy", () => {
  const current = buildLampEvaluationArtifact({
    raw: {
      results: rawVisualResults().map((result) => ({
        ...result,
        score: result.evalId === "skin-texture-age" ? 72 : 100,
        violations: [],
      })),
    },
    iteration: 2,
    audioVerified: true,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });
  assert.equal(current.version, LAMP_EVALUATOR_VERSION);

  const legacy: LampEvaluationArtifact = {
    version: LAMP_LEGACY_EVALUATOR_VERSION,
    iteration: current.iteration,
    costUsd: current.costUsd,
    evalResults: [
      ...current.evalResults.map((result) =>
        result.evalId === "skin-texture-age"
          ? {
              ...result,
              verdict: "fail" as const,
              verdicts: result.verdicts.map((judgeVerdict) => ({
                ...judgeVerdict,
                verdict: "fail" as const,
              })),
            }
          : result
      ),
      {
        ...current.evalResults[0],
        evalId: "temporal-alignment",
      },
    ],
  };
  assert.equal(isLampEvaluationArtifact(legacy, 2), true);
  const projection = projectLampEvaluationForRead({
    iteration: 2,
    artifact: legacy,
    humanGradeSaved: true,
  });
  assert.equal(projection.evalResults.length, 9);
  assert.equal(
    projection.evalResults.some(
      (result) => result.evalId === "temporal-alignment"
    ),
    false
  );
  assert.equal(
    projection.evalResults.find(
      (result) => result.evalId === "skin-texture-age"
    )?.verdict,
    "borderline"
  );
});

test("run-scoped grading definitions keep Lamp at nine and Flora at eleven", () => {
  assert.equal(
    evalDefsForRun({ workflowId: "lamp-v1" } as Run).length,
    9
  );
  assert.equal(
    evalDefsForRun({ workflowMode: "flora", workflowId: "flora-relight-v1" } as Run)
      .length,
    11
  );
  assert.equal(
    evalDefsForRun({
      workflowMode: "flora",
      workflowId: "flora-relight-v1",
      serverExecution: { executionId: "lamp:authoritative" },
    } as Run).length,
    9
  );
});

test("Lamp exposes Final scores ordinarily and seals only an explicit blind Grade read", () => {
  const initialArtifact = buildLampEvaluationArtifact({
    raw: { results: rawVisualResults() },
    iteration: 1,
    audioVerified: true,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });
  const finalArtifact = buildLampEvaluationArtifact({
    raw: { results: rawVisualResults() },
    iteration: 2,
    audioVerified: true,
    previousResults: initialArtifact.evalResults,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });

  const visibleInitial = projectLampEvaluationForRead({
    iteration: 1,
    artifact: initialArtifact,
    humanGradeSaved: false,
  });
  const visibleFinal = projectLampEvaluationForRead({
    iteration: 2,
    artifact: finalArtifact,
    humanGradeSaved: false,
  });
  const blindGradeFinal = projectLampEvaluationForRead({
    iteration: 2,
    artifact: finalArtifact,
    humanGradeSaved: false,
    hideFinalEvaluation: true,
  });
  const gradedFinal = projectLampEvaluationForRead({
    iteration: 2,
    artifact: finalArtifact,
    humanGradeSaved: true,
    hideFinalEvaluation: true,
  });

  assert.equal(visibleInitial.evalResults.length, 9);
  assert.ok(visibleInitial.composite);
  assert.equal(visibleFinal.evalResults.length, 9);
  assert.ok(visibleFinal.composite);
  assert.deepEqual(blindGradeFinal, { evalResults: [] });
  assert.equal(gradedFinal.evalResults.length, 9);
  assert.ok(gradedFinal.composite);
});

test("the first holistic evaluation compiles one v2 prompt with every correction", () => {
  const initial = initialMegaPrompt();
  const firstEvaluation = buildLampEvaluationArtifact({
    raw: { results: rawVisualResults() },
    iteration: 1,
    audioVerified: true,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });

  const finalPrompt = compileLampFinalPrompt(initial.rendered, firstEvaluation);

  assert.equal(initial.version, 1);
  assert.equal(initial.corrections.length, 0);
  assert.equal(finalPrompt.version, 2);
  assert.match(finalPrompt.rendered, /LAMP RELIGHT MEGA PROMPT v2/);
  assert.doesNotMatch(finalPrompt.rendered, /\banchor\b/i);
  assert.equal(
    finalPrompt.corrections.filter((correction) => !correction.resolved).length,
    EXPECTED_VISUAL_EVAL_IDS.length
  );
  for (let index = 1; index <= EXPECTED_VISUAL_EVAL_IDS.length; index += 1) {
    const correction = `Apply fixture correction ${index}.`;
    assert.equal(finalPrompt.rendered.split(correction).length - 1, 1);
  }
});

test("a persisted Lamp v1 keeps v2 stable across a later base-template deploy", () => {
  const persistedV1 = initialMegaPrompt().rendered;
  const firstEvaluation = buildLampEvaluationArtifact({
    raw: { results: rawVisualResults() },
    iteration: 1,
    audioVerified: true,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });
  const beforeDeploy = compileLampFinalPrompt(
    persistedV1,
    firstEvaluation
  ).rendered;
  const originalTask = LAMP_RELIGHT_BASE_PROMPT.task;

  try {
    LAMP_RELIGHT_BASE_PROMPT.task =
      "DEPLOY-ONLY TEMPLATE CHANGE THAT MUST NOT ENTER AN EXISTING RUN";
    assert.notEqual(initialMegaPrompt().rendered, persistedV1);

    const afterDeploy = compileLampFinalPrompt(
      persistedV1,
      firstEvaluation
    ).rendered;
    assert.equal(afterDeploy, beforeDeploy);
    assert.doesNotMatch(afterDeploy, /DEPLOY-ONLY TEMPLATE CHANGE/);
  } finally {
    LAMP_RELIGHT_BASE_PROMPT.task = originalTask;
  }
});

test("Lamp cost includes two generations, two evaluations, and one possible repair", () => {
  const durationSec = 7.5;
  const estimate = estimateLampRun(durationSec);

  assert.equal(LAMP_GENERATION_COUNT, 2);
  assert.equal(LAMP_EVALUATION_COUNT, 2);
  assert.equal(estimate.items.length, 6);

  const [
    generation,
    generationInput,
    evaluationInput,
    evaluationOutput,
    lipsync,
    localAudio,
  ] = estimate.items;
  assert.equal(generation.units, durationSec * 2);
  assert.equal(
    generation.usd,
    durationSec * 2 * PRICE_TABLE.omniFlashPerOutputSecond.usd
  );
  assert.equal(generationInput.provider, "omni");
  assert.equal(evaluationInput.provider, "gemini");
  assert.equal(evaluationOutput.provider, "gemini");
  assert.ok(generationInput.usd > 0);
  assert.ok(evaluationInput.usd > 0);
  assert.ok(evaluationOutput.usd > 0);
  assert.equal(lipsync.provider, "replicate");
  assert.equal(lipsync.units, durationSec);
  assert.equal(
    lipsync.usd,
    durationSec * PRICE_TABLE.lipsync2ProPerOutputSecond.usd
  );
  assert.equal(localAudio.units, 2);
  assert.equal(localAudio.usd, 0);
  assert.equal(
    estimate.totalUsd,
    durationSec * 2 * PRICE_TABLE.omniFlashPerOutputSecond.usd +
      generationInput.usd +
      evaluationInput.usd +
      evaluationOutput.usd +
      lipsync.usd
  );
});

test("Lamp batches bind the exact two-pass contract while legacy batches stay Flora", () => {
  assert.equal(normalizedWorkflowMode(undefined), "flora");
  assert.equal(batchExecutionId("batch_fixture", "flora"), "first-cuts:batch_fixture");
  assert.equal(
    batchMemberExecutionId("batch_fixture", "run_fixture", "flora"),
    "batch:batch_fixture:run_fixture"
  );

  assert.equal(batchExecutionId("batch_fixture", "lamp"), "lamp-batch:batch_fixture");
  assert.equal(
    batchMemberExecutionId("batch_fixture", "run_fixture", "lamp"),
    "lamp:run_fixture"
  );
  assert.equal(batchApprovalScope("lamp"), "lamp_two_pass");
  assert.equal(batchMaximumIterations("lamp"), 2);
  assert.equal(batchCompletionIteration("lamp"), 2);
  assert.equal(batchApprovalScope("flora"), "first_cut");
  assert.equal(batchMaximumIterations("flora"), 1);
  assert.equal(batchCompletionIteration("flora"), 1);
});

test("Lamp batch admission reserves and authorizes one exact two-pass run", () => {
  const runId = "run_batch_lamp_fixture";
  const batchId = "batch_lamp_fixture";
  const now = 1_800_000_000_000;
  const video: VideoAsset = {
    id: "video_batch_lamp_fixture",
    runId,
    kind: "original",
    url: "/api/media/run_batch_lamp_fixture/source.mp4",
    label: "Lamp batch fixture",
    durationSec: 7.5,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
  const approval = createSpendApproval(
    video,
    "batch",
    batchId,
    now,
    "lamp_two_pass"
  );
  const run = {
    id: runId,
    originalVideo: video,
    spendApproval: approval,
  } as Run;
  const reservation = lampMaximumMicros();
  const plan = planBatchBudget(
    [runId, "run_skipped_fixture"],
    reservation,
    microsToUsd(reservation)
  );

  assert.equal(approval.source, "batch");
  assert.equal(approval.scope, "lamp_two_pass");
  assert.equal(approval.batchId, batchId);
  assert.equal(approval.maxIterations, 2);
  assert.equal(approval.maxUsd, microsToUsd(reservation));
  assert.equal(hasReusableLampApproval(run, "batch", batchId, now + 1), true);
  assert.equal(hasReusableLampApproval(run, "single", undefined, now + 1), false);
  assert.doesNotThrow(() =>
    assertPaidOperationAuthorized(
      run,
      "lipsync",
      2,
      undefined,
      LIPSYNC_OPERATION_ID,
      now + 1
    )
  );
  assert.throws(
    () =>
      assertPaidOperationAuthorized(
        run,
        "lipsync",
        1,
        undefined,
        LIPSYNC_OPERATION_ID,
        now + 1
      ),
    /at most one Lipsync-2-Pro repair/
  );
  assert.equal(
    hasReusableLampApproval(run, "batch", "batch_wrong_fixture", now + 1),
    false
  );
  assert.deepEqual(plan.selected, [{ runId, reservedMicros: reservation }]);
  assert.deepEqual(plan.skippedRunIds, ["run_skipped_fixture"]);
  assert.equal(plan.reservedMicros, reservation);
  assert.equal(plan.budgetLimitMicros, reservation);
});

test("Lamp batch mode and reservation plan are immutable after durable creation", () => {
  const renderedPrompt = initialMegaPrompt().rendered;
  const reservation = lampMaximumMicros();
  const execution: BatchExecution = {
    batchId: "batch_immutable_lamp",
    executionId: "lamp-batch:batch_immutable_lamp",
    workflowMode: "lamp",
    renderedPrompt,
    inputHash: createHash("sha256").update(renderedPrompt, "utf8").digest("hex"),
    status: "queued",
    revision: 1,
    concurrency: 2,
    budgetLimitMicros: reservation,
    reservedMicros: reservation,
    settledMicros: 0,
    members: [
      {
        runId: "run_immutable_lamp",
        position: 0,
        state: "queued",
        maxReservedMicros: reservation,
      },
    ],
    startedAt: 1,
    updatedAt: 1,
  };
  assert.equal(assertNewBatchExecution(execution), execution);
  assert.throws(
    () =>
      assertBatchExecutionTransition(
        execution,
        {
          ...execution,
          workflowMode: "flora",
          status: "running",
          workflowRunId: "workflow_immutable_lamp",
          revision: 2,
          updatedAt: 2,
        },
        1
      ),
    /identity and dispatch limits are immutable/
  );
});

test("Lamp batch settlement counts both generations and both holistic evaluations", () => {
  const actualMicros = confirmedLampBatchActualMicros({
    initialGenerationUsd: 0.75,
    initialEvaluationUsd: 0.02,
    finalGenerationUsd: 0.75,
    finalEvaluationUsd: 0.02,
  });
  assert.equal(actualMicros, 1_540_000);
  assert.equal(actualMicros <= lampMaximumMicros(), true);
  assert.equal(
    confirmedLampBatchActualMicros({
      initialGenerationUsd: 0.75,
      initialEvaluationUsd: 0.02,
      finalGenerationUsd: 0.75,
      finalEvaluationUsd: 0.02,
      lipsyncRepairUsd: 0.44,
    }),
    1_980_000
  );
  assert.throws(
    () =>
      confirmedLampBatchActualMicros({
        initialGenerationUsd: 0.75,
        initialEvaluationUsd: -0.02,
        finalGenerationUsd: 0.75,
        finalEvaluationUsd: 0.02,
      }),
    /finite non-negative/
  );
});

test("human comparison always pairs with Lamp v2 rather than a better-looking v1", () => {
  const evalId = "identity-preservation";
  const makeResult = (iteration: number, score: number) => ({
    evalId,
    iteration,
    verdicts: [],
    score,
    confidence: 1,
    verdict: "pass" as const,
    violations: [],
  });
  const run = {
    workflowMode: "lamp",
    workflowId: "lamp-v1",
    iterations: [
      { index: 1, evalResults: [makeResult(1, 99)] },
      { index: 2, evalResults: [makeResult(2, 81)] },
    ],
    humanGrade: {
      scores: {
        [evalId]: { points: 4, score: 85, verdict: "pass" },
      },
    },
  } as unknown as Run;

  assert.equal(finalLampIteration(run)?.index, 2);
  const comparisons = collectComparisons([run]);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].ai.iteration, 2);
  assert.equal(comparisons[0].ai.score, 81);
});

test("comparison ignores legacy Lamp extras but retains all Flora checks", () => {
  const humanScores = Object.fromEntries(
    EVAL_DEFS.map((definition) => [
      definition.id,
      { points: 4 as const, score: 85, verdict: "pass" as const },
    ])
  );
  const resultFor = (evalId: string, iteration = 2) => ({
    evalId,
    iteration,
    verdicts: [],
    score: 85,
    confidence: 1,
    verdict: "pass" as const,
    violations: [],
  });
  const lamp = {
    workflowMode: "lamp",
    workflowId: "lamp-v1",
    iterations: [
      {
        index: 2,
        evalResults: LAMP_EVAL_DEFS.map((definition) =>
          resultFor(definition.id)
        ),
      },
    ],
    humanGrade: {
      gradedAt: 1,
      scores: humanScores,
      shipIt: true,
    },
  } as unknown as Run;
  const flora = {
    workflowMode: "flora",
    workflowId: "flora-relight-v1",
    iterations: [
      {
        index: 2,
        evalResults: EVAL_DEFS.map((definition) => resultFor(definition.id)),
      },
    ],
    humanGrade: {
      gradedAt: 2,
      scores: humanScores,
      shipIt: true,
    },
  } as unknown as Run;

  const lampComparisons = collectComparisons([lamp]);
  assert.equal(lampComparisons.length, 9);
  assert.equal(
    lampComparisons.some((comparison) => comparison.evalId === "temporal-alignment"),
    false
  );
  const floraComparisons = collectComparisons([flora]);
  assert.equal(floraComparisons.length, 11);
  assert.equal(
    floraComparisons.some(
      (comparison) => comparison.evalId === "temporal-alignment"
    ),
    true
  );
  assert.equal(
    floraComparisons.some(
      (comparison) => comparison.evalId === "lighting-match-to-anchor"
    ),
    true
  );
});

test("Lamp enters Grade only with a provider-backed v2 final", () => {
  const runId = "run_gradeable_lamp_fixture";
  const video: VideoAsset = {
    id: "video_gradeable_lamp_fixture",
    runId,
    kind: "generated",
    url: "/api/media/run_gradeable_lamp_fixture/final.mp4",
    label: "Lamp Final fixture",
    durationSec: 7.5,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
  const execution = {
    runId,
    executionId: `lamp:${runId}`,
    source: "single",
    status: "awaiting_review",
  } as RunExecution;
  const initialOnly = {
    workflowMode: "lamp",
    serverExecution: execution,
    iterations: [
      {
        index: 1,
        evalResults: [],
        generatedVideo: video,
        recoveredFromProviderOperation: true,
      },
    ],
  } as unknown as Run;
  const finished = {
    ...initialOnly,
    iterations: [
      ...initialOnly.iterations,
      {
        index: 2,
        evalResults: [],
        generatedVideo: video,
        recoveredFromProviderOperation: true,
      },
    ],
  } as unknown as Run;

  assert.equal(finalLampIteration(initialOnly), undefined);
  assert.equal(isGradeable(initialOnly), false);
  assert.equal(finalLampIteration(finished)?.index, 2);
  assert.equal(isGradeable(finished), true);
});

test("human-grade CTA trusts canonical Lamp execution instead of presentation status", () => {
  const execution = {
    runId: "blind_fixture",
    executionId: "lamp:blind_fixture",
    source: "single",
    status: "awaiting_review",
  } as RunExecution;
  const browserClaimedReviewed = {
    status: "approved",
    serverExecution: execution,
  } as unknown as Run;
  const humanGradeSaved = {
    ...browserClaimedReviewed,
    humanGrade: { gradedAt: 1, scores: {}, shipIt: true },
  } as unknown as Run;

  assert.equal(needsLampHumanGrade(browserClaimedReviewed), true);
  assert.equal(
    needsLampHumanGrade({
      ...browserClaimedReviewed,
      serverExecution: {
        ...execution,
        source: "batch",
        batchId: "batch_blind_fixture",
      },
    }),
    true
  );
  assert.equal(needsLampHumanGrade(humanGradeSaved), false);
  assert.equal(
    needsLampHumanGrade({
      ...browserClaimedReviewed,
      serverExecution: {
        ...execution,
        executionId: "first-cut:blind_fixture",
      },
    }),
    false
  );
});

test("renewed Lamp approval requeues the same execution for journal replay", () => {
  const paused: RunExecution = {
    runId: "run_resume_fixture",
    executionId: "lamp:run_resume_fixture",
    inputHash: "a".repeat(64),
    renderedPrompt: "fixture prompt",
    source: "single",
    status: "user_action_required",
    phase: "evaluating",
    iteration: 1,
    revision: 7,
    startedAt: 100,
    updatedAt: 200,
    workflowRunId: "workflow-old",
    error: `${LAMP_USER_ACTION_REQUIRED_PREFIX}approval expired`,
  };

  const resumed = requeueLampExecutionAfterApproval(paused, 300);

  assert.equal(resumed.runId, paused.runId);
  assert.equal(resumed.executionId, paused.executionId);
  assert.equal(resumed.inputHash, paused.inputHash);
  assert.equal(resumed.renderedPrompt, paused.renderedPrompt);
  assert.equal(resumed.startedAt, paused.startedAt);
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.phase, "queued");
  assert.equal(resumed.iteration, 0);
  assert.equal(resumed.revision, 8);
  assert.equal(resumed.workflowRunId, undefined);
  assert.equal(resumed.error, undefined);
  assert.equal(isLampApprovalReplayTransition(paused, resumed), true);
});

test("a batch Lamp child replays the same journal identity after approval renewal", () => {
  const paused: RunExecution = {
    runId: "run_batch_resume_fixture",
    executionId: "lamp:run_batch_resume_fixture",
    inputHash: "c".repeat(64),
    renderedPrompt: "fixture batch prompt",
    source: "batch",
    batchId: "batch_resume_fixture",
    status: "user_action_required",
    phase: "video_generation",
    iteration: 2,
    revision: 5,
    startedAt: 100,
    updatedAt: 200,
    workflowRunId: "workflow-batch-old",
    error: `${LAMP_USER_ACTION_REQUIRED_PREFIX}approval expired before pass 2`,
  };
  const resumed = requeueLampExecutionAfterApproval(paused, 300);
  assert.equal(resumed.executionId, paused.executionId);
  assert.equal(resumed.source, "batch");
  assert.equal(resumed.batchId, paused.batchId);
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.iteration, 0);
  assert.equal(resumed.workflowRunId, undefined);
  assert.equal(isLampApprovalReplayTransition(paused, resumed), true);
});

test("an expired Lamp batch re-arms only paused members under a newer approval epoch", () => {
  const renderedPrompt = initialMegaPrompt("lamp").rendered;
  const reservation = lampMaximumMicros();
  const running: BatchExecution = {
    batchId: "batch_rearm_fixture",
    executionId: "lamp-batch:batch_rearm_fixture",
    workflowMode: "lamp",
    renderedPrompt,
    inputHash: createHash("sha256").update(renderedPrompt, "utf8").digest("hex"),
    status: "running",
    revision: 2,
    concurrency: 2,
    budgetLimitMicros: reservation,
    reservedMicros: reservation,
    settledMicros: 0,
    members: [{
      runId: "run_rearm_fixture",
      position: 0,
      state: "running",
      maxReservedMicros: reservation,
    }],
    startedAt: 100,
    approvalStartedAt: 100,
    updatedAt: 200,
    workflowRunId: "workflow-parent-old",
  };
  const paused: BatchExecution = {
    ...running,
    status: "user_action_required",
    revision: 3,
    updatedAt: 300,
    members: [{ ...running.members[0], state: "user_action_required" }],
    error: `${LAMP_BATCH_USER_ACTION_REQUIRED_PREFIX}renew approval`,
  };
  assert.equal(assertBatchExecutionTransition(running, paused, 2), paused);

  const resumed = requeueLampBatchExecutionAfterApproval(paused, 400);
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.members[0].state, "queued");
  assert.equal(resumed.approvalStartedAt, 400);
  assert.equal(resumed.workflowRunId, undefined);
  assert.equal(resumed.executionId, paused.executionId);
  assert.equal(resumed.renderedPrompt, paused.renderedPrompt);
  assert.equal(isLampBatchApprovalReplayTransition(paused, resumed), true);
  assert.equal(assertBatchExecutionTransition(paused, resumed, 3), resumed);
});

test("approval replay cannot requeue a terminal Lamp execution", () => {
  const terminal = {
    runId: "run_terminal_fixture",
    executionId: "lamp:run_terminal_fixture",
    inputHash: "b".repeat(64),
    renderedPrompt: "fixture prompt",
    source: "single",
    status: "failed",
    phase: "evaluating",
    iteration: 1,
    revision: 3,
    startedAt: 100,
    updatedAt: 200,
    workflowRunId: "workflow-old",
    error: `${LAMP_USER_ACTION_REQUIRED_PREFIX}approval expired`,
  } as const satisfies RunExecution;

  assert.throws(
    () => requeueLampExecutionAfterApproval(terminal),
    /Only a Lamp execution paused for approval/
  );
});

test("complete final applicable evals produce a coverage-aware AI pass rate", () => {
  const finalArtifact = buildLampEvaluationArtifact({
    raw: {
      results: rawVisualResults().map((result) => ({
        ...result,
        score: 100,
        violations: [],
      })),
    },
    iteration: 2,
    audioVerified: true,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });
  const run = {
    workflowMode: "lamp",
    workflowId: "lamp-v1",
    iterations: [
      {
        index: 2,
        evalResults: finalArtifact.evalResults,
        // A browser-authored/stale aggregate must not override canonical evals.
        composite: {
          score: 0,
          passed: false,
          hardGateFailures: ["identity-preservation"],
        },
      },
    ],
  } as unknown as Run;

  const composite = lampCompositeForResults(finalArtifact.evalResults);
  assert.deepEqual(composite, {
    score: 100,
    passed: true,
    hardGateFailures: [],
  });
  assert.equal(aiPassRatePct([run]), 100);

  const incomplete = {
    ...run,
    iterations: [
      {
        index: 2,
        evalResults: finalArtifact.evalResults.filter(
          (result) => result.evalId !== "audio-integrity"
        ),
      },
    ],
  } as unknown as Run;
  assert.equal(lampCompositeForResults(incomplete.iterations[0].evalResults), undefined);
  assert.equal(aiPassRatePct([incomplete]), undefined);
});

test("historical artifacts re-verdict under the current thresholds", () => {
  // Policy pinned 2026-07-16: history is always presented under TODAY's
  // rules. A judge that scored skin 86 under the old 88/75 prompt persisted
  // "borderline"; the current Lamp policy (85/70) presents it as a pass.
  const results = rawVisualResults().map((result) =>
    result.evalId === "skin-texture-age"
      ? {
          ...result,
          score: 86,
          violations: [],
        }
      : result
  );
  const artifact = buildLampEvaluationArtifact({
    raw: { results },
    iteration: 1,
    audioVerified: true,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });
  const skin = artifact.evalResults.find(
    (result) => result.evalId === "skin-texture-age"
  );
  assert.equal(skin?.verdict, "pass");
  const composite = lampCompositeForResults(artifact.evalResults);
  assert.ok(composite);
  assert.ok(!composite.hardGateFailures?.includes("skin-texture-age"));
});

test("a duplicated check row invalidates the composite instead of scoring silently", () => {
  const artifact = buildLampEvaluationArtifact({
    raw: { results: rawVisualResults() },
    iteration: 1,
    audioVerified: true,
    usage: GEMINI_USAGE,
    costUsd: 0.02,
  });
  const duplicated = [
    ...artifact.evalResults,
    { ...artifact.evalResults.find((r) => r.evalId === "skin-texture-age")! },
  ];
  assert.equal(lampCompositeForResults(duplicated), undefined);
});
