import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { migrate } from './migrate';
import { migrateIssueEngine } from '../issues/engine';
import { migrateDesigns } from '../designs/store';
import type { JsonlReader } from './jsonl';
import {
  buildHistoryDigest,
  EMPTY_DIGEST,
  formatConvTime,
  formatMessageLine,
  type DigestLocator,
} from './history-digest';

// ---------- 假 reader / locator ----------

/** 内存 JsonlReader：path → 内容字节，statPath/readFileRange 走内存切片 */
function mkReader(files: Record<string, string>): JsonlReader {
  const enc = new TextEncoder();
  const bytes: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) bytes[k] = enc.encode(v);
  return {
    async statPath(p) {
      return bytes[p] ? { size: bytes[p]!.length } : null;
    },
    async readFileRange(p, offset, limit) {
      const b = bytes[p];
      if (!b) throw new Error(`no file ${p}`);
      return { data: b.subarray(offset, offset + limit), size: b.length };
    },
    async listDir() {
      return [];
    },
  };
}

/** 内存定位器：convId → path（缺省 null） */
function mkLocator(paths: Record<string, string>): DigestLocator {
  return { async locate(id) {
    return paths[id] ?? null;
  } };
}

// ---------- claude jsonl 行构造 ----------

const userLine = (t: string) => JSON.stringify({ type: 'user', message: { content: t } });
const asstLine = (t: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const thinkLine = (t: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: t }] } });
const toolLine = (name: string, input: unknown) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const toolResultLine = (t: string) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: t, tool_use_id: 't1' }] },
  });

const jsonl = (...lines: string[]) => lines.join('\n') + '\n';

// ---------- db 装配 ----------

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  db.run(
    `INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'admin', 'x', 'admin', 0)`,
  );
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
  );
  db.run(
    `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts) VALUES (1, 'p', 1, '/repo', 1, 0)`,
  );
  return db;
}

function insertConv(
  db: ReturnType<typeof setup>,
  id: string,
  label: string,
  createdTs: number,
  agent: 'claude' | 'codex' = 'claude',
  archived = 0,
) {
  db.query(
    `INSERT INTO conversations (id, project_id, label, created_ts, archived, agent) VALUES (?, 1, ?, ?, ?, ?)`,
  ).run(id, label, createdTs, archived, agent);
}

// ---------- 纯函数单测 ----------

describe('formatConvTime', () => {
  test('epoch ms → UTC YYYY-MM-DD HH:MM', () => {
    expect(formatConvTime(Date.UTC(2026, 6, 17, 8, 30, 0))).toBe('2026-07-17 08:30');
  });
  test('非法/零 ts → 未知时间', () => {
    expect(formatConvTime(0)).toBe('未知时间');
    expect(formatConvTime(Number.NaN)).toBe('未知时间');
  });
});

describe('formatMessageLine', () => {
  test('用户/助手/工具进摘要；thinking/tool_result 丢弃', () => {
    expect(formatMessageLine({ seq: 0, role: 'user', text: '加导出' }, 400)).toBe('👤 用户：加导出');
    expect(formatMessageLine({ seq: 0, role: 'assistant', text: '好的' }, 400)).toBe('🤖 助手：好的');
    expect(formatMessageLine({ seq: 0, role: 'tool_use', title: '✏️ 改 x.ts', tool: 'Edit' }, 400)).toBe(
      '🔧 ✏️ 改 x.ts',
    );
    expect(formatMessageLine({ seq: 0, role: 'thinking', text: '内部思考' }, 400)).toBeNull();
    expect(formatMessageLine({ seq: 0, role: 'tool_result', result: '结果' }, 400)).toBeNull();
    expect(formatMessageLine({ seq: 0, role: 'user', text: '   ' }, 400)).toBeNull();
  });
  test('tool_use 无 title 退化到工具名', () => {
    expect(formatMessageLine({ seq: 0, role: 'tool_use', tool: 'Bash' }, 400)).toBe('🔧 Bash');
  });
});

// ---------- buildHistoryDigest ----------

