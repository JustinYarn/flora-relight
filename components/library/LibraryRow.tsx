"use client";

import { useState } from "react";
import Link from "next/link";
import type { Iteration, Run } from "@/lib/types";
import { Badge, Button, verdictColor } from "@/components/ui";
import { formatUsd } from "@/lib/cost";
import { useAppStore } from "@/lib/store";
import { CheckList } from "@/components/library/CheckList";
import { PairPlayer } from "@/components/library/PairPlayer";
import { DownloadSideBySide } from "@/components/review/DownloadSideBySide";
import { isLampBlindGradeLocked } from "@/components/grade/derive";
import {
  STATUS_META,
  activeFixes,
  compositeVerdict,
  formatRunDate,
  shippedComposite,
  shippedIteration,
  shippedVideo,
} from "@/components/library/derive";

/*
 * One Library entry — progressive disclosure:
 *   Level 1: the collapsed row (thumbnail pair, label, status, score, cost).
 *   Level 2: expanded — side-by-side players, per-attempt chips, the 11
 *            checks, the fix list, review actions.
 *   Level 3: lives inside CheckList — judge details per check.
 */

const THUMB_TIME = "#t=0.5";

function severityColor(s: "critical" | "major" | "minor"): string {
  return s === "critical"
    ? "var(--fail)"
    : s === "major"
      ? "var(--borderline)"
      : "var(--muted)";
}

/** ~120px before/after thumbnail. Falls back to a quiet tile when the file is missing. */
function Thumb({
  url,
  tag,
  filter,
  dimmed,
}: {
  url?: string;
  tag?: string;
  filter?: string;
  dimmed?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="relative block w-[120px] shrink-0 overflow-hidden rounded-md border border-edge bg-canvas">
      <span className="block aspect-video">
        {url && !broken ? (
          <video
            src={`${url}${THUMB_TIME}`}
            preload="metadata"
            muted
            playsInline
            onError={() => setBroken(true)}
            style={filter ? { filter } : undefined}
            className={`h-full w-full object-cover ${dimmed ? "opacity-40" : ""}`}
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-2xs text-faint">
            no file
          </span>
        )}
      </span>
      {tag ? (
        <span
          className="pointer-events-none absolute bottom-1 left-1 rounded px-1 py-px text-[9px] font-semibold tracking-wider text-ink"
          style={{ background: "color-mix(in srgb, var(--canvas) 78%, transparent)" }}
        >
          {tag}
        </span>
      ) : null}
    </span>
  );
}

