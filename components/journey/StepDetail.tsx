"use client";

/**
 * The detail panel below the chain: one panel, content swaps with the
 * selected step, always answering "what changed at this step". Flat rows
 * with hairline dividers — no nested cards, no modal.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import type { Iteration, Run, ViolationSeverity } from "@/lib/types";
import { Badge } from "@/components/ui";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { formatUsd } from "@/lib/cost";
import { formatClock, formatTime } from "@/lib/util";
import type { JourneyStep } from "./chain";
import { firstDataUrl } from "./chain";

// ---------------------------------------------------------------------------
// Small local pieces
// ---------------------------------------------------------------------------

function severityColor(s: ViolationSeverity): string {
  return s === "critical"
    ? "var(--fail)"
    : s === "major"
      ? "var(--borderline)"
      : "var(--muted)";
}

function evalName(id: string): string {
  return EVAL_DEFS.find((d) => d.id === id)?.name ?? id;
}

const EVAL_ORDER = new Map(EVAL_DEFS.map((d, i) => [d.id, i]));

function orderedResults(iteration: Iteration) {
  return [...iteration.evalResults].sort(
    (a, b) => (EVAL_ORDER.get(a.evalId) ?? 99) - (EVAL_ORDER.get(b.evalId) ?? 99)
  );
}

function DetailShell({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {hint ? <p className="text-2xs text-faint">{hint}</p> : null}
      </div>
      <div className="mt-5">{children}</div>
    </div>
  );
}

/** One quiet key–value line with a hairline divider. */
function Line({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex gap-6 border-b border-edge py-3 text-sm last:border-0">
      <span className="w-28 shrink-0 text-faint">{k}</span>
      <span className="min-w-0 text-muted">{v}</span>
    </div>
  );
}

function Still({ src, caption }: { src?: string; caption: string }) {
  return (
    <figure className="min-w-0">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- canvas data URL, not an optimizable asset
        <img
          src={src}
          alt={caption}
          className="aspect-video w-full rounded-lg border border-edge object-cover"
        />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-edge text-2xs text-faint">
          frame unavailable
        </div>
      )}
      <figcaption className="mt-1.5 text-2xs uppercase tracking-wider text-faint">
        {caption}
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Per-step details
// ---------------------------------------------------------------------------

function SourceDetail({ run }: { run: Run }) {
  const v = run.originalVideo;
  return (
    <DetailShell
      title={v.label}
      hint="the untouched source — every attempt starts again from these pixels"
    >
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span className="tabular-nums">{v.durationSec.toFixed(1)}s</span>
        <span className="text-faint">·</span>
        <span className="tabular-nums">
          {v.width}×{v.height}
        </span>
        <Badge color={v.hasAudio ? "var(--pass)" : "var(--faint)"}>
          {v.hasAudio ? "audio present" : "no audio"}
        </Badge>
      </div>
      {run.manifest ? (
        <div className="mt-7 max-w-3xl">
          <p
            className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted"
            title="Scene inventory (scene manifest)"
          >
            Scene inventory summary
          </p>
          <div className="mt-2">
            <Line k="Person" v={run.manifest.person.faceDescriptor} />
            <Line k="Background" v={run.manifest.background.layoutNotes} />
            <Line k="Lighting" v={run.manifest.lightingDiagnosis} />
          </div>
        </div>
      ) : (
        <p className="mt-7 text-2xs text-faint">Scene inventory not captured yet.</p>
      )}
    </DetailShell>
  );
}

function ManifestDetail({ run }: { run: Run }) {
  const m = run.manifest;
  if (!m) {
    return (
      <DetailShell title="Scene inventory" hint="taking inventory…">
        <p className="text-sm text-faint">
          Still listing everything in the source clip — person, room, and lighting.
        </p>
      </DetailShell>
    );
  }
  return (
    <DetailShell
      title="Scene inventory"
      hint="captured once when the clip is read — the checks compare every attempt against this list (technical: scene manifest)"
    >
      <div className="max-w-3xl">
        <Line k="Face" v={m.person.faceDescriptor} />
        <Line k="Hair" v={m.person.hair} />
        <Line
          k="Wardrobe"
          v={[...m.person.clothing, ...m.person.accessories].join(" · ")}
        />
        <Line
          k="Background"
          v={`${m.background.objects.join("; ")} — ${m.background.surfaces}`}
        />
        <Line k="Camera" v={`${m.camera.framing} · ${m.camera.angle}`} />
        <Line k="Diagnosis" v={m.lightingDiagnosis} />
      </div>
    </DetailShell>
  );
}

function AnchorDetail({ run }: { run: Run }) {
  const firstIter = run.iterations[0] as Iteration | undefined;
  const before = firstDataUrl(firstIter?.beforeFrames);
  return (
    <DetailShell
      title="Look Anchor"
      hint="the target lighting photo — the look is chosen and approved on one still before any video"
    >
      <div className="grid max-w-2xl grid-cols-2 gap-4">
        <Still src={before} caption="original frame" />
        <Still src={firstIter?.relitKeyframeDataUrl} caption="target lighting photo" />
      </div>
      <p className="mt-5 max-w-2xl text-sm text-muted">
        One frame is relit first, as a cheap still image, before any video is
        generated. Once this photo is approved, every video attempt is steered to
        carry exactly this lighting across the whole clip.
      </p>
    </DetailShell>
  );
}

