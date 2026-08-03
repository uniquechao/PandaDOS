import { useEffect, useState } from 'preact/hooks';
import { AutoApproveSwitch } from '../components/AutoApproveSwitch';
import { IssueGitBranchFields } from '../components/IssueGitBranchFields';
import { Modal } from '../components/Modal';
import { ModuleSelect } from '../components/ModuleSelect';
import { useI18n } from '../i18n/provider';
import { api, ApiError, getProjectExecutorAgents } from '../lib/api';
import { issueGitBranchPayload, type IssueGitBranchValue } from '../lib/issuegitbranch';
import { readNewIssueAutoApprove, writeNewIssueAutoApprove } from '../lib/newIssuePrefs';
import { nav } from '../lib/router';
import { toast } from '../lib/toast';
import type {
  AgentKind,
  AutoApproveLevel,
  ExternalIssueCandidate,
  ExternalIssueSourceSummary,
  IssueCategory,
  Project,
  ProjectModule,
} from '../lib/types';
import { reconcileAgent } from '../components/AgentPicker';

const PROVIDER_LABEL = { github: 'GitHub', gitlab: 'GitLab' } as const;

export interface ExternalIssueImportForm {
  title: string;
  body: string;
  category: IssueCategory;
  module: string;
  agent: AgentKind;
  autoApprove: AutoApproveLevel;
  gitBranch: IssueGitBranchValue;
}

export function externalIssueIdentity(candidate: ExternalIssueCandidate): Record<string, string> {
  return {
    externalId: candidate.externalId,
    externalNumber: candidate.externalNumber,
    externalUrl: candidate.url,
  };
}

export function externalIssueImportPayload(
  candidate: ExternalIssueCandidate,
  form: ExternalIssueImportForm,
  modules: ProjectModule[],
): Record<string, unknown> {
  const selectedModule = modules.find(
    (module) => module.slug === form.module.trim() || module.displayName === form.module.trim(),
  );
  return {
    ...externalIssueIdentity(candidate),
    title: form.title.trim(),
    body: form.body,
    category: form.category,
    ...(selectedModule
      ? { moduleId: selectedModule.id }
      : form.module.trim()
        ? { moduleName: form.module.trim() }
        : {}),
    agent: selectedModule?.agent ?? form.agent,
    autoApprove: form.autoApprove,
    ...issueGitBranchPayload(form.gitBranch),
  };
}

