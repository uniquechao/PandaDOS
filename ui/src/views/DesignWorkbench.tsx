import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import {
  designEventLabelKey,
  graphRankLayout,
  graphSemanticRows,
  isCompletePublishConfirmation,
  LatestOnlyRequestGuard,
  mergeWorkbenchDesignTask,
  preferLatestDesignTask,
  reduceDesignMobilePane,
  TASK_10_CAPABILITIES,
  type DesignAssetView,
  type DesignAssetCapabilityView,
  type DesignCapabilities,
  type DesignEvent,
  type DesignFileDiff,
  type DesignFindingView,
  type DesignGraph,
  type DesignGraphGranularity,
  type DesignMobilePane,
  type DesignOutputTab,
  type DesignPublicationView,
  type DesignPublishConfirmationView,
  type DesignPersonaView,
  type DesignLinkedIssueView,
  type DesignReadinessSummary,
  type DesignRunMode,
  type DesignRunView,
  type DesignSyncView,
  type DesignTask,
  type DesignWorktreeView,
  type DesignWorkbenchView,
} from '../lib/design';
import { timeAgo } from '../lib/fmt';
import { nav } from '../lib/router';
import { AgentLogo } from '../components/AgentLogo';
import { Loading } from '../components/Loaders';
import { Modal } from '../components/Modal';
import { toast } from '../lib/toast';
import { useI18n } from '../i18n/provider';
import { DesignAssetsPanel } from './DesignAssetsPanel';
import { DesignPersonaPanel } from './DesignPersonaPanel';

type Inspector = 'readiness' | 'reviews' | 'delivery' | null;
const EMPTY_GRAPH: DesignGraph = { nodes: [], edges: [] };
const GRANULARITIES: DesignGraphGranularity[] = ['milestone', 'module', 'balanced', 'small', 'atomic'];
const DIMENSIONS = ['goal_clarity', 'scope_boundaries', 'solution_completeness', 'dependencies_constraints', 'acceptance_testability', 'risks_unknowns'] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function findingText(event: DesignEvent): { persona: string; text: string; severity: string } {
  const data = record(event.data);
  return {
    persona: typeof data?.persona === 'string' ? data.persona : '',
    text: typeof data?.summary === 'string' ? data.summary
      : typeof data?.message === 'string' ? data.message : '',
    severity: typeof data?.severity === 'string' ? data.severity : '',
  };
}

function eventMessage(event: DesignEvent): string | null {
  const data = record(event.data);
  for (const key of ['message', 'input', 'summary', 'feedback']) {
    if (typeof data?.[key] === 'string' && data[key]) return data[key] as string;
  }
  return null;
}

