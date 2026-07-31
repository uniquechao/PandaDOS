/**
 * web/ws —— WS 挂载点聚合：upgrade 前鉴权 + 按 kind 分发 open/message/close。
 *
 * 鉴权（与 middleware 'project-access' 语义一致，upgrade 前完成）：
 * - 无 token/token 无效 → 401；
 * - 项目不存在：admin 见 404，普通用户统一 403（不泄露项目是否存在）；
 * - 非属主、非成员且非 admin → 403（终端/对话属协作面，关联成员亦可接入）。
 *
 * 路由：
 * - GET /ws/term/:projectId?issue=&conv=&session=&cols=&rows= → PTY 桥（term.ts）
 *   终端目标是互斥的强类型 selector：
 *     · 无 selector = 项目隔离 Bash console（cc-<pid>-console，缺则懒建）；
 *     · issue = 仅本项目当前驱动、仍绑定 currentConv 的 issue，解析 cc/module tmux；
 *     · conv = 仅本项目 kind='chat' 的独立对话，解析 chat-<convId>；
 *     · session = 本项目 sessions 表登记的显式导入会话。
 *   agent tmux 永不按名字猜测或兜底连接，历史 issue / 非 chat 对话 / 冲突 selector 一律拒绝。
 * - GET /ws/chat/:projectId → 聊天流（chat.ts），对话 = 项目当前激活对话；
 *   ?conv=<convId> 钉住对话：
 *     · issue 引擎绑定对话 → 项目 cc-<pid> 会话，live=激活对话全交互、非激活只读历史；
 *     · chat 独立对话（对话模式）→ 注入/抓屏打到它自身会话 chat-<convId>，恒可注入。
 */
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { Database } from 'bun:sqlite';
import type { MessageBumper } from '../../core/activity';
import { chatTmux } from '../../core/conversations';
import { ProjectMemberStore } from '../../core/members';
import type { JsonlReader } from '../../core/jsonl';
import type { Project, User } from '../../core/types';
import type { UserStore } from '../../core/users';
import type { ExecutorDriver } from '../../executor/driver';
import { getProject } from '../../issues/engine';
import type { KeyedMutex } from '../../issues/mutex';
import { resolveUser, type SessionLookup } from '../auth';
import { json } from '../middleware';
import {
  chatClose,
  chatMessage,
  chatOpen,
  type ChatApprovals,
  type ChatWsData,
  type ChatWsDeps,
} from './chat';
import { clampInt, termClose, termMessage, termOpen, type TermWsData } from './term';

export type WsData = TermWsData | ChatWsData;

export interface WsDeps {
  db: Database;
  users: UserStore;
  /** 登录会话查找（飞书扫码签发）；缺省不接 = 只认长期 token */
  sessions?: SessionLookup;
  convs: {
    tmuxName(projectId: number, convId?: string | null): string;
    currentConv(projectId: number): string | undefined;
    /** 就绪门禁自愈：codex 退回 shell 时重启会话（ConversationManager.activate） */
    activate?(convId: string): Promise<unknown>;
  };
  locator: { locate(convId: string): Promise<string | null> };
  mutex: KeyedMutex;
  /** jsonl 读取面（与引擎/locator 同源 = 主执行机 Driver） */
  reader: JsonlReader;
  /** tmux/PTY 操作面：项目 → 其 executor 的 Driver */
  driverForProject(project: Project): ExecutorDriver;
  approvals?: ChatApprovals;
  /** 菜单解读（issue #112「解释一下」）；缺省不接 = 前端点了收 explain_failed */
  explain?: ChatWsDeps['explain'];
  chatPollMs?: number;
  retryDelayMs?: number;
  /** 用户消息计数（013）：chat 文本帧注入成功后记一笔；缺省不接 = 不统计 */
  messages?: MessageBumper;
}

const TERM_RE = /^\/ws\/term\/(\d+)$/;
const CHAT_RE = /^\/ws\/chat\/(\d+)$/;

type TermTarget =
  | { kind: 'console'; session: string; createIfMissing: true }
  | { kind: 'imported'; session: string; createIfMissing: false }
  | { kind: 'issue'; session: string; createIfMissing: false }
  | { kind: 'conversation'; session: string; createIfMissing: false };

type TermTargetResult = { target: TermTarget } | { deny: Response };

function targetDeny(error: string, status: number): TermTargetResult {
  return { deny: json({ ok: false, error }, status) };
}

