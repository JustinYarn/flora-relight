import assert from "node:assert/strict";
import test from "node:test";

import { parseHumanGrade } from "../lib/human-grade.ts";
import {
  EVAL_DEFS,
  humanGradeEvalDefsForMode,
} from "../lib/prompts/eval-defs.ts";
import type { HumanCheckGrade } from "../lib/types.ts";

const PERFECT: HumanCheckGrade = {
  points: 5,
  score: 95,
  verdict: "pass",
};

function scoresFor(ids: string[]): Record<string, HumanCheckGrade> {
  return Object.fromEntries(ids.map((id) => [id, PERFECT]));
}

test("Lamp human grading neither renders nor requires the anchor row", () => {
  const definitions = humanGradeEvalDefsForMode("lamp");
  const ids = definitions.map((definition) => definition.id);

  assert.equal(definitions.length, EVAL_DEFS.length - 1);
  assert.equal(ids.includes("lighting-match-to-anchor"), false);

  const parsed = parseHumanGrade(
    {
      gradedAt: 123,
      scores: scoresFor(ids),
      shipIt: true,
    },
    "lamp"
  );
  assert.ok(parsed);
  assert.equal(parsed.scores["lighting-match-to-anchor"], undefined);
});

test("human grade validation rejects rows outside the mode-specific contract", () => {
  const lampIds = humanGradeEvalDefsForMode("lamp").map(
    (definition) => definition.id
  );
  const lampWithAnchor = {
    ...scoresFor(lampIds),
    "lighting-match-to-anchor": PERFECT,
  };
  assert.equal(
    parseHumanGrade(
      { gradedAt: 123, scores: lampWithAnchor, shipIt: true },
      "lamp"
    ),
    null
  );

  assert.equal(
    parseHumanGrade(
      { gradedAt: 123, scores: scoresFor(lampIds), shipIt: true },
      "flora"
    ),
    null
  );
  assert.ok(
    parseHumanGrade(
      {
        gradedAt: 123,
        scores: scoresFor(EVAL_DEFS.map((definition) => definition.id)),
        shipIt: true,
      },
      "flora"
    )
  );
});
