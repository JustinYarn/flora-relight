"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/lib/store";
import type { RunStatus, WorkflowMode } from "@/lib/types";
import { Badge, Button, EmptyState } from "@/components/ui";
import { PipelineCanvas } from "@/components/canvas/PipelineCanvas";
import { NodeInspector } from "@/components/canvas/NodeInspector";
import { StageProgressStrip } from "@/components/canvas/StageProgressStrip";
import { STAGE_LANES } from "@/components/canvas/layout";
import {
  isPlanWorkflowMode,
  runWorkflowMode,
  workflowModeLabel,
} from "@/lib/workflow-mode";
import { workflowForMode } from "@/lib/workflow-def";

function iterationLabel(workflowMode: WorkflowMode, index: number) {
  if (workflowMode === "combined") return `Take ${index}`;
  if (workflowMode === "flora") return `Attempt ${index}`;
  if (index === 1) return "Initial";
  if (index === 2) return "Final";
  return `v${index}`;
}

/**
 * Minimal structural view of the Batch contract (lib/types.ts gains the full
 * interface in this phase). Typed locally + read via optional chaining so this
 * page compiles and runs whether or not the batch module has landed yet.
 */
interface BatchLike {
  id: string;
  name: string;
  runIds: string[];
}

function runStatusColor(status: RunStatus): string {
  switch (status) {
    case "running":
      return "var(--running)";
    case "awaiting-review":
      return "var(--borderline)";
    case "approved":
      return "var(--pass)";
    case "needs-changes":
    case "failed":
      return "var(--fail)";
    default:
      return "var(--muted)";
  }
}

