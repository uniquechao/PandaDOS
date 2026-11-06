import type { Database } from 'bun:sqlite';
import { parseLines } from '../core/jsonl';
import type { Conversation, Executor } from '../core/types';
import { codexTitles, type AgentHistoryReader } from './agent-history';

interface Binding {
  id: string;
  agent: string;
  agent_session_id: string | null;
  agent_jsonl_path: string | null;
  persisted_path?: string | null;
}

interface TranscriptState {
  offset: number;
  pending: string;
  decoder: TextDecoder;
  customTitle: string | null;
  summary: string | null;
  firstUser: string | null;
  mtimeMs?: number;
}

const cleanTitle = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  return value.replace(/\s+/g, ' ').trim().slice(0, 80) || null;
};

/** 只消费原生结构化元数据；普通消息只用于首条用户消息的临时摘要。 */
export class ConversationTitleSync {
  private readonly transcripts = new Map<string, TranscriptState>();
  private readonly running = new Map<number, Promise<void>>();

  constructor(private readonly db: Database) {}

  sync(
    projectId: number,
    executor: Pick<Executor, 'id' | 'codexDir'>,
    reader: AgentHistoryReader,
    conversations: Conversation[],
    locate?: (id: string) => Promise<string | null>,
  ): Promise<void> {
    const active = this.running.get(projectId);
    if (active) return active;
    const work = this.syncProject(projectId, executor, reader, conversations, locate)
      .finally(() => { this.running.delete(projectId); });
    this.running.set(projectId, work);
    return work;
  }

  private async syncProject(
    projectId: number,
    executor: Pick<Executor, 'id' | 'codexDir'>,
    reader: AgentHistoryReader,
    conversations: Conversation[],
    locate?: (id: string) => Promise<string | null>,
  ): Promise<void> {
    const bindings: Binding[] = [];
    // 定位器负责已有会话的严格绑定；这里不从 cwd 或最近会话猜测归属。
    for (const conversation of conversations) {
      if (conversation.kind !== 'chat' || conversation.sharedReadOnly) continue;
      const path = locate ? await locate(conversation.id).catch(() => null) : null;
      const row = this.db.query<Binding, [string, number]>(
        'SELECT id, agent, agent_session_id, agent_jsonl_path FROM conversations WHERE id = ? AND project_id = ?',
      ).get(conversation.id, projectId);
      if (row) bindings.push({ ...row, persisted_path: row.agent_jsonl_path, agent_jsonl_path: path ?? row.agent_jsonl_path });
    }
    const titles = await codexTitles(reader, executor.codexDir, new Set(bindings
      .filter((row) => row.agent === 'codex' && row.agent_session_id)
      .map((row) => row.agent_session_id!)));
    for (const binding of bindings) {
      const sid = binding.agent_session_id ?? (binding.agent === 'claude' ? binding.id : null);
      if (!sid) continue;
      let transcript: TranscriptState | null = null;
      if (binding.agent_jsonl_path) {
        const key = `${executor.id}:${binding.agent}:${sid}:${binding.agent_jsonl_path}`;
        transcript = await this.readTranscript(reader, binding.agent_jsonl_path, key, sid).catch(() => null);
      }
      const title = binding.agent === 'codex'
        ? cleanTitle(titles.get(sid))
        : transcript?.customTitle ?? transcript?.summary ?? null;
      // SQL 在异步读取结束后重新判断手动覆盖与原生绑定，防止重命名/重绑期间的旧读覆盖。
      this.db.query(`UPDATE conversations SET
          agent_title = COALESCE(?, agent_title),
          first_message_title = COALESCE(first_message_title, ?),
          label = COALESCE(manual_title, ?, agent_title, first_message_title,
            CASE WHEN label IS NULL OR trim(label) = '' OR label IN ('新对话', '会话')
              THEN COALESCE(?, label) ELSE label END)
        WHERE id = ? AND project_id = ? AND agent = ?
          AND agent_session_id IS ? AND agent_jsonl_path IS ? AND kind = 'chat'
          AND shared_read_only = 0`).run(
        title, transcript?.firstUser ?? null, title, transcript?.firstUser ?? null, binding.id, projectId, binding.agent,
        binding.agent_session_id,
        // Claude 原生定位器不回填路径；必须比对读取前真实的数据库路径。
        binding.persisted_path ?? null,
      );
    }
  }

  private async readTranscript(
    reader: AgentHistoryReader, path: string, key: string, sid: string,
  ): Promise<TranscriptState | null> {
    const stat = await reader.statPath(path);
    if (!stat || stat.isDirectory) return null;
    let state = this.transcripts.get(key);
    if (!state || stat.size < state.offset ||
        (stat.size === state.offset && stat.mtimeMs !== undefined && state.mtimeMs !== stat.mtimeMs)) {
      state = { offset: 0, pending: '', decoder: new TextDecoder(), customTitle: null, summary: null, firstUser: null };
      // 缓存只保存元数据，限制长期浏览很多历史对话时的内存占用。
      if (this.transcripts.size >= 256) this.transcripts.delete(this.transcripts.keys().next().value!);
      this.transcripts.set(key, state);
    }
    const end = Math.min(stat.size, state.offset + 4 * 1024 * 1024);
    while (state.offset < end) {
      const chunk = await reader.readFileRange(path, state.offset, Math.min(256 * 1024, end - state.offset));
      if (!chunk.data.length) break;
      state.offset += chunk.data.length;
      const lines = (state.pending + state.decoder.decode(chunk.data, { stream: true })).split('\n');
      state.pending = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // Claude 子代理或其他会话的标题即使混入文件也不能覆盖当前会话。
          if (entry.sessionId && entry.sessionId !== sid) continue;
          if (entry.type === 'custom-title' && entry.sessionId === sid) {
            state.customTitle = cleanTitle(entry.customTitle) ?? state.customTitle;
          } else if (entry.type === 'summary') {
            state.summary = cleanTitle(entry.summary) ?? state.summary;
          }
          if (!state.firstUser) {
            const user = parseLines([line], 0).msgs.find((message) => message.role === 'user');
            state.firstUser = cleanTitle(user?.text);
          }
        } catch { /* 损坏或未完成的记录不清空已有名称。 */ }
      }
    }
    state.mtimeMs = stat.mtimeMs;
    return state;
  }
}

export function restoreAgentTitle(db: Database, id: string): void {
  db.query(`UPDATE conversations SET manual_title = NULL,
    label = COALESCE(agent_title, first_message_title, '新对话') WHERE id = ? AND kind = 'chat'`).run(id);
}
