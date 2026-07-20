"use client";

import { useState } from "react";

import {
  estimateLampCombinedTwoPass,
  formatUsd,
  lampCombinedTwoPassReservationUsd,
} from "@/lib/cost";
import {
  LAMP_COMBINED_CLEANLINESS_PROFILES,
  type LampCombinedPlan,
} from "@/lib/lamp-combined";
import { useAppStore } from "@/lib/store";
import type { Run } from "@/lib/types";
import { runWorkflowMode } from "@/lib/workflow-mode";
import { DEFAULT_RELIGHT_INTENSITY } from "@/lib/relight-intensity";
import { ConfirmSpend } from "@/components/shell/ConfirmSpend";
import { Badge, Button, Card } from "@/components/ui";

function formatReservationUsd(usd: number): string {
  return `$${(Math.ceil(usd * 100) / 100).toFixed(2)}`;
}

function plainLabel(value: string): string {
  return value.replaceAll("-", " ");
}

interface PlanListItem {
  id: string;
  label?: string;
  location?: string;
  rationale?: string;
  evidence?: string;
  reason?: string;
  uncertainty?: string;
}

function PlanBucket({
  title,
  description,
  items,
  color,
  empty = "None.",
}: {
  title: string;
  description: string;
  items: readonly PlanListItem[];
  color: string;
  empty?: string;
}) {
  return (
    <section className="rounded-xl bg-raised p-3.5">
      <div className="flex items-center gap-2">
        <span
          className="size-2 rounded-full"
          style={{ background: color }}
          aria-hidden="true"
        />
        <h4 className="text-sm font-medium text-ink">{title}</h4>
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
            <li
              key={item.id}
              className="border-t border-edge pt-3 first:border-0 first:pt-0"
            >
              <p className="text-sm font-medium capitalize text-ink">
                {item.label ?? plainLabel(item.id)}
              </p>
              {item.location ? (
                <p className="mt-0.5 text-2xs text-faint">{item.location}</p>
              ) : null}
              <p className="mt-1 text-pretty text-xs leading-relaxed text-muted">
                {item.rationale ?? item.reason ?? item.uncertainty}
              </p>
              {item.evidence ? (
                <p className="mt-1 text-pretty text-2xs leading-relaxed text-faint">
                  Observed: {item.evidence}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-faint">{empty}</p>
      )}
    </section>
  );
}

export function ControlPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-raised px-3 py-2.5">
      <p className="text-2xs text-faint">{label}</p>
      <p className="mt-0.5 text-sm font-medium tabular-nums text-ink">
        {value}
      </p>
    </div>
  );
}

export function BackgroundScope({ plan }: { plan: LampCombinedPlan }) {
  const background = plan.backgroundPlan;
  return (
    <section className="mt-5 border-t border-edge pt-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
            Background
          </p>
          <h3 className="mt-1 text-base font-semibold text-ink">
            {background.decision === "cleanup"
              ? "Approved cleanup boundaries"
              : "Planner found no safe removal target"}
          </h3>
          <p className="mt-1 max-w-3xl text-pretty text-xs leading-relaxed text-muted">
            {background.sceneSummary}
          </p>
        </div>
        <Badge color="var(--accent)">
          {
            LAMP_COMBINED_CLEANLINESS_PROFILES[
              plan.controls.cleanlinessLevel
            ].label
          }
        </Badge>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <PlanBucket
          title="Remove"
          description="Only these exact targets may be removed."
          items={background.remove}
          color="var(--accent)"
          empty="No removal targets approved."
        />
        <PlanBucket
          title="Preserve"
          description="These scene details stay source-faithful."
          items={background.preserve}
          color="var(--pass)"
          empty="No extra preserve callouts."
        />
        <PlanBucket
          title="Uncertain"
          description="Ambiguous details are protected by default."
          items={background.uncertain}
          color="var(--borderline)"
          empty="No uncertain scene details."
        />
      </div>
    </section>
  );
}

