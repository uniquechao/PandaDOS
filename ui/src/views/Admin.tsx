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

export type AdminTab = 'users' | 'execs' | 'llm' | 'owner' | 'overview';

export function AdminView({ initialTab = 'users' }: { initialTab?: AdminTab }) {
  const [tab, setTab] = useState<AdminTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const TABS: Array<[AdminTab, string]> = [
    ['users', '用户'],
    ['execs', '执行机'],
    ['llm', '驱动大模型'],
    ['owner', '项目归属'],
    ['overview', '活跃概览'],
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
      toast.success(r.config.configured ? '驱动大模型配置已生效' : '配置已保存，但尚不完整');
    } catch (x) {
      const message = x instanceof ApiError ? x.message : String(x);
      setErr(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    if (busy || !confirm('清除当前 API Key？依赖驱动大模型的功能将暂停。')) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ ok: boolean; config: AdminLlmConfig }>(
        '/api/admin/llm-config',
        'PUT',
        buildLlmConfigUpdate({ baseUrl, model, apiKey: '', clearApiKey: true }),
      );
      apply(r.config);
      toast.info('API Key 已清除');
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
          <div class="h2">驱动大模型</div>
          <div class="mut small">支持 OpenAI-compatible Chat Completions 接口，保存后立即生效。</div>
        </div>
        <span class={`badge ${config?.configured ? 'b-green' : 'b-amber'}`}>
          {config?.configured ? '已配置' : '未配置'}
        </span>
      </div>
      <label>
        接口地址
        <input
          value={baseUrl}
          placeholder="https://example.com/v1"
          onInput={(e) => setBaseUrl(e.currentTarget.value)}
        />
      </label>
      <label>
        模型名称
        <input
          value={model}
          placeholder="model-name"
          onInput={(e) => setModel(e.currentTarget.value)}
        />
      </label>
      <label>
        API Key
        <input
          type="password"
          value={apiKey}
          autocomplete="new-password"
          placeholder={config?.apiKeyConfigured ? '留空表示保留当前 Key' : '请输入 API Key'}
          onInput={(e) => setApiKey(e.currentTarget.value)}
        />
      </label>
      <div class="mut small">
        {config?.apiKeyConfigured
          ? `当前 Key：${config.apiKeyMasked}（明文不会被读取或回显）`
          : '当前未配置 API Key'}
      </div>
      {err && <div class="err">{err}</div>}
      <div class="row">
        <button class="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存配置'}
        </button>
        {config?.apiKeyConfigured && (
          <button class="btn danger" disabled={busy} onClick={() => void clearKey()}>
            清除 API Key
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
      <div class="err">⚠ token 明文只显示这一次，关掉就没了——现在就复制发给用户。</div>
      <div class="token-box">{token}</div>
      {extra && extra.length > 0 && <div class="mut small">{extra.join('\n')}</div>}
      <div class="mbtns">
        <button class="btn" onClick={copy}>
          {copied ? '已复制 ✓' : '复制'}
        </button>
        <button class="btn primary" onClick={onClose}>
          我已保存，关闭
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
    const name = prompt('新用户名（字母数字 _ -）', u.username);
    if (!name || name === u.username) return;
    try {
      await api(`/api/admin/users/${u.id}`, 'PATCH', { username: name });
      load();
      toast.success(`已改名为 ${name}`);
    } catch (x) {
      fail(x);
    }
  };

  const toggleRole = async (u: AdminUser): Promise<void> => {
    const to: Role = u.role === 'admin' ? 'user' : 'admin';
    if (!confirm(`把 ${u.username} 的角色改成 ${to}？`)) return;
    try {
      await api(`/api/admin/users/${u.id}`, 'PATCH', { role: to });
      load();
      toast.success(`${u.username} 已${to === 'admin' ? '升为 admin' : '降为 user'}`);
    } catch (x) {
      fail(x);
    }
  };

  const resetToken = async (u: AdminUser): Promise<void> => {
    if (!confirm(`重置 ${u.username} 的 token？旧 token 立即失效。`)) return;
    try {
      const r = await api<{ ok: boolean; token: string }>(`/api/admin/users/${u.id}/token`, 'POST');
      setTokenModal({ title: `${u.username} 的新 token`, token: r.token });
    } catch (x) {
      fail(x);
    }
  };

  const remove = async (u: AdminUser): Promise<void> => {
    if (!confirm(`删除用户 ${u.username}？`)) return;
    try {
      await api(`/api/admin/users/${u.id}`, 'DELETE');
      load();
      toast.info(`已删除用户 ${u.username}`);
    } catch (x) {
      fail(x);
    }
  };

  return (
    <div>
      <div class="row" style={{ marginBottom: 10 }}>
        <span class="grow mut small">{users ? `${users.length} 个用户` : ''}</span>
        <button class="btn primary sm" onClick={() => setCreating(true)}>
          ＋ 建用户
        </button>
      </div>
      {err && <div class="err" style={{ marginBottom: 8 }}>{err}</div>}
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>用户</th>
              <th>角色</th>
              <th>飞书</th>
              <th>上次登录</th>
              <th>最近使用</th>
              <th>任务（今天/总）</th>
              <th>消息（今天/总）</th>
              <th>操作</th>
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
                      改名
                    </button>
                    <button class="btn sm" onClick={() => void toggleRole(u)}>
                      {u.role === 'admin' ? '降为 user' : '升为 admin'}
                    </button>
                    <button class="btn sm warn" onClick={() => void resetToken(u)}>
                      重置 token
                    </button>
                    <button class="btn sm" onClick={() => setEditSettings(u)}>
                      设定
                    </button>
                    <button class="btn sm danger" onClick={() => void remove(u)}>
                      删
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
            setTokenModal({ title: `${username} 的 token`, token, extra: warnings });
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
    <Modal title="建用户" onClose={onClose}>
      <div class="formcol">
        <label class="field">
          用户名（字母数字 _ -）
          <input value={username} autocapitalize="off" onInput={(e) => setUsername(e.currentTarget.value)} />
        </label>
        <label class="field">
          角色
          <select value={role} onChange={(e) => setRole(e.currentTarget.value as Role)}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          取消
        </button>
        <button class="btn primary" disabled={busy || !username.trim()} onClick={submit}>
          {busy ? '创建中…' : '创建'}
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
      toast.success(`已保存 ${user.username} 的设定`);
      onClose();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
      setBusy(false);
    }
  };

  return (
    <Modal title={`${user.username} 的设定`} onClose={onClose}>
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
            新会话默认开自动驾驶
          </label>
          <label class="field">
            通知偏好（JSON）
            <input value={s.notifyPref ?? ''} onInput={(e) => setS({ ...s, notifyPref: e.currentTarget.value || null })} />
          </label>
        </div>
      )}
      {err && <div class="err">{err}</div>}
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          取消
        </button>
        <button class="btn primary" disabled={busy || !s} onClick={save}>
          {busy ? '保存中…' : '保存'}
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
    if (!confirm(`删除执行机 ${x.name}？`)) return;
    try {
      await api(`/api/admin/executors/${x.id}`, 'DELETE');
      load();
      toast.info(`已删除执行机 ${x.name}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div>
      <div class="row" style={{ marginBottom: 10 }}>
        <span class="grow mut small">{execs ? `${execs.length} 台执行机` : ''}</span>
        <button class="btn primary sm" onClick={() => setEditing('new')}>
          ＋ 登记执行机
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
            Agent：{[
              x.supportsClaude ? 'Claude' : '',
              x.supportsCodex ? 'Codex' : '',
            ].filter(Boolean).join('、') || '未配置'}
            {x.isSystemLocal && <span class="badge" style={{ marginLeft: 6 }}>系统本机</span>}
          </div>
          <div class="row" style={{ marginTop: 8 }}>
            <button class="btn sm" onClick={() => setEditing(x)}>
              编辑
            </button>
            {!x.isSystemLocal && (
              <button class="btn sm danger" onClick={() => void remove(x)}>删除</button>
            )}
          </div>
        </div>
      ))}
      {execs !== null && execs.length === 0 && <div class="empty">还没有执行机</div>}
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
      toast.success(exec ? `已更新执行机 ${f.name}` : `已登记执行机 ${f.name}`);
      onSaved();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
      setBusy(false);
    }
  };

  const CONNECTION_FIELDS: Array<[keyof typeof EMPTY_EXEC, string, string]> = [
    ['name', '名称', 'local-1'],
    ['host', 'host（留空 = 本机执行机）', '10.0.0.2'],
    ['port', 'SSH 端口', '22'],
    ['sshUser', 'SSH 用户（本机执行机可留空）', 'root'],
    ['keyRef', '私钥路径或引用名（引用名从 ~/.mando/keys/ 读取；本机留空）', '/Users/you/.ssh/id_ed25519'],
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
        <button class="btn sm" disabled={!canUseConnection} onClick={() => setPicking(key)}>选择目录</button>
      </div>
      {!exec && !canUseConnection && (
        <span class="mut small">请先填写名称和有效连接信息，即可检测并浏览远端目录。</span>
      )}
      {suggestion && suggestion !== f[key] && (
        <span class="small">
          建议：<code>{suggestion}</code>{' '}
          <button class="linkbtn" onClick={() => setF({ ...f, [key]: suggestion })}>采用建议</button>
        </span>
      )}
    </label>
  );

  return (
    <Modal title={exec ? `编辑执行机 ${exec.name}` : '登记执行机'} onClose={onClose}>
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
        {exec?.isSystemLocal && <div class="mut small">系统本机执行机的 host 与 SSH 配置固定为本机。</div>}
        <div class="field">
          <div class="row">
            <span class="grow">可用 Agent</span>
            <button class="btn sm" disabled={!canUseConnection || detecting} onClick={() => void detect()}>
              {detecting ? '检测中…' : '自动检测'}
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
                    {d.commandFound ? '命令已检测' : d.stateDirFound ? '目录存在' : '未检测到'}
                  </span>
                );
              })}
              {detection.warnings.map((w) => <span class="warn">{w}</span>)}
            </div>
          )}
        </div>
        {pathField(
          'workspaceRoot',
          'workspace 根',
          '/Users/you/workspace',
          detection?.workspaceSuggestion,
        )}
        <details class="exec-advanced" open={!!exec}>
          <summary>高级设置（Agent 会话目录）</summary>
          <div class="formcol" style={{ marginTop: 8 }}>
            {agents.includes('claude') &&
              pathField(
                'claudeDir',
                'Claude projects 目录',
                '/Users/you/.claude/projects',
                detection?.agents.claude.suggestedDir,
              )}
            {agents.includes('codex') &&
              pathField(
                'codexDir',
                'Codex sessions 目录',
                '/Users/you/.codex/sessions',
                detection?.agents.codex.suggestedDir,
              )}
          </div>
        </details>
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          取消
        </button>
        <button class="btn primary" disabled={busy} onClick={submit}>
          {busy ? '保存中…' : '保存'}
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
      toast.success(`已把「${p.name}」转给 ${users.find((u) => u.id === userId)?.username ?? userId}`);
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
              <th>项目</th>
              <th>状态</th>
              <th>属主</th>
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
      {projects !== null && projects.length === 0 && <div class="empty">没有项目</div>}
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
              <th>用户</th>
              <th>角色</th>
              <th>项目数</th>
              <th>上次登录</th>
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
                <td class="mut">{r.lastLoginTs ? `${timeAgo(r.lastLoginTs)}（${fmtTime(r.lastLoginTs)}）` : '从未'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