export default function PipelinePage() {
  const defaultWorkflow = useAppStore((s) => s.workflow);
  const runs = useAppStore((s) => s.runs);
  const mode = useAppStore((s) => s.mode);
  const workflowMode = useAppStore((s) => s.workflowMode);
  const batches = useAppStore(
    (s) => (s as unknown as { batches?: BatchLike[] }).batches
  );

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    const url = new URL(window.location.href);
    if (nodeId) url.searchParams.set("node", nodeId);
    else url.searchParams.delete("node");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }, []);
  const closeInspector = useCallback(() => selectNode(null), [selectNode]);

  /* Default to the newest run for the selected method, never an unrelated door. */
  const activeRun = useMemo(() => {
    if (selectedRunId) {
      const found = runs.find((r) => r.id === selectedRunId);
      if (found) return found;
    }
    return runs.find((run) => runWorkflowMode(run) === workflowMode);
  }, [runs, selectedRunId, workflowMode]);
  const displayedWorkflowMode = activeRun
    ? runWorkflowMode(activeRun)
    : workflowMode;
  const workflow = useMemo(
    () =>
      activeRun
        ? workflowForMode(displayedWorkflowMode)
        : defaultWorkflow,
    [activeRun, defaultWorkflow, displayedWorkflowMode]
  );
  const displayedMode = activeRun ? (activeRun.live ? "live" : "mock") : mode;

  /* Rubrics deep-links to the graph without making the URL the source of
     truth for normal canvas clicks. Invalid node ids are simply ignored. */
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("node");
    if (requested && workflow.nodes.some((node) => node.id === requested)) {
      setSelectedNodeId(requested);
    } else if (
      selectedNodeId &&
      !workflow.nodes.some((node) => node.id === selectedNodeId)
    ) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, workflow.nodes]);

  const selectedNode = selectedNodeId
    ? workflow.nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;

  const parentBatch =
    activeRun && batches
      ? batches.find(
          (b) => Array.isArray(b.runIds) && b.runIds.includes(activeRun.id)
        )
      : undefined;

  const latestIteration =
    activeRun && activeRun.iterations.length > 0
      ? activeRun.iterations[activeRun.iterations.length - 1]
      : undefined;
  const latestIterationLabel = latestIteration
    ? iterationLabel(displayedWorkflowMode, latestIteration.index)
    : undefined;

  return (
    <div className="flex h-[calc(100vh-56px)] min-h-0 flex-col">
      {/* Page-local run binding bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-edge bg-surface px-4 py-2">
        <span
          className="text-sm font-semibold text-ink"
          title={workflow.description}
        >
          {workflow.name}
        </span>
        {displayedMode === "live" ? (
          <Badge color="var(--pass)">{activeRun ? "LIVE RUN" : "LIVE MODE"}</Badge>
        ) : (
          <Badge color="var(--accent)">{activeRun ? "MOCK RUN" : "MOCK MODE"}</Badge>
        )}
        {latestIteration ? (
          <span
            className="hidden text-2xs tabular-nums text-muted md:inline"
            title={`${latestIterationLabel} video · mega prompt v${latestIteration.megaPrompt.version}`}
          >
            {latestIterationLabel} · mega prompt v
            {latestIteration.megaPrompt.version}
          </span>
        ) : null}
        {parentBatch ? (
          <Link
            href="/batch"
            className="shrink-0"
            title={`This run is part of batch "${parentBatch.name}" — open the batch board`}
          >
            <Badge color="var(--accent)">batch · {parentBatch.name}</Badge>
          </Link>
        ) : null}

        {/* Lane-oriented legend: stage names, not raw kind colors. */}
        <div className="ml-auto hidden items-center gap-2.5 xl:flex">
          {(isPlanWorkflowMode(displayedWorkflowMode) ||
          displayedWorkflowMode === "combined"
            ? []
            : STAGE_LANES
          ).map((lane) => (
            <span
              key={lane.id}
              className="flex items-center gap-1 text-2xs text-faint"
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: lane.color }}
              />
              {lane.index} · {lane.title.toLowerCase()}
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <select
            value={activeRun?.id ?? ""}
            onChange={(e) => setSelectedRunId(e.target.value || null)}
            disabled={runs.length === 0}
            aria-label="Select run"
            className="rounded-lg border border-edge bg-raised px-2 py-1.5 text-xs text-ink focus:outline-none disabled:opacity-40"
          >
            {runs.length === 0 ? (
              <option value="">no runs yet</option>
            ) : !activeRun ? (
              <option value="">
                {workflowModeLabel(workflowMode)} definition
              </option>
            ) : null}
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {workflowModeLabel(runWorkflowMode(r))} · run …{r.id.slice(-6)} · {r.status}
              </option>
            ))}
          </select>
          {activeRun ? (
            <Badge color={runStatusColor(activeRun.status)}>
              {activeRun.status}
            </Badge>
          ) : null}
        </div>
      </div>

      {/* Live stage progress — what is happening right now, in plain words. */}
      <StageProgressStrip
        run={activeRun}
        config={workflow.config}
        workflowMode={displayedWorkflowMode}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge bg-canvas px-4 py-2">
        <Badge color="var(--accent)">prompt map</Badge>
        <p className="text-pretty text-xs text-muted">
          {displayedWorkflowMode === "combined"
            ? "Open a node to inspect the saved aggregate scope, each source-rooted Take prompt, recorded qualification receipts, and the human winner when one exists."
            : displayedWorkflowMode === "flora"
              ? "Open a labeled node to trace each historical attempt, its whole-video checks, and the saved corrections that feed the next attempt."
              : "Open a labeled node to trace the mega prompt, each whole-video rubric, its result, and the one correction set that creates Final."}
        </p>
        <Link
          href="/prompts"
          className="ml-auto inline-flex min-h-10 items-center text-xs text-faint transition-colors duration-150 hover:text-ink"
        >
          Browse every rubric →
        </Link>
      </div>

      {/* Canvas + inspector */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <PipelineCanvas
            workflow={workflow}
            workflowMode={displayedWorkflowMode}
            run={activeRun}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
          />
          {runs.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
              <div
                className="pointer-events-auto w-full max-w-md rounded-xl backdrop-blur-sm"
                style={{
                  background:
                    "color-mix(in srgb, var(--canvas) 82%, transparent)",
                }}
              >
                <EmptyState
                  title="The pipeline is idle"
                  hint="Upload a clip in Create to start a run, then pick it here to watch every node light up as it moves through the pipeline."
                  action={
                    <Link href="/">
                      <Button variant="primary">Go to Create</Button>
                    </Link>
                  }
                />
              </div>
            </div>
          ) : null}
        </div>

        {selectedNode ? (
          <NodeInspector
            node={selectedNode}
            run={activeRun}
            config={workflow.config}
            mode={mode}
            workflowMode={displayedWorkflowMode}
            onSelectNode={selectNode}
            onClose={closeInspector}
          />
        ) : null}
      </div>
    </div>
  );
}
