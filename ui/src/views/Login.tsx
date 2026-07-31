/**
 * 登录页：用户名 + token → POST /api/login（401 显示服务端话术）；
 * 服务端配了飞书 app 时（GET /api/feishu/oauth/status）另给「飞书扫码登录」——
 * 整页跳 /api/feishu/oauth/start，桌面出二维码、手机拉起飞书授权；
 * 回调失败经 /?feishu_err= 回跳（main.tsx 解析后由 initErr 带进来）。
 * 成功后父级重拉 GET /api/me 进主界面。
 */
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';

export function LoginView({ onLogin, initErr = '' }: { onLogin: () => void; initErr?: string }) {
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
      setErr(x instanceof ApiError ? x.message : '登录失败');
    }
    setBusy(false);
  };

  return (
    <div class="login">
      <form class="login-card" onSubmit={submit}>
        <img class="logo-mark" src="/logo-mark.png" alt="Mando AI" />
        <h1>
          Mando<span class="brand-ai">AI</span>
        </h1>
        <p class="login-sub">曼拓 · 你的口袋工程管家</p>
        <label class="field">
          用户名
          <input
            value={username}
            autocomplete="username"
            autocapitalize="off"
            onInput={(e) => setUsername(e.currentTarget.value)}
          />
        </label>
        <label class="field">
          Token
          <input
            type="password"
            value={token}
            autocomplete="current-password"
            onInput={(e) => setToken(e.currentTarget.value)}
          />
        </label>
        {err && <div class="err">{err}</div>}
        <button type="submit" class="btn primary big" disabled={busy || !username.trim() || !token}>
          {busy ? '登录中…' : '登录'}
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
            🛩️ 飞书扫码登录
          </button>
        )}
      </form>
    </div>
  );
}