/** Initial/Final for Lamp; legacy attempt chips remain readable for older runs. */
function AttemptChips({
  iterations,
  bestIndex,
  fixedTwoPass,
  selected,
  onSelect,
}: {
  iterations: Iteration[];
  bestIndex?: number;
  fixedTwoPass: boolean;
  selected: number | undefined;
  onSelect: (index: number) => void;
}) {
  const dotColor = (status: Iteration["status"]): string =>
    status === "running"
      ? "var(--running)"
      : status === "ungraded"
        ? "var(--borderline)"
      : status === "passed"
        ? "var(--pass)"
        : "var(--fail)";
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-2xs uppercase tracking-[0.14em] text-faint">
        {fixedTwoPass ? "Videos" : "Attempts"}
      </span>
      {iterations.map((it) => (
        <button
          key={it.index}
          onClick={() => onSelect(it.index)}
          className={`flex min-h-10 items-center gap-1.5 rounded-md px-2 text-xs transition-[transform,color,background-color] duration-150 ease-out active:scale-[0.96] ${
            selected === it.index ? "bg-raised text-ink" : "text-muted hover:text-ink"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${it.status === "running" ? "status-pulse" : ""}`}
            style={{ background: dotColor(it.status) }}
          />
          {fixedTwoPass
            ? it.index === 1
              ? "Initial"
              : it.index === 2
                ? "Final"
                : `v${it.index}`
            : `a${it.index}`}
          {!fixedTwoPass && bestIndex === it.index ? (
            <span className="text-2xs text-accent" title="shipped attempt">
              ★
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** Level 2 body — mounted only while the row is open so its state resets per visit. */
function RowBody({ run }: { run: Run }) {
  const submitReview = useAppStore((s) => s.submitReview);
  const shipped = shippedIteration(run);
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(
    shipped?.index
  );
  const ordered = [...run.iterations].sort((a, b) => a.index - b.index);
  const selected =
    ordered.find((it) => it.index === selectedIndex) ?? shipped;
  const fixes = activeFixes(run);
  const relit = shippedVideo(run);
  const fixedTwoPass =
    run.workflowMode === "lamp" || run.workflowId === "lamp-v1";
  const blindGradeLocked = isLampBlindGradeLocked(run);

  return (
    <div className="space-y-5 pb-6 pl-1 pr-1">
      <PairPlayer
        original={run.originalVideo}
        relit={relit}
        relitLabel={
          run.workflowId === "lamp-v1" && shipped?.index === 2
            ? "RELIT · FINAL"
            : run.finalVideo
              ? "RELIT · FINAL"
              : shipped
                ? `RELIT v${shipped.index}`
                : "RELIT"
        }
      />

      {blindGradeLocked ? (
        <div className="rounded-xl bg-raised px-4 py-3 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
          <p className="text-sm font-medium text-ink">Final AI evaluation is ready</p>
          <p className="mt-1 text-pretty text-2xs leading-relaxed text-muted">
            It stays hidden by default in Grade. You can reveal it there when you
            want, or grade the Final without looking.
          </p>
        </div>
      ) : ordered.length > 0 ? (
        <div className="space-y-2">
          <AttemptChips
            iterations={ordered}
            bestIndex={run.bestIterationIndex}
            fixedTwoPass={fixedTwoPass}
            selected={selected?.index}
            onSelect={setSelectedIndex}
          />
          <CheckList
            iteration={selected}
            runActive={run.status === "running"}
            workflowMode={fixedTwoPass ? "lamp" : "flora"}
          />
        </div>
      ) : (
        <CheckList
          iteration={undefined}
          runActive={run.status === "running"}
          workflowMode={fixedTwoPass ? "lamp" : "flora"}
        />
      )}

      {!blindGradeLocked && fixes.length > 0 ? (
        <div>
          <p className="mb-1.5 text-2xs uppercase tracking-[0.14em] text-faint">
            {fixedTwoPass ? "Corrections applied to Final" : "Fixes that drove the final attempt"}
          </p>
          <ul className="space-y-1.5">
            {fixes.map((f) => (
              <li key={f.id} className="flex items-baseline gap-2 text-xs">
                <Badge color={severityColor(f.severity)}>{f.severity}</Badge>
                <span className="min-w-0 flex-1 text-muted">{f.instruction}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-edge pt-4">
        <Link
          href={`/runs/${run.id}`}
          className="text-sm text-muted transition hover:text-ink"
        >
          Open review →
        </Link>
        {!blindGradeLocked ? (
          <Link
            href={`/runs/${run.id}/journey`}
            className="text-sm text-muted transition hover:text-ink"
          >
            Open journey →
          </Link>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {blindGradeLocked ? (
            <Link
              href={`/grade?run=${encodeURIComponent(run.id)}`}
              className="inline-flex min-h-10 items-center rounded-lg bg-pass px-3.5 py-1.5 text-sm font-medium text-canvas transition-transform active:scale-[0.96]"
            >
              Grade Final
            </Link>
          ) : run.status === "awaiting-review" ? (
            <>
              <Button
                variant="success"
                onClick={() => submitReview(run.id, "approved", "")}
              >
                Approve
              </Button>
              <Button
                variant="danger"
                onClick={() => submitReview(run.id, "needs-changes", "")}
              >
                Request changes
              </Button>
            </>
          ) : run.review ? (
            <span className="text-2xs text-faint">
              reviewed —{" "}
              {run.review.decision === "approved" ? "approved" : "needs changes"}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function LibraryRow({
  run,
  passThreshold,
  open,
  onToggle,
  onDeleted,
}: {
  run: Run;
  passThreshold: number;
  open: boolean;
  onToggle: () => void;
  /** Called after a successful delete so the list view can drop its own copy. */
  onDeleted?: () => void;
}) {
  const removeRun = useAppStore((s) => s.removeRun);
  const status = STATUS_META[run.status];
  const composite = shippedComposite(run);
  const verdict = composite ? compositeVerdict(composite, passThreshold) : undefined;
  const relit = shippedVideo(run);
  const attempts = run.iterations.length;
  const fixedTwoPass = run.workflowId === "lamp-v1";
  const actualUsd = run.cost?.actualUsd ?? 0;

  // Delete flow: ✕ → inline confirm → removeRun (optimistic; store restores
  // the run and we surface a text-fail line if the server refuses).
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const protectedByBatch = useAppStore((state) =>
    Object.values(state.batchExecutions).some((execution) => {
      const member = execution.members.find(
        (candidate) => candidate.runId === run.id
      );
      if (!member) return false;
      if (member.state === "reconcile_required") return true;
      return execution.status === "queued" || execution.status === "running";
    })
  );
  // A freshly uploaded clip deliberately has presentation status "running"
  // before any generation is approved. Only server-owned active work should
  // disable deletion; the route independently rejects stale-tab races.
  const stillRunning =
    protectedByBatch ||
    run.serverExecution?.status === "queued" ||
    run.serverExecution?.status === "running" ||
    run.serverExecution?.status === "user_action_required" ||
    run.serverExecution?.status === "reconcile_required";

  const confirmDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await removeRun(run.id);
      onDeleted?.();
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : "Couldn't delete this run — the server said no. It's back in the list; try again."
      );
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div>
      {/* LEVEL 1 — the collapsed row; click the row to expand, actions right */}
      <div className="flex w-full items-center gap-x-3 transition hover:bg-[color-mix(in_srgb,var(--raised)_40%,transparent)]">
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2 py-3 text-left"
        >
        <span className="flex shrink-0 gap-1.5">
          <Thumb url={run.originalVideo.url} tag="BEFORE" />
          {relit ? (
            <Thumb
              url={relit.url}
              tag="AFTER"
              filter={relit.simulatedFilter}
            />
          ) : (
            <Thumb url={run.originalVideo.url} tag="no relit cut" dimmed />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-ink">
              {run.originalVideo.label}
            </span>
            {!run.live ? <Badge color="var(--accent)">simulated</Badge> : null}
            {relit?.simulatedFilter && run.live ? (
              <Badge color="var(--accent)">simulated</Badge>
            ) : null}
          </span>
          <span className="mt-0.5 block text-2xs text-faint">
            {formatRunDate(run.createdAt)}
          </span>
        </span>

        <span className="w-32 shrink-0">
          <Badge color={status.color}>{status.label}</Badge>
        </span>

        <span
          className="w-20 shrink-0"
          title={fixedTwoPass ? "Overall score of Final" : "Overall score of the shipped cut"}
        >
          {composite && verdict ? (
            <>
              <span
                className="block text-xl font-semibold tabular-nums"
                style={{ color: verdictColor(verdict) }}
              >
                {composite.score.toFixed(1)}
              </span>
              <span className="mt-1 block h-0.5 w-16 overflow-hidden rounded-full bg-raised">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.min(100, Math.max(0, composite.score))}%`,
                    background: verdictColor(verdict),
                  }}
                />
              </span>
            </>
          ) : (
            <span className="text-xl font-semibold text-faint">—</span>
          )}
        </span>

        <span className="w-16 shrink-0 text-sm tabular-nums text-muted">
          {fixedTwoPass ? `${attempts}/2 vids` : `${attempts} att.`}
        </span>

        <span
          className="w-16 shrink-0 text-right text-sm tabular-nums text-muted"
          title={
            run.cost
              ? `actual spend ${formatUsd(actualUsd)} · est. ${formatUsd(run.cost.estimatedUsd)}`
              : "no cost ledger"
          }
        >
          {run.cost ? formatUsd(actualUsd) : "—"}
        </span>

          <span className="w-3 shrink-0 text-center text-2xs text-faint">
            {open ? "▴" : "▾"}
          </span>
        </button>

        {/* ROW ACTIONS — download the comparison cut, delete the run */}
        <span className="flex shrink-0 items-center gap-1.5 pr-1">
          {confirmingDelete ? (
            <span className="flex items-center gap-2">
              <span className="max-w-[190px] text-right text-2xs leading-tight text-muted">
                Delete forever? This removes the videos too.
              </span>
              <button
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className="rounded-md border border-[color-mix(in_srgb,var(--fail)_40%,transparent)] bg-[color-mix(in_srgb,var(--fail)_14%,transparent)] px-2 py-1 text-xs text-fail transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="px-1 py-1 text-xs text-muted transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                keep
              </button>
            </span>
          ) : (
            <>
              <DownloadSideBySide run={run} variant="compact" />
              <button
                onClick={() => setConfirmingDelete(true)}
                disabled={stillRunning}
                title={stillRunning ? "still running" : "Delete run"}
                aria-label="Delete run"
                className="rounded-md border border-edge px-2 py-1 text-xs text-faint transition hover:border-faint hover:text-fail disabled:cursor-not-allowed disabled:opacity-40"
              >
                ✕
              </button>
            </>
          )}
        </span>
      </div>

      {deleteError ? (
        <p className="pb-2 text-right text-2xs text-fail">{deleteError}</p>
      ) : null}

      {/* LEVEL 2 — expanded */}
      {open ? <RowBody run={run} /> : null}
    </div>
  );
}
