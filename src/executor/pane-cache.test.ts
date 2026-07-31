/**
 * executor/pane-cache 单测（M6）：
 * - TTL 内多方 capturePane 合并为一次真实抓屏（含并发 in-flight 共享同一 promise）；
 * - TTL 过期后重抓；不同会话互不串缓存；
 * - 写操作（sendKeys/sendKey/createSession/killSession）后立即失效本会话缓存（他会话不受累），
 *   失败的写同样失效（屏幕可能已变）；
 * - 抓屏失败不缓存：错误只打一次调用方，TTL 窗口内下一次真抓；
 * - status/close 透传（healthz 状态映射与停机链依赖）。
 */
import { describe, expect, test } from 'bun:test';
import type { ExecutorDriver } from './driver';
import { PANE_CACHE_TTL_MS, withPaneCache } from './pane-cache';

function makeFake() {
  const calls: string[] = [];
  let closed = false;
  let captureImpl: (session: string) => Promise<string> = (s) =>
    Promise.resolve(`pane:${s}:${calls.length}`);
  const inner = {
    status: 'connected',
    close: () => {
      closed = true;
    },
    capturePane: (s: string) => {
      calls.push(`cap:${s}`);
      return captureImpl(s);
    },
    sendKeys: async (s: string) => {
      calls.push(`keys:${s}`);
    },
    sendKey: async (s: string) => {
      calls.push(`key:${s}`);
    },
    createSession: async (s: string) => {
      calls.push(`create:${s}`);
    },
    killSession: async (s: string) => {
      calls.push(`kill:${s}`);
    },
  } as unknown as ExecutorDriver;
  return {
    inner,
    calls,
    caps: (s: string) => calls.filter((c) => c === `cap:${s}`).length,
    isClosed: () => closed,
    setCapture: (f: (session: string) => Promise<string>) => {
      captureImpl = f;
    },
  };
}

describe('PaneCacheDriver（M6 capturePane TTL 合并缓存）', () => {
  test('TTL 内合并为一次真实抓屏；过期后重抓；不同会话不串', async () => {
    const f = makeFake();
    let t = 1_000;
    const d = withPaneCache(f.inner, 300, () => t);

    const a1 = await d.capturePane('s1');
    t += 100;
    const a2 = await d.capturePane('s1'); // TTL 内 → 命中缓存
    expect(a2).toBe(a1);
    expect(f.caps('s1')).toBe(1);

    await d.capturePane('s2'); // 他会话独立缓存
    expect(f.caps('s2')).toBe(1);
    expect(f.caps('s1')).toBe(1);

    t += 300; // 距 s1 首抓已 400ms > TTL → 重抓
    await d.capturePane('s1');
    expect(f.caps('s1')).toBe(2);
  });

  test('并发合并：TTL 内两个消费者共享同一 in-flight promise', async () => {
    const f = makeFake();
    let t = 0;
    const d = withPaneCache(f.inner, 300, () => t);
    let release!: (v: string) => void;
    f.setCapture(() => new Promise<string>((r) => (release = r)));

    const p1 = d.capturePane('s1');
    const p2 = d.capturePane('s1'); // 真实抓屏未归还时第二方进来 → 共享
    expect(f.caps('s1')).toBe(1);
    release('SCREEN');
    expect(await p1).toBe('SCREEN');
    expect(await p2).toBe('SCREEN');
  });

  test('写操作后立即失效本会话缓存（actOnMenu 注入后核对不许吃旧屏），他会话不受累', async () => {
    const f = makeFake();
    let t = 0;
    const d = withPaneCache(f.inner, 300, () => t);
    await d.capturePane('s1');
    await d.capturePane('s2');

    await d.sendKeys('s1', 'hello');
    await d.capturePane('s1'); // s1 已失效 → 真抓
    await d.capturePane('s2'); // s2 缓存仍有效
    expect(f.caps('s1')).toBe(2);
    expect(f.caps('s2')).toBe(1);

    for (const op of [
      () => d.sendKey('s1', 'Enter'),
      () => d.createSession('s1', '/tmp'),
      () => d.killSession('s1'),
    ]) {
      await d.capturePane('s1'); // 确保缓存在（可能命中已有）
      const before = f.caps('s1');
      await op();
      await d.capturePane('s1');
      expect(f.caps('s1')).toBe(before + 1); // op 失效 → 真抓一次
      await d.capturePane('s1');
      expect(f.caps('s1')).toBe(before + 1); // 真抓后重新被缓存
    }
  });

  test('写操作失败同样失效缓存（失败也可能已改屏幕）', async () => {
    const f = makeFake();
    let t = 0;
    const d = withPaneCache(f.inner, 300, () => t);
    await d.capturePane('s1');
    (f.inner as { sendKeys: unknown }).sendKeys = async () => {
      throw new Error('boom');
    };
    await expect(d.sendKeys('s1', 'x')).rejects.toThrow('boom');
    await d.capturePane('s1');
    expect(f.caps('s1')).toBe(2);
  });

  test('抓屏失败不缓存：错误只打当次，TTL 窗口内下一次真抓', async () => {
    const f = makeFake();
    let t = 0;
    const d = withPaneCache(f.inner, 300, () => t);
    f.setCapture(() => Promise.reject(new Error('capture 失败')));
    await expect(d.capturePane('s1')).rejects.toThrow('capture 失败');

    f.setCapture((s) => Promise.resolve(`ok:${s}`));
    expect(await d.capturePane('s1')).toBe('ok:s1'); // 未吃到糊住的失败缓存
    expect(f.caps('s1')).toBe(2);
  });

  test('status/close 透传；默认 TTL 300ms', async () => {
    const f = makeFake();
    const d = withPaneCache(f.inner);
    expect((d as { status?: unknown }).status).toBe('connected');
    await d.close();
    expect(f.isClosed()).toBe(true);
    expect(PANE_CACHE_TTL_MS).toBe(300);
  });
});
