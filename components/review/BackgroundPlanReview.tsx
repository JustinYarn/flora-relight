"use client";

import { useState } from "react";

import {
  estimateLampBackgroundTwoPass,
  formatUsd,
  lampBackgroundTwoPassReservationUsd,
} from "@/lib/cost";
import type {
  LampBackgroundCleanupPlan,
  LampBackgroundPlanItem,
  LampBackgroundUncertainItem,
} from "@/lib/lamp-background";
import { useAppStore } from "@/lib/store";
import type { Run } from "@/lib/types";
import { Badge, Button, Card } from "@/components/ui";
import { ConfirmSpend } from "@/components/shell/ConfirmSpend";

function formatReservationUsd(usd: number): string {
  return `$${(Math.ceil(usd * 100) / 100).toFixed(2)}`;
}

function PlanItems({
  title,
  description,
  items,
  tone,
}: {
  title: string;
  description: string;
  items: Array<LampBackgroundPlanItem | LampBackgroundUncertainItem>;
  tone: "remove" | "preserve" | "uncertain";
}) {
  const color =
    tone === "remove"
      ? "var(--accent)"
      : tone === "preserve"
        ? "var(--pass)"
        : "var(--borderline)";
  return (
    <section className="rounded-xl bg-raised p-3.5">
      <div className="flex items-center gap-2">
        <span
          className="size-2 rounded-full"
          style={{ background: color }}
          aria-hidden="true"
        />
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <span className="ml-auto text-2xs tabular-nums text-faint">
          {items.length}
        </span>
      </div>
      <p className="mt-1 text-pretty text-2xs leading-relaxed text-muted">
        {description}
      </p>
      {items.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {items.map((item) => (
            <li key={item.id} className="border-t border-edge pt-3 first:border-0 first:pt-0">
              <p className="text-sm font-medium text-ink">{item.label}</p>
              <p className="mt-0.5 text-2xs text-faint">
                {item.location} · {item.temporalVisibility.replaceAll("-", " ")}
              </p>
              <p className="mt-1 text-pretty text-xs leading-relaxed text-muted">
                {item.rationale}
              </p>
              {"uncertainty" in item ? (
                <p className="mt-1 text-pretty text-2xs leading-relaxed text-borderline">
                  Uncertainty: {item.uncertainty} Preserve by default.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-faint">None identified.</p>
      )}
    </section>
  );
}

function ApprovalCopy({ plan }: { plan: LampBackgroundCleanupPlan }) {
  if (plan.decision === "exceptional-no-op") {
    return (
      <div className="rounded-xl border border-borderline/40 bg-[color-mix(in_srgb,var(--borderline)_8%,transparent)] p-3.5">
        <p className="text-sm font-medium text-ink">Exceptional unchanged delivery</p>
        <p className="mt-1 text-pretty text-xs leading-relaxed text-muted">
          {plan.noOpJustification?.summary}
        </p>
        <p className="mt-2 text-pretty text-2xs leading-relaxed text-faint">
          {plan.noOpJustification?.whyRemovalWouldNotImprovePresentation}
        </p>
      </div>
    );
  }
  return (
    <p className="text-pretty text-xs leading-relaxed text-muted">
      Approval freezes these classifications. Both generations must remove only
      the listed targets, preserve everything listed or uncertain, and keep the
      person, performance, lighting, camera, framing, focus, color, and source
      audio unchanged.
    </p>
  );
}

export function BackgroundPlanReview({
  run,
  interactive = true,
  compact = false,
}: {
  run: Run;
  interactive?: boolean;
  compact?: boolean;
}) {
  const mode = useAppStore((state) => state.mode);
  const approveBackgroundPlan = useAppStore(
    (state) => state.approveBackgroundPlan
  );
  const [confirmingSpend, setConfirmingSpend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = run.backgroundCleanupPlan;
  if (run.workflowMode !== "background" || !plan) return null;

  const approved = plan.approval.status === "approved";
  const cleanup = plan.decision === "cleanup";
  const pausedForApproval =
    run.serverExecution?.status === "user_action_required" ||
    (mode === "live" &&
      approved &&
      cleanup &&
      run.serverExecution === undefined &&
      run.status === "running");
  const estimate = estimateLampBackgroundTwoPass(
    run.originalVideo.durationSec
  );
  const reservation = lampBackgroundTwoPassReservationUsd(
    run.originalVideo.durationSec
  );

  const approve = async (approveLiveSpend: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await approveBackgroundPlan(run.id, { approveLiveSpend });
      setConfirmingSpend(false);
    } catch (approvalError) {
      setError(
        approvalError instanceof Error
          ? approvalError.message
          : "The cleanup plan could not be approved."
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
              {approved ? "Approved scope for this source" : "Proposed scope for this source"}
            </p>
            <h2 className="mt-1 text-balance text-lg font-semibold text-ink">
              Background cleanup plan
            </h2>
            <p className="mt-2 max-w-3xl text-pretty text-sm leading-relaxed text-muted">
              {plan.sceneSummary}
            </p>
          </div>
          <Badge color={approved ? "var(--pass)" : "var(--borderline)"}>
            {approved ? "human approved" : "approval required"}
          </Badge>
        </div>

        <div className={`mt-4 grid gap-3 ${compact ? "lg:grid-cols-3" : "md:grid-cols-3"}`}>
          <PlanItems
            title="Remove"
            description="Authorized clutter removal targets. Nothing else may be erased."
            items={plan.remove}
            tone="remove"
          />
          <PlanItems
            title="Preserve"
            description="Scene content that must stay visibly faithful to the source."
            items={plan.preserve}
            tone="preserve"
          />
          <PlanItems
            title="Uncertain"
            description="Ambiguous content remains protected unless a later plan explicitly changes it."
            items={plan.uncertain}
            tone="uncertain"
          />
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
                  : cleanup
                  ? "Generation cannot begin until you approve this exact plan."
                  : "This rare no-op delivers the exact source and does not authorize generation or a new AI evaluation."}
              </p>
              <Button
                disabled={busy}
                onClick={() => {
                  if (mode === "live" && cleanup) {
                    setConfirmingSpend(true);
                    return;
                  }
                  void approve(false);
                }}
              >
                {busy
                  ? pausedForApproval
                    ? "Resuming cleanup…"
                    : "Approving plan…"
                  : pausedForApproval
                    ? "Review spend & resume"
                    : cleanup
                    ? mode === "live"
                      ? "Review spend & approve"
                      : "Approve plan & run demo"
                    : "Approve unchanged delivery"}
              </Button>
            </div>
          ) : approved ? (
            <p className="mt-3 text-2xs text-pass">
              This exact plan is locked to the run and remains visible during blind grading.
            </p>
          ) : null}
        </div>
      </Card>

      {confirmingSpend ? (
        <ConfirmSpend
          title={
            pausedForApproval
              ? "Renew approval and resume this cleanup?"
              : "Approve this plan and run the two-pass cleanup?"
          }
          lines={[
            `${run.originalVideo.label} — ${run.originalVideo.durationSec.toFixed(1)}s`,
            `Estimated provider cost after plan approval: ${formatUsd(estimate.totalUsd)}`,
            `Spend authorization: the server reserves ${formatReservationUsd(reservation)} for exactly two cleanup generations, two whole-video evaluations, and at most one Final Lipsync-2-Pro repair. The completed planning call is excluded.`,
            "Initial and Final both start from the immutable source and are bound to this exact remove / preserve / uncertain plan.",
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
