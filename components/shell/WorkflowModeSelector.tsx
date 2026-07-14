"use client";

import { useAppStore } from "@/lib/store";
import type { WorkflowMode } from "@/lib/types";

const MODES: ReadonlyArray<{
  id: WorkflowMode;
  label: string;
  summary: string;
  detail: string;
}> = [
  {
    id: "flora",
    label: "Flora",
    summary: "Legacy one-pass",
    detail:
      "Generate one review-ready cut per video. Flora keeps the established single and batch workflow.",
  },
  {
    id: "lamp",
    label: "Lamp",
    summary: "Exact two-pass",
    detail:
      "Generate, evaluate the whole video, regenerate once, then grade the Final blind before comparing with AI.",
  },
];

export function WorkflowModeSelector({
  className = "",
}: {
  className?: string;
}) {
  const workflowMode = useAppStore((state) => state.workflowMode);
  const setWorkflowMode = useAppStore((state) => state.setWorkflowMode);
  const active = MODES.find((mode) => mode.id === workflowMode) ?? MODES[1];

  return (
    <section
      aria-label="Relight workflow"
      className={`rounded-xl bg-raised p-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)] ${className}`}
    >
      <div className="grid grid-cols-2 gap-1" role="group" aria-label="Workflow mode">
        {MODES.map((mode) => {
          const selected = mode.id === workflowMode;
          return (
            <button
              key={mode.id}
              type="button"
              aria-pressed={selected}
              onClick={() => setWorkflowMode(mode.id)}
              className={`min-h-10 rounded-lg px-3 py-2 text-left transition-[transform,color,background-color,box-shadow] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-raised active:scale-[0.96] ${
                selected
                  ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.06)]"
                  : "text-faint hover:bg-surface hover:text-muted"
              }`}
            >
              <span className="block text-xs font-semibold">{mode.label}</span>
              <span className="mt-0.5 block text-2xs">{mode.summary}</span>
            </button>
          );
        })}
      </div>
      <p
        className="px-2 pb-2 pt-2.5 text-pretty text-2xs leading-relaxed text-muted"
        aria-live="polite"
      >
        <span className="font-medium text-ink">{active.label}:</span>{" "}
        {active.detail}
      </p>
    </section>
  );
}
