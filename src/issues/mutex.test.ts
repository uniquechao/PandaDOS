import { describe, expect, test } from 'bun:test';
import { gitLockKey, KeyedMutex, projectLockKey, tmuxLockKey } from './mutex';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  test('同 key 严格串行（FIFO），无交错', async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    await Promise.all([
      m.runExclusive('a', async () => {
        log.push('1s');
        await sleep(20);
        log.push('1e');
      }),
      m.runExclusive('a', async () => {
        log.push('2s');
        await sleep(5);
        log.push('2e');
      }),
      m.runExclusive('a', async () => {
        log.push('3s');
        log.push('3e');
      }),
    ]);
    expect(log).toEqual(['1s', '1e', '2s', '2e', '3s', '3e']);
  });

  test('不同 key 并行不互相阻塞', async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    await Promise.all([
      m.runExclusive('a', async () => {
        await sleep(30);
        log.push('a');
      }),
      m.runExclusive('b', async () => {
        log.push('b');
      }),
    ]);
    expect(log).toEqual(['b', 'a']);
  });

  test('抛错不毒化队列：后续照常执行，错误向本调用者传播', async () => {
    const m = new KeyedMutex();
    const p1 = m.runExclusive('a', async () => {
      throw new Error('boom');
    });
    const p2 = m.runExclusive('a', async () => 'ok');
    await expect(p1).rejects.toThrow('boom');
    expect(await p2).toBe('ok');
  });

  test('归零回收：全部完成后 isLocked=false', async () => {
    const m = new KeyedMutex();
    expect(m.isLocked('a')).toBe(false);
    const p = m.runExclusive('a', async () => {
      await sleep(10);
    });
    expect(m.isLocked('a')).toBe(true);
    await p;
    expect(m.isLocked('a')).toBe(false);
  });

  test('返回值透传', async () => {
    const m = new KeyedMutex();
    expect(await m.runExclusive('a', () => 7)).toBe(7);
  });
});

describe('锁 key 约定', () => {
  test('tmux / project / git key 格式稳定（PM/路由复用契约）', () => {
    expect(tmuxLockKey('cc-3')).toBe('tmux:cc-3');
    expect(projectLockKey(3)).toBe('project:3');
    expect(gitLockKey(3)).toBe('git:3');
  });
});
