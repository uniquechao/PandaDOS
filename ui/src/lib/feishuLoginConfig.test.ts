import { describe, expect, test } from 'bun:test';
import { parseHash } from './router';
import {
  buildFeishuLoginConfigUpdate,
  createFeishuLoginEditor,
  editFeishuLoginForm,
  type AdminFeishuLoginConfig,
  type FeishuLoginForm,
  type FeishuLoginVerification,
} from './feishuLoginConfig';

const config: AdminFeishuLoginConfig = {
  enabled: true,
  allowRegistration: true,
  appId: 'cli_old',
  appSecretConfigured: true,
  publicUrl: 'https://panda.example',
  callbackUrl: 'https://panda.example/api/feishu/oauth/callback',
  configured: true,
  source: 'database',
};
const verification: FeishuLoginVerification = {
  ok: true,
  checks: [{ key: 'credentials', status: 'passed' }, { key: 'tenant', status: 'passed' }],
  tenant: { name: 'Example', key: 'tenant-example' },
  callbackUrl: config.callbackUrl,
};

function payload(patch: Partial<FeishuLoginForm> = {}) {
  return buildFeishuLoginConfigUpdate({ ...createFeishuLoginEditor(config).form, ...patch }, config.appId);
}

describe('Feishu login configuration editor', () => {
  test('blank secret preserves credentials only for the same application', () => {
    expect(payload({ appId: ' cli_old ', appSecret: '  ', publicUrl: ' https://panda.example/ ' })).toEqual({
      enabled: true,
      allowRegistration: true,
      appId: 'cli_old',
      publicUrl: 'https://panda.example',
    });
    expect(payload({ appId: 'cli_new' })).toMatchObject({ appId: 'cli_new', clearAppSecret: true });
    expect(payload({ appId: '' })).toMatchObject({ appId: '', clearAppSecret: true });
  });

  test('a replacement secret is sent for the new application; clearing is explicit and wins', () => {
    expect(payload({ appId: 'cli_new', appSecret: ' new-secret ' })).toEqual({
      enabled: true,
      allowRegistration: true,
      appId: 'cli_new',
      publicUrl: config.publicUrl,
      appSecret: 'new-secret',
    });
    const cleared = payload({ clearAppSecret: true, appSecret: 'must-not-send' });
    expect(cleared.clearAppSecret).toBe(true);
    expect(cleared).not.toHaveProperty('appSecret');
    expect(payload({ enabled: false, allowRegistration: false })).toMatchObject({
      enabled: false, allowRegistration: false,
    });
  });

  test('every editable field invalidates previous verification without changing saved configuration', () => {
    const original = { ...createFeishuLoginEditor(config), verification };
    const changes: Partial<FeishuLoginForm>[] = [
      { enabled: false }, { allowRegistration: false }, { appId: 'cli_new' },
      { appSecret: 'replacement' }, { clearAppSecret: true }, { publicUrl: 'https://other.example' },
    ];
    for (const change of changes) {
      const edited = editFeishuLoginForm(original, change);
      expect(edited.verification).toBeNull();
      expect(edited.form).toMatchObject(change);
      expect(original.verification).toBe(verification);
      expect(original.form.appId).toBe('cli_old');
    }
  });

  test('applying the saved configuration resets secret input, clear intent and verification', () => {
    const editor = createFeishuLoginEditor({ ...config, appId: 'cli_new' });
    expect(editor.form).toMatchObject({ appId: 'cli_new', appSecret: '', clearAppSecret: false });
    expect(editor.verification).toBeNull();
    expect(editor.form).not.toHaveProperty('appSecretConfigured');
  });

  test('Feishu deep links resolve to the new admin section and preserve existing routes', () => {
    expect(parseHash('#/admin/feishu')).toEqual({ name: 'admin', section: 'feishu' });
    expect(parseHash('#/admin/llm')).toEqual({ name: 'admin', section: 'llm' });
    expect(parseHash('#/admin')).toEqual({ name: 'admin' });
    expect(parseHash('#/admin/unknown')).toEqual({ name: 'admin' });
  });
});
