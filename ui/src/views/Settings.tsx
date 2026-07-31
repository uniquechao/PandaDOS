/**
 * 我的设定（spec §9-5）：
 * - GET/PUT /api/me/settings（persona/memory/autopilotDefault/notifyPref）
 * - 飞书绑定 POST /api/me/feishu {openid}（成功=测试消息已发；{openid:null} 解绑）
 * - 订阅管理 GET /api/me/subscriptions + DELETE /api/subscriptions
 */
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import { fmtTime } from '../lib/fmt';
import type { Me, Project, Subscription, UserSettings } from '../lib/types';
import { Loading } from '../components/Loaders';
import { toast } from '../lib/toast';

export function SettingsView({ me, onLogout }: { me: Me; onLogout: () => void }) {
  return (
    <div class="page">
      <div class="h1">我的设定</div>
      <AccountSect me={me} onLogout={onLogout} />
      <MySettingsSect />
      <FeishuSect me={me} />
      <SubscriptionsSect />
    </div>
  );
}

function AccountSect({ me, onLogout }: { me: Me; onLogout: () => void }) {
  return (
    <div class="sect">
      <div class="h2">账号</div>
      <div class="row">
        <span class="grow">
          <b>{me.username}</b> <span class={`badge ${me.role === 'admin' ? 'b-amber' : 'b-gray'}`}>{me.role}</span>
        </span>
        <button class="btn sm danger ghost" onClick={onLogout}>
          退出登录
        </button>
      </div>
      <div class="mut small">上次登录：{fmtTime(me.lastLoginTs)}</div>
    </div>
  );
}

function MySettingsSect() {
  const [s, setS] = useState<UserSettings | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<UserSettings>('/api/me/settings').then(setS).catch((e: Error) => setErr(e.message));
  }, []);

  const save = async (): Promise<void> => {
    if (!s || busy) return;
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      const r = await api<{ ok: boolean; settings: UserSettings }>('/api/me/settings', 'PUT', {
        persona: s.persona,
        memory: s.memory,
        autopilotDefault: s.autopilotDefault,
        notifyPref: s.notifyPref,
      });
      setS(r.settings);
      toast.success('设定已保存');
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
    setBusy(false);
  };

  if (!s) return <div class="sect">{err ? <div class="err">{err}</div> : <Loading />}</div>;

  return (
    <div class="sect">
      <div class="h2">Persona / 记忆</div>
      <label class="field">
        persona（管家怎么称呼/对待你）
        <textarea
          rows={3}
          value={s.persona ?? ''}
          onInput={(e) => setS({ ...s, persona: e.currentTarget.value || null })}
        />
      </label>
      <label class="field">
        memory（长期记忆，管家每次都会带上）
        <textarea
          rows={6}
          value={s.memory ?? ''}
          onInput={(e) => setS({ ...s, memory: e.currentTarget.value || null })}
        />
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
        通知偏好（JSON，可留空）
        <input
          value={s.notifyPref ?? ''}
          onInput={(e) => setS({ ...s, notifyPref: e.currentTarget.value || null })}
          placeholder='{"quiet":"23:00-08:00"}'
        />
      </label>
      {err && <div class="err">{err}</div>}
      {msg && <div class="okmsg">{msg}</div>}
      <button class="btn primary" disabled={busy} onClick={save}>
        {busy ? '保存中…' : '保存设定'}
      </button>
    </div>
  );
}

function FeishuSect({ me }: { me: Me }) {
  const [openid, setOpenid] = useState('');
  const [bound, setBound] = useState<string | null>(me.feishuOpenid);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanOn, setScanOn] = useState(false);

  useEffect(() => {
    api<{ enabled: boolean }>('/api/feishu/oauth/status')
      .then((r) => setScanOn(r.enabled))
      .catch(() => {});
  }, []);

  const bind = async (): Promise<void> => {
    if (!openid.trim() || busy) return;
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      const r = await api<{ ok: boolean; feishuOpenid: string }>('/api/me/feishu', 'POST', {
        openid: openid.trim(),
      });
      setBound(r.feishuOpenid);
      setOpenid('');
      toast.success('绑定成功，测试消息已发送——去飞书确认收到 ✅');
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
    setBusy(false);
  };

  const unbind = async (): Promise<void> => {
    if (busy || !confirm('解绑飞书？之后不再收到通知。')) return;
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      await api('/api/me/feishu', 'POST', { openid: null });
      setBound(null);
      toast.info('已解绑飞书');
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
    setBusy(false);
  };

  return (
    <div class="sect">
      <div class="h2">飞书通知绑定</div>
      {bound ? (
        <div class="row">
          <span class="grow">
            已绑定：<span class="mono small">{bound}</span>
          </span>
          <button class="btn sm danger ghost" disabled={busy} onClick={unbind}>
            解绑
          </button>
        </div>
      ) : (
        <>
          {scanOn && (
            <div class="row">
              <button
                class="btn primary"
                disabled={busy}
                onClick={() => {
                  location.href = '/api/feishu/oauth/bind';
                }}
              >
                🛩 飞书扫码绑定
              </button>
              <span class="mut small">推荐：跳转飞书授权，自动回填 openid</span>
            </div>
          )}
          <div class="row">
            <input
              class="grow"
              value={openid}
              placeholder="你的飞书 openid（ou_…）"
              onInput={(e) => setOpenid(e.currentTarget.value)}
            />
            <button class="btn" disabled={busy || !openid.trim()} onClick={bind}>
              {busy ? '验证中…' : '手动绑定'}
            </button>
          </div>
        </>
      )}
      <div class="mut small">
        {bound
          ? '绑定后可在登录页直接飞书扫码登录。'
          : '手动绑定会发一条测试消息验证可达，发送失败不会保存；扫码绑定无需测试消息。'}
      </div>
      {err && <div class="err">{err}</div>}
      {msg && <div class="okmsg">{msg}</div>}
    </div>
  );
}

function SubscriptionsSect() {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [projects, setProjects] = useState<Map<number, string>>(new Map());
  const [err, setErr] = useState('');

  const load = (): void => {
    api<Subscription[]>('/api/me/subscriptions').then(setSubs).catch((e: Error) => setErr(e.message));
    api<Project[]>('/api/projects')
      .then((ps) => setProjects(new Map(ps.map((p) => [p.id, p.name]))))
      .catch(() => {});
  };
  useEffect(load, []);

  const unsub = async (s: Subscription): Promise<void> => {
    try {
      await api('/api/subscriptions', 'DELETE', { scope: s.scope, targetId: s.targetId });
      load();
      toast.info('已退订');
    } catch (x) {
      toast.error(x instanceof ApiError ? x.message : String(x));
    }
  };

  return (
    <div class="sect">
      <div class="h2">我的订阅</div>
      {err && <div class="err">{err}</div>}
      {subs === null && <Loading />}
      {subs !== null && subs.length === 0 && <div class="mut small">（暂无订阅——去项目页点「订阅」）</div>}
      {(subs ?? []).map((s) => (
        <div key={s.id} class="sub-i">
          <span class={`badge ${s.scope === 'project' ? 'b-blue' : 'b-purple'}`}>
            {s.scope === 'project' ? '项目' : 'issue'}
          </span>
          <span class="grow">
            {s.scope === 'project' ? (projects.get(s.targetId) ?? `#${s.targetId}`) : `issue #${s.targetId}`}
          </span>
          <span class="mut small">{fmtTime(s.createdTs)}</span>
          <button class="btn sm ghost danger" onClick={() => void unsub(s)}>
            退订
          </button>
        </div>
      ))}
    </div>
  );
}
