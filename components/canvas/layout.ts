/**
 * Canvas-only layout: six labeled stage lanes + node position overrides.
 *
 * RELIGHT_WORKFLOW (lib/workflow-def.ts) stays untouched — the engine and the
 * rest of the app key on node ids, so this module re-lays the SAME nodes into
 * an assembly line of labeled stages purely at render time. If a node id is
 * missing from POSITION_OVERRIDES the canvas falls back to the definition's
 * own position, so a workflow change degrades gracefully instead of breaking.
 *
 * All colors are design tokens (CSS variables) — no raw hex.
 */

export interface LaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StageLaneDef {
  id: string;
  /** 1-based stage number, rendered in the lane label and the legend. */
  index: number;
  title: string;
  subtitle?: string;
  /** Token color the lane tint and label derive from. */
  color: string;
  nodeIds: string[];
  rect: LaneRect;
}

const NODE_W = 200; // matches the w-[200px] node card
const STEP_X = 244; // horizontal rhythm inside a lane (card + gap)
const LANE_GAP = 56;
const LANE_PAD_X = 32;
const LANE_PAD_TOP = 60; // room for the lane label
const LANE_PAD_BOTTOM = 36;
const SPINE_Y = 320; // main left-to-right flow line
const EVAL_TOP = -175; // eval stack centered on the spine
const EVAL_STEP = 110;

/** Order of the per-iteration checks in the gauntlet stack (top to bottom). */
export const EVAL_STACK_IDS: readonly string[] = [
  "eval-align",
  "eval-identity",
  "eval-skin",
  "eval-appearance",
  "eval-background",
  "eval-lighting-delta",
  "eval-lighting-anchor",
  "eval-motion",
  "eval-temporal",
  "eval-halluc",
];

/** Rough card heights used ONLY to size the lane panels behind the nodes. */
function estHeight(id: string): number {
  if (id === "anchor") return 150; // keyframe thumbnail
  if (id === "videogen") return 122; // iteration badge + seed row
  if (id === "gate") return 100; // composite-vs-threshold row
  if (id.startsWith("eval")) return 100; // score chip + verdict badge
  return 86;
}

export const POSITION_OVERRIDES: Record<string, { x: number; y: number }> = {};
export const STAGE_LANES: StageLaneDef[] = [];

/** Columns of {id, y} placements; each column advances x by STEP_X. */
type Placement = Array<Array<{ id: string; y: number }>>;

let cursorX = 0;

function addLane(
  def: Omit<StageLaneDef, "rect" | "nodeIds">,
  cols: Placement
): void {
  const x0 = cursorX + LANE_PAD_X;
  let minY = Infinity;
  let maxY = -Infinity;
  const nodeIds: string[] = [];
  cols.forEach((col, ci) => {
    const x = x0 + ci * STEP_X;
    for (const { id, y } of col) {
      POSITION_OVERRIDES[id] = { x, y };
      nodeIds.push(id);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + estHeight(id));
    }
  });
  const width = LANE_PAD_X * 2 + (cols.length - 1) * STEP_X + NODE_W;
  STAGE_LANES.push({
    ...def,
    nodeIds,
    rect: {
      x: cursorX,
      y: minY - LANE_PAD_TOP,
      width,
      height: maxY - minY + LANE_PAD_TOP + LANE_PAD_BOTTOM,
    },
  });
  cursorX += width + LANE_GAP;
}

addLane(
  { id: "lane-ingest", index: 1, title: "Read the clip", color: "var(--muted)" },
  [
    [{ id: "src", y: SPINE_Y }],
    [{ id: "ingest", y: SPINE_Y }],
    [{ id: "manifest", y: SPINE_Y }],
  ]
);

addLane(
  {
    id: "lane-anchor",
    index: 2,
    title: "Look Anchor",
    subtitle: "target lighting photo",
    color: "var(--accent)",
  },
  [[{ id: "anchor", y: SPINE_Y }], [{ id: "anchor-gate", y: SPINE_Y }]]
);

addLane(
  {
    id: "lane-generate",
    index: 3,
    title: "Generate the video",
    subtitle: "from the generation brief",
    color: "var(--accent)",
  },
  [
    [{ id: "compile", y: SPINE_Y }],
    [{ id: "videogen", y: SPINE_Y }],
    [{ id: "conform", y: SPINE_Y }],
  ]
);

addLane(
  {
    id: "lane-evals",
    index: 4,
    title: "The 10 checks",
    subtitle: "full loop · selected run may skip",
    color: "var(--running)",
  },
  [
    [{ id: "sample", y: SPINE_Y }],
    EVAL_STACK_IDS.map((id, i) => ({ id, y: EVAL_TOP + i * EVAL_STEP })),
  ]
);

addLane(
  {
    id: "lane-decide",
    index: 5,
    title: "Pass or retry",
    // Same token mix the gate node kind uses.
    color: "color-mix(in srgb, var(--fail) 55%, var(--borderline) 45%)",
  },
  [
    [{ id: "ledger", y: SPINE_Y }],
    [
      { id: "gate", y: SPINE_Y },
      { id: "fallback", y: SPINE_Y + 210 },
    ],
  ]
);

addLane(
  { id: "lane-deliver", index: 6, title: "Deliver", color: "var(--pass)" },
  [
    [{ id: "remux", y: SPINE_Y }],
    [{ id: "eval-audio", y: SPINE_Y }],
    [{ id: "review", y: SPINE_Y }],
  ]
);
