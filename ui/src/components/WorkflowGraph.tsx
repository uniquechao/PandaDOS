import { useMemo } from 'preact/hooks';
import type { IssueWorkflowNodeRun, WorkflowGraphSnapshot, WorkflowNodeRunStatus } from '../lib/types';
import { tr } from '../i18n/runtime';
import { workflowNodeStatusKey } from '../lib/workflow';

const NODE_W = 196;
const NODE_H = 72;

function currentRuns(runs: IssueWorkflowNodeRun[]): Map<string, IssueWorkflowNodeRun> {
  const result = new Map<string, IssueWorkflowNodeRun>();
  for (const run of runs) {
    const previous = result.get(run.nodeKey);
    if (!previous || previous.id < run.id) result.set(run.nodeKey, run);
  }
  return result;
}

function graphBounds(graph: WorkflowGraphSnapshot): { x: number; y: number; width: number; height: number } {
  if (graph.nodes.length === 0) return { x: 0, y: 0, width: 640, height: 240 };
  const minX = Math.min(...graph.nodes.map((node) => node.positionX)) - 48;
  const minY = Math.min(...graph.nodes.map((node) => node.positionY)) - 48;
  const maxX = Math.max(...graph.nodes.map((node) => node.positionX + NODE_W)) + 48;
  const maxY = Math.max(...graph.nodes.map((node) => node.positionY + NODE_H)) + 48;
  return { x: minX, y: minY, width: Math.max(480, maxX - minX), height: Math.max(210, maxY - minY) };
}

function short(value: string, limit = 23): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function WorkflowGraph({ graph, runs = [], compact = false }: { graph: WorkflowGraphSnapshot; runs?: IssueWorkflowNodeRun[]; compact?: boolean }) {
  const runByNode = useMemo(() => currentRuns(runs), [runs]);
  const nodeByKey = useMemo(() => new Map(graph.nodes.map((node) => [node.key, node])), [graph.nodes]);
  const bounds = useMemo(() => graphBounds(graph), [graph]);

  return (
    <div class={`wfg${compact ? ' compact' : ''}`} role="img" aria-label={tr('workflow.graphRuntimeAria')}>
      <svg viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="wfg-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" />
          </marker>
        </defs>
        {graph.edges.map((edge) => {
          const from = nodeByKey.get(edge.fromNodeKey);
          const to = nodeByKey.get(edge.toNodeKey);
          if (!from || !to) return null;
          const x1 = from.positionX + NODE_W;
          const y1 = from.positionY + NODE_H / 2;
          const x2 = to.positionX;
          const y2 = to.positionY + NODE_H / 2;
          const curve = Math.max(42, Math.abs(x2 - x1) * 0.42);
          const selected = runs.some((run) => run.selectedEdgeKeys.includes(edge.key));
          return (
            <g key={edge.key} class={selected ? 'selected' : ''}>
              <path class="wfg-edge" d={`M${x1},${y1} C${x1 + curve},${y1} ${x2 - curve},${y2} ${x2},${y2}`} marker-end="url(#wfg-arrow)" />
              {edge.conditionText && !compact && <title>{edge.conditionText}</title>}
            </g>
          );
        })}
        {graph.nodes.map((node) => {
          const run = runByNode.get(node.key);
          const status: WorkflowNodeRunStatus | 'idle' = run?.status ?? 'idle';
          const kind = tr(`workflow.nodeKind.${node.kind}`);
          const meta = run
            ? `${tr(workflowNodeStatusKey(status))} · ${tr('workflow.iterationValue', { value: run.iteration })}`
            : node.agent ? (node.agent === 'claude' ? 'Claude Code' : 'Codex') : kind;
          return (
            <g key={node.key} class={`wfg-node status-${status}`} transform={`translate(${node.positionX} ${node.positionY})`}>
              <title>{tr('workflow.nodeRuntimeAria', { title: node.title, kind, status: tr(workflowNodeStatusKey(status)) })}</title>
              <rect width={NODE_W} height={NODE_H} rx="14" />
              <circle cx="18" cy="19" r="5" />
              <text class="wfg-title" x="31" y="24">{short(node.title)}</text>
              <text class="wfg-meta" x="18" y="51">{short(meta, 28)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
