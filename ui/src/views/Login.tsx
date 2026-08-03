/**
 * 登录页：用户名 + token → POST /api/login（401 显示服务端话术）；
 * 服务端配了飞书 app 时（GET /api/feishu/oauth/status）另给「飞书扫码登录」——
 * 整页跳 /api/feishu/oauth/start，桌面出二维码、手机拉起飞书授权；
 * 回调失败经 /?feishu_err= 回跳（main.tsx 解析后由 initErr 带进来）。
 * 成功后父级重拉 GET /api/me 进主界面。
 */
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import { LanguageSelect } from '../i18n/LanguageSelect';
import { useI18n } from '../i18n/provider';

export function LoginView({ onLogin, initErr = '' }: { onLogin: () => void; initErr?: string }) {
  const { locale, setLocale, t } = useI18n();
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [err, setErr] = useState(initErr);
  const [busy, setBusy] = useState(false);
  const [feishuOn, setFeishuOn] = useState(false);

  useEffect(() => {
    api<{ enabled: boolean }>('/api/feishu/oauth/status')
      .then((r) => setFeishuOn(r.enabled))
      .catch(() => {});
  }, []);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!username.trim() || !token || busy) return;
    setBusy(true);
    setErr('');
    try {
      await api('/api/login', 'POST', { username: username.trim(), token }, { silent401: true });
      onLogin();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : t('login.failed'));
    }
    setBusy(false);
  };

  return (
    <div class="login">
      <div class="login-art" aria-hidden="true">
        <i class="login-glow login-glow-tl" />
        <i class="login-glow login-glow-br" />
        <i class="login-ring login-ring-left" />
        <i class="login-ring login-ring-right" />
        <i class="login-dots login-dots-tl" />
        <i class="login-dots login-dots-br" />
        <i class="login-spark login-spark-top">✦</i>
        <i class="login-spark login-spark-side">✦</i>
      </div>
      <div class="login-locale">
        <LanguageSelect compact value={locale} onChange={setLocale} />
      </div>
      <form class="login-card" onSubmit={submit}>
        <img class="logo-mark" src="/logo-mark.png" alt="PandaDOS" />
        <h1>
          Panda<span class="brand-ai">DOS</span>
        </h1>
        <label class="field">
          {t('login.username')}
          <span class="login-input">
            <span class="login-input-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <circle cx="12" cy="8" r="3.25" />
                <path d="M5.75 19c.55-3.4 2.65-5.1 6.25-5.1s5.7 1.7 6.25 5.1" />
              </svg>
            </span>
            <input
              value={username}
              autocomplete="username"
              autocapitalize="off"
              onInput={(e) => setUsername(e.currentTarget.value)}
            />
          </span>
        </label>
        <label class="field">
          {t('login.token')}
          <span class="login-input">
            <span class="login-input-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <rect x="6.5" y="10" width="11" height="9" rx="2" />
                <path d="M9 10V7.5a3 3 0 0 1 6 0V10M12 13.5v2" />
              </svg>
            </span>
            <input
              type="password"
              value={token}
              autocomplete="current-password"
              onInput={(e) => setToken(e.currentTarget.value)}
            />
          </span>
        </label>
        {err && <div class="err">{err}</div>}
        <button type="submit" class="btn primary big login-submit" disabled={busy || !username.trim() || !token}>
          <svg class="login-submit-icon" aria-hidden="true" viewBox="0 0 24 24">
            <path d="M10 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7M4 12h11M11 8l4 4-4 4" />
          </svg>
          {busy ? t('login.signingIn') : t('login.signIn')}
        </button>
        {feishuOn && (
          <button
            type="button"
            class="btn big"
            disabled={busy}
            onClick={() => {
              location.href = '/api/feishu/oauth/start';
            }}
          >
            🛩️ {t('login.feishuSignIn')}
          </button>
        )}
      </form>
    </div>
  );
}