function DesignConversation({
  pid, did, task, events, run, personas, runModes, canManage, enabled, onRun, onRefresh,
}: {
  pid: number; did: number; task: DesignTask; events: DesignEvent[]; run: DesignRunView | null;
  personas: DesignPersonaView[]; runModes: DesignRunMode[]; canManage: boolean; enabled: boolean; onRun: (run: DesignRunView) => void; onRefresh: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<DesignRunMode>(runModes[0] ?? 'goal');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [selectedPersonas, setSelectedPersonas] = useState<string[]>([]);
  const runPollGuardRef = useRef(new LatestOnlyRequestGuard());
  useEffect(() => { if (!runModes.includes(mode) && runModes[0]) setMode(runModes[0]); }, [runModes.join('|'), mode]);
  const submit = async (): Promise<void> => {
    if (!canManage || !enabled || sending || !message.trim() || !runModes.includes(mode)) return;
    setSending(true);
    try {
      const result = await api<{ run: DesignRunView }>(
        `/api/projects/${pid}/designs/${did}/runs`, 'POST',
        { expectedRevision: task.currentRevision, mode, message: message.trim(), ...(selectedPersonas.length ? { personas: selectedPersonas } : {}) },
        { idempotencyKey: crypto.randomUUID() },
      );
      setMessage('');
      onRun(result.run);
      toast.success(t('design.runQueued'));
    } catch (cause) { toast.error(cause instanceof ApiError ? cause.message : t('design.loadFailed')); }
    finally { setSending(false); }
  };
  const retryRun = async (): Promise<void> => {
    if (!run || !canManage || !enabled || sending || !runModes.includes(run.mode)) return;
    setSending(true);
    try {
      const result = await api<{ run: DesignRunView }>(
        `/api/projects/${pid}/designs/${did}/runs`, 'POST',
        { expectedRevision: task.currentRevision, mode: run.mode, ...(run.personas.length ? { personas: run.personas } : {}) },
        { idempotencyKey: crypto.randomUUID() },
      );
      onRun(result.run); toast.success(t('design.runQueued'));
    } catch (cause) { toast.error(cause instanceof ApiError ? cause.message : t('design.loadFailed')); }
    finally { setSending(false); }
  };
  useEffect(() => {
    if (!run || !['queued', 'running'].includes(run.status)) return;
    const timer = window.setInterval(() => {
      const ticket = runPollGuardRef.current.begin();
      void api<{ run: DesignRunView }>(`/api/projects/${pid}/designs/${did}/runs/${run.id}`, 'GET', undefined, { signal: ticket.signal })
        .then((result) => {
          if (!runPollGuardRef.current.isCurrent(ticket)) return;
          onRun(result.run);
          if (!['queued', 'running'].includes(result.run.status)) onRefresh();
        }).catch(() => undefined);
    }, 1_500);
    return () => { window.clearInterval(timer); runPollGuardRef.current.invalidate(); };
  }, [run?.id, run?.status, pid, did]);
  return (
    <section class="design-conversation" aria-label={t('design.conversation')}>
      <div class="design-conversation-head"><div><span class="design-eyebrow">{t('design.goalCoach')}</span><h2>{t('design.conversation')}</h2></div><AgentLogo agent={task.agent} size="sm" /></div>
      <div class="design-messages" aria-live="polite">
        <article class="design-message user"><span class="design-message-author">{t('design.originalNeed')}</span><p>{task.originalRequest}</p></article>
        {events.map((event) => {
          const messageText = eventMessage(event);
          return messageText ? <article class={`design-message ${event.kind === 'input_appended' ? 'user' : 'coach'}`} key={event.id}><span class="design-message-author">{t(designEventLabelKey(event.kind))}</span><p>{messageText}</p><time>{timeAgo(event.ts)}</time></article>
            : <article class="design-event" key={event.id}><span class="design-event-dot" aria-hidden="true"/><span>{t(designEventLabelKey(event.kind))}</span><time>{timeAgo(event.ts)}</time></article>;
        })}
        {run && <div class={`design-run-state ${run.status}`}><strong>{t(`design.mode.${run.mode}`)}</strong><span>{t(`design.run.${run.status}`)}</span>{(run.status === 'interrupted' || run.status === 'failed') && <button class="btn" disabled={!runModes.includes(run.mode) || sending} onClick={() => void retryRun()}>{t('design.retryRun')}</button>}</div>}
      </div>
      <div class="design-composer-slot">
        <div class="design-mode-row" role="radiogroup" aria-label={t('design.runMode')}>{runModes.map((value) => <button type="button" role="radio" aria-checked={mode === value} class={mode === value ? 'on' : ''} onClick={() => setMode(value)}>{t(`design.mode.${value}`)}</button>)}</div>
        <details class="design-run-personas"><summary>{t('design.runPersonas')}</summary>{personas.filter((persona) => persona.enabled && persona.manifest.compatibleAgents.includes(task.agent)).map((persona) => <label><input type="checkbox" checked={selectedPersonas.includes(persona.key)} onChange={(event) => setSelectedPersonas((current) => event.currentTarget.checked ? [...current, persona.key] : current.filter((key) => key !== persona.key))}/>{persona.manifest.displayName}</label>)}</details>
        <textarea value={message} disabled={!canManage || !enabled || sending || runModes.length === 0} aria-label={t('design.message')} placeholder={enabled && runModes.length ? t('design.messagePlaceholder') : t('design.collaborationUnavailable')} onInput={(event) => setMessage(event.currentTarget.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit(); } }}/>
        <div class="design-composer-actions"><span>{t('design.sendShortcut')}</span><button class="btn primary" disabled={!message.trim() || !canManage || !enabled || sending || !runModes.includes(mode)} onClick={() => void submit()}>{sending ? t('design.sending') : t('design.send')}</button></div>
      </div>
    </section>
  );
}

function ReadinessInspector({ task, readiness, events, close }: { task: DesignTask; readiness: DesignReadinessSummary | null; events: DesignEvent[]; close: () => void }) {
  const { t } = useI18n();
  const latest = [...events].reverse().find((event) => event.kind === 'readiness_updated');
  const dimensions = readiness?.dimensions ?? (record(latest?.data)?.dimensions as DesignReadinessSummary['dimensions'] | undefined);
  const next = DIMENSIONS.flatMap((key) => dimensions?.[key]?.nextQuestions ?? [])[0];
  return <div class="design-inspector" aria-label={t('design.readiness')}><div class="design-inspector-head"><h3>{t('design.readiness')}</h3><button class="iconbtn" aria-label={t('design.closeInspector')} onClick={close}>×</button></div>
    <div class="design-readiness-total"><div class="design-readiness-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readiness?.score ?? 0}><span style={{ width: `${readiness?.score ?? 0}%` }}/></div><strong>{t('design.score', { score: readiness?.score ?? 0 })}</strong><span>{t('design.threshold', { threshold: readiness?.threshold ?? task.readinessThreshold })}</span></div>
    <div class="design-readiness-grid">{DIMENSIONS.map((key) => <div><span>{t(`design.dimension.${key}`)}</span><strong>{dimensions?.[key]?.score ?? 0}</strong>{dimensions?.[key]?.summary && <p>{dimensions[key]!.summary}</p>}{dimensions?.[key]?.evidence?.map((item) => <small>{item}</small>)}{dimensions?.[key]?.patch?.map((item) => <small class="design-patch">{item}</small>)}</div>)}</div>
    <div class="design-next-question"><span>{t('design.nextQuestion')}</span><p>{next ?? t('design.nextQuestionEmpty')}</p></div>
    {!!readiness?.blockers?.length && <section><h4>{t('design.blockers')}</h4><ul>{readiness.blockers.map((item) => <li>{item.message}</li>)}</ul></section>}
  </div>;
}