function ImportModal({
  pid,
  candidate,
  modules,
  supportedAgents,
  onClose,
  onImported,
}: {
  pid: number;
  candidate: ExternalIssueCandidate;
  modules: ProjectModule[];
  supportedAgents: AgentKind[];
  onClose: () => void;
  onImported: (candidate: ExternalIssueCandidate, localIssueId: number) => void;
}) {
  const { t } = useI18n();
  const initialAgent = supportedAgents[0] ?? 'claude';
  const [form, setForm] = useState<ExternalIssueImportForm>({
    title: candidate.title,
    body: candidate.body,
    category: 'task',
    module: '',
    agent: initialAgent,
    autoApprove: readNewIssueAutoApprove(),
    gitBranch: { targetBranch: '', sourceRef: '' },
  });
  const [gitLoading, setGitLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectedModule = modules.find(
    (module) => module.slug === form.module.trim() || module.displayName === form.module.trim(),
  );
  const effectiveAgent = selectedModule?.agent ?? form.agent;
  const agentUnavailable = !supportedAgents.includes(effectiveAgent);

  useEffect(() => {
    const next = reconcileAgent(form.agent, supportedAgents);
    if (next) setForm((current) => ({ ...current, agent: next }));
  }, [supportedAgents]);

  const submit = async (): Promise<void> => {
    if (!form.title.trim() || busy || gitLoading || agentUnavailable) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ issue: { id: number } }>(
        `/api/projects/${pid}/external-issues/import`,
        'POST',
        externalIssueImportPayload(candidate, form, modules),
      );
      writeNewIssueAutoApprove(form.autoApprove);
      onImported(candidate, result.issue.id);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal title={t('externalImport.edit')} wide onClose={onClose}>
      <div class="formcol">
        <div class="ei-modal-source">
          <span class="badge b-gray">{PROVIDER_LABEL[candidate.provider]} #{candidate.externalNumber}</span>
          <a href={candidate.url} target="_blank" rel="noreferrer">{t('externalImport.openRemote')}</a>
        </div>
        <label class="field">{t('board.title')}<input value={form.title} onInput={(event) => setForm((current) => ({ ...current, title: event.currentTarget.value }))} /></label>
        <label class="field">{t('board.detailsOptional')}<textarea rows={7} value={form.body} onInput={(event) => setForm((current) => ({ ...current, body: event.currentTarget.value }))} /></label>
        <div class="row ei-form-row">
          <label class="field grow">{t('board.category')}<select value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.currentTarget.value as IssueCategory }))}><option value="task">{t('status.categoryTask')}</option><option value="design">{t('status.categoryDesign')}</option><option value="debug">DEBUG</option></select></label>
          <label class="field grow">{t('board.moduleOptional')}<ModuleSelect modules={modules} value={form.module} placeholder={t('board.autoModule')} onChange={(module) => {
            const selected = modules.find((item) => item.slug === module.trim() || item.displayName === module.trim());
            setForm((current) => ({ ...current, module, ...(selected ? { agent: selected.agent } : {}) }));
          }} /></label>
        </div>
        <label class="field">{t('board.agent')}<select value={effectiveAgent} disabled={Boolean(selectedModule)} onChange={(event) => setForm((current) => ({ ...current, agent: event.currentTarget.value as AgentKind }))}>{supportedAgents.map((agent) => <option key={agent} value={agent}>{agent === 'claude' ? 'Claude Code' : 'Codex'}</option>)}</select>{selectedModule && <span class="mut small">{t('board.moduleAgent', { agent: selectedModule.agent })}</span>}{agentUnavailable && <span class="err small">{t('board.agentUnavailable')}</span>}</label>
        <div class="nia-aa"><AutoApproveSwitch level={form.autoApprove} onChange={(autoApprove) => setForm((current) => ({ ...current, autoApprove }))} /><span class="mut small">{t('board.rememberApproval')}</span></div>
        <IssueGitBranchFields pid={pid} value={form.gitBranch} onChange={(gitBranch) => setForm((current) => ({ ...current, gitBranch }))} onLoadingChange={setGitLoading} />
        {error && <div class="err" role="alert">{error}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" disabled={busy} onClick={onClose}>{t('ui.cancel')}</button>
        <button class="btn primary" disabled={busy || gitLoading || !form.title.trim() || agentUnavailable} onClick={() => void submit()}>{busy ? t('externalImport.importing') : t('externalImport.confirm')}</button>
      </div>
    </Modal>
  );
}

