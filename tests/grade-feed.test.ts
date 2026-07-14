import assert from "node:assert/strict";
import test from "node:test";

import { mergeGradeFeedRuns } from "../components/grade/run-feed.ts";
import type { Run } from "../lib/types.ts";

function run(id: string, createdAt: number, extra: Partial<Run> = {}): Run {
  return {
    id,
    createdAt,
    iterations: [],
    ...extra,
  } as unknown as Run;
}

test("Grade feed appends server-only runs and replaces durable projections", () => {
  const stale = run("run_existing", 10);
  const authoritative = run("run_existing", 10, {
    serverExecution: {
      runId: "run_existing",
      executionId: "lamp:run_existing",
      status: "awaiting_review",
    } as Run["serverExecution"],
  });
  const discovered = run("run_from_another_tab", 20);

  const merged = mergeGradeFeedRuns(
    [stale],
    [authoritative, discovered]
  );

  assert.deepEqual(
    merged.map((item) => item.id),
    ["run_from_another_tab", "run_existing"]
  );
  assert.equal(merged[0], discovered);
  assert.equal(merged[1], authoritative);
});

test("Grade feed preserves legacy in-tab state while adopting verified media", () => {
  const localIteration = {
    index: 1,
    evalResults: [{ evalId: "local-eval" }],
  } as unknown as Run["iterations"][number];
  const verifiedIteration = {
    index: 1,
    evalResults: [],
    recoveredFromProviderOperation: true,
    generatedVideo: { url: "/api/media/run_legacy/final.mp4" },
  } as unknown as Run["iterations"][number];
  const local = run("run_legacy", 1, { iterations: [localIteration] });
  const server = run("run_legacy", 1, {
    iterations: [verifiedIteration],
    originalVideo: { url: "/api/media/run_legacy/source.mp4" } as Run["originalVideo"],
  });

  const [merged] = mergeGradeFeedRuns([local], [server]);

  assert.notEqual(merged, server);
  assert.equal(merged.iterations[0].evalResults, localIteration.evalResults);
  assert.equal(
    merged.iterations[0].generatedVideo,
    verifiedIteration.generatedVideo
  );
  assert.equal(merged.iterations[0].recoveredFromProviderOperation, true);
});

test("Grade feed rejects lower execution revisions and preserves a newer grade", () => {
  const finalEvidence = {
    index: 2,
    evalResults: [{ evalId: "identity-preservation" }],
  } as unknown as Run["iterations"][number];
  const local = run("run_race", 10, {
    status: "approved",
    iterations: [finalEvidence],
    humanGrade: { gradedAt: 200, scores: {}, shipIt: true },
    serverExecution: {
      runId: "run_race",
      executionId: "lamp:run_race",
      status: "awaiting_review",
      revision: 9,
      updatedAt: 190,
    } as Run["serverExecution"],
  });
  const stale = run("run_race", 10, {
    status: "awaiting-review",
    iterations: [{ index: 2, evalResults: [] }] as unknown as Run["iterations"],
    serverExecution: {
      runId: "run_race",
      executionId: "lamp:run_race",
      status: "running",
      revision: 8,
      updatedAt: 180,
    } as Run["serverExecution"],
  });

  const [merged] = mergeGradeFeedRuns([local], [stale]);

  assert.equal(merged.serverExecution?.revision, 9);
  assert.equal(merged.humanGrade?.gradedAt, 200);
  assert.equal(merged.status, "approved");
  assert.equal(merged.iterations[0].evalResults, finalEvidence.evalResults);
});

test("Grade feed adopts a server-saved grade for a legacy run", () => {
  const local = run("run_legacy_grade", 10, { status: "awaiting-review" });
  const server = run("run_legacy_grade", 10, {
    status: "approved",
    humanGrade: { gradedAt: 300, scores: {}, shipIt: true },
  });

  const [merged] = mergeGradeFeedRuns([local], [server]);

  assert.equal(merged.humanGrade?.gradedAt, 300);
  assert.equal(merged.status, "approved");
});

test("a complete Grade feed prunes only unchanged server-owned records observed at read start", () => {
  const removed = run("run_removed", 10, {
    serverExecution: {
      executionId: "lamp:run_removed",
      updatedAt: 100,
    } as Run["serverExecution"],
  });
  const previousVersion = run("run_updated", 20, {
    serverExecution: {
      executionId: "lamp:run_updated",
      revision: 1,
    } as Run["serverExecution"],
  });
  const updatedDuringRead = run("run_updated", 20, {
    serverExecution: {
      executionId: "lamp:run_updated",
      revision: 2,
    } as Run["serverExecution"],
  });

  const merged = mergeGradeFeedRuns([removed, updatedDuringRead], [], {
    pruneMissingServerOwnedFrom: new Map([
      [removed.id, removed],
      [previousVersion.id, previousVersion],
    ]),
  });

  assert.deepEqual(merged.map((item) => item.id), ["run_updated"]);
  assert.equal(merged[0], updatedDuringRead);
});
