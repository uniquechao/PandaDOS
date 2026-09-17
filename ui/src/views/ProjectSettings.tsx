import { useEffect, useState } from 'preact/hooks';
import { AgentLogo } from '../components/AgentLogo';
import { ModulesPanel } from '../components/ModulesPanel';
import { SummaryButton } from '../components/SummaryButton';
import { useI18n } from '../i18n/provider';
import {
  addMember,
  api,
  ApiError,
  listMemberCandidates,
  listMembers,
  removeMember,
  transferOwner,
} from '../lib/api';
import { fmtTime, timeAgo } from '../lib/fmt';
import { pollProjectSummary } from '../lib/pollSummary';
import { nav } from '../lib/router';
import { isAsyncMode, SUMMARY_MODELS, type SummaryMode } from '../lib/summaryModes';
import { toast } from '../lib/toast';
import type {
  AgentKind,
  ExternalIssueProvider,
  ExternalIssueRemote,
  ExternalIssueSourceSummary,
  ExecutorLite,
  Issue,
  Me,
  MemberCandidate,
  Project,
  ProjectDataSyncStatus,
  ProjectMember,
  ProjectModule,
  ValidationCommand,
} from '../lib/types';

const PROVIDER_LABEL: Record<ExternalIssueProvider, string> = { github: 'GitHub', gitlab: 'GitLab' };
const GITLAB_INSTANCE_EXAMPLE = 'https://gitlab.example.com';

export interface ExternalIssueSourceForm {
  provider: ExternalIssueProvider;
  remoteName: string;
  instanceUrl: string;
  apiToken: string;
  clearApiToken: boolean;
}

export interface ProjectSettingsFields {
  name: string;
  goal: string;
  /** 门禁命令（#279）：一行一条，参数空格分隔；空文本 = 未配置（按 package.json 探测） */
  validationCommands: string;
}

/**
 * 文本框 → 门禁命令（#279）。一行一条，按空白切成 argv；空行忽略。
 * **空文本返回 null**（= 未配置，交给控制面按 package.json 探测），不是「不跑门禁」。
 */
export function parseValidationCommandLines(text: string): ValidationCommand[] | null {
  const commands = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split(/\s+/).filter((part) => part.length > 0))
    .filter((argv) => argv.length > 0)
    .map((argv) => ({ label: argv.slice(1).join(' ') || argv[0]!, argv }));
  return commands.length > 0 ? commands : null;
}

/** 门禁命令 → 文本框（未配置/空配置都显示为空） */
export function formatValidationCommandLines(commands: ValidationCommand[] | null | undefined): string {
  return (commands ?? []).map((c) => c.argv.join(' ')).join('\n');
}

type SettingsSection = 'general' | 'repository' | 'issueSubscription' | 'members' | 'modules' | 'workflows';
const SETTINGS_SECTION_INDEX: Record<SettingsSection, string> = {
  general: '01', repository: '02', issueSubscription: '03', members: '04', modules: '05', workflows: '06',
};
const SYNC_STATE_KEYS = {
  never: 'projectSettings.syncState.never', syncing: 'projectSettings.syncState.syncing',
  success: 'projectSettings.syncState.success', warning: 'projectSettings.syncState.warning',
  error: 'projectSettings.syncState.error',
} as const;

function normalizedProjectSettings(fields: ProjectSettingsFields): ProjectSettingsFields {
  return {
    name: fields.name.trim(),
    goal: fields.goal.trim(),
    validationCommands: formatValidationCommandLines(parseValidationCommandLines(fields.validationCommands)),
  };
}

export function projectSettingsDirty(saved: ProjectSettingsFields, current: ProjectSettingsFields): boolean {
  const a = normalizedProjectSettings(saved);
  const b = normalizedProjectSettings(current);
  return a.name !== b.name || a.goal !== b.goal || a.validationCommands !== b.validationCommands;
}