function GraphContract({ graph }: { graph: DesignGraph }) {
  const { t } = useI18n();
  return <ol class="design-graph-contract">{[...graph.nodes].sort((a, b) => a.ordinal - b.ordinal).map((node) => <li><h4>{node.ordinal + 1}. {node.title}</h4><div class="row"><span class="badge b-gray">{node.implMode === 'team' ? t('design.team') : t('design.direct')}</span><span>{t('design.module')}: {node.moduleId ?? t('design.none')}</span><span>{t('design.agent')}: {node.agent ?? t('design.none')}</span></div><p>{t('design.prerequisites')}: {(node.dependencies ?? graph.edges.filter((edge) => edge.toNodeId === node.nodeId).map((edge) => edge.fromNodeId)).join(' → ') || t('design.none')}</p>{([['acceptanceCriteria','design.acceptanceCriteria'],['testRecommendations','design.testRecommendations'],['evidenceRequirements','design.evidenceRequirements'],['blockers','design.blockers']] as const).map(([field, label]) => <section><strong>{t(label)}</strong><ul>{(node[field] ?? []).map((item) => <li>{item}</li>)}</ul></section>)}</li>)}</ol>;
}

function PublishConfirmationContract({ confirmation }: { confirmation: DesignPublishConfirmationView }) {
  const { t } = useI18n();
  return <div class="design-confirmation-contract">
    <div class="design-confirmation-identity"><span>{t('design.revision', { revision: confirmation.revision })}</span><code>{confirmation.graphDigest}</code></div>
    <section>
      <strong>{t('design.readinessSnapshot')}</strong>
      <p>{confirmation.readiness.score} / {confirmation.readiness.threshold} · {confirmation.readiness.override ? t('design.readinessOverrideActive') : t('design.readinessOverrideInactive')}</p>
    </section>
    <section><strong>{t('design.topologicalOrder')}</strong><p>{confirmation.topologicalOrder.join(' → ')}</p></section>
    <section><strong>{t('design.blockers')}</strong><ul>{confirmation.blockers.map((item) => <li>{item}</li>)}</ul></section>
    <ol class="design-graph-contract">{confirmation.orderedNodes.map((node, index) => <li key={node.nodeId}>
      <h4>{index + 1}. {node.title}</h4>
      <div class="row"><span class="badge b-gray">{node.implMode === 'team' ? t('design.team') : t('design.direct')}</span><span>{t('design.module')}: {node.resolvedModuleId ?? t('design.none')}</span><span>{t('design.agent')}: {node.resolvedAgent}</span></div>
      <p>{t('design.runtime')}: {node.runtime}</p>
      <p>{t('design.complexity')}: {t(`design.complexity.${node.complexity}`)}</p>
      <p>{t('design.prerequisites')}: {(node.dependencies ?? confirmation.dependencies.filter((edge) => edge.toNodeId === node.nodeId).map((edge) => edge.fromNodeId)).join(' → ') || t('design.none')}</p>
      {node.goal && <p>{node.goal}</p>}
      {([['scope','design.scope'],['nonGoals','design.nonGoals'],['inputs','design.inputs'],['outputs','design.outputs'],['implementationNotes','design.implementationNotes'],['complexityRationale','design.complexityRationale'],['acceptanceCriteria','design.acceptanceCriteria'],['testRecommendations','design.testRecommendations'],['evidenceRequirements','design.evidenceRequirements'],['completionInstructions','design.completionInstructions']] as const).map(([field, label]) => <section><strong>{t(label)}</strong><ul>{node[field].map((item) => <li>{item}</li>)}</ul></section>)}
      <p><strong>{t('design.bodyDigest')}</strong> <code>{node.bodyDigest}</code></p>
    </li>)}</ol>
  </div>;
}

function DesignDag({ graph, linkedIssues, pid }: { graph: DesignGraph; linkedIssues: Record<string, DesignLinkedIssueView>; pid: number }) {
  const { t } = useI18n();
  const layout = useMemo(() => graphRankLayout(graph), [graph]);
  const positions = new Map(layout.nodes.map((node) => [node.nodeId, node]));
  return <div class="design-dag-scroll"><div class="design-dag" style={{ minWidth: `${layout.width}px`, height: `${layout.height}px` }}>
    <svg class="design-dag-edges" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true" preserveAspectRatio="none">
      <defs><marker id="design-dag-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z"/></marker></defs>
      {graph.edges.map((edge) => { const from = positions.get(edge.fromNodeId); const to = positions.get(edge.toNodeId); return from && to ? <path d={`M ${from.x + 196} ${from.y + 36} C ${from.x + 218} ${from.y + 36}, ${to.x - 22} ${to.y + 36}, ${to.x} ${to.y + 36}`} marker-end="url(#design-dag-arrow)"/> : null; })}
    </svg>
    {layout.nodes.map((position) => { const node = graph.nodes.find((item) => item.nodeId === position.nodeId)!; const linked = linkedIssues[node.nodeId]; return <article class={`design-dag-node ${linked?.status ?? 'draft'}`} style={{ left: `${position.x}px`, top: `${position.y}px` }}>
      <span class="design-dag-rank">{position.rank + 1}</span><strong>{node.title}</strong>
      <span>{node.implMode === 'team' ? t('design.team') : t('design.direct')}</span>
      {linked ? <button class="linkbtn" onClick={() => nav(`/p/${pid}/issue/${linked.issueId}`)}>{t('design.issueStatus')}: {linked.status}</button> : <span>{t('design.graphDraftStatus')}</span>}
    </article>; })}
  </div></div>;
}

