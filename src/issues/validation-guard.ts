/**
 * issues/validation-guard —— 批次全量回归守护（#279 / I-03，最小实现）。
 *
 * per-issue 的门禁是**定向**的（validation.ts 的 scope 推导），省钱但有盲区：定向没覆盖到的
 * 用例可能已经被前几条 issue 悄悄改红了。这个守护就是那个兜底——按固定间隔在项目 cwd 跑一次
 * **全量**门禁，红了就通知人。
 *
 * 刻意做小：**只做定时 + 通知**。不建 issue、不动队列、不改任何 issue 状态——自动建 issue 会
 * 让「回归红了」直接变成一条排队任务，和 #274 想省的钱撞在一起；要不要修、什么时候修是人的决定。
 *
 * 与项目并发的关系：项目忙（有 issue 在驱动中）就跳过本轮。全量门禁和 issue 自己的门禁抢同一台
 * 执行机、同一个工作树，抢起来只会两败俱伤；等下一轮就是了。
 */
import type { Project, ValidationCommand } from '../core/types';
import {
  resolveValidationCommands,
  runValidation,
  VALIDATION_TIMEOUT_MS,
  type ValidationExecutor,
} from './validation';

/** 守护自己的通知事件（与 EngineNotifyEvent 结构兼容，issues 层不 import notify） */
export interface GuardNotifyEvent {
  kind: 'issue_blocked';
  projectId: number;
  issueId: number;
  summaryCode: 'regression_failed';
  summaryParams: Record<string, string | number>;
}

export interface RegressionGuardDeps {
  /** 门禁执行入口 + package.json 读取（ExecutorDriver 的子集） */
  driver: ValidationExecutor & {
    statPath(path: string): Promise<{ size: number; isFile: boolean } | null>;
    readFileRange(path: string, offset: number, limit: number): Promise<{ data: Uint8Array }>;
  };
  /** 参与守护的项目（调用方决定范围：通常是 active 项目） */
  listProjects(): Project[];
  /** 项目是否正忙（有 issue 在驱动中）——忙就跳过本轮 */
  isBusy(projectId: number): boolean;
  /** 事件挂靠的锚点 issue（项目级事件按既有惯例挂在项目最后一条 issue 上）；没有 issue 返回 null */
  anchorIssueId(projectId: number): number | null;
  logEvent(issueId: number, kind: string, data: Record<string, unknown>): void;
  /** 该项目最近一次回归跑完的时刻（读事件），null = 从没跑过 */
  lastRunTs(projectId: number): number | null;
  notify(event: GuardNotifyEvent): void | Promise<void>;
  now?: () => number;
}

export interface RegressionGuardConfig {
  /** 两次全量回归的最小间隔；<= 0 = 关闭守护 */
  intervalMs: number;
  /** 单条命令超时 */
  timeoutMs: number;
}

export const DEFAULT_REGRESSION_GUARD_CONFIG: RegressionGuardConfig = {
  intervalMs: 24 * 60 * 60 * 1000,
  timeoutMs: VALIDATION_TIMEOUT_MS,
};

/** 一轮守护对单个项目的结论（返回给调用方/测试看，不落库） */
export type GuardOutcome =
  | { kind: 'skipped'; reason: 'disabled' | 'busy' | 'too-soon' | 'no-commands' | 'no-anchor' }
  | { kind: 'passed'; durationMs: number }
  | { kind: 'failed'; label: string; code: number };

export class RegressionGuard {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly deps: RegressionGuardDeps,
    private readonly cfg: RegressionGuardConfig = DEFAULT_REGRESSION_GUARD_CONFIG,
  ) {}

  /**
   * 起定时器。**节拍远比间隔密**（默认每 10 分钟看一眼）：到没到点由 `lastRunTs` 判，
   * 这样重启不会把「上次跑完」这件事忘掉，也不会因为进程刚起就立刻跑一轮全量。
   */
  start(tickMs = 10 * 60 * 1000): void {
    if (this.timer || this.cfg.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 跑一轮：逐个项目判定并执行（单飞，上一轮没跑完就跳过） */
  async tick(): Promise<GuardOutcome[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const out: GuardOutcome[] = [];
      for (const project of this.deps.listProjects()) {
        out.push(await this.runForProject(project));
      }
      return out;
    } finally {
      this.running = false;
    }
  }

  /** 对一个项目跑一轮全量回归（公开供路由/测试直接触发） */
  async runForProject(project: Project): Promise<GuardOutcome> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.cfg.intervalMs <= 0) return { kind: 'skipped', reason: 'disabled' };
    if (this.deps.isBusy(project.id)) return { kind: 'skipped', reason: 'busy' };

    const last = this.deps.lastRunTs(project.id);
    if (last !== null && now - last < this.cfg.intervalMs) return { kind: 'skipped', reason: 'too-soon' };

    const anchor = this.deps.anchorIssueId(project.id);
    if (anchor === null) return { kind: 'skipped', reason: 'no-anchor' }; // 没有 issue 的项目没什么可回归的

    const commands = resolveValidationCommands(
      project.validationCommands,
      await this.readPackageJson(project.cwd),
    );
    if (commands.length === 0) return { kind: 'skipped', reason: 'no-commands' };

    this.deps.logEvent(anchor, 'regression_started', {
      projectId: project.id,
      commands: commands.map((c: ValidationCommand) => c.label),
    });
    let run;
    try {
      run = await runValidation(
        this.deps.driver,
        project.cwd,
        commands,
        { kind: 'full', files: [], reason: '批次全量回归' },
        { timeoutMs: this.cfg.timeoutMs, ...(this.deps.now ? { now: this.deps.now } : {}) },
      );
    } catch (e) {
      // 执行机抖动不是回归失败：留痕即可，别拿它去骚扰用户
      this.deps.logEvent(anchor, 'error', { where: 'regression', error: String(e).slice(0, 300) });
      return { kind: 'skipped', reason: 'no-commands' };
    }
    if (run.ok) {
      this.deps.logEvent(anchor, 'regression_passed', {
        projectId: project.id,
        durationMs: run.durationMs,
      });
      return { kind: 'passed', durationMs: run.durationMs };
    }
    const failed = run.failed!;
    this.deps.logEvent(anchor, 'regression_failed', {
      projectId: project.id,
      label: failed.label,
      code: failed.code,
      timedOut: failed.timedOut,
      durationMs: run.durationMs,
      tail: run.tail.slice(0, 2000),
    });
    await this.deps.notify({
      kind: 'issue_blocked',
      projectId: project.id,
      issueId: anchor,
      summaryCode: 'regression_failed',
      summaryParams: { project: project.name, label: failed.label, code: failed.code },
    });
    return { kind: 'failed', label: failed.label, code: failed.code };
  }

  private async readPackageJson(cwd: string): Promise<string | null> {
    try {
      const path = `${cwd.replace(/\/+$/, '')}/package.json`;
      const stat = await this.deps.driver.statPath(path);
      if (!stat?.isFile || stat.size === 0) return null;
      const r = await this.deps.driver.readFileRange(path, 0, Math.min(stat.size, 256 * 1024));
      return new TextDecoder().decode(r.data);
    } catch {
      return null;
    }
  }
}
