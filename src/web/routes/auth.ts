/**
 * web/routes/auth —— 登录/登出/我是谁（spec §7；v1 web.ts login/logout 平移改造）。
 * - 登录常数时间：用户不存在时也对 dummy 哈希做一次 timingSafeEqual，
 *   失败统一话术「用户名或 token 不对」（防枚举，v1 web.ts:99 平移）
 * - 成功种 HttpOnly cookie（TLS 下带 Secure），同时返回角色供前端路由
 * 本模块只 export 路由定义，注册进 index.ts 由集成步骤统一做。
 */
import { genToken, hashEq, hashToken, type UserStore } from '../../core/users';
import { loginCookie, logoutCookie, requestIsSecure } from '../auth';
import { json, type RouteDef } from '../middleware';

export interface AuthRoutesDeps {
  users: UserStore;
}

/** 用户不存在时的比对对象：每进程一次随机，不可预测、必不等于任何真实 token 的哈希 */
const DUMMY_HASH = hashToken(genToken());

export function authRoutes(deps: AuthRoutesDeps): RouteDef[] {
  return [
    {
      method: 'POST',
      path: '/api/login',
      auth: 'public',
      handler: async ({ req, url }) => {
        const b = (await req.json().catch(() => ({}))) as {
          username?: unknown;
          token?: unknown;
        };
        const username = typeof b.username === 'string' ? b.username : '';
        const token = typeof b.token === 'string' ? b.token : '';

        const u = username ? deps.users.byUsername(username) : undefined;
        // 常数时间：无论用户存在与否都比对一次哈希
        const match = token.length > 0 && hashEq(hashToken(token), u?.tokenHash ?? DUMMY_HASH);
        if (!u || !match) {
          return json({ ok: false, error: '用户名或 token 不对' }, 401);
        }

        deps.users.touchLogin(u.id);
        return new Response(
          JSON.stringify({ ok: true, userId: u.id, username: u.username, role: u.role }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'set-cookie': loginCookie(token, { secure: requestIsSecure(req, url) }),
            },
          },
        );
      },
    },
    {
      method: 'POST',
      path: '/api/logout',
      auth: 'public', // 幂等清 cookie：token 已失效的会话也允许登出
      handler: ({ req, url }) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'set-cookie': logoutCookie({ secure: requestIsSecure(req, url) }),
          },
        }),
    },
    {
      method: 'GET',
      path: '/api/me',
      auth: 'user',
      handler: ({ user }) => {
        const u = user!; // auth:'user' 保证非空
        return json({
          id: u.id,
          username: u.username,
          role: u.role,
          feishuOpenid: u.feishuOpenid,
          lastLoginTs: u.lastLoginTs,
        });
      },
    },
  ];
}
