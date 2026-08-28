import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useI18n } from '../i18n/provider';
import { api, ApiError } from '../lib/api';
import { nav } from '../lib/router';
import { toast } from '../lib/toast';
import type {
  AgentKind,
  WorkflowEdgeDefinition,
  WorkflowGraphSnapshot,
  WorkflowNodeDefinition,
  WorkflowNodeKind,
  WorkflowTemplateDetail,
  WorkflowValidationIssue,
} from '../lib/types';
import { workflowValidationKey } from '../lib/workflow';

const CANVAS_WIDTH = 1240;
const CANVAS_HEIGHT = 760;
const NODE_WIDTH = 184;
const NODE_HEIGHT = 96;
const ZOOM_MIN = 0.55;
const ZOOM_MAX = 1.5;

interface StarterLabels {
  issue: string;
  agent: string;
  end: string;
}

export function createStarterWorkflowGraph(labels: StarterLabels): WorkflowGraphSnapshot {
  return {
    schemaVersion: 1,
    entryNodeKey: 'issue',
    maxLoopIterations: 10,
    nodes: [
      { key: 'issue', kind: 'issue', title: labels.issue, instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 80, positionY: 220, config: null },
      { key: 'agent-1', kind: 'agent', title: labels.agent, instructions: null, agent: 'codex', executionMode: 'write', maxVisits: 1, positionX: 390, positionY: 220, config: null },
      { key: 'end', kind: 'end', title: labels.end, instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 700, positionY: 220, config: null },
    ],
    edges: [
      { key: 'edge-1', fromNodeKey: 'issue', toNodeKey: 'agent-1', conditionText: null, priority: 0, isDefault: false },
      { key: 'edge-2', fromNodeKey: 'agent-1', toNodeKey: 'end', conditionText: null, priority: 0, isDefault: false },
    ],
  };
}

function nextKey(prefix: string, keys: readonly string[]): string {
  const used = new Set(keys);
  for (let index = 1; ; index += 1) {
    const key = `${prefix}-${index}`;
    if (!used.has(key)) return key;
  }
}

export function addWorkflowNode(
  graph: WorkflowGraphSnapshot,
  kind: Exclude<WorkflowNodeKind, 'issue'>,
  title: string,
): WorkflowGraphSnapshot {
  const key = nextKey(kind, graph.nodes.map((node) => node.key));
  const offset = graph.nodes.length * 34;
  const node: WorkflowNodeDefinition = {
    key,
    kind,
    title,
    instructions: null,
    agent: kind === 'agent' ? 'codex' : null,
    executionMode: kind === 'agent' ? 'write' : 'read',
    maxVisits: 1,
    positionX: Math.min(920, 180 + offset),
    positionY: Math.min(560, 100 + offset),
    config: kind === 'fork' ? { joinNodeKey: '' } : null,
  };
  return { ...graph, nodes: [...graph.nodes, node] };
}

export function removeWorkflowNode(graph: WorkflowGraphSnapshot, key: string): WorkflowGraphSnapshot {
  if (key === graph.entryNodeKey) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.key !== key),
    edges: graph.edges.filter((edge) => edge.fromNodeKey !== key && edge.toNodeKey !== key),
  };
}

export function moveWorkflowNode(
  graph: WorkflowGraphSnapshot,
  key: string,
  positionX: number,
  positionY: number,
): WorkflowGraphSnapshot {
  const x = Math.max(16, Math.min(CANVAS_WIDTH - NODE_WIDTH - 16, Math.round(positionX)));
  const y = Math.max(16, Math.min(CANVAS_HEIGHT - NODE_HEIGHT - 16, Math.round(positionY)));
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.key === key ? { ...node, positionX: x, positionY: y } : node),
  };
}

export function connectWorkflowNodes(
  graph: WorkflowGraphSnapshot,
  fromNodeKey: string,
  toNodeKey: string,
): WorkflowGraphSnapshot {
  const key = nextKey('edge', graph.edges.map((edge) => edge.key));
  return {
    ...graph,
    edges: [...graph.edges, { key, fromNodeKey, toNodeKey, conditionText: null, priority: 0, isDefault: false }],
  };
}