function OutputTabs({
  pid, did, task, graph, readiness, events, tab, onTab, canManage, capabilities,
  publications, syncs, worktree, files, assets, assetCapability, findings, linkedIssues, personas,
  run, runModes, sensitiveEpoch, onRun, onTask, onRefresh,
}: {
  pid: number; did: number; task: DesignTask; graph: DesignGraph; readiness: DesignReadinessSummary | null; events: DesignEvent[];
  tab: DesignOutputTab; onTab: (tab: DesignOutputTab) => void; canManage: boolean; capabilities: DesignCapabilities;
  publications: DesignPublicationView[]; syncs: DesignSyncView[]; worktree: DesignWorktreeView | null; files: DesignFileDiff | null; assets: DesignAssetView[]; assetCapability: DesignAssetCapabilityView | null; findings: DesignFindingView[]; linkedIssues: Record<string, DesignLinkedIssueView>; personas: DesignPersonaView[];
  run: DesignRunView | null; runModes: DesignRunMode[]; sensitiveEpoch: number; onRun: (run: DesignRunView) => void; onTask: (task: DesignTask) => void; onRefresh: () => void;
}) {
  const { t } = useI18n();
  const [inspector, setInspector] = useState<Inspector>(null);
  const [granularity, setGranularity] = useState<DesignGraphGranularity>(task.graphGranularity);
  const [publishPreview, setPublishPreview] = useState<(DesignPublishConfirmationView & { publishKey: string; workspaceKey: string }) | null>(null);
  const [executionMode, setExecutionMode] = useState<'current' | 'worktree'>('current');
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [baseRef, setBaseRef] = useState('');
  const [busy, setBusy] = useState('');
  const rows = useMemo(() => graphSemanticRows(graph), [graph]);
  useEffect(() => { setPublishPreview(null); }, [task.currentRevision, sensitiveEpoch]);
  const eventFindings = events.filter((event) => event.kind === 'finding_appended');
  const publishedIssues = Object.values(linkedIssues);
  const canCompleteExecution = publishedIssues.length > 0
    && publishedIssues.every((issue) => issue.status === 'done' || issue.status === 'cancelled');
  const action = async (name: string, operation: () => Promise<unknown>): Promise<void> => {
    if (busy) return; setBusy(name);
    try { await operation(); onRefresh(); toast.success(t('ui.saved')); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : t('design.loadFailed')); }
    finally { setBusy(''); }
  };
  const requestPreview = () => void action('preview', async () => {
    const result = await api<{ confirmation: unknown }>(`/api/projects/${pid}/designs/${did}/graph/publish-confirmation`, 'POST', { expectedRevision: task.currentRevision });
    if (!isCompletePublishConfirmation(result.confirmation)) throw new Error(t('design.publishSnapshotIncomplete'));
    setPublishPreview({ ...result.confirmation, publishKey: crypto.randomUUID(), workspaceKey: crypto.randomUUID() });
  });
  const approveGraph = () => void action('approve', async () => {
    const result = await api<{ design: DesignTask }>(`/api/projects/${pid}/designs/${did}/approve-graph`, 'POST', { expectedRevision: task.currentRevision, readiness: readiness?.approvalInput ?? {} });
    onTask(result.design); setApprovalOpen(false);
  });
  const persistGranularity = (value: DesignGraphGranularity) => void action('granularity', async () => {
    const graphRunKey = crypto.randomUUID();
    const result = await api<{ design: DesignTask }>(`/api/projects/${pid}/designs/${did}/granularity`, 'PATCH', { expectedRevision: task.currentRevision, granularity: value });
    setGranularity(result.design.graphGranularity); onTask(result.design);
    const started = await api<{ run: DesignRunView }>(`/api/projects/${pid}/designs/${did}/runs`, 'POST', { expectedRevision: result.design.currentRevision, mode: 'graph' }, { idempotencyKey: graphRunKey });
    onRun(started.run);
  });
  const decideSync = (sync: DesignSyncView, decision: 'apply' | 'ignore' | 'supplement') => { if (sync.executionSyncId === null) return; void action(`sync-${sync.linkId}`, () => api(`/api/projects/${pid}/designs/${did}/syncs/${sync.executionSyncId}/${decision}`, 'POST', { expectedRevision: task.currentRevision }, decision === 'supplement' ? { idempotencyKey: crypto.randomUUID() } : undefined)); };
  const worktreeAction = (kind: 'inspect' | 'execute') => {
    if (!worktree?.publicationId) return;
    void action(kind, async () => {
      await api(`/api/projects/${pid}/designs/${did}/worktree/${kind}`, 'POST', { publicationId: worktree.publicationId, expectedRevision: worktree.revision, graphDigest: worktree.graphDigest });
      if (kind === 'execute' && task.stage === 'approved') {
        await api(`/api/projects/${pid}/designs/${did}/start-execution`, 'POST', { expectedRevision: task.currentRevision });
      }
    });
  };
  const completeExecution = () => void action('complete-execution', () => api(
    `/api/projects/${pid}/designs/${did}/complete-execution`,
    'POST',
    { expectedRevision: task.currentRevision },
  ));
  const resolveRecovery = (sync: DesignSyncView, resolution: 'confirm_delivered' | 'retry') => {
    if (sync.executionSyncId === null) return;
    void action(`recovery-${sync.linkId}`, () => api(`/api/projects/${pid}/designs/${did}/syncs/${sync.executionSyncId}/recovery`, 'POST', { expectedRevision: task.currentRevision, resolution }));
  };
  const confirmPublication = async (): Promise<void> => {
    if (!publishPreview) return;
    await action('publish', async () => {
      if (!worktree) {
        await api(`/api/projects/${pid}/designs/${did}/worktree`, 'POST', {
          expectedRevision: publishPreview.revision,
          graphDigest: publishPreview.graphDigest,
          executionMode,
          ...(executionMode === 'worktree' ? { baseRef: baseRef.trim() } : {}),
        }, { idempotencyKey: publishPreview.workspaceKey });
      }
      await api(`/api/projects/${pid}/designs/${did}/graph/publish`, 'POST', {
        expectedRevision: publishPreview.revision,
        confirmationToken: publishPreview.token,
      }, { idempotencyKey: publishPreview.publishKey });
      setPublishPreview(null);
    });
  };
  return <section class="design-output" aria-label={t('design.output')}>
    <div class="design-output-head"><div class="design-output-tabs" role="tablist">{(['document','graph','assets'] as const).map((value) => <button role="tab" aria-selected={tab === value} class={tab === value ? 'on' : ''} onClick={() => { setInspector(null); onTab(value); }}>{t(`design.${value}`)}</button>)}</div>
      <div class="design-output-tools"><button data-inspector="readiness" class={inspector === 'readiness' ? 'design-tool on' : 'design-tool'} aria-pressed={inspector === 'readiness'} onClick={() => setInspector(inspector === 'readiness' ? null : 'readiness')}>{t('design.readiness')} · {readiness?.score ?? 0}</button><button data-inspector="reviews" class={inspector === 'reviews' ? 'design-tool on' : 'design-tool'} aria-pressed={inspector === 'reviews'} onClick={() => setInspector(inspector === 'reviews' ? null : 'reviews')}>{t('design.reviews')} · {findings.length || eventFindings.length}</button><button data-inspector="delivery" class={inspector === 'delivery' ? 'design-tool on' : 'design-tool'} aria-pressed={inspector === 'delivery'} onClick={() => setInspector(inspector === 'delivery' ? null : 'delivery')}>{t('design.delivery')}</button></div></div>
    {inspector === 'readiness' ? <ReadinessInspector task={task} readiness={readiness} events={events} close={() => setInspector(null)}/>
      : inspector === 'reviews' ? <div class="design-inspector"><div class="design-inspector-head"><h3>{t('design.reviews')}</h3><button class="iconbtn" aria-label={t('design.closeInspector')} onClick={() => setInspector(null)}>×</button></div>{findings.length ? findings.map((item) => <article class="design-finding"><div><strong>{item.persona}</strong><span class="badge b-gray">{item.severity}</span></div><p>{item.finding}</p>{item.evidence?.map((entry) => <small>{entry}</small>)}{item.patch?.map((entry) => <small class="design-patch">{entry}</small>)}</article>) : eventFindings.length === 0 ? <p class="mut">{t('design.reviewEmpty')}</p> : eventFindings.map((event) => { const item = findingText(event); return <article class="design-finding"><div><strong>{item.persona || t('design.reviews')}</strong>{item.severity && <span class="badge b-gray">{item.severity}</span>}</div><p>{item.text || t(designEventLabelKey(event.kind))}</p></article>; })}<DesignPersonaPanel pid={pid} personas={personas} canManage={canManage} onRefresh={onRefresh}/></div>
      : inspector === 'delivery' ? <div class="design-inspector design-delivery"><div class="design-inspector-head"><h3>{t('design.delivery')}</h3><button class="iconbtn" aria-label={t('design.closeInspector')} onClick={() => setInspector(null)}>×</button></div>
        <section><h4>{t('design.worktree')}</h4><p>{worktree ? `${worktree.executionMode} · ${worktree.lifecycleState}` : t('design.workspaceChoice')}</p>{worktree && <div class="row"><button class="btn" onClick={() => worktreeAction('inspect')}>{t('design.inspect')}</button>{task.stage === 'executing' ? <button class="btn primary" disabled={!canCompleteExecution || busy === 'complete-execution'} onClick={completeExecution}>{t('design.event.execution_completed')}</button> : task.stage === 'approved' ? <button class="btn primary" disabled={!worktree.publicationId} onClick={() => worktreeAction('execute')}>{t('design.execute')}</button> : null}</div>}</section>
        <section><h4>{t('design.files')}</h4>{files?.files.length ? files.files.map((file) => <div class="design-file-row"><code>{file.path}</code><span class={`badge ${file.classification === 'conflict' ? 'b-red' : 'b-gray'}`}>{file.classification}</span></div>) : <p class="mut">{t('design.noChanges')}</p>}{canManage && files && !files.conflictToken && <button class="btn primary" onClick={() => void action('publish-files', () => api(`/api/projects/${pid}/designs/${did}/publish-files`, 'POST', { expectedRevision: task.currentRevision }))}>{t('design.publishFiles')}</button>}{files?.conflictToken && canManage && <button class="btn" onClick={() => void action('overwrite', () => api(`/api/projects/${pid}/designs/${did}/publish-files`, 'POST', { expectedRevision: task.currentRevision, resolution: 'overwrite', conflictToken: files.conflictToken }))}>{t('design.overwrite')}</button>}</section>
      </div>
      : tab === 'document' ? <div class="design-document" role="tabpanel"><div class="design-document-meta"><span>{t('design.revision', { revision: task.currentRevision })}</span><span>{t('design.documentHelp')}</span></div>{task.documentMarkdown ? <pre>{task.documentMarkdown}</pre> : <div class="design-output-empty"><strong>{t('design.documentEmpty')}</strong></div>}</div>
      : tab === 'graph' ? <div class="design-graph-list" role="tabpanel"><div class="design-graph-toolbar"><label>{t('design.granularity')}<select value={granularity} disabled={!canManage || !!busy || !runModes.includes('graph')} onChange={(event) => persistGranularity(event.currentTarget.value as DesignGraphGranularity)}>{GRANULARITIES.map((value) => <option value={value}>{t(`design.granularity.${value}`)}</option>)}</select></label>{(busy === 'granularity' || (run?.mode === 'graph' && (run.status === 'queued' || run.status === 'running'))) && <span class="design-redecomposing" aria-live="polite">{t('design.redecomposing')}</span>}{task.stage !== 'approved' && <button class="btn primary" disabled={!canManage || graph.nodes.length === 0} onClick={() => setApprovalOpen(true)}>{t('design.approveGraph')}</button>}<button class="btn primary" disabled={!canManage || !capabilities.issuePublish || task.stage !== 'approved'} onClick={requestPreview}>{t('design.publishIssues')}</button></div>
        {rows.length === 0 ? <div class="design-output-empty">{t('design.graphEmpty')}</div> : <><DesignDag graph={graph} linkedIssues={linkedIssues} pid={pid}/><ol class="design-graph-semantic">{rows.map((row, index) => { const node = graph.nodes.find((item) => item.nodeId === row.nodeId); const linked = linkedIssues[row.nodeId]; const dirty = node?.lastSyncedRevision !== null && node?.lastSyncedRevision !== task.currentRevision; return <li><span class="design-graph-index">{index + 1}</span><div><strong>{row.title}</strong><p>{t('design.prerequisites')}: {row.prerequisiteTitles.join(' → ') || t('design.none')}</p><div class="row"><span class="badge b-gray">{node?.implMode === 'team' ? t('design.team') : t('design.direct')}</span>{linked && <span class="badge b-blue">{t('design.issueStatus')}: {linked.status}</span>}{linked && <span class="badge b-gray">{linked.syncState}</span>}{dirty && <span class="badge b-amber">{t('design.syncPending')}</span>}{linked && <button class="linkbtn" onClick={() => nav(`/p/${pid}/issue/${linked.issueId}`)}>{t('design.openIssue', { id: linked.issueId })}</button>}</div></div></li>; })}</ol></>}
        {syncs.map((sync) => <section class="design-sync-row" data-link-id={sync.linkId}><div><strong>{sync.nodeId}</strong><span class="badge b-amber">{sync.decisionState ?? t('design.syncPending')}</span></div>{sync.fields.filter((field) => field.kind !== 'unchanged').map((field) => <details><summary>{field.field} · {field.kind}</summary><div class="design-three-way"><pre>{JSON.stringify(field.base, null, 2)}</pre><pre>{JSON.stringify(field.local, null, 2)}</pre><pre>{JSON.stringify(field.incoming, null, 2)}</pre></div></details>)}{canManage && sync.executionSyncId !== null && sync.recovery?.resolutionRequired ? <div class="row"><button class="btn" onClick={() => resolveRecovery(sync, 'confirm_delivered')}>{t('design.confirmDelivered')}</button><button class="btn" onClick={() => resolveRecovery(sync, 'retry')}>{t('design.retrySync')}</button></div> : canManage && sync.executionSyncId !== null && <div class="row"><button class="btn" onClick={() => decideSync(sync, 'apply')}>{t('design.apply')}</button><button class="btn" onClick={() => decideSync(sync, 'ignore')}>{t('design.ignore')}</button><button class="btn" onClick={() => decideSync(sync, 'supplement')}>{t('design.supplement')}</button></div>}</section>)}
      </div>
      : (
        <DesignAssetsPanel
          pid={pid}
          did={did}
          task={task}
          canManage={canManage}
          capability={assetCapability}
          assets={assets}
          onRefresh={onRefresh}
        />
      )}
    {approvalOpen && <Modal wide title={t('design.approveGraph')} onClose={() => setApprovalOpen(false)}><div class="design-approval"><p>{t('design.approveGraphHelp')}</p><GraphContract graph={graph}/>{!!readiness?.blockers?.length && <section><h4>{t('design.blockers')}</h4><ul>{readiness.blockers.map((item) => <li>{item.message}</li>)}</ul></section>}<div class="form-actions"><button class="btn" onClick={() => setApprovalOpen(false)}>{t('common.cancel')}</button><button class="btn primary" disabled={!!busy || !!readiness?.blockers?.length} onClick={approveGraph}>{t('design.confirmApproveGraph')}</button></div></div></Modal>}
    {publishPreview && <Modal wide title={t('design.publishPreview')} onClose={() => setPublishPreview(null)}><div class="design-publish-preview"><p>{t('design.publishPreviewHelp')}</p><PublishConfirmationContract confirmation={publishPreview}/>{!worktree && <fieldset><legend>{t('design.workspaceChoice')}</legend><label><input type="radio" name="execution-mode" checked={executionMode === 'current'} onChange={() => setExecutionMode('current')}/>{t('design.currentWorkspace')}</label><label><input type="radio" name="execution-mode" checked={executionMode === 'worktree'} onChange={() => setExecutionMode('worktree')}/>{t('design.createWorktree')}</label>{executionMode === 'worktree' && <label>{t('design.baseRef')}<input value={baseRef} onInput={(event) => setBaseRef(event.currentTarget.value)}/></label>}</fieldset>}<div class="form-actions"><button class="btn" onClick={() => setPublishPreview(null)}>{t('common.cancel')}</button><button class="btn primary" disabled={busy === 'publish' || (executionMode === 'worktree' && !worktree && !baseRef.trim())} onClick={() => void confirmPublication()}>{t('design.confirmPublish')}</button></div></div></Modal>}
  </section>;
}

