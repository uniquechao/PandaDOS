/**
 * web/ws/progress —— V2 进度管道。
 *
 * 事件源：引擎 watch tail 的新消息（EngineDeps.onConvMessages 钩子——引擎是唯一 tail，
 * 这里严禁再 tail 同一文件）。每项目一个 ProgressReporter（pm.createProgressReporter，
 * 惰性建、start() 即挂定时批处理），reporter 判定 push=true 时经适配层把
 * {push,status,needsReply,headline} 翻成 NotifyEvent 交 NotifyRouter：
 *   kind = 'status_change'（进度类事件；确定性事件引擎已直发，不经本管道——评审 M18）
 *   summary = 状态 emoji + headline（needsReply 由 reporter 侧已折进 status='waiting'）
 *
 * 生命周期：挂引擎生命周期——server 停机（engine.stop 之后）调 stopAll() 清定时器。
 */
import type { ProgressAnalysis, ProgressEventLike } from '../../agents/progress';
import type { ChatMessage } from '../../core/jsonl';
import type { Project } from '../../core/types';
import type { EngineIssue } from '../../issues/engine';

// ---------- 依赖最小面 ----------

/** ProgressReporter 结构子集（agents/progress.ts） */
export interface ReporterLike {
  add(ev: ProgressEventLike): void;
  start(): void;
  stop(): void;
}

/** PmAgent 结构子集：进度报告器工厂（agents/pm.ts createProgressReporter） */
export interface ProgressPm {
  createProgressReporter(
    onPush: (a: ProgressAnalysis) => void | Promise<void>,
    opts?: { throttleSeconds?: number },
  ): ReporterLike;
}

/** NotifyRouter.dispatch 结构子集 */
export interface ProgressNotifier {
  dispatch(e: {
    kind: 'status_change';
    projectId: number;
    issueId: number;
    summaryCode: 'progress' | 'progress_needs_reply';
    summaryParams: { emoji: string; headline: string };
  }): Promise<void>;
}

export interface ProgressBridgeDeps {
  pmFor(project: Project): ProgressPm;
  notify: ProgressNotifier;
  /** 批处理窗口秒数（透传 reporter；缺省 reporter 默认 30s） */
  throttleSeconds?: number;
}

/** 状态 emoji（与 notify/cards.ts STATUS_EMOJI 同映射；确定性渲染不过 LLM） */
const STATUS_EMOJI: Record<string, string> = {
  working: '🛠️',
  milestone: '📌',
  waiting: '💬',
  error: '❗',
  done: '✅',
};

/** {push,status,needsReply,headline} → NotifyEvent 的确定性翻译（导出便于测形状） */
export function progressToEvent(
  projectId: number,
  issueId: number,
  a: ProgressAnalysis,
): {
  kind: 'status_change'; projectId: number; issueId: number;
  summaryCode: 'progress' | 'progress_needs_reply';
  summaryParams: { emoji: string; headline: string };
} {
  const emoji = STATUS_EMOJI[a.status] ?? '🛠️';
  return {
    kind: 'status_change', projectId, issueId,
    summaryCode: a.needsReply ? 'progress_needs_reply' : 'progress',
    summaryParams: { emoji, headline: a.headline },
  };
}

export class ProgressBridge {
  private readonly reporters = new Map<number, ReporterLike>();
  /** 通知落到哪条 issue：跟随该项目最近一次喂消息的 issue */
  private readonly lastIssue = new Map<number, number>();
  private stopped = false;

  constructor(private readonly deps: ProgressBridgeDeps) {}

  /** 引擎 EngineDeps.onConvMessages 接线点（同步、不抛——引擎侧还有 try/catch 双保险） */
  onConvMessages(issue: EngineIssue, project: Project, msgs: ChatMessage[]): void {
    if (this.stopped || msgs.length === 0) return;
    this.lastIssue.set(project.id, issue.id);
    const r = this.reporterFor(project);
    for (const m of msgs) r.add(m);
  }

  /** 观测/测试用 */
  get size(): number {
    return this.reporters.size;
  }

  /** 停机：清全部 reporter 定时器（server stop 于 engine.stop 之后调用） */
  stopAll(): void {
    this.stopped = true;
    for (const r of this.reporters.values()) r.stop();
    this.reporters.clear();
  }

  private reporterFor(project: Project): ReporterLike {
    let r = this.reporters.get(project.id);
    if (r) return r;
    const pm = this.deps.pmFor(project);
    r = pm.createProgressReporter(
      async (a) => {
        await this.deps.notify.dispatch(
          progressToEvent(project.id, this.lastIssue.get(project.id) ?? 0, a),
        );
      },
      this.deps.throttleSeconds !== undefined ? { throttleSeconds: this.deps.throttleSeconds } : {},
    );
    r.start();
    this.reporters.set(project.id, r);
    return r;
  }
}
