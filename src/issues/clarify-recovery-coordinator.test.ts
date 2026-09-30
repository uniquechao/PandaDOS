import { describe, expect, test } from 'bun:test';
import type { Project } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import type { EngineIssue, IssueStore } from './engine';
import { ClarifyRecoveryCoordinator } from './clarify-recovery-coordinator';

describe('ClarifyRecoveryCoordinator', () => {
  test('reschedules pending work and discards finished work with remote scratch cleanup', async () => {
    const events: string[] = [];
    const issues = [
      { id: '1', status: 'pending', projectId: 7 },
      { id: '2', status: 'done', projectId: 7 },
    ] as EngineIssue[];
    const store = {
      listDanglingClarify: () => issues,
      logEvent: (id: string, kind: string) => { events.push(`${id}:${kind}`); },
    } as unknown as Pick<IssueStore, 'listDanglingClarify' | 'logEvent'>;
    const driver = {
      killSession: async (name: string) => { events.push(`kill:${name}`); },
      removeTree: async (path: string) => { events.push(`remove:${path}`); },
    } as ExecutorDriver;
    const coordinator = new ClarifyRecoveryCoordinator({
      store,
      project: () => ({ cwd: '/workspace' }) as Project,
      driverForProject: () => driver,
      scheduleClarify: (id) => { events.push(`schedule:${id}`); },
    });
    await coordinator.recover();
    expect(events[0]).toBe('schedule:1');
    expect(events[1]).toBe('2:clarify_discarded');
    expect(events[2]).toBe('kill:clr-2');
    expect(events[3]).toContain('/workspace/.panda/tmp/clarify/2');
  });
});
