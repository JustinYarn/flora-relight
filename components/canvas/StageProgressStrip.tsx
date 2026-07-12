"use client";

/**
 * Horizontal strip above the canvas that mirrors live run state in plain
 * words — one chip per stage lane, e.g.
 * "Ingest ✓ → Anchor ✓ → Generate ● v2 → Evals ● 7/10 → Gate ✗ → looping → Deliver —".
 */

import { Fragment } from "react";
import type { Run, RunConfig } from "@/lib/types";
import { deriveStageChips, STAGE_STATE_COLOR } from "@/components/canvas/derive";

export function StageProgressStrip({
  run,
  config,
}: {
  run?: Run;
  config: RunConfig;
}) {
  const chips = deriveStageChips(run, config);
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-edge bg-surface px-4 py-2"
      aria-label="Pipeline stage progress"
    >
      {chips.map((chip, i) => {
        const color = STAGE_STATE_COLOR[chip.state];
        return (
          <Fragment key={chip.id}>
            {i > 0 ? (
              <span aria-hidden="true" className="text-2xs text-faint">
                →
              </span>
            ) : null}
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs font-medium tabular-nums"
              style={{
                color,
                borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
                background: `color-mix(in srgb, ${color} 8%, transparent)`,
              }}
            >
              <span
                aria-hidden="true"
                className={chip.state === "running" ? "status-pulse" : undefined}
              >
                {chip.symbol}
              </span>
              {chip.label}
              {chip.detail ? (
                <span className="opacity-75">{chip.detail}</span>
              ) : null}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
