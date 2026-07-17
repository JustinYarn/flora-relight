import assert from "node:assert/strict";
import test from "node:test";

import { parseHumanGrade } from "../lib/human-grade.ts";
import { LAMP_BACKGROUND_EVAL_IDS } from "../lib/lamp-background-evaluation.ts";
import { LAMP_EVAL_IDS } from "../lib/lamp-evaluation.ts";
import { EVAL_DEFS } from "../lib/prompts/eval-defs.ts";

const FLORA_EVAL_IDS = EVAL_DEFS.map((definition) => definition.id);

function grade(evalIds: readonly string[]) {
  return {
    gradedAt: 123,
    shipIt: true,
    overallNote: "fixture",
    scores: Object.fromEntries(
      evalIds.map((evalId) => [
        evalId,
        { points: 4, score: 85, verdict: "pass", note: `note:${evalId}` },
      ])
    ),
  };
}

test("a current nine-row Lamp grade is accepted and canonicalized", () => {
  const parsed = parseHumanGrade({
    value: grade(LAMP_EVAL_IDS),
    requiredEvalIds: LAMP_EVAL_IDS,
    acceptedLegacyEvalIds: FLORA_EVAL_IDS,
  });

  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed.scores), LAMP_EVAL_IDS);
  assert.deepEqual(parsed.scores["skin-texture-age"], {
    points: 4,
    score: 85,
    verdict: "pass",
    note: "note:skin-texture-age",
  });
});

test("a stale eleven-row Lamp submission saves only the current nine rows", () => {
  const parsed = parseHumanGrade({
    value: grade(FLORA_EVAL_IDS),
    requiredEvalIds: LAMP_EVAL_IDS,
    acceptedLegacyEvalIds: FLORA_EVAL_IDS,
  });

  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed.scores), LAMP_EVAL_IDS);
  assert.equal("temporal-alignment" in parsed.scores, false);
  assert.equal("lighting-match-to-anchor" in parsed.scores, false);
});

test("Lamp Background requires its exact cleanup and preservation rows", () => {
  const parsed = parseHumanGrade({
    value: grade(LAMP_BACKGROUND_EVAL_IDS),
    requiredEvalIds: LAMP_BACKGROUND_EVAL_IDS,
  });
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed.scores), LAMP_BACKGROUND_EVAL_IDS);
  assert.equal(
    parseHumanGrade({
      value: grade(LAMP_EVAL_IDS),
      requiredEvalIds: LAMP_BACKGROUND_EVAL_IDS,
    }),
    null
  );
});

test("Lamp rejects partial, unknown, and non-canonical score payloads", () => {
  assert.equal(
    parseHumanGrade({
      value: grade(LAMP_EVAL_IDS.slice(0, -1)),
      requiredEvalIds: LAMP_EVAL_IDS,
      acceptedLegacyEvalIds: FLORA_EVAL_IDS,
    }),
    null
  );

  const unknown = grade([...LAMP_EVAL_IDS.slice(0, -1), "unknown-check"]);
  assert.equal(
    parseHumanGrade({
      value: unknown,
      requiredEvalIds: LAMP_EVAL_IDS,
      acceptedLegacyEvalIds: FLORA_EVAL_IDS,
    }),
    null
  );

  const wrongScale = grade(LAMP_EVAL_IDS);
  wrongScale.scores["skin-texture-age"].score = 84;
  assert.equal(
    parseHumanGrade({
      value: wrongScale,
      requiredEvalIds: LAMP_EVAL_IDS,
      acceptedLegacyEvalIds: FLORA_EVAL_IDS,
    }),
    null
  );
});

test("Flora continues to require all eleven rows", () => {
  assert.ok(
    parseHumanGrade({
      value: grade(FLORA_EVAL_IDS),
      requiredEvalIds: FLORA_EVAL_IDS,
    })
  );
  assert.equal(
    parseHumanGrade({
      value: grade(LAMP_EVAL_IDS),
      requiredEvalIds: FLORA_EVAL_IDS,
    }),
    null
  );
});
