import assert from "node:assert/strict";
import test from "node:test";

import { parseOptionalPositiveBudgetUsd } from "../lib/budget-input.ts";

test("an empty batch budget means no cap", () => {
  assert.deepEqual(parseOptionalPositiveBudgetUsd("   "), {
    ok: true,
    value: undefined,
  });
});

test("zero, negative, and non-numeric budgets never become an uncapped batch", () => {
  for (const raw of ["0", "-1", "not-a-number"]) {
    const parsed = parseOptionalPositiveBudgetUsd(raw);
    assert.equal(parsed.ok, false);
  }
});

test("a positive batch budget is forwarded exactly", () => {
  assert.deepEqual(parseOptionalPositiveBudgetUsd("2.05"), {
    ok: true,
    value: 2.05,
  });
});
