/**
 * Render-only layout for Lamp's four-stage Method canvas.
 *
 * The workflow definition remains the execution vocabulary; this module only
 * arranges those same nodes into readable lanes.
 */

export interface LaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StageLaneDef {
  id: string;
  index: number;
  title: string;
  subtitle?: string;
  color: string;
  nodeIds: string[];
  rect: LaneRect;
}

const NODE_W = 200;
const STEP_X = 244;
const LANE_GAP = 56;
const LANE_PAD_X = 32;
const LANE_PAD_TOP = 60;
const LANE_PAD_BOTTOM = 36;
const SPINE_Y = 320;
const EVAL_TOP = -65;
const EVAL_STEP = 110;

/** The eight visual results returned by each holistic Lamp evaluation call. */
export const EVAL_STACK_IDS: readonly string[] = [
  "eval-identity",
  "eval-skin",
  "eval-appearance",
  "eval-background",
  "eval-lighting-delta",
  "eval-motion",
  "eval-temporal",
  "eval-halluc",
];

function estHeight(id: string): number {
  if (id === "videogen") return 122;
  if (id.startsWith("eval")) return 100;
  return 86;
}

export const POSITION_OVERRIDES: Record<string, { x: number; y: number }> = {};
export const STAGE_LANES: StageLaneDef[] = [];

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

  cols.forEach((col, columnIndex) => {
    const x = x0 + columnIndex * STEP_X;
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
  {
    id: "lane-source",
    index: 1,
    title: "Protect the source",
    subtitle: "video + original audio",
    color: "var(--muted)",
  },
  [[{ id: "src", y: SPINE_Y }], [{ id: "ingest", y: SPINE_Y }]]
);

addLane(
  {
    id: "lane-generate",
    index: 2,
    title: "Generate & verify twice",
    subtitle: "Initial, then Final · source audio restored each time",
    color: "var(--accent)",
  },
  [
    [{ id: "compile", y: SPINE_Y }],
    [{ id: "videogen", y: SPINE_Y }],
    [{ id: "remux", y: SPINE_Y }],
    [{ id: "eval-audio", y: SPINE_Y }],
  ]
);

addLane(
  {
    id: "lane-evaluate",
    index: 3,
    title: "Evaluate the whole video",
    subtitle: "8 visual results returned together",
    color: "var(--running)",
  },
  [
    EVAL_STACK_IDS.map((id, index) => ({ id, y: EVAL_TOP + index * EVAL_STEP })),
    [{ id: "ledger", y: SPINE_Y }],
  ]
);

addLane(
  {
    id: "lane-grade",
    index: 4,
    title: "Blind human grade",
    subtitle: "Final only · reveal AI after save",
    color: "var(--pass)",
  },
  [[{ id: "review", y: SPINE_Y }]]
);
