/**
 * admin 后台（spec §7/§9-6；入口仅 role=admin 可见）：
 * - 用户：建/改名/角色/删/重置 token（新 token 一次性弹窗）/代编每用户设定
 * - 执行机：CRUD + status 徽标
 * - 项目归属调整（PUT /api/admin/projects/:id/owner）
 * - 活跃概览（GET /api/admin/overview）
 */
import { useEffect, useState } from 'preact/hooks';
import { FeishuLoginConfigTab } from './FeishuLoginConfigTab';
import { api, ApiError } from '../lib/api';
import { fmtTime, timeAgo } from '../lib/fmt';
import type {
  AdminUser,
  AdminLlmConfig,
  AgentKind,
  Executor,
  ExecutorDetection,
  OverviewUser,
  Project,
  Role,
  UserSettings,
} from '../lib/types';
import { buildLlmConfigUpdate } from '../lib/llmConfig';
import { ExecBadge } from '../components/badges';
import { Modal } from '../components/Modal';
import { Loading } from '../components/Loaders';
import { toast } from '../lib/toast';
import { AgentLogo } from '../components/AgentLogo';
import { AgentPicker } from '../components/AgentPicker';
import { DirPicker } from '../components/DirPicker';
import { runtimeI18n, tr } from '../i18n/runtime';

export type AdminTab = 'users' | 'execs' | 'llm' | 'feishu' | 'owner' | 'overview' | 'personaMarkets' | 'cost';

