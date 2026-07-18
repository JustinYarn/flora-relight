import assert from "node:assert/strict";
import test from "node:test";

import { sideBySideExportVersion } from "../components/review/export-selection.ts";
import type { Run } from "../lib/types.ts";

function irisRun(deliveredIteration: 1 | 2): Run {
  return {
    id: "run-iris-export",
    workflowId: "lamp-iris-v1",
    workflowMode: "iris",
    createdAt: 1,
    originalVideo: {} as never,
    status: "awaiting-review",
    iterations: [1, 2].map((index) => ({
      index,
      generatedVideo: {
        url: `/api/media/run-iris-export/relit-v${index}.mp4`,
      },
      evalResults: [],
    })) as never,
    nodeStates: {},
    log: [],
    serverExecution: { deliveredIteration } as never,
  } as Run;
}

test("Iris exports the server-delivered best-of-two take", () => {
  assert.equal(sideBySideExportVersion(irisRun(1)), 1);
  assert.equal(sideBySideExportVersion(irisRun(2)), 2);
});

test("approved exact-source no-ops do not advertise a missing relit export", () => {
  const run = irisRun(2);
  run.iterations = [
    {
      index: 2,
      generatedVideo: {
        ...run.originalVideo,
        url: "/api/media/run-iris-export/source.mp4",
      },
      evalResults: [],
    } as never,
  ];
  run.irisPlan = {
    runId: run.id,
    decision: "exceptional-no-op",
    approval: { status: "approved", approvedAt: 2, approvedBy: "human" },
  } as never;
  assert.equal(sideBySideExportVersion(run), null);
});
