"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  useNodesState,
  type Edge,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  EvalResult,
  Run,
  WorkflowDefinition,
  WorkflowMode,
} from "@/lib/types";
import { clamp } from "@/lib/util";
import {
  kindColor,
  PipelineNodeView,
  type GateSnapshot,
  type PipelineFlowNode,
  type PipelineNodeData,
} from "@/components/canvas/PipelineNode";
import {
  StageLaneView,
  type LaneFlowNode,
  type LaneNodeData,
} from "@/components/canvas/StageLane";
import { POSITION_OVERRIDES, STAGE_LANES } from "@/components/canvas/layout";
import { currentSeed, latestComposite, loopContext } from "@/components/canvas/derive";

type CanvasNode = PipelineFlowNode | LaneFlowNode;

/* Stable module-level map so React Flow never re-registers node types. */
const nodeTypes = { pipeline: PipelineNodeView, lane: StageLaneView };

const COMPACT_PLAN_WORKFLOW_IDS = new Set([
  "lamp-background-v1",
  "lamp-beautify-v1",
  "lamp-iris-v1",
  "lamp-combined-v1",
]);

function isCompactPlanWorkflow(workflow: WorkflowDefinition): boolean {
  return COMPACT_PLAN_WORKFLOW_IDS.has(workflow.id);
}

function buildNodes(
  workflow: WorkflowDefinition,
  workflowMode: WorkflowMode
): CanvasNode[] {
  const laneNodes: LaneFlowNode[] =
    isCompactPlanWorkflow(workflow)
      ? []
      : STAGE_LANES.map((lane) => ({
    id: lane.id,
    type: "lane" as const,
    position: { x: lane.rect.x, y: lane.rect.y },
    data: { lane },
    width: lane.rect.width,
    height: lane.rect.height,
    zIndex: -1,
    draggable: false,
    selectable: false,
    focusable: false,
    /* Clicks fall through the lane panel to the pane (deselect). */
    style: { pointerEvents: "none" as const },
        }));
  const pipelineNodes: PipelineFlowNode[] = workflow.nodes.map((n) => ({
    id: n.id,
    type: "pipeline" as const,
    /* Render-time stage layout; the workflow definition stays untouched. */
    position: {
      ...(
        isCompactPlanWorkflow(workflow)
          ? n.position
          : POSITION_OVERRIDES[n.id] ?? n.position
      ),
    },
    data: {
      pipelineNode: n,
      workflowMode,
      status: "idle" as const,
      evalResult: null,
      iteration: null,
      seed: null,
      anchorThumb: null,
      gateInfo: null,
    },
  }));
  return [...laneNodes, ...pipelineNodes];
}

const EDGE_LABEL_OVERRIDES: Record<string, string> = {
  "e-ledger-compile": "one correction ↺",
};

function buildEdges(
  workflow: WorkflowDefinition,
  run: Run | undefined,
  loopingBack: boolean,
  fallbackActive: boolean
): Edge[] {
  const statusOf = (id: string) => run?.nodeStates[id]?.status ?? "idle";
  return workflow.edges.map((e) => {
    const base: Edge = {
      id: e.id,
      source: e.source,
      target: e.target,
      label: EDGE_LABEL_OVERRIDES[e.id] ?? e.label,
      labelBgStyle: { fill: "var(--raised)" },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
    };

    if (e.isFeedbackLoop) {
      /* Lamp's only feedback edge animates between the Initial critique and
         the one Final generation. There is no conditional fallback route. */
      const isCorrections = e.target === "compile";
      const active = isCorrections ? loopingBack : fallbackActive;
      const color = isCorrections ? "var(--accent)" : "var(--borderline)";
      return {
        ...base,
        animated: active,
        style: active
          ? { stroke: color, strokeWidth: 2 }
          : { stroke: "var(--edge)", strokeDasharray: "6 4" },
        labelStyle: {
          fill: active ? color : "var(--faint)",
          fontSize: 10,
          fontWeight: active ? 600 : 400,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: active ? color : "var(--edge)",
        },
      };
    }

    /* Normal flow edges brighten once work has flowed across them, so the
       pipeline visibly fills left to right. */
    const src = statusOf(e.source);
    const tgt = statusOf(e.target);
    const lit = src === "succeeded" && (tgt === "succeeded" || tgt === "running");
    return {
      ...base,
      style: lit ? { stroke: "var(--running)", strokeWidth: 2 } : undefined,
      labelStyle: { fill: lit ? "var(--running)" : "var(--muted)", fontSize: 10 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: lit ? "var(--running)" : "var(--edge)",
      },
    };
  });
}

