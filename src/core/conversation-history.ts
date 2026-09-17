/** 将执行机原生 Agent 历史绑定为 PandaDOS chat 对话的统一持久化规则。 */
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { AgentKind, ConversationKind } from './types';

export const CONVERSATION_ARCHIVE_DIR = '.panda/conversations';
const ARCHIVE_READ_CHUNK_BYTES = 1024 * 1024;

/** 与 executor/agent-history.AgentHistorySession 结构兼容，避免 core 反向依赖 executor。 */
export interface HistoryConversationInput {
  agent: AgentKind;
  sessionId: string;
  jsonlPath: string;
  createdTs: number;
  updatedTs: number;
  title: string | null;
}

export interface BoundHistoryConversation {
  id: string;
  projectId: number;
  kind: ConversationKind;
}

export interface ImportHistoryConversationsResult {
  importedIds: string[];
  existingIds: string[];
  conflicts: Array<{ agent: AgentKind; sessionId: string; projectId: number }>;
}

export interface HistoryArchiveFs {
  readFileRange(path: string, offset: number, limit: number): Promise<{ data: Uint8Array; size: number }>;
  statPath(path: string): Promise<{ size: number; isDirectory: boolean } | null>;
  writeFile(path: string, data: Uint8Array | string, mode?: number): Promise<void>;
}

/** 标准 CLI session id 保留原名；异常 id 改用稳定摘要，防路径穿越和文件名过长。 */
export function historyArchiveRelPath(
  session: Pick<HistoryConversationInput, 'agent' | 'sessionId'>,
): string {
  const filename = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(session.sessionId)
    ? session.sessionId
    : `session-${createHash('sha256').update(`${session.agent}\0${session.sessionId}`).digest('hex').slice(0, 24)}`;
  return `${CONVERSATION_ARCHIVE_DIR}/${session.agent}/${filename}.jsonl`;
}

async function readCompleteHistory(fs: HistoryArchiveFs, path: string): Promise<Uint8Array> {
  const stat = await fs.statPath(path);
  if (!stat || stat.isDirectory || !Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw new Error(`历史会话源文件不可读: ${path}`);
  }
  const data = new Uint8Array(stat.size);
  let offset = 0;
  while (offset < stat.size) {
    const part = await fs.readFileRange(path, offset, Math.min(ARCHIVE_READ_CHUNK_BYTES, stat.size - offset));
    if (part.data.length === 0) throw new Error(`历史会话源文件在读取时被截断: ${path}`);
    const length = Math.min(part.data.length, stat.size - offset);
    data.set(part.data.subarray(0, length), offset);
    offset += length;
  }
  return data;
}

/**
 * 把已选原生会话按 Agent 分目录原样快照到项目内。重复导入覆盖同一文件；
 * 不改写 session.jsonlPath，会话 resume/tail 仍使用 Agent 原始路径。
 */
export async function archiveHistoryConversations(
  fs: HistoryArchiveFs,
  cwd: string,
  sessions: HistoryConversationInput[],
): Promise<void> {
  const base = cwd === '/' ? '' : cwd.replace(/\/+$/, '');
  for (const session of sessions) {
    const data = await readCompleteHistory(fs, session.jsonlPath);
    await fs.writeFile(posix.join(base || '/', historyArchiveRelPath(session)), data);
  }
}

/** Claude 以 conversation id、Codex 以 agent_session_id 识别同一原生会话。 */
export function findBoundHistoryConversation(
  db: Database,
  session: Pick<HistoryConversationInput, 'agent' | 'sessionId'>,
): BoundHistoryConversation | null {
  const row = session.agent === 'claude'
    ? db
        .query<{ id: string; project_id: number; kind: string }, [string]>(
          `SELECT id, project_id, kind FROM conversations WHERE id = ? AND agent = 'claude'`,
        )
        .get(session.sessionId)
    : db
        .query<{ id: string; project_id: number; kind: string }, [string]>(
          `SELECT id, project_id, kind FROM conversations
           WHERE agent = 'codex' AND agent_session_id = ? ORDER BY created_ts LIMIT 1`,
        )
        .get(session.sessionId);
  return row ? { id: row.id, projectId: row.project_id, kind: row.kind === 'chat' ? 'chat' : 'issue' } : null;
}

function isDesignBoundConversation(db: Database, conversationId: string): boolean {
  const exists = db.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'design_tasks'`,
  ).get()!.n > 0;
  if (exists && db.query<{ found: number }, [string]>(
    'SELECT 1 AS found FROM design_tasks WHERE conversation_id = ?',
  ).get(conversationId)?.found === 1) return true;
  const hasOwners = db.query<{ found: number }, []>(
    `SELECT COUNT(*) AS found FROM sqlite_master
     WHERE type = 'table' AND name = 'design_saga_conversation_owners'`,
  ).get()!.found > 0;
  return hasOwners && db.query<{ found: number }, [string]>(
    `SELECT 1 AS found FROM design_saga_conversation_owners
     WHERE conversation_id = ?`,
  ).get(conversationId)?.found === 1;
}

/** PandaDOS issue 引擎发起的原生会话不应再被当作用户本地历史导入。 */
export function importableHistorySessions<T extends Pick<HistoryConversationInput, 'agent' | 'sessionId'>>(
  db: Database,
  sessions: T[],
): T[] {
  return sessions.filter((session) => {
    const bound = findBoundHistoryConversation(db, session);
    return bound?.kind !== 'issue' && (!bound || !isDesignBoundConversation(db, bound.id));
  });
}

function insertHistoryConversation(db: Database, projectId: number, session: HistoryConversationInput): string {
  // Claude CLI 可直接 --resume 原 session id；Codex 的 conversation id 是 PandaDOS 内部键，
  // 原生 session id 单独存 agent_session_id，启动时走 `codex resume <sid>`。
  const id = session.agent === 'claude' ? session.sessionId : crypto.randomUUID();
  db.query(
    `INSERT INTO conversations
       (id, project_id, label, created_ts, agent, agent_session_id, agent_jsonl_path,
        agent_launch_ts, kind, last_active_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'chat', ?)`,
  ).run(
    id,
    projectId,
    (session.title ?? session.sessionId).slice(0, 80),
    session.createdTs,
    session.agent,
    session.sessionId,
    session.jsonlPath,
    session.createdTs,
    session.updatedTs,
  );
  return id;
}

/**
 * 幂等批量绑定历史：同项目已有会话回 existingIds；被其他项目占用的不复制，回 conflicts；
 * 其余在同一 SQLite 事务内写入，任一失败整批回滚。
 */
export function importHistoryConversations(
  db: Database,
  projectId: number,
  sessions: HistoryConversationInput[],
): ImportHistoryConversationsResult {
  const result: ImportHistoryConversationsResult = {
    importedIds: [],
    existingIds: [],
    conflicts: [],
  };
  db.transaction(() => {
    for (const session of importableHistorySessions(db, sessions)) {
      const bound = findBoundHistoryConversation(db, session);
      if (bound?.projectId === projectId) {
        result.existingIds.push(bound.id);
        continue;
      }
      if (bound) {
        result.conflicts.push({ agent: session.agent, sessionId: session.sessionId, projectId: bound.projectId });
        continue;
      }
      result.importedIds.push(insertHistoryConversation(db, projectId, session));
    }
  })();
  return result;
}
