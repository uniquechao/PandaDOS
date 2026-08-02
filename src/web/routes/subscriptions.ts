/**
 * web/routes/subscriptions —— 订阅管理 + 飞书绑定（spec §8）。
 *
 * - POST/DELETE /api/subscriptions {scope,targetId}（auth:'user'）：
 *   只能订阅自己可见（属主 ∨ 成员）的目标——project 按项目访问权校验，issue 沿其所属 project 校验；admin 全通。
 *   不可见与不存在对普通用户统一 403（不泄露资源存在性，与 middleware project-access 同约定）。
 * - GET /api/me/subscriptions：本人订阅清单。
 * - POST /api/me/feishu {openid}：先经 FeishuChannel.verifyBinding 发测试消息验证可达，
 *   成功才写 users.feishu_openid（发送失败即不保存=天然回滚，防通知外泄）；
 *   {openid:null} 解绑（免验证）。
 *
 * 只 export 路由定义，注册进 routes/index.ts 由集成步骤统一做。
 */
import type { Database } from 'bun:sqlite';
import { ProjectMemberStore } from '../../core/members';
import type { SubscriptionScope } from '../../core/types';
import type { UserStore } from '../../core/users';
import { userByFeishuOpenid, type SubscriptionStore } from '../../notify/router';
import { json, type RouteDef } from '../middleware';

/** 飞书绑定验证的最小接口（FeishuChannel 结构兼容，直接传实例即可） */
export interface FeishuBindVerifier {
  verifyBinding(openid: string, userId?: number): Promise<boolean>;
}

export interface SubscriptionsRoutesDeps {
  db: Database;
  users: UserStore;
  subs: SubscriptionStore;
  /** 飞书通道；未配置（null）时绑定接口 503 */
  feishu: FeishuBindVerifier | null;
}

/** openid 形态护栏（飞书 open_id 是 ASCII 短串；真伪由测试消息验证兜底） */
export const OPENID_RE = /^[A-Za-z0-9_-]{4,64}$/;

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
}

/** 解析并校验 {scope,targetId}；非法返回 null */
function parseSubTarget(b: Record<string, unknown>): { scope: SubscriptionScope; targetId: number } | null {
  const scope = b.scope === 'project' || b.scope === 'issue' ? b.scope : null;
  const targetId =
    typeof b.targetId === 'number' && Number.isInteger(b.targetId) && b.targetId > 0
      ? b.targetId
      : null;
  if (!scope || !targetId) return null;
  return { scope, targetId };
}

/**
 * 目标可见性解析：返回目标所属项目的 { projectId, owner }；目标不存在返回 undefined。
 * issue 沿 issues.project_id 追到项目（防拿 issue id 越权订阅别人项目动态）。
 * 返回 projectId 供成员判定用（成员 ∨ 属主 ∨ admin 皆可订阅）。
 */
function resolveTarget(
  db: Database,
  scope: SubscriptionScope,
  targetId: number,
): { projectId: number; owner: number } | undefined {
  const row =
    scope === 'project'
      ? db
          .query<{ id: number; owner_user_id: number }, [number]>(
            'SELECT id, owner_user_id FROM projects WHERE id = ?',
          )
          .get(targetId)
      : db
          .query<{ id: number; owner_user_id: number }, [number]>(
            `SELECT p.id, p.owner_user_id FROM issues i JOIN projects p ON p.id = i.project_id
             WHERE i.id = ?`,
          )
          .get(targetId);
  return row ? { projectId: row.id, owner: row.owner_user_id } : undefined;
}

export function subscriptionsRoutes(deps: SubscriptionsRoutesDeps): RouteDef[] {
  const { db, users, subs } = deps;
  const members = new ProjectMemberStore(db);
  return [
    {
      method: 'POST',
      path: '/api/subscriptions',
      auth: 'user',
      handler: async ({ req, user }) => {
        const t = parseSubTarget(await readBody(req));
        if (!t) return json({ ok: false, error: '需要 scope(project|issue) 与正整数 targetId' }, 400);
        const target = resolveTarget(db, t.scope, t.targetId);
        if (target === undefined) {
          // 不存在：admin 见 404，普通用户统一 403（middleware 同约定）
          return user!.role === 'admin'
            ? json({ ok: false, error: '目标不存在' }, 404)
            : json({ ok: false, error: '无权限' }, 403);
        }
        // 可订阅 = 属主 ∨ 成员 ∨ admin（与 middleware project-access 同口径）
        if (
          user!.role !== 'admin' &&
          target.owner !== user!.id &&
          !members.isMember(target.projectId, user!.id)
        ) {
          return json({ ok: false, error: '无权限' }, 403);
        }
        return json({ ok: true, subscription: subs.add(user!.id, t.scope, t.targetId) });
      },
    },
    {
      method: 'DELETE',
      path: '/api/subscriptions',
      auth: 'user',
      handler: async ({ req, user }) => {
        const t = parseSubTarget(await readBody(req));
        if (!t) return json({ ok: false, error: '需要 scope(project|issue) 与正整数 targetId' }, 400);
        // 退订只动自己的行，无需可见性校验（目标已易主/已删也允许清掉自己的订阅）
        return json({ ok: true, removed: subs.remove(user!.id, t.scope, t.targetId) });
      },
    },
    {
      method: 'GET',
      path: '/api/me/subscriptions',
      auth: 'user',
      handler: ({ user }) => json(subs.listByUser(user!.id)),
    },
    {
      method: 'POST',
      path: '/api/me/feishu',
      auth: 'user',
      handler: async ({ req, user }) => {
        const b = await readBody(req);
        if (b.openid === null) {
          users.setFeishuOpenid(user!.id, null); // 解绑：不发消息、不验证
          return json({ ok: true, feishuOpenid: null });
        }
        const openid = typeof b.openid === 'string' ? b.openid.trim() : '';
        if (!OPENID_RE.test(openid)) {
          return json({ ok: false, error: 'openid 格式不对（4-64 位字母/数字/_-）' }, 400);
        }
        // openid 全局唯一：扫码登录按 openid 反查用户，占用别人的 openid 会让登录落错账号
        const holder = userByFeishuOpenid(db, openid);
        if (holder && holder.id !== user!.id) {
          return json({ ok: false, error: '该 openid 已被其他用户绑定' }, 409);
        }
        if (!deps.feishu) return json({ ok: false, error: '飞书通道未配置' }, 503);
        const ok = await deps.feishu.verifyBinding(openid, user!.id);
        if (!ok) {
          // 发送失败即不落库（保存前验证 = 天然回滚），旧绑定保持不变
          return json({ ok: false, error: '测试消息发送失败，openid 未保存（请核对后重试）' }, 502);
        }
        users.setFeishuOpenid(user!.id, openid);
        return json({ ok: true, feishuOpenid: openid });
      },
    },
  ];
}
