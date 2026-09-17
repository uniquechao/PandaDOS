/**
 * core/usage-collector 单测（#282 / I-08、I-09）：增量游标、归因边界、chat 单列、重复扫不重复计数。
 * 用内存 DB + 假 driver（文件内容放在一个 Map 里），不碰真 fs / SSH。
 */
import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { migrate } from './migrate';
import { migrateIssueEngine } from '../issues/engine';
import { MODULE_NONE, MODULE_UNATTRIBUTED, UsageStore } from './usage-store';
import { attributeTo, lineTimestamp, UsageCollector } from './usage-collector';

const iso = (ms: number) => new Date(ms).toISOString();

const claudeLine = (id: string, ts: number, usage: Record<string, number>, extra: unknown[] = []) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(ts),
    message: { id, usage, content: extra },
  });

function setup(files: Record<string, string> = {}) {
  const db = openDb(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  migrate(db);
  migrateIssueEngine(db);
  db.run(`INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'admin', 'x', 'admin', 1)`);
  db.run(`INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`);
  db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'a', 1, '/ws/a', 1, 1)`);

  const store = new Map<string, string>(Object.entries(files));
  const driver = {
    async statPath(path: string) {
      const data = store.get(path);
      return data === undefined ? null : { size: Buffer.byteLength(data, 'utf8'), isFile: true };
    },
    async readFileRange(path: string, offset: number, limit: number) {
      const buf = Buffer.from(store.get(path) ?? '', 'utf8');
      const slice = buf.subarray(offset, offset + limit);
      return { data: new Uint8Array(slice), size: buf.length };
    },
  };
  const collector = new UsageCollector(
    { db, driver, locate: async (convId) => (store.has(`/logs/${convId}.jsonl`) ? `/logs/${convId}.jsonl` : null), now: () => 5000 },
    { intervalMs: 0 },
  );
  return { db, files: store, collector, usage: new UsageStore(db) };
}

/** 建一条会话 + 一条绑在它上面的 issue */
function conv(db: ReturnType<typeof openDb>, id: string, kind: 'issue' | 'chat' = 'issue') {
  db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent, kind) VALUES (?, 1, 'x', 1, 'claude', ?)`, [id, kind]);
}
function issueOn(db: ReturnType<typeof openDb>, issueId: number, convId: string) {
  db.run(`INSERT INTO issues (id, project_id, title, conv_id, created_ts) VALUES (?, 1, ?, ?, 1)`, [issueId, `i${issueId}`, convId]);
}
function segment(db: ReturnType<typeof openDb>, issueId: number, start: number, end?: number) {
  db.run(`INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, 'conversation_segment_started', '{}', ?)`, [issueId, start]);
  if (end !== undefined) {
    db.run(`INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, 'conversation_segment_ended', '{}', ?)`, [issueId, end]);
  }
}

describe('增量游标', () => {
  test('第二轮只处理新增字节；重复扫不重复计数', async () => {
    const first = claudeLine('m1', 1000, { input_tokens: 10, output_tokens: 5 }) + '\n';
    const { db, files, collector, usage } = setup({ '/logs/c1.jsonl': first });
    conv(db, 'c1');

    await collector.tick();
    expect(usage.getConversation('c1')).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 5 });
    const cursor = usage.getConversation('c1')!.scannedBytes;

    // 没有新内容 → 什么都不做
    const again = await collector.tick();
    expect(again[0]).toMatchObject({ skipped: 'no-new-bytes' });
    expect(usage.getConversation('c1')).toMatchObject({ requests: 1, inputTokens: 10 });

    // 追加一行 → 只累加新的那一行
    files.set('/logs/c1.jsonl', first + claudeLine('m2', 2000, { input_tokens: 7, output_tokens: 3 }) + '\n');
    await collector.tick();
    expect(usage.getConversation('c1')).toMatchObject({ requests: 2, inputTokens: 17, outputTokens: 8 });
    expect(usage.getConversation('c1')!.scannedBytes).toBeGreaterThan(cursor);
  });

  test('末尾半行留到下一轮：游标停在最后一个换行处', async () => {
    const complete = claudeLine('m1', 1000, { input_tokens: 10, output_tokens: 5 }) + '\n';
    const { db, files, collector, usage } = setup({ '/logs/c1.jsonl': complete + '{"type":"assis' });
    conv(db, 'c1');

    await collector.tick();
    expect(usage.getConversation('c1')).toMatchObject({ requests: 1, scannedBytes: Buffer.byteLength(complete) });

    // 半行补全后才计入
    files.set('/logs/c1.jsonl', complete + claudeLine('m2', 2000, { input_tokens: 1, output_tokens: 1 }) + '\n');
    await collector.tick();
    expect(usage.getConversation('c1')).toMatchObject({ requests: 2 });
  });

  test('claude 同一请求写多行：跨批次边界也不重复计（重叠窗口只登记 id）', async () => {
    const line = claudeLine('m1', 1000, { input_tokens: 100, output_tokens: 20 }) + '\n';
    const { db, files, collector, usage } = setup({ '/logs/c1.jsonl': line });
    conv(db, 'c1');
    await collector.tick();
    expect(usage.getConversation('c1')).toMatchObject({ requests: 1, inputTokens: 100 });

    files.set('/logs/c1.jsonl', line + line); // 同 id 重复行落在下一批
    await collector.tick();
    expect(usage.getConversation('c1')).toMatchObject({ requests: 1, inputTokens: 100 });
  });

  test('文件被换掉（size 比游标还小）→ 归零重扫，不留旧账', async () => {
    const long = claudeLine('m1', 1000, { input_tokens: 500, output_tokens: 50 }) + '\n';
    const { db, files, collector, usage } = setup({ '/logs/c1.jsonl': long });
    conv(db, 'c1');
    await collector.tick();
    expect(usage.getConversation('c1')).toMatchObject({ inputTokens: 500 });

    files.set('/logs/c1.jsonl', claudeLine('m9', 3000, { input_tokens: 3, output_tokens: 1 }) + '\n');
    await collector.tick();
    expect(usage.getConversation('c1')).toMatchObject({ requests: 1, inputTokens: 3, outputTokens: 1 });
  });
});

