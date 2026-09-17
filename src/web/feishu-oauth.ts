/**
 * web/feishu-oauth —— 飞书扫码登录/绑定的 OAuth2 客户端 + state 防伪存储（spec §7/§8 延伸）。
 *
 * 流程（授权码模式；桌面浏览器打开授权页自动出二维码，手机端拉起飞书内确认）：
 *   1. /start|/bind 签发一次性 state → 302 到 accounts.feishu.cn 授权页
 *   2. 用户扫码/确认 → 飞书 302 回 /callback?code&state
 *   3. code 换 user_access_token（authen/v2/oauth/token）→ 取 user_info 得 open_id
 *
 * 纪律：
 * - fetch 可注入（测试全 mock，铁律与 feishu SDK 同待遇：不打真网络）
 * - state 一次性消费 + TTL + 容量上限（/start 是公开端点，防匿名灌满内存）
 * - redirect_uri 在 issue 时冻结进 state，换 token 时原样带回（OAuth 规范要求一致）
 */
import type { FeishuConfig } from '../notify/feishu';
import { genToken } from '../core/users';

export const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
export const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
export const FEISHU_TENANT_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
export const FEISHU_TENANT_URL = 'https://open.feishu.cn/open-apis/tenant/v2/tenant/query';
export const FEISHU_USERINFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';

/** OAuth 拿回的用户身份（只取绑定/登录需要的最小面） */
export interface FeishuOauthUser {
  openId: string;
  name: string;
  tenantKey?: string;
}

export interface FeishuConfigVerification {
  ok: boolean;
  checks: Array<{ key: 'credentials' | 'tenant'; status: 'passed' | 'failed' | 'skipped';
    code?: 'credentials_invalid' | 'tenant_unavailable' }>;
  tenant?: { name: string; key: string };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 路由层依赖的最小面（测试传假实现，FeishuOauthClient 结构兼容） */
export interface FeishuOauthPort {
  authorizeUrl(redirectUri: string, state: string): string;
  /** code 换 token + 取用户信息一步到位；失败抛 Error（message 可直接展示给用户） */
  userByCode(code: string, redirectUri: string): Promise<FeishuOauthUser>;
  /** 仅允许本服务自建飞书应用所属企业的用户首次建号。 */
  canRegister(user: FeishuOauthUser): Promise<boolean>;
}

export class FeishuOauthClient implements FeishuOauthPort {
  constructor(
    private readonly cfg: FeishuConfig,
    private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
  ) {}

