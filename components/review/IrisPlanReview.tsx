"use client";

import { useState } from "react";

import {
  estimateLampIrisTwoPass,
  formatUsd,
  lampIrisTwoPassReservationUsd,
} from "@/lib/cost";
import type {
  LampIrisCorrectItem,
  LampIrisDeclinedItem,
  LampIrisIntensity,
  LampIrisPlan,
  LampIrisUncertainItem,
} from "@/lib/lamp-iris";
import { useAppStore } from "@/lib/store";
import type { Run } from "@/lib/types";
import { Badge, Button, Card } from "@/components/ui";
import { ConfirmSpend } from "@/components/shell/ConfirmSpend";
import { runWorkflowMode } from "@/lib/workflow-mode";

function formatReservationUsd(usd: number): string {
  return `$${(Math.ceil(usd * 100) / 100).toFixed(2)}`;
}

const INTENSITY_LABEL: Record<1 | 2 | 3, string> = {
  1: "intensity 1 · natural assist",
  2: "intensity 2 · presenter",
  3: "intensity 3 · anchor",
};

function categoryTitle(id: string): string {
  return id.replaceAll("-", " ");
}

function CorrectItems({ items }: { items: LampIrisCorrectItem[] }) {
  return (
    <section className="rounded-xl bg-raised p-3.5">
      <div className="flex items-center gap-2">
        <span
          className="size-2 rounded-full"
          style={{ background: "var(--accent)" }}
          aria-hidden="true"
        />
        <h3 className="text-sm font-medium text-ink">Correct</h3>
        <span className="ml-auto text-2xs tabular-nums text-faint">
          {items.length}
        </span>
      </div>
      <p className="mt-1 text-pretty text-2xs leading-relaxed text-muted">
        Approved gaze-correction categories. Nothing outside this list may
        change.
      </p>
      {items.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="border-t border-edge pt-3 first:border-0 first:pt-0"
            >
              <p className="text-sm font-medium capitalize text-ink">
                {categoryTitle(item.id)}
              </p>
              <p className="mt-0.5 text-2xs text-accent">
                {INTENSITY_LABEL[item.intensity]}
              </p>
              <p className="mt-1 text-pretty text-xs leading-relaxed text-muted">
                {item.rationale}
              </p>
              <p className="mt-1 text-pretty text-2xs leading-relaxed text-faint">
                Observed: {item.evidence}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-faint">None approved.</p>
      )}
    </section>
  );
}

function DeclinedItems({ items }: { items: LampIrisDeclinedItem[] }) {
  return (
    <section className="rounded-xl bg-raised p-3.5">
      <div className="flex items-center gap-2">
        <span
          className="size-2 rounded-full"
          style={{ background: "var(--pass)" }}
          aria-hidden="true"
        />
        <h3 className="text-sm font-medium text-ink">Declined</h3>
        <span className="ml-auto text-2xs tabular-nums text-faint">
          {items.length}
        </span>
      </div>
      <p className="mt-1 text-pretty text-2xs leading-relaxed text-muted">
        Considered and rejected — these stay exactly as filmed.
      </p>
      {items.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="border-t border-edge pt-3 first:border-0 first:pt-0"
            >
              <p className="text-sm font-medium capitalize text-ink">
                {categoryTitle(item.id)}
              </p>
              <p className="mt-1 text-pretty text-xs leading-relaxed text-muted">
                {item.reason}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-faint">None declined.</p>
      )}
    </section>
  );
}

function UncertainItems({ items }: { items: LampIrisUncertainItem[] }) {
  return (
    <section className="rounded-xl bg-raised p-3.5">
      <div className="flex items-center gap-2">
        <span
          className="size-2 rounded-full"
          style={{ background: "var(--borderline)" }}
          aria-hidden="true"
        />
        <h3 className="text-sm font-medium text-ink">Uncertain</h3>
        <span className="ml-auto text-2xs tabular-nums text-faint">
          {items.length}
        </span>
      </div>
      <p className="mt-1 text-pretty text-2xs leading-relaxed text-muted">
        Ambiguous categories decline by default and remain untouched.
      </p>
      {items.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="border-t border-edge pt-3 first:border-0 first:pt-0"
            >
              <p className="text-sm font-medium capitalize text-ink">
                {categoryTitle(item.id)}
              </p>
              <p className="mt-1 text-pretty text-2xs leading-relaxed text-borderline">
                Uncertainty: {item.uncertainty} Declined by default.
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-faint">None identified.</p>
      )}
    </section>
  );
}

