import assert from "node:assert/strict";
import test from "node:test";

import { v2SyncConfigIssue } from "../lib/server/v2-sync-config.ts";

function withEnv(
  env: Record<string, string | undefined>,
  fn: () => void
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("v2 sync preflight passes a clean configuration", () => {
  withEnv(
    {
      SYNCNET_BASE_URL: "https://sync.example.com",
      REPLICATE_API_TOKEN: "r8_test_token",
    },
    () => assert.equal(v2SyncConfigIssue(), null)
  );
});

test("v2 sync preflight names each missing or mangled variable", () => {
  withEnv(
    { SYNCNET_BASE_URL: undefined, REPLICATE_API_TOKEN: "r8_x" },
    () => assert.match(v2SyncConfigIssue() ?? "", /SYNCNET_BASE_URL is not configured/)
  );
  withEnv(
    { SYNCNET_BASE_URL: '"https://sync.example.com"', REPLICATE_API_TOKEN: "r8_x" },
    () => assert.match(v2SyncConfigIssue() ?? "", /surrounding quotes/)
  );
  withEnv(
    { SYNCNET_BASE_URL: "not a url", REPLICATE_API_TOKEN: "r8_x" },
    () => assert.match(v2SyncConfigIssue() ?? "", /not a valid URL/)
  );
  withEnv(
    { SYNCNET_BASE_URL: "https://sync.example.com", REPLICATE_API_TOKEN: undefined },
    () => assert.match(v2SyncConfigIssue() ?? "", /REPLICATE_API_TOKEN is not configured/)
  );
  withEnv(
    { SYNCNET_BASE_URL: "https://sync.example.com", REPLICATE_API_TOKEN: "'r8_x'" },
    () => assert.match(v2SyncConfigIssue() ?? "", /surrounding quotes/)
  );
});
