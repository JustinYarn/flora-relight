"use client";

import { useId } from "react";
import { relightIntensityProfile } from "@/lib/relight-intensity";
import {
  LAMP_COMBINED_CLEANLINESS_PROFILES,
  type LampCombinedControls,
} from "@/lib/lamp-combined";
import {
  defaultLampChainStageOrder,
  lampChainEnabledStages,
  type LampChainControls,
  type LampChainStage,
} from "@/lib/lamp-chain";
import type { SelectableWorkflowMode } from "@/lib/workflow-mode";

const MODE_OPTIONS = [
  { mode: "lamp", label: "Lamp", detail: "Relight" },
  { mode: "background", label: "Background", detail: "Clean scene" },
  { mode: "beautify", label: "Beautify", detail: "Camera ready" },
  { mode: "iris", label: "Iris", detail: "Eye contact" },
  { mode: "combined", label: "Combined", detail: "Two takes · you pick" },
  { mode: "chain", label: "Chain", detail: "Combined V2 — sequential stages" },
] as const satisfies ReadonlyArray<{
  mode: SelectableWorkflowMode;
  label: string;
  detail: string;
}>;

const CHAIN_STAGE_LABELS: Record<
  LampChainStage,
  { label: string; detail: string }
> = {
  background: { label: "Background", detail: "Clean scene" },
  lamp: { label: "Lamp", detail: "Relight" },
  beautify: { label: "Beautify", detail: "Camera ready" },
  iris: { label: "Iris", detail: "Eye contact" },
};

/**
 * Keep a chain stage order valid after its triple changes: still-enabled
 * stages retain their relative order; newly enabled stages append at the end.
 */
