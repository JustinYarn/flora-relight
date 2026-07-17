"use client";

import { useState } from "react";

import {
  estimateLampBeautifyTwoPass,
  formatUsd,
  lampBeautifyTwoPassReservationUsd,
} from "@/lib/cost";
import type {
  LampBeautifyDeclinedItem,
  LampBeautifyEnhanceItem,
  LampBeautifyPlan,
  LampBeautifyUncertainItem,
} from "@/lib/lamp-beautify";
import { useAppStore } from "@/lib/store";
import type { Run } from "@/lib/types";
import { Badge, Button, Card } from "@/components/ui";
import { ConfirmSpend } from "@/components/shell/ConfirmSpend";

function formatReservationUsd(usd: number): string {
  return `$${(Math.ceil(usd * 100) / 100).toFixed(2)}`;
}

const INTENSITY_LABEL: Record<1 | 2 | 3, string> = {
  1: "intensity 1 · subtle",
  2: "intensity 2 · balanced",
  3: "intensity 3 · polished",
};

function categoryTitle(id: string): string {
  return id.replaceAll("-", " ");
}

function EnhanceItems({ items }: { items: LampBeautifyEnhanceItem[] }) {
  return (
    <section className="rounded-xl bg-raised p-3.5">
      <div className="flex items-center gap-2">
        <span
          className="size-2 rounded-full"
          style={{ background: "var(--accent)" }}
          aria-hidden="true"
        />
        <h3 className="text-sm font-medium text-ink">Enhance</h3>
        <span className="ml-auto text-2xs tabular-nums text-faint">
          {items.length}
        </span>
      </div>
      <p className="mt-1 text-pretty text-2xs leading-relaxed text-muted">
        Approved touch-up categories. Nothing outside this list may change.
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

function DeclinedItems({ items }: { items: LampBeautifyDeclinedItem[] }) {
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

function UncertainItems({ items }: { items: LampBeautifyUncertainItem[] }) {
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

function ApprovalCopy({ plan }: { plan: LampBeautifyPlan }) {
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
          {plan.noOpJustification?.whyEnhancementWouldNotImprovePresentation}
        </p>
      </div>
    );
  }
  return (
    <p className="text-pretty text-xs leading-relaxed text-muted">
      Approval freezes these classifications. Both generations may apply only
      the approved enhancements at their approved intensities, and must keep
      identity, permanent features, performance, wardrobe, other people, the
      background, lighting, camera, framing, and source audio unchanged.
    </p>
  );
}

export function BeautifyPlanReview({
  run,
  interactive = true,
  compact = false,
}: {
  run: Run;
  interactive?: boolean;
  compact?: boolean;
}) {
  const mode = useAppStore((state) => state.mode);
  const approveBeautifyPlan = useAppStore(
    (state) => state.approveBeautifyPlan
  );
  const [confirmingSpend, setConfirmingSpend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = run.beautifyPlan;
  if (run.workflowMode !== "beautify" || !plan) return null;

  const approved = plan.approval.status === "approved";
  const enhance = plan.decision === "enhance";
  const pausedForApproval =
    run.serverExecution?.status === "user_action_required" ||
    (mode === "live" &&
      approved &&
      enhance &&
      run.serverExecution === undefined &&
      run.status === "running");
  const estimate = estimateLampBeautifyTwoPass(run.originalVideo.durationSec);
  const reservation = lampBeautifyTwoPassReservationUsd(
    run.originalVideo.durationSec
  );

  const approve = async (approveLiveSpend: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await approveBeautifyPlan(run.id, { approveLiveSpend });
      setConfirmingSpend(false);
    } catch (approvalError) {
      setError(
        approvalError instanceof Error
          ? approvalError.message
          : "The enhancement plan could not be approved."
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
              On-camera enhancement plan
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
          <EnhanceItems items={plan.enhance} />
          <DeclinedItems items={plan.declined} />
          <UncertainItems items={plan.uncertain} />
        </div>

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
                  : enhance
                  ? "Generation cannot begin until you approve this exact plan."
                  : "This rare no-op delivers the exact source and does not authorize generation or a new AI evaluation."}
              </p>
              <Button
                disabled={busy}
                onClick={() => {
                  if (mode === "live" && enhance) {
                    setConfirmingSpend(true);
                    return;
                  }
                  void approve(false);
                }}
              >
                {busy
                  ? pausedForApproval
                    ? "Resuming touch-up…"
                    : "Approving plan…"
                  : pausedForApproval
                    ? "Review spend & resume"
                    : enhance
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
              ? "Renew approval and resume this touch-up?"
              : "Approve this plan and run the two-pass touch-up?"
          }
          lines={[
            `${run.originalVideo.label} — ${run.originalVideo.durationSec.toFixed(1)}s`,
            `Estimated provider cost after plan approval: ${formatUsd(estimate.totalUsd)}`,
            `Spend authorization: the server reserves ${formatReservationUsd(reservation)} for exactly two touch-up generations, two whole-video evaluations, and at most one Final Lipsync-2-Pro repair. The completed planning call is excluded.`,
            "Initial and Final both start from the immutable source and are bound to this exact enhance / declined / uncertain plan.",
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
