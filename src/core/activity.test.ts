import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { migrate } from './migrate';
import { UserStore } from './users';
import { activityStatsByUser, localDay, localDayStartMs, MessageCounter } from './activity';

const SH = 'Asia/Shanghai';
/** 东八区墙钟 → epoch 毫秒（测试基准，不依赖宿主 TZ） */
const sh = (s: string): number => Date.parse(`${s}+08:00`);

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const alice = users.create('alice', 'user').user;
  const bob = users.create('bob', 'user').user;
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
  );
  db.query(
    'INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES (?, 1, ?, ?, ?)',
  ).run('proj', '/ws/p', alice.id, 1_000);
  const addIssue = (createdBy: number | null, createdTs: number): void => {
    db.query(
      'INSERT INTO issues (project_id, title, created_by, created_ts) VALUES (1, ?, ?, ?)',
    ).run(`issue-${createdTs}`, createdBy, createdTs);
  };
  return { db, users, alice, bob, addIssue };
}

describe('localDayStartMs', () => {
  test('东八区日切：凌晨不错切到前一天（bun 无 TZ 按 UTC 的坑）', () => {
    const t = sh('2026-07-27T01:30:00'); // = 2026-07-26T17:30Z，按 UTC 取日会退到 26 号
    expect(localDayStartMs(t, SH)).toBe(sh('2026-07-27T00:00:00'));
    expect(localDay(t, SH)).toBe('2026-07-27');
  });

  test('与 localDay 同口径：日首、日末、跨月都自洽', () => {
    for (const s of [
      '2026-07-27T00:00:00.000',
      '2026-07-27T23:59:59.999',
      '2026-07-31T23:59:59.999',
      '2026-08-01T00:00:00.001',
      '2026-01-01T07:59:59.500',
    ]) {
      const t = sh(s);
      const start = localDayStartMs(t, SH);
      expect(localDay(start, SH)).toBe(localDay(t, SH));
      expect(start).toBeLessThanOrEqual(t);
      expect(t - start).toBeLessThan(86_400_000);
    }
  });

  test('日首那一毫秒的边界：start 恰是自己，减 1ms 落到前一天', () => {
    const start = sh('2026-07-27T00:00:00.000');
    expect(localDayStartMs(start, SH)).toBe(start);
    expect(localDay(start - 1, SH)).toBe('2026-07-26');
  });

  test('换时区口径跟着换（UTC）', () => {
    const t = sh('2026-07-27T01:30:00');
    expect(localDayStartMs(t, 'UTC')).toBe(Date.parse('2026-07-26T00:00:00Z'));
    expect(localDay(t, 'UTC')).toBe('2026-07-26');
  });
});

describe('MessageCounter', () => {
  test('bump 按本地日累加，跨日分桶，用户之间互不干扰', () => {
    const { db, alice, bob } = setup();
    const counter = new MessageCounter(db, { now: () => sh('2026-07-27T10:00:00'), tz: SH });

    expect(counter.countsFor(alice.id)).toEqual({ today: 0, total: 0 });

    counter.bump(alice.id);
    counter.bump(alice.id);
    counter.bump(alice.id, sh('2026-07-26T22:00:00')); // 昨天
    counter.bump(bob.id);

    expect(counter.countsFor(alice.id)).toEqual({ today: 2, total: 3 });
    expect(counter.countsFor(bob.id)).toEqual({ today: 1, total: 1 });

    const rows = db
      .query<{ day: string; count: number }, [number]>(
        'SELECT day, count FROM user_message_counts WHERE user_id = ? ORDER BY day',
      )
      .all(alice.id);
    expect(rows).toEqual([
      { day: '2026-07-26', count: 1 },
      { day: '2026-07-27', count: 2 },
    ]);
  });

  test('凌晨 0–8 点算今天（本地日切，不是 UTC 日）', () => {
    const { db, alice } = setup();
    const counter = new MessageCounter(db, { now: () => sh('2026-07-27T00:30:00'), tz: SH });
    counter.bump(alice.id);
    expect(counter.countsFor(alice.id)).toEqual({ today: 1, total: 1 });
    expect(
      db.query<{ day: string }, []>('SELECT day FROM user_message_counts').get()?.day,
    ).toBe('2026-07-27');
  });

  test('删用户级联清理计数（外键 ON DELETE CASCADE）', () => {
    // 用 bob：alice 名下有项目，会先撞 projects 的外键（那是另一条既有规则）
    const { db, users, bob } = setup();
    new MessageCounter(db, { now: () => sh('2026-07-27T10:00:00'), tz: SH }).bump(bob.id);
    users.remove(bob.id);
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM user_message_counts').get()?.n,
    ).toBe(0);
  });
});

describe('activityStatsByUser', () => {
  test('任务按 created_by 归属 + 本地日切；消息取自计数表；无数据用户全 0', () => {
    const { db, alice, bob, addIssue } = setup();
    const now = sh('2026-07-27T09:00:00');
    const opts = { now: () => now, tz: SH };

    addIssue(alice.id, sh('2026-07-27T00:00:00')); // 今天第一毫秒 → 算今天
    addIssue(alice.id, sh('2026-07-27T08:30:00'));
    addIssue(alice.id, sh('2026-07-26T23:59:59')); // 昨天末 → 不算今天
    addIssue(bob.id, sh('2026-07-27T07:00:00'));
    addIssue(null, sh('2026-07-27T07:30:00')); // 无归属（历史数据）→ 不进任何人

    const counter = new MessageCounter(db, opts);
    counter.bump(alice.id);
    counter.bump(alice.id);
    counter.bump(alice.id, sh('2026-07-20T10:00:00'));

    const stats = activityStatsByUser(db, opts);
    expect(stats.get(alice.id)).toEqual({
      userId: alice.id,
      todayTasks: 2,
      totalTasks: 3,
      todayMessages: 2,
      totalMessages: 3,
    });
    expect(stats.get(bob.id)).toEqual({
      userId: bob.id,
      todayTasks: 1,
      totalTasks: 1,
      todayMessages: 0,
      totalMessages: 0,
    });
    // 每个用户都在结果里（含全 0 的），调用方不用兜底
    expect([...stats.keys()].sort()).toEqual([alice.id, bob.id].sort());
  });

  test('跨天后「今天」自动清零，累计不动', () => {
    const { db, alice, addIssue } = setup();
    addIssue(alice.id, sh('2026-07-27T08:00:00'));
    new MessageCounter(db, { now: () => sh('2026-07-27T08:00:00'), tz: SH }).bump(alice.id);

    const next = activityStatsByUser(db, { now: () => sh('2026-07-28T09:00:00'), tz: SH });
    expect(next.get(alice.id)).toEqual({
      userId: alice.id,
      todayTasks: 0,
      totalTasks: 1,
      todayMessages: 0,
      totalMessages: 1,
    });
  });
});
