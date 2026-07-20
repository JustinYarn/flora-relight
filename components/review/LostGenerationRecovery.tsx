"use client";

/**
 * LostGenerationRecovery — the human-facing panel for a single Lamp run whose
 * durable execution stopped in reconcile_required.
 *
 * When the stop reason is the provider-lost-interaction seal, it offers the
 * one safe recovery: explicitly acknowledge the loss (which archives the
 * sealed journal as unresolved billing evidence and withdraws the old
 * approval), then walk through a fresh spend confirmation on Create. The
 * replacement run replays every completed journal for free and claims one
 * fresh provider interaction for the lost generation. Any other
 * reconciliation reason renders as read-only evidence — those stay
 * operator-owned and are never re-billed from the browser.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Run } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { markServerRunObserved } from "@/lib/persist";
import { isProviderLostInteractionError } from "@/lib/lost-interaction";
import {
  estimateLampBackgroundTwoPass,
  estimateLampBeautifyTwoPass,
  estimateLampIrisTwoPass,
  estimateLampRun,
  formatUsd,
} from "@/lib/cost";
import { workflowModeFromExecutionId } from "@/lib/workflow-mode";
import { Button, Card } from "@/components/ui";

export function LostGenerationRecovery({ run }: { run: Run }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execution = run.serverExecution;
  if (
    !execution ||
    execution.source !== "single" ||
    execution.status !== "reconcile_required"
  ) {
    return null;
  }

  const workflowMode = workflowModeFromExecutionId(execution.executionId);
  const combinedRecoveryUnsupported = workflowMode === "combined";
  // Chain owns its own settlement/failure path inside the durable workflow;
  // browser-side lost-generation recovery is intentionally unavailable.
  const chainRecoveryUnsupported = workflowMode === "chain";
  const lostGeneration =
    workflowMode !== "flora" &&
    !combinedRecoveryUnsupported &&
    !chainRecoveryUnsupported &&
    isProviderLostInteractionError(execution.error);
  // Prefer the canonical journal entry; fall back to the archived :lost:
  // entry so an acknowledgment that crashed between its two durable writes
  // (journal already superseded, execution not yet advanced) can still be
  // retried — the route's idempotent path accepts the archived handle.
  const operation =
    run.providerOperations?.find(
      (item) => item.id === `video-generation:${execution.iteration}`
    ) ??
    run.providerOperations?.find(
      (item) =>
        item.id.startsWith(`video-generation:${execution.iteration}:lost:`) &&
        item.providerInteractionId
    );
  const interactionId =
    lostGeneration && operation ? operation.providerInteractionId : undefined;

  const estimate =
    workflowMode === "background"
      ? estimateLampBackgroundTwoPass(run.originalVideo.durationSec)
      : workflowMode === "beautify"
        ? estimateLampBeautifyTwoPass(run.originalVideo.durationSec)
        : workflowMode === "iris"
          ? estimateLampIrisTwoPass(run.originalVideo.durationSec)
      : estimateLampRun(run.originalVideo.durationSec);
  // Iteration 1 lost → the whole plan still runs; iteration 2 lost → only the
  // final generation and its evaluation remain (earlier journals replay free,
  // so exactly half the two-generation/two-evaluation plan is new spend).
  const expectedNewUsd =
    execution.iteration >= 2 ? estimate.totalUsd / 2 : estimate.totalUsd;

  const acknowledge = async () => {
    if (submitting || !interactionId) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/runs/reconcile-lost-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.id, interactionId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          payload.error ?? "The acknowledgment could not be saved."
        );
      }
      // Pull the durable read model before leaving so Create's resume card
      // sees the paused-for-approval state without waiting for a poll.
      const refreshed = await fetch(
        `/api/runs?id=${encodeURIComponent(run.id)}`,
        { cache: "no-store" }
      );
      if (refreshed.ok) {
        const body = (await refreshed.json()) as { run?: Run };
        if (body.run) {
          const fullRun = body.run;
          markServerRunObserved(fullRun);
          useAppStore.setState((state) => ({
            ...state,
            runs: state.runs.map((item) =>
              item.id === run.id ? fullRun : item
            ),
          }));
        }
      }
      router.push("/");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The acknowledgment could not be saved."
      );
      setSubmitting(false);
    }
  };

  return (
    <Card className="mt-6 space-y-3 border-[color-mix(in_srgb,var(--fail)_45%,var(--edge))] p-4">
      <p className="text-sm font-medium text-ink">
        {lostGeneration
          ? "The provider lost this generation"
          : "This run needs manual reconciliation"}
      </p>
      <p className="text-2xs leading-relaxed text-muted">
        {execution.error ??
          "The provider outcome is ambiguous. It will not be billed again automatically."}
      </p>
      {lostGeneration ? (
        <>
          <p className="text-2xs leading-relaxed text-muted">
            The lost attempt may still have been charged upstream; its journal
            entry stays visible as unresolved evidence. Recovering re-runs the
            lost generation from the original video with a fresh provider
            interaction. That needs a new spend approval — expected new spend
            about {formatUsd(expectedNewUsd)}
            {execution.iteration >= 2
              ? " (the saved initial video and its evaluation replay at no new cost)"
              : ""}
            , confirmed on the next screen before anything is billed.
          </p>
          {interactionId ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={submitting} onClick={() => void acknowledge()}>
                {submitting
                  ? "Saving acknowledgment…"
                  : "Acknowledge loss and set up the re-run"}
              </Button>
              <span className="font-mono text-2xs text-faint">
                lost interaction {interactionId.slice(0, 24)}
                {interactionId.length > 24 ? "…" : ""}
              </span>
            </div>
          ) : (
            <p className="text-2xs text-faint">
              The sealed journal entry is not visible in this browser yet.
              Reload the page to load the durable evidence before
              acknowledging.
            </p>
          )}
          {error ? <p className="text-2xs text-[var(--fail)]">{error}</p> : null}
        </>
      ) : (
        <p className="text-2xs text-faint">
          {combinedRecoveryUnsupported
            ? "Combined preserves its aggregate plan and both candidate journal sets, but browser recovery is intentionally unavailable. Inspect the journals before any operator action; no provider work is replayed automatically."
            : chainRecoveryUnsupported
              ? "Chain preserves its ordered plan and every stage receipt, but browser recovery is intentionally unavailable — the durable workflow owns chain settlement. Inspect the journals before any operator action; no provider work is replayed automatically."
              : "Inspect the provider journal before any re-run; nothing is re-billed automatically."}
        </p>
      )}
    </Card>
  );
}
