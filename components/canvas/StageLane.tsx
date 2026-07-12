"use client";

/**
 * Non-interactive lane panel rendered BEHIND the pipeline nodes (zIndex -1,
 * pointer-events disabled at the node level) — one per stage, so the graph
 * reads as a labeled assembly line instead of freeform node spaghetti.
 */

import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { StageLaneDef } from "@/components/canvas/layout";

export type LaneNodeData = { lane: StageLaneDef };

export type LaneFlowNode = Node<LaneNodeData, "lane">;

export const StageLaneView = memo(function StageLaneView({
  data,
}: NodeProps<LaneFlowNode>) {
  const { lane } = data;
  return (
    <div
      aria-hidden="true"
      className="rounded-2xl border border-edge"
      style={{
        width: lane.rect.width,
        height: lane.rect.height,
        background: `color-mix(in srgb, ${lane.color} 5%, transparent)`,
      }}
    >
      <p
        className="px-4 pt-3 text-2xs font-semibold uppercase tracking-[0.18em]"
        style={{ color: `color-mix(in srgb, ${lane.color} 60%, var(--muted))` }}
      >
        {lane.index} · {lane.title}
        {lane.subtitle ? (
          <span className="ml-1 font-normal normal-case tracking-normal text-faint">
            — {lane.subtitle}
          </span>
        ) : null}
      </p>
    </div>
  );
});
