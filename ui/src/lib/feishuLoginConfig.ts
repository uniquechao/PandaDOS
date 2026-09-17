export interface AdminFeishuLoginConfig {
  enabled: boolean;
  allowRegistration: boolean;
  appId: string;
  appSecretConfigured: boolean;
  publicUrl: string;
  callbackUrl: string;
  source: 'database' | 'environment';
  configured: boolean;
}

export interface FeishuLoginForm {
  enabled: boolean;
  allowRegistration: boolean;
  appId: string;
  appSecret: string;
  clearAppSecret: boolean;
  publicUrl: string;
}

export interface FeishuLoginVerification {
  ok: boolean;
  checks: Array<{
    key: 'credentials' | 'tenant';
    status: 'passed' | 'failed' | 'skipped';
    code?: 'credentials_invalid' | 'tenant_unavailable';
  }>;
  tenant?: { name: string; key: string };
  callbackUrl: string;
}

export interface FeishuLoginEditor {
  form: FeishuLoginForm;
  verification: FeishuLoginVerification | null;
}

export function createFeishuLoginEditor(config: AdminFeishuLoginConfig): FeishuLoginEditor {
  return {
    form: {
      enabled: config.enabled,
      allowRegistration: config.allowRegistration,
      appId: config.appId,
      publicUrl: config.publicUrl,
      appSecret: '',
      clearAppSecret: false,
    },
    verification: null,
  };
}

export function editFeishuLoginForm(
  editor: FeishuLoginEditor,
  patch: Partial<FeishuLoginForm>,
): FeishuLoginEditor {
  return { form: { ...editor.form, ...patch }, verification: null };
}

export function buildFeishuLoginConfigUpdate(form: FeishuLoginForm, savedAppId: string): {
  enabled: boolean;
  allowRegistration: boolean;
  appId: string;
  publicUrl: string;
  appSecret?: string;
  clearAppSecret?: true;
} {
  const base = {
    enabled: form.enabled,
    allowRegistration: form.allowRegistration,
    appId: form.appId.trim(),
    publicUrl: form.publicUrl.trim().replace(/\/+$/, ''),
  };
  if (form.clearAppSecret) return { ...base, clearAppSecret: true };
  const appSecret = form.appSecret.trim();
  if (appSecret) return { ...base, appSecret };
  // A blank secret only preserves credentials for the same application.
  return base.appId !== savedAppId.trim() ? { ...base, clearAppSecret: true } : base;
}
