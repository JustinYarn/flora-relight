"use client";

/**
 * Flora (legacy one-pass) is retired for new work, so the old two-button
 * selector is now a static Lamp panel. Existing Flora runs remain viewable
 * and resumable from their own records; only new work is Lamp.
 */
export function WorkflowModeSelector({
  className = "",
}: {
  className?: string;
}) {
  return (
    <section
      aria-label="Relight workflow"
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
    </section>
  );
}
