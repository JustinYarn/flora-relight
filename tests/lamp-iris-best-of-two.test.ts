import assert from "node:assert/strict";
import test from "node:test";

import {
  approveLampIrisPlan,
  createMockLampIrisPlan,
  type LampIrisPlan,
} from "../lib/lamp-iris.ts";
import {
  buildLampIrisEvaluationArtifact,
  LAMP_IRIS_EVAL_IDS,
  LAMP_IRIS_VISUAL_EVAL_DEFS,
  lampIrisArtifactComposite,
  selectLampIrisDeliveredIteration,
  type LampIrisEvaluationArtifact,
} from "../lib/lamp-iris-evaluation.ts";
import { projectLampIrisEvaluationForRead } from "../lib/lamp-iris-read.ts";
import {
  deliveredVideoLabel,
  deliveredInitialBestOfTwo,
  finalLampIteration,
  finalLampVideo,
  revealedDeliveredEvaluation,
} from "../components/grade/derive.ts";
import {
  reviewAttemptKey,
  reviewAttemptLabel,
  reviewAttemptSelection,
} from "../components/review/attempt-selection.ts";
import type { Run } from "../lib/types.ts";

function approvedPlan(): LampIrisPlan {
  const draft = createMockLampIrisPlan("run_best_of_two", 1_784_000_000_000);
  return approveLampIrisPlan(draft, 1_784_000_000_001);
}

/**
 * One holistic-judge fixture: every visual check at `baseScore` except the
 * ids overridden, plus the deterministic verified-audio row appended by the
 * trusted builder — the same path the workflow settlement scores.
 */
function artifactFor(
  plan: LampIrisPlan,
  iteration: 1 | 2,
  baseScore: number,
  overrides: Partial<Record<string, number>> = {}
): LampIrisEvaluationArtifact {
  return buildLampIrisEvaluationArtifact({
    raw: {
      results: LAMP_IRIS_VISUAL_EVAL_DEFS.map((definition) => ({
        evalId: definition.id,
        score: overrides[definition.id] ?? baseScore,
        confidence: 0.9,
        violations: [],
        reasoning: "Scripted best-of-two fixture result.",
      })),
    },
    plan,
    iteration,
    audioVerified: true,
    costUsd: 0.01,
  });
}

test("hard gates dominate: a gate-passing Initial beats a higher-composite gate-failed Final", () => {
  const plan = approvedPlan();
  // Every check at 90 clears its pass threshold (the strictest are 90).
  const first = artifactFor(plan, 1, 90);
  // The Final scores higher everywhere except one dead-stare hard gate.
  const final = artifactFor(plan, 2, 98, { "gaze-naturalness": 40 });

  const initialComposite = lampIrisArtifactComposite(first);
  const finalComposite = lampIrisArtifactComposite(final);
  assert.equal(initialComposite.passed, true);
  assert.equal(finalComposite.passed, false);
  assert.deepEqual(finalComposite.hardGateFailures, ["gaze-naturalness"]);
  assert.equal(
    finalComposite.score > initialComposite.score,
    true,
    "the fixture must make the failed Final outscore the passing Initial so the gate rule is what decides"
  );

  const selection = selectLampIrisDeliveredIteration(first, final);
  assert.equal(selection.iteration, 1);
  assert.match(selection.reason, /passed every hard gate/);
});

test("the Final delivers when only it passes the gates", () => {
  const plan = approvedPlan();
  const first = artifactFor(plan, 1, 95, { "gaze-adherence": 40 });
  const final = artifactFor(plan, 2, 90);

  assert.equal(lampIrisArtifactComposite(first).passed, false);
  assert.equal(lampIrisArtifactComposite(final).passed, true);

  const selection = selectLampIrisDeliveredIteration(first, final);
  assert.equal(selection.iteration, 2);
  assert.match(selection.reason, /Final passed every hard gate/);
});

test("when both takes fail the gates, the higher composite wins", () => {
  const plan = approvedPlan();
  const strongInitial = artifactFor(plan, 1, 92, { "gaze-adherence": 40 });
  const weakFinal = artifactFor(plan, 2, 80, { "gaze-adherence": 40 });
  assert.equal(lampIrisArtifactComposite(strongInitial).passed, false);
  assert.equal(lampIrisArtifactComposite(weakFinal).passed, false);

  const initialWins = selectLampIrisDeliveredIteration(strongInitial, weakFinal);
  assert.equal(initialWins.iteration, 1);
  assert.match(initialWins.reason, /Initial outscored Final/);

  const weakInitial = artifactFor(plan, 1, 80, { "gaze-adherence": 40 });
  const strongFinal = artifactFor(plan, 2, 92, { "gaze-adherence": 40 });
  const finalWins = selectLampIrisDeliveredIteration(weakInitial, strongFinal);
  assert.equal(finalWins.iteration, 2);
  assert.match(finalWins.reason, /Final outscored Initial/);
});