describe('buildHistoryDigest', () => {
  test('excludes design-bound conversations from the ordinary project digest', async () => {
    const db = setup();
    insertConv(db, 'ordinary', 'Ordinary chat', 1000);
    insertConv(db, 'design', 'Private design', 2000);
    db.query(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, conversation_id, created_ts, updated_ts)
       VALUES (1, 'Design', 'Private', 'claude', 'design', 1, 1)`,
    ).run();
    const reader = mkReader({
      '/j/ordinary.jsonl': jsonl(userLine('ordinary history')),
      '/j/design.jsonl': jsonl(userLine('secret design history')),
    });
    const digest = await buildHistoryDigest({
      db,
      reader,
      locator: mkLocator({ ordinary: '/j/ordinary.jsonl', design: '/j/design.jsonl' }),
    }, 1);

    expect(digest).toContain('ordinary history');
    expect(digest).not.toContain('secret design history');
    expect(digest).toContain('共 1 条会话，本摘要纳入 1 条');
  });

  test('两条会话：含 label + 关键往来，新→旧排序，噪声被过滤', async () => {
    const db = setup();
    insertConv(db, 'c-old', '旧会话', 1000);
    insertConv(db, 'c-new', '新会话', 2000);
    const reader = mkReader({
      '/j/old.jsonl': jsonl(userLine('加导出功能'), asstLine('好的我来加'), thinkLine('隐藏思考不该出现')),
      '/j/new.jsonl': jsonl(
        userLine('修个 bug'),
        toolLine('Edit', { file_path: 'src/x.ts', old_string: 'a', new_string: 'b' }),
        toolResultLine('工具结果是噪声不该出现'),
        asstLine('已修复'),
      ),
    });
    const locator = mkLocator({ 'c-old': '/j/old.jsonl', 'c-new': '/j/new.jsonl' });

    const d = await buildHistoryDigest({ db, reader, locator }, 1);

    expect(d).toContain('项目历史会话摘要');
    expect(d).toContain('共 2 条会话，本摘要纳入 2 条');
    expect(d).toContain('会话「新会话」');
    expect(d).toContain('会话「旧会话」');
    expect(d).toContain('👤 用户：加导出功能');
    expect(d).toContain('🤖 助手：已修复');
    expect(d).toContain('🔧'); // Edit 工具动作有标题
    // 新→旧：新会话块在前
    expect(d.indexOf('会话「新会话」')).toBeLessThan(d.indexOf('会话「旧会话」'));
    // 噪声被过滤
    expect(d).not.toContain('隐藏思考不该出现');
    expect(d).not.toContain('工具结果是噪声不该出现');
    expect(d.endsWith('…（历史会话过长，其余已省略）…')).toBe(false);
  });

  test('无对话 → EMPTY_DIGEST', async () => {
    const db = setup();
    const d = await buildHistoryDigest({ db, reader: mkReader({}), locator: mkLocator({}) }, 1);
    expect(d).toBe(EMPTY_DIGEST);
  });

  test('对话都定位不到 jsonl → EMPTY_DIGEST', async () => {
    const db = setup();
    insertConv(db, 'c1', '会话', 1000);
    const d = await buildHistoryDigest({ db, reader: mkReader({}), locator: mkLocator({}) }, 1);
    expect(d).toBe(EMPTY_DIGEST);
  });

  test('只有噪声（thinking/tool_result）的会话被整条略过 → EMPTY_DIGEST', async () => {
    const db = setup();
    insertConv(db, 'c1', '会话', 1000);
    const reader = mkReader({ '/j/c1.jsonl': jsonl(thinkLine('思考'), toolResultLine('结果')) });
    const d = await buildHistoryDigest({ db, reader, locator: mkLocator({ c1: '/j/c1.jsonl' }) }, 1);
    expect(d).toBe(EMPTY_DIGEST);
  });

  test('maxChars 小：硬截断到上限并带截断标记', async () => {
    const db = setup();
    insertConv(db, 'c1', '会话', 1000);
    const long = '很长的一段对话内容'.repeat(50);
    const reader = mkReader({
      '/j/c1.jsonl': jsonl(userLine(long), asstLine(long), userLine(long), asstLine(long)),
    });
    const d = await buildHistoryDigest(
      { db, reader, locator: mkLocator({ c1: '/j/c1.jsonl' }) },
      1,
      { maxChars: 200 },
    );
    expect(d.length).toBeLessThanOrEqual(200);
    expect(d.endsWith('…（历史会话过长，其余已省略）…')).toBe(true);
  });

  test('maxConvs 限制纳入条数（新→旧取前 N）', async () => {
    const db = setup();
    insertConv(db, 'c1', '会话1', 1000);
    insertConv(db, 'c2', '会话2', 2000);
    insertConv(db, 'c3', '会话3', 3000);
    const reader = mkReader({
      '/j/1.jsonl': jsonl(userLine('一')),
      '/j/2.jsonl': jsonl(userLine('二')),
      '/j/3.jsonl': jsonl(userLine('三')),
    });
    const locator = mkLocator({ c1: '/j/1.jsonl', c2: '/j/2.jsonl', c3: '/j/3.jsonl' });
    const d = await buildHistoryDigest({ db, reader, locator }, 1, { maxConvs: 1 });
    expect(d).toContain('会话「会话3」'); // 最新
    expect(d).not.toContain('会话「会话1」');
    expect(d).toContain('共 1 条会话，本摘要纳入 1 条');
  });

  test('includeArchived=false 跳过归档会话', async () => {
    const db = setup();
    insertConv(db, 'c-arch', '归档会话', 2000, 'claude', 1);
    insertConv(db, 'c-live', '活跃会话', 1000, 'claude', 0);
    const reader = mkReader({
      '/j/a.jsonl': jsonl(userLine('归档内容')),
      '/j/l.jsonl': jsonl(userLine('活跃内容')),
    });
    const locator = mkLocator({ 'c-arch': '/j/a.jsonl', 'c-live': '/j/l.jsonl' });
    const d = await buildHistoryDigest({ db, reader, locator }, 1, { includeArchived: false });
    expect(d).toContain('会话「活跃会话」');
    expect(d).not.toContain('会话「归档会话」');
  });

  test('codex 会话头部标注 codex', async () => {
    const db = setup();
    insertConv(db, 'cx', 'CX 会话', 1000, 'codex');
    const reader = mkReader({ '/j/cx.jsonl': jsonl(userLine('你好')) });
    const d = await buildHistoryDigest({ db, reader, locator: mkLocator({ cx: '/j/cx.jsonl' }) }, 1);
    expect(d).toContain('（codex，');
  });
});
