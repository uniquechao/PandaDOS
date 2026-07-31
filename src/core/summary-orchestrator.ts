/**
 * core/summary-orchestrator —— 「Agent 认知总结」后台任务编排 + 落库。
 *
 * 把子任务 2（历史摘要）+ 子任务 3（Agent runner）串成一个异步任务：
 *   start(project, agent)  —— 同步守卫（单飞防重入）+ 置 summary_status='running'，
 *                             随即后台跑 buildDigest → runSummary → 落库，立即返回；
 *   成功 → understanding / understanding_agent / understanding_ts + 派生 ≤200 字回填 readme_summary
 *          + summary_status='done'；
 *   失败 → summary_status='error' + summary_error（understanding 等旧值不动，保留上次好结果）。
 *
 * 解耦：buildDigest / runSummary 由构造方注入（生产里 = history-digest + agent-summary 包一层，
 * 各自带项目的 Driver/locator）。本模块只碰 db 与这两个回调，不 import executor / issues/engine
 * （层次干净、可测），Project 由调用方（web 路由）加载后传入。
 */
import type { Database } from 'bun:sqlite';
import type { RunSummaryResult, SummaryTarget } from './agent-summary';
import { SUMMARY_MAX_CHARS } from './readme-summary';
import type { AgentKind, Project } from './types';

export type StartResult = { started: true } | { started: false; reason: 'busy' };

export interface SummaryOrchestratorDeps {
  db: Database;
  /** 为项目产出历史会话摘要（生产 = buildHistoryDigest 包一层，带项目 Driver+locator） */
  buildDigest: (project: Project) => Promise<string>;
  /**
   * 用选定 agent + 历史摘要跑 Agent runner（生产 = AgentSummaryRunner(driverForProject).run）。
   * target：'readme'（更新简介）| 'memory'（更新记忆，写 CLAUDE.md/AGENTS.md）；旧回调忽略即默认 readme。
   */
  runSummary: (
    project: Project,
    agent: AgentKind,
    historyDigest: string,
    target?: SummaryTarget,
  ) => Promise<RunSummaryResult>;
  /** 测试注入时钟 */
  now?: () => number;
}

/**
 * 从认知长文派生 ≤max 字短简介：去代码块/标题/列表/引用与行内强调（保留连字符），
 * 并行空白后按 Unicode 码点截断（防 emoji 腰斩），超长补省略号。
 */
export function deriveShortSummary(understanding: string, max = SUMMARY_MAX_CHARS): string {
  const flat = understanding
    .replace(/```[\s\S]*?```/g, ' ') // 代码块
    .replace(/^\s{0,3}#{1,6}\s*/gm, '') // 标题井号
    .replace(/^\s*[-*+]\s+/gm, '') // 列表符
    .replace(/^\s*>\s?/gm, '') // 引用符
    .replace(/[*_`]+/g, '') // 行内强调/代码（保留连字符）
    .replace(/\s+/g, ' ')
    .trim();
  const pts = [...flat];
  if (pts.length <= max) return flat;
  return pts.slice(0, max - 1).join('') + '…';
}

/** 失败原因 → 落库文案 */
function failMessage(r: Extract<RunSummaryResult, { ok: false }>): string {
  if (r.reason === 'timeout') return '生成超时（Agent 未在限时内完成）';
  if (r.reason === 'no-output') return 'Agent 已结束但未产出认知总结';
  return (r.error || '生成失败').slice(0, 300);
}

export class SummaryOrchestrator {
  private readonly db: Database;
  private readonly now: () => number;
  /** 单飞：正在跑的项目 id（防重入） */
  private readonly running = new Set<number>();
  /** projectId → 进行中的 execute promise（供测试/优雅停机等待） */
  private readonly inflight = new Map<number, Promise<void>>();

  constructor(private readonly deps: SummaryOrchestratorDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => Date.now());
  }

  isRunning(projectId: number): boolean {
    return this.running.has(projectId);
  }

  /** 等某项目当前任务结束（无任务立即 resolve）——测试与优雅停机用 */
  async wait(projectId: number): Promise<void> {
    await this.inflight.get(projectId);
  }

  /**
   * 启动一次总结任务。同步守卫：同项目已在跑 → { started:false, reason:'busy' }；
   * 否则置 running 并后台执行，立即返回 { started:true }。project 由调用方保证存在。
   * target：'readme'（默认，更新简介）| 'memory'（更新记忆）；两者共用 summary_status 单飞（互斥不并发）。
   */
  start(project: Project, agent: AgentKind, target: SummaryTarget = 'readme'): StartResult {
    const id = project.id;
    if (this.running.has(id)) return { started: false, reason: 'busy' };
    this.running.add(id);
    this.db
      .query("UPDATE projects SET summary_status = 'running', summary_error = NULL WHERE id = ?")
      .run(id);
    const p = this.execute(project, agent, target).finally(() => {
      this.running.delete(id);
      this.inflight.delete(id);
    });
    this.inflight.set(id, p);
    return { started: true };
  }

  /** 后台主体：digest → run → 落库。异常自兜为 error，绝不外抛（finally 已托管清理）。 */
  private async execute(project: Project, agent: AgentKind, target: SummaryTarget): Promise<void> {
    let result: RunSummaryResult;
    try {
      const digest = await this.deps.buildDigest(project);
      result = await this.deps.runSummary(project, agent, digest, target);
    } catch (e) {
      result = { ok: false, reason: 'error', error: String(e).slice(0, 300) };
    }

    if (result.ok) {
      const short = deriveShortSummary(result.understanding);
      this.db
        .query(
          `UPDATE projects
              SET understanding = ?, understanding_agent = ?, understanding_ts = ?,
                  readme_summary = ?, summary_status = 'done', summary_error = NULL
            WHERE id = ?`,
        )
        .run(result.understanding, agent, this.now(), short, project.id);
    } else {
      this.db
        .query("UPDATE projects SET summary_status = 'error', summary_error = ? WHERE id = ?")
        .run(failMessage(result), project.id);
    }
  }

  /**
   * 启动时清理「卡在 running」的僵尸态（服务重启会丢内存里的 inflight，DB 却停在 running）。
   * 把这些翻成 error，让 UI 明确可重试。返回被清理的行数。
   */
  resetStale(): number {
    const rows = this.db
      .query<{ id: number }, []>("SELECT id FROM projects WHERE summary_status = 'running'")
      .all()
      .filter((r) => !this.running.has(r.id));
    for (const r of rows) {
      this.db
        .query("UPDATE projects SET summary_status = 'error', summary_error = ? WHERE id = ?")
        .run('服务重启，任务已中断，请重试', r.id);
    }
    return rows.length;
  }
}
