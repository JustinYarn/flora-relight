import assert from "node:assert/strict";
import test from "node:test";
import type { GenerateContentResponseUsageMetadata } from "@google/genai";

import {
  FIRST_CUT_MAX_OUTPUT_SECONDS,
  PRICE_TABLE,
  estimateLampRun,
  geminiProCostFromUsage,
  omniCostFromUsage,
  requireGeminiProUsage,
  requireOmniUsage,
} from "../lib/cost.ts";
import {
  firstCutMaximumMicros,
  firstCutOutputAuthorizationMicros,
  usdToMicros,
} from "../lib/server/batch-budget.ts";
import { lampMaximumMicros } from "../lib/server/spend-approval.ts";
import { assertAuthorizedRawOutputDuration } from "../lib/server/video-generation-cost.ts";
import { buildFreshVideoGenerationRequest } from "../lib/video-generation-request.ts";

const currentAuthorization = {
  maxAuthorizedCostMicros: firstCutOutputAuthorizationMicros(),
  billingUsdPerOutputSecond: PRICE_TABLE.omniFlashPerOutputSecond.usd,
};

test("generation authorization admits a raw artifact within its duration bound", () => {
  assert.doesNotThrow(() =>
    assertAuthorizedRawOutputDuration(10.01, currentAuthorization)
  );
});

test("generation authorization admits the 10.05s ceiling and rejects any longer output", () => {
  assert.equal(FIRST_CUT_MAX_OUTPUT_SECONDS, 10.05);
  assert.doesNotThrow(() =>
    assertAuthorizedRawOutputDuration(
      FIRST_CUT_MAX_OUTPUT_SECONDS,
      currentAuthorization
    )
  );
  assert.throws(
    () =>
      assertAuthorizedRawOutputDuration(
        FIRST_CUT_MAX_OUTPUT_SECONDS + 0.001,
        currentAuthorization
      ),
    /above the immutable 10\.05s per-generation authorization/
  );
});

test("Lamp reserves both generations, evaluations, and one possible repair", () => {
  assert.equal(firstCutOutputAuthorizationMicros(), 1_018_668);
  assert.equal(firstCutMaximumMicros(), 1_800_492);
  assert.ok(
    firstCutMaximumMicros() >
      usdToMicros(estimateLampRun(FIRST_CUT_MAX_OUTPUT_SECONDS).totalUsd / 2)
  );
  assert.equal(lampMaximumMicros(), 6_138_511);
});

test("Omni actual cost comes from input and output modality usage", () => {
  const usage = requireOmniUsage({
    total_input_tokens: 10_000,
    total_output_tokens: 58_000,
    total_thought_tokens: 100,
    total_tokens: 68_100,
    input_tokens_by_modality: [
      { modality: "TEXT", tokens: 1_000 },
      { modality: "VIDEO", tokens: 9_000 },
    ],
    output_tokens_by_modality: [
      { modality: "VIDEO", tokens: 57_920 },
      { modality: "TEXT", tokens: 80 },
    ],
  });

  assert.deepEqual(usage.output_tokens_by_modality, [
    { modality: "VIDEO", tokens: 57_920 },
    { modality: "TEXT", tokens: 80 },
  ]);
  assert.ok(Math.abs(omniCostFromUsage(usage) - 1.03022) < 1e-12);
});

test("Gemini Pro actual cost switches rates above 200k prompt tokens", () => {
  const standardMetadata = {
    promptTokenCount: 200_000,
    candidatesTokenCount: 1_000,
    thoughtsTokenCount: 500,
    totalTokenCount: 201_500,
  } satisfies GenerateContentResponseUsageMetadata;
  const longContextMetadata = {
    promptTokenCount: 200_001,
    candidatesTokenCount: 1_000,
    thoughtsTokenCount: 500,
    totalTokenCount: 201_501,
  } satisfies GenerateContentResponseUsageMetadata;
  const standard = requireGeminiProUsage(standardMetadata);
  const longContext = requireGeminiProUsage(longContextMetadata);

  assert.ok(Math.abs(geminiProCostFromUsage(standard) - 0.418) < 1e-12);
  assert.ok(
    Math.abs(geminiProCostFromUsage(longContext) - 0.827004) < 1e-12
  );
});

test("completed calls without billable usage cannot invent an actual cost", () => {
  assert.throws(
    () => requireOmniUsage(undefined),
    /returned no usage metadata/
  );
  assert.throws(
    () => requireGeminiProUsage({ promptTokenCount: 1 }),
    /invalid usage metadata/
  );
});

test("Final generation is a fresh source request with no interaction chain", () => {
  const request = buildFreshVideoGenerationRequest({
    iteration: 2,
    model: "gemini-omni-flash-preview",
    prompt: "Complete corrected prompt",
    uploadUri: "files/canonical-source",
  });

  assert.equal("previous_interaction_id" in request, false);
  assert.deepEqual(request.input[1], {
    type: "video",
    uri: "files/canonical-source",
    mime_type: "video/mp4",
  });
});

test("generation authorization rejects invalid billable durations", () => {
  assert.throws(
    () => assertAuthorizedRawOutputDuration(0, currentAuthorization),
    /no valid billable duration/
  );
  assert.throws(
    () => assertAuthorizedRawOutputDuration(Number.NaN, currentAuthorization),
    /no valid billable duration/
  );
});

test("an old in-flight claim cannot inherit the new container allowance", () => {
  assert.throws(
    () => assertAuthorizedRawOutputDuration(10.01, {}),
    /above the immutable 10\.00s per-generation authorization/
  );
  assert.doesNotThrow(() => assertAuthorizedRawOutputDuration(10, {}));
});

test("generation authorization rejects partial or widened price snapshots", () => {
  assert.throws(
    () =>
      assertAuthorizedRawOutputDuration(10, {
        maxAuthorizedCostMicros: firstCutMaximumMicros(),
      }),
    /no valid immutable cost authorization/
  );
  assert.throws(
    () =>
      assertAuthorizedRawOutputDuration(10, {
        maxAuthorizedCostMicros: firstCutOutputAuthorizationMicros() + 1,
        billingUsdPerOutputSecond:
          PRICE_TABLE.omniFlashPerOutputSecond.usd,
      }),
    /no valid immutable cost authorization/
  );
});