export function BeautifyScope({ plan }: { plan: LampCombinedPlan }) {
  if (plan.beautify.state === "disabled") {
    return (
      <section className="mt-5 border-t border-edge pt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
              Beautify
            </p>
            <h3 className="mt-1 text-base font-semibold text-ink">
              Fully locked off
            </h3>
            <p className="mt-1 text-pretty text-xs leading-relaxed text-muted">
              The Beautify planner was skipped, so no appearance edit can be
              introduced later by generation or correction.
            </p>
          </div>
          <Badge>off</Badge>
        </div>
      </section>
    );
  }

  const beautify = plan.beautify.plan;
  return (
    <section className="mt-5 border-t border-edge pt-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
            Beautify
          </p>
          <h3 className="mt-1 text-base font-semibold text-ink">
            {beautify.decision === "enhance"
              ? "Approved presentation touch-ups"
              : "Planner approved no appearance edits"}
          </h3>
          <p className="mt-1 max-w-3xl text-pretty text-xs leading-relaxed text-muted">
            {beautify.subjectSummary}
          </p>
        </div>
        <Badge color="var(--accent)">
          level {plan.controls.beautifyLevel} of 3
        </Badge>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <PlanBucket
          title="Enhance"
          description="Only these approved categories may change."
          items={beautify.enhance}
          color="var(--accent)"
          empty="No touch-ups approved."
        />
        <PlanBucket
          title="Declined"
          description="Considered and explicitly kept unchanged."
          items={beautify.declined}
          color="var(--pass)"
          empty="No declined categories."
        />
        <PlanBucket
          title="Uncertain"
          description="Ambiguous categories decline by default."
          items={beautify.uncertain}
          color="var(--borderline)"
          empty="No uncertain categories."
        />
      </div>
    </section>
  );
}

export function IrisScope({ plan }: { plan: LampCombinedPlan }) {
  if (plan.iris.state === "disabled") {
    return (
      <section className="mt-5 border-t border-edge pt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
              Eye contact
            </p>
            <h3 className="mt-1 text-base font-semibold text-ink">
              Fully locked off
            </h3>
            <p className="mt-1 text-pretty text-xs leading-relaxed text-muted">
              The gaze planner was skipped, so the source gaze and eye motion
              remain protected.
            </p>
          </div>
          <Badge>off</Badge>
        </div>
      </section>
    );
  }

  const iris = plan.iris.plan;
  return (
    <section className="mt-5 border-t border-edge pt-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
            Eye contact
          </p>
          <h3 className="mt-1 text-base font-semibold text-ink">
            {iris.decision === "correct"
              ? "Approved presenter gaze corrections"
              : "Planner approved no gaze edits"}
          </h3>
          <p className="mt-1 max-w-3xl text-pretty text-xs leading-relaxed text-muted">
            {iris.subjectSummary}
          </p>
        </div>
        <Badge color="var(--accent)">Presenter · level 2</Badge>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <PlanBucket
          title="Correct"
          description="Only these gaze categories may change."
          items={iris.correct}
          color="var(--accent)"
          empty="No gaze corrections approved."
        />
        <PlanBucket
          title="Declined"
          description="Considered and explicitly kept unchanged."
          items={iris.declined}
          color="var(--pass)"
          empty="No declined gaze categories."
        />
        <PlanBucket
          title="Uncertain"
          description="Ambiguous gaze behavior declines by default."
          items={iris.uncertain}
          color="var(--borderline)"
          empty="No uncertain gaze categories."
        />
      </div>
    </section>
  );
}