  authorizeUrl(redirectUri: string, state: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.appId,
      redirect_uri: redirectUri,
      state,
    });
    return `${FEISHU_AUTHORIZE_URL}?${q.toString()}`;
  }

  async userByCode(code: string, redirectUri: string): Promise<FeishuOauthUser> {
    const accessToken = await this.exchangeCode(code, redirectUri);
    return this.userInfo(accessToken);
  }

  async canRegister(user: FeishuOauthUser): Promise<boolean> {
    if (!user.tenantKey) return false;
    const result = await this.verifyConfiguration();
    if (!result.ok || !result.tenant) {
      throw new Error('飞书企业身份校验失败，请稍后重试或联系管理员检查应用的企业信息权限');
    }
    return result.tenant.key === user.tenantKey;
  }

  /** 管理页与首次建号共用实际凭据/企业检查；不回显上游消息或任何凭据。 */
  async verifyConfiguration(): Promise<FeishuConfigVerification> {
    const checks: FeishuConfigVerification['checks'] = [];
    let token: string;
    try {
      if (!this.cfg.appId || !this.cfg.appSecret) throw new Error('missing credentials');
      const response = await this.fetchFn(FEISHU_TENANT_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json() as { code?: number; tenant_access_token?: unknown };
      if (!response.ok || body?.code !== 0 || typeof body.tenant_access_token !== 'string' || !body.tenant_access_token.trim()) {
        throw new Error('invalid tenant token');
      }
      token = body.tenant_access_token;
      checks.push({ key: 'credentials', status: 'passed' });
    } catch {
      return { ok: false, checks: [
        { key: 'credentials', status: 'failed', code: 'credentials_invalid' },
        { key: 'tenant', status: 'skipped' },
      ] };
    }
    try {
      const response = await this.fetchFn(FEISHU_TENANT_URL, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json() as {
        code?: number; data?: { tenant?: { tenant_key?: unknown; name?: unknown } };
      };
      const tenant = body?.data?.tenant;
      if (!response.ok || body?.code !== 0 || typeof tenant?.tenant_key !== 'string' || !tenant.tenant_key.trim()) {
        throw new Error('invalid tenant identity');
      }
      checks.push({ key: 'tenant', status: 'passed' });
      return { ok: true, checks, tenant: { key: tenant.tenant_key, name: typeof tenant.name === 'string' ? tenant.name : '' } };
    } catch {
      checks.push({ key: 'tenant', status: 'failed', code: 'tenant_unavailable' });
      return { ok: false, checks };
    }
  }

  /** 授权码换 user_access_token（authen/v2；错误返回 {code!=0, error_description}） */
  private async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const r = await this.fetchFn(FEISHU_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.cfg.appId,
        client_secret: this.cfg.appSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const b = (await r.json().catch(() => null)) as {
      code?: number;
      access_token?: string;
      error_description?: string;
      error?: string;
    } | null;
    if (!b || b.code !== 0 || !b.access_token) {
      throw new Error(`飞书换取凭证失败：${b?.error_description ?? b?.error ?? `HTTP ${r.status}`}`);
    }
    return b.access_token;
  }

  /** user_access_token → open_id/name（authen/v1/user_info） */
  private async userInfo(accessToken: string): Promise<FeishuOauthUser> {
    const r = await this.fetchFn(FEISHU_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const b = (await r.json().catch(() => null)) as {
      code?: number;
      msg?: string;
      data?: { open_id?: string; name?: string; tenant_key?: unknown };
    } | null;
    if (!b || b.code !== 0 || !b.data?.open_id) {
      throw new Error(`飞书获取用户信息失败：${b?.msg ?? `HTTP ${r.status}`}`);
    }
    return {
      openId: b.data.open_id, name: b.data.name ?? '',
      ...(typeof b.data.tenant_key === 'string' ? { tenantKey: b.data.tenant_key } : {}),
    };
  }
}

// ---------- state 防伪存储（内存态；重启丢失 = 用户重扫一次，可接受） ----------

export type OauthMode = 'login' | 'bind';

export interface OauthState {
  /** 配置切换后使在途授权失效，防止使用另一套应用凭据换码。 */
  configRevision?: string;
  mode: OauthMode;
  /** bind 模式：发起绑定的已登录用户（callback 无需再看 cookie） */
  userId?: number;
  /** issue 时冻结的回调地址（换 token 必须原样一致） */
  redirectUri: string;
}

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** 容量上限：/start 是公开端点，防匿名请求灌满内存（超限淘汰最旧） */
export const OAUTH_STATE_MAX = 200;

export class OauthStateStore {
  private readonly entries = new Map<string, OauthState & { createdTs: number }>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? OAUTH_STATE_TTL_MS;
    this.max = opts.max ?? OAUTH_STATE_MAX;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 签发一次性 state（48 hex 随机串） */
  issue(s: OauthState): string {
    const ts = this.now();
    for (const [k, v] of this.entries) {
      if (ts - v.createdTs > this.ttlMs) this.entries.delete(k);
    }
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest); // Map 迭代序 = 插入序，先删最旧
    }
    const state = genToken();
    this.entries.set(state, { ...s, createdTs: ts });
    return state;
  }

  /** 消费（一次性）：命中即删；过期/不存在 → null */
  consume(state: string): OauthState | null {
    const v = this.entries.get(state);
    if (!v) return null;
    this.entries.delete(state);
    if (this.now() - v.createdTs > this.ttlMs) return null;
    const { createdTs: _, ...rest } = v;
    return rest;
  }
}
