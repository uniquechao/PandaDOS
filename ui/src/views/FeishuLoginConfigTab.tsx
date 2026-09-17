import { useEffect, useState } from 'preact/hooks';
import { Loading } from '../components/Loaders';
import { FeishuMessagingSection } from './FeishuMessagingSection';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { tr } from '../i18n/runtime';
import {
  buildFeishuLoginConfigUpdate,
  createFeishuLoginEditor,
  editFeishuLoginForm,
  type AdminFeishuLoginConfig,
  type FeishuLoginEditor,
  type FeishuLoginForm,
  type FeishuLoginVerification,
} from '../lib/feishuLoginConfig';

export function FeishuLoginConfigTab() {
  const [credentialsRevision, setCredentialsRevision] = useState(0);
  return <>
    <FeishuLoginSettings onSaved={() => setCredentialsRevision((value) => value + 1)} />
    <FeishuMessagingSection credentialsRevision={credentialsRevision} />
  </>;
}

function FeishuLoginSettings({ onSaved }: { onSaved: () => void }) {
  const [config, setConfig] = useState<AdminFeishuLoginConfig | null>(null);
  const [editor, setEditor] = useState<FeishuLoginEditor | null>(null);
  const [busy, setBusy] = useState<'load' | 'save' | 'verify' | null>('load');
  const [error, setError] = useState('');

  const apply = (next: AdminFeishuLoginConfig): void => {
    setConfig(next);
    setEditor(createFeishuLoginEditor(next));
  };
  const load = async (): Promise<void> => {
    setBusy('load');
    setError('');
    try { apply(await api<AdminFeishuLoginConfig>('/api/admin/feishu-login-config')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  useEffect(() => { void load(); }, []);

  const edit = (patch: Partial<FeishuLoginForm>): void => {
    if (busy) return;
    setEditor((current) => current && editFeishuLoginForm(current, patch));
    setError('');
  };
  const submit = async (action: 'save' | 'verify'): Promise<void> => {
    if (busy || !config || !editor) return;
    setBusy(action);
    setError('');
    setEditor({ ...editor, verification: null });
    const body = buildFeishuLoginConfigUpdate(editor.form, config.appId);
    try {
      if (action === 'save') {
        const result = await api<{ ok: true; config: AdminFeishuLoginConfig }>(
          '/api/admin/feishu-login-config', 'PUT', body,
        );
        apply(result.config);
        onSaved();
        toast.success(tr('feishuLogin.saved'));
      } else {
        const verification = await api<FeishuLoginVerification>(
          '/api/admin/feishu-login-config/verify', 'POST', body,
        );
        setEditor({ ...editor, verification });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(null); }
  };

  if (!config || !editor) {
    if (busy === 'load') return <Loading />;
    return <div class="sect feishu-login-config">
      <div class="err" role="alert">{error}</div>
      <button class="btn" onClick={() => void load()}>{tr('feishuLogin.retry')}</button>
    </div>;
  }

  const { form, verification } = editor;
  const appChanged = form.appId.trim() !== config.appId.trim();
  const keepSecret = config.appSecretConfigured && !appChanged;
  // Show the saved/verified URI only for the public URL it belongs to.
  const callbackUrl = verification?.callbackUrl
    ?? (form.publicUrl.trim().replace(/\/+$/, '') === config.publicUrl.replace(/\/+$/, '') ? config.callbackUrl : '');
  return <div class="sect llm-config feishu-login-config" aria-busy={!!busy}>
    <div class="row feishu-login-heading">
      <div class="grow">
        <h2 class="h2">{tr('feishuLogin.title')}</h2>
        <p class="mut small">{tr('feishuLogin.help')}</p>
      </div>
      <span class={`badge ${config.configured ? 'b-green' : 'b-amber'}`}>
        {config.configured ? tr('admin.configured') : tr('admin.notConfigured')}
      </span>
    </div>
    <div class="mut small">{tr(config.source === 'database' ? 'feishuLogin.sourceDatabase' : 'feishuLogin.sourceEnvironment')}</div>
    <form onSubmit={(event) => { event.preventDefault(); void submit('save'); }}>
      <fieldset disabled={!!busy} class="feishu-login-fields">
        <label class="feishu-login-toggle">
          <input type="checkbox" checked={form.enabled} onChange={(event) => edit({ enabled: event.currentTarget.checked })} />
          <span>{tr('feishuLogin.enabled')}</span>
        </label>
        <label class="feishu-login-toggle">
          <input type="checkbox" checked={form.allowRegistration} onChange={(event) => edit({ allowRegistration: event.currentTarget.checked })} />
          <span>{tr('feishuLogin.allowRegistration')}</span>
        </label>
        <p class="mut small">{tr('feishuLogin.registrationHelp')}</p>
        <label>{tr('feishuLogin.appId')}
          <input value={form.appId} autocomplete="off" spellcheck={false} onInput={(event) => edit({ appId: event.currentTarget.value })} />
        </label>
        <label>{tr('feishuLogin.appSecret')}
          <input type="password" value={form.appSecret} autocomplete="new-password" disabled={!!busy || form.clearAppSecret}
            placeholder={tr(keepSecret ? 'feishuLogin.keepSecret' : 'feishuLogin.enterSecret')}
            onInput={(event) => edit({ appSecret: event.currentTarget.value })} />
        </label>
        <div class="mut small">{tr(config.appSecretConfigured ? 'feishuLogin.secretStored' : 'feishuLogin.secretMissing')}</div>
        {appChanged && <div class="mut small">{tr('feishuLogin.appChanged')}</div>}
        <label class="feishu-login-toggle">
          <input type="checkbox" checked={form.clearAppSecret} onChange={(event) => edit({ clearAppSecret: event.currentTarget.checked, appSecret: '' })} />
          <span>{tr('feishuLogin.clearSecret')}</span>
        </label>
        <label>{tr('feishuLogin.publicUrl')}
          <input type="url" aria-describedby="feishu-public-url-help" value={form.publicUrl} autocomplete="url" spellcheck={false} onInput={(event) => edit({ publicUrl: event.currentTarget.value })} />
        </label>
        <p id="feishu-public-url-help" class="mut small">{tr('feishuLogin.publicUrlHelp')}</p>
        <div class="feishu-login-callback">
          <strong>{tr('feishuLogin.callbackUrl')}</strong>
          {callbackUrl ? <code>{callbackUrl}</code> : <span class="mut small">{tr('feishuLogin.callbackPending')}</span>}
        </div>
        <div class="row feishu-login-actions">
          <button class="btn primary" type="submit">{busy === 'save' ? tr('ui.saving') : tr('admin.saveConfig')}</button>
          <button class="btn" type="button" onClick={() => void submit('verify')}>{tr(busy === 'verify' ? 'feishuLogin.verifying' : 'feishuLogin.verify')}</button>
        </div>
      </fieldset>
    </form>
    {error && <div class="err" role="alert">{error}</div>}
    {verification && <section class="feishu-login-verification" aria-live="polite">
      <h3 class="h2">{tr('feishuLogin.verificationTitle')}</h3>
      <ul>
        {verification.checks.map((check) => <li key={check.key}>
          <span>{tr(check.key === 'credentials' ? 'feishuLogin.credentials' : 'feishuLogin.tenant')}</span>
          <span class={`badge ${check.status === 'passed' ? 'b-green' : check.status === 'failed' ? 'b-amber' : 'b-gray'}`}>
            {tr(check.status === 'passed' ? 'feishuLogin.passed' : check.status === 'failed' ? 'feishuLogin.failed' : 'feishuLogin.skipped')}
          </span>
          {check.code && <p class="mut small">{tr(check.code === 'credentials_invalid' ? 'feishuLogin.credentialsInvalid' : 'feishuLogin.tenantUnavailable')}</p>}
        </li>)}
      </ul>
      {verification.tenant && <dl>
        <dt>{tr('feishuLogin.tenantName')}</dt><dd>{verification.tenant.name}</dd>
        <dt>{tr('feishuLogin.tenantKey')}</dt><dd><code>{verification.tenant.key}</code></dd>
      </dl>}
      <p class="mut small">{tr('feishuLogin.verificationScope')}</p>
    </section>}
    <div class="feishu-login-setup">
      <h3 class="h2">{tr('feishuLogin.platformSetup')}</h3>
      <ul>
        <li>{tr('feishuLogin.platformCallback')}</li>
        <li>{tr('feishuLogin.platformAudience')}</li>
        <li>{tr('feishuLogin.platformPublish')}</li>
      </ul>
    </div>
  </div>;
}
