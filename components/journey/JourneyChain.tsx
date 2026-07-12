"use client";

/**
 * The chain: this run's story as a horizontal storyboard of compact tiles
 * connected by thin lines colored by outcome. While the run executes, the
 * tail grows live and the current step pulses. Clicking a tile selects it
 * for the detail panel below — no cards-in-cards, no modal.
 */

import type { JourneyStep, StepTone } from "./chain";
import { toneColor } from "./chain";

function connectorColor(tone: StepTone): string {
  return tone === "neutral" ? "var(--edge)" : toneColor(tone);
}

function Tile({
  step,
  active,
  pulse,
  onSelect,
}: {
  step: JourneyStep;
  active: boolean;
  pulse: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(step.id)}
      aria-pressed={active}
      className="group flex w-[120px] shrink-0 flex-col items-center text-center focus:outline-none"
    >
      <div
        className={`relative h-[68px] w-full overflow-hidden rounded-lg border bg-surface transition group-focus-visible:border-accent ${
          active ? "border-accent" : "border-edge group-hover:border-faint"
        }`}
      >
        {step.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- canvas data URL, not an optimizable asset
          <img src={step.thumb} alt="" className="h-full w-full object-cover" />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-lg tabular-nums"
            style={{
              color: step.tone === "neutral" ? "var(--muted)" : toneColor(step.tone),
            }}
          >
            {step.glyph}
          </div>
        )}
        {pulse || step.tone === "running" ? (
          <span
            className="status-pulse absolute right-1.5 top-1.5 h-2 w-2 rounded-full"
            style={{ background: "var(--running)" }}
          />
        ) : null}
        {step.kind === "attempt" && step.tone !== "running" ? (
          <span
            className="absolute bottom-1 right-1.5 rounded px-1 text-xs font-semibold leading-4"
            style={{
              color: toneColor(step.tone),
              background: "color-mix(in srgb, var(--canvas) 72%, transparent)",
            }}
          >
            {step.tone === "pass" ? "✓" : "✕"}
          </span>
        ) : null}
      </div>
      <span
        className={`mt-2 text-xs transition ${
          active ? "text-ink" : "text-muted group-hover:text-ink"
        }`}
      >
        {step.label}
      </span>
      {step.sub ? (
        <span className="mt-0.5 text-2xs tabular-nums text-faint">{step.sub}</span>
      ) : null}
    </button>
  );
}

export function JourneyChain({
  steps,
  activeId,
  onSelect,
  live,
}: {
  steps: JourneyStep[];
  activeId: string;
  onSelect: (id: string) => void;
  /** True while the run executes — the last step pulses. */
  live: boolean;
}) {
  return (
    <div className="overflow-x-auto pb-3">
      <div className="flex min-w-max items-start gap-3 px-1 pt-1">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1;
          return (
            <div key={step.id} className="flex items-start gap-3">
              <Tile
                step={step}
                active={step.id === activeId}
                pulse={live && isLast}
                onSelect={onSelect}
              />
              {!isLast ? (
                <div
                  aria-hidden
                  className="mt-[34px] h-px w-8 shrink-0 sm:w-12"
                  style={{ background: connectorColor(step.tone) }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
