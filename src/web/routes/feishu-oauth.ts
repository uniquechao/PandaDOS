/**
 * web/routes/feishu-oauth —— 飞书扫码登录/绑定路由（web/feishu-oauth.ts 的 HTTP 面）。
 *
 * - GET /api/feishu/oauth/status（public）：{enabled} 前端据此显隐扫码按钮
 * - GET /api/feishu/oauth/start （public）：登录流——302 到飞书授权页
 * - GET /api/feishu/oauth/bind  （user）  ：绑定流——当前用户 id 冻进 state
 * - GET /api/feishu/oauth/callback（public）：code 换 open_id →
 *     bind：openid 唯一性校验后写 users.feishu_openid → 302 /?feishu=bound#/settings
 *     login：openid 反查用户，同企业首次登录自动建普通账号 → 签发 auth_sessions 会话 + 种 cookie → 302 /
 *   失败一律 302 回 /?feishu_err=<msg>（bind 流带 #/settings），前端 toast 展示。
 *
 * 安全：state 一次性 + TTL（CSRF/重放）；bind 身份来自 state 非 cookie；
 * openid 全局唯一（否则扫码登录会落到别人账号）；回跳只去站内固定路径。
 */
import type { Database } from 'bun:sqlite';
import type { FeishuLoginConfigStore } from '../feishu-login-config';
import type { SessionStore } from '../../core/sessions';
import { genToken, type UserStore } from '../../core/users';
import { userByFeishuOpenid } from '../../notify/router';
import { loginCookie, requestIsSecure } from '../auth';
import { json, type RouteDef } from '../middleware';
import { OauthStateStore, type FeishuOauthPort } from '../feishu-oauth';

export const OAUTH_CALLBACK_PATH = '/api/feishu/oauth/callback';

export interface FeishuOauthRoutesDeps {
  config?: FeishuLoginConfigStore | undefined;
  db: Database;
  users: UserStore;
  sessions: SessionStore;
  /** 未配置飞书 app 凭据时传 null：status={enabled:false}，其余接口 503 */
  oauth: FeishuOauthPort | null;
  /** 对外基址（如 https://panda.example.com）；缺省按请求 Host/x-forwarded-proto 推导 */
  publicUrl?: string | undefined;
  /** state 存储（测试注入短 TTL/假时钟；缺省进程级默认参数） */
  states?: OauthStateStore;
}

/** 回调地址：env 基址优先，否则按请求推导（nginx 需透传 Host + x-forwarded-proto） */
export function callbackUri(deps: Pick<FeishuOauthRoutesDeps, 'publicUrl'>, req: Request, url: URL): string {
  const base = deps.publicUrl
    ? deps.publicUrl.replace(/\/+$/, '')
    : `${requestIsSecure(req, url) ? 'https' : 'http'}://${req.headers.get('host') ?? url.host}`;
  return `${base}${OAUTH_CALLBACK_PATH}`;
}

/** 失败回跳：登录流回登录页，绑定流回设定页（都由前端读 feishu_err 展示） */
function failRedirect(mode: 'login' | 'bind', msg: string): Response {
  const suffix = mode === 'bind' ? '#/settings' : '';
  return redirect(`/?feishu_err=${encodeURIComponent(msg)}${suffix}`);
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...extraHeaders } });
}

