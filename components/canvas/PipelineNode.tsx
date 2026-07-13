"use client";

import { memo } from "react";
import type { CSSProperties } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type {
  EvalResult,
  NodeKind,
  NodeRunStatus,
  PipelineNode,
  ProviderInfo,
} from "@/lib/types";
import { Badge, statusColor, VerdictBadge, verdictColor } from "@/components/ui";
import { promptRoleForNode } from "@/components/canvas/prompt-map";

/** Latest composite vs the pass threshold, shown on the iteration gate card. */
export type GateSnapshot = {
  score: number;
  passed: boolean;
  threshold: number;
};

/** Data carried by every canvas node; synced from the active run by PipelineCanvas. */
export type PipelineNodeData = {
  pipelineNode: PipelineNode;
  status: NodeRunStatus;
  /** Latest EvalResult for this node's evalId in the active run (evaluate nodes only). */
  evalResult: EvalResult | null;
  /** videogen only: current iteration number. */
  iteration: number | null;
  /** videogen only: the seed currently pinned by the engine. */
  seed: number | null;
  /** anchor only: relit keyframe preview (data URL). */
  anchorThumb: string | null;
  /** gate only: latest composite vs threshold. */
  gateInfo: GateSnapshot | null;
};

export type PipelineFlowNode = Node<PipelineNodeData, "pipeline">;

/** Kind → token color. Gate reads as a fail-ish orange mixed from the tokens. */
export function kindColor(kind: NodeKind): string {
  switch (kind) {
    case "input":
      return "var(--faint)";
    case "process":
      return "var(--muted)";
    case "generate":
      return "var(--accent)";
    case "evaluate":
      return "var(--running)";
    case "aggregate":
      return "var(--borderline)";
    case "gate":
      return "color-mix(in srgb, var(--fail) 55%, var(--borderline) 45%)";
    case "output":
      return "var(--pass)";
    default:
      return "var(--muted)";
  }
}

/** Current display labels mirrored from the server-owned provider constants. */
export const PROVIDER_MODELS: Record<ProviderInfo["id"], string> = {
  omni: "gemini-omni-flash-preview",
  gemini: "gemini-3-pro-image",
  claude: "claude-fable-5",
};

/** Status icon + word — legible at a glance, not just a colored dot. */
const STATUS_GLYPH: Record<NodeRunStatus, { icon: string; word: string }> = {
  idle: { icon: "○", word: "idle" },
  queued: { icon: "◔", word: "queued" },
  running: { icon: "●", word: "running" },
  succeeded: { icon: "✓", word: "ok" },
  failed: { icon: "✕", word: "fail" },
  skipped: { icon: "⊘", word: "skipped" },
};

const HANDLE_STYLE: CSSProperties = {
  width: 6,
  height: 6,
  minWidth: 6,
  minHeight: 6,
  background: "var(--faint)",
  border: "none",
};

export const PipelineNodeView = memo(function PipelineNodeView({
  data,
  selected,
}: NodeProps<PipelineFlowNode>) {
  const { pipelineNode: node, status, evalResult, iteration, seed, anchorThumb, gateInfo } =
    data;
  const color = kindColor(node.kind);
  const promptRole = promptRoleForNode(node);
  const glyph = STATUS_GLYPH[status];
  /** Evaluate nodes carry their verdict on the trailing edge of the card. */
  const verdictEdge =
    node.kind === "evaluate" && evalResult
      ? verdictColor(evalResult.verdict)
      : null;

  return (
    <div
      title={node.description}
      data-node-id={node.id}
      data-prompt-role={promptRole?.label}
      className="w-[200px] rounded-lg bg-surface px-3 py-2 transition-[box-shadow,border-color] duration-150 ease-out"
      style={{
        border: "1px solid transparent",
        borderColor: selected
          ? `color-mix(in srgb, ${color} 60%, var(--edge))`
          : "transparent",
        boxShadow: selected
          ? `0 0 0 1px ${color}, 0 10px 28px rgba(0, 0, 0, 0.28)`
          : "0 0 0 1px rgba(255, 255, 255, 0.08), 0 2px 8px rgba(0, 0, 0, 0.14)",
        ...(verdictEdge
          ? { borderRightColor: verdictEdge, borderRightWidth: 3 }
          : {}),
      }}
    >
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-2xs font-semibold uppercase tracking-[0.12em]"
          style={{ color: promptRole?.color ?? color }}
          title={promptRole?.description}
        >
          {promptRole?.label ?? node.kind}
        </span>
        <span
          className={`inline-flex items-center gap-1 text-2xs font-medium ${
            status === "running" ? "status-pulse" : ""
          }`}
          style={{ color: statusColor(status) }}
        >
          <span aria-hidden="true">{glyph.icon}</span>
          {glyph.word}
        </span>
      </div>
      <p className="mt-1 text-sm font-medium leading-snug text-ink">
        {node.label}
      </p>

      {node.kind === "evaluate" && evalResult ? (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span
            className="text-xs font-semibold tabular-nums"
            style={{ color: verdictColor(evalResult.verdict) }}
          >
            {Math.round(evalResult.score)}
          </span>
          <VerdictBadge verdict={evalResult.verdict} />
        </div>
      ) : null}

      {node.id === "videogen" ? (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <Badge color="var(--accent)">
            {iteration !== null ? `v${iteration}` : "v—"}
          </Badge>
          <span className="font-mono text-2xs tabular-nums text-faint">
            {seed !== null ? `seed ${seed}` : "seed —"}
          </span>
        </div>
      ) : null}

      {node.id === "anchor" && anchorThumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={anchorThumb}
          alt="Relit look-anchor keyframe"
          className="mt-1.5 h-16 w-full rounded-md border border-edge object-cover"
        />
      ) : null}

      {node.id === "gate" ? (
        gateInfo ? (
          <div className="mt-1.5 flex items-baseline gap-1.5 text-2xs tabular-nums">
            <span
              className="font-semibold"
              style={{
                color: gateInfo.passed ? "var(--pass)" : "var(--fail)",
              }}
            >
              {gateInfo.score}
            </span>
            <span className="text-faint">vs ≥ {gateInfo.threshold}</span>
          </div>
        ) : (
          <p className="mt-1.5 text-2xs text-faint">score pending</p>
        )
      ) : null}

      {node.kind === "generate" && node.providerId ? (
        <p className="mt-1 text-2xs text-faint">
          {PROVIDER_MODELS[node.providerId]}
        </p>
      ) : null}
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
    </div>
  );
});