describe('归因边界', () => {
  test('按 segment 时间区间归到对应 issue；区间外的算非 Issue 会话', async () => {
    const lines = [
      claudeLine('m0', 500, { input_tokens: 9, output_tokens: 9 }),   // 段之前：不归因
      claudeLine('m1', 1500, { input_tokens: 10, output_tokens: 1 }), // 落在 #10
      claudeLine('m2', 2500, { input_tokens: 20, output_tokens: 2 }), // 两段之间：不归因
      claudeLine('m3', 3500, { input_tokens: 30, output_tokens: 3 }), // 落在 #11
    ].join('\n') + '\n';
    const { db, collector, usage } = setup({ '/logs/c1.jsonl': lines });
    conv(db, 'c1');
    issueOn(db, 10, 'c1');
    issueOn(db, 11, 'c1');
    segment(db, 10, 1000, 2000);
    segment(db, 11, 3000, 4000);

    await collector.tick();
    expect(usage.getIssue(10)).toMatchObject({ requests: 1, inputTokens: 10 });
    expect(usage.getIssue(11)).toMatchObject({ requests: 1, inputTokens: 30 });
    // 会话总量含全部四行，余量 = 没归因的两行
    expect(usage.getConversation('c1')).toMatchObject({ requests: 4, inputTokens: 69 });
    expect(usage.unattributedByProject()[0]).toMatchObject({ requests: 2, inputTokens: 29 });
  });

  test('未结束的段按「还在跑」算，后续的行照常归给它', async () => {
    const { db, collector, usage } = setup({
      '/logs/c1.jsonl': claudeLine('m1', 9_000, { input_tokens: 4, output_tokens: 2 }) + '\n',
    });
    conv(db, 'c1');
    issueOn(db, 10, 'c1');
    segment(db, 10, 1000); // 只有 started
    await collector.tick();
    expect(usage.getIssue(10)).toMatchObject({ requests: 1, inputTokens: 4 });
  });

  test('归因是纯函数判断：抠不出时间戳的行一律算非 Issue 会话', () => {
    const segs = [{ issueId: 1, start: 100, end: 200 }];
    expect(attributeTo(segs, 150)).toBe(1);
    expect(attributeTo(segs, 250)).toBeNull();
    expect(attributeTo(segs, undefined)).toBeNull();
    expect(lineTimestamp(claudeLine('m', 1000, {}))).toBe(1000);
    expect(lineTimestamp('{"type":"x"}')).toBeUndefined();
  });
});

