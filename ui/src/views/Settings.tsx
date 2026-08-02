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
import { LanguageSelect } from '../i18n/LanguageSelect';
import { TimezoneSelect } from '../i18n/TimezoneSelect';
import { useI18n } from '../i18n/provider';

export function SettingsView({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { t } = useI18n();
  return (
    <div class="page">
      <div class="h1">{t('view.mySettings')}</div>
      <AccountSect me={me} onLogout={onLogout} />
      <LanguageRegionSect />
      <MySettingsSect />
      <FeishuSect me={me} />
      <SubscriptionsSect />
    </div>
  );
}

function LanguageRegionSect() {
  const i18n = useI18n();
  const now = Date.now();
  return (
    <div class="sect">
      <div class="h2">{i18n.t('settings.languageRegion')}</div>
      <LanguageSelect value={i18n.locale} onChange={i18n.setLocale} />
      <TimezoneSelect />
      <div class="mut small locale-preview">
        <b>{i18n.t('settings.localePreview')}：</b>{' '}
        {i18n.formatDateTime(now)} · {i18n.formatRelativeTime(now - 5 * 60_000, now)}
      </div>
    </div>
  );
}

function AccountSect({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { t } = useI18n();
  return (
    <div class="sect">
      <div class="h2">{t('view.account')}</div>
      <div class="row">
        <span class="grow">
          <b>{me.username}</b> <span class={`badge ${me.role === 'admin' ? 'b-amber' : 'b-gray'}`}>{me.role}</span>
        </span>
        <button class="btn sm danger ghost" onClick={onLogout}>
          {t('shell.signOut')}
        </button>
      </div>
      <div class="mut small">{t('view.lastLogin', { time: fmtTime(me.lastLoginTs) })}</div>
    </div>
  );
}

function MySettingsSect() {
  const { t } = useI18n();
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
      toast.success(t('view.settingsSaved'));
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
    setBusy(false);
  };

  if (!s) return <div class="sect">{err ? <div class="err">{err}</div> : <Loading />}</div>;

  return (
    <div class="sect">
      <div class="h2">{t('view.personaMemory')}</div>
      <label class="field">
        {t('view.personaHelp')}
        <textarea
          rows={3}
          value={s.persona ?? ''}
          onInput={(e) => setS({ ...s, persona: e.currentTarget.value || null })}
        />
      </label>
      <label class="field">
        {t('view.memoryHelp')}
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
        {t('view.autopilotDefault')}
      </label>
      <label class="field">
        {t('view.notificationPreference')}
        <input
          value={s.notifyPref ?? ''}
          onInput={(e) => setS({ ...s, notifyPref: e.currentTarget.value || null })}
          placeholder='{"quiet":"23:00-08:00"}'
        />
      </label>
      {err && <div class="err">{err}</div>}
      {msg && <div class="okmsg">{msg}</div>}
      <button class="btn primary" disabled={busy} onClick={save}>
        {busy ? t('ui.saving') : t('view.saveSettings')}
      </button>
    </div>
  );
}

function FeishuSect({ me }: { me: Me }) {
  const { t } = useI18n();
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
      toast.success(t('view.feishuConnectedTest'));
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
    setBusy(false);
  };

  const unbind = async (): Promise<void> => {
    if (busy || !confirm(t('view.unbindFeishuConfirm'))) return;
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      await api('/api/me/feishu', 'POST', { openid: null });
      setBound(null);
      toast.info(t('view.feishuDisconnected'));
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
    setBusy(false);
  };

  return (
    <div class="sect">
      <div class="h2">{t('view.feishuNotifications')}</div>
      {bound ? (
        <div class="row">
          <span class="grow">
            {t('view.bound')} <span class="mono small">{bound}</span>
          </span>
          <button class="btn sm danger ghost" disabled={busy} onClick={unbind}>
            {t('view.disconnect')}
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
                🛩 {t('view.feishuQrBind')}
              </button>
              <span class="mut small">{t('view.feishuOAuthRecommended')}</span>
            </div>
          )}
          <div class="row">
            <input
              class="grow"
              value={openid}
              placeholder={t('view.feishuOpenIdPlaceholder')}
              onInput={(e) => setOpenid(e.currentTarget.value)}
            />
            <button class="btn" disabled={busy || !openid.trim()} onClick={bind}>
              {busy ? t('view.verifying') : t('view.bindManually')}
            </button>
          </div>
        </>
      )}
      <div class="mut small">
        {bound
          ? t('view.feishuLoginAfterBind')
          : t('view.feishuManualHelp')}
      </div>
      {err && <div class="err">{err}</div>}
      {msg && <div class="okmsg">{msg}</div>}
    </div>
  );
}

function SubscriptionsSect() {
  const { t } = useI18n();
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
      toast.info(t('view.unsubscribed'));
    } catch (x) {
      toast.error(x instanceof ApiError ? x.message : String(x));
    }
  };

  return (
    <div class="sect">
      <div class="h2">{t('view.mySubscriptions')}</div>
      {err && <div class="err">{err}</div>}
      {subs === null && <Loading />}
      {subs !== null && subs.length === 0 && <div class="mut small">{t('view.noSubscriptions')}</div>}
      {(subs ?? []).map((s) => (
        <div key={s.id} class="sub-i">
          <span class={`badge ${s.scope === 'project' ? 'b-blue' : 'b-purple'}`}>
            {s.scope === 'project' ? t('view.project') : 'issue'}
          </span>
          <span class="grow">
            {s.scope === 'project' ? (projects.get(s.targetId) ?? `#${s.targetId}`) : `issue #${s.targetId}`}
          </span>
          <span class="mut small">{fmtTime(s.createdTs)}</span>
          <button class="btn sm ghost danger" onClick={() => void unsub(s)}>
            {t('view.unsubscribe')}
          </button>
        </div>
      ))}
    </div>
  );
}
