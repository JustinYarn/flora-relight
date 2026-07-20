"use client";

import type { LampChainStage } from "@/lib/lamp-chain";
import {
  lampChainStageComposite,
  type LampChainEvaluationArtifact,
} from "@/lib/lamp-chain-evaluation";
import { formatUsd } from "@/lib/cost";
import type { Run } from "@/lib/types";
import { runWorkflowMode } from "@/lib/workflow-mode";
import { Badge, Card, SectionTitle } from "@/components/ui";

const CHAIN_STAGE_LABELS: Record<LampChainStage, string> = {
  background: "Background",
  lamp: "Lamp",
  beautify: "Beautify",
  iris: "Iris",
};

type StageStatus = "pending" | "completed" | "invalid" | "not-started";

/** Server GET projection — read defensively; it may not be present at all. */
interface ChainExecutionStageProjection {
  stage?: number;
  stageKind?: LampChainStage;
  status?: string;
  videoUrl?: string;
  artifact?: unknown;
  costUsd?: number;
}

interface ChainExecutionProjection {
  stageOrder?: LampChainStage[];
  stages?: ChainExecutionStageProjection[];
}

interface ReportRow {
  evalId: string;
  score: number;
  verdict?: string;
  delta?: number;
}

interface StageReport {
  stage: number;
  stageKind?: LampChainStage;
  status: StageStatus;
  rows: ReportRow[];
  composite?: { score: number; hardGateFailures: string[] };
  costUsd?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chainProjection(run: Run): ChainExecutionProjection | undefined {
  const projected = (run as Run & { chainExecution?: unknown }).chainExecution;
  return isRecord(projected)
    ? (projected as ChainExecutionProjection)
    : undefined;
}

function stageStatus(value: unknown): StageStatus | undefined {
  return value === "pending" ||
    value === "completed" ||
    value === "invalid" ||
    value === "not-started"
    ? value
    : undefined;
}

/** Rows straight from a projected artifact; tolerates any malformed shape. */
function rowsFromArtifact(artifact: unknown): ReportRow[] {
  if (!isRecord(artifact) || !Array.isArray(artifact.evalResults)) return [];
  return artifact.evalResults.flatMap((result) => {
    if (
      !isRecord(result) ||
      typeof result.evalId !== "string" ||
      typeof result.score !== "number" ||
      !Number.isFinite(result.score)
    ) {
      return [];
    }
    return [
      {
        evalId: result.evalId,
        score: result.score,
        ...(typeof result.verdict === "string"
          ? { verdict: result.verdict }
          : {}),
        ...(typeof result.deltaFromPrevious === "number" &&
        Number.isFinite(result.deltaFromPrevious)
          ? { delta: result.deltaFromPrevious }
          : {}),
      },
    ];
  });
}

/** Registry-weighted composite; a malformed artifact simply yields none. */
function compositeFromArtifact(
  artifact: unknown
): { score: number; hardGateFailures: string[] } | undefined {
  if (!isRecord(artifact) || !Array.isArray(artifact.evalResults)) {
    return undefined;
  }
  try {
    const { composite, hardGateFailures } = lampChainStageComposite(
      artifact as unknown as LampChainEvaluationArtifact
    );
    return { score: composite, hardGateFailures };
  } catch {
    return undefined;
  }
}

function chainDelivered(run: Run): boolean {
  return (
    Boolean(run.finalVideo) ||
    run.status === "awaiting-review" ||
    run.status === "approved" ||
    run.serverExecution?.status === "awaiting_review"
  );
}

/** One stage's report, preferring the server projection over mock iterations. */
function stageReport(
  run: Run,
  stage: number,
  stageKind: LampChainStage | undefined,
  projected: ChainExecutionStageProjection | undefined,
  delivered: boolean
): StageReport {
  const projectedRows = projected?.artifact
    ? rowsFromArtifact(projected.artifact)
    : [];
  if (projectedRows.length > 0) {
    return {
      stage,
      stageKind: projected?.stageKind ?? stageKind,
      status: stageStatus(projected?.status) ?? "completed",
      rows: projectedRows,
      composite: compositeFromArtifact(projected?.artifact),
      ...(typeof projected?.costUsd === "number"
        ? { costUsd: projected.costUsd }
        : {}),
    };
  }
  // Mock runs carry the detached report card on their iterations directly.
  const iteration = run.iterations.find((item) => item.index === stage);
  const iterationRows: ReportRow[] = (iteration?.evalResults ?? []).map(
    (result) => ({
      evalId: result.evalId,
      score: result.score,
      verdict: result.verdict,
      ...(result.deltaFromPrevious !== undefined
        ? { delta: result.deltaFromPrevious }
        : {}),
    })
  );
  if (iterationRows.length > 0) {
    return {
      stage,
      stageKind,
      status: "completed",
      rows: iterationRows,
      ...(iteration?.composite
        ? {
            composite: {
              score: iteration.composite.score,
              hardGateFailures: iteration.composite.hardGateFailures,
            },
          }
        : {}),
    };
  }
  const projectedStatus = stageStatus(projected?.status);
  const generated =
    Boolean(iteration?.generatedVideo) || Boolean(projected?.videoUrl);
  return {
    stage,
    stageKind: projected?.stageKind ?? stageKind,
    status:
      projectedStatus ?? (delivered || generated ? "pending" : "not-started"),
    rows: [],
    ...(typeof projected?.costUsd === "number"
      ? { costUsd: projected.costUsd }
      : {}),
  };
}

function formatDelta(delta: number): string {
  const magnitude = Math.round(Math.abs(delta) * 10) / 10;
  return Number.isInteger(magnitude)
    ? String(magnitude)
    : magnitude.toFixed(1);
}

const STATUS_META: Record<StageStatus, { color: string; label: string }> = {
  completed: { color: "var(--pass)", label: "completed" },
  pending: { color: "var(--borderline)", label: "measuring…" },
  invalid: { color: "var(--fail)", label: "invalid" },
  "not-started": { color: "var(--faint)", label: "not started" },
};

/**
 * The detached report card. Delivery never waits for it: a chain run is
 * gradeable with zero measurements persisted, so a missing evaluation is
 * always "pending"/"measuring" here — never an error.
 */
export function ChainEvalReport({ run }: { run: Run }) {
  if (runWorkflowMode(run) !== "chain") return null;
  const projection = chainProjection(run);
  const stageOrder: (LampChainStage | undefined)[] =
    projection?.stageOrder ??
    run.chainPlan?.stageOrder ??
    run.chainControls?.stageOrder ??
    [];
  const stageCount = Math.max(
    stageOrder.length,
    projection?.stages?.length ?? 0,
    run.iterations.length
  );
  const delivered = chainDelivered(run);
  const started =
    delivered ||
    run.iterations.length > 0 ||
    run.serverExecution !== undefined;
  if (stageCount === 0 || !started) return null;

  const reports = Array.from({ length: stageCount }, (_, index) => {
    const stage = index + 1;
    const projected = projection?.stages?.find(
      (item) => item.stage === stage
    );
    return stageReport(run, stage, stageOrder[index], projected, delivered);
  });
  const attached = reports.filter(
    (report) => report.rows.length > 0
  ).length;
  const hiddenUntilGraded =
    run.live === true &&
    delivered &&
    attached === 0 &&
    run.humanGrade === undefined;

  return (
    <Card className="mt-6 p-5">
      <SectionTitle
        right={
          <span className="text-2xs tabular-nums text-faint">
            {attached}/{stageCount} stage measurements attached
          </span>
        }
      >
        Detached report card
      </SectionTitle>
      <p className="text-pretty text-xs leading-relaxed text-muted">
        Every measurement here judges its stage&apos;s output against the
        ORIGINAL clip and attaches after delivery. It can never hold, repair,
        or un-deliver the cut.
      </p>

      {hiddenUntilGraded ? (
        <p className="mt-3 rounded-xl bg-raised px-3.5 py-3 text-pretty text-xs leading-relaxed text-borderline">
          Report card hidden until grading is saved — grade the delivered cut
          blind at /grade; the per-stage measurements appear here afterwards.
        </p>
      ) : null}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {reports.map((report) => {
          const meta = STATUS_META[report.status];
          return (
            <section
              key={report.stage}
              className="rounded-xl bg-raised p-3.5"
            >
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-ink">
                  Stage {report.stage}
                  {report.stageKind
                    ? ` — ${CHAIN_STAGE_LABELS[report.stageKind]}`
                    : ""}
                </h3>
                <span className="ml-auto flex items-center gap-2">
                  {report.costUsd !== undefined ? (
                    <span className="text-2xs tabular-nums text-faint">
                      {formatUsd(report.costUsd)}
                    </span>
                  ) : null}
                  <Badge color={meta.color}>{meta.label}</Badge>
                </span>
              </div>

              {report.composite ? (
                <p className="mt-2 text-xs text-muted">
                  composite{" "}
                  <span className="font-medium tabular-nums text-ink">
                    {report.composite.score.toFixed(1)}
                  </span>
                  {" · "}
                  {report.composite.hardGateFailures.length > 0 ? (
                    <span className="text-fail">
                      hard gates failed:{" "}
                      {report.composite.hardGateFailures.join(", ")}
                    </span>
                  ) : (
                    <span className="text-pass">all hard gates clear</span>
                  )}
                </p>
              ) : null}

              {report.rows.length > 0 ? (
                <ul className="mt-3 space-y-1">
                  {report.rows.map((row) => (
                    <li
                      key={row.evalId}
                      className="flex items-baseline justify-between gap-3 text-xs"
                    >
                      <span className="min-w-0 truncate text-muted">
                        {row.evalId}
                      </span>
                      <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
                        <span
                          className={
                            row.verdict === "fail"
                              ? "text-fail"
                              : row.verdict === "borderline"
                                ? "text-borderline"
                                : "text-ink"
                          }
                        >
                          {Math.round(row.score)}
                        </span>
                        {row.delta !== undefined && row.delta !== 0 ? (
                          <span
                            className={
                              row.delta < 0 ? "text-fail" : "text-pass"
                            }
                            title="score movement vs the previous stage"
                          >
                            {row.delta < 0 ? "↓" : "↑"}
                            {formatDelta(row.delta)}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-faint">
                  {report.status === "invalid"
                    ? "The stored measurement could not be validated against the approved plan; delivery is unaffected."
                    : report.status === "not-started"
                      ? "This stage has not generated yet."
                      : hiddenUntilGraded
                        ? "report card hidden until grading is saved"
                        : "measuring…"}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </Card>
  );
}
