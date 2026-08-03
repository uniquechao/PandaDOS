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
import {
  archiveHistoryConversations,
  findBoundHistoryConversation,
  type HistoryArchiveFs,
  importableHistorySessions,
  importHistoryConversations,
} from '../../core/conversation-history';
import { getExecutor, projectAgentSupport } from '../../core/executors';
import {
  parseAutoApproveLevel,
  type AgentKind,
  type AutoApproveLevel,
  type Conversation,
  type Project,
  type ProjectKind,
} from '../../core/types';
import {
  discoverExecutorAgentHistory,
  type AgentHistoryReader,
  type AgentHistorySession,
} from '../../executor/agent-history';
import { getProject } from '../../issues/engine';
import { type KeyedMutex, tmuxLockKey } from '../../issues/mutex';
import { apiError } from '../errors';
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
  /** 项目所在执行机的只读 Driver；本地历史查询/导入使用。缺省时相关端点返回 503。 */
  driverForProject?(project: Project): AgentHistoryReader & HistoryArchiveFs;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
}

export function conversationsRoutes(deps: ConversationsRoutesDeps): RouteDef[] {
  const { db, convs, mutex, models } = deps;

  const discoverProjectHistory = async (
    project: Project,
  ): Promise<{ sessions: AgentHistorySession[] } | { error: Response }> => {
    if (!deps.driverForProject) {
      return {
        error: json(apiError(
          'executor.driver_unavailable',
          'Executor operations are unavailable because no driver is configured.',
          503,
        ), 503),
      };
    }
    const executor = getExecutor(db, project.executorId);
    if (!executor) {
      return { error: json(apiError('executor.not_found', 'The executor does not exist.', 409), 409) };
    }
    const projectCwd = project.cwd === '/' ? '/' : project.cwd.replace(/\/+$/, '');
    try {
      const history = await discoverExecutorAgentHistory(deps.driverForProject(project), executor);
      return {
        sessions: importableHistorySessions(
          db,
          history.sessions.filter((session) => session.cwd === projectCwd),
        ),
      };
    } catch (e) {
      return {
        error: json(apiError(
          'history.read_failed',
          'Could not read local agent history.',
          502,
          {},
          String(e).slice(0, 200),
        ), 502),
      };
    }
  };

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
      /** 当前项目 cwd 的本地 Claude/Codex 历史候选；不向浏览器暴露执行机 JSONL 路径。 */
      method: 'GET',
      path: '/api/projects/:projectId/conversations/local-history',
      auth: 'project-access',
      handler: async ({ params }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json(apiError('project.not_found', 'The project does not exist.', 404), 404);
        const found = await discoverProjectHistory(project);
        if ('error' in found) return found.error;
        const sessions = found.sessions.flatMap((session) => {
          const bound = findBoundHistoryConversation(db, session);
          if (bound && bound.projectId !== project.id) return [];
          return [{
            agent: session.agent,
            sessionId: session.sessionId,
            title: session.title,
            createdTs: session.createdTs,
            updatedTs: session.updatedTs,
            importedConversationId: bound?.id ?? null,
          }];
        });
        return json({ ok: true, cwd: project.cwd, sessions });
      },
    },
    {
      /**
       * 选取当前 cwd 的原生会话并绑定为 chat 对话。请求只携带 agent+sessionId；路径、时间、
       * 标题全部以本轮执行机扫描结果为准，防止跨 cwd 或伪造文件导入。
       */
      method: 'POST',
      path: '/api/projects/:projectId/conversations/local-history',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json(apiError('project.not_found', 'The project does not exist.', 404), 404);
        const historyFs = deps.driverForProject?.(project);
        if (!historyFs) {
          return json(apiError(
            'executor.driver_unavailable',
            'Executor operations are unavailable because no driver is configured.',
            503,
          ), 503);
        }
        const body = await readBody(req);
        if (!Array.isArray(body.sessions) || body.sessions.length === 0 || body.sessions.length > 200) {
          return json(apiError(
            'history.selection_required',
            'Select between 1 and 200 history sessions.',
            400,
          ), 400);
        }
        const selections: Array<{ agent: AgentKind; sessionId: string }> = [];
        const requested = new Set<string>();
        for (const raw of body.sessions) {
          if (!raw || typeof raw !== 'object') {
            return json(apiError(
              'history.selection_invalid',
              'The selected history sessions are invalid.',
              400,
            ), 400);
          }
          const value = raw as { agent?: unknown; sessionId?: unknown };
          if (
            (value.agent !== 'claude' && value.agent !== 'codex') ||
            typeof value.sessionId !== 'string' || !value.sessionId.trim()
          ) {
            return json(apiError(
              'history.selection_invalid',
              'The selected history sessions are invalid.',
              400,
            ), 400);
          }
          const key = `${value.agent}\0${value.sessionId}`;
          if (requested.has(key)) continue;
          requested.add(key);
          selections.push({ agent: value.agent, sessionId: value.sessionId });
        }
        const found = await discoverProjectHistory(project);
        if ('error' in found) return found.error;
        const byKey = new Map(found.sessions.map((session) => [`${session.agent}\0${session.sessionId}`, session]));
        const selected = selections.map((selection) => byKey.get(`${selection.agent}\0${selection.sessionId}`));
        if (selected.some((session) => !session)) {
          return json(apiError(
            'history.not_found',
            'A selected history session was not found or does not match this project’s working directory.',
            404,
          ), 404);
        }
        const sessions = selected as AgentHistorySession[];
        const conflict = sessions
          .map((session) => ({ session, bound: findBoundHistoryConversation(db, session) }))
          .find(({ bound }) => bound && bound.projectId !== project.id);
        if (conflict?.bound) {
          return json(apiError(
            'history.assigned',
            'A selected history session belongs to another project.',
            409,
          ), 409);
        }
        try {
          await archiveHistoryConversations(historyFs, project.cwd, sessions);
          const result = importHistoryConversations(db, project.id, sessions);
          if (result.conflicts.length > 0) {
            return json(apiError(
              'history.assigned',
              'A selected history session belongs to another project.',
              409,
            ), 409);
          }
          const ids = [...result.importedIds, ...result.existingIds];
          return json({
            ok: true,
            imported: result.importedIds.length,
            existing: result.existingIds.length,
            conversations: ids.map((id) => convs.get(id)).filter(Boolean),
          });
        } catch (e) {
          return json(apiError(
            'history.import_failed',
            'Could not import local history.',
            500,
            {},
            String(e).slice(0, 200),
          ), 500);
        }
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