/** 空 token 不进入请求，避免界面把脱敏摘要或空值误当成新凭据覆盖后端。 */
export function externalIssueSourcePayload(form: ExternalIssueSourceForm): Record<string, unknown> {
  return {
    provider: form.provider,
    remoteName: form.remoteName,
    ...(form.provider === 'gitlab' && form.instanceUrl.trim()
      ? { instanceUrl: form.instanceUrl.trim() }
      : {}),
    ...(form.apiToken.trim() ? { apiToken: form.apiToken.trim() } : {}),
    ...(form.clearApiToken ? { clearApiToken: true } : {}),
  };
}

export function externalIssueSourceDefaults(
  remote?: Pick<ExternalIssueRemote, 'host'> & Partial<Pick<ExternalIssueRemote, 'suggestedProvider' | 'suggestedInstanceUrl'>>,
): Pick<ExternalIssueSourceForm, 'provider' | 'instanceUrl'> {
  const provider: ExternalIssueProvider = !remote || remote.host.toLowerCase() === 'github.com' ? 'github' : 'gitlab';
  return {
    provider,
    instanceUrl: provider === 'gitlab' ? remote?.suggestedInstanceUrl ?? `https://${remote?.host ?? ''}` : '',
  };
}

function MembersSection({ pid, me, ownerUserId }: { pid: number; me: Me; ownerUserId: number }) {
  const { t } = useI18n();
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [candidates, setCandidates] = useState<MemberCandidate[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canManage = me.role === 'admin' || me.id === ownerUserId;

  const load = (): void => {
    void listMembers(pid).then((result) => setMembers(result.members)).catch((e: Error) => setError(e.message));
  };

  useEffect(load, [pid, ownerUserId]);
  useEffect(() => {
    if (!canManage) return setCandidates([]);
    void listMemberCandidates(pid).then((result) => setCandidates(result.candidates)).catch(() => setCandidates([]));
  }, [pid, canManage, members]);

  const add = async (): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await addMember(pid, selected);
      toast.success(result.added
        ? t('board.addedMember', { name: result.member.username })
        : t('board.alreadyMember', { name: result.member.username }));
      setSelected('');
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (member: ProjectMember): Promise<void> => {
    if (busy || !confirm(t('board.removeMemberConfirm', { name: member.username }))) return;
    setBusy(true);
    setError('');
    try {
      await removeMember(pid, member.userId);
      toast.success(t('board.removedMember', { name: member.username }));
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const makeOwner = async (member: ProjectMember): Promise<void> => {
    if (busy || !confirm(t('board.transferOwnerConfirm', { name: member.username }))) return;
    setBusy(true);
    setError('');
    try {
      await transferOwner(pid, member.userId);
      toast.success(t('board.transferredOwner', { name: member.username }));
      location.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  const activity = (member: ProjectMember): string =>
    t('board.loginActive', {
      login: member.lastLoginTs ? timeAgo(member.lastLoginTs) : t('ui.never'),
      active: member.lastSeenTs ? timeAgo(member.lastSeenTs) : t('ui.never'),
    });
  const activityTitle = (member: ProjectMember): string =>
    t('board.loginActiveTitle', {
      login: member.lastLoginTs ? fmtTime(member.lastLoginTs) : t('ui.never'),
      active: member.lastSeenTs ? fmtTime(member.lastSeenTs) : t('ui.never'),
    });

  return (
    <section id="settings-members" class="ps-section">
      <div class="ps-section-head">
        <div><span>{SETTINGS_SECTION_INDEX.members}</span><h2>{t('projectSettings.members')}</h2></div>
        {canManage && (
          <div class="ps-member-add">
            <select value={selected} aria-label={t('board.chooseUser')} onChange={(e) => setSelected(e.currentTarget.value)}>
              <option value="">{candidates.length ? t('board.chooseUser') : t('board.noUsersToAdd')}</option>
              {candidates.map((candidate) => <option key={candidate.id} value={candidate.username}>{candidate.username}</option>)}
            </select>
            <button class="btn sm" disabled={busy || !selected} onClick={() => void add()}>＋ {t('board.add')}</button>
          </div>
        )}
      </div>
      <div class="ps-members-panel">
      {members === null ? <div class="mut">{t('ui.loading')}</div> : (
        <div class="memlist">
          {members.map((member) => (
            <div class="memrow" key={member.userId}>
              <div class="memrow-main">
                <span class="memrow-name">👤 {member.username}</span>
                <span class={`badge ${member.role === 'owner' ? 'b-amber' : 'b-gray'}`}>
                  {member.role === 'owner' ? t('board.owner') : t('board.member')}
                </span>
              </div>
              <span class="memrow-meta" title={activityTitle(member)}>{activity(member)}</span>
              <span class="memrow-stat" title={t('board.memberIssueStats')}>issue {member.issueDone}/{member.issueTotal}</span>
              {canManage && member.role === 'member' && (
                <div class="memrow-acts">
                  <button class="memrow-act" disabled={busy} onClick={() => void makeOwner(member)}>{t('board.setOwner')}</button>
                  <button class="memrow-act danger" disabled={busy} onClick={() => void remove(member)}>{t('board.remove')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {!canManage && <div class="mut small">{t('board.memberPermission')}</div>}
      {error && <div class="err" role="alert">{error}</div>}
      </div>
    </section>
  );
}

export function ProjectSettingsView({ pid, me }: { pid: number; me: Me }) {
  const { t } = useI18n();
  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [validationCommands, setValidationCommands] = useState('');
  const [remotes, setRemotes] = useState<ExternalIssueRemote[]>([]);
  const [source, setSource] = useState<ExternalIssueSourceSummary | null>(null);
  const [sourceForm, setSourceForm] = useState<ExternalIssueSourceForm>({
    provider: 'github', remoteName: '', instanceUrl: '', apiToken: '', clearApiToken: false,
  });
  const [issues, setIssues] = useState<Issue[]>([]);
  const [modules, setModules] = useState<ProjectModule[] | null>(null);
  const [executor, setExecutor] = useState<ExecutorLite | null>(null);
  const [supportedAgents, setSupportedAgents] = useState<AgentKind[]>([]);
  const [modulesOpen, setModulesOpen] = useState(false);
  const [savedFields, setSavedFields] = useState<ProjectSettingsFields | null>(null);
  const [saving, setSaving] = useState(false);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState('');
  const [syncStatus, setSyncStatus] = useState<ProjectDataSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  const canManage = Boolean(project && (me.role === 'admin' || me.id === project.ownerUserId));

  const applyProject = (next: Project): void => {
    const fields = {
      name: next.name,
      goal: next.goal ?? '',
      validationCommands: formatValidationCommandLines(next.validationCommands),
    };
    setProject(next);
    setName(fields.name);
    setGoal(fields.goal);
    setValidationCommands(fields.validationCommands);
    setSavedFields(fields);
  };
  const applySource = (next: ExternalIssueSourceSummary | null, candidates = remotes): void => {
    setSource(next);
    const remote = candidates.find((item) => item.name === next?.remoteName) ?? candidates[0];
    const defaults = externalIssueSourceDefaults(remote);
    setSourceForm({
      provider: next?.provider ?? defaults.provider,
      remoteName: next?.remoteName ?? remote?.name ?? '',
      instanceUrl: next?.provider === 'gitlab' ? next.instanceUrl : next ? '' : defaults.instanceUrl,
      apiToken: '',
      clearApiToken: false,
    });
  };

  const load = (): void => {
    setError('');
    void Promise.all([
      api<Project>(`/api/projects/${pid}`),
      api<{ remotes: ExternalIssueRemote[] }>(`/api/projects/${pid}/external-issues/remotes`),
      api<{ source: ExternalIssueSourceSummary | null }>(`/api/projects/${pid}/external-issues/source`),
      api<Issue[]>(`/api/projects/${pid}/issues`),
      api<{ modules: ProjectModule[] }>(`/api/projects/${pid}/modules`),
      api<ExecutorLite[]>('/api/executors'),
      api<{ status: ProjectDataSyncStatus }>(`/api/projects/${pid}/sync`),
    ]).then(([nextProject, remoteResult, sourceResult, nextIssues, moduleResult, executors, syncResult]) => {
      const nextExecutor = executors.find((item) => item.id === nextProject.executorId) ?? null;
      applyProject(nextProject);
      setRemotes(remoteResult.remotes);
      applySource(sourceResult.source, remoteResult.remotes);
      setIssues(nextIssues);
      setModules(moduleResult.modules);
      setExecutor(nextExecutor);
      setSupportedAgents(nextExecutor?.supportedAgents ?? []);
      setSyncStatus(syncResult.status);
    }).catch((e: Error) => setError(e.message));
  };
  useEffect(load, [pid]);

  const currentFields = { name, goal, validationCommands };
  const dirty = Boolean(savedFields && projectSettingsDirty(savedFields, currentFields));

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    addEventListener('beforeunload', warnBeforeUnload);
    return () => removeEventListener('beforeunload', warnBeforeUnload);
  }, [dirty]);

  const leaveSettings = (): void => {
    if (dirty && !confirm(t('projectSettings.unsavedConfirm'))) return;
    nav(`/p/${pid}`);
  };

  const saveProject = async (): Promise<void> => {
    if (!project || !canManage || saving || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      const result = await api<{ project: Project }>(`/api/projects/${pid}`, 'PATCH', {
        name: currentFields.name.trim(),
        goal: currentFields.goal.trim() || null,
        // 留空 = null = 未配置（后端按 package.json 探测），与「显式不跑门禁」不是一回事
        validationCommands: parseValidationCommandLines(currentFields.validationCommands),
      });
      applyProject(result.project);
      toast.success(t('projectSettings.saved'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const updateSummary = async (mode: SummaryMode): Promise<void> => {
    if (!project || summarizing) return;
    setSummarizing(true);
    try {
      const result = await api<{ summary?: string; project: Project }>(`/api/projects/${pid}/readme-summary`, 'POST', { mode });
      applyProject(result.project);
      if (isAsyncMode(mode)) {
        toast.info(t('project.startedSummary', { mode }));
        const final = await pollProjectSummary(pid, { onTick: applyProject });
        if (final.summaryStatus === 'done') toast.success(t('project.knowledgeUpdated'));
        else if (final.summaryStatus === 'error') toast.error(final.summaryError ?? t('project.generationFailed'));
      } else toast.success(t('project.summaryUpdated'));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSummarizing(false);
    }
  };

  const saveSource = async (): Promise<void> => {
    if (!canManage || sourceSaving || !sourceForm.remoteName) return;
    setSourceSaving(true);
    setError('');
    try {
      const result = await api<{ source: ExternalIssueSourceSummary }>(
        `/api/projects/${pid}/external-issues/source`, 'PUT', externalIssueSourcePayload(sourceForm),
      );
      applySource(result.source);
      toast.success(t('projectSettings.sourceSaved'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSourceSaving(false);
    }
  };

  const removeSource = async (): Promise<void> => {
    if (!canManage || !source || sourceSaving || !confirm(t('projectSettings.removeSourceConfirm'))) return;
    setSourceSaving(true);
    try {
      await api(`/api/projects/${pid}/external-issues/source`, 'DELETE');
      applySource(null);
      toast.success(t('projectSettings.sourceRemoved'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSourceSaving(false);
    }
  };

  const syncNow = async (): Promise<void> => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await api<{ status: ProjectDataSyncStatus }>(`/api/projects/${pid}/sync`, 'POST');
      setSyncStatus(result.status);
      if (result.status.state === 'success') toast.success(t('projectSettings.syncCompleted'));
      else toast.error(t('projectSettings.syncNeedsAttention'));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  if (!project && !error) return <div class="boot">{t('ui.loading')}</div>;
  if (!project) return <div class="page"><div class="err" role="alert">{error}</div></div>;

  const selectedRemote = remotes.find((item) => item.name === sourceForm.remoteName);
  return (
    <div class="page ps-page">
      <header class="ps-head">
        <button class="back" aria-label={t('ui.back')} onClick={leaveSettings}>‹</button>
        <div class="ps-title"><h1>{t('projectSettings.title')}</h1><div class="mut small">{project.name}</div></div>
        <div class={`ps-savebar ${dirty ? 'is-dirty' : ''}`} aria-live="polite">
          <span class="ps-save-state"><i aria-hidden="true" />{dirty ? t('projectSettings.unsavedChanges') : t('projectSettings.allChangesSaved')}</span>
          <button class="btn primary" disabled={!canManage || saving || !dirty || !name.trim()} onClick={() => void saveProject()}>
            {saving ? t('ui.saving') : t('projectSettings.saveChanges')}
          </button>
        </div>
      </header>
      {!canManage && <div class="ps-note">{t('projectSettings.ownerOnly')}</div>}
      {error && <div class="err ps-error" role="alert">{error}</div>}

      <div class="ps-console">
        <div class="ps-content">
          <section id="settings-general" class="ps-section">
            <div class="ps-section-head"><div><span>{SETTINGS_SECTION_INDEX.general}</span><h2>{t('projectSettings.general')}</h2></div></div>
            <div class="ps-form-grid">
              <label class="field">{t('project.projectName')}<input value={name} disabled={!canManage} onInput={(e) => setName(e.currentTarget.value)} /></label>
              <label class="field">{t('project.goal')}<textarea rows={3} value={goal} disabled={!canManage} onInput={(e) => setGoal(e.currentTarget.value)} /><span class="small mut">{t('projectSettings.descriptionHelp')}</span></label>
              <label class="field">{t('projectSettings.validationCommands')}
                <textarea
                  rows={3}
                  class="mono"
                  value={validationCommands}
                  disabled={!canManage}
                  onInput={(e) => setValidationCommands(e.currentTarget.value)}
                />
                <span class="small mut">{t('projectSettings.validationCommandsHelp')}</span>
              </label>
            </div>
            <div class="ps-summary">
              <div class="ps-summary-head"><b>{t('projectSettings.readmeSummary')}</b><SummaryButton status={project.summaryStatus} busy={summarizing} onPick={(mode) => void updateSummary(mode)} renderLabel={(_, busy) => busy || project.summaryStatus === 'running' ? t('action.generating') : t('projectSettings.manualUpdate')} models={SUMMARY_MODELS.filter((item) => item.mode === 'llm' || supportedAgents.includes(item.mode as AgentKind))} /></div>
              {project.readmeSummary ? <p>{project.readmeSummary}</p> : <div class="empty">—</div>}
            </div>
          </section>

          <section id="settings-repository" class="ps-section">
            <div class="ps-section-head"><div><span>{SETTINGS_SECTION_INDEX.repository}</span><h2>{t('projectSettings.repository')}</h2></div></div>
            <div class="ps-repository-grid">
              <div class="ps-repository-field"><span>{t('projectSettings.directory')}</span><strong class="ps-readonly-field mono" title={project.cwd}>{project.cwd}</strong></div>
              {remotes.length === 0 ? <div class="empty">{t('projectSettings.noRemotes')}</div> : (
                <label class="field ps-repository-field">{t('projectSettings.remote')}<select disabled={!canManage} value={sourceForm.remoteName} onChange={(e) => {
                  const remoteName = e.currentTarget.value;
                  const remote = remotes.find((item) => item.name === remoteName);
                  const defaults = externalIssueSourceDefaults(remote);
                  setSourceForm((form) => ({ ...form, remoteName, ...defaults }));
                }}>{remotes.map((remote) => <option key={remote.name} value={remote.name}>{remote.name} · {remote.url}</option>)}</select>{selectedRemote && <span class="ps-remote-meta mono">{selectedRemote.host} · {selectedRemote.url}</span>}</label>
              )}
            </div>
            <div class="ps-executor-block">
              <div class="ps-executor-head">
                <strong>{t('projectSettings.executor')}</strong>
                {executor && <span class={`ps-status ${executor.status === 'online' ? 'ok' : executor.status === 'offline' ? 'warn' : 'muted'}`}>{t(executor.status === 'online' ? 'status.online' : executor.status === 'offline' ? 'status.offline' : 'status.unknown')}</span>}
              </div>
              {executor ? (
                <div class="ps-executor-card">
                  <div class="ps-executor-main">
                    <span class="ps-executor-mark" aria-hidden="true" />
                    <div><strong>{executor.name}</strong><span class="mono">#{executor.id}</span></div>
                    {executor.isSystemLocal && <span class="badge b-amber">{t('admin.systemLocal')}</span>}
                  </div>
                  <div class="ps-executor-agents">
                    <span>{t('admin.availableAgents')}</span>
                    <div>{executor.supportedAgents.length
                      ? executor.supportedAgents.map((agent) => <AgentLogo agent={agent} size="xs" key={agent} />)
                      : <span class="mut">{t('project.noAgent')}</span>}
                    </div>
                  </div>
                </div>
              ) : <div class="empty">{t('ui.notConfigured')}</div>}
            </div>
            <div class={`ps-sync-card is-${syncStatus?.state ?? 'never'}`} aria-live="polite">
              <div class="ps-sync-head">
                <div><strong>{t('projectSettings.syncTitle')}</strong><span class={`ps-status ${syncStatus?.state === 'success' ? 'ok' : syncStatus?.state === 'warning' || syncStatus?.state === 'error' ? 'warn' : 'muted'}`}>{t(SYNC_STATE_KEYS[syncStatus?.state ?? 'never'])}</span></div>
                <button class="btn sm" disabled={syncing || syncStatus?.state === 'syncing'} onClick={() => void syncNow()}>{syncing || syncStatus?.state === 'syncing' ? t('projectSettings.syncing') : t('projectSettings.syncNow')}</button>
              </div>
              <div class="ps-sync-meta">
                <span>{syncStatus?.lastAttemptTs ? t('projectSettings.syncLast', { time: fmtTime(syncStatus.lastAttemptTs) }) : t('projectSettings.syncNever')}</span>
                {syncStatus && <span>{t('projectSettings.syncSummary', { detected: syncStatus.detectedUpdates, imported: syncStatus.imported, archived: syncStatus.archived })}</span>}
              </div>
              {syncStatus && (syncStatus.conflicts > 0 || syncStatus.parseErrors > 0) && <div class="ps-sync-errors" role="alert">
                <strong>{t('projectSettings.syncProblems', { conflicts: syncStatus.conflicts, errors: syncStatus.parseErrors })}</strong>
                {syncStatus.details.length > 0 && <ul>{syncStatus.details.map((detail) => <li key={detail}><code>{detail}</code></li>)}</ul>}
              </div>}
            </div>
          </section>

          <section id="settings-issue-subscription" class="ps-section">
            <div class="ps-section-head"><div><span>{SETTINGS_SECTION_INDEX.issueSubscription}</span><h2>{t('projectSettings.issueSubscription')}</h2></div><span class={`ps-status ${source?.tokenConfigured ? 'ok' : 'muted'}`}>{source?.tokenConfigured ? t('projectSettings.sourceConfigured') : t('projectSettings.sourceNotConfigured')}</span></div>
            {remotes.length === 0 ? <div class="empty">{t('projectSettings.noRemotes')}</div> : <div class="ps-source-form">
              <div class="ps-source-grid">
                <label class="field">{t('projectSettings.provider')}<select disabled={!canManage} value={sourceForm.provider} onChange={(e) => {
                  const provider = e.currentTarget.value as ExternalIssueProvider;
                  setSourceForm((form) => ({ ...form, provider, instanceUrl: provider === 'gitlab' ? selectedRemote?.suggestedInstanceUrl ?? '' : '' }));
                }}><option value="github">{PROVIDER_LABEL.github}</option><option value="gitlab">{PROVIDER_LABEL.gitlab}</option></select></label>
                {sourceForm.provider === 'gitlab' && <label class="field">{t('projectSettings.gitlabInstance')}<input placeholder={GITLAB_INSTANCE_EXAMPLE} disabled={!canManage} value={sourceForm.instanceUrl} onInput={(e) => setSourceForm((form) => ({ ...form, instanceUrl: e.currentTarget.value }))} /><span class="small mut">{t('projectSettings.gitlabInstanceHelp')}</span></label>}
              </div>
              <label class="field">{t('projectSettings.apiToken')}<input type="password" autocomplete="new-password" disabled={!canManage || sourceForm.clearApiToken} value={sourceForm.apiToken} onInput={(e) => setSourceForm((form) => ({ ...form, apiToken: e.currentTarget.value, clearApiToken: false }))} placeholder={t('projectSettings.keepToken')} /></label>
              <div class="small mut">{source?.tokenConfigured && source.tokenMasked ? t('projectSettings.configuredToken', { token: source.tokenMasked }) : t('projectSettings.noToken')}</div>
              {source?.tokenConfigured && <label class="chkrow"><input type="checkbox" disabled={!canManage} checked={sourceForm.clearApiToken} onChange={(e) => setSourceForm((form) => ({ ...form, clearApiToken: e.currentTarget.checked, apiToken: '' }))} />{t('projectSettings.clearToken')}</label>}
              <div class="row ps-actions"><button class="btn primary" disabled={!canManage || sourceSaving || !sourceForm.remoteName} onClick={() => void saveSource()}>{sourceSaving ? t('ui.saving') : t('projectSettings.saveSource')}</button>{source && <button class="btn danger" disabled={!canManage || sourceSaving} onClick={() => void removeSource()}>{t('projectSettings.removeSource')}</button>}</div>
            </div>}
          </section>

          <MembersSection pid={pid} me={me} ownerUserId={project.ownerUserId} />

          <section id="settings-modules" class="ps-section">
            <div class="ps-section-head"><div><span>{SETTINGS_SECTION_INDEX.modules}</span><h2>{t('projectSettings.modules')}</h2></div><button class="btn sm" onClick={() => setModulesOpen(true)}>{t('projectSettings.manageModules')}</button></div>
            {modules === null ? <div class="mut">{t('ui.loading')}</div> : modules.length === 0 ? <div class="empty">{t('ui.noModules')}</div> : (
              <div class="ps-module-list">
                {modules.map((module) => (
                  <div class="ps-module-item" key={module.id}>
                    <div class="ps-module-main"><strong title={module.displayName}>{module.displayName}</strong><span class="mono" title={module.slug}>{module.slug}</span></div>
                    <div class="ps-module-meta">
                      <AgentLogo agent={module.agent} size="xs" />
                      <span>{module.source === 'legacy' ? t('ui.migrated') : module.source === 'manual' ? t('ui.manual') : t('ui.automatic')}</span>
                      <span class="badge b-gray">{t('ui.moduleIssueCount', { count: issues.filter((issue) => issue.moduleId === module.id).length })}</span>
                      <span title={module.lastUsedTs ? fmtTime(module.lastUsedTs) : t('ui.never')}>{module.lastUsedTs ? timeAgo(module.lastUsedTs) : t('ui.never')}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section id="settings-workflows" class="ps-section">
            <div class="ps-section-head">
              <div><span>{SETTINGS_SECTION_INDEX.workflows}</span><h2>{t('projectSettings.workflows')}</h2></div>
              <button class="btn sm" onClick={() => nav(`/p/${pid}/workflows`)}>{t('projectSettings.manageWorkflows')}</button>
            </div>
            <p class="mut small ps-section-copy">{t('projectSettings.workflowsHelp')}</p>
          </section>
        </div>
      </div>
      {modulesOpen && <ModulesPanel pid={pid} issues={issues} supportedAgents={supportedAgents} onChanged={load} onClose={() => setModulesOpen(false)} />}
    </div>
  );
}
