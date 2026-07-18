"use client";

import Link from "next/link";

import {
  lampCombinedCandidateIneligibility,
  type LampCombinedCandidateIneligibility,
} from "@/lib/lamp-combined";
import {
  lampCombinedCandidateArtifactIdentityHash,
  lampCombinedCandidateReceiptEligible,
  lampCombinedCandidateReceiptToDeliveryCandidate,
} from "@/lib/lamp-combined-candidate-read";
import type { LampCombinedCandidateQualificationReceipt } from "@/lib/lamp-combined-candidate";
import type { Iteration, Run } from "@/lib/types";
import { runWorkflowMode } from "@/lib/workflow-mode";
import { Badge, Button, Card } from "@/components/ui";
import { isGradeableLampCombinedCandidate } from "@/components/grade/derive";

const INELIGIBLE_COPY: Record<
  LampCombinedCandidateIneligibility,
  string
> = {
  "generation-incomplete": "generation did not finish",
  "audio-unverified": "source audio is not verified",
  "sync-failed": "SyncNet failed; Take 1 cannot be repaired",
  "sync-unverified": "SyncNet proof is incomplete",
  "evaluation-incomplete": "whole-video evaluation is incomplete",
};

function receiptFor(
  run: Run,
  iteration: 1 | 2
): LampCombinedCandidateQualificationReceipt | undefined {
  return iteration === 1
    ? run.serverExecution?.combinedCandidateReceipts?.initial
    : run.serverExecution?.combinedCandidateReceipts?.final;
}

function candidateState(
  run: Run,
  iteration: 1 | 2,
  candidate?: Iteration
): {
  receipt?: LampCombinedCandidateQualificationReceipt;
  eligible: boolean;
  reason: string;
  gradeable: boolean;
} {
  const receipt = receiptFor(run, iteration);
  if (run.live === true) {
    if (!receipt) {
      return {
        eligible: false,
        gradeable: false,
        reason: "qualification proof is still pending",
      };
    }
    const ineligibility = lampCombinedCandidateIneligibility(
      lampCombinedCandidateReceiptToDeliveryCandidate(receipt)
    );
    return {
      receipt,
      eligible: lampCombinedCandidateReceiptEligible(receipt),
      gradeable: isGradeableLampCombinedCandidate(run, iteration),
      reason: ineligibility
        ? INELIGIBLE_COPY[ineligibility]
        : receipt.repair
          ? "qualified after one exact Take 2 sync repair"
          : "audio, sync, and evaluation proofs complete",
    };
  }
  const ready = Boolean(
    candidate?.generatedVideo && candidate.evalResults.length > 0
  );
  return {
    eligible: ready,
    gradeable: false,
    reason: ready
      ? "provider-free demo take; preview only"
      : "demo take is still being prepared",
  };
}

function CandidateCard({
  run,
  iteration,
  onPreview,
}: {
  run: Run;
  iteration: 1 | 2;
  onPreview: (iteration: 1 | 2) => void;
}) {
  const candidate = run.iterations.find((item) => item.index === iteration);
  const video = candidate?.generatedVideo;
  const state = candidateState(run, iteration, candidate);
  const gradedWinner = run.humanGrade?.gradedIteration;
  const savedWinner = gradedWinner === iteration;
  const savedHashMatches =
    !savedWinner ||
    (state.receipt !== undefined &&
      state.gradeable &&
      lampCombinedCandidateArtifactIdentityHash(state.receipt) ===
        run.humanGrade?.gradedCandidateArtifactIdentityHash);
  const alternateLocked = gradedWinner !== undefined && !savedWinner;

  return (
    <article
      className={`overflow-hidden rounded-xl border bg-raised transition-[border-color,box-shadow] duration-150 ${
        savedWinner
          ? "border-[color-mix(in_srgb,var(--pass)_55%,transparent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--pass)_14%,transparent)]"
          : "border-edge"
      }`}
    >
      <div className="aspect-video bg-black">
        {video ? (
          <video
            controls
            playsInline
            preload="metadata"
            src={video.url}
            className="size-full object-contain"
            aria-label={`Take ${iteration} candidate`}
          />
        ) : (
          <div className="flex size-full items-center justify-center px-5 text-center text-2xs text-faint">
            candidate video is not available yet
          </div>
        )}
      </div>
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">
            Take {iteration}
          </h3>
          <Badge
            color={
              savedWinner
                ? savedHashMatches
                  ? "var(--pass)"
                  : "var(--fail)"
                : state.eligible
                  ? "var(--pass)"
                  : "var(--borderline)"
            }
          >
            {savedWinner
              ? savedHashMatches
                ? "graded winner"
                : "winner proof mismatch"
              : state.eligible
                ? "eligible"
                : "not eligible"}
          </Badge>
        </div>
        <p className="mt-1.5 text-pretty text-2xs leading-relaxed text-muted">
          {state.reason}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="ghost"
            disabled={!video}
            onClick={() => onPreview(iteration)}
          >
            Preview with original
          </Button>
          {state.gradeable && gradedWinner === undefined ? (
            <Link
              href={`/grade?run=${encodeURIComponent(run.id)}&candidate=${iteration}`}
              className="inline-flex min-h-10 items-center rounded-lg border border-transparent bg-accent px-3.5 py-1.5 text-sm font-semibold text-[#0b0d10] transition-[transform,filter] duration-150 ease-out hover:brightness-110 active:scale-[0.96]"
            >
              Choose Take {iteration} &amp; grade blind
            </Link>
          ) : alternateLocked ? (
            <span className="inline-flex min-h-10 items-center px-1 text-2xs text-faint">
              choice locked after grade
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function CombinedWinnerPicker({
  run,
  onPreview,
}: {
  run: Run;
  onPreview: (iteration: 1 | 2) => void;
}) {
  if (
    runWorkflowMode(run) !== "combined" ||
    run.combinedPlan?.approval.status !== "approved" ||
    run.iterations.length === 0
  ) {
    return null;
  }

  const gradedWinner = run.humanGrade?.gradedIteration;
  return (
    <Card className="mb-6 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-accent">
            Human winner choice
          </p>
          <h2 className="mt-1 text-balance text-lg font-semibold text-ink">
            Compare both takes, then pick one
          </h2>
          <p className="mt-2 max-w-3xl text-pretty text-sm leading-relaxed text-muted">
            AI does not choose the winner. Watch both takes and their
            qualification status, use the original comparison whenever you
            want, then grade only an eligible take. You can switch before
            saving the grade; afterward the artifact fingerprint is locked.
          </p>
        </div>
        {gradedWinner ? (
          <Badge color="var(--pass)">Take {gradedWinner} locked</Badge>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <CandidateCard run={run} iteration={1} onPreview={onPreview} />
        <CandidateCard run={run} iteration={2} onPreview={onPreview} />
      </div>

      {run.live !== true ? (
        <p className="mt-3 text-pretty text-2xs leading-relaxed text-faint">
          Demo candidates stay preview-only because no provider artifact,
          source-audio proof, or SyncNet receipt exists to bind a real grade.
        </p>
      ) : null}
    </Card>
  );
}
