/**
 * admin 后台（spec §7/§9-6；入口仅 role=admin 可见）：
 * - 用户：建/改名/角色/删/重置 token（新 token 一次性弹窗）/代编每用户设定
 * - 执行机：CRUD + status 徽标
 * - 项目归属调整（PUT /api/admin/projects/:id/owner）
 * - 活跃概览（GET /api/admin/overview）
 */
import { useEffect, useState } from 'preact/hooks';
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
import { AgentPicker } from '../components/AgentPicker';
import { DirPicker } from '../components/DirPicker';
import { tr } from '../i18n/runtime';

export type AdminTab = 'users' | 'execs' | 'llm' | 'owner' | 'overview';

export function AdminView({ initialTab = 'users' }: { initialTab?: AdminTab }) {
  const [tab, setTab] = useState<AdminTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const TABS: Array<[AdminTab, string]> = [
    ['users', tr('admin.users')],
    ['execs', tr('admin.executors')],
    ['llm', tr('admin.llm')],
    ['owner', tr('admin.ownership')],
    ['overview', tr('admin.overview')],
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
      {tab === 'owner' && <OwnerTab />}
      {tab === 'overview' && <OverviewTab />}
    </div>
  );
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
                  <span class={`badge ${d.commandFound || d.stateDirFound ? 'ok' : ''}`}>
                    {agent === 'claude' ? 'Claude' : 'Codex'}：
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