function reconcileChainStageOrder(
  order: readonly LampChainStage[],
  controls: LampCombinedControls
): LampChainStage[] {
  const enabled = lampChainEnabledStages(controls);
  const kept = order.filter((stage) => enabled.includes(stage));
  return [...kept, ...enabled.filter((stage) => !kept.includes(stage))];
}

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
  combinedControls,
  onCombinedControlsChange,
  chainControls,
  onChainControlsChange,
  disabled = false,
}: {
  className?: string;
  workflowMode: SelectableWorkflowMode;
  onWorkflowModeChange: (mode: SelectableWorkflowMode) => void;
  relightIntensity: number;
  onRelightIntensityChange: (value: number) => void;
  combinedControls: LampCombinedControls;
  onCombinedControlsChange: (controls: LampCombinedControls) => void;
  chainControls: LampChainControls;
  onChainControlsChange: (controls: LampChainControls) => void;
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

      {workflowMode === "lamp" ||
      workflowMode === "combined" ||
      workflowMode === "chain" ? (
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

      {workflowMode === "combined" ? (
        <CombinedControlsBlock
          controls={combinedControls}
          disabled={disabled}
          onChange={onCombinedControlsChange}
        />
      ) : null}

      {workflowMode === "chain" ? (
        <>
          <CombinedControlsBlock
            controls={chainControls}
            disabled={disabled}
            onChange={(triple) =>
              onChainControlsChange({
                ...triple,
                stageOrder: reconcileChainStageOrder(
                  chainControls.stageOrder,
                  triple
                ),
              })
            }
          />
          <ChainStageOrderPicker
            controls={chainControls}
            disabled={disabled}
            onChange={onChainControlsChange}
          />
        </>
      ) : null}
    </section>
  );
}

/** The Combined triple — shared verbatim by Combined and Chain. */
function CombinedControlsBlock({
  controls,
  disabled,
  onChange,
}: {
  controls: LampCombinedControls;
  disabled: boolean;
  onChange: (controls: LampCombinedControls) => void;
}) {
  return (
    <div className="mt-1 space-y-1 rounded-xl bg-surface p-1 shadow-[0_1px_2px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.06)]">
      <CombinedChoice
        label="Beautify"
        description="Optional presenter polish. Off keeps face texture and expression locked."
        value={String(controls.beautifyLevel)}
        options={[
          { value: "0", label: "Off" },
          { value: "1", label: "1 · Light" },
          { value: "2", label: "2 · Polished" },
          { value: "3", label: "3 · Max natural" },
        ]}
        disabled={disabled}
        onChange={(value) =>
          onChange({
            ...controls,
            beautifyLevel: Number(value) as 0 | 1 | 2 | 3,
          })
        }
      />
      <CombinedChoice
        label="Background cleanliness"
        description="Changes thoroughness inside approved targets; it never adds targets or redesigns the room."
        value={String(controls.cleanlinessLevel)}
        options={([1, 2, 3] as const).map((level) => ({
          value: String(level),
          label: `${level} · ${LAMP_COMBINED_CLEANLINESS_PROFILES[level].label}`,
        }))}
        disabled={disabled}
        onChange={(value) =>
          onChange({
            ...controls,
            cleanlinessLevel: Number(value) as 1 | 2 | 3,
          })
        }
      />
      <div className="rounded-lg bg-raised px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-xs font-semibold text-ink">
              Eye contact
            </span>
            <span className="mt-0.5 block text-pretty text-2xs leading-relaxed text-muted">
              When on, Iris is fixed at Presenter level 2—no hidden strength dial.
            </span>
          </span>
          <button
            type="button"
            aria-label={`Eye contact ${
              controls.eyeContact ? "on, Presenter level 2" : "off"
            }`}
            aria-pressed={controls.eyeContact}
            disabled={disabled}
            onClick={() =>
              onChange({
                ...controls,
                eyeContact: !controls.eyeContact,
              })
            }
            className={`min-h-10 min-w-24 rounded-lg px-3 text-xs font-semibold tabular-nums transition-[background-color,color,box-shadow,scale] duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 ${
              controls.eyeContact
                ? "bg-accent text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.28)]"
                : "bg-surface text-muted shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:text-ink"
            }`}
          >
            {controls.eyeContact ? "On · P2" : "Off"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Chain only: the execution order for the enabled stages. Order is approved
 * identity — it binds into the chain plan hash at review, so this picker is
 * the last free reordering point before approval.
 */
function ChainStageOrderPicker({
  controls,
  disabled,
  onChange,
}: {
  controls: LampChainControls;
  disabled: boolean;
  onChange: (controls: LampChainControls) => void;
}) {
  const order = controls.stageOrder;
  const defaultOrder = defaultLampChainStageOrder(controls);
  const isDefault =
    order.length === defaultOrder.length &&
    order.every((stage, index) => stage === defaultOrder[index]);

  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange({ ...controls, stageOrder: next });
  };

  return (
    <fieldset className="mt-1 rounded-xl bg-surface px-3 pb-3 pt-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.06)]">
      <legend className="sr-only">Stage order</legend>
      <div className="flex items-start justify-between gap-3">
        <span>
          <span className="block text-xs font-semibold text-ink">
            Stage order
          </span>
          <span className="mt-0.5 block text-pretty text-2xs leading-relaxed text-muted">
            Each stage generates over the previous stage&apos;s cut. The order
            is frozen into the plan approval.
          </span>
        </span>
        <button
          type="button"
          disabled={disabled || isDefault}
          onClick={() =>
            onChange({ ...controls, stageOrder: defaultOrder })
          }
          className="min-h-10 shrink-0 rounded-lg bg-raised px-3 text-2xs font-medium text-muted shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] transition-[color,scale] duration-150 ease-out hover:text-ink active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Default order
        </button>
      </div>
      <ol className="mt-2 space-y-1">
        {order.map((stage, index) => (
          <li
            key={stage}
            className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2"
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xs font-semibold tabular-nums text-accent">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-ink">
                {CHAIN_STAGE_LABELS[stage].label}
              </span>
              <span className="block text-2xs text-faint">
                {CHAIN_STAGE_LABELS[stage].detail}
              </span>
            </span>
            <button
              type="button"
              aria-label={`Move ${CHAIN_STAGE_LABELS[stage].label} earlier`}
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
              className="min-h-10 min-w-10 rounded-lg bg-surface text-sm text-muted shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] transition-[color,scale] duration-150 ease-out hover:text-ink active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Move ${CHAIN_STAGE_LABELS[stage].label} later`}
              disabled={disabled || index === order.length - 1}
              onClick={() => move(index, 1)}
              className="min-h-10 min-w-10 rounded-lg bg-surface text-sm text-muted shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] transition-[color,scale] duration-150 ease-out hover:text-ink active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
    </fieldset>
  );
}

function CombinedChoice({
  label,
  description,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="rounded-lg bg-raised px-3 py-2.5">
      <legend className="sr-only">{label}</legend>
      <p className="text-xs font-semibold text-ink">{label}</p>
      <p className="mt-0.5 text-pretty text-2xs leading-relaxed text-muted">
        {description}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-1" role="group">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`min-h-10 rounded-lg px-2 text-2xs font-medium tabular-nums transition-[background-color,color,box-shadow,scale] duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.24),0_0_0_1px_rgba(255,255,255,0.07)]"
                  : "text-muted hover:bg-surface/55 hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
