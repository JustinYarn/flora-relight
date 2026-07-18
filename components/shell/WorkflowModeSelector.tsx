"use client";

import { useId } from "react";
import { relightIntensityProfile } from "@/lib/relight-intensity";
import type { SelectableWorkflowMode } from "@/lib/workflow-mode";

const MODE_OPTIONS = [
  { mode: "lamp", label: "Lamp", detail: "Relight" },
  { mode: "background", label: "Background", detail: "Clean scene" },
  { mode: "beautify", label: "Beautify", detail: "Camera ready" },
  { mode: "iris", label: "Iris", detail: "Eye contact" },
] as const satisfies ReadonlyArray<{
  mode: SelectableWorkflowMode;
  label: string;
  detail: string;
}>;

/**
 * Selects the method for the next source clip. The parent locks this control
 * while an upload or spend decision is in flight so one run cannot inherit a
 * different method halfway through preparation.
 */
export function WorkflowModeSelector({
  className = "",
  workflowMode,
  onWorkflowModeChange,
  relightIntensity,
  onRelightIntensityChange,
  disabled = false,
}: {
  className?: string;
  workflowMode: SelectableWorkflowMode;
  onWorkflowModeChange: (mode: SelectableWorkflowMode) => void;
  relightIntensity: number;
  onRelightIntensityChange: (value: number) => void;
  disabled?: boolean;
}) {
  const sliderId = useId();
  const descriptionId = `${sliderId}-description`;
  const profile = relightIntensityProfile(relightIntensity);

  return (
    <section
      aria-label="Choose a Lamp workflow"
      className={`rounded-2xl bg-raised p-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)] ${className}`}
    >
      <div className="grid grid-cols-2 gap-1" aria-label="Workflow" role="group">
        {MODE_OPTIONS.map((option) => {
          const selected = option.mode === workflowMode;
          return (
            <button
              key={option.mode}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onWorkflowModeChange(option.mode)}
              className={`min-h-14 rounded-xl px-3 py-2 text-left transition-[background-color,box-shadow,scale,color] duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.08)]"
                  : "text-muted hover:bg-surface/55 hover:text-ink"
              }`}
            >
              <span className="block text-xs font-semibold">{option.label}</span>
              <span className="mt-0.5 block text-2xs text-faint">
                {option.detail}
              </span>
            </button>
          );
        })}
      </div>

      {disabled ? (
        <p className="px-2 pb-1 pt-2 text-pretty text-2xs leading-relaxed text-faint">
          Finish the current upload or confirmation before switching methods.
        </p>
      ) : null}

      {workflowMode === "lamp" ? (
        <div className="mt-1 rounded-xl bg-surface px-3 pb-3 pt-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.06)]">
          <div className="flex items-start justify-between gap-3">
            <span>
              <label
                htmlFor={sliderId}
                className="block text-xs font-semibold text-ink"
              >
                Relight strength
              </label>
              <span className="mt-0.5 block text-2xs text-muted">
                {profile.shortLabel}
              </span>
            </span>
            <output
              className="min-w-12 text-right text-lg font-semibold tabular-nums text-accent"
              aria-live="polite"
            >
              {relightIntensity}
            </output>
          </div>

          <p
            id={descriptionId}
            className="mt-2 text-pretty text-2xs leading-relaxed text-muted"
          >
            {profile.description}
          </p>

          <input
            id={sliderId}
            type="range"
            min={0}
            max={100}
            step={5}
            value={relightIntensity}
            onChange={(event) =>
              onRelightIntensityChange(Number(event.target.value))
            }
            disabled={disabled}
            aria-describedby={descriptionId}
            aria-valuetext={`${relightIntensity} out of 100, ${profile.label}`}
            className="mt-2 h-11 w-full cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50"
          />

          <div
            className="grid grid-cols-3 gap-2 text-2xs text-faint"
            aria-hidden="true"
          >
            <span>
              <span className="block tabular-nums text-muted">0</span>
              Daylight lift
            </span>
            <span className="text-center">
              <span className="block tabular-nums text-muted">75</span>
              Current Lamp
            </span>
            <span className="text-right">
              <span className="block tabular-nums text-muted">100</span>
              Cinematic hero
            </span>
          </div>

          <p className="mt-2 text-pretty text-2xs leading-relaxed text-faint">
            <span className="tabular-nums">
              Face +{profile.faceLiftStops} stops · key {profile.keyFillRatio}:1 ·
              background {profile.backgroundStops > 0 ? "+" : ""}
              {profile.backgroundStops} stops
            </span>
            . Strength sets how far Lamp transforms the lighting and what its
            critic expects—not whether the result is good.
          </p>
        </div>
      ) : null}
    </section>
  );
}