function edgePath(from: WorkflowNodeDefinition, to: WorkflowNodeDefinition): string {
  const x1 = from.positionX + NODE_WIDTH;
  const y1 = from.positionY + NODE_HEIGHT / 2;
  const x2 = to.positionX;
  const y2 = to.positionY + NODE_HEIGHT / 2;
  if (from.key === to.key) {
    const top = from.positionY - 42;
    return `M ${x1 - 24} ${from.positionY + 8} C ${x1 + 72} ${top}, ${from.positionX - 72} ${top}, ${from.positionX + 24} ${from.positionY + 8}`;
  }
  const bend = Math.max(70, Math.abs(x2 - x1) * 0.45);
  const direction = x2 >= x1 ? 1 : -1;
  return `M ${x1} ${y1} C ${x1 + bend * direction} ${y1}, ${x2 - bend * direction} ${y2}, ${x2} ${y2}`;
}

function detailIssues(error: unknown): WorkflowValidationIssue[] {
  if (!(error instanceof ApiError) || typeof error.details !== 'object' || error.details === null) return [];
  const issues = (error.details as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues.filter((item): item is WorkflowValidationIssue => (
    typeof item === 'object' && item !== null && typeof (item as WorkflowValidationIssue).code === 'string'
  )) : [];
}

function nodeKindIcon(kind: WorkflowNodeKind): string {
  if (kind === 'issue') return '◆';
  if (kind === 'agent') return '◉';
  if (kind === 'fork') return '⑂';
  if (kind === 'join') return '⑃';
  return '✓';
}

export function WorkflowTemplatesView({ pid }: { pid: number }) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<WorkflowTemplateDetail[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [graph, setGraph] = useState<WorkflowGraphSnapshot>(() => createStarterWorkflowGraph({
    issue: t('workflow.defaultIssueNode'), agent: t('workflow.defaultAgentNode'), end: t('workflow.defaultEndNode'),
  }));
  const [savedSignature, setSavedSignature] = useState('');
  const [selectedNodeKey, setSelectedNodeKey] = useState('issue');
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState('issue');
  const [connectTo, setConnectTo] = useState('agent-1');
  const [zoom, setZoom] = useState(0.85);
  const [issues, setIssues] = useState<WorkflowValidationIssue[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ key: string; clientX: number; clientY: number; x: number; y: number } | null>(null);

  const signature = useMemo(() => JSON.stringify({ name: name.trim(), description: description.trim(), status, graph }), [name, description, status, graph]);
  const dirty = signature !== savedSignature;
  const selectedNode = graph.nodes.find((node) => node.key === selectedNodeKey) ?? null;
  const selectedEdge = graph.edges.find((edge) => edge.key === selectedEdgeKey) ?? null;

  const applyDetail = (detail: WorkflowTemplateDetail): void => {
    setSelectedId(detail.template.id);
    setName(detail.template.name);
    setDescription(detail.template.description ?? '');
    setStatus(detail.template.status);
    setGraph(detail.version.graph);
    setSelectedNodeKey(detail.version.graph.entryNodeKey);
    setSelectedEdgeKey(null);
    setIssues([]);
    setError('');
    setSavedSignature(JSON.stringify({
      name: detail.template.name.trim(),
      description: (detail.template.description ?? '').trim(),
      status: detail.template.status,
      graph: detail.version.graph,
    }));
  };

  const load = async (preferId?: number | null): Promise<void> => {
    const result = await api<{ ok: true; workflows: WorkflowTemplateDetail[] }>(`/api/projects/${pid}/workflows`);
    setTemplates(result.workflows);
    const target = result.workflows.find((item) => item.template.id === (preferId ?? selectedId)) ?? result.workflows[0];
    if (target) applyDetail(target);
  };

  useEffect(() => {
    void load().catch((cause: Error) => setError(cause.message));
  }, [pid]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);

  const confirmDiscard = (): boolean => !dirty || confirm(t('workflow.discardConfirm'));

  const newTemplate = (): void => {
    if (!confirmDiscard()) return;
    const next = createStarterWorkflowGraph({
      issue: t('workflow.defaultIssueNode'), agent: t('workflow.defaultAgentNode'), end: t('workflow.defaultEndNode'),
    });
    setSelectedId(null);
    setName('');
    setDescription('');
    setStatus('active');
    setGraph(next);
    setSelectedNodeKey(next.entryNodeKey);
    setSelectedEdgeKey(null);
    setIssues([]);
    setError('');
    setSavedSignature('__new_template__');
  };

  const chooseTemplate = (detail: WorkflowTemplateDetail): void => {
    if (!confirmDiscard()) return;
    applyDetail(detail);
  };

  const updateNode = (patch: Partial<WorkflowNodeDefinition>): void => {
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.key === selectedNodeKey ? { ...node, ...patch } : node),
    }));
    setIssues([]);
  };

  const updateEdge = (patch: Partial<WorkflowEdgeDefinition>): void => {
    if (!selectedEdgeKey) return;
    setGraph((current) => ({
      ...current,
      edges: current.edges.map((edge) => edge.key === selectedEdgeKey ? { ...edge, ...patch } : edge),
    }));
    setIssues([]);
  };

  const addNode = (kind: Exclude<WorkflowNodeKind, 'issue'>): void => {
    const title = t(`workflow.nodeKind.${kind}`);
    setGraph((current) => {
      const next = addWorkflowNode(current, kind, title);
      setSelectedNodeKey(next.nodes[next.nodes.length - 1]!.key);
      return next;
    });
    setSelectedEdgeKey(null);
    setIssues([]);
  };

  const deleteNode = (): void => {
    if (!selectedNode || selectedNode.key === graph.entryNodeKey || !confirm(t('workflow.deleteNodeConfirm', { name: selectedNode.title }))) return;
    setGraph((current) => removeWorkflowNode(current, selectedNode.key));
    setSelectedNodeKey(graph.entryNodeKey);
    setSelectedEdgeKey(null);
    setIssues([]);
  };

  const addEdge = (): void => {
    if (!connectFrom || !connectTo) return;
    setGraph((current) => {
      const next = connectWorkflowNodes(current, connectFrom, connectTo);
      setSelectedEdgeKey(next.edges[next.edges.length - 1]!.key);
      return next;
    });
    setIssues([]);
  };

  const deleteEdge = (): void => {
    if (!selectedEdge) return;
    setGraph((current) => ({ ...current, edges: current.edges.filter((edge) => edge.key !== selectedEdge.key) }));
    setSelectedEdgeKey(null);
    setIssues([]);
  };

  const validate = async (): Promise<WorkflowGraphSnapshot | null> => {
    setError('');
    setIssues([]);
    try {
      const result = await api<{ ok: true; graph: WorkflowGraphSnapshot }>(`/api/projects/${pid}/workflows/validate`, 'POST', { graph });
      setGraph(result.graph);
      toast.success(t('workflow.validationPassed'));
      return result.graph;
    } catch (cause) {
      const structural = detailIssues(cause);
      setIssues(structural);
      setError(structural.length ? '' : cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };

  const save = async (): Promise<void> => {
    if (busy) return;
    if (!name.trim()) {
      setError(t('workflow.nameRequired'));
      return;
    }
    setBusy(true);
    try {
      const normalizedGraph = await validate();
      if (!normalizedGraph) return;
      let detail: WorkflowTemplateDetail;
      if (selectedId === null) {
        const result = await api<{ ok: true; workflow: WorkflowTemplateDetail }>(`/api/projects/${pid}/workflows`, 'POST', {
          name: name.trim(), description: description.trim() || null, graph: normalizedGraph,
        });
        detail = result.workflow;
      } else {
        const saved = templates?.find((item) => item.template.id === selectedId);
        detail = saved!;
        if (!saved || saved.template.name !== name.trim() || (saved.template.description ?? '') !== description.trim() || saved.template.status !== status) {
          const result = await api<{ ok: true; workflow: WorkflowTemplateDetail }>(`/api/projects/${pid}/workflows/${selectedId}`, 'PATCH', {
            name: name.trim(), description: description.trim() || null, status,
          });
          detail = result.workflow;
        }
        if (!saved || JSON.stringify(saved.version.graph) !== JSON.stringify(normalizedGraph)) {
          const result = await api<{ ok: true; workflow: WorkflowTemplateDetail }>(`/api/projects/${pid}/workflows/${selectedId}`, 'PUT', { graph: normalizedGraph });
          detail = result.workflow;
        }
      }
      await load(detail.template.id);
      toast.success(t('workflow.saved'));
    } catch (cause) {
      const structural = detailIssues(cause);
      setIssues(structural);
      setError(structural.length ? '' : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyTemplate = async (): Promise<void> => {
    if (selectedId === null || busy) return;
    const copyName = prompt(t('workflow.copyNamePrompt'), t('workflow.copyName', { name }))?.trim();
    if (!copyName) return;
    setBusy(true);
    try {
      const result = await api<{ ok: true; workflow: WorkflowTemplateDetail }>(`/api/projects/${pid}/workflows/${selectedId}/copy`, 'POST', { name: copyName });
      await load(result.workflow.template.id);
      toast.success(t('workflow.copied'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteTemplate = async (): Promise<void> => {
    if (selectedId === null || busy || !confirm(t('workflow.deleteTemplateConfirm', { name }))) return;
    setBusy(true);
    try {
      await api(`/api/projects/${pid}/workflows/${selectedId}`, 'DELETE');
      setSelectedId(null);
      await load(null);
      toast.success(t('workflow.deleted'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const onNodePointerDown = (event: JSX.TargetedPointerEvent<HTMLButtonElement>, node: WorkflowNodeDefinition): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { key: node.key, clientX: event.clientX, clientY: event.clientY, x: node.positionX, y: node.positionY };
    setSelectedNodeKey(node.key);
    setSelectedEdgeKey(null);
  };

  const onNodePointerMove = (event: JSX.TargetedPointerEvent<HTMLButtonElement>): void => {
    const active = drag.current;
    if (!active || active.key !== event.currentTarget.dataset.nodeKey) return;
    setGraph((current) => moveWorkflowNode(
      current,
      active.key,
      active.x + (event.clientX - active.clientX) / zoom,
      active.y + (event.clientY - active.clientY) / zoom,
    ));
  };

  const onNodeKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>, node: WorkflowNodeDefinition): void => {
    const delta = event.shiftKey ? 48 : 12;
    const movement: Record<string, [number, number]> = {
      ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta],
    };
    const step = movement[event.key];
    if (!step) return;
    event.preventDefault();
    setGraph((current) => moveWorkflowNode(current, node.key, node.positionX + step[0], node.positionY + step[1]));
  };

  const leave = (): void => {
    if (confirmDiscard()) nav(`/p/${pid}/settings`);
  };

  return (
    <div class="fullcol wf-page">
      <header class="wf-head">
        <button class="back" aria-label={t('ui.back')} onClick={leave}>‹</button>
        <div class="wf-head-copy"><h1>{t('workflow.title')}</h1><span>{t('workflow.subtitle')}</span></div>
        <div class="wf-head-actions" aria-live="polite">
          <span class={`wf-save-state ${dirty ? 'dirty' : ''}`}>{dirty ? t('workflow.unsaved') : t('workflow.savedState')}</span>
          <button class="btn" disabled={busy} onClick={() => void validate()}>{t('workflow.validate')}</button>
          <button class="btn primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t('ui.saving') : t('workflow.save')}</button>
        </div>
      </header>

      <div class="wf-layout">
        <aside class="wf-library" aria-label={t('workflow.templateList')}>
          <div class="wf-panel-head"><strong>{t('workflow.templates')}</strong><button class="wf-icon-btn" title={t('workflow.newTemplate')} aria-label={t('workflow.newTemplate')} onClick={newTemplate}>＋</button></div>
          <div class="wf-template-list">
            {templates === null ? <div class="mut small wf-pad">{t('ui.loading')}</div> : templates.length === 0 ? <div class="empty">{t('workflow.empty')}</div> : templates.map((detail) => (
              <button key={detail.template.id} class={`wf-template ${selectedId === detail.template.id ? 'on' : ''}`} aria-pressed={selectedId === detail.template.id} aria-label={t('workflow.templateAria', { name: detail.template.name, version: detail.template.currentVersion, status: t(detail.template.status === 'active' ? 'workflow.active' : 'workflow.archived') })} onClick={() => chooseTemplate(detail)}>
                <span class="wf-template-title">{detail.template.name}</span>
                <span class="wf-template-meta">{t('workflow.templateMeta', { version: detail.template.currentVersion, nodes: detail.nodeCount })}</span>
                {detail.template.status === 'archived' && <span class="badge b-gray">{t('workflow.archived')}</span>}
              </button>
            ))}
          </div>
          <div class="wf-library-actions">
            <button class="btn sm" disabled={selectedId === null || busy} onClick={() => void copyTemplate()}>{t('workflow.copy')}</button>
            <button class="btn sm danger" disabled={selectedId === null || busy} onClick={() => void deleteTemplate()}>{t('workflow.deleteTemplate')}</button>
          </div>
        </aside>

        <main class="wf-workspace">
          <div class="wf-toolbar" aria-label={t('workflow.canvasTools')}>
            <div class="wf-add-tools">
              {(['agent', 'fork', 'join', 'end'] as const).map((kind) => <button key={kind} class="wf-tool" onClick={() => addNode(kind)}><span aria-hidden="true">{nodeKindIcon(kind)}</span>{t(`workflow.add.${kind}`)}</button>)}
            </div>
            <div class="wf-zoom">
              <button class="wf-icon-btn" aria-label={t('workflow.zoomOut')} onClick={() => setZoom((value) => Math.max(ZOOM_MIN, value - 0.1))}>−</button>
              <button class="wf-zoom-value" aria-label={t('workflow.resetZoom')} onClick={() => setZoom(0.85)}>{Math.round(zoom * 100)}%</button>
              <button class="wf-icon-btn" aria-label={t('workflow.zoomIn')} onClick={() => setZoom((value) => Math.min(ZOOM_MAX, value + 0.1))}>＋</button>
            </div>
          </div>
          <div class="wf-canvas-scroll">
            <div class="wf-canvas" role="application" aria-label={t('workflow.canvasAria')} style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
              <svg class="wf-connections" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} aria-hidden="true">
                <defs><marker id="wf-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" /></marker></defs>
                {graph.edges.map((edge) => {
                  const from = graph.nodes.find((node) => node.key === edge.fromNodeKey);
                  const to = graph.nodes.find((node) => node.key === edge.toNodeKey);
                  return from && to ? <path key={edge.key} class={selectedEdgeKey === edge.key ? 'on' : ''} d={edgePath(from, to)} /> : null;
                })}
              </svg>
              {graph.nodes.map((node) => (
                <button
                  key={node.key}
                  type="button"
                  data-node-key={node.key}
                  class={`wf-node kind-${node.kind} ${selectedNodeKey === node.key ? 'on' : ''}`}
                  style={{ left: node.positionX, top: node.positionY }}
                  aria-pressed={selectedNodeKey === node.key}
                  aria-label={t('workflow.nodeAria', { title: node.title, kind: t(`workflow.nodeKind.${node.kind}`) })}
                  onPointerDown={(event) => onNodePointerDown(event, node)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={() => { drag.current = null; }}
                  onPointerCancel={() => { drag.current = null; }}
                  onKeyDown={(event) => onNodeKeyDown(event, node)}
                >
                  <span class="wf-node-icon" aria-hidden="true">{nodeKindIcon(node.kind)}</span>
                  <span class="wf-node-copy"><strong>{node.title}</strong><small>{node.kind === 'agent' ? `${node.agent ?? '—'} · ${t(`workflow.mode.${node.executionMode}`)}` : t(`workflow.nodeKind.${node.kind}`)}</small></span>
                  <span class="wf-node-key mono">{node.key}</span>
                </button>
              ))}
            </div>
          </div>
          <p class="wf-keyboard-help">{t('workflow.keyboardHelp')}</p>
        </main>

        <aside class="wf-inspector" aria-label={t('workflow.inspector')}>
          <div class="wf-inspector-scroll">
            <section class="wf-fields">
              <h2>{t('workflow.templateDetails')}</h2>
              <label class="field">{t('workflow.name')}<input maxlength={80} value={name} onInput={(event) => setName(event.currentTarget.value)} /></label>
              <label class="field">{t('workflow.description')}<textarea rows={3} maxlength={500} value={description} onInput={(event) => setDescription(event.currentTarget.value)} /></label>
              <label class="field">{t('workflow.status')}<select value={status} onChange={(event) => setStatus(event.currentTarget.value as 'active' | 'archived')}><option value="active">{t('workflow.active')}</option><option value="archived">{t('workflow.archived')}</option></select></label>
              <label class="field">{t('workflow.loopLimit')}<input type="number" min={1} max={100} value={graph.maxLoopIterations} onInput={(event) => setGraph((current) => ({ ...current, maxLoopIterations: Number(event.currentTarget.value) }))} /></label>
            </section>

            {selectedNode && <section class="wf-fields">
              <div class="wf-section-title"><h2>{t('workflow.nodeDetails')}</h2><span class="badge b-amber">{t(`workflow.nodeKind.${selectedNode.kind}`)}</span></div>
              <label class="field">{t('workflow.nodeTitle')}<input maxlength={120} value={selectedNode.title} onInput={(event) => updateNode({ title: event.currentTarget.value })} /></label>
              {selectedNode.kind === 'agent' && <>
                <label class="field">{t('workflow.instructions')}<textarea rows={5} maxlength={8000} value={selectedNode.instructions ?? ''} onInput={(event) => updateNode({ instructions: event.currentTarget.value || null })} /></label>
                <label class="field">{t('workflow.agent')}<select value={selectedNode.agent ?? 'codex'} onChange={(event) => updateNode({ agent: event.currentTarget.value as AgentKind })}><option value="codex">{t('workflow.agentOptionCodex')}</option><option value="claude">{t('workflow.agentOptionClaude')}</option></select></label>
                <label class="field">{t('workflow.access')}<select value={selectedNode.executionMode} onChange={(event) => updateNode({ executionMode: event.currentTarget.value as 'read' | 'write' })}><option value="read">{t('workflow.mode.read')}</option><option value="write">{t('workflow.mode.write')}</option></select></label>
              </>}
              {selectedNode.kind === 'fork' && <label class="field">{t('workflow.joinTarget')}<select value={typeof selectedNode.config?.joinNodeKey === 'string' ? selectedNode.config.joinNodeKey : ''} onChange={(event) => updateNode({ config: { ...(selectedNode.config ?? {}), joinNodeKey: event.currentTarget.value } })}><option value="">{t('workflow.chooseJoin')}</option>{graph.nodes.filter((node) => node.kind === 'join').map((node) => <option value={node.key} key={node.key}>{node.title}</option>)}</select></label>}
              <label class="field">{t('workflow.maxVisits')}<input type="number" min={1} max={100} value={selectedNode.maxVisits} onInput={(event) => updateNode({ maxVisits: Number(event.currentTarget.value) })} /></label>
              <button class="btn danger" disabled={selectedNode.key === graph.entryNodeKey} onClick={deleteNode}>{t('workflow.deleteNode')}</button>
            </section>}

            <section class="wf-fields">
              <h2>{t('workflow.connections')}</h2>
              <div class="wf-connect-grid">
                <label class="field">{t('workflow.from')}<select value={connectFrom} onChange={(event) => setConnectFrom(event.currentTarget.value)}>{graph.nodes.map((node) => <option key={node.key} value={node.key}>{node.title}</option>)}</select></label>
                <label class="field">{t('workflow.to')}<select value={connectTo} onChange={(event) => setConnectTo(event.currentTarget.value)}>{graph.nodes.map((node) => <option key={node.key} value={node.key}>{node.title}</option>)}</select></label>
              </div>
              <button class="btn" onClick={addEdge}>{t('workflow.addConnection')}</button>
              <div class="wf-edge-list" aria-label={t('workflow.connectionList')}>
                {graph.edges.map((edge) => <button key={edge.key} class={selectedEdgeKey === edge.key ? 'on' : ''} aria-pressed={selectedEdgeKey === edge.key} aria-label={t('workflow.edgeAria', { from: edge.fromNodeKey, to: edge.toNodeKey, condition: edge.conditionText || t('workflow.unconditional') })} onClick={() => { setSelectedEdgeKey(edge.key); setSelectedNodeKey(''); }}><span>{edge.fromNodeKey} → {edge.toNodeKey}</span><small>{edge.conditionText || t('workflow.unconditional')}</small></button>)}
              </div>
              {selectedEdge && <div class="wf-edge-fields">
                <label class="field">{t('workflow.condition')}<textarea rows={3} maxlength={2000} value={selectedEdge.conditionText ?? ''} onInput={(event) => updateEdge({ conditionText: event.currentTarget.value || null })} /></label>
                <label class="chkrow"><input type="checkbox" checked={selectedEdge.isDefault} onChange={(event) => updateEdge({ isDefault: event.currentTarget.checked })} />{t('workflow.defaultConnection')}</label>
                <label class="field">{t('workflow.priority')}<input type="number" min={-10000} max={10000} value={selectedEdge.priority} onInput={(event) => updateEdge({ priority: Number(event.currentTarget.value) })} /></label>
                <button class="btn danger" onClick={deleteEdge}>{t('workflow.deleteConnection')}</button>
              </div>}
            </section>

            {(issues.length > 0 || error) && <section class="wf-errors" role="alert" aria-live="assertive">
              <h2>{t('workflow.structureErrors')}</h2>
              {error && <p>{error}</p>}
              {issues.length > 0 && <ul>{issues.map((item, index) => <li key={`${item.code}-${item.nodeKey ?? item.edgeKey ?? index}`}>{t('workflow.validationMessage', { message: t(workflowValidationKey(item.code), item.params), target: item.nodeKey ?? item.edgeKey ?? t('workflow.graphTarget') })}</li>)}</ul>}
            </section>}
          </div>
        </aside>
      </div>
    </div>
  );
}
