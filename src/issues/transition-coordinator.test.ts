import { describe, expect, test } from 'bun:test';
import { IssueTransitionCoordinator } from './transition-coordinator';

describe('IssueTransitionCoordinator', () => {
  test('starts the first task synchronously and serializes later tasks on the same issue', async () => {
    const coordinator = new IssueTransitionCoordinator();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.run('1', async () => {
      events.push('first-start');
      await gate;
      events.push('first-end');
    });
    expect(events).toEqual(['first-start']);
    expect(coordinator.isActive('1')).toBe(true);
    const second = coordinator.run('1', () => { events.push('second'); });
    const independent = coordinator.run('2', () => { events.push('independent'); });
    expect(events).toEqual(['first-start', 'independent']);
    release();
    await Promise.all([first, second, independent]);
    expect(events).toEqual(['first-start', 'independent', 'first-end', 'second']);
    await Promise.resolve();
    expect(coordinator.isActive('1')).toBe(false);
  });

  test('a rejected transition releases its queue slot', async () => {
    const coordinator = new IssueTransitionCoordinator();
    const failed = coordinator.run('1', () => { throw new Error('entry action'); });
    const next = coordinator.run('1', () => 'recovered');
    await expect(failed).rejects.toThrow('entry action');
    expect(await next).toBe('recovered');
    await Promise.resolve();
    expect(coordinator.isActive('1')).toBe(false);
  });

  test('queued transition remains reserved between successive task microtasks', async () => {
    const coordinator = new IssueTransitionCoordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.run('1', async () => { await gate; });
    const second = coordinator.run('1', () => 2);
    release();
    await first;
    expect(coordinator.isActive('1')).toBe(true);
    expect(await second).toBe(2);
  });
});
