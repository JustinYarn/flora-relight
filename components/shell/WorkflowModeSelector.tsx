"use client";

/**
 * Lamp Iris is the only method offered for new work in this experiment.
 * Historical Flora and Lamp runs remain viewable and resumable from their own
 * records without changing their saved workflow identity.
 */
export function WorkflowModeSelector({
  className = "",
}: {
  className?: string;
}) {
  return (
    <section
      aria-label="Eye-contact correction workflow"
      className={`rounded-xl bg-raised p-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)] ${className}`}
    >
      <div className="rounded-lg bg-surface px-3 py-2 text-left shadow-[0_1px_2px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.06)]">
        <span className="block text-xs font-semibold text-ink">
          Lamp Iris
        </span>
        <span className="mt-0.5 block text-2xs text-muted">
          Plan + two-pass eye contact
        </span>
      </div>
      <p className="px-2 pb-2 pt-2.5 text-pretty text-2xs leading-relaxed text-muted">
        <span className="font-medium text-ink">Lamp Iris:</span> Approve a
        gaze-correction plan, generate Initial, critique the whole video once,
        generate Final from the source, then grade it blind before comparing
        with AI. Existing Flora and Lamp runs stay viewable.
      </p>
    </section>
  );
}
