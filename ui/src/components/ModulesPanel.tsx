/**
 * 项目模块管理面板（Modal，Board 头部「模块」入口）：
 * - 智能整理：手动触发（可选 claude/codex），执行代理在独立会话扫全部历史 issue + 代码库，
 *   产出整理方案（合并 / 改 slug / 新建模块 / 挪 issue）；面板轮询进度，方案逐项「执行」
 *   （服务端按当前事实重校验 + 防重放），或「忽略本批」（localStorage 同批不再提示）。
 * - 模块列表：显示名 · slug · 代理 · 来源 · issue 数；行内改名（PATCH displayName）、
 *   归档（PATCH status=archived，有未完结 issue 时服务端会拒绝）。
 */
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import type { AgentKind, Issue, ProjectModule } from '../lib/types';
import {
  actionKindMessage,
  actionMessage,
  dismissOrganizeSuggestion,
  failureMessage,
  readOrganizeDismissedTs,
  resultMessage,
  visibleSuggestion,
  type OrganizeApplyResult,
  type OrganizeStatus,
} from '../lib/organize';
import { Modal } from './Modal';
import { toast } from '../lib/toast';
import { reconcileAgent } from './AgentPicker';
import { useI18n } from '../i18n/provider';

const ORG_POLL_MS = 4000;

