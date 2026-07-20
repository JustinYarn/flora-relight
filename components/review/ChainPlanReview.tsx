"use client";

import { useState } from "react";

import {
  estimateLampChainSequence,
  formatUsd,
  lampChainSequenceReservationUsd,
} from "@/lib/cost";
import { LAMP_COMBINED_CLEANLINESS_PROFILES } from "@/lib/lamp-combined";
import { type LampChainStage } from "@/lib/lamp-chain";
import { useAppStore } from "@/lib/store";
import type { Run } from "@/lib/types";
import { runWorkflowMode } from "@/lib/workflow-mode";
import { DEFAULT_RELIGHT_INTENSITY } from "@/lib/relight-intensity";
import { ConfirmSpend } from "@/components/shell/ConfirmSpend";
import { Badge, Button, Card } from "@/components/ui";
import {
  BackgroundScope,
  BeautifyScope,
  ControlPill,
  IrisScope,
} from "@/components/review/CombinedPlanReview";

function formatReservationUsd(usd: number): string {
  return `$${(Math.ceil(usd * 100) / 100).toFixed(2)}`;
}

const CHAIN_STAGE_LABELS: Record<LampChainStage, string> = {
  background: "Background",
  lamp: "Lamp",
  beautify: "Beautify",
  iris: "Iris",
};

/**
 * One approval for the ordered chain: the aggregate subplans plus the exact
 * stage order. The approve action is hash-bound — the store recomputes
 * `hashLampChainPlan` over this exact plan (order included) and POSTs it to
 * /api/chain-plan/approve, so any reorder or subplan edit invalidates the
 * presented approval.
 */
