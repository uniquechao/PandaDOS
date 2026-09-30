import { describe, expect, test } from 'bun:test';
import { Semaphore } from './llm';

describe('shared model concurrency gate', () => {
  test('hands a reserved slot to a waiter without allowing a new caller to steal it', async () => {
    const gate = new Semaphore(1);
    const first = await gate.acquire();
    const second = gate.acquire();
    first();
    let thirdStarted = false;
    const third = gate.acquire().then(release => { thirdStarted = true; return release; });
    const releaseSecond = await second;
    expect(gate.inUse).toBe(1);
    expect(thirdStarted).toBe(false);
    releaseSecond();
    const releaseThird = await third;
    expect(gate.inUse).toBe(1);
    releaseThird(); releaseThird();
    expect(gate.inUse).toBe(0);
  });

  test('an aborted queued room does not consume a future provider slot', async () => {
    const gate = new Semaphore(1);
    const release = await gate.acquire();
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(DOMException);
    expect(gate.inUse).toBe(1);
    release();
    const next = await gate.acquire();
    next();
    expect(gate.inUse).toBe(0);
  });
});