export function CombinedPlanReview({
  run,
  interactive = true,
  compact = false,
}: {
  run: Run;
  interactive?: boolean;
  compact?: boolean;
}) {
  const approveCombinedPlan = useAppStore(
    (state) => state.approveCombinedPlan
  );
  const [confirmingSpend, setConfirmingSpend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = run.combinedPlan;

  if (runWorkflowMode(run) !== "combined" || !plan) return null;

  const liveRun = run.live === true;
  const approved = plan.approval.status === "approved";
  const pausedForApproval =
    run.serverExecution?.status === "user_action_required" ||
    (liveRun &&
      approved &&
      run.serverExecution === undefined &&
      run.status === "running");
  const estimate = estimateLampCombinedTwoPass(
    run.originalVideo.durationSec
  );
  const reservation = lampCombinedTwoPassReservationUsd(
    run.originalVideo.durationSec
  );
  const cleanliness =
    LAMP_COMBINED_CLEANLINESS_PROFILES[plan.controls.cleanlinessLevel];
  const relightIntensity =
    run.relightIntensity ?? DEFAULT_RELIGHT_INTENSITY;

  const approve = async (approveLiveSpend: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await approveCombinedPlan(run.id, { approveLiveSpend });
      setConfirmingSpend(false);
    } catch (approvalError) {
      setError(
        approvalError instanceof Error
          ? approvalError.message
          : "The Combined plan could not be approved."
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
                ? "One approved scope for both takes"
                : "One approval for the complete edit"}
            </p>
            <h2 className="mt-1 text-balance text-lg font-semibold text-ink">
              Lamp Combined plan
            </h2>
            <p className="mt-2 max-w-3xl text-pretty text-sm leading-relaxed text-muted">
              Lighting and background cleanup are always active. Optional
              appearance and gaze work are either explicitly scoped below or
              locked off. Both takes start separately from the original.
            </p>
          </div>
          <Badge color={approved ? "var(--pass)" : "var(--borderline)"}>
            {approved ? "human approved" : "approval required"}
          </Badge>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <ControlPill
            label="Relight"
            value={`${relightIntensity} / 100`}
          />
          <ControlPill
            label="Background"
            value={`${cleanliness.label} · ${plan.controls.cleanlinessLevel}/3`}
          />
          <ControlPill
            label="Beautify"
            value={
              plan.controls.beautifyLevel === 0
                ? "Off"
                : `${plan.controls.beautifyLevel} / 3`
            }
          />
          <ControlPill
            label="Eye contact"
            value={plan.controls.eyeContact ? "Presenter · P2" : "Off"}
          />
        </div>

        <BackgroundScope plan={plan} />
        <BeautifyScope plan={plan} />
        <IrisScope plan={plan} />

        <div className="mt-5 border-t border-edge pt-4">
          <p className="text-pretty text-xs leading-relaxed text-muted">
            Approval freezes this entire plan in one click. Take 1 and Take 2
            are generated separately from the immutable source—Take 2 never
            edits Take 1—and each must pass its own audio, sync, and complete
            evaluation checks before it can enter your winner choice.
          </p>
          {error ? (
            <p className="mt-3 text-xs leading-relaxed text-fail" role="alert">
              {error}
            </p>
          ) : null}
          {interactive && (!approved || pausedForApproval) ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-2xl text-pretty text-2xs leading-relaxed text-faint">
                {pausedForApproval
                  ? "Completed provider journals stay saved. Renewing this exact approval resumes without rebilling finished work."
                  : "Generation cannot begin until this exact aggregate plan is approved."}
              </p>
              <Button
                disabled={busy}
                onClick={() => {
                  if (liveRun) {
                    setConfirmingSpend(true);
                    return;
                  }
                  void approve(false);
                }}
              >
                {busy
                  ? pausedForApproval
                    ? "Resuming Combined…"
                    : "Approving plan…"
                  : pausedForApproval
                    ? "Review spend & resume"
                    : liveRun
                      ? "Review spend & approve"
                      : "Approve plan & run demo"}
              </Button>
            </div>
          ) : approved ? (
            <p className="mt-3 text-2xs text-pass">
              This exact plan and all four controls are locked to this source.
            </p>
          ) : null}
        </div>
      </Card>

      {confirmingSpend ? (
        <ConfirmSpend
          title={
            pausedForApproval
              ? "Renew approval and resume Lamp Combined?"
              : "Approve this plan and create both takes?"
          }
          lines={[
            `${run.originalVideo.label} — ${run.originalVideo.durationSec.toFixed(1)}s`,
            `Estimated provider cost after plan approval: ${formatUsd(estimate.totalUsd)}`,
            `Spend authorization: the server reserves ${formatReservationUsd(reservation)} for exactly two source-rooted generations, two whole-video evaluations, and at most one Take 2 Lipsync-2-Pro repair. The completed planning calls are excluded.`,
            `Controls locked to this approval: relight ${relightIntensity}/100; background ${cleanliness.label}; Beautify ${plan.controls.beautifyLevel === 0 ? "off" : `${plan.controls.beautifyLevel}/3`}; eye contact ${plan.controls.eyeContact ? "Presenter P2" : "off"}.`,
            "Take 1 and Take 2 both start from the immutable original. Take 2 receives only the frozen prompt plus the bounded correction ledger—never Take 1's generated pixels.",
            "There is one correction pass, no chaining, and no open-ended regeneration loop. After both candidates finish qualification, you choose among the eligible takes before blind grading.",
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