test("an exact tie ships the correction pass", () => {
  const plan = approvedPlan();
  const first = artifactFor(plan, 1, 92);
  const final = artifactFor(plan, 2, 92);
  const selection = selectLampIrisDeliveredIteration(first, final);
  assert.equal(selection.iteration, 2);
  assert.match(selection.reason, /tied/);
});

test("selection refuses out-of-order artifacts", () => {
  const plan = approvedPlan();
  const first = artifactFor(plan, 1, 92);
  const final = artifactFor(plan, 2, 92);
  assert.throws(
    () => selectLampIrisDeliveredIteration(final, first),
    /Initial and Final artifacts in order/
  );
});

test("the blind-grading hide follows the delivered iteration", () => {
  const plan = approvedPlan();
  const first = artifactFor(plan, 1, 92);
  const final = artifactFor(plan, 2, 92);

  // Delivered Initial: the graded take (1) hides until the human grade is
  // saved, while the non-delivered Final's evaluation stays readable.
  const hiddenInitial = projectLampIrisEvaluationForRead({
    iteration: 1,
    artifact: first,
    irisPlan: plan,
    humanGradeSaved: false,
    hideFinalEvaluation: true,
    deliveredIteration: 1,
  });
  assert.equal(hiddenInitial.evalResults.length, 0);
  assert.equal(hiddenInitial.composite, undefined);
  const visibleFinal = projectLampIrisEvaluationForRead({
    iteration: 2,
    artifact: final,
    irisPlan: plan,
    humanGradeSaved: false,
    hideFinalEvaluation: true,
    deliveredIteration: 1,
  });
  assert.equal(visibleFinal.evalResults.length, LAMP_IRIS_EVAL_IDS.length);
  assert.notEqual(visibleFinal.composite, undefined);

  // Delivered Final (explicit or the legacy default): exactly the historical
  // behavior — iteration 2 hides, iteration 1 stays readable.
  for (const deliveredIteration of [2 as const, undefined]) {
    const hiddenFinal = projectLampIrisEvaluationForRead({
      iteration: 2,
      artifact: final,
      irisPlan: plan,
      humanGradeSaved: false,
      hideFinalEvaluation: true,
      ...(deliveredIteration !== undefined ? { deliveredIteration } : {}),
    });
    assert.equal(hiddenFinal.evalResults.length, 0);
    assert.equal(hiddenFinal.composite, undefined);
    const visibleInitial = projectLampIrisEvaluationForRead({
      iteration: 1,
      artifact: first,
      irisPlan: plan,
      humanGradeSaved: false,
      hideFinalEvaluation: true,
      ...(deliveredIteration !== undefined ? { deliveredIteration } : {}),
    });
    assert.equal(visibleInitial.evalResults.length, LAMP_IRIS_EVAL_IDS.length);
    assert.notEqual(visibleInitial.composite, undefined);
  }

  // A saved human grade reveals the delivered take again.
  const revealed = projectLampIrisEvaluationForRead({
    iteration: 1,
    artifact: first,
    irisPlan: plan,
    humanGradeSaved: true,
    hideFinalEvaluation: true,
    deliveredIteration: 1,
  });
  assert.equal(revealed.evalResults.length, LAMP_IRIS_EVAL_IDS.length);

  // Without the blind-feed flag nothing hides regardless of delivery.
  const ordinaryRead = projectLampIrisEvaluationForRead({
    iteration: 1,
    artifact: first,
    irisPlan: plan,
    humanGradeSaved: false,
    deliveredIteration: 1,
  });
  assert.equal(ordinaryRead.evalResults.length, LAMP_IRIS_EVAL_IDS.length);
});

