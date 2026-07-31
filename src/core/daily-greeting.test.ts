/**
 * core/daily-greeting 单测 —— 每日欢迎语（每用户按本地日期各一条，驱动大模型 生成）：
 * 本地日切时区、当天缓存命中、跨天重生成、超长截断、多用户互不相同、LLM 失败回退 null。
 * LLM 为结构替身，不碰真实 驱动大模型。
 */
import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { LlmClient, LlmMessage, LlmResult } from '../agents/llm';
import { openDb } from './db';
import { migrate } from './migrate';
import {
  GREETING_MAX_CHARS,
  getOrCreateDailyGreeting,
  localDay,
} from './daily-greeting';

// ---------- 替身 ----------

/** 可编程 LLM 替身：记下每次消息，按 respond(messages) 回答；respond 抛错即模拟 LLM 失败 */
function fakeLlm(
  respond: (messages: LlmMessage[]) => string,
): LlmClient & { calls: LlmMessage[][] } {
  const calls: LlmMessage[][] = [];
  return {
    calls,
    async chat(messages: LlmMessage[]): Promise<LlmResult> {
      calls.push(messages);
      const content = respond(messages);
      return { content, toolCalls: [], raw: { role: 'assistant', content } };
    },
  };
}

function setupDb(): Database {
  const db = openDb(':memory:');
  migrate(db);
  // FK ON：daily_greeting.user_id 需真实用户，先建两个
  db.run(`INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'admin', 'h', 'admin', 1)`);
  db.run(`INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (2, 'bob', 'h', 'user', 1)`);
  return db;
}

/** 固定「今天」的时钟（东八区某日 03:00，稳定落在该日期） */
function clockOn(y: number, m: number, d: number): () => number {
  return () => Date.UTC(y, m - 1, d, 3, 0); // 03:00 UTC → 东八区 11:00 同日
}

function greetingRows(db: Database, userId: number): { day: string; text: string }[] {
  return db
    .query<{ day: string; text: string }, [number]>(
      'SELECT day, text FROM daily_greeting WHERE user_id = ? ORDER BY day',
    )
    .all(userId);
}

// ---------- localDay 时区 ----------

describe('localDay 本地日切', () => {
  test('东八区跨日：UTC 23:30 归到次日；同一时刻按 UTC 仍是当日', () => {
    const t = Date.UTC(2026, 6, 21, 23, 30); // 2026-07-21 23:30 UTC
    expect(localDay(t, 'Asia/Shanghai')).toBe('2026-07-22');
    expect(localDay(t, 'UTC')).toBe('2026-07-21');
  });

  test('UTC 16:00 = 东八区次日 00:00（进入新的一天）', () => {
    expect(localDay(Date.UTC(2026, 6, 22, 16, 0), 'Asia/Shanghai')).toBe('2026-07-23');
  });

  test('默认时区即 Asia/Shanghai', () => {
    const t = Date.UTC(2026, 6, 21, 23, 30);
    expect(localDay(t)).toBe('2026-07-22');
  });
});

// ---------- getOrCreateDailyGreeting ----------

describe('getOrCreateDailyGreeting', () => {
  test('同一天二次调用命中缓存：LLM 只调 1 次，文案一致', async () => {
    const db = setupDb();
    let n = 0;
    const llm = fakeLlm(() => `欢迎第${++n}次`);
    const now = clockOn(2026, 7, 22);

    const first = await getOrCreateDailyGreeting({ db, llm, now }, { id: 1, username: 'admin' });
    const second = await getOrCreateDailyGreeting({ db, llm, now }, { id: 1, username: 'admin' });

    expect(first).toBe('欢迎第1次');
    expect(second).toBe('欢迎第1次');
    expect(llm.calls.length).toBe(1);
    expect(greetingRows(db, 1)).toEqual([{ day: '2026-07-22', text: '欢迎第1次' }]);
    db.close();
  });

  test('跨天重新生成：不同「今天」各生成一条', async () => {
    const db = setupDb();
    let n = 0;
    const llm = fakeLlm(() => `第${++n}天你好`);

    const d1 = await getOrCreateDailyGreeting({ db, llm, now: clockOn(2026, 7, 22) }, { id: 1, username: 'admin' });
    const d2 = await getOrCreateDailyGreeting({ db, llm, now: clockOn(2026, 7, 23) }, { id: 1, username: 'admin' });

    expect(d1).toBe('第1天你好');
    expect(d2).toBe('第2天你好');
    expect(llm.calls.length).toBe(2);
    expect(greetingRows(db, 1)).toEqual([
      { day: '2026-07-22', text: '第1天你好' },
      { day: '2026-07-23', text: '第2天你好' },
    ]);
    db.close();
  });

  test('超长回答按 Unicode 码点截断到上限', async () => {
    const db = setupDb();
    const long = '一二三四五六七八九十'.repeat(5); // 50 字，超过 24
    const llm = fakeLlm(() => long);

    const text = await getOrCreateDailyGreeting({ db, llm, now: clockOn(2026, 7, 22) }, { id: 1, username: 'admin' });

    expect([...(text ?? '')].length).toBe(GREETING_MAX_CHARS);
    expect(text).toBe([...long].slice(0, GREETING_MAX_CHARS).join(''));
    db.close();
  });

  test('不同用户同一天互不相同、各自独立缓存', async () => {
    const db = setupDb();
    let n = 0;
    const llm = fakeLlm(() => `欢迎语-${++n}`);
    const now = clockOn(2026, 7, 22);

    const a = await getOrCreateDailyGreeting({ db, llm, now }, { id: 1, username: 'admin' });
    const b = await getOrCreateDailyGreeting({ db, llm, now }, { id: 2, username: 'bob' });

    expect(a).not.toBe(b);
    expect(llm.calls.length).toBe(2);
    expect(greetingRows(db, 1)).toEqual([{ day: '2026-07-22', text: a! }]);
    expect(greetingRows(db, 2)).toEqual([{ day: '2026-07-22', text: b! }]);
    db.close();
  });

  test('LLM 失败 → 返回 null，且不落库（下次仍可重试）', async () => {
    const db = setupDb();
    const llm: LlmClient = {
      async chat() {
        throw new Error('llm 502');
      },
    };

    const r = await getOrCreateDailyGreeting({ db, llm, now: clockOn(2026, 7, 22) }, { id: 1, username: 'admin' });

    expect(r).toBeNull();
    expect(greetingRows(db, 1)).toEqual([]);
    db.close();
  });

  test('清洗：去掉包裹引号，只取一句', async () => {
    const db = setupDb();
    const llm = fakeLlm(() => '「欢迎回来，愿今天顺利」\n（多余说明）');

    const text = await getOrCreateDailyGreeting({ db, llm, now: clockOn(2026, 7, 22) }, { id: 1, username: 'admin' });

    expect(text).toBe('欢迎回来，愿今天顺利');
    db.close();
  });
});