export function ExternalIssuesView({ pid }: { pid: number }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [project, setProject] = useState<Project | null>(null);
  const [source, setSource] = useState<ExternalIssueSourceSummary | null>(null);
  const [modules, setModules] = useState<ProjectModule[]>([]);
  const [supportedAgents, setSupportedAgents] = useState<AgentKind[]>([]);
  const [candidates, setCandidates] = useState<ExternalIssueCandidate[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [ignoringId, setIgnoringId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ExternalIssueCandidate | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setCandidates(null);
    setError('');
    void Promise.all([
      api<Project>(`/api/projects/${pid}`),
      api<{ source: ExternalIssueSourceSummary | null }>(`/api/projects/${pid}/external-issues/source`),
      api<{ modules: ProjectModule[] }>(`/api/projects/${pid}/modules`),
      getProjectExecutorAgents(pid),
    ]).then(([nextProject, sourceResult, moduleResult, agents]) => {
      setProject(nextProject);
      setSource(sourceResult.source);
      setModules(moduleResult.modules);
      setSupportedAgents(agents);
    }).catch((reason: Error) => setError(reason.message));
  }, [pid]);

  const fetchCandidates = async (): Promise<void> => {
    if (fetching || !source?.tokenConfigured) return;
    setFetching(true);
    setError('');
    try {
      const result = await api<{ source: ExternalIssueSourceSummary; issues: ExternalIssueCandidate[] }>(
        `/api/projects/${pid}/external-issues/fetch`, 'POST', {},
      );
      setSource(result.source);
      setCandidates(result.issues);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setFetching(false);
    }
  };

  const ignore = async (candidate: ExternalIssueCandidate): Promise<void> => {
    if (ignoringId || !confirm(t('externalImport.ignoreConfirm', { number: candidate.externalNumber }))) return;
    setIgnoringId(candidate.externalId);
    setError('');
    try {
      await api(`/api/projects/${pid}/external-issues/ignore`, 'POST', externalIssueIdentity(candidate));
      setCandidates((current) => current?.filter((item) => item.externalId !== candidate.externalId) ?? current);
      toast.info(t('externalImport.ignored', { number: candidate.externalNumber }));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setIgnoringId(null);
    }
  };

  const formatRemoteTime = (value: string | null): string => {
    if (!value) return t('ui.unknown');
    const time = Date.parse(value);
    return Number.isFinite(time) ? i18n.formatDateTime(time) : value;
  };

  const ready = Boolean(source?.tokenConfigured);
  return (
    <div class="page ei-page">
      <header class="ei-head">
        <button class="back" aria-label={t('ui.back')} onClick={() => nav(`/p/${pid}`)}>‹</button>
        <div class="grow"><h1>{t('externalImport.title')}</h1><p>{project ? `${project.name} · ` : ''}{t('externalImport.description')}</p></div>
        <button class="btn primary" disabled={!ready || fetching} onClick={() => void fetchCandidates()}>{fetching ? t('externalImport.fetching') : t('externalImport.fetch')}</button>
      </header>

      {source ? (
        <div class="ei-source">
          <b>{t('externalImport.source')}</b>
          <span class="badge b-gray">{PROVIDER_LABEL[source.provider]}</span>
          <span class="mono">{source.remoteName} · {source.remoteUrl}</span>
          <span class="mut">{source.instanceUrl}</span>
        </div>
      ) : null}
      {!ready && (
        <div class="ps-note ei-config-note">
          <span>{t('externalImport.configureFirst')}</span>
          <button class="btn sm" onClick={() => nav(`/p/${pid}/settings`)}>{t('externalImport.configureAction')}</button>
        </div>
      )}
      {error && <div class="err ps-error" role="alert">{error}</div>}

      {ready && candidates === null && !fetching && <div class="ei-state" role="status">{t('externalImport.idle')}</div>}
      {ready && fetching && <div class="ei-state" role="status" aria-live="polite"><span class="spinner" aria-hidden="true" /> {t('externalImport.fetching')}</div>}
      {candidates !== null && !fetching && candidates.length === 0 && <div class="ei-state" role="status">{t('externalImport.empty')}</div>}
      {candidates && candidates.length > 0 && (
        <section class="ei-results">
          <div class="ei-count" role="status" aria-live="polite">{t('externalImport.count', { count: candidates.length })}</div>
          <div class="ei-list">
            {candidates.map((candidate) => (
              <article class="ei-card" key={`${candidate.sourceKey}:${candidate.externalId}`}>
                <div class="ei-card-head">
                  <span class="badge b-gray">{PROVIDER_LABEL[candidate.provider]} #{candidate.externalNumber}</span>
                  <h2>{candidate.title}</h2>
                </div>
                {candidate.body && <p class="ei-body">{candidate.body}</p>}
                <div class="ei-meta">
                  {candidate.author && <span>{t('externalImport.author', { author: candidate.author })}</span>}
                  {candidate.labels.length > 0 && <span>{t('externalImport.labels', { labels: i18n.formatList(candidate.labels) })}</span>}
                  <span>{t('externalImport.created', { time: formatRemoteTime(candidate.createdAt) })}</span>
                  <span>{t('externalImport.updated', { time: formatRemoteTime(candidate.updatedAt) })}</span>
                </div>
                <div class="ei-actions">
                  <a class="btn sm" href={candidate.url} target="_blank" rel="noreferrer">{t('externalImport.openRemote')}</a>
                  <button class="btn sm danger" disabled={ignoringId !== null} onClick={() => void ignore(candidate)}>{t('externalImport.ignore')}</button>
                  <button class="btn sm primary" onClick={() => setEditing(candidate)}>{t('externalImport.edit')}</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {editing && <ImportModal pid={pid} candidate={editing} modules={modules} supportedAgents={supportedAgents} onClose={() => setEditing(null)} onImported={(candidate, localIssueId) => {
        setCandidates((current) => current?.filter((item) => item.externalId !== candidate.externalId) ?? current);
        setEditing(null);
        toast.success(t('externalImport.imported', { number: candidate.externalNumber, id: localIssueId }));
      }} />}
    </div>
  );
}