export function ModulesPanel({
  pid,
  issues,
  supportedAgents,
  onChanged,
  onClose,
}: {
  pid: number;
  issues: Issue[];
  supportedAgents: AgentKind[];
  /** 合并/归档/整理改变了 issue 归属或模块列表后回调（Board 刷新列表用） */
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [modules, setModules] = useState<ProjectModule[] | null>(null);
  const [org, setOrg] = useState<OrganizeStatus | null>(null);
  const [orgAgent, setOrgAgent] = useState<AgentKind>('claude');
  const [dismissed, setDismissed] = useState<number | null>(() => readOrganizeDismissedTs(pid));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState<number | null>(null);
  const [err, setErr] = useState('');

  const load = (): void => {
    api<{ modules: ProjectModule[] }>(`/api/projects/${pid}/modules`)
      .then((r) => setModules(r.modules))
      .catch((e: Error) => setErr(e.message));
    void loadOrg();
  };
  const loadOrg = (): Promise<void> =>
    api<OrganizeStatus>(`/api/projects/${pid}/modules/organize`)
      .then(setOrg)
      .catch(() => {});
  useEffect(load, [pid]);
  useEffect(() => {
    const next = reconcileAgent(orgAgent, supportedAgents);
    if (next) setOrgAgent(next);
  }, [supportedAgents]);

  // 分析在途时轮询（面板开着才轮；归还后最后再拉一次拿方案）
  useEffect(() => {
    if (!org?.running) return;
    const t = window.setInterval(() => void loadOrg(), ORG_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.running, pid]);

  const sugg = visibleSuggestion(org, dismissed);
  const issueCount = (moduleId: number): number => issues.filter((i) => i.moduleId === moduleId).length;

  const startOrganize = async (): Promise<void> => {
    if (busy || org?.running) return;
    setBusy(true);
    try {
      await api(`/api/projects/${pid}/modules/organize`, 'POST', { agent: orgAgent });
      toast.info(t('ui.analysisStarted', { agent: orgAgent }));
      await loadOrg();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyAction = async (index: number): Promise<void> => {
    if (applying !== null) return;
    setApplying(index);
    try {
      const r = await api<{ ok: boolean; result: OrganizeApplyResult }>(
        `/api/projects/${pid}/modules/organize/apply`,
        'POST',
        { index },
      );
      const message = resultMessage(r.result);
      toast.success(t(message.key, message.values));
      load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
      void loadOrg(); // 失败也刷新（可能已被别处执行）
    } finally {
      setApplying(null);
    }
  };

  const ignore = (): void => {
    const ts = org?.suggestion?.ts ?? Date.now();
    dismissOrganizeSuggestion(pid, ts);
    setDismissed(ts);
    toast.info(t('ui.batchIgnored'));
  };

  const saveRename = async (m: ProjectModule): Promise<void> => {
    const name = editName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await api(`/api/projects/${pid}/modules/${m.id}`, 'PATCH', { displayName: name });
      toast.success(t('ui.renamed'));
      setEditingId(null);
      load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (m: ProjectModule): Promise<void> => {
    if (busy) return;
    if (!confirm(t('ui.archiveModuleConfirm', { name: m.displayName }))) return;
    setBusy(true);
    try {
      await api(`/api/projects/${pid}/modules/${m.id}`, 'PATCH', { status: 'archived' });
      toast.success(t('ui.archived'));
      load();
      onChanged();
    } catch (e) {
      // 典型拒绝：模块还有未完结 issue → 提示先合并/处理
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changeAgent = async (m: ProjectModule, agent: AgentKind): Promise<void> => {
    if (busy || agent === m.agent) return;
    setBusy(true);
    try {
      await api(`/api/projects/${pid}/modules/${m.id}`, 'PATCH', { agent });
      toast.success(t('ui.moduleAgentChanged', { agent }));
      load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('ui.projectModules')} wide onClose={onClose}>
      <div class="formcol">
        <div class="org-bar">
          <span class="org-title">✨ {t('ui.smartOrganize')}</span>
          <span class="org-hint" title={t('ui.smartOrganizeHint')}>
            {t('ui.smartOrganizeHint')}
          </span>
          <select
            value={orgAgent}
            disabled={org?.running || busy}
            onChange={(e) => setOrgAgent(e.currentTarget.value as AgentKind)}
          >
            {supportedAgents.map((a) => (
              <option key={a} value={a}>{a === 'claude' ? 'Claude Code' : 'Codex'}</option>
            ))}
          </select>
          <button
            class="btn sm primary"
            disabled={busy || !!org?.running || supportedAgents.length === 0}
            onClick={() => void startOrganize()}
          >
            {org?.running ? t('ui.analyzing') : t('ui.startAnalysis')}
          </button>
        </div>
        {org?.running && (
          <div class="org-note run">
            <span class="spinner sm" />
            {t('ui.agentScanning')}
          </div>
        )}
        {!org?.running && org?.failed && (
          <div class="org-note fail">
            {(() => {
              const message = failureMessage(org.failed.reason);
              return t(message.key, message.values);
            })()}
            {org.failed.error && <span class="org-failure-detail"> {t('ui.organizeFailureDetail', { detail: org.failed.error })}</span>}
          </div>
        )}

        {sugg && (
          <div class="org-card">
            <div class="org-hd">
              <span class="org-hd-t">{t('ui.organizePlan')}</span>
              <span class="org-hd-meta">
                {sugg.agent} · {t('ui.awaitingActionCount', { pending: sugg.actions.filter((a) => !a.applied).length, total: sugg.actions.length })}
              </span>
              {sugg.actions.some((a) => !a.applied) && (
                <button class="org-ignore" disabled={applying !== null} onClick={ignore}>
                  {t('ui.ignoreBatch')}
                </button>
              )}
            </div>
            {sugg.actions.map((a, i) => (
              <div class={`org-item${a.applied ? ' done' : ''}`} key={i}>
                <span class={`badge ${a.kind === 'merge' ? 'b-ai' : 'b-gray'}`}>
                  {(() => {
                    const message = actionKindMessage(a.kind);
                    return t(message.key, message.values);
                  })()}
                </span>
                <div class="org-item-tx">
                  <div class="org-label">
                    {(() => {
                      const message = actionMessage(a);
                      return t(message.key, message.values);
                    })()}
                  </div>
                  {a.reason && <div class="org-reason">{a.reason}</div>}
                </div>
                {a.applied ? (
                  <span class="org-applied">✓ {t('ui.executed')}</span>
                ) : (
                  <button class="org-apply" disabled={applying !== null} onClick={() => void applyAction(i)}>
                    {applying === i ? t('ui.executing') : t('ui.execute')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {modules === null ? (
          <div class="mut">{t('ui.loading')}</div>
        ) : modules.length === 0 ? (
          <div class="empty">{t('ui.noModules')}</div>
        ) : (
          <div class="mlist">
            {modules.map((m) => (
              <div class="mrow" key={m.id}>
                {editingId === m.id ? (
                  <>
                    <input
                      class="mrow-edit"
                      value={editName}
                      onInput={(e) => setEditName(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveRename(m);
                      }}
                    />
                    <button class="mrow-act save" disabled={busy || !editName.trim()} onClick={() => void saveRename(m)}>
                      {t('ui.save')}
                    </button>
                    <button class="mrow-act" disabled={busy} onClick={() => setEditingId(null)}>
                      {t('ui.cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <span class="mrow-main">
                      <span class="mrow-name" title={m.displayName}>{m.displayName}</span>
                      <span class="mrow-slug" title={m.slug}>{m.slug}</span>
                    </span>
                    <span class="mrow-meta">
                      <span class="mrow-src" title={t('ui.moduleSource')}>
                        {m.source === 'legacy' ? t('ui.migrated') : m.source === 'manual' ? t('ui.manual') : t('ui.automatic')}
                      </span>
                      <select
                        class="mrow-agent"
                        value={m.agent}
                        disabled={busy}
                        title={t('ui.moduleAgent')}
                        aria-label={`${m.displayName} · ${t('ui.moduleAgent')}`}
                        onChange={(e) => void changeAgent(m, e.currentTarget.value as AgentKind)}
                      >
                        {!supportedAgents.includes(m.agent) && <option value={m.agent}>{m.agent} ({t('ui.unavailable')})</option>}
                        {supportedAgents.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                      <span class="badge b-gray mrow-count" title={t('ui.relatedIssueCount')}>
                        {t('ui.moduleIssueCount', { count: issueCount(m.id) })}
                      </span>
                      <span class="mrow-acts">
                        <button
                          class="mrow-act"
                          disabled={busy}
                          onClick={() => {
                            setEditingId(m.id);
                            setEditName(m.displayName);
                          }}
                        >
                          {t('ui.rename')}
                        </button>
                        <button class="mrow-act danger" disabled={busy} onClick={() => void archive(m)}>
                          {t('ui.archive')}
                        </button>
                      </span>
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          {t('action.close')}
        </button>
      </div>
    </Modal>
  );
}