/** Most recent EvalResult for an eval across the run's iterations (results stream in live). */
function latestEvalResult(run: Run, evalId: string): EvalResult | null {
  for (let i = run.iterations.length - 1; i >= 0; i -= 1) {
    const found = run.iterations[i].evalResults.find(
      (r) => r.evalId === evalId
    );
    if (found) return found;
  }
  return null;
}

export function PipelineCanvas({
  workflow,
  workflowMode,
  run,
  selectedNodeId,
  onSelectNode,
}: {
  workflow: WorkflowDefinition;
  workflowMode: WorkflowMode;
  /** The run whose nodeStates / eval results drive the live view. */
  run?: Run;
  /** Controlled selection also lets Rubrics deep-link into one graph node. */
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}) {
  const initialNodes = useMemo(
    () => buildNodes(workflow, workflowMode),
    [workflow, workflowMode]
  );
  const [nodes, setNodes, onNodesChange] =
    useNodesState<CanvasNode>(initialNodes);
  const pipelineNodeIds = useMemo(
    () => new Set(workflow.nodes.map((node) => node.id)),
    [workflow.nodes]
  );

  useEffect(() => {
    setNodes(buildNodes(workflow, workflowMode));
  }, [setNodes, workflow, workflowMode]);

  const threshold = workflow.config.compositePassThreshold;

  /* Keep the visual selection in sync with the inspector, including nodes
     opened from /pipeline?node=... rather than a direct canvas click. */
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        if (node.type !== "pipeline") return node;
        const selected = node.id === selectedNodeId;
        return node.selected === selected ? node : { ...node, selected };
      })
    );
  }, [selectedNodeId, setNodes]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      onNodesChange(changes);
      const selected = changes.find(
        (change) =>
          change.type === "select" &&
          change.selected &&
          pipelineNodeIds.has(change.id)
      );
      if (selected?.type === "select") {
        onSelectNode(selected.id);
        return;
      }
      const deselectedCurrent = changes.some(
        (change) =>
          change.type === "select" &&
          !change.selected &&
          change.id === selectedNodeId
      );
      if (deselectedCurrent) onSelectNode(null);
    },
    [onNodesChange, onSelectNode, pipelineNodeIds, selectedNodeId]
  );

  /* Sync live run state into node data without clobbering drag positions.
     Return the EXISTING node object when nothing it renders changed — fresh
     objects on every store tick would defeat memo on the custom node. The
     eval result and gate snapshot are compared by value because the store
     clones state, breaking reference equality. */
  useEffect(() => {
    const seed = currentSeed(run);
    const iteration =
      run && run.iterations.length > 0 ? run.iterations.length : null;
    const anchorThumb = run?.iterations[0]?.relitKeyframeDataUrl ?? null;
    const composite = latestComposite(run);
    const gateSnapshot: GateSnapshot | null = composite
      ? { score: composite.score, passed: composite.passed, threshold }
      : null;

    setNodes((current) =>
      current.map((n) => {
        if (n.type !== "pipeline" || !("pipelineNode" in n.data)) return n;
        const status = run?.nodeStates[n.id]?.status ?? "idle";
        const evalResult =
          run && n.data.pipelineNode.evalId
            ? latestEvalResult(run, n.data.pipelineNode.evalId)
            : null;
        const nextIteration = n.id === "videogen" ? iteration : null;
        const nextSeed = n.id === "videogen" ? seed : null;
        const nextThumb = n.id === "anchor" ? anchorThumb : null;
        const nextGate = n.id === "gate" ? gateSnapshot : null;

        const prev = n.data.evalResult;
        const sameEvalResult =
          prev === evalResult ||
          (prev !== null &&
            evalResult !== null &&
            prev.score === evalResult.score &&
            prev.verdict === evalResult.verdict &&
            prev.confidence === evalResult.confidence);
        const prevGate = n.data.gateInfo;
        const sameGate =
          prevGate === nextGate ||
          (prevGate !== null &&
            nextGate !== null &&
            prevGate.score === nextGate.score &&
            prevGate.passed === nextGate.passed);

        if (
          n.data.status === status &&
          sameEvalResult &&
          sameGate &&
          n.data.iteration === nextIteration &&
          n.data.seed === nextSeed &&
          n.data.anchorThumb === nextThumb
        ) {
          return n;
        }
        return {
          ...n,
          data: {
            ...n.data,
            status,
            evalResult,
            iteration: nextIteration,
            seed: nextSeed,
            anchorThumb: nextThumb,
            gateInfo: nextGate,
          },
        };
      })
    );
  }, [run, threshold, setNodes]);

  /* Edges re-render from node statuses; rebuild only when a status actually
     flips — the run object's identity churns on every store tick. */
  const { loopingBack, fallbackActive } = loopContext(run);
  const statusFingerprint = useMemo(
    () =>
      `${run?.id ?? "none"}|${workflow.nodes
        .map((n) => run?.nodeStates[n.id]?.status ?? "idle")
        .join("|")}`,
    [workflow, run]
  );
  const edges = useMemo(
    () => buildEdges(workflow, run, loopingBack, fallbackActive),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workflow, statusFingerprint, loopingBack, fallbackActive]
  );

  /* Follow mode: smoothly pan to whichever node is running. Default ON;
     any manual pan/zoom pauses it until the toggle is switched back on. */
  const rfRef = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null);
  const [follow, setFollow] = useState(true);
  const lastFocusKeyRef = useRef("");

  const runningKey = useMemo(() => {
    if (!run || run.status !== "running") return "";
    return workflow.nodes
      .filter((n) => run.nodeStates[n.id]?.status === "running")
      .map((n) => n.id)
      .join(",");
  }, [workflow, run]);
  const nodePositionById = useMemo(
    () =>
      new Map(
        workflow.nodes.map((node) => [
          node.id,
          isCompactPlanWorkflow(workflow)
            ? node.position
            : POSITION_OVERRIDES[node.id] ?? node.position,
        ])
      ),
    [workflow]
  );

  useEffect(() => {
    if (!follow || runningKey === "") return;
    if (runningKey === lastFocusKeyRef.current) return;
    const inst = rfRef.current;
    if (!inst) return;
    lastFocusKeyRef.current = runningKey;
    const ids = runningKey.split(",");
    let sx = 0;
    let sy = 0;
    for (const id of ids) {
      const p = nodePositionById.get(id) ?? { x: 0, y: 0 };
      sx += p.x + 100; // node center (cards are 200px wide)
      sy += p.y + 50;
    }
    void inst.setCenter(sx / ids.length, sy / ids.length, {
      zoom: clamp(inst.getZoom(), 0.55, 1.1),
      duration: 650,
    });
  }, [follow, nodePositionById, runningKey]);

  /* Programmatic moves report a null event; a real event means the user
     grabbed the viewport, which pauses following. */
  const handleMoveStart = useCallback(
    (event: MouseEvent | TouchEvent | null) => {
      if (event) setFollow(false);
    },
    []
  );

  const toggleFollow = () => {
    const next = !follow;
    if (next) lastFocusKeyRef.current = ""; // re-center immediately
    setFollow(next);
  };

  return (
    <div className="h-full w-full">
      <ReactFlow<CanvasNode, Edge>
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => {
          if (node.type === "pipeline") onSelectNode(node.id);
        }}
        onPaneClick={() => onSelectNode(null)}
        onMoveStart={handleMoveStart}
        onInit={(inst) => {
          rfRef.current = inst;
        }}
        nodesDraggable
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        minZoom={0.15}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="var(--edge)" />
        <Controls position="bottom-left" showInteractive={false} />
        <Panel position="top-right">
          <button
            onClick={toggleFollow}
            title="Smoothly pan to whichever node is running. Panning or zooming by hand pauses it."
            className="rounded-full border px-3 py-1 text-2xs font-medium transition"
            style={
              follow
                ? {
                    color: "var(--running)",
                    borderColor:
                      "color-mix(in srgb, var(--running) 45%, transparent)",
                    background:
                      "color-mix(in srgb, var(--running) 10%, transparent)",
                  }
                : {
                    color: "var(--muted)",
                    borderColor: "var(--edge)",
                    background: "var(--surface)",
                  }
            }
          >
            {follow ? "◉ follow: on" : "○ follow: off"}
          </button>
        </Panel>
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          style={{ width: 160, height: 110, background: "var(--surface)" }}
          maskColor="color-mix(in srgb, var(--canvas) 72%, transparent)"
          nodeStrokeColor="var(--edge)"
          nodeColor={(n) => {
            if (n.type === "lane") {
              const lane = (n.data as LaneNodeData).lane;
              return `color-mix(in srgb, ${lane.color} 8%, var(--surface))`;
            }
            return kindColor((n.data as PipelineNodeData).pipelineNode.kind);
          }}
        />
      </ReactFlow>
    </div>
  );
}