test("finalLampIteration grades the delivered take for iris best-of-two only", () => {
  const iterations = [
    { index: 1, evalResults: [] },
    { index: 2, evalResults: [] },
  ];
  const irisRun = (deliveredIteration?: 1 | 2): Run =>
    ({
      workflowMode: "iris",
      workflowId: "lamp-iris-v1",
      serverExecution: {
        runId: "run_best_of_two",
        executionId: "lamp-iris:run_best_of_two",
        status: "awaiting_review",
        ...(deliveredIteration !== undefined ? { deliveredIteration } : {}),
      },
      iterations,
    }) as unknown as Run;

  assert.equal(deliveredInitialBestOfTwo(irisRun(1)), true);
  assert.equal(deliveredInitialBestOfTwo(irisRun(2)), false);
  assert.equal(deliveredInitialBestOfTwo(irisRun()), false);
  assert.equal(finalLampIteration(irisRun(1))?.index, 1);
  assert.equal(finalLampIteration(irisRun(2))?.index, 2);
  // Legacy iris executions settled before the policy delivered the Final.
  assert.equal(finalLampIteration(irisRun())?.index, 2);

  // No other mode ever consults the marker, even if one leaked onto a record.
  const lampRun = {
    workflowMode: "lamp",
    workflowId: "lamp-v1",
    serverExecution: {
      runId: "run_best_of_two",
      executionId: "lamp:run_best_of_two",
      status: "awaiting_review",
      deliveredIteration: 1,
    },
    iterations,
  } as unknown as Run;
  assert.equal(deliveredInitialBestOfTwo(lampRun), false);
  assert.equal(finalLampIteration(lampRun)?.index, 2);
});

test("AI reveal follows the delivered Iris take instead of hard-coding Final", () => {
  const irisRun = (deliveredIteration: 1 | 2, revealed: boolean): Run =>
    ({
      workflowMode: "iris",
      workflowId: "lamp-iris-v1",
      serverExecution: {
        runId: "run_best_of_two",
        executionId: "lamp-iris:run_best_of_two",
        status: "awaiting_review",
        deliveredIteration,
      },
      iterations: [
        { index: 1, evalResults: deliveredIteration === 1 && revealed ? [{}] : [] },
        { index: 2, evalResults: deliveredIteration === 2 && revealed ? [{}] : [] },
      ],
    }) as unknown as Run;

  assert.equal(
    revealedDeliveredEvaluation(irisRun(1, false), irisRun(1, true))?.index,
    1
  );
  assert.equal(
    revealedDeliveredEvaluation(irisRun(2, false), irisRun(2, true))?.index,
    2
  );
  assert.equal(
    revealedDeliveredEvaluation(irisRun(1, false), irisRun(2, true)),
    undefined
  );
  assert.equal(
    revealedDeliveredEvaluation(irisRun(1, false), irisRun(1, false)),
    undefined
  );
});

test("review keeps Iris Final selectable when best-of-two delivers Initial", () => {
  const video = (id: string, url: string, kind: "original" | "generated" | "final") => ({
    id,
    runId: "run_best_of_two_review",
    kind,
    url,
    label: `${id}.mp4`,
    durationSec: 8,
    width: 1280,
    height: 720,
    hasAudio: true,
  });
  const initialVideo = video("initial", "/generated/v1.mp4", "generated");
  const finalVideo = video("final", "/generated/v2.mp4", "generated");
  const run = {
    id: "run_best_of_two_review",
    workflowMode: "iris",
    workflowId: "lamp-iris-v1",
    originalVideo: video("source", "/source/input.mp4", "original"),
    serverExecution: {
      runId: "run_best_of_two_review",
      executionId: "lamp-iris:run_best_of_two_review",
      status: "awaiting_review",
      deliveredIteration: 1,
    },
    iterations: [
      { index: 1, generatedVideo: initialVideo, evalResults: [] },
      { index: 2, generatedVideo: finalVideo, evalResults: [] },
    ],
  } as unknown as Run;

  const initial = run.iterations[0]!;
  const final = run.iterations[1]!;
  assert.equal(reviewAttemptKey(run, initial), "final");
  assert.equal(reviewAttemptLabel(run, initial), "Delivered");
  assert.equal(reviewAttemptKey(run, final), "iter-2");
  assert.equal(reviewAttemptLabel(run, final), "Final");

  const deliveredSelection = reviewAttemptSelection(run, "final");
  assert.equal(deliveredSelection.iteration?.index, 1);
  assert.equal(deliveredSelection.video?.url, initialVideo.url);
  const finalSelection = reviewAttemptSelection(run, "iter-2");
  assert.equal(finalSelection.iteration?.index, 2);
  assert.equal(finalSelection.video?.url, finalVideo.url);

  assert.equal(finalLampVideo(run)?.url, initialVideo.url);
  assert.equal(
    deliveredVideoLabel(run),
    "DELIVERED VIDEO · v1 · BEST OF TWO"
  );

  // If an older/read-model record also carries a canonical delivered remux,
  // that artifact still wins over the raw iteration media.
  const deliveredVideo = video("delivered", "/delivered/v1-remux.mp4", "final");
  const withDeliveredRemux = { ...run, finalVideo: deliveredVideo };
  assert.equal(
    reviewAttemptSelection(withDeliveredRemux, "final").video?.url,
    deliveredVideo.url
  );
  assert.equal(finalLampVideo(withDeliveredRemux)?.url, deliveredVideo.url);
});
