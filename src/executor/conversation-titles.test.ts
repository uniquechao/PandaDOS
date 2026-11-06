import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ConversationTitleSync, restoreAgentTitle } from './conversation-titles';
import type { AgentHistoryReader } from './agent-history';
import type { Conversation } from '../core/types';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE conversations (
    id TEXT PRIMARY KEY, project_id INTEGER, label TEXT, agent TEXT, kind TEXT DEFAULT 'chat',
    agent_session_id TEXT, agent_jsonl_path TEXT, agent_title TEXT, manual_title TEXT, first_message_title TEXT,
    shared_read_only INTEGER DEFAULT 0
  )`);
  const files = new Map<string, string>();
  let offline = false;
  const reads: Array<{ path: string; offset: number }> = [];
  const reader: AgentHistoryReader = {
    listDir: async () => [],
    statPath: async (path) => {
      if (offline) throw new Error('offline');
      const content = files.get(path);
      return content === undefined ? null : { size: new TextEncoder().encode(content).length, isDirectory: false, isFile: true, mode: 0o600, mtimeMs: content.length };
    },
    readFileRange: async (path, offset, limit) => {
      if (offline) throw new Error('offline');
      reads.push({ path, offset });
      const bytes = new TextEncoder().encode(files.get(path) ?? '');
      return { data: bytes.slice(offset, offset + Math.min(limit, 23)), size: bytes.length };
    },
  };
  const sync = new ConversationTitleSync(db);
  const add = (id: string, agent: 'claude' | 'codex' = 'claude', projectId = 1) => {
    db.query(`INSERT INTO conversations
      (id, project_id, label, agent, agent_session_id, agent_jsonl_path)
      VALUES (?, ?, '新对话', ?, ?, ?)`).run(id, projectId, agent, id, `/${id}.jsonl`);
    return { id, projectId, kind: 'chat', agent } as Conversation;
  };
  const get = (id: string) => db.query<any, [string]>('SELECT * FROM conversations WHERE id = ?').get(id)!;
  const run = (conversations: Conversation[]) => sync.sync(1, { id: 1, codexDir: '/codex/sessions' }, reader, conversations);
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  const append = (path: string, value: unknown) => files.set(path, (files.get(path) ?? '') + line(value));
  return { db, files, reader, reads, add, get, run, line, append, sync, setOffline: (value: boolean) => { offline = value; } };
}

describe('会话原生标题同步', () => {
  test('首条用户摘要 → Claude 结构化标题 → 后续改名，增量读取不猜测回复', async () => {
    const f = fixture();
    const c = f.add('claude-a');
    f.append('/claude-a.jsonl', { type: 'user', sessionId: c.id, message: { role: 'user', content: '检查 登录\n流程' } });
    f.append('/claude-a.jsonl', { type: 'assistant', message: { role: 'assistant', content: '标题：不应采用' } });
    await f.run([c]);
    expect(f.get(c.id).label).toBe('检查 登录 流程');
    expect(f.get(c.id).agent_title).toBeNull();
    f.append('/claude-a.jsonl', { type: 'summary', summary: '登录流程检查', leafUuid: 'leaf-a' });
    await f.run([c]);
    expect(f.get(c.id).label).toBe('登录流程检查');
    const before = new TextEncoder().encode(f.files.get('/claude-a.jsonl')).length;
    f.append('/claude-a.jsonl', { type: 'custom-title', sessionId: c.id, customTitle: '修复登录会话' });
    f.reads.length = 0;
    await f.run([c]);
    expect(f.get(c.id).label).toBe('修复登录会话');
    expect(f.reads[0].offset).toBe(before);
    f.append('/claude-a.jsonl', { type: 'custom-title', sessionId: c.id, customTitle: '补齐登录测试' });
    await f.run([c]);
    expect(f.get(c.id).label).toBe('补齐登录测试');
  });

  test('Codex 按原生会话 ID 与 updated_at 取最新标题，不串用同项目其他会话', async () => {
    const f = fixture();
    const a = f.add('codex-a', 'codex');
    const b = f.add('codex-b', 'codex');
    for (const entry of [
      { id: a.id, thread_name: '初始名称', updated_at: '2026-11-04T01:00:00Z' },
      { id: b.id, thread_name: '另一个对话', updated_at: '2026-11-04T03:00:00Z' },
      { id: a.id, thread_name: '更新名称', updated_at: '2026-11-04T02:00:00Z' },
      { id: a.id, thread_name: '迟到的旧名称', updated_at: '2026-11-04T00:00:00Z' },
    ]) f.append('/codex/session_index.jsonl', entry);
    await f.run([a, b]);
    expect(f.get(a.id).label).toBe('更新名称');
    expect(f.get(b.id).label).toBe('另一个对话');
    f.append('/codex/session_index.jsonl', { id: a.id, thread_name: '后续名称', updated_at: '2026-11-04T04:00:00Z' });
    await f.run([a]);
    expect(f.get(a.id).label).toBe('后续名称');
  });

  test('手动名称持续优先，恢复后立即采用保存的最新 Agent 标题', async () => {
    const f = fixture();
    const c = f.add('a', 'codex');
    f.db.run("UPDATE conversations SET label = '我的名称', manual_title = '我的名称' WHERE id = 'a'");
    f.append('/codex/session_index.jsonl', { id: c.id, thread_name: '最新 Agent 名称' });
    await f.run([c]);
    expect(f.get(c.id).label).toBe('我的名称');
    expect(f.get(c.id).agent_title).toBe('最新 Agent 名称');
    restoreAgentTitle(f.db, c.id);
    expect(f.get(c.id).label).toBe('最新 Agent 名称');
    expect(f.get(c.id).manual_title).toBeNull();
  });

  test('手动模式仍保存首条摘要，重建同步器且离线时恢复自动命名使用持久摘要', async () => {
    const f = fixture();
    const c = f.add('a');
    f.db.run("UPDATE conversations SET label = '用户名称', manual_title = '用户名称' WHERE id = 'a'");
    f.append('/a.jsonl', { type: 'user', sessionId: c.id, message: { role: 'user', content: '首条消息摘要' } });
    await f.run([c]);
    expect(f.get(c.id).label).toBe('用户名称');
    expect(f.get(c.id).first_message_title).toBe('首条消息摘要');
    f.setOffline(true);
    const restarted = new ConversationTitleSync(f.db);
    await restarted.sync(1, { id: 1, codexDir: '/codex/sessions' }, f.reader, [c]);
    restoreAgentTitle(f.db, c.id);
    expect(f.get(c.id).label).toBe('首条消息摘要');
    expect(f.get(c.id).manual_title).toBeNull();
    f.setOffline(false);
    f.append('/a.jsonl', { type: 'custom-title', sessionId: c.id, customTitle: '重连标题' });
    await restarted.sync(1, { id: 1, codexDir: '/codex/sessions' }, f.reader, [c]);
    expect(f.get(c.id).label).toBe('重连标题');
  });

  test('没有 Agent 标题或首条摘要时恢复默认名称，之后继续自动同步', async () => {
    const f = fixture();
    const c = f.add('a');
    f.db.run("UPDATE conversations SET label = '用户名称', manual_title = '用户名称' WHERE id = 'a'");
    restoreAgentTitle(f.db, c.id);
    expect(f.get(c.id).label).toBe('新对话');
    f.append('/a.jsonl', { type: 'user', sessionId: c.id, message: { role: 'user', content: '第一条' } });
    await f.run([c]);
    f.append('/a.jsonl', { type: 'user', sessionId: c.id, message: { role: 'user', content: '第二条' } });
    await new ConversationTitleSync(f.db).sync(1, { id: 1, codexDir: '/codex/sessions' }, f.reader, [c]);
    expect(f.get(c.id).label).toBe('第一条');
    expect(f.get(c.id).first_message_title).toBe('第一条');
  });

  test('空标题、损坏行、离线与缺文件均保留名称，恢复后补齐最新值', async () => {
    const f = fixture();
    const c = f.add('a', 'codex');
    f.append('/codex/session_index.jsonl', { id: c.id, thread_name: '已确认名称' });
    await f.run([c]);
    f.files.set('/codex/session_index.jsonl', 'broken\n' + f.line({ id: c.id, thread_name: '  ' }));
    await f.run([c]);
    expect(f.get(c.id).label).toBe('已确认名称');
    f.setOffline(true);
    await f.run([c]);
    expect(f.get(c.id).label).toBe('已确认名称');
    f.setOffline(false);
    f.files.delete('/codex/session_index.jsonl');
    await f.run([c]);
    expect(f.get(c.id).label).toBe('已确认名称');
    f.append('/codex/session_index.jsonl', { id: c.id, thread_name: '重连后的名称' });
    await f.run([c]);
    expect(f.get(c.id).label).toBe('重连后的名称');
  });

  test('Claude 半行、UTF-8 短读、其他会话标题与空值处理', async () => {
    const f = fixture();
    const c = f.add('a');
    const entry = f.line({ type: 'custom-title', sessionId: c.id, customTitle: '中文标题' });
    f.files.set('/a.jsonl', entry.slice(0, -3));
    await f.run([c]);
    expect(f.get(c.id).label).toBe('新对话');
    f.files.set('/a.jsonl', entry);
    await f.run([c]);
    expect(f.get(c.id).label).toBe('中文标题');
    f.append('/a.jsonl', { type: 'custom-title', sessionId: 'another', customTitle: '其他会话' });
    f.append('/a.jsonl', { type: 'custom-title', sessionId: c.id, customTitle: '' });
    await f.run([c]);
    expect(f.get(c.id).label).toBe('中文标题');
  });

  test('读取期间手动改名不能被旧的异步标题覆盖', async () => {
    const f = fixture();
    const c = f.add('a');
    f.append('/a.jsonl', { type: 'custom-title', sessionId: c.id, customTitle: 'Agent 标题' });
    const read = f.reader.readFileRange;
    f.reader.readFileRange = async (...args) => {
      f.db.run("UPDATE conversations SET label = '用户名称', manual_title = '用户名称' WHERE id = 'a'");
      return read(...args);
    };
    await f.run([c]);
    expect(f.get(c.id).label).toBe('用户名称');
    expect(f.get(c.id).agent_title).toBe('Agent 标题');
  });

  test('读取期间会话重新绑定后不采用旧标题；其他项目和只读会话不更新', async () => {
    const f = fixture();
    const c = f.add('a');
    const other = f.add('b', 'claude', 2);
    const shared = f.add('shared');
    shared.sharedReadOnly = true;
    f.append('/a.jsonl', { type: 'custom-title', sessionId: c.id, customTitle: '旧会话名称' });
    const read = f.reader.readFileRange;
    f.reader.readFileRange = async (...args) => {
      f.db.run("UPDATE conversations SET agent_session_id = 'new-sid', agent_jsonl_path = '/new.jsonl' WHERE id = 'a'");
      return read(...args);
    };
    await f.run([c, other, shared]);
    expect(f.get(c.id).label).toBe('新对话');
    expect(f.get(other.id).label).toBe('新对话');
    expect(f.get(shared.id).label).toBe('新对话');
  });

  test('Claude 定位器返回原生路径，无需数据库路径已回填', async () => {
    const f = fixture();
    const c = f.add('a');
    f.db.run("UPDATE conversations SET agent_jsonl_path = NULL WHERE id = 'a'");
    f.append('/located.jsonl', { type: 'custom-title', sessionId: c.id, customTitle: '已定位标题' });
    await f.sync.sync(1, { id: 1, codexDir: '/codex/sessions' }, f.reader, [c], async () => '/located.jsonl');
    expect(f.get(c.id).label).toBe('已定位标题');
  });
});
