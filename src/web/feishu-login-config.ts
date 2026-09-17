import type { Database } from 'bun:sqlite';
import { genToken, hashToken } from '../core/users';
import type { FeishuConfig } from '../notify/feishu';
import { FeishuOauthClient, type FetchLike } from './feishu-oauth';

export interface FeishuLoginConfig extends FeishuConfig {
  enabled: boolean;
  allowRegistration: boolean;
  publicUrl: string;
  revision: string;
  source: 'database' | 'environment';
}

export class FeishuConfigError extends Error {
  constructor(readonly code: string, fallback: string) { super(fallback); }
}

interface ConfigRow {
  enabled: number; allow_registration: number; app_id: string;
  app_secret: string; public_url: string; revision: string;
}

/** 登录配置与通知长连接分开；DB 整行优先于启动时部署兜底。 */
export class FeishuLoginConfigStore {
  constructor(
    private readonly db: Database,
    private readonly fallback: FeishuConfig | null,
    private readonly defaultPublicUrl = '',
    private readonly fetchFn?: FetchLike,
  ) {}

  load(): FeishuLoginConfig {
    const row = this.db.query<ConfigRow, []>('SELECT * FROM feishu_login_config WHERE id = 1').get();
    if (row) return {
      enabled: row.enabled !== 0, allowRegistration: row.allow_registration !== 0,
      appId: row.app_id, appSecret: row.app_secret, publicUrl: row.public_url,
      revision: row.revision, source: 'database',
    };
    const appId = this.fallback?.appId ?? '';
    const appSecret = this.fallback?.appSecret ?? '';
    return {
      enabled: !!(appId && appSecret), allowRegistration: true,
      appId, appSecret, publicUrl: this.defaultPublicUrl,
      revision: hashToken(JSON.stringify([appId, appSecret, this.defaultPublicUrl])), source: 'environment',
    };
  }

  safe(config = this.load()) {
    return {
      enabled: config.enabled, allowRegistration: config.allowRegistration,
      appId: config.appId, appSecretConfigured: !!config.appSecret,
      publicUrl: config.publicUrl, source: config.source,
      configured: !!(config.appId && config.appSecret),
    };
  }

  /** 空密码保留同一应用的原密钥；切换应用必须重新提供密钥。 */
  draft(body: unknown): FeishuLoginConfig {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FeishuConfigError('config_invalid', 'Check the configuration fields and try again.');
    const b = body as Record<string, unknown>;
    if (typeof b.enabled !== 'boolean' || typeof b.allowRegistration !== 'boolean' ||
        typeof b.appId !== 'string' || typeof b.publicUrl !== 'string') {
      throw new FeishuConfigError('config_invalid', 'Check the configuration fields and try again.');
    }
    if (b.appSecret !== undefined && typeof b.appSecret !== 'string') throw new FeishuConfigError('secret_invalid', 'Enter a valid app secret, up to 512 characters.');
    if (b.clearAppSecret !== undefined && typeof b.clearAppSecret !== 'boolean') throw new FeishuConfigError('config_invalid', 'Check the configuration fields and try again.');
    const appId = b.appId.trim();
    if (appId && !/^cli_[A-Za-z0-9_-]{1,100}$/.test(appId)) throw new FeishuConfigError('app_id_invalid', 'App ID must start with cli_ and contain only letters, numbers, underscores or hyphens.');
    let publicUrl = b.publicUrl.trim().replace(/\/+$/, '');
    if (publicUrl) {
      let url: URL;
      try { url = new URL(publicUrl); } catch { throw new FeishuConfigError('public_url_invalid', 'Use an http(s) site origin, with an optional port and no path, credentials, query or fragment.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          url.search || url.hash || url.pathname !== '/') {
        throw new FeishuConfigError('public_url_invalid', 'Use an http(s) site origin, with an optional port and no path, credentials, query or fragment.');
      }
      publicUrl = url.origin;
    }
    const current = this.load();
    const replacement = typeof b.appSecret === 'string' ? b.appSecret.trim() : '';
    if (replacement.length > 512) throw new FeishuConfigError('secret_invalid', 'Enter a valid app secret, up to 512 characters.');
    if (replacement && b.clearAppSecret) throw new FeishuConfigError('secret_conflict', 'Do not replace and clear the app secret at the same time.');
    const appSecret = b.clearAppSecret ? '' : replacement || (appId === current.appId ? current.appSecret : '');
    if (b.enabled && (!appId || !appSecret)) throw new FeishuConfigError('credentials_required', 'An App ID and secret are required to enable sign-in. Enter a new secret when switching apps.');
    return { enabled: b.enabled, allowRegistration: b.allowRegistration, appId, appSecret,
      publicUrl, revision: current.revision, source: 'database' };
  }

  save(config: FeishuLoginConfig): void {
    this.db.query(`INSERT INTO feishu_login_config
      (id, enabled, allow_registration, app_id, app_secret, public_url, revision)
      VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      enabled=excluded.enabled, allow_registration=excluded.allow_registration,
      app_id=excluded.app_id, app_secret=excluded.app_secret, public_url=excluded.public_url,
      revision=excluded.revision`).run(Number(config.enabled), Number(config.allowRegistration),
        config.appId, config.appSecret, config.publicUrl, genToken());
  }

  client(config = this.load()): FeishuOauthClient {
    return new FeishuOauthClient(config, this.fetchFn);
  }
}
