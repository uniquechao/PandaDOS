/**
 * web/routes/conversations —— 对话模式的对话 CRUD + 激活（落地 server.ts Wave4 TODO）。
 *
 * 面向「对话模式（chat）」的独立对话：每条对话一个独立 tmux 会话（chat-<convId>，见
 * core/conversations.ts），彼此常驻互不 kill。本路由只管 chat 对话——issue 引擎绑定的
 * 会话仍由引擎自己 activate（不在此暴露，避免与单活跃模型打架）。
 *
 * 端点（全 auth:'project-access'，:projectId 解析，属主/成员/admin 皆可）：
 *   GET  /api/projects/:projectId/conversations                 列 chat 对话（?includeArchived=1 含归档）
 *   POST /api/projects/:projectId/conversations                 新建 chat 对话 {label?, agent?:'claude'|'codex'}
 *   POST /api/projects/:projectId/conversations/:convId/activate 启动/复活其独立会话（tmuxLockKey 互斥）
 *   POST /api/projects/:projectId/conversations/:convId/archive  归档 + kill 会话（关闭清理）
 *   POST /api/projects/:projectId/conversations/:convId/rename   改标题 {label}
 *   POST /api/projects/:projectId/conversations/:convId/auto-approve 改自动批准档位 {level}
 *   GET  /api/projects/:projectId/conversations/:convId/model        当前使用的模型原始名（可为 null）
 *
 * activate/archive 都在本对话会话名的 tmuxLockKey 下执行——与 WS 聊天注入/引擎/PM 同一把锁
 * （评审 H9 单一驾驶员）。
 */
import type { Database } from 'bun:sqlite';
import { projectAgentSupport } from '../../core/executors';
import {
  parseAutoApproveLevel,
  type AgentKind,
  type AutoApproveLevel,
  type Conversation,
  type ProjectKind,
} from '../../core/types';
import { getProject } from '../../issues/engine';
import { type KeyedMutex, tmuxLockKey } from '../../issues/mutex';
import { json, type RouteDef } from '../middleware';

/** ConversationManager 最小面（core/conversations.ts 结构兼容） */
export interface ConvManagerPort {
  listChats(projectId: number, includeArchived?: boolean): Conversation[];
  create(projectId: number, label: string, agent?: AgentKind, kind?: ProjectKind): Conversation;
  get(id: string): Conversation | undefined;
  activate(id: string): Promise<Conversation | null>;
  archive(id: string): Promise<void>;
  rename(id: string, label: string): void;
  setAutoApprove(id: string, level: AutoApproveLevel): void;
  sessionName(c: Conversation): string;
}

/** 模型探测最小面（core/model-probe.ModelProbe 结构兼容） */
export interface ConvModelPort {
  modelOf(convId: string): Promise<string | null>;
}

export interface ConversationsRoutesDeps {
  db: Database;
  convs: ConvManagerPort;
  /** tmux 注入锁（与引擎/PM/act/WS 聊天同一实例，锁才有互斥意义） */
  mutex: KeyedMutex;
  /** 当前模型探测（读会话 jsonl，见 core/model-probe）；缺省 = model 恒 null（前端不显示） */
  models?: ConvModelPort;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
}

export function conversationsRoutes(deps: ConversationsRoutesDeps): RouteDef[] {
  const { db, convs, mutex, models } = deps;

  /** 取一条属于本项目的 chat 对话（跨项目/非 chat/不存在 → 错误响应） */
  const chatConvOf = (
    params: Record<string, string>,
  ): { conv: Conversation } | { error: Response } => {
    const pid = Number(params.projectId);
    const c = convs.get(params.convId ?? '');
    if (!c || c.projectId !== pid) return { error: json({ ok: false, error: '无此对话' }, 404) };
    if (c.kind !== 'chat') {
      return { error: json({ ok: false, error: 'issue 对话由引擎管理，不能在此操作' }, 400) };
    }
    return { conv: c };
  };

  return [
    {
      method: 'GET',
      path: '/api/projects/:projectId/conversations',
      auth: 'project-access',
      handler: ({ params, url }) => {
        const pid = Number(params.projectId);
        if (!getProject(db, pid)) return json({ ok: false, error: '无此项目' }, 404);
        const iaw = url.searchParams.get('includeArchived');
        const includeArchived = iaw === '1' || iaw === 'true';
        return json({ ok: true, conversations: convs.listChats(pid, includeArchived) });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/conversations',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const pid = Number(params.projectId);
        if (!getProject(db, pid)) return json({ ok: false, error: '无此项目' }, 404);
        const b = await readBody(req);
        const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim() : '新对话';
        const agent: AgentKind = b.agent === 'codex' ? 'codex' : 'claude';
        const support = projectAgentSupport(db, pid, agent);
        if (!support.ok) return json({ ok: false, error: support.error }, 409);
        const conversation = convs.create(pid, label, agent, 'chat');
        return json({ ok: true, conversation });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/conversations/:convId/activate',
      auth: 'project-access',
      handler: async ({ params }) => {
        const r = chatConvOf(params);
        if ('error' in r) return r.error;
        const support = projectAgentSupport(db, r.conv.projectId, r.conv.agent);
        if (!support.ok) return json({ ok: false, error: support.error }, 409);
        const session = convs.sessionName(r.conv);
        try {
          const conversation = await mutex.runExclusive(tmuxLockKey(session), () =>
            convs.activate(r.conv.id),
          );
          return json({ ok: true, conversation });
        } catch (e) {
          return json({ ok: false, error: `启动失败：${String(e).slice(0, 200)}` }, 502);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/conversations/:convId/archive',
      auth: 'project-access',
      handler: async ({ params }) => {
        const r = chatConvOf(params);
        if ('error' in r) return r.error;
        const session = convs.sessionName(r.conv);
        try {
          await mutex.runExclusive(tmuxLockKey(session), () => convs.archive(r.conv.id));
        } catch (e) {
          return json({ ok: false, error: `归档失败：${String(e).slice(0, 200)}` }, 502);
        }
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/conversations/:convId/rename',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const r = chatConvOf(params);
        if ('error' in r) return r.error;
        const b = await readBody(req);
        const label = typeof b.label === 'string' ? b.label.trim() : '';
        if (!label) return json({ ok: false, error: '缺 label' }, 400);
        convs.rename(r.conv.id, label);
        return json({ ok: true, conversation: convs.get(r.conv.id) });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/conversations/:convId/auto-approve',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const r = chatConvOf(params);
        if ('error' in r) return r.error;
        const level = parseAutoApproveLevel((await readBody(req)).level);
        if (!level) return json({ ok: false, error: 'level 必须是 cautious/medium/auto' }, 400);
        convs.setAutoApprove(r.conv.id, level);
        return json({ ok: true, conversation: convs.get(r.conv.id) });
      },
    },
    {
      // 当前使用的模型（issue #109）：只读展示，chat 与 issue 引擎对话都放行（详情页顶部要显示
      // 执行会话在用的模型），故不走 chatConvOf 的 kind 闸。model 可为 null = 还没开跑/探不到，
      // 前端据此不显示（绝不拿代理默认模型顶替）。
      method: 'GET',
      path: '/api/projects/:projectId/conversations/:convId/model',
      auth: 'project-access',
      handler: async ({ params }) => {
        const pid = Number(params.projectId);
        const c = convs.get(params.convId ?? '');
        if (!c || c.projectId !== pid) return json({ ok: false, error: '无此对话' }, 404);
        const model = models ? await models.modelOf(c.id).catch(() => null) : null;
        return json({ ok: true, agent: c.agent, model });
      },
    },
  ];
}
