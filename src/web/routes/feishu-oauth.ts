/**
 * web/routes/feishu-oauth —— 飞书扫码登录/绑定路由（web/feishu-oauth.ts 的 HTTP 面）。
 *
 * - GET /api/feishu/oauth/status（public）：{enabled} 前端据此显隐扫码按钮
 * - GET /api/feishu/oauth/start （public）：登录流——302 到飞书授权页
 * - GET /api/feishu/oauth/bind  （user）  ：绑定流——当前用户 id 冻进 state
 * - GET /api/feishu/oauth/callback（public）：code 换 open_id →
 *     bind：openid 唯一性校验后写 users.feishu_openid → 302 /?feishu=bound#/settings
 *     login：openid 反查用户 → 签发 auth_sessions 会话 + 种 cookie → 302 /
 *   失败一律 302 回 /?feishu_err=<msg>（bind 流带 #/settings），前端 toast 展示。
 *
 * 安全：state 一次性 + TTL（CSRF/重放）；bind 身份来自 state 非 cookie；
 * openid 全局唯一（否则扫码登录会落到别人账号）；回跳只去站内固定路径。
 */
import type { Database } from 'bun:sqlite';
import type { SessionStore } from '../../core/sessions';
import type { UserStore } from '../../core/users';
import { userByFeishuOpenid } from '../../notify/router';
import { loginCookie, requestIsSecure } from '../auth';
import { json, type RouteDef } from '../middleware';
import { OauthStateStore, type FeishuOauthPort } from '../feishu-oauth';

export const OAUTH_CALLBACK_PATH = '/api/feishu/oauth/callback';

export interface FeishuOauthRoutesDeps {
  db: Database;
  users: UserStore;
  sessions: SessionStore;
  /** 未配置飞书 app 凭据时传 null：status={enabled:false}，其余接口 503 */
  oauth: FeishuOauthPort | null;
  /** 对外基址（如 https://stack.example.com）；缺省按请求 Host/x-forwarded-proto 推导 */
  publicUrl?: string | undefined;
  /** state 存储（测试注入短 TTL/假时钟；缺省进程级默认参数） */
  states?: OauthStateStore;
}

/** 回调地址：env 基址优先，否则按请求推导（nginx 需透传 Host + x-forwarded-proto） */
export function callbackUri(deps: FeishuOauthRoutesDeps, req: Request, url: URL): string {
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

  const startFlow = (
    req: Request,
    url: URL,
    mode: 'login' | 'bind',
    userId?: number,
  ): Response => {
    if (!deps.oauth) return json({ ok: false, error: '飞书扫码未配置' }, 503);
    const redirectUri = callbackUri(deps, req, url);
    const state = states.issue(
      userId !== undefined ? { mode, userId, redirectUri } : { mode, redirectUri },
    );
    return redirect(deps.oauth.authorizeUrl(redirectUri, state));
  };

  return [
    {
      method: 'GET',
      path: '/api/feishu/oauth/status',
      auth: 'public',
      handler: () => json({ enabled: deps.oauth !== null }),
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
        if (!deps.oauth) return json({ ok: false, error: '飞书扫码未配置' }, 503);
        const stateParam = url.searchParams.get('state') ?? '';
        const st = stateParam ? states.consume(stateParam) : null;
        // state 先消费再看其余参数：即使飞书回了 error 也烧掉这个 state
        if (!st) return failRedirect('login', '扫码状态已过期或无效，请重新扫码');

        if (url.searchParams.get('error')) {
          return failRedirect(st.mode, '飞书授权被取消或失败');
        }
        const code = url.searchParams.get('code') ?? '';
        if (!code) return failRedirect(st.mode, '飞书回调缺少授权码');

        let fu;
        try {
          fu = await deps.oauth.userByCode(code, st.redirectUri);
        } catch (e) {
          return failRedirect(st.mode, e instanceof Error ? e.message : '飞书授权校验失败');
        }

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

        // login：openid 反查用户 → 签发会话 cookie
        const holder = userByFeishuOpenid(deps.db, fu.openId);
        if (!holder) {
          return failRedirect(
            'login',
            `该飞书账号（${fu.name || fu.openId}）未绑定用户——请先用 token 登录，在「设定」页扫码绑定`,
          );
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