function parseIssueId(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * 终端的 selector 是能力边界，不是任意 tmux 名称的别名。
 * issue 必须同时满足「运行态、绑定合法对话、仍是项目 currentConv」：模块复用会让历史
 * issue 与当前 issue 指向同一 conv，若仅凭 conv 解析就会把历史页误接到当前代理。
 */
function resolveTermTarget(deps: WsDeps, projectId: number, url: URL, ded: string): TermTargetResult {
  const hasSession = url.searchParams.has('session');
  const hasIssue = url.searchParams.has('issue');
  const hasConv = url.searchParams.has('conv');
  if ([hasSession, hasIssue, hasConv].filter(Boolean).length > 1) {
    return targetDeny('终端目标参数冲突', 400);
  }
  if (
    url.searchParams.getAll('session').length > 1 ||
    url.searchParams.getAll('issue').length > 1 ||
    url.searchParams.getAll('conv').length > 1
  ) {
    return targetDeny('终端目标参数冲突', 400);
  }

  if (!hasSession && !hasIssue && !hasConv) {
    return { target: { kind: 'console', session: `${ded}-console`, createIfMissing: true } };
  }

  if (hasSession) {
    const session = url.searchParams.get('session') ?? '';
    if (!/^[\w.-]+$/.test(session)) return targetDeny('非法会话名', 400);
    const moduleSession = deps.db
      .query<{ slug: string }, [number]>(
        'SELECT slug FROM project_modules WHERE project_id = ?',
      )
      .all(projectId)
      .some((m) => session === `${ded}-m-${m.slug}`);
    const chatSession = deps.db
      .query<{ id: string }, [number, string]>(
        `SELECT id FROM conversations
         WHERE project_id = ? AND kind = 'chat' AND 'chat-' || id = ?`,
      )
      .get(projectId, session);
    // 导入登记不能覆盖本服务管理的 agent 会话；它们必须走 issue / conv 的事实校验。
    if (session === ded || moduleSession || chatSession) {
      return targetDeny('agent 会话不能通过 session 直接接入', 403);
    }
    const imported = deps.db
      .query<{ name: string }, [string, number]>('SELECT name FROM sessions WHERE name = ? AND project_id = ?')
      .get(session, projectId);
    if (!imported) return targetDeny('会话不属于该项目', 403);
    return { target: { kind: 'imported', session, createIfMissing: false } };
  }

  if (hasIssue) {
    const raw = url.searchParams.get('issue') ?? '';
    const issueId = parseIssueId(raw);
    if (issueId === null) return targetDeny('非法 issue id', 400);
    const scope = deps.db.query<{ project_id: number }, [number]>('SELECT project_id FROM issues WHERE id = ?').get(issueId);
    if (!scope) return targetDeny('issue 不存在', 404);
    if (scope.project_id !== projectId) return targetDeny('issue 不属于该项目', 403);
    const issue = deps.db
      .query<{ conv_id: string }, [number, number]>(
        `SELECT i.conv_id
         FROM issues i
         JOIN conversations c ON c.id = i.conv_id AND c.project_id = i.project_id AND c.kind = 'issue'
         WHERE i.id = ? AND i.project_id = ?
           AND i.status IN ('planning', 'implementing', 'testing')`,
      )
      .get(issueId, projectId);
    if (!issue || deps.convs.currentConv(projectId) !== issue.conv_id) {
      return targetDeny('issue 不在当前执行中', 409);
    }
    return {
      target: {
        kind: 'issue',
        session: deps.convs.tmuxName(projectId, issue.conv_id),
        createIfMissing: false,
      },
    };
  }

  const convId = url.searchParams.get('conv') ?? '';
  if (!convId) return targetDeny('非法对话 id', 400);
  const scope = deps.db
    .query<{ project_id: number }, [string]>('SELECT project_id FROM conversations WHERE id = ?')
    .get(convId);
  if (!scope) return targetDeny('对话不存在', 404);
  if (scope.project_id !== projectId) return targetDeny('对话不属于该项目', 403);
  const conv = deps.db
    .query<{ kind: string }, [string, number]>('SELECT kind FROM conversations WHERE id = ? AND project_id = ?')
    .get(convId, projectId);
  if (!conv || conv.kind !== 'chat') return targetDeny('对话不是独立 chat 会话', 409);
  return { target: { kind: 'conversation', session: chatTmux(convId), createIfMissing: false } };
}

/** 项目访问鉴权（middleware 'project-access' 语义镜像：属主 ∨ 成员 ∨ admin）；
 *  通过返回 project，否则返回拒绝 Response */
function authorize(
  deps: WsDeps,
  user: User | null,
  projectId: number,
): { project: Project } | { deny: Response } {
  if (!user) return { deny: json({ ok: false, error: '未登录' }, 401) };
  const project = getProject(deps.db, projectId);
  if (!project) {
    return {
      deny:
        user.role === 'admin'
          ? json({ ok: false, error: '项目不存在' }, 404)
          : json({ ok: false, error: '无权限' }, 403),
    };
  }
  // 属主已加载在 project 上，成员另查（与 hasProjectAccess 同口径：owner ∨ member）
  if (
    user.role !== 'admin' &&
    project.ownerUserId !== user.id &&
    !new ProjectMemberStore(deps.db).isMember(projectId, user.id)
  ) {
    return { deny: json({ ok: false, error: '无权限' }, 403) };
  }
  return { project };
}

/**
 * /ws/* 的 upgrade 入口（server.ts fetch 内调用）。
 * 返回 Response = 拒绝/参数错误；undefined = 已升级（fetch 应原样返回 undefined）；
 * null = 不是 WS 路由（调用方继续走 API/静态）。
 */
export async function handleWsUpgrade(
  req: Request,
  url: URL,
  server: Server<WsData>,
  deps: WsDeps,
): Promise<Response | undefined | null> {
  const term = url.pathname.match(TERM_RE);
  const chat = term ? null : url.pathname.match(CHAT_RE);
  if (!term && !chat) return null;

  const user = resolveUser(req, deps.users, deps.sessions);
  const pid = Number((term ?? chat)![1]);
  const auth = authorize(deps, user, pid);
  if ('deny' in auth) return auth.deny;
  const project = auth.project;
  const driver = deps.driverForProject(project);
  const ded = deps.convs.tmuxName(pid);

  if (term) {
    const resolved = resolveTermTarget(deps, pid, url, ded);
    if ('deny' in resolved) return resolved.deny;
    const { target } = resolved;
    const session = target.session;
    const sessions = await driver.listSessions().catch(() => []);
    let exists = sessions.some((s) => s.name === session);
    if (!exists && target.createIfMissing) {
      try {
        await driver.createSession(session, project.cwd);
        exists = true;
      } catch {
        // 并发竞态：可能已被另一条连接建好，再查一次避免误判
        exists = (await driver.listSessions().catch(() => [])).some((s) => s.name === session);
      }
    }
    if (!exists) return json({ ok: false, error: '会话不存在' }, 404);
    const data: TermWsData = {
      kind: 'term',
      session,
      cols: clampInt(url.searchParams.get('cols'), 120, 20, 400),
      rows: clampInt(url.searchParams.get('rows'), 30, 5, 200),
      driver,
      pty: null,
      pending: [],
      closed: false,
    };
    return server.upgrade(req, { data }) ? undefined : json({ ok: false, error: 'upgrade failed' }, 400);
  }

  // ?conv= 钉住对话：必须属于该项目——防跨项目读任意对话历史。
  // 不存在与不属于同视为 403（不泄露 conv 存在性，与项目 404/403 语义一致）。
  // kind='chat'（对话模式独立对话）→ 注入/抓屏目标 = 它自己的会话 chat-<convId>，恒可注入；
  // 其余（issue 引擎绑定对话）→ 项目专用 cc-<pid> 会话，走 pinned==active 门控。
  const pinnedConv = url.searchParams.get('conv');
  let chatMode = false;
  let session = deps.convs.tmuxName(pid, deps.convs.currentConv(pid));
  let pinnedAgent: 'claude' | 'codex' | undefined;
  if (pinnedConv !== null) {
    const row = deps.db
      .query<{ id: string; kind: string; agent: string }, [string, number]>(
        'SELECT id, kind, agent FROM conversations WHERE id = ? AND project_id = ?',
      )
      .get(pinnedConv, pid);
    if (!row) return json({ ok: false, error: '对话不属于该项目' }, 403);
    pinnedAgent = row.agent === 'codex' ? 'codex' : 'claude';
    if (row.kind === 'chat') {
      chatMode = true;
      session = chatTmux(pinnedConv);
    } else {
      session = deps.convs.tmuxName(pid, pinnedConv);
    }
  }

  const data: ChatWsData = {
    kind: 'chat',
    projectId: pid,
    userId: user!.id, // authorize 已挡掉未登录（无 user 早已 401），到这里必有
    session,
    cwd: project.cwd,
    driver,
    ...(pinnedAgent ? { agent: pinnedAgent } : {}),
    pinnedConv,
    chatMode,
    live: chatMode || pinnedConv === null,
    convId: null,
    jsonl: null,
    offset: 0,
    nextSeq: 0,
    historyHead: 0,
    lastSelSig: '',
    timer: null,
  };
  return server.upgrade(req, { data }) ? undefined : json({ ok: false, error: 'upgrade failed' }, 400);
}

/** Bun.serve 的 websocket 处理器（按 ws.data.kind 分发） */
export function createWsHandlers(deps: WsDeps): WebSocketHandler<WsData> {
  const chatDeps = {
    reader: deps.reader,
    locator: deps.locator,
    convs: deps.convs,
    mutex: deps.mutex,
    ...(deps.approvals ? { approvals: deps.approvals } : {}),
    ...(deps.explain ? { explain: deps.explain } : {}),
    ...(deps.chatPollMs !== undefined ? { chatPollMs: deps.chatPollMs } : {}),
    ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
    ...(deps.messages ? { messages: deps.messages } : {}),
  };
  return {
    open(ws) {
      if (ws.data.kind === 'term') void termOpen(ws as ServerWebSocket<TermWsData>);
      else void chatOpen(ws as ServerWebSocket<ChatWsData>, chatDeps);
    },
    message(ws, msg) {
      // Bun 的 binary 帧是 Buffer（Uint8Array 子类），零拷贝转视图
      const payload: string | Uint8Array =
        typeof msg === 'string' ? msg : new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
      if (ws.data.kind === 'term') termMessage(ws as ServerWebSocket<TermWsData>, payload);
      else chatMessage(ws as ServerWebSocket<ChatWsData>, payload, chatDeps);
    },
    close(ws) {
      if (ws.data.kind === 'term') termClose(ws as ServerWebSocket<TermWsData>);
      else chatClose(ws as ServerWebSocket<ChatWsData>);
    },
  };
}
