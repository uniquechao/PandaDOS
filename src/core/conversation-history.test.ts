import { describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db';
import { migrate } from './migrate';
import { UserStore } from './users';
import { migrateIssueEngine } from '../issues/engine';
import { DesignStore, migrateDesigns } from '../designs/store';
import {
  archiveHistoryConversations,
  findBoundHistoryConversation,
  historyArchiveRelPath,
  importableHistorySessions,
  importHistoryConversations,
  type HistoryConversationInput,
} from './conversation-history';
import { LocalDriver } from '../executor/local';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  const users = new UserStore(db);
  const alice = users.create('alice').user;
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
  );
  const insertProject = db.prepare(
    'INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES (?, 1, ?, ?, 1)',
  );
  insertProject.run('one', '/ws/one', alice.id);
  insertProject.run('two', '/ws/two', alice.id);
  return { db };
}

const claude: HistoryConversationInput = {
  agent: 'claude',
  sessionId: 'claude-history',
  jsonlPath: '/claude/projects/one/claude-history.jsonl',
  createdTs: 100,
  updatedTs: 200,
  title: 'Claude 历史标题',
};

const codex: HistoryConversationInput = {
  agent: 'codex',
  sessionId: 'codex-history',
  jsonlPath: '/codex/sessions/rollout-codex-history.jsonl',
  createdTs: 300,
  updatedTs: 400,
  title: null,
};

describe('importHistoryConversations', () => {
  test('绑定 Claude/Codex 恢复元数据，并保留各自原生 session id 语义', () => {
    const { db } = setup();
    const result = importHistoryConversations(db, 1, [claude, codex]);
    expect(result.existingIds).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.importedIds).toHaveLength(2);
    expect(result.importedIds[0]).toBe(claude.sessionId);
    expect(result.importedIds[1]).not.toBe(codex.sessionId);

    const rows = db.query<{
      id: string;
      label: string;
      agent: string;
      agent_session_id: string;
      agent_jsonl_path: string;
      agent_launch_ts: number;
      last_active_ts: number;
      kind: string;
    }, []>(
      `SELECT id, label, agent, agent_session_id, agent_jsonl_path,
              agent_launch_ts, last_active_ts, kind
       FROM conversations ORDER BY created_ts`,
    ).all();
    expect(rows[0]).toMatchObject({
      id: claude.sessionId,
      label: claude.title,
      agent: 'claude',
      agent_session_id: claude.sessionId,
      agent_jsonl_path: claude.jsonlPath,
      agent_launch_ts: claude.createdTs,
      last_active_ts: claude.updatedTs,
      kind: 'chat',
    });
    expect(rows[1]).toMatchObject({
      label: codex.sessionId,
      agent: 'codex',
      agent_session_id: codex.sessionId,
      agent_jsonl_path: codex.jsonlPath,
      kind: 'chat',
    });
  });

  test('同项目重复导入幂等；其他项目占用时报告冲突且不复制', () => {
    const { db } = setup();
    const first = importHistoryConversations(db, 1, [claude, codex]);
    const again = importHistoryConversations(db, 1, [claude, codex]);
    expect(again).toEqual({
      importedIds: [],
      existingIds: first.importedIds,
      conflicts: [],
    });

    const conflict = importHistoryConversations(db, 2, [claude, codex]);
    expect(conflict.importedIds).toEqual([]);
    expect(conflict.existingIds).toEqual([]);
    expect(conflict.conflicts).toEqual([
      { agent: 'claude', sessionId: claude.sessionId, projectId: 1 },
      { agent: 'codex', sessionId: codex.sessionId, projectId: 1 },
    ]);
    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM conversations').get()!.count).toBe(2);
    expect(findBoundHistoryConversation(db, claude)).toEqual({ id: claude.sessionId, projectId: 1, kind: 'chat' });
    expect(findBoundHistoryConversation(db, codex)).toEqual({ id: first.importedIds[1], projectId: 1, kind: 'chat' });
  });

  test('只排除 PandaDOS issue 会话，保留未绑定和已导入的 chat 会话', () => {
    const { db } = setup();
    const chat = importHistoryConversations(db, 1, [claude]);
    db.query(
      `INSERT INTO conversations
         (id, project_id, label, created_ts, agent, agent_session_id, kind)
       VALUES ('codex-issue', 1, 'issue', 500, 'codex', ?, 'issue')`,
    ).run(codex.sessionId);

    const unbound = { ...codex, sessionId: 'codex-unbound' };
    expect(importableHistorySessions(db, [claude, codex, unbound])).toEqual([claude, unbound]);
    expect(findBoundHistoryConversation(db, claude)).toEqual({
      id: chat.importedIds[0],
      projectId: 1,
      kind: 'chat',
    });
  });

  test('excludes design-bound native sessions from both candidate filtering and import', () => {
    const { db } = setup();
    const first = importHistoryConversations(db, 1, [claude]);
    new DesignStore(db).createTask({
      projectId: 1,
      title: 'Private design',
      originalRequest: 'Do not expose this in ordinary history.',
      agent: 'claude',
      conversationId: first.importedIds[0],
    });

    expect(importableHistorySessions(db, [claude])).toEqual([]);
    expect(importHistoryConversations(db, 1, [claude])).toEqual({
      importedIds: [],
      existingIds: [],
      conflicts: [],
    });
  });

  test('原始 JSONL 按 Agent 完整留存，异常 session id 使用安全且幂等的文件名', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-history-archive-'));
    try {
      const source = path.join(root, 'source.jsonl');
      const cwd = path.join(root, 'project');
      const session = {
        ...codex,
        sessionId: '../unsafe/会话',
        jsonlPath: source,
      };
      await fsp.writeFile(source, '{"text":"第一版"}\n');
      await archiveHistoryConversations(new LocalDriver(), cwd, [session]);
      const rel = historyArchiveRelPath(session);
      expect(rel).toMatch(/^\.panda\/conversations\/codex\/session-[a-f0-9]{24}\.jsonl$/);
      expect(await fsp.readFile(path.join(cwd, rel), 'utf8')).toBe('{"text":"第一版"}\n');

      await fsp.writeFile(source, '{"text":"第二版"}\n');
      await archiveHistoryConversations(new LocalDriver(), cwd, [session]);
      expect(await fsp.readFile(path.join(cwd, rel), 'utf8')).toBe('{"text":"第二版"}\n');
      expect(await fsp.readdir(path.join(cwd, '.panda', 'conversations', 'codex'))).toEqual([
        path.basename(rel),
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
