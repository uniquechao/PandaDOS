import { FeishuConfigError, type FeishuLoginConfigStore } from '../feishu-login-config';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';
import { callbackUri } from './feishu-oauth';

export function feishuLoginConfigRoutes(store: FeishuLoginConfigStore, onSaved?: () => Promise<void> | undefined): RouteDef[] {
  const callback = (publicUrl: string, req: Request, url: URL) => callbackUri({ publicUrl }, req, url);
  return [
    {
      method: 'GET', path: '/api/admin/feishu-login-config', auth: 'admin',
      handler: ({ req, url }) => {
        const config = store.load();
        return json({ ...store.safe(config), callbackUrl: callback(config.publicUrl, req, url) });
      },
    },
    {
      method: 'PUT', path: '/api/admin/feishu-login-config', auth: 'admin',
      handler: async ({ req, url }) => {
        let config;
        try { config = store.draft(await req.json()); }
        catch (error) {
          return json(apiError(error instanceof FeishuConfigError ? `feishu.${error.code}` : 'feishu.config_invalid',
            error instanceof FeishuConfigError ? error.message : 'Check the configuration fields and try again.', 400), 400);
        }
        store.save(config);
        await onSaved?.();
        const saved = store.load();
        return json({ ok: true, config: { ...store.safe(saved), callbackUrl: callback(saved.publicUrl, req, url) } });
      },
    },
    {
      method: 'POST', path: '/api/admin/feishu-login-config/verify', auth: 'admin',
      handler: async ({ req, url }) => {
        let config;
        try { config = store.draft(await req.json()); }
        catch (error) {
          return json(apiError(error instanceof FeishuConfigError ? `feishu.${error.code}` : 'feishu.config_invalid',
            error instanceof FeishuConfigError ? error.message : 'Check the configuration fields and try again.', 400), 400);
        }
        // 验证当前表单，不写配置，也不向任何用户发送消息。
        const result = await store.client(config).verifyConfiguration();
        return json({ ...result, callbackUrl: callback(config.publicUrl, req, url) });
      },
    },
  ];
}