describe('按天分桶（065 / #295）', () => {
  test('日键按北京时间：UTC 16:30 记到第二天（同一批里跨天各成一桶）', async () => {
    // 2026-09-07T15:00Z = 北京 09-07 23:00；2026-09-07T16:30Z = 北京 09-08 00:30
    const t1 = Date.parse('2026-09-07T15:00:00.000Z');
    const t2 = Date.parse('2026-09-07T16:30:00.000Z');
    const { db, collector, usage } = setup({
      '/logs/c1.jsonl': [
        claudeLine('m1', t1, { input_tokens: 10, output_tokens: 1 }),
        claudeLine('m2', t2, { input_tokens: 20, output_tokens: 2 }),
      ].join('\n') + '\n',
    });
    conv(db, 'c1');
    issueOn(db, 10, 'c1');
    segment(db, 10, t1 - 1000);

    await collector.tick();
    expect(usage.listDaily().map((r) => [r.day, r.inputTokens, r.outputTokens])).toEqual([
      ['2026-09-07', 10, 1],
      ['2026-09-08', 20, 2],
    ]);
    // 分桶总量 = 会话总量（同一份增量喂两边，天然对得上）
    expect(usage.getConversation('c1')).toMatchObject({ inputTokens: 30, outputTokens: 3 });
  });

  test('归不进 segment 的落 issue_id = 0（未归因桶），归进去的挂在对应 issue 上', async () => {
    const day = Date.parse('2026-09-07T02:00:00.000Z'); // 北京 09-07 10:00
    const { db, collector, usage } = setup({
      '/logs/c1.jsonl': [
        claudeLine('m0', day, { input_tokens: 9, output_tokens: 9 }),        // 段之前
        claudeLine('m1', day + 2000, { input_tokens: 10, output_tokens: 1 }), // 落在 #10
      ].join('\n') + '\n',
    });
    conv(db, 'c1');
    issueOn(db, 10, 'c1');
    segment(db, 10, day + 1000, day + 3000);

    await collector.tick();
    const rows = usage.listDailyByModule();
    expect(rows.map((r) => [r.moduleId, r.inputTokens])).toEqual([
      [MODULE_UNATTRIBUTED, 9], // 未归因那一行没被悄悄摊给 #10
      [MODULE_NONE, 10],        // #10 还没归模块
    ]);
    expect(usage.getIssue(10)).toMatchObject({ inputTokens: 10 });
  });

  test('抠不出时间戳的行落到扫描时刻当日（宁可摊到今天，也不丢账）', async () => {
    // 没有 timestamp 字段的 claude 行：仍带 usage，但归因与日键都取不到
    const line = JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 8, output_tokens: 2 }, content: [] } });
    const { db, collector, usage } = setup({ '/logs/c1.jsonl': line + '\n' });
    conv(db, 'c1');

    await collector.tick();
    // setup 里注入的时钟是 now() = 5000（1970-01-01T00:00:05Z → 北京 1970-01-01 08:00）
    expect(usage.listDaily()).toEqual([
      expect.objectContaining({ day: '1970-01-01', inputTokens: 8, outputTokens: 2 }),
    ]);
  });

  test('重复扫不翻倍：没有新字节时分桶一个数都不动', async () => {
    const t = Date.parse('2026-09-07T02:00:00.000Z');
    const first = claudeLine('m1', t, { input_tokens: 10, output_tokens: 5 }) + '\n';
    const { db, files, collector, usage } = setup({ '/logs/c1.jsonl': first });
    conv(db, 'c1');

    await collector.tick();
    await collector.tick(); // 无新增字节
    expect(usage.listDaily()).toEqual([
      expect.objectContaining({ day: '2026-09-07', requests: 1, inputTokens: 10, outputTokens: 5 }),
    ]);

    // 同 id 的重复行落在下一批：重叠窗口挡住，分桶同样不涨
    files.set('/logs/c1.jsonl', first + first);
    await collector.tick();
    expect(usage.listDaily()).toEqual([
      expect.objectContaining({ day: '2026-09-07', requests: 1, inputTokens: 10 }),
    ]);

    // 真有新内容才涨，且累加进同一天那一桶
    files.set('/logs/c1.jsonl', first + first + claudeLine('m2', t + 1000, { input_tokens: 3, output_tokens: 1 }) + '\n');
    await collector.tick();
    expect(usage.listDaily()).toEqual([
      expect.objectContaining({ day: '2026-09-07', requests: 2, inputTokens: 13, outputTokens: 6 }),
    ]);
  });
});

describe('chat 会话单列', () => {
  test('kind=chat 的会话照常统计，但不归因到任何 issue', async () => {
    const { db, collector, usage } = setup({
      '/logs/chat1.jsonl': claudeLine('m1', 1500, { input_tokens: 12, output_tokens: 6 }) + '\n',
    });
    conv(db, 'chat1', 'chat');

    await collector.tick();
    expect(usage.getConversation('chat1')).toMatchObject({ kind: 'chat', requests: 1, inputTokens: 12 });
    expect(usage.listChatUsage()).toEqual([expect.objectContaining({ projectId: 1, inputTokens: 12 })]);
    expect(usage.listIssueUsage()).toEqual([]);
  });
});

describe('健壮性', () => {
  test('找不到文件 / 读失败：只留痕不抛错，也不动已有累计', async () => {
    const errors: string[] = [];
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'a', 'x', 'admin', 1)`);
    db.run(`INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'l', '127.0.0.1', 22, 'r', 'k', '/ws', '/c')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts) VALUES (1, 'a', 1, '/ws/a', 1, 1)`);
    db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent) VALUES ('c1', 1, 'x', 1, 'claude')`);

    const collector = new UsageCollector({
      db,
      driver: {
        async statPath() { throw new Error('ssh 断了'); },
        async readFileRange() { throw new Error('ssh 断了'); },
      },
      locate: async () => '/logs/c1.jsonl',
      onError: (convId) => errors.push(convId),
    }, { intervalMs: 0 });

    expect(await collector.tick()).toEqual([{ convId: 'c1', scanned: 0, attributed: 0, skipped: 'error' }]);
    expect(errors).toEqual(['c1']);
    expect(new UsageStore(db).getConversation('c1')).toBeUndefined();
  });

  test('定位不到 jsonl 的会话直接跳过', async () => {
    const { db, collector } = setup();
    conv(db, 'c-nofile');
    expect(await collector.tick()).toEqual([{ convId: 'c-nofile', scanned: 0, attributed: 0, skipped: 'no-file' }]);
  });
});
