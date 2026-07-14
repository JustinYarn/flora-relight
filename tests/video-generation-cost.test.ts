import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_CUT_MAX_OUTPUT_SECONDS,
  estimateLampRun,
} from "../lib/cost.ts";
import {
  firstCutMaximumMicros,
  usdToMicros,
} from "../lib/server/batch-budget.ts";
import { lampMaximumMicros } from "../lib/server/spend-approval.ts";
import { authorizedRawOutputCostUsd } from "../lib/server/video-generation-cost.ts";

const currentAuthorization = {
  maxAuthorizedCostMicros: 1_005_000,
  billingUsdPerOutputSecond: 0.1,
};

test("generation authorization records the live 10.01s artifact at actual cost", () => {
  const costUsd = authorizedRawOutputCostUsd(10.01, currentAuthorization);

  assert.ok(Math.abs(costUsd - 1.001) < 1e-12);
  assert.equal(usdToMicros(costUsd), 1_001_000);
});

test("generation authorization admits the 10.05s ceiling and rejects any longer output", () => {
  assert.equal(FIRST_CUT_MAX_OUTPUT_SECONDS, 10.05);
  assert.equal(
    usdToMicros(
      authorizedRawOutputCostUsd(
        FIRST_CUT_MAX_OUTPUT_SECONDS,
        currentAuthorization
      )
    ),
    firstCutMaximumMicros()
  );
  assert.throws(
    () =>
      authorizedRawOutputCostUsd(
        FIRST_CUT_MAX_OUTPUT_SECONDS + 0.001,
        currentAuthorization
      ),
    /above the immutable 10\.05s per-generation authorization/
  );
});

test("Lamp reserves both bounded generations plus both evaluations", () => {
  assert.equal(firstCutMaximumMicros(), 1_005_000);
  assert.equal(
    lampMaximumMicros(),
    usdToMicros(estimateLampRun(FIRST_CUT_MAX_OUTPUT_SECONDS).totalUsd)
  );
  assert.equal(lampMaximumMicros(), 2_050_000);
});

test("generation authorization rejects invalid billable durations", () => {
  assert.throws(
    () => authorizedRawOutputCostUsd(0, currentAuthorization),
    /no valid billable duration/
  );
  assert.throws(
    () => authorizedRawOutputCostUsd(Number.NaN, currentAuthorization),
    /no valid billable duration/
  );
});

test("an old in-flight claim cannot inherit the new container allowance", () => {
  assert.throws(
    () => authorizedRawOutputCostUsd(10.01, {}),
    /above the immutable 10\.00s per-generation authorization/
  );
  assert.equal(authorizedRawOutputCostUsd(10, {}), 1);
});

test("generation authorization rejects partial or widened price snapshots", () => {
  assert.throws(
    () =>
      authorizedRawOutputCostUsd(10, {
        maxAuthorizedCostMicros: firstCutMaximumMicros(),
      }),
    /no valid immutable cost authorization/
  );
  assert.throws(
    () =>
      authorizedRawOutputCostUsd(10, {
        maxAuthorizedCostMicros: firstCutMaximumMicros() + 1,
        billingUsdPerOutputSecond: 0.1,
      }),
    /no valid immutable cost authorization/
  );
});
