import { expect, test } from 'bun:test';
import { ResourceDrain } from './lifecycle';

test('bounded close keeps a real resource barrier until the flight settles', async () => {
  const drain = new ResourceDrain();
  let release!: () => void;
  drain.track(new Promise<void>(resolve => { release = resolve; }));
  const close = drain.close(5);
  expect(drain.close(0)).toBe(close);
  const result = await close;
  expect(result.settled).toBe(false);
  expect(result.pending).toBe(1);
  let releasedResource = false;
  void result.done.then(() => { releasedResource = true; });
  await Promise.resolve();
  expect(releasedResource).toBe(false);
  expect(() => drain.track(Promise.resolve())).toThrow('drain_closed');
  release();
  await result.done;
  expect(releasedResource).toBe(true);
});
test('drain settles rejection without losing the barrier or throwing shutdown errors', async () => {
  const drain = new ResourceDrain();
  drain.track(Promise.reject(new Error('private scheduler error')));
  expect((await drain.close()).settled).toBe(true);
});