export function feishuOauthRoutes(deps: FeishuOauthRoutesDeps): RouteDef[] {
  const states = deps.states ?? new OauthStateStore();
  const current = () => {
    if (!deps.config) return { oauth: deps.oauth, publicUrl: deps.publicUrl, allowRegistration: true, revision: undefined };
    const config = deps.config.load();
    return {
      oauth: config.enabled && config.appId && config.appSecret ? deps.config.client(config) : null,
      publicUrl: config.publicUrl, allowRegistration: config.allowRegistration, revision: config.revision,
    };
  };
  const configChanged = (revision: string | undefined) => revision !== current().revision;


  const startFlow = (
    req: Request,
    url: URL,
    mode: 'login' | 'bind',
    userId?: number,
  ): Response => {
    const active = current();
    if (!active.oauth) return json({ ok: false, error: '飞书扫码未配置或已关闭' }, 503);
    const redirectUri = callbackUri(active, req, url);
    const state = states.issue(
      { mode, redirectUri, ...(userId !== undefined ? { userId } : {}),
        ...(active.revision !== undefined ? { configRevision: active.revision } : {}) },
    );
    return redirect(active.oauth.authorizeUrl(redirectUri, state));
  };

  return [
    {
      method: 'GET',
      path: '/api/feishu/oauth/status',
      auth: 'public',
      handler: () => json({ enabled: current().oauth !== null }),
    },
    {
      method: 'GET',
      path: '/api/feishu/oauth/start',
      auth: 'public',
      handler: ({ req, url }) => startFlow(req, url, 'login'),
    },
    {
      method: 'GET',
      path: '/api/feishu/oauth/bind',
      auth: 'user',
      handler: ({ req, url, user }) => startFlow(req, url, 'bind', user!.id),
    },
    {
      method: 'GET',
      path: OAUTH_CALLBACK_PATH,
      auth: 'public',
      handler: async ({ req, url }) => {
        const active = current();
        if (!active.oauth) return json({ ok: false, error: '飞书扫码未配置或已关闭' }, 503);
        const stateParam = url.searchParams.get('state') ?? '';
        const st = stateParam ? states.consume(stateParam) : null;
        // state 先消费再看其余参数：即使飞书回了 error 也烧掉这个 state
        if (!st) return failRedirect('login', '扫码状态已过期或无效，请重新扫码');
        if (st.configRevision !== active.revision) return failRedirect(st.mode, '飞书登录配置已更新，请重新扫码');

        if (url.searchParams.get('error')) {
          return failRedirect(st.mode, '飞书授权被取消或失败');
        }
        const code = url.searchParams.get('code') ?? '';
        if (!code) return failRedirect(st.mode, '飞书回调缺少授权码');

        let fu;
        try {
          fu = await active.oauth.userByCode(code, st.redirectUri);
        } catch (e) {
          return failRedirect(st.mode, e instanceof Error ? e.message : '飞书授权校验失败');
        }

        if (configChanged(active.revision)) return failRedirect(st.mode, '飞书登录配置已更新，请重新扫码');

        if (st.mode === 'bind') {
          const target = st.userId !== undefined ? deps.users.byId(st.userId) : undefined;
          if (!target) return failRedirect('bind', '发起绑定的用户已不存在');
          const holder = userByFeishuOpenid(deps.db, fu.openId);
          if (holder && holder.id !== target.id) {
            return failRedirect('bind', '该飞书账号已被其他用户绑定');
          }
          deps.users.setFeishuOpenid(target.id, fu.openId);
          return redirect('/?feishu=bound#/settings');
        }

        // 已绑定账号保持原身份；新同事通过企业校验后自动建普通账号。
        let holder = userByFeishuOpenid(deps.db, fu.openId);
        if (!holder) {
          if (!active.allowRegistration) return failRedirect('login', '同企业自动建号已关闭，请联系管理员创建并绑定账号');
          try {
            if (!await active.oauth.canRegister(fu)) {
              return failRedirect('login', '仅本飞书企业成员可直接登录，请使用企业账号授权');
            }
            if (configChanged(active.revision)) return failRedirect('login', '飞书登录配置已更新，请重新扫码');
            holder = deps.db.transaction(() => {
              // 企业校验包含 await：其他回调可能已建号，事务内重新按 openid 查询。
              const existing = userByFeishuOpenid(deps.db, fu.openId);
              if (existing) return existing;
              // 随机用户名不依赖重名/中文姓名，不会误关联现有账号；可在管理页改名。
              const { user } = deps.users.create(`feishu_${genToken().slice(0, 24)}`, 'user');
              deps.users.setFeishuOpenid(user.id, fu.openId);
              return user;
            })();
          } catch {
            return failRedirect('login', '飞书企业登录暂时不可用，请重试或联系管理员检查应用的企业信息权限');
          }
        }
        const sess = deps.sessions.create(holder.id, 'feishu');
        deps.users.touchLogin(holder.id);
        return redirect('/', {
          'set-cookie': loginCookie(sess.token, { secure: requestIsSecure(req, url) }),
        });
      },
    },
  ];
}