export function ChainPlanReview({
  run,
  interactive = true,
  compact = false,
}: {
  run: Run;
  interactive?: boolean;
  compact?: boolean;
}) {
  const approveChainPlan = useAppStore((state) => state.approveChainPlan);
  const [confirmingSpend, setConfirmingSpend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = run.chainPlan;

  if (runWorkflowMode(run) !== "chain" || !plan) return null;

  const liveRun = run.live === true;
  const approved = plan.aggregate.approval.status === "approved";
  const pausedForApproval =
    run.serverExecution?.status === "user_action_required" ||
    (liveRun &&
      approved &&
      run.serverExecution === undefined &&
      run.status === "running");
  const controls = plan.aggregate.controls;
  const stageOrder = plan.stageOrder;
  const stageCount = stageOrder.length;
  const estimate = estimateLampChainSequence(
    controls,
    run.originalVideo.durationSec
  );
  const reservation = lampChainSequenceReservationUsd(
    controls,
    run.originalVideo.durationSec
  );
  // Per-stage lines derive from the same estimate the totals use, split by
  // label family so they can never drift from the priced items.
  const generationUsd = estimate.items
    .filter((item) => item.label.includes("generation"))
    .reduce((sum, item) => sum + item.usd, 0);
  const evaluationUsd = estimate.items
    .filter((item) => item.label.includes("evaluation"))
    .reduce((sum, item) => sum + item.usd, 0);
  const perStageGenerationUsd = generationUsd / stageCount;
  const perStageEvaluationUsd = evaluationUsd / stageCount;
  const cleanliness =
    LAMP_COMBINED_CLEANLINESS_PROFILES[plan.aggregate.controls.cleanlinessLevel];
  const relightIntensity = run.relightIntensity ?? DEFAULT_RELIGHT_INTENSITY;

  const approve = async (approveLiveSpend: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await approveChainPlan(run.id, { approveLiveSpend });
      setConfirmingSpend(false);
    } catch (approvalError) {
      setError(
        approvalError instanceof Error
          ? approvalError.message
          : "The Chain plan could not be approved."
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
                ? "One approved order for the whole chain"
                : "One approval for the ordered chain"}
            </p>
            <h2 className="mt-1 text-balance text-lg font-semibold text-ink">
              Lamp Chain plan
            </h2>
            <p className="mt-2 max-w-3xl text-pretty text-sm leading-relaxed text-muted">
              Each enabled concern runs as its own single-pass stage over the
              previous stage&apos;s cut, in exactly the order below. The final
              cut is delivered on structural proof; every evaluation is a
              detached report card that attaches afterwards.
            </p>
          </div>
          <Badge color={approved ? "var(--pass)" : "var(--borderline)"}>
            {approved ? "human approved" : "approval required"}
          </Badge>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <ControlPill label="Relight" value={`${relightIntensity} / 100`} />
          <ControlPill
            label="Background"
            value={`${cleanliness.label} · ${plan.aggregate.controls.cleanlinessLevel}/3`}
          />
          <ControlPill
            label="Beautify"
            value={
              plan.aggregate.controls.beautifyLevel === 0
                ? "Off"
                : `${plan.aggregate.controls.beautifyLevel} / 3`
            }
          />
          <ControlPill
            label="Eye contact"
            value={plan.aggregate.controls.eyeContact ? "Presenter · P2" : "Off"}
          />
        </div>

        {/* ORDER STRIP — approved identity: reordering invalidates the hash. */}
        <div className="mt-4 rounded-xl bg-raised p-3.5">
          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
            Stage order
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {stageOrder.map((stage, index) => (
              <span key={stage} className="flex items-center gap-1.5">
                <span className="flex items-center gap-1.5 rounded-lg bg-surface px-2.5 py-1.5 text-xs font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.24),0_0_0_1px_rgba(255,255,255,0.07)]">
                  <span className="tabular-nums text-accent">{index + 1}</span>
                  {CHAIN_STAGE_LABELS[stage]}
                </span>
                {index < stageOrder.length - 1 ? (
                  <span aria-hidden="true" className="text-xs text-faint">
                    →
                  </span>
                ) : null}
              </span>
            ))}
          </div>
          <p className="mt-2 text-pretty text-2xs leading-relaxed text-faint">
            Stage 1 generates from the immutable source; every later stage
            conditions on the previous stage&apos;s audio-remuxed cut. The
            order binds into the approval hash, so changing it requires a new
            review.
          </p>
        </div>

        <BackgroundScope plan={plan.aggregate} />
        <BeautifyScope plan={plan.aggregate} />
        <IrisScope plan={plan.aggregate} />

        {/* COST ROWS — the sequence estimate this approval would authorize. */}
        <section className="mt-5 border-t border-edge pt-5">
          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
            Estimated chain spend after approval
          </p>
          <ul className="mt-2 space-y-1">
            {estimate.items.map((item) => (
              <li
                key={item.label}
                className="flex items-baseline justify-between gap-3 text-xs text-muted"
              >
                <span className="min-w-0 text-pretty">{item.label}</span>
                <span className="shrink-0 tabular-nums text-ink">
                  {formatUsd(item.usd)}
                </span>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-3 border-t border-edge pt-1.5 text-xs font-medium text-ink">
              <span>Total ({stageCount} stages)</span>
              <span className="tabular-nums">{formatUsd(estimate.totalUsd)}</span>
            </li>
          </ul>
        </section>

        <div className="mt-5 border-t border-edge pt-4">
          <p className="text-pretty text-xs leading-relaxed text-muted">
            Approval freezes the subplans and the stage order in one click and
            authorizes exactly {stageCount} single-pass generations plus{" "}
            {stageCount} detached stage evaluations — never a Lipsync repair.
            Delivery does not wait for evaluations; the report card attaches
            afterwards.
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
                  ? "Completed provider journals stay saved. Renewing this exact approval resumes without rebilling finished stages."
                  : "No stage can generate until this exact ordered plan is approved."}
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
                    ? "Resuming Chain…"
                    : "Approving plan…"
                  : pausedForApproval
                    ? "Review spend & resume"
                    : liveRun
                      ? "Review spend & approve"
                      : "Approve chain & start"}
              </Button>
            </div>
          ) : approved ? (
            <p className="mt-3 text-2xs text-pass">
              This exact plan, all controls, and the stage order are locked to
              this source.
            </p>
          ) : null}
        </div>
      </Card>

      {confirmingSpend ? (
        <ConfirmSpend
          title={
            pausedForApproval
              ? "Renew approval and resume Lamp Chain?"
              : `Approve this ordered plan and run all ${stageCount} stages?`
          }
          lines={[
            `${run.originalVideo.label} — ${run.originalVideo.durationSec.toFixed(1)}s`,
            `Order locked to this approval: ${stageOrder
              .map((stage, index) => `${index + 1} ${CHAIN_STAGE_LABELS[stage]}`)
              .join(" → ")}.`,
            ...stageOrder.map(
              (stage, index) =>
                `Stage ${index + 1} — ${CHAIN_STAGE_LABELS[stage]}: one single-pass generation over ${
                  index === 0 ? "the immutable source" : `stage ${index}'s cut`
                } · est. ${formatUsd(perStageGenerationUsd)}`
            ),
            ...stageOrder.map(
              (stage, index) =>
                `Detached eval ${index + 1} — ${CHAIN_STAGE_LABELS[stage]}: one holistic judge call vs the original, after delivery · est. ${formatUsd(perStageEvaluationUsd)}`
            ),
            "Delivery does not wait for evaluations; the report card attaches afterwards.",
            `Estimated provider cost after plan approval: ${formatUsd(estimate.totalUsd)}`,
            `Spend authorization: the server reserves ${formatReservationUsd(reservation)} for exactly ${stageCount} stage generations and ${stageCount} detached stage evaluations. A Lipsync repair is never authorized for a chain.`,
            `Controls locked to this approval: relight ${relightIntensity}/100; background ${cleanliness.label}; Beautify ${plan.aggregate.controls.beautifyLevel === 0 ? "off" : `${plan.aggregate.controls.beautifyLevel}/3`}; eye contact ${plan.aggregate.controls.eyeContact ? "Presenter P2" : "off"}.`,
          ]}
          confirmLabel={
            pausedForApproval ? "Renew approval & resume" : "Approve chain & start"
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
