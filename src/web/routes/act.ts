/**
 * web/routes/act —— 对话动作的可靠 HTTP 版（Wave3 任务 B；v1 /api/act 平移改造）。
 *
 * POST /api/projects/:projectId/act（RouteDef auth:'project-access'）
 * body（与 WS chat 入站帧同语义）：
 *   {type:'text', text}                    → 净化注入 + 回车
 *   {type:'key', key}                      → 白名单单键
 *   {type:'select', index, sig?, requestId?} → 带互斥锁的菜单选择：
 *       锁内重抓 capturePane 核对 sig（screen.ts selectionSig），不符 409 {error:'stale'}；
 *       requestId = 审批升级卡的一次性 id（消费即焚，ApprovalPipeline.consume）。
 *
 * 注入目标 = 项目专用 cc 会话（cc-<pid>）；全部注入经 KeyedMutex(tmuxLockKey)
 * ——与引擎/PM/WS 同一把锁（评审 H9 单一驾驶员）。
 * 注意：本路由不做 activate 抢占（v1 /api/act 会 kill+resume 切对话——评审 H18 判定
 * 为事故源，v2 由引擎/显式切换接口负责激活，act 只对当前会话注入）。
 */
import type { Database } from 'bun:sqlite';
import type { MessageBumper } from '../../core/activity';
import type { Project } from '../../core/types';
import { getProject } from '../../issues/engine';
import type { KeyedMutex } from '../../issues/mutex';
import { json, type RouteDef } from '../middleware';
import type { ChatApprovals } from '../ws/chat';
import { actOnMenu, injectKey, injectText, type MenuDriver } from '../ws/inject';

export interface ActRoutesDeps {
  db: Database;
  convs: { tmuxName(projectId: number): string };
  mutex: KeyedMutex;
  driverForProject(project: Project): MenuDriver;
  approvals?: ChatApprovals;
  retryDelayMs?: number;
  /**
   * 用户消息计数（013）：type:'text' 注入成功后记一笔（按键/选项不是消息，不计）。
   * 缺省不接 = 不统计（最小装配/测试）。
   */
  messages?: MessageBumper;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
}

export function actRoutes(deps: ActRoutesDeps): RouteDef[] {
  return [
    {
      method: 'POST',
      path: '/api/projects/:projectId/act',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const pid = Number(params.projectId);
        const project = getProject(deps.db, pid);
        if (!project) return json({ ok: false, error: '无此项目' }, 404); // owner 校验已过=admin
        const session = deps.convs.tmuxName(pid);
        const inj = {
          driver: deps.driverForProject(project),
          mutex: deps.mutex,
          ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
        };
        const b = await readBody(req);

        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          try {
            await injectText(inj, session, b.text);
          } catch (e) {
            return json({ ok: false, error: `注入失败：${String(e).slice(0, 200)}` }, 502);
          }
          if (user) deps.messages?.bump(user.id); // 注入成功才计
          return json({ ok: true });
        }

        if (b.type === 'key' && typeof b.key === 'string') {
          try {
            await injectKey(inj, session, b.key);
          } catch {
            return json({ ok: false, error: `不支持的按键: ${b.key}` }, 400);
          }
          return json({ ok: true });
        }

        if (b.type === 'select' && Number.isInteger(b.index)) {
          const index = b.index as number;
          // 审批升级卡的网页消费口（消费即焚 + 管道内核对 menuSig）
          if (typeof b.requestId === 'string' && deps.approvals) {
            const r = await deps.approvals.consume(b.requestId, index, { expectSession: session });
            if (r.ok) return json({ ok: true });
            if (r.reason === 'stale' || r.reason === 'no_menu') {
              return json({ ok: false, error: 'stale' }, 409);
            }
            if (r.reason === 'expired') return json({ ok: false, error: '卡片已失效' }, 409);
            if (r.reason === 'forbidden') return json({ ok: false, error: '无权限' }, 403);
            return json({ ok: false, error: '选项越界' }, 400);
          }
          const r = await actOnMenu(
            inj,
            session,
            index,
            typeof b.sig === 'string' ? { sig: b.sig } : {},
          );
          if (r.ok) return json({ ok: true, option: r.option });
          if (r.reason === 'no_menu') return json({ ok: false, error: '当前无选择菜单' }, 409);
          if (r.reason === 'stale') return json({ ok: false, error: 'stale' }, 409);
          return json({ ok: false, error: '选项越界' }, 400);
        }

        return json({ ok: false, error: '未知动作' }, 400);
      },
    },
  ];
}