export function AdminView({ initialTab = 'users' }: { initialTab?: AdminTab }) {
  const [tab, setTab] = useState<AdminTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const TABS: Array<[AdminTab, string]> = [
    ['users', tr('admin.users')],
    ['execs', tr('admin.executors')],
    ['llm', tr('admin.llm')],
    ['feishu', tr('admin.feishu')],
    ['owner', tr('admin.ownership')],
    ['overview', tr('admin.overview')],
    ['personaMarkets', tr('admin.personaMarkets')],
    ['cost', tr('admin.cost')],
  ];
  return (
    <div class="page">
      <div class="h1">admin</div>
      <div class="subtabs">
        {TABS.map(([k, label]) => (
          <button key={k} class={`subtab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'users' && <UsersTab />}
      {tab === 'execs' && <ExecutorsTab />}
      {tab === 'llm' && <LlmConfigTab />}
      {tab === 'feishu' && <FeishuLoginConfigTab />}
      {tab === 'owner' && <OwnerTab />}
      {tab === 'overview' && <OverviewTab />}
      {tab === 'personaMarkets' && <PersonaMarketsTab />}
      {tab === 'cost' && <CostTab />}
    </div>
  );
}

interface PersonaMarketSource {
  id: number; name: string; repo: string; subdir: string; note: string; enabled: boolean;
  lastSyncTs: number | null; lastError: string | null; personaSourceEpoch: number;
}

function PersonaMarketsTab() {
  const [markets, setMarkets] = useState<PersonaMarketSource[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState(''); const [repo, setRepo] = useState('');
  const [subdir, setSubdir] = useState(''); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const load = (): void => { void api<{ markets: PersonaMarketSource[] }>('/api/admin/design-persona-markets').then((result) => { setMarkets(result.markets); setError(''); }).catch((cause: Error) => setError(cause.message)); };
  useEffect(load, []);
  const reset = () => { setEditing(null); setName(''); setRepo(''); setSubdir(''); setNote(''); };
  const save = async () => {
    if (busy || !name.trim() || !repo.trim()) return; setBusy('save');
    try {
      if (editing) await api(`/api/admin/design-persona-markets/${encodeURIComponent(editing)}`, 'PATCH', { repo: repo.trim(), subdir: subdir.trim(), note: note.trim() });
      else await api('/api/admin/design-persona-markets', 'POST', { name: name.trim(), repo: repo.trim(), subdir: subdir.trim(), note: note.trim() });
      reset(); load(); toast.success(tr('admin.personaMarketSaved'));
    } catch (cause) { toast.error(cause instanceof ApiError ? cause.message : String(cause)); }
    finally { setBusy(''); }
  };
  const sync = async (market: PersonaMarketSource) => {
    if (busy) return; setBusy(`sync-${market.name}`);
    try { await api(`/api/admin/design-persona-markets/${encodeURIComponent(market.name)}/sync`, 'POST'); load(); toast.success(tr('admin.personaMarketSynced')); }
    catch (cause) { toast.error(cause instanceof ApiError ? cause.message : String(cause)); }
    finally { setBusy(''); }
  };
  const toggle = async (market: PersonaMarketSource) => {
    if (busy) return; setBusy(`toggle-${market.name}`);
    try { await api(`/api/admin/design-persona-markets/${encodeURIComponent(market.name)}`, 'PATCH', { enabled: !market.enabled }); load(); }
    catch (cause) { toast.error(cause instanceof ApiError ? cause.message : String(cause)); }
    finally { setBusy(''); }
  };
  const remove = async (market: PersonaMarketSource) => {
    if (busy || !confirm(tr('admin.personaMarketDeleteConfirm', { name: market.name }))) return; setBusy(`delete-${market.name}`);
    try { await api(`/api/admin/design-persona-markets/${encodeURIComponent(market.name)}`, 'DELETE'); load(); toast.info(tr('admin.personaMarketDeleted')); }
    catch (cause) { toast.error(cause instanceof ApiError ? cause.message : String(cause)); }
    finally { setBusy(''); }
  };
  if (!markets && !error) return <Loading/>;
  return <div class="sect persona-market-admin"><div class="h2">{tr('admin.personaMarkets')}</div><p class="mut">{tr('admin.personaMarketsHelp')}</p>
    {error && <div class="err">{error}</div>}
    <div class="persona-market-form"><label>{tr('admin.personaMarketName')}<input value={name} disabled={editing !== null} onInput={(event) => setName(event.currentTarget.value)}/></label><label>{tr('admin.personaMarketRepo')}<input value={repo} onInput={(event) => setRepo(event.currentTarget.value)}/></label><label>{tr('admin.personaMarketSubdir')}<input value={subdir} onInput={(event) => setSubdir(event.currentTarget.value)}/></label><label>{tr('admin.personaMarketNote')}<input value={note} onInput={(event) => setNote(event.currentTarget.value)}/></label><div class="row"><button class="btn primary" disabled={!!busy || !name.trim() || !repo.trim()} onClick={() => void save()}>{editing ? tr('ui.save') : tr('admin.personaMarketCreate')}</button>{editing && <button class="btn" onClick={reset}>{tr('common.cancel')}</button>}</div></div>
    <div class="persona-market-list">{markets?.map((market) => <article><div class="row"><div class="grow"><strong>{market.name}</strong><code>{market.repo}</code><small>{market.subdir || tr('admin.personaMarketRoot')}</small></div><span class={`badge ${market.enabled ? 'b-green' : 'b-gray'}`}>{market.enabled ? tr('admin.personaMarketEnabled') : tr('admin.personaMarketDisabled')}</span></div>{market.note && <p>{market.note}</p>}{market.lastError && <div class="err">{market.lastError}</div>}<div class="row"><button class="btn" disabled={!!busy} onClick={() => { setEditing(market.name); setName(market.name); setRepo(market.repo); setSubdir(market.subdir); setNote(market.note); }}>{tr('ui.edit')}</button><button class="btn" disabled={!!busy} onClick={() => void toggle(market)}>{market.enabled ? tr('admin.personaMarketDisable') : tr('admin.personaMarketEnable')}</button><button class="btn" disabled={!!busy} onClick={() => void sync(market)}>{tr('admin.personaMarketSync')}</button><button class="btn danger" disabled={!!busy} onClick={() => void remove(market)}>{tr('ui.delete')}</button></div></article>)}</div>
  </div>;
}

// ---------- 驱动大模型 ----------

function LlmConfigTab() {
  const [config, setConfig] = useState<AdminLlmConfig | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const apply = (next: AdminLlmConfig): void => {
    setConfig(next);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setApiKey('');
  };

  useEffect(() => {
    api<AdminLlmConfig>('/api/admin/llm-config')
      .then(apply)
      .catch((e: Error) => setErr(e.message));
  }, []);

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ ok: boolean; config: AdminLlmConfig }>(
        '/api/admin/llm-config',
        'PUT',
        buildLlmConfigUpdate({ baseUrl, model, apiKey, clearApiKey: false }),
      );
      apply(r.config);
      toast.success(r.config.configured ? tr('admin.configApplied') : tr('admin.configIncomplete'));
    } catch (x) {
      const message = x instanceof ApiError ? x.message : String(x);
      setErr(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    if (busy || !confirm(tr('admin.clearKeyConfirm'))) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ ok: boolean; config: AdminLlmConfig }>(
        '/api/admin/llm-config',
        'PUT',
        buildLlmConfigUpdate({ baseUrl, model, apiKey: '', clearApiKey: true }),
      );
      apply(r.config);
      toast.info(tr('admin.keyCleared'));
    } catch (x) {
      const message = x instanceof ApiError ? x.message : String(x);
      setErr(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  if (!config && !err) return <Loading />;
  return (
    <div class="sect llm-config">
      <div class="row">
        <div class="grow">
          <div class="h2">{tr('admin.llm')}</div>
          <div class="mut small">{tr('admin.llmHelp')}</div>
        </div>
        <span class={`badge ${config?.configured ? 'b-green' : 'b-amber'}`}>
          {config?.configured ? tr('admin.configured') : tr('admin.notConfigured')}
        </span>
      </div>
      <label>
        {tr('admin.baseUrl')}
        <input
          value={baseUrl}
          placeholder="https://example.com/v1"
          onInput={(e) => setBaseUrl(e.currentTarget.value)}
        />
      </label>
      <label>
        {tr('admin.model')}
        <input
          value={model}
          placeholder="model-name"
          onInput={(e) => setModel(e.currentTarget.value)}
        />
      </label>
      <label>
        {tr('admin.apiKey')}
        <input
          type="password"
          value={apiKey}
          autocomplete="new-password"
          placeholder={config?.apiKeyConfigured ? tr('admin.keepKey') : tr('admin.enterKey')}
          onInput={(e) => setApiKey(e.currentTarget.value)}
        />
      </label>
      <div class="mut small">
        {config?.apiKeyConfigured
          ? tr('admin.currentKey', { key: config.apiKeyMasked })
          : tr('admin.noCurrentKey')}
      </div>
      {err && <div class="err">{err}</div>}
      <div class="row">
        <button class="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? tr('ui.saving') : tr('admin.saveConfig')}
        </button>
        {config?.apiKeyConfigured && (
          <button class="btn danger" disabled={busy} onClick={() => void clearKey()}>
            {tr('admin.clearKey')}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- 一次性 token 弹窗 ----------

function TokenModal({ title, token, extra, onClose }: { title: string; token: string; extra?: string[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard
      ?.writeText(token)
      .then(() => setCopied(true))
      .catch(() => {});
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div class="err">⚠ {tr('admin.tokenOnce')}</div>
      <div class="token-box">{token}</div>
      {extra && extra.length > 0 && <div class="mut small">{extra.join('\n')}</div>}
      <div class="mbtns">
        <button class="btn" onClick={copy}>
          {copied ? tr('ui.copied') : tr('ui.copy')}
        </button>
        <button class="btn primary" onClick={onClose}>
          {tr('admin.savedClose')}
        </button>
      </div>
    </Modal>
  );
}

// ---------- 用户 ----------

function UsersTab() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [tokenModal, setTokenModal] = useState<{ title: string; token: string; extra?: string[] } | null>(null);
  const [editSettings, setEditSettings] = useState<AdminUser | null>(null);

  const load = (): void => {
    api<AdminUser[]>('/api/admin/users').then(setUsers).catch((e: Error) => setErr(e.message));
  };
  useEffect(load, []);

  const fail = (x: unknown): void => {
    toast.error(x instanceof ApiError ? x.message : String(x));
  };

  const rename = async (u: AdminUser): Promise<void> => {
    const name = prompt(tr('admin.newUsernamePrompt'), u.username);
    if (!name || name === u.username) return;
    try {
      await api(`/api/admin/users/${u.id}`, 'PATCH', { username: name });
      load();
      toast.success(tr('admin.renamedUser', { name }));
    } catch (x) {
      fail(x);
    }
  };

  const toggleRole = async (u: AdminUser): Promise<void> => {
    const to: Role = u.role === 'admin' ? 'user' : 'admin';
    if (!confirm(tr('admin.changeRoleConfirm', { name: u.username, role: to }))) return;
    try {
      await api(`/api/admin/users/${u.id}`, 'PATCH', { role: to });
      load();
      toast.success(tr(to === 'admin' ? 'admin.promoted' : 'admin.demoted', { name: u.username }));
    } catch (x) {
      fail(x);
    }
  };

  const resetToken = async (u: AdminUser): Promise<void> => {
    if (!confirm(tr('admin.resetTokenConfirm', { name: u.username }))) return;
    try {
      const r = await api<{ ok: boolean; token: string }>(`/api/admin/users/${u.id}/token`, 'POST');
      setTokenModal({ title: tr('admin.newToken', { name: u.username }), token: r.token });
    } catch (x) {
      fail(x);
    }
  };

  const remove = async (u: AdminUser): Promise<void> => {
    if (!confirm(tr('admin.deleteUserConfirm', { name: u.username }))) return;
    try {
      await api(`/api/admin/users/${u.id}`, 'DELETE');
      load();
      toast.info(tr('admin.userDeleted', { name: u.username }));
    } catch (x) {
      fail(x);
    }
  };

  return (
    <div>
      <div class="row" style={{ marginBottom: 10 }}>
        <span class="grow mut small">{users ? tr('admin.userCount', { count: users.length }) : ''}</span>
        <button class="btn primary sm" onClick={() => setCreating(true)}>
          ＋ {tr('admin.createUser')}
        </button>
      </div>
      {err && <div class="err" style={{ marginBottom: 8 }}>{err}</div>}
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>{tr('admin.user')}</th>
              <th>{tr('admin.role')}</th>
              <th>{tr('admin.feishu')}</th>
              <th>{tr('admin.lastLogin')}</th>
              <th>{tr('admin.recentUse')}</th>
              <th>{tr('admin.tasksTodayTotal')}</th>
              <th>{tr('admin.messagesTodayTotal')}</th>
              <th>{tr('admin.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.id}>
                <td>
                  <b>{u.username}</b> <span class="mut small">#{u.id}</span>
                </td>
                <td>
                  <span class={`badge ${u.role === 'admin' ? 'b-amber' : 'b-gray'}`}>{u.role}</span>
                </td>
                <td>{u.feishuOpenid ? '✓' : '—'}</td>
                <td class="mut">{timeAgo(u.lastLoginTs)}</td>
                <td class="mut">{timeAgo(u.lastSeenTs)}</td>
                <td>
                  {u.todayTasks} <span class="mut">/ {u.totalTasks}</span>
                </td>
                <td>
                  {u.todayMessages} <span class="mut">/ {u.totalMessages}</span>
                </td>
                <td>
                  <div class="acts">
                    <button class="btn sm" onClick={() => void rename(u)}>
                      {tr('ui.rename')}
                    </button>
                    <button class="btn sm" onClick={() => void toggleRole(u)}>
                      {u.role === 'admin' ? tr('admin.demote') : tr('admin.promote')}
                    </button>
                    <button class="btn sm warn" onClick={() => void resetToken(u)}>
                      {tr('admin.resetToken')}
                    </button>
                    <button class="btn sm" onClick={() => setEditSettings(u)}>
                      {tr('admin.settings')}
                    </button>
                    <button class="btn sm danger" onClick={() => void remove(u)}>
                      {tr('admin.remove')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={(username, token, warnings) => {
            setCreating(false);
            load();
            setTokenModal({ title: tr('admin.newToken', { name: username }), token, extra: warnings });
          }}
        />
      )}
      {tokenModal && <TokenModal {...tokenModal} onClose={() => setTokenModal(null)} />}
      {editSettings && <UserSettingsModal user={editSettings} onClose={() => setEditSettings(null)} />}
    </div>
  );
}

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (username: string, token: string, warnings?: string[]) => void;
}) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!username.trim() || busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api<{
        ok: boolean;
        user: AdminUser;
        token: string;
        workspace?: { provisioned: string[]; warnings: string[] };
      }>('/api/admin/users', 'POST', { username: username.trim(), role });
      onCreated(r.user.username, r.token, r.workspace?.warnings?.length ? r.workspace.warnings : undefined);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
      setBusy(false);
    }
  };

  return (
    <Modal title={tr('admin.createUser')} onClose={onClose}>
      <div class="formcol">
        <label class="field">
          {tr('admin.username')}
          <input value={username} autocapitalize="off" onInput={(e) => setUsername(e.currentTarget.value)} />
        </label>
        <label class="field">
          {tr('admin.role')}
          <select value={role} onChange={(e) => setRole(e.currentTarget.value as Role)}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          {tr('ui.cancel')}
        </button>
        <button class="btn primary" disabled={busy || !username.trim()} onClick={submit}>
          {busy ? tr('ui.creating') : tr('ui.create')}
        </button>
      </div>
    </Modal>
  );
}

/** admin 代编某用户的 persona/memory/autopilot 默认 */
function UserSettingsModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [s, setS] = useState<UserSettings | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<UserSettings>(`/api/admin/users/${user.id}/settings`).then(setS).catch((e: Error) => setErr(e.message));
  }, [user.id]);

  const save = async (): Promise<void> => {
    if (!s || busy) return;
    setBusy(true);
    setErr('');
    try {
      await api(`/api/admin/users/${user.id}/settings`, 'PUT', {
        persona: s.persona,
        memory: s.memory,
        autopilotDefault: s.autopilotDefault,
        notifyPref: s.notifyPref,
      });
      toast.success(tr('admin.settingsSaved', { name: user.username }));
      onClose();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
      setBusy(false);
    }
  };

  return (
    <Modal title={tr('admin.userSettings', { name: user.username })} onClose={onClose}>
      {!s && !err && <Loading />}
      {s && (
        <div class="formcol">
          <label class="field">
            persona
            <textarea rows={3} value={s.persona ?? ''} onInput={(e) => setS({ ...s, persona: e.currentTarget.value || null })} />
          </label>
          <label class="field">
            memory
            <textarea rows={5} value={s.memory ?? ''} onInput={(e) => setS({ ...s, memory: e.currentTarget.value || null })} />
          </label>
          <label class="chkrow">
            <input
              type="checkbox"
              checked={s.autopilotDefault}
              onChange={(e) => setS({ ...s, autopilotDefault: e.currentTarget.checked })}
            />
            {tr('admin.autopilotDefault')}
          </label>
          <label class="field">
            {tr('admin.notificationPref')}
            <input value={s.notifyPref ?? ''} onInput={(e) => setS({ ...s, notifyPref: e.currentTarget.value || null })} />
          </label>
        </div>
      )}
      {err && <div class="err">{err}</div>}
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          {tr('ui.cancel')}
        </button>
        <button class="btn primary" disabled={busy || !s} onClick={save}>
          {busy ? tr('ui.saving') : tr('ui.save')}
        </button>
      </div>
    </Modal>
  );
}

// ---------- 执行机 ----------

const EMPTY_EXEC = {
  name: '',
  host: '',
  port: '22',
  sshUser: 'root',
  keyRef: '',
  workspaceRoot: '',
  claudeDir: '',
  codexDir: '',
};

function ExecutorsTab() {
  const [execs, setExecs] = useState<Executor[] | null>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<Executor | 'new' | null>(null);

  const load = (): void => {
    api<Executor[]>('/api/admin/executors').then(setExecs).catch((e: Error) => setErr(e.message));
  };
  useEffect(load, []);

  const remove = async (x: Executor): Promise<void> => {
    if (!confirm(tr('admin.deleteExecutorConfirm', { name: x.name }))) return;
    try {
      await api(`/api/admin/executors/${x.id}`, 'DELETE');
      load();
      toast.info(tr('admin.executorDeleted', { name: x.name }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div>
      <div class="row" style={{ marginBottom: 10 }}>
        <span class="grow mut small">{execs ? tr('admin.executorCount', { count: execs.length }) : ''}</span>
        <button class="btn primary sm" onClick={() => setEditing('new')}>
          ＋ {tr('admin.registerExecutor')}
        </button>
      </div>
      {err && <div class="err" style={{ marginBottom: 8 }}>{err}</div>}
      {(execs ?? []).map((x) => (
        <div key={x.id} class="card">
          <div class="row">
            <b class="grow">
              {x.name} <span class="mut small">#{x.id}</span>
            </b>
            <ExecBadge status={x.status} />
          </div>
          <div class="mono small mut" style={{ marginTop: 6 }}>
            {x.sshUser}@{x.host}:{x.port}
          </div>
          <div class="mono small mut">ws: {x.workspaceRoot} · claude: {x.claudeDir}</div>
          <div class="small mut">
            {tr('admin.agent')}: {[
              x.supportsClaude ? 'Claude' : '',
              x.supportsCodex ? 'Codex' : '',
            ].filter(Boolean).join(', ') || tr('admin.notConfigured')}
            {x.isSystemLocal && <span class="badge" style={{ marginLeft: 6 }}>{tr('admin.systemLocal')}</span>}
          </div>
          <div class="row" style={{ marginTop: 8 }}>
            <button class="btn sm" onClick={() => setEditing(x)}>
              {tr('ui.edit')}
            </button>
            {!x.isSystemLocal && (
              <button class="btn sm danger" onClick={() => void remove(x)}>{tr('ui.delete')}</button>
            )}
          </div>
        </div>
      ))}
      {execs !== null && execs.length === 0 && <div class="empty">{tr('admin.noExecutors')}</div>}
      {editing && (
        <ExecModal
          exec={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function ExecModal({ exec, onClose, onSaved }: { exec: Executor | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(() =>
    exec
      ? {
          name: exec.name,
          host: exec.host,
          port: String(exec.port),
          sshUser: exec.sshUser,
          keyRef: exec.keyRef,
          workspaceRoot: exec.workspaceRoot,
          claudeDir: exec.claudeDir,
          codexDir: exec.codexDir,
        }
      : { ...EMPTY_EXEC },
  );
  const [agents, setAgents] = useState<AgentKind[]>(() =>
    exec
      ? [
          ...(exec.supportsClaude ? (['claude'] as const) : []),
          ...(exec.supportsCodex ? (['codex'] as const) : []),
        ]
      : ['claude'],
  );
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<ExecutorDetection | null>(null);
  const [picking, setPicking] = useState<'workspaceRoot' | 'claudeDir' | 'codexDir' | null>(null);
  const previewConnection = {
    name: f.name.trim(),
    host: f.host.trim(),
    port: Number(f.port),
    sshUser: f.sshUser.trim(),
    keyRef: f.keyRef.trim(),
  };
  const previewIsLocal =
    (!previewConnection.host ||
      previewConnection.host === '127.0.0.1' ||
      previewConnection.host === 'localhost') &&
    !previewConnection.keyRef;
  const canUseConnection =
    !!exec ||
    (!!previewConnection.name &&
      Number.isInteger(previewConnection.port) &&
      previewConnection.port >= 1 &&
      previewConnection.port <= 65535 &&
      (previewIsLocal || (!!previewConnection.sshUser && !!previewConnection.keyRef)));

  const set = (k: keyof typeof EMPTY_EXEC) => (e: { currentTarget: { value: string } }) =>
    setF({ ...f, [k]: e.currentTarget.value });

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setErr('');
    const body = {
      name: f.name,
      workspaceRoot: f.workspaceRoot,
      claudeDir: f.claudeDir,
      codexDir: f.codexDir,
      supportsClaude: agents.includes('claude'),
      supportsCodex: agents.includes('codex'),
      capabilitiesCheckedTs: detection?.checkedTs ?? exec?.capabilitiesCheckedTs ?? null,
      ...(!exec?.isSystemLocal
        ? {
            host: f.host,
            port: Number(f.port),
            sshUser: f.sshUser,
            keyRef: f.keyRef,
          }
        : {}),
    };
    try {
      if (exec) await api(`/api/admin/executors/${exec.id}`, 'PATCH', body);
      else await api('/api/admin/executors', 'POST', body);
      toast.success(tr(exec ? 'admin.executorUpdated' : 'admin.executorRegistered', { name: f.name }));
      onSaved();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
      setBusy(false);
    }
  };

  const CONNECTION_FIELDS: Array<[keyof typeof EMPTY_EXEC, string, string]> = [
    ['name', tr('admin.name'), 'local-1'],
    ['host', tr('admin.host'), '10.0.0.2'],
    ['port', tr('admin.sshPort'), '22'],
    ['sshUser', tr('admin.sshUser'), 'root'],
    ['keyRef', tr('admin.keyRef'), '/Users/you/.ssh/id_ed25519'],
  ];

  const detect = async (): Promise<void> => {
    if (!canUseConnection || detecting) return;
    setDetecting(true);
    setErr('');
    try {
      const r = await api<{ ok: boolean; detection: ExecutorDetection }>(
        exec ? `/api/admin/executors/${exec.id}/detect` : '/api/admin/executors/preview/detect',
        'POST',
        {
          ...(!exec ? previewConnection : {}),
          workspaceRoot: f.workspaceRoot,
          claudeDir: f.claudeDir,
          codexDir: f.codexDir,
        },
      );
      setDetection(r.detection);
      const detected = (['claude', 'codex'] as AgentKind[]).filter((agent) => {
        const d = r.detection.agents[agent];
        return d.commandFound || d.stateDirFound;
      });
      if (detected.length > 0) setAgents(detected);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    } finally {
      setDetecting(false);
    }
  };

  const pathField = (
    key: 'workspaceRoot' | 'claudeDir' | 'codexDir',
    label: string,
    placeholder: string,
    suggestion?: string | null,
  ) => (
    <label class="field">
      {label}
      <div class="row exec-path-row">
        <input class="grow" value={f[key]} placeholder={placeholder} onInput={set(key)} />
        <button class="btn sm" disabled={!canUseConnection} onClick={() => setPicking(key)}>{tr('admin.chooseDirectory')}</button>
      </div>
      {!exec && !canUseConnection && (
        <span class="mut small">{tr('admin.connectionFirst')}</span>
      )}
      {suggestion && suggestion !== f[key] && (
        <span class="small">
          {tr('admin.suggestion')} <code>{suggestion}</code>{' '}
          <button class="linkbtn" onClick={() => setF({ ...f, [key]: suggestion })}>{tr('admin.useSuggestion')}</button>
        </span>
      )}
    </label>
  );

  return (
    <Modal title={exec ? tr('admin.editExecutor', { name: exec.name }) : tr('admin.registerExecutor')} onClose={onClose}>
      <div class="formcol">
        {CONNECTION_FIELDS.map(([k, label, ph]) => (
          <label key={k} class="field">
            {label}
            <input
              value={f[k]}
              placeholder={ph}
              onInput={set(k)}
              disabled={!!exec?.isSystemLocal && k !== 'name'}
            />
          </label>
        ))}
        {exec?.isSystemLocal && <div class="mut small">{tr('admin.localFixed')}</div>}
        <div class="field">
          <div class="row">
            <span class="grow">{tr('admin.availableAgents')}</span>
            <button class="btn sm" disabled={!canUseConnection || detecting} onClick={() => void detect()}>
              {detecting ? tr('admin.detecting') : tr('admin.autoDetect')}
            </button>
          </div>
          <AgentPicker value={agents} onChange={setAgents} />
          {detection && (
            <div class="detect-result small">
              {(['claude', 'codex'] as AgentKind[]).map((agent) => {
                const d = detection.agents[agent];
                return (
                  <span class={`badge ${d.commandFound || d.stateDirFound ? 'ok' : ''}`} key={agent}>
                    <AgentLogo agent={agent} size="xs" />
                    {d.commandFound ? tr('admin.commandDetected') : d.stateDirFound ? tr('admin.directoryExists') : tr('admin.notDetected')}
                  </span>
                );
              })}
              {detection.warnings.map((w) => <span class="warn">{w}</span>)}
            </div>
          )}
        </div>
        {pathField(
          'workspaceRoot',
          tr('admin.workspaceRoot'),
          '/Users/you/workspace',
          detection?.workspaceSuggestion,
        )}
        <details class="exec-advanced" open={!!exec}>
          <summary>{tr('admin.advanced')}</summary>
          <div class="formcol" style={{ marginTop: 8 }}>
            {agents.includes('claude') &&
              pathField(
                'claudeDir',
                tr('admin.claudeDir'),
                '/Users/you/.claude/projects',
                detection?.agents.claude.suggestedDir,
              )}
            {agents.includes('codex') &&
              pathField(
                'codexDir',
                tr('admin.codexDir'),
                '/Users/you/.codex/sessions',
                detection?.agents.codex.suggestedDir,
              )}
          </div>
        </details>
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          {tr('ui.cancel')}
        </button>
        <button class="btn primary" disabled={busy} onClick={submit}>
          {busy ? tr('ui.saving') : tr('ui.save')}
        </button>
      </div>
      {picking && canUseConnection && (
        <DirPicker
          {...(exec ? { executorId: exec.id } : { previewConnection })}
          start={f[picking]}
          onClose={() => setPicking(null)}
          onPick={(path) => {
            setF({ ...f, [picking]: path });
            setPicking(null);
          }}
        />
      )}
    </Modal>
  );
}

// ---------- 项目归属 ----------

function OwnerTab() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [err, setErr] = useState('');

  const load = (): void => {
    api<Project[]>('/api/projects').then(setProjects).catch((e: Error) => setErr(e.message));
    api<AdminUser[]>('/api/admin/users').then(setUsers).catch(() => {});
  };
  useEffect(load, []);

  const assign = async (p: Project, userId: number): Promise<void> => {
    try {
      await api(`/api/admin/projects/${p.id}/owner`, 'PUT', { userId });
      toast.success(tr('admin.ownerChanged', { project: p.name, owner: users.find((u) => u.id === userId)?.username ?? userId }));
      load();
    } catch (x) {
      toast.error(x instanceof ApiError ? x.message : String(x));
    }
  };

  return (
    <div>
      {err && <div class="err" style={{ marginBottom: 8 }}>{err}</div>}
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>{tr('admin.project')}</th>
              <th>{tr('admin.status')}</th>
              <th>{tr('admin.owner')}</th>
            </tr>
          </thead>
          <tbody>
            {(projects ?? []).map((p) => (
              <tr key={p.id}>
                <td>
                  <b>{p.name}</b> <span class="mut small">#{p.id}</span>
                </td>
                <td>
                  <span class={`badge ${p.status === 'active' ? 'b-green' : 'b-gray'}`}>{p.status}</span>
                </td>
                <td>
                  <select
                    value={String(p.ownerUserId)}
                    onChange={(e) => void assign(p, Number(e.currentTarget.value))}
                    style={{ width: 'auto', padding: '6px 8px', fontSize: 13 }}
                  >
                    {users.map((u) => (
                      <option key={u.id} value={String(u.id)}>
                        {u.username}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {projects !== null && projects.length === 0 && <div class="empty">{tr('admin.noProjects')}</div>}
    </div>
  );
}

// ---------- 活跃概览 ----------

/** 成本视图（#282 / I-08、I-09）：跨所有项目，仅管理员可见 */
interface UsageTotalsView {
  requests: number; inputTokens: number; cachedInputTokens: number; outputTokens: number;
  reasoningTokens: number; compactions: number; toolCalls: number; skillReads: number;
}
interface UsageBucketView extends UsageTotalsView { projectId: number; projectName: string; costUsd: number }
interface IssueCostView {
  issueId: number; projectId: number; projectName: string; title: string; status: string; createdTs: number;
  usage: UsageTotalsView; testRetries: number; nudges: number; judged: number; clarifies: number;
  validationMs: number; validationRuns: number; costUsd: number;
}
interface UsageResponse {
  grand: UsageTotalsView;
  grandCostUsd: number;
  pricing: { currency: string; inputPerMTok: number; cachedInputPerMTok: number; outputPerMTok: number };
  projects: UsageBucketView[];
  chat: UsageBucketView[];
  unattributed: UsageBucketView[];
  issues: IssueCostView[];
}

/** 周度视图（#295）：按模块把钱与「完成 / 失败 / 恢复」并排看 */
interface WeeklyOutcomes {
  doneCount: number; blockedCount: number; cancelledCount: number; failedCount: number;
  outcomeCount: number; failureRate: number; recoveredCount: number; recoveryRate: number;
}
interface WeeklyModuleView {
  projectId: number; projectName: string; moduleId: number; moduleSlug: string; moduleName: string;
  usage: UsageTotalsView; costUsd: number;
  /** 未归因桶没有 issue，也就没有结局指标——后端给 null，前端照原样显示「—」 */
  outcomes: WeeklyOutcomes | null;
}
interface WeeklyResponse {
  week: { start: string; end: string; days: string[]; fromMs: number; toMs: number };
  pricing: { currency: string };
  days: Array<{ day: string; usage: UsageTotalsView; costUsd: number }>;
  modules: WeeklyModuleView[];
  totals: {
    usage: UsageTotalsView; costUsd: number; doneCount: number; blockedCount: number;
    cancelledCount: number; failedCount: number; outcomeCount: number; failureRate: number;
    recoveredCount: number; recoveryRate: number;
  };
}

/** 未归模块 / 未归因两个哨兵桶（口径见 core/usage-store） */
const MODULE_NONE = 0;
const MODULE_UNATTRIBUTED = -1;

/** 日键 + n 天：周切换按日历走，不碰时区（日键本身就是北京时间的墙上日期） */
function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d) + n * 86_400_000).toISOString().slice(0, 10);
}

/** 大数字压成 k/M：成本表里全是六七位数，原样铺开没法看 */
function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 金额：小额也要看得见，统一四位小数 */
function money(v: number): string {
  return `$${v.toFixed(4)}`;
}

/** 比率按 locale 格式化；没有分母（还没有结局 / 未归因桶）显示「—」，不写成 0% 冒充健康 */
function percent(v: number | null): string {
  if (v === null) return '—';
  return new Intl.NumberFormat(runtimeI18n().locale, { style: 'percent', maximumFractionDigits: 0 }).format(v);
}

function tokenCell(u: UsageTotalsView): string {
  return `${compactNumber(u.inputTokens)} / ${compactNumber(u.cachedInputTokens)} / ${compactNumber(u.outputTokens)} / ${compactNumber(u.reasoningTokens)}`;
}

/**
 * 周度视图（#295）：回答「只优化 token，有没有把可靠性一起优化没了」。
 * 口径（北京时间日切、周一起算、失败率与恢复率的分母）在后端 core/usage-weekly 收口，
 * 这里只负责翻周与展示——**不要在前端再算一遍比率**，两边算法迟早会分叉。
 */
function WeeklyPanel({ projectId }: { projectId: string }) {
  const [week, setWeek] = useState('');       // 空 = 本周（由后端定）
  const [data, setData] = useState<WeeklyResponse | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (week) params.set('weekStart', week);
    if (projectId.trim()) params.set('projectId', projectId.trim());
    api<WeeklyResponse>(`/api/admin/usage/weekly${params.size ? `?${params.toString()}` : ''}`)
      .then((r) => { setData(r); setErr(''); })
      .catch((e: Error) => setErr(e.message));
  }, [week, projectId]);

  const start = data?.week.start ?? '';
  const moduleLabel = (m: WeeklyModuleView): string => {
    if (m.moduleId === MODULE_UNATTRIBUTED) return tr('admin.costUnattributed');
    if (m.moduleId === MODULE_NONE) return tr('admin.costUnmoduled');
    return m.moduleName || m.moduleSlug || `#${m.moduleId}`;
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div class="row" style={{ gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <b>{tr('admin.costWeekly')}</b>
        <button class="btn sm" disabled={!start} onClick={() => setWeek(shiftDay(start, -7))}>
          {tr('admin.costWeekPrev')}
        </button>
        <button class="btn sm" disabled={!week} onClick={() => setWeek('')}>{tr('admin.costWeekThis')}</button>
        <button class="btn sm" disabled={!start} onClick={() => setWeek(shiftDay(start, 7))}>
          {tr('admin.costWeekNext')}
        </button>
        <span class="mono">
          {data ? tr('admin.costWeekRange', { start: data.week.start, end: data.week.end }) : '—'}
        </span>
      </div>
      {err && <div class="err" style={{ marginBottom: 8 }}>{err}</div>}

      <div class="mut small" style={{ marginBottom: 6 }}>
        {tr('admin.costAmount')}：<b class="mono">{data ? money(data.totals.costUsd) : '—'}</b>
        {'　'}{tr('admin.costDone')}：<b class="mono">{data?.totals.doneCount ?? '—'}</b>
        {'　'}{tr('admin.costFailureRate')}：
        <b class="mono">{data && data.totals.outcomeCount > 0 ? percent(data.totals.failureRate) : '—'}</b>
        {'　'}{tr('admin.costRecoveryRate')}：
        <b class="mono">{data && data.totals.blockedCount > 0 ? percent(data.totals.recoveryRate) : '—'}</b>
      </div>

      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>{tr('admin.costDay')}</th>
              <th>{tr('admin.costAmount')}</th>
              <th>{tr('admin.costTokens')}</th>
              <th>{tr('admin.costRequests')}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.days ?? []).map((d) => (
              <tr key={d.day}>
                <td class="mono">{d.day}</td>
                <td class="mono">{money(d.costUsd)}</td>
                <td class="mono">{tokenCell(d.usage)}</td>
                <td class="mono">{d.usage.requests}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="tblwrap" style={{ marginTop: 12 }}>
        <table class="tbl">
          <thead>
            <tr>
              <th>{tr('admin.costModule')}</th>
              <th>{tr('admin.project')}</th>
              <th>{tr('admin.costAmount')}</th>
              <th>{tr('admin.costDone')}</th>
              <th>{tr('admin.costFailureRate')}</th>
              <th>{tr('admin.costRecoveryRate')}</th>
              <th>{tr('admin.costTokens')}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.modules ?? []).map((m) => (
              <tr key={`${m.projectId}-${m.moduleId}`}>
                <td>{moduleLabel(m)}</td>
                <td>{m.projectName || `#${m.projectId}`}</td>
                <td class="mono">{money(m.costUsd)}</td>
                <td class="mono">{m.outcomes ? m.outcomes.doneCount : '—'}</td>
                {/* 没有结局的模块（还在跑）不写 0%，那会把「不知道」说成「很健康」 */}
                <td class="mono">{percent(m.outcomes && m.outcomes.outcomeCount > 0 ? m.outcomes.failureRate : null)}</td>
                <td class="mono">{percent(m.outcomes && m.outcomes.blockedCount > 0 ? m.outcomes.recoveryRate : null)}</td>
                <td class="mono">{tokenCell(m.usage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="mut small" style={{ marginTop: 6 }}>{tr('admin.costWeeklyNote')}</div>
    </div>
  );
}

function CostTab() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [err, setErr] = useState('');
  const [projectId, setProjectId] = useState('');
  const [days, setDays] = useState('7');

  const load = (): void => {
    const params = new URLSearchParams();
    if (projectId.trim()) params.set('projectId', projectId.trim());
    if (days.trim() && Number(days) > 0) params.set('from', String(Date.now() - Number(days) * 86_400_000));
    api<UsageResponse>(`/api/admin/usage${params.size ? `?${params.toString()}` : ''}`)
      .then((r) => { setData(r); setErr(''); })
      .catch((e: Error) => setErr(e.message));
  };
  useEffect(load, [projectId, days]);

  const bucketRows = (rows: UsageBucketView[], label: string) => rows.map((r) => (
    <tr key={`${label}-${r.projectId}`}>
      <td>{label}</td>
      <td>{r.projectName || `#${r.projectId}`}</td>
      <td class="mono">{money(r.costUsd)}</td>
      <td class="mono">{tokenCell(r)}</td>
      <td class="mono">{r.requests}</td>
      <td class="mono">{r.toolCalls}</td>
      <td class="mono">{r.compactions}</td>
    </tr>
  ));

  return (
    <div>
      {err && <div class="err" style={{ marginBottom: 8 }}>{err}</div>}
      <div class="row" style={{ gap: 8, marginBottom: 8 }}>
        <input
          aria-label={tr('admin.project')}
          value={projectId}
          onInput={(e) => setProjectId(e.currentTarget.value)}
          style={{ width: 120 }}
        />
        <select
          aria-label={tr('admin.costWindowNote')}
          value={days}
          onChange={(e) => setDays(e.currentTarget.value)}
        >
          {['1', '7', '30', ''].map((d) => (
            <option key={d || 'all'} value={d}>{d ? `${d}d` : '∞'}</option>
          ))}
        </select>
        <button class="btn sm" onClick={() => { void api('/api/admin/usage/rescan', 'POST', {}).then(load).catch((e: Error) => setErr(e.message)); }}>
          {tr('admin.costRescan')}
        </button>
        <span class="mut small">{tr('admin.costWindowNote')}</span>
      </div>

      <div class="mut small" style={{ marginBottom: 6 }}>
        {tr('admin.costAmount')}：<b class="mono">{data ? money(data.grandCostUsd) : '—'}</b>
        {'　'}{tr('admin.costTokens')}：<b class="mono">{data ? tokenCell(data.grand) : '—'}</b>
        {'　'}{tr('admin.costRequests')}：<b class="mono">{data?.grand.requests ?? '—'}</b>
        {'　'}{tr('admin.costTools')}：<b class="mono">{data?.grand.toolCalls ?? '—'}</b>
        {'　'}{tr('admin.costCompactions')}：<b class="mono">{data?.grand.compactions ?? '—'}</b>
      </div>

      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>{tr('admin.scope')}</th>
              <th>{tr('admin.project')}</th>
              <th>{tr('admin.costAmount')}</th>
              <th>{tr('admin.costTokens')}</th>
              <th>{tr('admin.costRequests')}</th>
              <th>{tr('admin.costTools')}</th>
              <th>{tr('admin.costCompactions')}</th>
            </tr>
          </thead>
          <tbody>
            {bucketRows(data?.projects ?? [], tr('admin.project'))}
            {bucketRows(data?.chat ?? [], tr('admin.costChat'))}
            {bucketRows(data?.unattributed ?? [], tr('admin.costUnattributed'))}
          </tbody>
        </table>
      </div>

      <div class="tblwrap" style={{ marginTop: 12 }}>
        <table class="tbl">
          <thead>
            <tr>
              <th>issue</th>
              <th>{tr('admin.project')}</th>
              <th>{tr('admin.costAmount')}</th>
              <th>{tr('admin.costTokens')}</th>
              <th>{tr('admin.costRequests')}</th>
              <th>{tr('admin.costTools')}</th>
              <th>{tr('admin.costRetries')}</th>
              <th>{`nudge / judge`}</th>
              <th>{tr('admin.costGateTime')}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.issues ?? []).map((r) => (
              <tr key={r.issueId}>
                <td><b>#{r.issueId}</b> {r.title}</td>
                <td>{r.projectName || `#${r.projectId}`}</td>
                <td class="mono">{money(r.costUsd)}</td>
                <td class="mono">{tokenCell(r.usage)}</td>
                <td class="mono">{r.usage.requests}</td>
                <td class="mono">{r.usage.toolCalls}</td>
                <td class="mono">{r.testRetries}</td>
                <td class="mono">{r.nudges} / {r.judged}</td>
                <td class="mono">{`${Math.round(r.validationMs / 1000)}s`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <WeeklyPanel projectId={projectId} />
    </div>
  );
}

function OverviewTab() {
  const [rows, setRows] = useState<OverviewUser[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api<{ users: OverviewUser[] }>('/api/admin/overview')
      .then((r) => setRows(r.users))
      .catch((e: Error) => setErr(e.message));
  }, []);

  return (
    <div>
      {err && <div class="err" style={{ marginBottom: 8 }}>{err}</div>}
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>{tr('admin.user')}</th>
              <th>{tr('admin.role')}</th>
              <th>{tr('admin.projectCount')}</th>
              <th>{tr('admin.lastLogin')}</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id}>
                <td>
                  <b>{r.username}</b>
                </td>
                <td>
                  <span class={`badge ${r.role === 'admin' ? 'b-amber' : 'b-gray'}`}>{r.role}</span>
                </td>
                <td>{r.projectCount}</td>
                <td class="mut">{r.lastLoginTs ? `${timeAgo(r.lastLoginTs)} (${fmtTime(r.lastLoginTs)})` : tr('admin.never')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