function ApprovalCopy({ plan }: { plan: LampIrisPlan }) {
  if (plan.decision === "exceptional-no-op") {
    return (
      <div className="rounded-xl border border-borderline/40 bg-[color-mix(in_srgb,var(--borderline)_8%,transparent)] p-3.5">
        <p className="text-sm font-medium text-ink">
          Exceptional unchanged delivery
        </p>
        <p className="mt-1 text-pretty text-xs leading-relaxed text-muted">
          {plan.noOpJustification?.summary}
        </p>
        <p className="mt-2 text-pretty text-2xs leading-relaxed text-faint">
          {plan.noOpJustification?.whyCorrectionWouldNotImproveContact}
        </p>
      </div>
    );
  }
  return (
    <p className="text-pretty text-xs leading-relaxed text-muted">
      Approval freezes these classifications. Both generations may apply only
      the approved gaze corrections at their approved intensities, and must
      keep identity, blinks, head pose, lip-sync, expression, wardrobe, other
      people, the background, lighting, camera, framing, and source audio
      unchanged.
    </p>
  );
}

export function IrisPlanReview({
  run,
  interactive = true,
  compact = false,
}: {
  run: Run;
  interactive?: boolean;
  compact?: boolean;
}) {
  const mode = useAppStore((state) => state.mode);
  const approveIrisPlan = useAppStore(
    (state) => state.approveIrisPlan
  );
  const [confirmingSpend, setConfirmingSpend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intensityOverride, setIntensityOverride] = useState<
    LampIrisIntensity | null
  >(null);
  const plan = run.irisPlan;
  if (runWorkflowMode(run) !== "iris" || !plan) return null;

  const approved = plan.approval.status === "approved";
  const correct = plan.decision === "correct";
  const effectiveCorrect =
    !approved && correct && intensityOverride !== null
      ? plan.correct.map((item) => ({ ...item, intensity: intensityOverride }))
      : plan.correct;
  const pausedForApproval =
    run.serverExecution?.status === "user_action_required" ||
    (mode === "live" &&
      approved &&
      correct &&
      run.serverExecution === undefined &&
      run.status === "running");
  const estimate = estimateLampIrisTwoPass(run.originalVideo.durationSec);
  const reservation = lampIrisTwoPassReservationUsd(
    run.originalVideo.durationSec
  );

  const approve = async (approveLiveSpend: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await approveIrisPlan(run.id, {
        approveLiveSpend,
        ...(intensityOverride !== null
          ? { intensityOverride }
          : {}),
      });
      setConfirmingSpend(false);
    } catch (approvalError) {
      setError(
        approvalError instanceof Error
          ? approvalError.message
          : "The gaze plan could not be approved."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card className={compact ? "p-4" : "mb-6 p-5"}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-accent">
              {approved
                ? "Approved scope for this subject"
                : "Proposed scope for this subject"}
            </p>
            <h2 className="mt-1 text-balance text-lg font-semibold text-ink">
              Gaze-correction plan
            </h2>
            <p className="mt-2 max-w-3xl text-pretty text-sm leading-relaxed text-muted">
              {plan.subjectSummary}
            </p>
          </div>
          <Badge color={approved ? "var(--pass)" : "var(--borderline)"}>
            {approved ? "human approved" : "approval required"}
          </Badge>
        </div>

        <div
          className={`mt-4 grid gap-3 ${compact ? "lg:grid-cols-3" : "md:grid-cols-3"}`}
        >
          <CorrectItems items={effectiveCorrect} />
          <DeclinedItems items={plan.declined} />
          <UncertainItems items={plan.uncertain} />
        </div>

        {!approved && correct && interactive ? (
          <div className="mt-4 rounded-xl bg-raised p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-ink">
                  Contact intensity
                </p>
                <p className="mt-0.5 max-w-xl text-pretty text-2xs leading-relaxed text-muted">
                  One dial over every approved item — the same ladder the
                  prompts and the evaluator read. &ldquo;As planned&rdquo;
                  keeps the planner&apos;s per-item levels.
                </p>
              </div>
              <div
                role="radiogroup"
                aria-label="Contact intensity"
                className="flex overflow-hidden rounded-lg border border-edge"
              >
                {(
                  [
                    [null, "As planned"],
                    [1, "1 · Natural assist"],
                    [2, "2 · Presenter"],
                    [3, "3 · Anchor"],
                  ] as Array<[LampIrisIntensity | null, string]>
                ).map(([value, label]) => {
                  const selected = intensityOverride === value;
                  return (
                    <button
                      key={label}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={busy}
                      onClick={() => setIntensityOverride(value)}
                      className={`px-3 py-1.5 text-2xs font-medium transition-colors ${
                        selected
                          ? "bg-accent-soft text-accent"
                          : "text-muted hover:text-ink"
                      } border-l border-edge first:border-l-0`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="mt-2 text-2xs leading-relaxed text-faint">
              {intensityOverride === null
                ? "Approving with the planner's proposed intensities."
                : intensityOverride === 1
                  ? "Every approved item at 1 — clear reading patterns calmed, natural glance-aways survive."
                  : intensityOverride === 2
                    ? "Every approved item at 2 — contact holds through speech, natural breaks survive."
                    : "Every approved item at 3 — broadcast-anchor contact, alive and blinking, never a frozen stare."}
            </p>
          </div>
        ) : null}

        <div className="mt-4 border-t border-edge pt-4">
          <ApprovalCopy plan={plan} />
          {error ? (
            <p className="mt-3 text-xs leading-relaxed text-fail" role="alert">
              {error}
            </p>
          ) : null}
          {interactive && (!approved || pausedForApproval) ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-2xl text-pretty text-2xs leading-relaxed text-faint">
                {pausedForApproval
                  ? "Completed provider journals stay saved. Renewing the exact two-pass approval resumes this same execution without rebilling finished work."
                  : correct
                  ? "Generation cannot begin until you approve this exact plan."
                  : "This rare no-op delivers the exact source and does not authorize generation or a new AI evaluation."}
              </p>
              <Button
                disabled={busy}
                onClick={() => {
                  if (mode === "live" && correct) {
                    setConfirmingSpend(true);
                    return;
                  }
                  void approve(false);
                }}
              >
                {busy
                  ? pausedForApproval
                    ? "Resuming correction…"
                    : "Approving plan…"
                  : pausedForApproval
                    ? "Review spend & resume"
                    : correct
                    ? mode === "live"
                      ? "Review spend & approve"
                      : "Approve plan & run demo"
                    : "Approve unchanged delivery"}
              </Button>
            </div>
          ) : approved ? (
            <p className="mt-3 text-2xs text-pass">
              This exact plan is locked to the run and remains visible during
              blind grading.
            </p>
          ) : null}
        </div>
      </Card>

      {confirmingSpend ? (
        <ConfirmSpend
          title={
            pausedForApproval
              ? "Renew approval and resume this gaze correction?"
              : "Approve this plan and run the two-pass gaze correction?"
          }
          lines={[
            `${run.originalVideo.label} — ${run.originalVideo.durationSec.toFixed(1)}s`,
            `Estimated provider cost after plan approval: ${formatUsd(estimate.totalUsd)}`,
            `Spend authorization: the server reserves ${formatReservationUsd(reservation)} for exactly two gaze-correction generations, two whole-video evaluations, and at most one Final Lipsync-2-Pro repair. The completed planning call is excluded.`,
            intensityOverride === null
              ? "Approving with the planner's proposed per-item intensities."
              : `Intensity override: every approved item at ${intensityOverride} of 3 — the prompts and the evaluator's intensity contract both follow the dial.`,
            "Initial and Final both start from the immutable source and are bound to this exact correct / declined / uncertain plan.",
            "There is one correction pass and no open-ended regeneration loop.",
          ]}
          confirmLabel={
            pausedForApproval
              ? "Renew approval & resume"
              : "Approve plan & generate"
          }
          busy={busy}
          error={error}
          onConfirm={() => void approve(true)}
          onCancel={() => {
            if (busy) return;
            setError(null);
            setConfirmingSpend(false);
          }}
        />
      ) : null}
    </>
  );
}