export function DesignWorkbench({ pid, did, task: baseline, wide, canManage, capabilities: declared = TASK_10_CAPABILITIES, onTask }: { pid: number; did: number; task: DesignTask; wide: boolean; canManage: boolean; capabilities?: DesignCapabilities; onTask: (task: DesignTask) => void }) {
  const { t } = useI18n();
  const [task, setTask] = useState(baseline); const [events, setEvents] = useState<DesignEvent[]>([]); const [graph, setGraph] = useState<DesignGraph>(EMPTY_GRAPH); const [readiness, setReadiness] = useState<DesignReadinessSummary | null>(null);
  const [findings, setFindings] = useState<DesignFindingView[]>([]); const [linkedIssues, setLinkedIssues] = useState<Record<string, DesignLinkedIssueView>>({}); const [personas, setPersonas] = useState<DesignPersonaView[]>([]);
  const [run, setRun] = useState<DesignRunView | null>(null); const [publications, setPublications] = useState<DesignPublicationView[]>([]); const [syncs, setSyncs] = useState<DesignSyncView[]>([]); const [worktree, setWorktree] = useState<DesignWorktreeView | null>(null); const [files, setFiles] = useState<DesignFileDiff | null>(null); const [assets, setAssets] = useState<DesignAssetView[]>([]); const [assetCapability, setAssetCapability] = useState<DesignAssetCapabilityView | null>(null);
  const [capabilities, setCapabilities] = useState<DesignCapabilities>(declared); const [runModes, setRunModes] = useState<DesignRunMode[]>([]); const [sensitiveEpoch, setSensitiveEpoch] = useState(0); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [tab, setTab] = useState<DesignOutputTab>('document'); const [mobilePane, setMobilePane] = useState<DesignMobilePane>({ kind: 'conversation' }); const refreshGuardRef = useRef(new LatestOnlyRequestGuard()); const refreshRef = useRef<() => void>(() => undefined); const taskRevisionRef = useRef(baseline.currentRevision); const taskRef = useRef(baseline);
  useEffect(() => { if (baseline.currentRevision > taskRevisionRef.current) refreshGuardRef.current.invalidate(); setTask((current) => { const next = preferLatestDesignTask(current, baseline); taskRef.current = next; return next; }); taskRevisionRef.current = Math.max(taskRevisionRef.current, baseline.currentRevision); }, [baseline]);
  useEffect(() => { taskRef.current = task; }, [task]);
  useEffect(() => { setFiles(null); setSensitiveEpoch((value) => value + 1); }, [task.currentRevision]);
  useEffect(() => {
    let active = true;
    const refresh = (initial = false) => { const ticket = refreshGuardRef.current.begin(); const core = Promise.all([
      api<{ workbench: DesignWorkbenchView }>(`/api/projects/${pid}/designs/${did}/workbench`, 'GET', undefined, { signal: ticket.signal }).then((response) => { const view = response.workbench; if (active && refreshGuardRef.current.isCurrent(ticket)) setRunModes(view.capabilities.runModes); return { ...view, design: mergeWorkbenchDesignTask(taskRef.current, view.design, view.revision) }; }), api<{ events: DesignEvent[] }>(`/api/projects/${pid}/designs/${did}/events`, 'GET', undefined, { signal: ticket.signal }),
    ]).catch((cause) => { if (active && refreshGuardRef.current.isCurrent(ticket)) { setFiles(null); setSensitiveEpoch((value) => value + 1); } throw cause; }); const optional = Promise.allSettled([
      api<{ publications: DesignPublicationView[] }>(`/api/projects/${pid}/designs/${did}/publications`, 'GET', undefined, { signal: ticket.signal }),
      api<{ syncs: DesignSyncView[] }>(`/api/projects/${pid}/designs/${did}/syncs`, 'GET', undefined, { signal: ticket.signal }),
      api<{ worktree: DesignWorktreeView | null }>(`/api/projects/${pid}/designs/${did}/worktree`, 'GET', undefined, { signal: ticket.signal }),
      api<{ diff: DesignFileDiff }>(`/api/projects/${pid}/designs/${did}/file-diff?expectedRevision=${taskRevisionRef.current}`, 'GET', undefined, { signal: ticket.signal }).catch((cause) => { if (active && refreshGuardRef.current.isCurrent(ticket)) { setFiles(null); setSensitiveEpoch((value) => value + 1); } throw cause; }),
      api<{ assets: DesignAssetView[] }>(`/api/projects/${pid}/designs/${did}/assets`, 'GET', undefined, { signal: ticket.signal }),
      api<{ capability: DesignAssetCapabilityView }>(`/api/projects/${pid}/designs/${did}/assets/capability`, 'GET', undefined, { signal: ticket.signal }),
      api<{ personas: DesignPersonaView[] }>(`/api/projects/${pid}/personas`, 'GET', undefined, { signal: ticket.signal }),
    ]); Promise.all([core, optional]).then(([[view, eventResult], extras]) => { if (!active || !refreshGuardRef.current.isCurrent(ticket)) return; taskRevisionRef.current = view.design.currentRevision; setTask((current) => preferLatestDesignTask(current, view.design)); onTask(view.design); setEvents(eventResult.events); setGraph(view.graph); const dimensionMap = Object.fromEntries(view.readinessReport.dimensions.map((item) => [item.dimension, { score: item.score, evidence: item.evidencePaths, patch: item.missingItems, nextQuestions: item.nextQuestions }])); setReadiness({ score: view.readinessReport.aggregate, threshold: view.readinessReport.threshold, override: view.readinessReport.override, revision: view.design.currentRevision, dimensions: dimensionMap, blockers: view.readinessReport.hardBlockers, approvalInput: { threshold: view.readinessReport.threshold, dimensions: Object.fromEntries(view.readinessReport.dimensions.map((item) => [item.dimension, { score: item.score, evidencePaths: item.evidencePaths, missingItems: item.missingItems, nextQuestions: item.nextQuestions }])), hardBlockers: view.readinessReport.hardBlockers } }); setFindings(view.findings.map((item) => ({ id: item.eventId, persona: item.persona, severity: item.severity, finding: item.finding, evidence: item.evidence, patch: item.proposedPatch == null ? [] : [JSON.stringify(item.proposedPatch)] }))); setLinkedIssues(Object.fromEntries(view.linkedIssues.map((item) => [item.nodeId, item]))); if (extras[6].status === 'fulfilled') setPersonas(extras[6].value.personas); if (view.latestRun) setRun((current) => !current || view.latestRun!.updatedTs >= current.updatedTs ? view.latestRun! : current); if (extras[0].status === 'fulfilled') setPublications(extras[0].value.publications); if (extras[1].status === 'fulfilled') setSyncs(extras[1].value.syncs); if (extras[2].status === 'fulfilled') setWorktree(extras[2].value.worktree); if (extras[3].status === 'fulfilled' && extras[3].value.diff.revision === view.design.currentRevision) setFiles(extras[3].value.diff); if (extras[4].status === 'fulfilled') setAssets(extras[4].value.assets); if (extras[5].status === 'fulfilled') setAssetCapability(extras[5].value.capability); setCapabilities({ designWs: declared.designWs, issuePublish: extras[0].status === 'fulfilled', visualAssets: extras[5].status === 'fulfilled' && extras[5].value.capability.enabled }); setError(''); }).catch((cause) => { if (active && initial) setError(cause instanceof ApiError ? cause.message : t('design.loadFailed')); }).finally(() => { if (active && initial) setLoading(false); }); };
    refreshRef.current = () => refresh(false); refresh(true); const timer = window.setInterval(() => refresh(false), 5_000); return () => { active = false; window.clearInterval(timer); refreshGuardRef.current.invalidate(); };
  }, [pid, did]);
  const selectOutput = (next: DesignOutputTab) => { setTab(next); setMobilePane((state) => reduceDesignMobilePane(state, { type: 'show-output', tab: next })); };
  if (loading) return <div class="design-workbench-state"><Loading/></div>; if (error) return <div class="design-workbench-state error">{error}</div>;
  const updateTask = (next: DesignTask) => { if (next.currentRevision !== taskRevisionRef.current) { refreshGuardRef.current.invalidate(); setFiles(null); setSensitiveEpoch((value) => value + 1); } taskRevisionRef.current = next.currentRevision; taskRef.current = next; setTask(next); onTask(next); };
  const conversation = <DesignConversation pid={pid} did={did} task={task} events={events} run={run} personas={personas} runModes={runModes} canManage={canManage} enabled={capabilities.designWs} onRun={setRun} onRefresh={() => refreshRef.current()}/>;
  const output = <OutputTabs pid={pid} did={did} task={task} graph={graph} readiness={readiness} events={events} tab={tab} onTab={selectOutput} canManage={canManage} capabilities={capabilities} publications={publications} syncs={syncs} worktree={worktree} files={files} assets={assets} assetCapability={assetCapability} findings={findings} linkedIssues={linkedIssues} personas={personas} run={run} runModes={runModes} sensitiveEpoch={sensitiveEpoch} onRun={setRun} onTask={updateTask} onRefresh={() => refreshRef.current()}/>;
  return <div class={wide ? 'design-workbench wide' : 'design-workbench narrow'}>{!wide && <div class="design-mobile-switch" role="tablist"><button role="tab" aria-selected={mobilePane.kind === 'conversation'} class={mobilePane.kind === 'conversation' ? 'on' : ''} onClick={() => setMobilePane({ kind: 'conversation' })}>{t('design.conversation')}</button><button role="tab" aria-selected={mobilePane.kind === 'output'} class={mobilePane.kind === 'output' ? 'on' : ''} onClick={() => setMobilePane({ kind: 'output', tab })}>{t('design.output')}</button></div>}{wide ? <>{conversation}{output}</> : mobilePane.kind === 'conversation' ? conversation : output}</div>;
}
