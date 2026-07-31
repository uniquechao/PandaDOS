/**
 * ui/lib/gitgraph —— 提交图泳道布局（纯函数，无 DOM/preact 依赖，可单测）。
 *
 * 输入：按 git log 顺序（子在前、父在后，routes/git.ts --date-order 保证）的
 * {sha, parents} 列表；输出每个提交的泳道号 + 连线段，SVG 渲染只做坐标换算。
 *
 * 算法（经典 lane 分配）：自上而下扫描，维护「活动泳道」数组，每道记录
 * 它正在等待的父 sha 与已挂上来的子节点。遇到提交 C：
 *   - 等它的所有泳道收敛到最左那条（其余闭合出连线段）；没人等 → 分配空闲道（分支 tip）。
 *   - C 的第一父占据 C 所在道继续向下；其余父（合并）优先挂进已在等它的道，否则开新道。
 * 窗口截断（父在 200 条之外）→ 连线段 missing:true，前端画淡出短桩。
 */

export interface GraphCommitIn {
  sha: string;
  parents: string[];
}

export interface GraphNode {
  sha: string;
  row: number;
  lane: number;
}

/**
 * 一条子→父连线：从 (fromRow, fromLane) 出发，沿 lane 道下行，
 * 到 (toRow, toLane) 汇入父节点。missing = 父不在窗口内（toRow 越界一行做淡出桩）。
 */
export interface GraphEdge {
  fromRow: number;
  fromLane: number;
  lane: number;
  toRow: number;
  toLane: number;
  missing?: boolean;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 泳道总数（含被复用的），决定图区宽度 */
  maxLanes: number;
}

interface ActiveLane {
  /** 该道正在等待的父 sha */
  sha: string;
  /** 已挂到该道上的子节点起点（可多个：多个子共父时并行下行、父行收敛） */
  starts: Array<{ row: number; lane: number }>;
}

export function layoutGraph(commits: GraphCommitIn[]): GraphLayout {
  const lanes: Array<ActiveLane | null> = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let maxLanes = 0;

  const freeSlot = (): number => {
    const i = lanes.indexOf(null);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  const touch = (lane: number): void => {
    if (lane + 1 > maxLanes) maxLanes = lane + 1;
  };

  commits.forEach((c, row) => {
    // 1) 所有在等 c 的泳道：最左的成为 c 的落点，其余闭合并出边
    const waiting: number[] = [];
    lanes.forEach((l, i) => {
      if (l && l.sha === c.sha) waiting.push(i);
    });
    const lane = waiting.length > 0 ? waiting[0]! : freeSlot();
    touch(lane);
    nodes.push({ sha: c.sha, row, lane });
    for (const i of waiting) {
      for (const st of lanes[i]!.starts) {
        edges.push({ fromRow: st.row, fromLane: st.lane, lane: i, toRow: row, toLane: lane });
      }
      lanes[i] = null;
    }

    // 2) 第一父沿本道继续；其余父（合并）挂已有道或开新道
    const [p0, ...rest] = c.parents;
    if (p0) lanes[lane] = { sha: p0, starts: [{ row, lane }] };
    for (const p of rest) {
      const existing = lanes.findIndex((l) => l !== null && l.sha === p);
      if (existing >= 0) {
        lanes[existing]!.starts.push({ row, lane });
      } else {
        const j = freeSlot();
        touch(j);
        lanes[j] = { sha: p, starts: [{ row, lane }] };
      }
    }
  });

  // 3) 窗口外的父：淡出桩（toRow 越界一行）
  lanes.forEach((l, i) => {
    if (!l) return;
    for (const st of l.starts) {
      edges.push({
        fromRow: st.row,
        fromLane: st.lane,
        lane: i,
        toRow: commits.length,
        toLane: i,
        missing: true,
      });
    }
  });

  return { nodes, edges, maxLanes };
}
