/**
 * issues/validation-guard 单测（#279 / I-03）——批次全量回归守护。
 * 依赖全部是小接口，用假实现驱动；不碰真 Driver、不碰 DB。
 */
import { describe, expect, test } from 'bun:test';
import type { CommandResult } from '../executor/driver';
import type { Project } from '../core/types';
import {
  DEFAULT_REGRESSION_GUARD_CONFIG,
  RegressionGuard,
  type GuardNotifyEvent,
  type RegressionGuardDeps,
} from './validation-guard';

const project = (over: Partial<Project> = {}): Project => ({
  id: 1, name: 'demo', executorId: 1, cwd: '/repo', ownerUserId: 1,
  pmPersona: null, goal: null, status: 'active', createdTs: 1, runUser: '',
  readmeSummary: null, workBranch: null, understanding: null, understandingAgent: null,
  understandingTs: null, summaryStatus: 'idle', summaryError: null, manualReview: false,
  validationCommands: null, kind: 'issue', ...over,
});

const pkg = JSON.stringify({ scripts: { typecheck: 'tsc', test: 'bun test' } });

function harness(over: Partial<RegressionGuardDeps> & { results?: CommandResult[] } = {}) {
  const events: Array<{ issueId: number; kind: string; data: Record<string, unknown> }> = [];
  const notifications: GuardNotifyEvent[] = [];
  const calls: string[][] = [];
  const results = over.results ?? [];
  let clock = 1_000_000;
  const deps: RegressionGuardDeps = {
    driver: {
      async runCommand(_cwd, argv) {
        calls.push(argv);
        return results[calls.length - 1]
          ?? { code: 0, out: '', err: '', timedOut: false, durationMs: 1 };
      },
      async statPath() {
        return { size: pkg.length, isFile: true };
      },
      async readFileRange() {
        return { data: new TextEncoder().encode(pkg) };
      },
    },
    listProjects: () => [project()],
    isBusy: () => false,
    anchorIssueId: () => 42,
    logEvent: (issueId, kind, data) => { events.push({ issueId, kind, data }); },
    lastRunTs: () => null,
    notify: (e) => { notifications.push(e); },
    now: () => clock,
    ...over,
  };
  return {
    guard: new RegressionGuard(deps, { intervalMs: 24 * 3600_000, timeoutMs: 60_000 }),
    events, notifications, calls,
    advance: (ms: number) => { clock += ms; },
    deps,
  };
}

describe('批次全量回归守护', () => {
  test('全绿：跑完整清单并落 regression_passed，不发通知', async () => {
    const h = harness();
    expect(await h.guard.tick()).toEqual([{ kind: 'passed', durationMs: 0 }]);
    expect(h.calls).toEqual([['bun', 'run', 'typecheck'], ['bun', 'run', 'test']]);
    expect(h.events.map((e) => e.kind)).toEqual(['regression_started', 'regression_passed']);
    expect(h.notifications).toHaveLength(0);
  });

  test('红了：落 regression_failed + 发通知，但不建 issue、不动队列', async () => {
    const h = harness({
      results: [{ code: 0, out: '', err: '', timedOut: false, durationMs: 1 },
        { code: 1, out: '', err: '3 fail', timedOut: false, durationMs: 2 }],
    });
    const [outcome] = await h.guard.tick();
    expect(outcome).toEqual({ kind: 'failed', label: 'test', code: 1 });

    const failed = h.events.find((e) => e.kind === 'regression_failed')!;
    expect(failed.issueId).toBe(42); // 挂在项目锚点 issue 上（项目级事件的既有惯例）
    expect(failed.data).toMatchObject({ projectId: 1, label: 'test', code: 1 });
    expect(String(failed.data.tail)).toContain('3 fail');

    expect(h.notifications).toEqual([{
      kind: 'issue_blocked', projectId: 1, issueId: 42,
      summaryCode: 'regression_failed',
      summaryParams: { project: 'demo', label: 'test', code: 1 },
    }]);
    // 只做定时 + 通知：没有任何「建 issue」的动作可言，事件里也只有回归自己的两条
    expect(h.events.map((e) => e.kind)).toEqual(['regression_started', 'regression_failed']);
  });

  test('项目忙就跳过本轮：全量门禁和 issue 抢同一个工作树只会两败俱伤', async () => {
    const h = harness({ isBusy: () => true });
    expect(await h.guard.tick()).toEqual([{ kind: 'skipped', reason: 'busy' }]);
    expect(h.calls).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test('没到间隔就跳过；到点才跑（重启不会忘记上次跑过）', async () => {
    let last: number | null = 1_000_000 - 3600_000; // 一小时前跑过
    const h = harness({ lastRunTs: () => last });
    expect(await h.guard.tick()).toEqual([{ kind: 'skipped', reason: 'too-soon' }]);
    last = 1_000_000 - 25 * 3600_000; // 25 小时前
    expect((await h.guard.tick())[0]!.kind).toBe('passed');
  });

  test('探测不到门禁命令 / 项目没有 issue → 跳过，不留噪音事件', async () => {
    const noPkg = harness({
      driver: {
        async runCommand() { return { code: 0, out: '', err: '', timedOut: false, durationMs: 1 }; },
        async statPath() { return null; },
        async readFileRange() { return { data: new Uint8Array() }; },
      },
    });
    expect(await noPkg.guard.tick()).toEqual([{ kind: 'skipped', reason: 'no-commands' }]);
    expect(noPkg.events).toHaveLength(0);

    const noIssue = harness({ anchorIssueId: () => null });
    expect(await noIssue.guard.tick()).toEqual([{ kind: 'skipped', reason: 'no-anchor' }]);
  });

  test('项目显式配了命令就以配置为准；间隔 <= 0 = 关闭守护', async () => {
    const configured = harness({
      listProjects: () => [project({ validationCommands: [{ label: 'ci', argv: ['make', 'ci'] }] })],
    });
    await configured.guard.tick();
    expect(configured.calls).toEqual([['make', 'ci']]);

    const off = new RegressionGuard(harness().deps, { intervalMs: 0, timeoutMs: 1000 });
    expect(await off.tick()).toEqual([{ kind: 'skipped', reason: 'disabled' }]);
  });

  test('执行机抖动（runCommand 抛错）只留痕，不当成回归失败去骚扰用户', async () => {
    const h = harness({
      driver: {
        async runCommand() { throw new Error('ssh 断了'); },
        async statPath() { return { size: pkg.length, isFile: true }; },
        async readFileRange() { return { data: new TextEncoder().encode(pkg) }; },
      },
    });
    await h.guard.tick();
    expect(h.notifications).toHaveLength(0);
    expect(h.events.some((e) => e.kind === 'error' && String(e.data.where) === 'regression')).toBe(true);
    expect(h.events.some((e) => e.kind === 'regression_failed')).toBe(false);
  });

  test('默认间隔 24 小时', () => {
    expect(DEFAULT_REGRESSION_GUARD_CONFIG.intervalMs).toBe(24 * 60 * 60 * 1000);
  });
});
