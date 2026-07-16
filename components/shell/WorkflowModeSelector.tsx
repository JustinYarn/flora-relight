"use client";

import { useId } from "react";
import { relightIntensityProfile } from "@/lib/relight-intensity";

/**
 * Flora (legacy one-pass) is retired for new work, so the old two-button
 * selector is now a Lamp setup panel. Existing Flora runs remain viewable
 * and resumable from their own records; only new work is Lamp. Relight
 * strength is controlled before upload so one immutable value can travel with
 * the run or batch that is prepared next.
 */
export function WorkflowModeSelector({
  className = "",
  relightIntensity,
  onRelightIntensityChange,
  disabled = false,
}: {
  className?: string;
  relightIntensity: number;
  onRelightIntensityChange: (value: number) => void;
  disabled?: boolean;
}) {
  const sliderId = useId();
  const descriptionId = `${sliderId}-description`;
  const profile = relightIntensityProfile(relightIntensity);

  return (
    <section
      aria-label="Lamp relight setup"
      className={`rounded-xl bg-raised p-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)] ${className}`}
    >
      <div className="rounded-lg bg-surface px-3 py-2 text-left shadow-[0_1px_2px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.06)]">
        <span className="block text-xs font-semibold text-ink">Lamp</span>
        <span className="mt-0.5 block text-2xs text-muted">
          Exact two-pass
        </span>
      </div>
      <p className="px-2 pb-2 pt-2.5 text-pretty text-2xs leading-relaxed text-muted">
        <span className="font-medium text-ink">Lamp:</span> Generate, evaluate
        the whole video, regenerate once, then grade the Final blind before
        comparing with AI. Flora (legacy one-pass) is retired; existing Flora
        runs stay viewable.
      </p>

      <div className="rounded-lg bg-surface px-3 pb-3 pt-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.06)]">
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
            Natural daylight
          </span>
          <span className="text-center">
            <span className="block tabular-nums text-muted">75</span>
            Current Lamp
          </span>
          <span className="text-right">
            <span className="block tabular-nums text-muted">100</span>
            Max studio
          </span>
        </div>

        <p className="mt-2 text-pretty text-2xs leading-relaxed text-faint">
          <span className="tabular-nums">
            Target +{profile.faceLiftStops} stops · {profile.keyFillRatio}:1
          </span>{" "}
          key-to-fill. Strength controls how far Lamp changes the lighting, not
          whether the result is good.
        </p>
      </div>
    </section>
  );
}