function AttemptDetail({
  iteration,
  threshold,
}: {
  iteration: Iteration;
  threshold: number;
}) {
  const mp = iteration.megaPrompt;
  const active = mp.corrections.filter((c) => !c.resolved);
  const lightingLine = mp.base.lighting.style.split(". ")[0];
  const composite = iteration.composite;
  const results = orderedResults(iteration);
  const hasDeltas = results.some((r) => r.deltaFromPrevious !== undefined);
  const before = iteration.beforeFrames.find((f) => f.dataUrl);
  const after = iteration.afterFrames.find((f) => f.dataUrl);
  const failures = composite?.hardGateFailures ?? [];

  const hint =
    iteration.status === "passed"
      ? "passed every check that matters"
      : iteration.status === "failed"
        ? "didn't pass — the problems found were written into the next brief"
        : iteration.status === "ungraded"
          ? "generated successfully — automated checks were not run; awaiting your grade"
          : "generating and checking…";

  return (
    <DetailShell title={`Attempt v${iteration.index}`} hint={hint}>
      <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-2">
        {/* WHAT WENT IN */}
        <div>
          <p
            className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted"
            title={`Generation brief v${mp.version} (mega prompt)`}
          >
            What went in — generation brief v{mp.version}
          </p>
          <p className="mt-3 text-sm text-ink">{lightingLine}.</p>
          <div className="mt-5">
            <p className="text-2xs text-faint">
              {active.length === 0
                ? "Fix list empty — base brief and lighting instructions only."
                : `${active.length} fix${active.length === 1 ? "" : "es"} on the list`}
            </p>
            {active.length > 0 ? (
              <ul className="mt-1">
                {active.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-start gap-2.5 border-b border-edge py-2.5 last:border-0"
                  >
                    <Badge color={severityColor(c.severity)}>{c.severity}</Badge>
                    <span className="min-w-0 flex-1 text-sm text-muted">
                      {c.instruction}
                    </span>
                    <span
                      className="shrink-0 pt-0.5 text-2xs"
                      style={{
                        color:
                          c.addedAtIteration === mp.version
                            ? "var(--running)"
                            : "var(--faint)",
                      }}
                    >
                      {c.addedAtIteration === mp.version ? "new" : "carried"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <details className="mt-5">
            <summary className="cursor-pointer text-2xs text-faint transition hover:text-muted">
              Full generation brief, as sent
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-canvas p-3 font-mono text-2xs leading-relaxed text-muted">
              {mp.rendered}
            </pre>
          </details>
        </div>

        {/* WHAT CAME OUT */}
        <div>
          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
            What came out
          </p>
          {composite ? (
            <div className="mt-3 flex items-baseline gap-3">
              <span
                className="text-2xl font-semibold tabular-nums"
                style={{ color: composite.passed ? "var(--pass)" : "var(--fail)" }}
              >
                {composite.score}
              </span>
              <span
                className="text-2xs text-faint"
                title="Overall score (weighted composite) vs the pass threshold"
              >
                Overall score · needs {threshold} to pass
              </span>
            </div>
          ) : (
            <p className="status-pulse mt-3 text-sm text-muted">checking…</p>
          )}
          {composite ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {failures.length > 0 ? (
                failures.map((id) => (
                  <Badge key={id} color="var(--fail)">
                    {evalName(id)}
                  </Badge>
                ))
              ) : (
                <span className="text-2xs text-faint">
                  all must-pass checks green
                </span>
              )}
            </div>
          ) : null}
          {results.length > 0 ? (
            <div className="mt-6">
              <p className="text-2xs text-faint">
                score per check{hasDeltas ? " · change vs previous attempt" : ""}
              </p>
              <div className="mt-1 grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                {results.map((r) => (
                  <div
                    key={r.evalId}
                    className="flex items-baseline justify-between gap-3 py-1 text-2xs"
                  >
                    <span className="truncate text-muted">{evalName(r.evalId)}</span>
                    <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
                      <span className="text-ink">{Math.round(r.score)}</span>
                      {r.deltaFromPrevious !== undefined ? (
                        r.deltaFromPrevious === 0 ? (
                          <span className="text-faint">—</span>
                        ) : (
                          <span
                            style={{
                              color:
                                r.deltaFromPrevious > 0 ? "var(--pass)" : "var(--fail)",
                            }}
                          >
                            {r.deltaFromPrevious > 0 ? "▲" : "▼"}
                            {Math.abs(r.deltaFromPrevious)}
                          </span>
                        )
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {before?.dataUrl || after?.dataUrl ? (
            <div className="mt-6 grid max-w-md grid-cols-2 gap-3">
              <Still
                src={before?.dataUrl}
                caption={`before · ${formatTime(before?.timestampSec ?? 0)}`}
              />
              <Still src={after?.dataUrl} caption={`after v${iteration.index}`} />
            </div>
          ) : null}
        </div>
      </div>
    </DetailShell>
  );
}

function CorrectionsDetail({
  step,
}: {
  step: Extract<JourneyStep, { kind: "corrections" }>;
}) {
  const { prev, next, added, resolved } = step;
  return (
    <DetailShell
      title={`Fix list — v${prev.index} → v${next.index}`}
      hint="what changed on the fix list going into the next brief (technical: constraint ledger)"
    >
      {added.length === 0 && resolved.length === 0 ? (
        <p className="text-sm text-faint">
          Nothing added or resolved — the fix list carried forward unchanged.
        </p>
      ) : (
        <div className="max-w-3xl divide-y divide-edge">
          {added.map((c) => (
            <div key={c.id} className="flex items-start gap-3 py-3">
              <Badge color={severityColor(c.severity)}>{c.severity}</Badge>
              <span className="min-w-0 flex-1 text-sm text-ink">{c.instruction}</span>
              <span
                className="shrink-0 pt-0.5 text-2xs"
                style={{ color: "var(--running)" }}
              >
                added
              </span>
            </div>
          ))}
          {resolved.map((c) => (
            <div key={c.id} className="flex items-start gap-3 py-3">
              <span className="min-w-0 flex-1 text-sm text-faint line-through">
                {c.instruction}
              </span>
              <span className="shrink-0 pt-0.5 text-2xs" style={{ color: "var(--pass)" }}>
                resolved
              </span>
            </div>
          ))}
        </div>
      )}
    </DetailShell>
  );
}

function RemuxDetail({ run }: { run: Run }) {
  const hashLine =
    run.log.find((l) => l.nodeId === "remux" && l.message.includes("SHA-256"))
      ?.message ??
    run.log.find((l) => l.nodeId === "ingest" && l.message.includes("SHA-256"))
      ?.message;
  return (
    <DetailShell
      title="Original audio restored"
      hint="the AI never touches the sound (technical: audio remux)"
    >
      <p className="max-w-3xl text-sm text-muted">
        The original audio is copied byte-for-byte onto the winning video — no AI
        model ever hears or touches it.
      </p>
      {hashLine ? (
        <p className="mt-3 max-w-3xl font-mono text-2xs text-faint">{hashLine}</p>
      ) : null}
    </DetailShell>
  );
}

function FallbackDetail({ run }: { run: Run }) {
  return (
    <DetailShell
      title="Safe fallback"
      hint="lighting copied onto the original pixels (technical: color transfer)"
    >
      <p className="max-w-3xl text-sm text-ink">
        {run.fallback?.reason ?? "The loop ended without a passing attempt."}
      </p>
      <p className="mt-3 max-w-3xl text-sm text-muted">
        The lighting from the best attempt is copied onto the original pixels, so
        the person, movement, and room stay exactly as filmed — the trade-off is a
        less dramatic relight. The output is labeled as a safe fallback, not a
        generated video.
      </p>
    </DetailShell>
  );
}

function ReviewDetail({ run }: { run: Run }) {
  return (
    <DetailShell title="Human review" hint="the final check is a person">
      {run.review ? (
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              color={
                run.review.decision === "approved" ? "var(--pass)" : "var(--fail)"
              }
            >
              {run.review.decision === "approved" ? "approved" : "needs changes"}
            </Badge>
            <span className="text-2xs text-faint">
              reviewed at {formatClock(run.review.reviewedAt)}
            </span>
          </div>
          {run.review.notes ? (
            <p className="mt-3 text-sm text-muted">&ldquo;{run.review.notes}&rdquo;</p>
          ) : (
            <p className="mt-3 text-2xs text-faint">No reviewer notes.</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">
          Awaiting a reviewer — approve or request changes from the{" "}
          <Link
            href={`/runs/${run.id}`}
            className="text-ink underline decoration-edge underline-offset-4 transition hover:decoration-faint"
          >
            Review tab
          </Link>
          .
        </p>
      )}
      {run.cost ? (
        <p className="mt-4 text-2xs tabular-nums text-faint">
          est. live cost for this run {formatUsd(run.cost.estimatedUsd)} ·
          actual in mock mode $0.00
        </p>
      ) : null}
    </DetailShell>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function StepDetail({
  run,
  step,
  threshold,
}: {
  run: Run;
  step: JourneyStep;
  threshold: number;
}) {
  switch (step.kind) {
    case "source":
      return <SourceDetail run={run} />;
    case "manifest":
      return <ManifestDetail run={run} />;
    case "anchor":
      return <AnchorDetail run={run} />;
    case "attempt":
      return <AttemptDetail iteration={step.iteration} threshold={threshold} />;
    case "corrections":
      return <CorrectionsDetail step={step} />;
    case "fallback":
      return <FallbackDetail run={run} />;
    case "remux":
      return <RemuxDetail run={run} />;
    case "review":
      return <ReviewDetail run={run} />;
  }
}
