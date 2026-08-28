/**
 * issues/engine —— issue 生命周期状态机引擎（v2 的心脏，spec §5）。
 *
 * 职责：
 * - 一切状态迁移收口 applyEvent（machine.transition 纯函数 + CAS + issue_events 落盘），
 *   封死 v1 web.ts:535-538 手动旁路（评审 M8/5.2#6）；
 * - 卡点①②走 gates 表（waiting→decided CAS 防重放），approve/reject 经路由回引擎；
 * - git 协作（Driver.git）：配置目标分支的新 issue 会在 planning 前切换或从选定源引用创建；
 *   历史 issue 沿用开发者当前分支。引擎记录本 issue 的起点/终点 commit（impl_base/impl_tip）
 *   与提交快照（impl_commits），merge_review 按 impl_base..impl_tip 出本 issue 净 diff 进 gate payload，
 *   但仍不做本地合并；
 * - 三级完成判定平移：哨兵主路径（整行+核 id）/ 安静 180s nudge 一次 / 安静 360s PM 保守判
 *   （读-判-重读-CAS，评审 5.2#5）；
 * - kickoff 幂等：per-issue 单飞标记 + issue_events 判重（进入该阶段后是否已 injected），
 *   进程启动 >5s 且无弹窗才注入（评审 H10/5.2#3）；
 * - 队列：每项目单 active，同模块优先+FIFO，done/blocked 接力（queue.ts）；
 * - limit 识别与协议解析解耦（先解析哨兵再退避决策，评审 M1/5.2#8），退避 5min 可配。
 *
 * 依赖纪律：对 PmAgent/NotifyRouter 只按骨架接口签名做结构化依赖（EnginePm/EngineNotifier），
 * 不 import 它们的实现；对执行机只走 ExecutorDriver。
 */
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AgentExecutableNotFoundError } from '../core/conversations';
import { projectAgentSupport } from '../core/executors';
import { migrate, type MigrationStatus } from '../core/migrate';
import { parseAutoApproveLevel } from '../core/types';
import type {
  AgentKind,
  AutoApproveLevel,
  Conversation,
  Gate,
  GateKind,
  GateStatus,
  Issue,
  IssueCategory,
  IssueEvent,
  IssueState,
  IssueWorkflowSharedContext,
  IssueWorkflowRuntime,
  IssueWorkflowSnapshot,
  Project,
  ProjectModule,
  ProjectStatus,
  SummaryStatus,
} from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import {
  readRecentMessages,
  tailConversation,
  type ChatMessage,
  type JsonlReader,
} from '../core/jsonl';
import { detectSelection, type SelectionPayload } from '../core/screen';
import {
  judgeAgentLiveness,
  paneHasAgentUi,
  shouldProbeLiveness,
  type AgentLiveness,
} from '../core/agent-liveness';
import { isCodexUpdatePrompt, pickAffirmative } from '../core/agent-summary';
import { readDriverText } from '../core/skills';
import { transition, type IssueMachineEvent } from './machine';
import {
  countSubtaskDone,
  extractAssistantTexts,
  extractClarifyText,
  findBlocked,
  findNeedClarify,
  findStageDone,
  findTestsFailed,
  looksRateLimited,
  MAX_CLARIFY_QUESTIONS,
  MAX_CLARIFY_TEXT_CHARS,
  parseClarifyQuestions,
  parseSubtasksBlock,
  RATE_LIMIT_BACKOFF_MS,
} from './sentinel';
import {
  buildClarifyContinue,
  buildNudge,
  buildPlanningPrompt,
  buildReplanRequest,
  buildReworkPrompt,
  buildSubtaskPrompt,
  buildTeamPrompt,
  buildTestingPrompt,
  imageReadHint,
} from './prompts';
import { clarifyPaths, clarifySessionName } from './clarify-runner';
import { parseOrganizePlan, type OrganizeAction } from './organize-runner';
import { BUSY_STATES, isBusy, moduleKeyOf, pickNext } from './queue';
import { gitLockKey, KeyedMutex, projectLockKey, tmuxLockKey } from './mutex';
import { outputLanguageInstruction, promptLanguage, userPromptLocale } from '../agents/prompts/language';
import { moduleIssueRelPath } from './module-docs';
import {
  validateWorkflowGraph,
  WorkflowTemplateStore,
  type WorkflowTemplateDetail,
  type WorkflowValidationIssue,
} from './workflows';
import { WorkflowNodeRunner } from './workflow-node-runner';
import { WorkflowScheduler } from './workflow-scheduler';
import { WorkflowWorktreeManager } from './workflow-worktrees';
import type { SupportedLocale } from '../../shared/i18n/locales';

/** pending 元数据编辑与自动合并落地共用的项目锁，避免 LLM 返回后的 Git 意图被并发改写。 */
function issueMetaLockKey(projectId: number): string {
  return `issue-meta:${projectId}`;
}

// ---------- 模块自带迁移（030 编号空间） ----------

/** issue 引擎的增量迁移目录（issues/migrations/030_*.sql） */
export const ISSUE_ENGINE_MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

/**
 * 应用 issue 引擎的增量迁移（issues.module/impl_mode 列 + project_active_conv 表）。
 * 集成接线：server 启动时在核心 `migrate(db)` 之后调用一次；幂等可重复执行
 * （编号 030 记录在同一张 schema_migrations，与核心 001 不冲突）。
 */
export function migrateIssueEngine(db: Database): MigrationStatus {
  return migrate(db, ISSUE_ENGINE_MIGRATIONS_DIR);
}

// ---------- 引擎侧类型（core/types.ts 不许动，扩展列/接口放这里） ----------

export type ImplMode = 'seq' | 'team';

/** 本 issue 涉及的一条提交（impl_commits 耐久快照 / merge_review payload 用；新→旧） */
export interface ImplCommit {
  sha: string;
  short: string;
  author: string;
  /** 提交时间（ms） */
  ts: number;
  subject: string;
}

/** 本 issue 触碰的一个文件（status/path + 增删行；二进制文件 adds/dels 为 null） */
export interface ImplFile {
  /** A/M/D/T + R/C（重命名/复制，含相似度，如 R100） */
  status: string;
  path: string;
  oldPath?: string;
  adds: number | null;
  dels: number | null;
}

/** 一次「工作定格」记录的本 issue 净提交 + 逐文件改动快照（impl_commits 事件 data 形状） */
export interface ImplCommitsSnapshot {
  /** 起点 sha（impl_base） */
  base: string;
  /** 终点 sha（impl_tip） */
  tip: string;
  commits: ImplCommit[];
  files: ImplFile[];
}

/** issues 表全量行（030 起的 issue 引擎增量列；036 补目标分支/源 ref） */
export interface EngineIssue extends Issue {
  moduleId: number | null;
  module: string;
  implMode: ImplMode;
  /** 驱动本 issue 的 CLI 代理；绑对话后不可改（对话 agent 生命周期内不变） */
  agent: AgentKind;
  /** 置顶时刻（ms）；null = 未置顶。仅影响 pending 排队顺序（queue.pickNext 置顶层） */
  pinnedTs: number | null;
  /** 创建时执行代理的反馈（理解/思路/风险，033 迁移）；null = 尚未分析或失败 */
  clarifyFeedback: string | null;
  /** 收尾（done/blocked）时执行代理的结果总结（033 迁移）；null = 尚未总结或失败 */
  resultSummary: string | null;
  /** 用户期望的目标分支名（036）；null = 沿用引擎默认现场。与 branch（实际执行分支）不同。 */
  targetBranch: string | null;
  /** 创建目标分支所基于的完整 ref（036，refs/heads/* 或 refs/remotes/*）；null = 默认现场。 */
  sourceRef: string | null;
  /** 本 issue 执行时的弹窗自动批准档位（038 迁移；默认 'medium' = 既有审批管道行为） */
  autoApprove: AutoApproveLevel;
  /** 039：由原子发布批次创建的稳定节点；自动模块合并不得折叠。 */
  publicationLocked?: boolean;
}

/** 设计域在边界上使用的产品实施模式；Issue 内部继续保持 seq/team。 */
export type DesignPublicationMode = 'direct' | 'team';

/** Issue 域可验证、但不依赖 designs 模块的发布草稿。 */
export interface DesignIssueDraft {
  nodeId: string;
  title: string;
  body: string;
  moduleId: number | null;
  implMode: DesignPublicationMode;
  agent: AgentKind;
  createdBy?: number | null;
  targetBranch?: string | null;
  sourceRef?: string | null;
}

export interface PreparedIssueDependency {
  /** prerequisite node */
  fromNodeId: string;
  /** dependent node */
  toNodeId: string;
  kind?: 'blocks';
}

export interface PreparedDesignIssue extends DesignIssueDraft {
  moduleSlug: string;
}

const PREPARED_DESIGN_BATCH_BRAND: unique symbol = Symbol('PreparedDesignBatch');

export interface PreparedDesignBatch {
  readonly [PREPARED_DESIGN_BATCH_BRAND]: true;
  readonly projectId: number;
  readonly drafts: readonly PreparedDesignIssue[];
}

export type SynchronousCallbackResult<Result> = Result extends PromiseLike<unknown> ? never : Result;

/** Narrow port consumed by a later cross-domain publisher; commit is intentionally synchronous. */
export interface IssuePublicationBatchPort {
  prepareDesignBatch(projectId: number, drafts: readonly DesignIssueDraft[]): Promise<PreparedDesignBatch>;
  commitPreparedDesignBatch<Result>(
    prepared: PreparedDesignBatch,
    dependencies: readonly PreparedIssueDependency[],
    onCreatedInTransaction: (
      issuesByNodeId: ReadonlyMap<string, EngineIssue>,
    ) => SynchronousCallbackResult<Result>,
  ): readonly EngineIssue[];
  completeDesignBatch(
    projectId: number,
    issueIds: readonly number[],
    outbox?: IssuePublicationPostCommitOutboxPort,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface IssuePublicationPostCommitOperation {
  key: string;
  kind: 'module-doc' | 'scheduler';
  projectId: number;
  issueId: number | null;
  issueIds: readonly number[];
  /** Immutable module target captured by the caller-owned publication outbox. */
  moduleId?: number | null;
  agent?: AgentKind;
}

/** Caller-owned durable outbox acknowledgement; completed items are skipped on whole-batch retry. */
export interface IssuePublicationPostCommitOutboxPort {
  /** When present, these durable intents are authoritative; the Issue row must not re-derive them. */
  listOperations?(): readonly IssuePublicationPostCommitOperation[] | Promise<readonly IssuePublicationPostCommitOperation[]>;
  isComplete(operation: IssuePublicationPostCommitOperation): boolean | Promise<boolean>;
  markComplete(operation: IssuePublicationPostCommitOperation): void | Promise<void>;
  markRetry(operation: IssuePublicationPostCommitOperation, error: string): void | Promise<void>;
}

/** The caller-owned durable outbox may retry completeDesignBatch when this error is returned. */
export class IssuePublicationPostCommitError extends Error {
  readonly retryable = true;
  constructor(readonly failures: readonly string[]) {
    super(`post-commit retry required: ${failures.join('; ')}`);
    this.name = 'IssuePublicationPostCommitError';
  }
}

export type IssueExecutionSyncState =
  | 'requested'
  | 'boundary_waiting'
  | 'applied'
  | 'ignored'
  | 'supplemented'
  | 'stale';

export type IssueExecutionSyncDecision = 'apply' | 'ignore' | 'supplement';

export interface IssueExecutionSyncRequest {
  sourceKind: string;
  sourceKey: string;
  sourceRevision: string;
  sourceDigest: string;
  diff: unknown;
  requestedBy?: number | null;
}

export interface IssueExecutionSync {
  id: number;
  issueId: number;
  sourceKind: string;
  sourceKey: string;
  sourceRevision: string;
  sourceDigest: string;
  diffJson: string;
  state: IssueExecutionSyncState;
  boundaryKind: string | null;
  deferredActionJson: string | null;
  requestedBy: number | null;
  requestedTs: number;
  acknowledgedTs: number | null;
  decidedBy: number | null;
  decidedTs: number | null;
  resumeState: 'idle' | 'pending' | 'running' | 'complete';
  /** Stable across claims/restarts; deferred DB/event consumers must CAS/idempotently key on it. */
  resumeKey: string | null;
  resumeToken: string | null;
  resumeClaimedTs: number | null;
  resumedTs: number | null;
}

export interface IssueExecutionSyncEffectContext {
  /** External I/O is represented by a stable intent committed with the database effect receipt. */
  enqueueExternalEffect(intentKey: string, kind: string, payload: unknown): void;
}

export interface IssueExecutionSyncEffectReceipt {
  syncId: number;
  resumeKey: string;
  result: unknown;
  completedTs: number;
}

export interface IssueDesignSyncSnapshot {
  issueId: number;
  projectId: number;
  status: IssueState;
  title: string;
  body: string;
  moduleId: number | null;
  agent: AgentKind;
  implMode: DesignPublicationMode;
  dependencyIssueIds: number[];
  hasConversation: boolean;
  manualReview: boolean;
}

export interface IssueDesignSyncUpdate {
  issueId: number;
  expectedStatus: 'pending' | 'blocked' | 'clarifying' | 'planning' | 'plan_review'
    | 'implementing' | 'testing' | 'merge_review';
  expected: Omit<IssueDesignSyncSnapshot, 'status' | 'hasConversation' | 'manualReview'>;
  next: Pick<IssueDesignSyncSnapshot, 'title' | 'body' | 'moduleId' | 'agent' | 'implMode' | 'dependencyIssueIds'>;
  sourceRevision: string;
}

export interface IssueExecutionSyncEffectOutboxItem {
  resumeKey: string;
  syncId: number;
  intentKey: string;
  kind: string;
  payload: unknown;
  createdTs: number;
  deliveredTs: number | null;
  deliveryState: 'pending' | 'dispatching' | 'delivered' | 'uncertain';
  deliveryToken: string | null;
  dispatchStartedTs: number | null;
}

export interface IssueDependencyBlocker {
  issueId: number;
  status: IssueState;
}

const MAX_PUBLICATION_BATCH = 200;
const MAX_PUBLICATION_BODY = 8_000;
const MAX_EXECUTION_SYNC_JSON = 200_000;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  ) && typeof (value as { then?: unknown }).then === 'function';
}

function isDeclaredAsyncFunction(value: Function): boolean {
  return Object.prototype.toString.call(value) === '[object AsyncFunction]';
}

function encodeExecutionSyncEffectResult(value: unknown): string {
  const encoded = JSON.stringify({ value });
  if (encoded === undefined || encoded.length > MAX_EXECUTION_SYNC_JSON) {
    throw new Error('execution sync effect result must be bounded JSON');
  }
  return encoded;
}

function decodeExecutionSyncEffectResult(encoded: string): unknown {
  const wrapper = JSON.parse(encoded) as { value?: unknown };
  return wrapper.value;
}

function validatePreparedDependencies(
  prepared: PreparedDesignBatch,
  dependencies: readonly PreparedIssueDependency[],
): readonly Required<PreparedIssueDependency>[] {
  if (!Array.isArray(dependencies) || dependencies.length > MAX_PUBLICATION_BATCH * MAX_PUBLICATION_BATCH) {
    throw new Error('invalid publication dependency list');
  }
  const nodes = new Set(prepared.drafts.map((draft) => draft.nodeId));
  const indegree = new Map([...nodes].map((nodeId) => [nodeId, 0]));
  const successors = new Map([...nodes].map((nodeId) => [nodeId, [] as string[]]));
  const seenEdges = new Set<string>();
  const normalized: Required<PreparedIssueDependency>[] = [];
  for (const dependency of dependencies) {
    const fromNodeId = dependency?.fromNodeId?.trim();
    const toNodeId = dependency?.toNodeId?.trim();
    if (!fromNodeId || !toNodeId || !nodes.has(fromNodeId) || !nodes.has(toNodeId)) {
      throw new Error('publication dependency references unknown node');
    }
    if (fromNodeId === toNodeId) throw new Error('publication dependency cannot reference itself');
    if (dependency.kind !== undefined && dependency.kind !== 'blocks') {
      throw new Error('unsupported publication dependency kind');
    }
    const edgeKey = `${fromNodeId}\0${toNodeId}`;
    if (seenEdges.has(edgeKey)) throw new Error('duplicate publication dependency');
    seenEdges.add(edgeKey);
    successors.get(fromNodeId)!.push(toNodeId);
    indegree.set(toNodeId, indegree.get(toNodeId)! + 1);
    normalized.push({ fromNodeId, toNodeId, kind: 'blocks' });
  }
  const ready = [...nodes].filter((nodeId) => indegree.get(nodeId) === 0).sort();
  let visited = 0;
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    visited++;
    for (const successor of successors.get(nodeId)!.slice().sort()) {
      const next = indegree.get(successor)! - 1;
      indegree.set(successor, next);
      if (next === 0) {
        ready.push(successor);
        ready.sort();
      }
    }
  }
  if (visited !== nodes.size) throw new Error('publication dependency graph contains a cycle');
  return Object.freeze(normalized.map((dependency) => Object.freeze(dependency)));
}

export interface Subtask {
  text: string;
  done: boolean;
}

export const MAX_SUBTASK_TEXT_LENGTH = 500;

export type UpdateUnstartedSubtaskResult =
  | { ok: true; index: number; subtask: Subtask }
  | {
      ok: false;
      reason: 'not_found' | 'text_required' | 'text_too_long' | 'already_dispatched';
    };

/** 同一模块永久会话中的一次 issue 工作片段；UI 据此折叠历史、标出任务切换。 */
export interface ConversationSegment {
  /** 稳定键：显式边界事件 id；老数据回退为 legacy-<issueId>。 */
  id: string;
  issueId: number;
  title: string;
  status: IssueState;
  startTs: number;
  endTs: number | null;
}

/** 驱动中的阶段：cc 进程在干活、watcher 要 tail 的状态 */
export const DRIVING_STATES: readonly IssueState[] = ['planning', 'implementing', 'testing'];

/**
 * 可以直接改内容（标题/正文/类别/模块/截图/分支意图）的状态——**唯一真相**（#93）。
 *
 * - `pending`：提交后还没开跑，改了不影响谁；
 * - `blocked`：执行已停止，可修订需求或子任务；保存后仍保持受阻，等用户明确解除；
 * - `cancelled`：已经停了，没有 CC 在读它；「取消 → 改需求 → 重新运行」正是本 issue 的用途。
 *
 * 已开跑的一律不许直接改：CC 早读过原文，偷偷换掉只会造成人机认知不一致，得走澄清/打回把
 * 意见带回会话。`done` 也不许——它是真终态，没有「改完再来」这回事。
 *
 * 守卫落在四处（路由前置判断、updatePendingMeta 的两次检查、patchPendingGitMeta 的 SQL CAS），
 * 全部从这里派生，别再各写各的字符串。
 */
export const EDITABLE_STATES: readonly IssueState[] = ['pending', 'blocked', 'cancelled'];

export function isEditableStatus(status: IssueState): boolean {
  return EDITABLE_STATES.includes(status);
}

/** EDITABLE_STATES 的 SQL 字面量（给 CAS 的 IN 用，跟着常量走不会漂） */
const EDITABLE_STATES_SQL = EDITABLE_STATES.map((s) => `'${s}'`).join(', ');

// ---------- 骨架接口的结构化镜像（不 import agents/notify 实现，评审 5.4#1 依赖方向） ----------

export type EngineDoneJudgement = 'done' | 'not_done' | 'blocked' | 'clarify';

/** 同模块智能合并的候选/结果形状（agents/pm.ts MergeCandidate/MergeGroup 结构一致） */
export interface EngineMergeCandidate {
  id: number;
  title: string;
  body: string | null;
}
export interface EngineMergeGroup {
  members: number[];
  title: string;
  body: string;
}

/** PmAgent 骨架签名子集（agents/pm.ts）；结构兼容，直接传 PmAgent 实例即可 */
export interface EnginePm {
  judgeDone(issue: Issue, recentOutput: string): Promise<EngineDoneJudgement>;
  /**
   * 可选：同模块任务智能合并（LLM）。引擎调度前对同模块 pending 候选调用，拿到合并建议后
   * 确定性折叠（校验/取消/改 body 全在引擎侧）。未实现（老 stub/离线）→ 引擎跳过合并。
   */
  mergeModuleTasks?(module: string, candidates: EngineMergeCandidate[]): Promise<EngineMergeGroup[]>;
}

/** 模块智能整理分析入参（issues/organize-runner RunOrganizeInput 结构一致） */
export interface EngineOrganizeInput {
  projectId: number;
  cwd: string;
  agent: AgentKind;
  projectName: string;
  goal?: string | null;
  modules: Array<{
    id: number;
    slug: string;
    displayName: string;
    agent: AgentKind;
    source: string;
    issueCount: number;
  }>;
  issues: Array<{
    id: number;
    title: string;
    body: string | null;
    status: string;
    agent: AgentKind;
    moduleId: number | null;
  }>;
  locale?: SupportedLocale;
}

/** 模块智能整理分析结果（issues/organize-runner RunOrganizeResult 结构一致） */
export type EngineOrganizeResult =
  | { ok: true; planText: string }
  | { ok: false; reason: string; error?: string };

/** 创建时澄清分析入参（issues/clarify-runner RunClarifyInput 结构一致） */
export interface EngineClarifyInput {
  issueId: number;
  cwd: string;
  agent: AgentKind;
  title: string;
  body?: string | null;
  category?: IssueCategory;
  goal?: string | null;
  projectName?: string;
  /** 创建时澄清的历轮问答（问题批 + 答复），代理据此不重复问已答过的 */
  history?: Array<{ questions: string[]; answer: string | null }>;
  /** false = 提问轮数到顶：本轮只更新反馈不出新题（引擎对结果另有确定性压制） */
  allowQuestions?: boolean;
  locale?: SupportedLocale;
}

/** 创建时澄清分析结果（issues/clarify-runner RunClarifyResult 结构一致） */
export type EngineClarifyResult =
  | { ok: true; feedback: string; questions: string[]; questionsText?: string }
  | { ok: false; reason: string; error?: string };

// ---------- 执行结果总结（文件哨兵；与 clarify-runner/agent-summary 同理，抓屏必误命中） ----------

/** 总结 scratch 根目录名（挂在项目 cwd 下；子目录按 issueId 隔离） */
export const RESULT_SUMMARY_SCRATCH_BASE = '.panda/tmp/result';

/** 给 cwd + issueId 算出总结 scratch 各绝对路径 */
export function resultSummaryPaths(cwd: string, issueId: number): {
  scratch: string;
  summary: string;
  done: string;
} {
  const base = `${cwd.replace(/\/+$/, '')}/${RESULT_SUMMARY_SCRATCH_BASE}/${issueId}`;
  return { scratch: base, summary: `${base}/summary.md`, done: `${base}/done` };
}

/** 组装注入 CC 会话的总结 prompt（单段；哨兵是文件不是输出行，不受回显歧义影响） */
export function buildResultSummaryPrompt(
  issueId: number,
  kind: 'done' | 'blocked',
  locale: SupportedLocale = 'zh-Hans',
): string {
  const rel = `${RESULT_SUMMARY_SCRATCH_BASE}/${issueId}`;
  if (promptLanguage(locale) === 'en') {
    const ask = kind === 'done' ? 'This task is complete.' : 'This task is blocked and has been handed to a person.';
    const points = kind === 'done'
      ? 'what was done, changed files, test results, and remaining work'
      : 'current progress, changed files, the blocker, and what a person must provide';
    return `[Execution summary] ${ask} Write ${points} to ${rel}/summary.md in at most 300 words. Then create ${rel}/done containing ok as the final step. Write only these two files and do nothing else. ${outputLanguageInstruction(locale)}`;
  }
  const ask =
    kind === 'done'
      ? '本任务已完成。请把执行结果总结写到文件'
      : '本任务已受阻转人工。请把当前进展总结写到文件';
  const points =
    kind === 'done'
      ? '做了什么、改动了哪些文件、测试情况、遗留事项'
      : '做到哪一步、已改动哪些文件、卡在哪里/需要人提供什么';
  return (
    `【执行总结】${ask} ${rel}/summary.md：${points}，简洁中文 300 字以内；` +
    `写完后最后创建标记文件 ${rel}/done（内容写 ok）。只写这两个文件，不要做任何其他事。 ${outputLanguageInstruction(locale)}`
  );
}

/**
 * 澄清答复并入正文的格式：有未答的问题批 → 问答成对写入（编号问题 + 答），
 * 否则纯补充。编号答案脱离问题没人读得懂——人和下一轮分析代理都一样。
 */
export function formatClarifyAppend(openQuestions: string[], answer: string): string {
  if (!openQuestions.length) return `【澄清补充】${answer}`;
  return ['【澄清问答】', ...openQuestions.map((q, i) => `${i + 1}. ${q}`), `答：${answer}`].join('\n');
}

/** 推送用需求正文摘要：压平空白取前 n 字（手机通知里一行读完） */
function bodyExcerpt(body: string | null | undefined, n = 120): string {
  const t = (body ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** NotifyRouter.dispatch 的事件形状（notify/router.ts NotifyEvent 结构一致） */
export interface EngineNotifyEvent {
  kind: 'status_change' | 'gate_waiting' | 'issue_done' | 'issue_blocked';
  projectId: number;
  issueId: number;
  from?: IssueState;
  to?: IssueState;
  gate?: Gate;
  summaryCode?:
    | 'status_transition'
    | 'issue_blocked'
    | 'plan_review'
    | 'auto_git_failure'
    | 'merge_review'
    | 'conversation_displaced'
    | 'menu_stuck'
    | 'rate_limited'
    | 'clarification_needed'
    | 'module_organization'
    | 'analysis_clarification';
  summaryParams?: Record<string, string | number>;
  summary?: string;
}

export interface EngineNotifier {
  dispatch(event: EngineNotifyEvent): Promise<void>;
}

/** 对话管理最小接口（core/conversations.ts ConversationManager 结构兼容） */
export interface EngineConvOps {
  create(
    projectId: number,
    label: string,
    agent?: AgentKind,
    kind?: 'issue' | 'chat',
  ): Conversation;
  get(id: string): Conversation | undefined;
  listByProject(projectId: number): Conversation[];
  currentConv(projectId: number): string | undefined;
  tmuxName(projectId: number, convId?: string | null): string;
  activate(id: string, cwdOverride?: string): Promise<Conversation | null>;
  /**
   * 强制重启代理进程（issue #97，无存活短路）。缺省时退化为 activate——它自己也会做
   * 存活检测，只是判据独立、可能与引擎的判定不一致（旧装配/精简 stub 的兼容路径）。
   */
  relaunch?(id: string): Promise<Conversation | null>;
  sleepIssue?(id: string): Promise<void>;
}

export interface EngineLocator {
  locate(convId: string): Promise<string | null>;
  /**
   * 会话失效后的重新认领（可选，AgentJsonlLocator 实现）：按 cwd 重新发现当前
   * 活跃会话并重绑，返回新 jsonl 路径；无候选返回 null 且不动原绑定。
   */
  reclaim?(convId: string): Promise<string | null>;
}

export interface EngineExecutionWorkspace {
  cwd: string;
  kind: 'project' | 'design-worktree';
  /** Fixed batch branch; required for a managed design worktree. */
  branch: string | null;
  runId: string | null;
}

export interface EngineExecutionWorkspaceOps {
  resolve(issue: EngineIssue, project: Project): EngineExecutionWorkspace | Promise<EngineExecutionWorkspace>;
  conversationFor(issue: EngineIssue, workspace: EngineExecutionWorkspace): Promise<Conversation>;
  recordResult?(issue: EngineIssue, workspace: EngineExecutionWorkspace, summary: string): Promise<void>;
}

// ---------- 行映射 ----------

interface IssueRow {
  id: number;
  project_id: number;
  title: string;
  body: string | null;
  category: string;
  status: string;
  module_id?: number | null;
  conv_id: string | null;
  plan_json: string | null;
  subtasks_json: string | null;
  sub_index: number;
  branch: string | null;
  note: string | null;
  images_json: string | null;
  created_by: number | null;
  created_ts: number;
  done_ts: number | null;
  module: string;
  impl_mode: string;
  agent: string;
  /** 032 迁移；SELECT * 在旧库上可能拿不到该列，映射时兜底 null */
  pinned_ts?: number | null;
  /** 033 迁移；同上，旧库兜底 null */
  clarify_feedback?: string | null;
  result_summary?: string | null;
  /** 036 迁移；同上，旧库兜底 null */
  target_branch?: string | null;
  source_ref?: string | null;
  /** 038 迁移；同上，旧库兜底 'medium'（= 既有审批管道行为） */
  auto_approve?: string | null;
  /** 039 迁移；发布节点禁止自动合并。 */
  publication_locked?: number | null;
}

function mapIssue(r: IssueRow): EngineIssue {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    body: r.body,
    category: r.category as IssueCategory,
    status: r.status as IssueState,
    moduleId: r.module_id ?? null,
    convId: r.conv_id,
    planJson: r.plan_json,
    subtasksJson: r.subtasks_json,
    subIndex: r.sub_index,
    branch: r.branch,
    note: r.note,
    imagesJson: r.images_json,
    createdBy: r.created_by,
    createdTs: r.created_ts,
    doneTs: r.done_ts,
    module: r.module,
    implMode: r.impl_mode === 'team' ? 'team' : 'seq',
    agent: r.agent === 'codex' ? 'codex' : 'claude',
    pinnedTs: r.pinned_ts ?? null,
    clarifyFeedback: r.clarify_feedback ?? null,
    resultSummary: r.result_summary ?? null,
    targetBranch: r.target_branch ?? null,
    sourceRef: r.source_ref ?? null,
    // 认不出的值（旧库无此列/脏数据）落回 'medium'——issue 侧的现状行为，不因脏数据变严或变松
    autoApprove: parseAutoApproveLevel(r.auto_approve) ?? 'medium',
    publicationLocked: (r.publication_locked ?? 0) === 1,
  };
}

interface ExecutionSyncRow {
  id: number;
  issue_id: number;
  source_kind: string;
  source_key: string;
  source_revision: string;
  source_digest: string;
  diff_json: string;
  state: string;
  boundary_kind: string | null;
  deferred_action_json: string | null;
  requested_by: number | null;
  requested_ts: number;
  acknowledged_ts: number | null;
  decided_by: number | null;
  decided_ts: number | null;
  resume_state: string;
  resume_key: string | null;
  resume_token: string | null;
  resume_claimed_ts: number | null;
  resumed_ts: number | null;
}

interface ExecutionSyncEffectReceiptRow {
  resume_key: string;
  sync_id: number;
  result_json: string;
  completed_ts: number;
}

interface ExecutionSyncEffectOutboxRow {
  resume_key: string;
  sync_id: number;
  intent_key: string;
  kind: string;
  payload_json: string;
  created_ts: number;
  delivered_ts: number | null;
  delivery_state: string;
  delivery_token: string | null;
  dispatch_started_ts: number | null;
}

function mapExecutionSync(row: ExecutionSyncRow): IssueExecutionSync {
  return {
    id: row.id,
    issueId: row.issue_id,
    sourceKind: row.source_kind,
    sourceKey: row.source_key,
    sourceRevision: row.source_revision,
    sourceDigest: row.source_digest,
    diffJson: row.diff_json,
    state: row.state as IssueExecutionSyncState,
    boundaryKind: row.boundary_kind,
    deferredActionJson: row.deferred_action_json,
    requestedBy: row.requested_by,
    requestedTs: row.requested_ts,
    acknowledgedTs: row.acknowledged_ts,
    decidedBy: row.decided_by,
    decidedTs: row.decided_ts,
    resumeState: row.resume_state as IssueExecutionSync['resumeState'],
    resumeKey: row.resume_key,
    resumeToken: row.resume_token,
    resumeClaimedTs: row.resume_claimed_ts,
    resumedTs: row.resumed_ts,
  };
}

function mapExecutionSyncEffectReceipt(row: ExecutionSyncEffectReceiptRow): IssueExecutionSyncEffectReceipt {
  return {
    syncId: row.sync_id,
    resumeKey: row.resume_key,
    result: decodeExecutionSyncEffectResult(row.result_json),
    completedTs: row.completed_ts,
  };
}

interface EventRow {
  id: number;
  issue_id: number;
  kind: string;
  data_json: string | null;
  ts: number;
}

function mapEvent(r: EventRow): IssueEvent {
  return { id: r.id, issueId: r.issue_id, kind: r.kind, dataJson: r.data_json, ts: r.ts };
}

interface GateRow {
  id: number;
  issue_id: number;
  kind: string;
  status: string;
  payload_json: string | null;
  decided_by: number | null;
  decided_ts: number | null;
}

function mapGate(r: GateRow): Gate {
  return {
    id: r.id,
    issueId: r.issue_id,
    kind: r.kind as GateKind,
    status: r.status as GateStatus,
    payloadJson: r.payload_json,
    decidedBy: r.decided_by,
    decidedTs: r.decided_ts,
  };
}

interface ProjectRow {
  id: number;
  name: string;
  executor_id: number;
  cwd: string;
  owner_user_id: number;
  pm_persona: string | null;
  goal: string | null;
  status: string;
  created_ts: number;
  /** 003 迁移；SELECT * 在旧库上可能拿不到该列，映射时兜底 '' */
  run_user?: string | null;
  /** 005 迁移；同上，旧库兜底 null */
  readme_summary?: string | null;
  /** 006 迁移；同上，旧库兜底 null */
  work_branch?: string | null;
  /** 007 迁移；同上，旧库兜底 null / 'idle' */
  understanding?: string | null;
  understanding_agent?: string | null;
  understanding_ts?: number | null;
  summary_status?: string | null;
  summary_error?: string | null;
  /** 008 迁移；同上，旧库兜底 0（= 全自动流） */
  manual_review?: number | null;
  /** 009 迁移；同上，旧库兜底 'issue'（= issue 看板） */
  kind?: string | null;
}

export function mapProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    executorId: r.executor_id,
    cwd: r.cwd,
    ownerUserId: r.owner_user_id,
    pmPersona: r.pm_persona,
    goal: r.goal,
    status: r.status as ProjectStatus,
    createdTs: r.created_ts,
    runUser: r.run_user ?? '',
    readmeSummary: r.readme_summary ?? null,
    workBranch: r.work_branch ?? null,
    understanding: r.understanding ?? null,
    understandingAgent:
      r.understanding_agent === 'codex' || r.understanding_agent === 'claude'
        ? r.understanding_agent
        : null,
    understandingTs: r.understanding_ts ?? null,
    summaryStatus: (r.summary_status ?? 'idle') as SummaryStatus,
    summaryError: r.summary_error ?? null,
    manualReview: (r.manual_review ?? 0) !== 0,
    kind: r.kind === 'chat' ? 'chat' : 'issue',
  };
}

export function getProject(db: Database, id: number): Project | undefined {
  const r = db.query<ProjectRow, [number]>('SELECT * FROM projects WHERE id = ?').get(id);
  return r ? mapProject(r) : undefined;
}

interface PublicationModuleRow {
  id: number;
  project_id: number;
  slug: string;
  display_name: string;
  agent: string;
  source: string;
  status: string;
  conversation_id: string | null;
  sync_status: string;
  sync_error: string | null;
  created_by: number | null;
  created_ts: number;
  last_used_ts: number | null;
}

function getPublicationModule(db: Database, id: number): ProjectModule | undefined {
  const row = db.query<PublicationModuleRow, [number]>('SELECT * FROM project_modules WHERE id = ?').get(id);
  if (!row) return undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    displayName: row.display_name,
    agent: row.agent === 'codex' ? 'codex' : 'claude',
    source: row.source === 'manual' ? 'manual' : row.source === 'legacy' ? 'legacy' : 'auto',
    status: row.status === 'archived' ? 'archived' : 'active',
    conversationId: row.conversation_id,
    syncStatus: row.sync_status === 'error' ? 'error' : 'ready',
    syncError: row.sync_error,
    createdBy: row.created_by,
    createdTs: row.created_ts,
    lastUsedTs: row.last_used_ts,
  };
}

/** git log 字段分隔符（提交信息里不会出现的控制符；与 web/routes/git.ts 同构） */
const GIT_FIELD_SEP = '\x1f';

/** numstat 的重命名路径归一：'dir/{old => new}/f'、'old => new' → 新路径 */
function normNumstatPath(p: string): string {
  let s = p.replace(/\{([^{}]*) => ([^{}]*)\}/g, '$2').replace(/\/{2,}/g, '/');
  const i = s.indexOf(' => ');
  return i >= 0 ? s.slice(i + 4) : s;
}

/**
 * `diff --name-status` ∪ `diff --numstat`（同一 range）→ 本 issue 触碰的文件列表。
 * name-status 出 status/path/oldPath，numstat 补 adds/dels（二进制为 null）。
 * web/routes/git.ts 有更完整的带引号反转义版；此处是引擎耐久快照的精简实现。
 */
export function parseImplFiles(nameStatus: string, numstat: string): ImplFile[] {
  const stats = new Map<string, { adds: number | null; dels: number | null }>();
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    stats.set(normNumstatPath(m[3]!), {
      adds: m[1] === '-' ? null : Number(m[1]),
      dels: m[2] === '-' ? null : Number(m[2]),
    });
  }
  const files: ImplFile[] = [];
  for (const line of nameStatus.split('\n')) {
    const f = line.split('\t');
    if (f.length < 2 || !f[0]) continue;
    const status = f[0]!;
    const isRename = status[0] === 'R' || status[0] === 'C';
    const path = isRename && f[2] ? f[2]! : f[1]!;
    const rec: ImplFile = { status, path, adds: null, dels: null };
    if (isRename && f[2]) rec.oldPath = f[1]!;
    const st = stats.get(path);
    if (st) {
      rec.adds = st.adds;
      rec.dels = st.dels;
    }
    files.push(rec);
  }
  return files;
}

/** `log --pretty=%H␟%h␟%an␟%at␟%s`（本 issue 净提交，新→旧） → 结构化 commit 列表 */
export function parseImplCommits(logOut: string): ImplCommit[] {
  const commits: ImplCommit[] = [];
  for (const line of logOut.split('\n')) {
    const f = line.split(GIT_FIELD_SEP);
    if (f.length < 5 || !f[0]) continue;
    commits.push({
      sha: f[0]!,
      short: f[1]!,
      author: f[2]!,
      ts: Number(f[3]) * 1000,
      subject: f.slice(4).join(GIT_FIELD_SEP),
    });
  }
  return commits;
}

// ---------- IssueStore：issues/issue_events/gates 的 DB 存取 ----------

export interface IssueInput {
  title: string;
  body?: string | null;
  category?: IssueCategory;
  module?: string;
  moduleId?: number;
  moduleName?: string;
  implMode?: ImplMode;
  agent?: AgentKind;
  targetBranch?: string | null;
  sourceRef?: string | null;
  imagesJson?: string | null;
  createdBy?: number | null;
  /** 创建时就定下的弹窗自动批准档位（#115）；缺省/非法 = 'medium'（既有行为） */
  autoApprove?: AutoApproveLevel;
  /** 项目工作流模板；创建时复制当前版本，之后模板更新不影响本 issue。 */
  workflowTemplateId?: number;
}

export type IssueWorkflowSelectionReason =
  | 'not_found'
  | 'inactive'
  | 'graph_invalid'
  | 'agent_unavailable';

export class IssueWorkflowSelectionError extends Error {
  constructor(
    readonly reason: IssueWorkflowSelectionReason,
    message: string,
    readonly issues: WorkflowValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'IssueWorkflowSelectionError';
  }
}

export interface IssueMetaPatch {
  title?: string;
  body?: string | null;
  module?: string;
  moduleId?: number | null;
  category?: IssueCategory;
  implMode?: ImplMode;
  agent?: AgentKind;
  targetBranch?: string | null;
  sourceRef?: string | null;
  imagesJson?: string | null;
}

export interface PendingModuleSelection {
  moduleId?: number;
  moduleName?: string;
  requestedAgent?: AgentKind;
}

function parseTransData(dataJson: string | null): {
  event?: string;
  from?: string;
  to?: string;
  note?: string;
  stage?: string;
} {
  if (!dataJson) return {};
  try {
    return JSON.parse(dataJson) as Record<string, string>;
  } catch {
    return {};
  }
}

export class IssueStore {
  constructor(private readonly db: Database) {}

  create(projectId: number, input: IssueInput): EngineIssue {
    const row = this.db
      .query<IssueRow, [
        number, string, string | null, string, string, number | null, string, string,
        string | null, string | null, string | null, number | null, string, number,
      ]>(
        `INSERT INTO issues
           (project_id, title, body, category, module, module_id, impl_mode, agent,
            target_branch, source_ref, images_json, created_by, auto_approve, created_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        projectId,
        input.title.slice(0, 200),
        input.body ? input.body.slice(0, 2000) : null,
        input.category === 'debug' ? 'debug' : input.category === 'design' ? 'design' : 'task',
        (input.module || '未分类').slice(0, 60),
        input.moduleId ?? null,
        input.implMode === 'team' ? 'team' : 'seq',
        input.agent === 'codex' ? 'codex' : 'claude',
        input.targetBranch ?? null,
        input.sourceRef ?? null,
        input.imagesJson ?? null,
        input.createdBy ?? null,
        // 归一到三档：038 的列带 CHECK 约束，脏值直接插会抛 SQLITE_CONSTRAINT 把建 issue 整条打挂
        parseAutoApproveLevel(input.autoApprove) ?? 'medium',
        Date.now(),
      );
    if (!row) throw new Error('insert issue failed');
    this.logEvent(row.id, 'created', { title: row.title });
    return mapIssue(row);
  }

  /** 039 publication-only insert: validated exact bytes, pending, locked, and no async side effects. */
  createPublished(projectId: number, input: PreparedDesignIssue): EngineIssue {
    const row = this.db
      .query<IssueRow, [
        number, string, string, string, string, number | null, string, string,
        string | null, string | null, number | null, number,
      ]>(
        `INSERT INTO issues
           (project_id, title, body, category, module, module_id, impl_mode, agent,
            target_branch, source_ref, created_by, created_ts, publication_locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         RETURNING *`,
      )
      .get(
        projectId,
        input.title,
        input.body,
        'task',
        input.moduleSlug,
        input.moduleId,
        input.implMode === 'team' ? 'team' : 'seq',
        input.agent,
        input.targetBranch ?? null,
        input.sourceRef ?? null,
        input.createdBy ?? null,
        Date.now(),
      );
    if (!row) throw new Error('insert published issue failed');
    this.logEvent(row.id, 'created', { title: row.title, publication: true, nodeId: input.nodeId });
    return mapIssue(row);
  }

  get(id: number): EngineIssue | undefined {
    const r = this.db.query<IssueRow, [number]>('SELECT * FROM issues WHERE id = ?').get(id);
    return r ? mapIssue(r) : undefined;
  }

  listByProject(projectId: number): EngineIssue[] {
    return this.db
      .query<IssueRow, [number]>('SELECT * FROM issues WHERE project_id = ? ORDER BY created_ts, id')
      .all(projectId)
      .map(mapIssue);
  }

  /**
   * Scheduler projection: retain every non-pending row for the project-wide busy predicate, but
   * expose a pending row only when every persisted predecessor is exactly done. Pin/module order
   * is applied later and therefore cannot bypass this predicate.
   */
  listRunnableByProject(projectId: number): EngineIssue[] {
    return this.db
      .query<IssueRow, [number]>(
        `SELECT i.* FROM issues i
         WHERE i.project_id = ? AND (
           i.status <> 'pending'
           OR NOT EXISTS (
             SELECT 1 FROM issue_dependencies d
             JOIN issues predecessor ON predecessor.id = d.depends_on_issue_id
             WHERE d.issue_id = i.id AND predecessor.status <> 'done'
           )
         )
         ORDER BY i.created_ts, i.id`,
      )
      .all(projectId)
      .map(mapIssue);
  }

  addDependency(issueId: number, dependsOnIssueId: number, kind = 'blocks'): void {
    if (kind !== 'blocks') throw new Error(`unsupported dependency kind: ${kind}`);
    const scope = this.db
      .query<{ issue_project: number; predecessor_project: number }, [number, number]>(
        `SELECT dependent.project_id AS issue_project,
                predecessor.project_id AS predecessor_project
         FROM issues dependent, issues predecessor
         WHERE dependent.id = ? AND predecessor.id = ?`,
      )
      .get(issueId, dependsOnIssueId);
    if (!scope) throw new Error('dependency issue does not exist');
    if (scope.issue_project !== scope.predecessor_project) {
      throw new Error('dependency issues must belong to the same project');
    }
    this.db.query(
      `INSERT INTO issue_dependencies (issue_id, depends_on_issue_id, kind, created_ts)
       VALUES (?, ?, ?, ?)`,
    ).run(issueId, dependsOnIssueId, kind, Date.now());
  }

  dependencyBlockers(issueId: number): IssueDependencyBlocker[] {
    return this.db
      .query<{ issue_id: number; status: string }, [number]>(
        `SELECT predecessor.id AS issue_id, predecessor.status
         FROM issue_dependencies d
         JOIN issues predecessor ON predecessor.id = d.depends_on_issue_id
         WHERE d.issue_id = ? AND predecessor.status <> 'done'
         ORDER BY predecessor.created_ts, predecessor.id`,
      )
      .all(issueId)
      .map((row) => ({ issueId: row.issue_id, status: row.status as IssueState }));
  }

  designSyncSnapshot(issueId: number): IssueDesignSyncSnapshot | null {
    const issue = this.get(issueId);
    if (!issue) return null;
    const project = this.db.query<{ manual_review: number }, [number]>(
      'SELECT manual_review FROM projects WHERE id = ?',
    ).get(issue.projectId);
    const dependencyIssueIds = this.db.query<{ id: number }, [number]>(
      `SELECT depends_on_issue_id AS id FROM issue_dependencies
       WHERE issue_id = ? ORDER BY depends_on_issue_id`,
    ).all(issueId).map((row) => row.id);
    return {
      issueId,
      projectId: issue.projectId,
      status: issue.status,
      title: issue.title,
      body: issue.body ?? '',
      moduleId: issue.moduleId ?? null,
      agent: issue.agent,
      implMode: issue.implMode === 'team' ? 'team' : 'direct',
      dependencyIssueIds,
      hasConversation: issue.convId !== null,
      manualReview: project?.manual_review === 1,
    };
  }

  updateFromDesignInTransaction<Result>(
    input: IssueDesignSyncUpdate,
    afterUpdate: (updated: IssueDesignSyncSnapshot) => SynchronousCallbackResult<Result>,
  ): Result {
    if (isDeclaredAsyncFunction(afterUpdate)) throw new Error('design sync callback must be synchronous');
    const apply = this.db.transaction(() => {
      const fresh = this.designSyncSnapshot(input.issueId);
      if (!fresh || fresh.status !== input.expectedStatus) throw new Error('design sync issue status changed');
      if (fresh.status === 'pending' && fresh.hasConversation) throw new Error('design sync pending issue already has a session');
      const comparable = ({
        issueId: fresh.issueId,
        projectId: fresh.projectId,
        title: fresh.title,
        body: fresh.body,
        moduleId: fresh.moduleId,
        agent: fresh.agent,
        implMode: fresh.implMode,
        dependencyIssueIds: fresh.dependencyIssueIds,
      });
      if (JSON.stringify(comparable) !== JSON.stringify(input.expected)) {
        throw new Error('design sync local contract changed');
      }
      if (!input.next.title.trim() || input.next.title.length > 200
        || input.next.body.length === 0 || input.next.body.length > MAX_PUBLICATION_BODY) {
        throw new Error('invalid design sync Issue content');
      }
      const project = this.db.query<{ id: number; status: string; kind: string }, [number]>(
        'SELECT id, status, kind FROM projects WHERE id = ?',
      ).get(fresh.projectId);
      if (!project || project.status !== 'active' || project.kind !== 'issue') {
        throw new Error('design sync project is not active');
      }
      const support = projectAgentSupport(this.db, project.id, input.next.agent);
      if (!support.ok) throw new Error(support.error);
      let moduleSlug = 'unclassified';
      if (input.next.moduleId !== null) {
        const module = getPublicationModule(this.db, input.next.moduleId);
        if (!module || module.projectId !== project.id || module.status !== 'active'
          || module.syncStatus !== 'ready' || module.agent !== input.next.agent) {
          throw new Error('design sync module governance changed');
        }
        moduleSlug = module.slug;
      }
      const dependencyIds = [...new Set(input.next.dependencyIssueIds)].sort((a, b) => a - b);
      if (dependencyIds.length !== input.next.dependencyIssueIds.length || dependencyIds.includes(input.issueId)) {
        throw new Error('invalid design sync dependencies');
      }
      for (const dependencyId of dependencyIds) {
        const dependency = this.get(dependencyId);
        if (!dependency || dependency.projectId !== fresh.projectId) {
          throw new Error('design sync dependency is outside project scope');
        }
      }
      this.db.query(
        `UPDATE issues SET title = ?, body = ?, module = ?, module_id = ?, impl_mode = ?, agent = ?
         WHERE id = ? AND status = ?`,
      ).run(
        input.next.title,
        input.next.body,
        moduleSlug,
        input.next.moduleId,
        input.next.implMode === 'team' ? 'team' : 'seq',
        input.next.agent,
        input.issueId,
        input.expectedStatus,
      );
      this.db.query('DELETE FROM issue_dependencies WHERE issue_id = ?').run(input.issueId);
      for (const dependencyId of dependencyIds) {
        this.addDependency(input.issueId, dependencyId, 'blocks');
      }
      this.logEvent(input.issueId, 'design_sync_applied', { sourceRevision: input.sourceRevision });
      const updated = this.designSyncSnapshot(input.issueId)!;
      const result = afterUpdate(updated);
      if (isThenable(result)) throw new Error('design sync callback must be synchronous');
      return result;
    });
    return apply();
  }

  requestExecutionSync(issueId: number, input: IssueExecutionSyncRequest): IssueExecutionSync {
    if (!this.get(issueId)) throw new Error('issue does not exist');
    const sourceKind = input.sourceKind.trim();
    const sourceKey = input.sourceKey.trim();
    const sourceRevision = input.sourceRevision.trim();
    const sourceDigest = input.sourceDigest.trim();
    if (!sourceKind || sourceKind.length > 40) throw new Error('invalid execution sync source kind');
    if (!sourceKey || sourceKey.length > 240) throw new Error('invalid execution sync source key');
    if (!sourceRevision || sourceRevision.length > 120) throw new Error('invalid execution sync source revision');
    if (!sourceDigest || sourceDigest.length > 200) throw new Error('invalid execution sync source digest');
    const diffJson = JSON.stringify(input.diff);
    if (diffJson === undefined || diffJson.length > MAX_EXECUTION_SYNC_JSON) {
      throw new Error('invalid execution sync diff');
    }
    const existing = this.db
      .query<ExecutionSyncRow, [number, string, string, string]>(
        `SELECT * FROM issue_execution_syncs
         WHERE issue_id = ? AND source_kind = ? AND source_key = ? AND source_revision = ?`,
      )
      .get(issueId, sourceKind, sourceKey, sourceRevision);
    if (existing) {
      if (existing.source_digest !== sourceDigest || existing.diff_json !== diffJson) {
        throw new Error('execution sync idempotency conflict');
      }
      return mapExecutionSync(existing);
    }
    const row = this.db
      .query<ExecutionSyncRow, [number, string, string, string, string, string, number | null, number]>(
        `INSERT INTO issue_execution_syncs
           (issue_id, source_kind, source_key, source_revision, source_digest, diff_json,
            state, requested_by, requested_ts)
         VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?)
         RETURNING *`,
      )
      .get(
        issueId,
        sourceKind,
        sourceKey,
        sourceRevision,
        sourceDigest,
        diffJson,
        input.requestedBy ?? null,
        Date.now(),
      );
    if (!row) throw new Error('create execution sync failed');
    return mapExecutionSync(row);
  }

  requestLatestExecutionSync(issueId: number, input: IssueExecutionSyncRequest): IssueExecutionSync {
    const request = this.db.transaction(() => {
      const existing = this.db.query<ExecutionSyncRow, [number, string, string, string]>(
        `SELECT * FROM issue_execution_syncs
         WHERE issue_id = ? AND source_kind = ? AND source_key = ? AND source_revision = ?`,
      ).get(issueId, input.sourceKind.trim(), input.sourceKey.trim(), input.sourceRevision.trim());
      if (existing) return this.requestExecutionSync(issueId, input);
      this.db.query(
        `UPDATE issue_execution_syncs SET state = 'stale', decided_ts = COALESCE(decided_ts, ?)
         WHERE issue_id = ? AND source_kind = ? AND source_key = ?
           AND state IN ('requested', 'boundary_waiting')`,
      ).run(Date.now(), issueId, input.sourceKind.trim(), input.sourceKey.trim());
      return this.requestExecutionSync(issueId, input);
    });
    return request();
  }

  latestExecutionSync(issueId: number, sourceKind: string, sourceKey: string): IssueExecutionSync | null {
    const row = this.db.query<ExecutionSyncRow, [number, string, string]>(
      `SELECT * FROM issue_execution_syncs
       WHERE issue_id = ? AND source_kind = ? AND source_key = ?
       ORDER BY requested_ts DESC, id DESC LIMIT 1`,
    ).get(issueId, sourceKind, sourceKey);
    return row ? mapExecutionSync(row) : null;
  }

  activeExecutionSyncBoundary(issueId: number): IssueExecutionSync | null {
    const row = this.db.query<ExecutionSyncRow, [number]>(
      `SELECT * FROM issue_execution_syncs
       WHERE issue_id = ? AND state = 'boundary_waiting'
       ORDER BY requested_ts DESC, id DESC LIMIT 1`,
    ).get(issueId);
    return row ? mapExecutionSync(row) : null;
  }

  hasUnresolvedExecutionSyncEffect(issueId: number): boolean {
    return this.db.query<{ found: number }, [number]>(
      `SELECT 1 AS found
       FROM issue_execution_sync_effect_outbox effect
       JOIN issue_execution_syncs sync ON sync.id = effect.sync_id
       WHERE sync.issue_id = ? AND effect.delivery_state <> 'delivered'
       LIMIT 1`,
    ).get(issueId) !== null;
  }

  getExecutionSync(id: number): IssueExecutionSync | undefined {
    const row = this.db.query<ExecutionSyncRow, [number]>('SELECT * FROM issue_execution_syncs WHERE id = ?').get(id);
    return row ? mapExecutionSync(row) : undefined;
  }

  holdExecutionSyncBoundary(
    issueId: number,
    boundaryKind: string,
    deferredAction: unknown,
  ): IssueExecutionSync | null {
    const boundary = boundaryKind.trim();
    if (!boundary || boundary.length > 80) throw new Error('invalid execution sync boundary');
    const actionJson = JSON.stringify(deferredAction);
    if (actionJson === undefined || actionJson.length > MAX_EXECUTION_SYNC_JSON) {
      throw new Error('invalid deferred execution action');
    }
    const hold = this.db.transaction(() => {
      const requested = this.db
        .query<ExecutionSyncRow, [number]>(
          `SELECT * FROM issue_execution_syncs
           WHERE issue_id = ? AND state IN ('requested', 'boundary_waiting')
           ORDER BY requested_ts DESC, id DESC LIMIT 1`,
        )
        .get(issueId);
      if (!requested) return null;
      if (requested.state === 'boundary_waiting') {
        if (requested.boundary_kind === boundary && requested.deferred_action_json === actionJson) {
          return mapExecutionSync(requested);
        }
        let existingAction: { kind?: unknown } | null = null;
        try {
          existingAction = JSON.parse(requested.deferred_action_json ?? 'null') as { kind?: unknown } | null;
        } catch {
          // Malformed durable action fails closed below.
        }
        if (existingAction?.kind !== 'safe_state') throw new Error('execution sync boundary conflict');
        const upgraded = this.db.query<ExecutionSyncRow, [string, string, number]>(
          `UPDATE issue_execution_syncs SET boundary_kind = ?, deferred_action_json = ?
           WHERE id = ? AND state = 'boundary_waiting' RETURNING *`,
        ).get(boundary, actionJson, requested.id);
        if (!upgraded) throw new Error('execution sync boundary race');
        return mapExecutionSync(upgraded);
      }
      const row = this.db
        .query<ExecutionSyncRow, [string, string, number, number]>(
          `UPDATE issue_execution_syncs
           SET state = 'boundary_waiting', boundary_kind = ?, deferred_action_json = ?,
               acknowledged_ts = ?
           WHERE id = ? AND state = 'requested'
           RETURNING *`,
        )
        .get(boundary, actionJson, Date.now(), requested.id);
      if (!row) throw new Error('execution sync boundary race');
      return mapExecutionSync(row);
    });
    return hold();
  }

  decideExecutionSync(
    id: number,
    decision: IssueExecutionSyncDecision,
    actor: number,
  ): IssueExecutionSync {
    const target: Exclude<IssueExecutionSyncState, 'requested' | 'boundary_waiting' | 'stale'> =
      decision === 'apply' ? 'applied' : decision === 'ignore' ? 'ignored' : 'supplemented';
    const decide = this.db.transaction(() => {
      const existing = this.getExecutionSync(id);
      if (!existing) throw new Error('execution sync does not exist');
      if (existing.state === target) return existing;
      if (existing.state !== 'boundary_waiting') throw new Error('execution sync decision conflict');
      const resumeKey = `issue-sync:${randomUUID()}`;
      const row = this.db
        .query<ExecutionSyncRow, [string, number, number, string, number]>(
          `UPDATE issue_execution_syncs
           SET state = ?, decided_by = ?, decided_ts = ?, resume_state = 'pending', resume_key = ?
           WHERE id = ? AND state = 'boundary_waiting'
           RETURNING *`,
        )
        .get(target, actor, Date.now(), resumeKey, id);
      if (!row) throw new Error('execution sync decision race');
      return mapExecutionSync(row);
    });
    return decide();
  }

  listResumableExecutionSyncs(limit: number): IssueExecutionSync[] {
    return this.db
      .query<ExecutionSyncRow, [number]>(
        `SELECT * FROM issue_execution_syncs
         WHERE state IN ('applied', 'ignored', 'supplemented')
           AND deferred_action_json IS NOT NULL
           AND resume_state = 'pending'
         ORDER BY decided_ts, id LIMIT ?`,
      )
      .all(limit)
      .map(mapExecutionSync);
  }

  getExecutionSyncEffectReceipt(id: number): IssueExecutionSyncEffectReceipt | null {
    const row = this.db
      .query<ExecutionSyncEffectReceiptRow, [number]>(
        'SELECT * FROM issue_execution_sync_effect_receipts WHERE sync_id = ?',
      )
      .get(id);
    return row ? mapExecutionSyncEffectReceipt(row) : null;
  }

  claimExecutionSyncResume(id: number, now: number): IssueExecutionSync | null {
    const claim = this.db.transaction(() => {
      const receipt = this.getExecutionSyncEffectReceipt(id);
      if (receipt) {
        this.db.query(
          `UPDATE issue_execution_syncs
           SET resume_state = 'complete', resume_token = NULL, resume_claimed_ts = NULL,
               resumed_ts = COALESCE(resumed_ts, ?)
           WHERE id = ? AND resume_key = ? AND resume_state <> 'complete'`,
        ).run(receipt.completedTs, id, receipt.resumeKey);
        return null;
      }
      const token = randomUUID();
      const row = this.db
        .query<ExecutionSyncRow, [string, number, number]>(
          `UPDATE issue_execution_syncs
           SET resume_state = 'running', resume_token = ?, resume_claimed_ts = ?
           WHERE id = ?
             AND state IN ('applied', 'ignored', 'supplemented')
             AND deferred_action_json IS NOT NULL
             AND resume_state = 'pending'
           RETURNING *`,
        )
        .get(token, now, id);
      return row ? mapExecutionSync(row) : null;
    });
    return claim();
  }

  releaseExecutionSyncResume(id: number, token: string): void {
    this.db.query(
      `UPDATE issue_execution_syncs
       SET resume_state = 'pending', resume_token = NULL, resume_claimed_ts = NULL
       WHERE id = ? AND resume_state = 'running' AND resume_token = ?`,
    ).run(id, token);
  }

  resetAbandonedExecutionSyncResume(id: number, resumeKey: string, abandonedToken: string): boolean {
    if (!resumeKey || !abandonedToken) return false;
    const reset = this.db.transaction(() => {
      const owned = this.db.query<{ id: number }, [number, string, string]>(
        `SELECT id FROM issue_execution_syncs
         WHERE id = ? AND resume_state = 'running' AND resume_key = ? AND resume_token = ?`,
      ).get(id, resumeKey, abandonedToken);
      if (!owned) return false;
      const receipt = this.getExecutionSyncEffectReceipt(id);
      if (receipt) {
        return this.db.query(
          `UPDATE issue_execution_syncs
           SET resume_state = 'complete', resume_token = NULL, resume_claimed_ts = NULL,
               resumed_ts = COALESCE(resumed_ts, ?)
           WHERE id = ? AND resume_state = 'running' AND resume_key = ? AND resume_token = ?`,
        ).run(receipt.completedTs, id, resumeKey, abandonedToken).changes === 1;
      }
      return this.db.query(
        `UPDATE issue_execution_syncs
         SET resume_state = 'pending', resume_token = NULL, resume_claimed_ts = NULL
         WHERE id = ? AND resume_state = 'running' AND resume_key = ? AND resume_token = ?`,
      ).run(id, resumeKey, abandonedToken).changes === 1;
    });
    return reset();
  }

  completeExecutionSyncResume(id: number, token: string): boolean {
    const result = this.db.query(
      `UPDATE issue_execution_syncs
       SET resume_state = 'complete', resume_token = NULL, resume_claimed_ts = NULL,
           resumed_ts = COALESCE(resumed_ts, receipt.completed_ts)
       FROM issue_execution_sync_effect_receipts receipt
       WHERE issue_execution_syncs.id = ?
         AND issue_execution_syncs.resume_state = 'running'
         AND issue_execution_syncs.resume_token = ?
         AND receipt.sync_id = issue_execution_syncs.id
         AND receipt.resume_key = issue_execution_syncs.resume_key`,
    ).run(id, token);
    return result.changes === 1;
  }

  commitExecutionSyncEffect<Result>(
    id: number,
    token: string,
    effect: (
      sync: IssueExecutionSync,
      context: IssueExecutionSyncEffectContext,
    ) => SynchronousCallbackResult<Result>,
  ): { applied: boolean; result: Result } {
    if (isDeclaredAsyncFunction(effect)) {
      throw new Error('execution sync effect callback must be synchronous');
    }
    const commit = this.db.transaction(() => {
      const row = this.db.query<ExecutionSyncRow, [number, string]>(
        `SELECT * FROM issue_execution_syncs
         WHERE id = ? AND resume_state = 'running' AND resume_token = ?`,
      ).get(id, token);
      if (!row || !row.resume_key) throw new Error('execution sync resume claim lost');
      const existing = this.getExecutionSyncEffectReceipt(id);
      if (existing) {
        if (!this.completeExecutionSyncResume(id, token)) throw new Error('execution sync resume claim lost');
        return { applied: false, result: existing.result as Result };
      }
      const sync = mapExecutionSync(row);
      const context: IssueExecutionSyncEffectContext = Object.freeze({
        enqueueExternalEffect: (intentKey: string, kind: string, payload: unknown): void => {
          if (!this.db.inTransaction) throw new Error('execution sync effect intent requires active transaction');
          const stableIntentKey = intentKey.trim();
          const stableKind = kind.trim();
          if (!stableIntentKey || stableIntentKey.length > 120 || !stableKind || stableKind.length > 80) {
            throw new Error('invalid execution sync effect intent');
          }
          const payloadJson = JSON.stringify(payload);
          if (payloadJson === undefined || payloadJson.length > MAX_EXECUTION_SYNC_JSON) {
            throw new Error('invalid execution sync effect intent payload');
          }
          this.db.query(
            `INSERT INTO issue_execution_sync_effect_outbox
               (resume_key, sync_id, intent_key, kind, payload_json, created_ts)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(row.resume_key, id, stableIntentKey, stableKind, payloadJson, Date.now());
        },
      });
      const result = effect(sync, context);
      if (isThenable(result)) throw new Error('execution sync effect callback must be synchronous');
      const resultJson = encodeExecutionSyncEffectResult(result);
      const completedTs = Date.now();
      this.db.query(
        `INSERT INTO issue_execution_sync_effect_receipts
           (resume_key, sync_id, result_json, completed_ts)
         VALUES (?, ?, ?, ?)`,
      ).run(row.resume_key, id, resultJson, completedTs);
      if (!this.completeExecutionSyncResume(id, token)) throw new Error('execution sync resume claim lost');
      return { applied: true, result };
    });
    return commit();
  }

  listExecutionSyncEffectOutbox(limit: number): IssueExecutionSyncEffectOutboxItem[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.db.query<ExecutionSyncEffectOutboxRow, [number]>(
      `SELECT * FROM issue_execution_sync_effect_outbox
       WHERE delivery_state = 'pending' ORDER BY created_ts, sync_id, intent_key LIMIT ?`,
    ).all(bounded).map((row) => ({
      resumeKey: row.resume_key,
      syncId: row.sync_id,
      intentKey: row.intent_key,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
      createdTs: row.created_ts,
      deliveredTs: row.delivered_ts,
      deliveryState: row.delivery_state as IssueExecutionSyncEffectOutboxItem['deliveryState'],
      deliveryToken: row.delivery_token,
      dispatchStartedTs: row.dispatch_started_ts,
    }));
  }

  listUncertainExecutionSyncEffects(limit: number): IssueExecutionSyncEffectOutboxItem[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.db.query<ExecutionSyncEffectOutboxRow, [number]>(
      `SELECT * FROM issue_execution_sync_effect_outbox
       WHERE delivery_state IN ('dispatching', 'uncertain')
       ORDER BY created_ts, sync_id, intent_key LIMIT ?`,
    ).all(bounded).map((row) => ({
      resumeKey: row.resume_key,
      syncId: row.sync_id,
      intentKey: row.intent_key,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
      createdTs: row.created_ts,
      deliveredTs: row.delivered_ts,
      deliveryState: row.delivery_state as IssueExecutionSyncEffectOutboxItem['deliveryState'],
      deliveryToken: row.delivery_token,
      dispatchStartedTs: row.dispatch_started_ts,
    }));
  }

  getUncertainExecutionSyncEffect(syncId: number): IssueExecutionSyncEffectOutboxItem | null {
    const row = this.db.query<ExecutionSyncEffectOutboxRow, [number]>(
      `SELECT * FROM issue_execution_sync_effect_outbox
       WHERE sync_id = ? AND delivery_state IN ('dispatching', 'uncertain')
       ORDER BY created_ts, intent_key LIMIT 1`,
    ).get(syncId);
    return row ? {
      resumeKey: row.resume_key,
      syncId: row.sync_id,
      intentKey: row.intent_key,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
      createdTs: row.created_ts,
      deliveredTs: row.delivered_ts,
      deliveryState: row.delivery_state as IssueExecutionSyncEffectOutboxItem['deliveryState'],
      deliveryToken: row.delivery_token,
      dispatchStartedTs: row.dispatch_started_ts,
    } : null;
  }

  resolveUncertainExecutionSyncEffect(
    resumeKey: string,
    intentKey: string,
    resolution: 'confirm_delivered' | 'retry',
  ): boolean {
    if (resolution === 'confirm_delivered') {
      return this.db.query(
        `UPDATE issue_execution_sync_effect_outbox
         SET delivery_state = 'delivered', delivered_ts = COALESCE(delivered_ts, ?),
             delivery_token = NULL, last_error = NULL
         WHERE resume_key = ? AND intent_key = ?
           AND delivery_state IN ('dispatching', 'uncertain')`,
      ).run(Date.now(), resumeKey, intentKey).changes === 1;
    }
    return this.db.query(
      `UPDATE issue_execution_sync_effect_outbox
       SET delivery_state = 'pending', delivery_token = NULL, dispatch_started_ts = NULL,
           last_error = NULL
       WHERE resume_key = ? AND intent_key = ?
         AND delivery_state IN ('dispatching', 'uncertain')`,
    ).run(resumeKey, intentKey).changes === 1;
  }

  claimExecutionSyncEffectDelivery(
    resumeKey: string,
    intentKey: string,
    now: number,
  ): IssueExecutionSyncEffectOutboxItem | null {
    const token = randomUUID();
    const row = this.db.query<ExecutionSyncEffectOutboxRow, [string, number, string, string]>(
      `UPDATE issue_execution_sync_effect_outbox
       SET delivery_state = 'dispatching', delivery_token = ?, dispatch_started_ts = ?, last_error = NULL
       WHERE resume_key = ? AND intent_key = ? AND delivery_state = 'pending'
       RETURNING *`,
    ).get(token, now, resumeKey, intentKey);
    return row ? {
      resumeKey: row.resume_key,
      syncId: row.sync_id,
      intentKey: row.intent_key,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
      createdTs: row.created_ts,
      deliveredTs: row.delivered_ts,
      deliveryState: 'dispatching',
      deliveryToken: row.delivery_token,
      dispatchStartedTs: row.dispatch_started_ts,
    } : null;
  }

  recordExecutionSyncEffectStep(
    resumeKey: string,
    intentKey: string,
    deliveryToken: string,
    stepKey: string,
    payload: unknown,
  ): boolean {
    const payloadJson = JSON.stringify(payload);
    if (!stepKey || stepKey.length > 80 || payloadJson === undefined || payloadJson.length > MAX_EXECUTION_SYNC_JSON) {
      throw new Error('invalid execution sync effect step');
    }
    const record = this.db.transaction(() => {
      const owned = this.db.query<{ found: number }, [string, string, string]>(
        `SELECT 1 AS found FROM issue_execution_sync_effect_outbox
         WHERE resume_key = ? AND intent_key = ? AND delivery_state = 'dispatching' AND delivery_token = ?`,
      ).get(resumeKey, intentKey, deliveryToken);
      if (!owned) return false;
      this.db.query(
        `INSERT INTO issue_execution_sync_effect_steps
           (resume_key, intent_key, step_key, payload_json, completed_ts)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).run(resumeKey, intentKey, stepKey, payloadJson, Date.now());
      return true;
    });
    return record();
  }

  reconcileCompletedExecutionSyncEffectDeliveries(limit: number): number {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.db.query<{ resume_key: string; intent_key: string }, [number]>(
      `SELECT o.resume_key, o.intent_key
       FROM issue_execution_sync_effect_outbox o
       JOIN issue_execution_sync_effect_steps s
         ON s.resume_key = o.resume_key AND s.intent_key = o.intent_key AND s.step_key = 'action-complete'
       WHERE o.delivery_state IN ('dispatching', 'uncertain')
       ORDER BY o.created_ts, o.sync_id, o.intent_key LIMIT ?`,
    ).all(bounded);
    let reconciled = 0;
    for (const row of rows) {
      reconciled += this.db.query(
        `UPDATE issue_execution_sync_effect_outbox
         SET delivery_state = 'delivered', delivered_ts = COALESCE(delivered_ts, ?),
             delivery_token = NULL, last_error = NULL
         WHERE resume_key = ? AND intent_key = ? AND delivery_state IN ('dispatching', 'uncertain')`,
      ).run(Date.now(), row.resume_key, row.intent_key).changes;
    }
    return reconciled;
  }

  markExecutionSyncEffectDelivered(resumeKey: string, intentKey: string, deliveryToken: string): boolean {
    return this.db.query(
      `UPDATE issue_execution_sync_effect_outbox
       SET delivery_state = 'delivered', delivered_ts = COALESCE(delivered_ts, ?),
           delivery_token = NULL, last_error = NULL
       WHERE resume_key = ? AND intent_key = ?
         AND delivery_state = 'dispatching' AND delivery_token = ?`,
    ).run(Date.now(), resumeKey, intentKey, deliveryToken).changes === 1;
  }

  markExecutionSyncEffectUncertain(
    resumeKey: string,
    intentKey: string,
    deliveryToken: string,
    error: string,
  ): boolean {
    return this.db.query(
      `UPDATE issue_execution_sync_effect_outbox
       SET delivery_state = 'uncertain', last_error = ?, delivery_token = NULL
       WHERE resume_key = ? AND intent_key = ?
         AND delivery_state = 'dispatching' AND delivery_token = ?`,
    ).run(error.slice(0, 4000), resumeKey, intentKey, deliveryToken).changes === 1;
  }

  /**
   * 驱动中（planning/implementing/testing 且已绑对话）的 issue —— watcher 遍历对象。
   * M4：JOIN projects.status='active'——归档项目的 issue 不再被 tick 驱动/kickoff。
   */
  listDriving(): EngineIssue[] {
    return this.db
      .query<IssueRow, []>(
        `SELECT i.* FROM issues i
         JOIN projects p ON p.id = i.project_id AND p.status = 'active'
         WHERE (
           i.status IN ('planning', 'implementing', 'testing') AND i.conv_id IS NOT NULL
         ) OR (
           i.status IN ('planning', 'plan_review', 'implementing', 'testing')
           AND EXISTS (SELECT 1 FROM issue_workflows iw WHERE iw.issue_id = i.id)
         )
         ORDER BY i.id`,
      )
      .all()
      .map(mapIssue);
  }

  /**
   * 悬空创建时澄清（重启恢复扫描的判据）：最后一条 clarify_started 之后无终态事件
   * —— clarify_done / clarify_discarded / error@where=clarify。分析链与轮询 runner
   * 是进程内存态，PandaDOS 重启即蒸发，只留下这种「有头无尾」的事件形状。
   * 不看 issue 状态（pending 重跑还是补收口由引擎分流）；只扫 active 项目。
   */
  listDanglingClarify(): EngineIssue[] {
    return this.db
      .query<IssueRow, []>(
        `SELECT i.* FROM issues i
         JOIN projects p ON p.id = i.project_id AND p.status = 'active'
         JOIN (SELECT issue_id, MAX(id) AS started_id FROM issue_events
               WHERE kind = 'clarify_started' GROUP BY issue_id) s ON s.issue_id = i.id
         WHERE NOT EXISTS (
           SELECT 1 FROM issue_events t
           WHERE t.issue_id = i.id AND t.id > s.started_id AND (
             t.kind IN ('clarify_done', 'clarify_discarded')
             OR (t.kind = 'error' AND t.data_json LIKE '%"where":"clarify"%')
           )
         )
         ORDER BY i.id`,
      )
      .all()
      .map(mapIssue);
  }

  /** CAS 状态迁移：仅当当前状态仍是 from 才写入（读-判-重读-CAS 的落库端） */
  casStatus(id: number, from: IssueState, to: IssueState): boolean {
    const r = this.db
      .query(
        `UPDATE issues SET status = ?, done_ts = CASE WHEN ? = 'done' THEN ? ELSE done_ts END
         WHERE id = ? AND status = ?`,
      )
      .run(to, to, Date.now(), id, from);
    return r.changes > 0;
  }

  /**
   * 绑对话；约束：一 conv 同时只属一条未关闭 issue（评审 3.2-4 修复）。
   *
   * 例外：**模块会话按设计被同模块 issue 顺序复用**（project_modules.conversation_id 持久持有），
   * 所以占用者只要已不在驱动中（典型是 blocked，或 unblock 回 pending 的），就放行——否则一条
   * blocked 会永久攥着模块会话，让该模块再也起不来。真正的「同时只有一条在跑」由项目级
   * isBusy 保证，不靠这里。非模块会话（debug/项目对话）仍按老规矩独占。
   */
  setConv(id: number, convId: string): void {
    const clash = this.db
      .query<{ id: number; status: string }, [string, number]>(
        `SELECT id, status FROM issues WHERE conv_id = ? AND status NOT IN ('done', 'cancelled') AND id != ?`,
      )
      .get(convId, id);
    if (clash && !this.canShareConv(id, convId, clash.status)) {
      throw new Error(`对话已绑定未关闭 issue #${clash.id}`);
    }
    this.db.query('UPDATE issues SET conv_id = ? WHERE id = ?').run(convId, id);
  }

  /** 该 conv 是 issue 所属模块的模块会话，且占用者已不在驱动中 → 可顺序复用 */
  private canShareConv(id: number, convId: string, clashStatus: string): boolean {
    if (BUSY_STATES.includes(clashStatus as IssueState)) return false;
    return !!this.db
      .query<{ n: number }, [string, number]>(
        `SELECT 1 AS n FROM project_modules pm
          JOIN issues i ON i.module_id = pm.id
         WHERE pm.conversation_id = ? AND i.id = ?`,
      )
      .get(convId, id);
  }

  setBranch(id: number, branch: string): void {
    this.db.query('UPDATE issues SET branch = ? WHERE id = ?').run(branch, id);
  }

  setBody(id: number, body: string): void {
    this.db.query('UPDATE issues SET body = ? WHERE id = ?').run(body.slice(0, 8000), id);
  }

  setNote(id: number, note: string | null): void {
    this.db.query('UPDATE issues SET note = ? WHERE id = ?').run(note, id);
  }

  /** 置顶时刻（ms）；null = 取消置顶。仅影响 pending 排队顺序（queue.pickNext 置顶层） */
  setPinned(id: number, pinnedTs: number | null): void {
    this.db.query('UPDATE issues SET pinned_ts = ? WHERE id = ?').run(pinnedTs, id);
  }

  /** 自动批准档位（038）：随时可改，下一轮弹窗即按新档位分级 */
  setAutoApprove(id: number, level: AutoApproveLevel): void {
    this.db.query('UPDATE issues SET auto_approve = ? WHERE id = ?').run(level, id);
  }

  /** 创建时执行代理反馈（033）；null = 清空（重新分析前） */
  setClarifyFeedback(id: number, text: string | null): void {
    this.db
      .query('UPDATE issues SET clarify_feedback = ? WHERE id = ?')
      .run(text ? text.slice(0, 8000) : null, id);
  }

  /** 收尾执行结果总结（033）；null = 清空 */
  setResultSummary(id: number, text: string | null): void {
    this.db
      .query('UPDATE issues SET result_summary = ? WHERE id = ?')
      .run(text ? text.slice(0, 16000) : null, id);
  }

  patchMeta(id: number, meta: IssueMetaPatch): void {
    if (meta.title !== undefined) this.db.query('UPDATE issues SET title = ? WHERE id = ?').run(meta.title.slice(0, 200), id);
    if (meta.body !== undefined) this.db.query('UPDATE issues SET body = ? WHERE id = ?').run(meta.body ? meta.body.slice(0, 8000) : null, id);
    if (meta.module !== undefined) this.db.query('UPDATE issues SET module = ? WHERE id = ?').run((meta.module || '未分类').slice(0, 60), id);
    if (meta.moduleId !== undefined) this.db.query('UPDATE issues SET module_id = ? WHERE id = ?').run(meta.moduleId, id);
    if (meta.category !== undefined) this.db.query('UPDATE issues SET category = ? WHERE id = ?').run(meta.category, id);
    if (meta.implMode !== undefined) this.db.query('UPDATE issues SET impl_mode = ? WHERE id = ?').run(meta.implMode, id);
    if (meta.agent !== undefined) this.db.query('UPDATE issues SET agent = ? WHERE id = ?').run(meta.agent === 'codex' ? 'codex' : 'claude', id);
    if (meta.targetBranch !== undefined) this.db.query('UPDATE issues SET target_branch = ? WHERE id = ?').run(meta.targetBranch, id);
    if (meta.sourceRef !== undefined) this.db.query('UPDATE issues SET source_ref = ? WHERE id = ?').run(meta.sourceRef, id);
    // 截图：存相对 cwd 路径的 JSON 数组（与建 issue 同格式）；null = 清空所有截图
    if (meta.imagesJson !== undefined) this.db.query('UPDATE issues SET images_json = ? WHERE id = ?').run(meta.imagesJson, id);
  }

  /**
   * target/source 必须同一条 SQL 落库，并以可编辑状态为 CAS 条件。
   * 这样状态迁移与 Git 意图编辑无论谁先写，另一个都能看到确定的先后顺序。
   */
  patchPendingGitMeta(
    id: number,
    meta: { targetBranch?: string | null; sourceRef?: string | null },
  ): boolean {
    const targetGiven = meta.targetBranch !== undefined;
    const sourceGiven = meta.sourceRef !== undefined;
    const r = this.db
      .query<unknown, [number, string | null, number, string | null, number]>(
        `UPDATE issues
         SET target_branch = CASE WHEN ? = 1 THEN ? ELSE target_branch END,
             source_ref = CASE WHEN ? = 1 THEN ? ELSE source_ref END
         WHERE id = ? AND status IN (${EDITABLE_STATES_SQL})`,
      )
      .run(
        targetGiven ? 1 : 0,
        meta.targetBranch ?? null,
        sourceGiven ? 1 : 0,
        meta.sourceRef ?? null,
        id,
      );
    return r.changes > 0;
  }

  subtasksOf(issue: EngineIssue): Subtask[] {
    if (!issue.subtasksJson) return [];
    try {
      const a = JSON.parse(issue.subtasksJson) as Subtask[];
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }

  setSubtasks(id: number, texts: string[]): void {
    const subs: Subtask[] = texts.map((t) => ({ text: t.slice(0, MAX_SUBTASK_TEXT_LENGTH), done: false }));
    this.db
      .query('UPDATE issues SET subtasks_json = ?, sub_index = 0, plan_json = ? WHERE id = ?')
      .run(JSON.stringify(subs), JSON.stringify({ subtasks: texts, ts: Date.now() }), id);
  }

  setSubtasksAtDesignBoundary(id: number, texts: string[]): IssueExecutionSync | null {
    const persist = this.db.transaction(() => {
      this.setSubtasks(id, texts);
      return this.holdExecutionSyncBoundary(id, 'plan_ready', {
        kind: 'issue-event', event: 'plan_ready', options: {},
      });
    });
    return persist();
  }

  /** 保留完成进度地替换计划文本；plan_review 时同步待确认卡点，避免详情与卡点显示两版计划。 */
  replaceSubtasks(id: number, subs: Subtask[], syncWaitingPlanGate: boolean): void {
    const issue = this.get(id);
    if (!issue) return;
    const texts = subs.map((subtask) => subtask.text);
    let plan: Record<string, unknown> = {};
    try {
      plan = issue.planJson ? (JSON.parse(issue.planJson) as Record<string, unknown>) : {};
    } catch {
      plan = {};
    }
    const update = this.db.transaction(() => {
      this.db
        .query('UPDATE issues SET subtasks_json = ?, plan_json = ? WHERE id = ?')
        .run(JSON.stringify(subs), JSON.stringify({ ...plan, subtasks: texts }), id);
      if (!syncWaitingPlanGate) return;
      const gate = this.db
        .query<GateRow, [number]>(
          `SELECT * FROM gates
           WHERE issue_id = ? AND kind = 'plan' AND status = 'waiting'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(id);
      if (!gate) return;
      let payload: Record<string, unknown> = {};
      try {
        payload = gate.payload_json ? (JSON.parse(gate.payload_json) as Record<string, unknown>) : {};
      } catch {
        payload = {};
      }
      this.db
        .query("UPDATE gates SET payload_json = ? WHERE id = ? AND status = 'waiting'")
        .run(JSON.stringify({ ...payload, subtasks: texts }), gate.id);
    });
    update();
  }

  /** 标记当前子任务完成、前进一个；返回是否全部完成（v1 advanceSubtask 平移） */
  advanceSubtask(id: number): { allDone: boolean; nextIdx: number } | null {
    const issue = this.get(id);
    if (!issue) return null;
    const subs = this.subtasksOf(issue);
    if (!subs.length) return null;
    const idx = issue.subIndex;
    if (subs[idx]) subs[idx]!.done = true;
    const next = idx + 1;
    this.db
      .query('UPDATE issues SET subtasks_json = ?, sub_index = ? WHERE id = ?')
      .run(JSON.stringify(subs), next, id);
    return { allDone: next >= subs.length, nextIdx: next };
  }

  /** Complete exactly the current seq subtask and atomically withhold its next injection if needed. */
  advanceSubtaskAtDesignBoundary(
    id: number,
  ): { allDone: boolean; nextIdx: number; held: IssueExecutionSync | null } | null {
    const advance = this.db.transaction(() => {
      const issue = this.get(id);
      if (!issue || issue.status !== 'implementing' || issue.implMode !== 'seq') return null;
      const subs = this.subtasksOf(issue);
      const idx = issue.subIndex;
      if (!subs[idx] || subs[idx]!.done) return null;
      subs[idx]!.done = true;
      const nextIdx = idx + 1;
      this.db.query('UPDATE issues SET subtasks_json = ?, sub_index = ? WHERE id = ? AND sub_index = ?')
        .run(JSON.stringify(subs), nextIdx, id, idx);
      const allDone = nextIdx >= subs.length;
      const held = allDone
        ? null
        : this.holdExecutionSyncBoundary(id, 'inject_subtask', {
          kind: 'inject_subtask', nextIndex: nextIdx,
        });
      return { allDone, nextIdx, held };
    });
    return advance();
  }

  markAllSubtasksDone(id: number): void {
    const issue = this.get(id);
    if (!issue) return;
    const subs = this.subtasksOf(issue);
    if (!subs.length) return;
    for (const s of subs) s.done = true;
    this.db
      .query('UPDATE issues SET subtasks_json = ?, sub_index = ? WHERE id = ?')
      .run(JSON.stringify(subs), subs.length, id);
  }

  remove(id: number): boolean {
    return this.db.query('DELETE FROM issues WHERE id = ?').run(id).changes > 0;
  }

  /** 项目内「未关闭 issue 已占用」的 conv id 集合（含 pending 已绑——v1 漏排是雷） */
  busyConvIds(projectId: number): Set<string> {
    const rows = this.db
      .query<{ conv_id: string }, [number]>(
        `SELECT conv_id FROM issues
         WHERE project_id = ? AND conv_id IS NOT NULL AND status NOT IN ('done', 'cancelled')`,
      )
      .all(projectId);
    return new Set(rows.map((r) => r.conv_id));
  }

  // ---- 事件时间线（全量，不截断） ----

  logEvent(issueId: number, kind: string, data?: Record<string, unknown>): void {
    this.db
      .query('INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, ?, ?, ?)')
      .run(issueId, kind, data ? JSON.stringify(data) : null, Date.now());
  }

  listEvents(issueId: number): IssueEvent[] {
    return this.db
      .query<EventRow, [number]>('SELECT * FROM issue_events WHERE issue_id = ? ORDER BY id')
      .all(issueId)
      .map(mapEvent);
  }

  /**
   * 一条模块共享会话的 issue 分段。新数据以显式 started/ended 事件为准；上线前的历史
   * 会话没有这两类事件，回退到首条 injected + 首个终态 transition，避免旧对话仍糊成一团。
   */
  listConversationSegments(convId: string): ConversationSegment[] {
    const issues = this.db
      .query<IssueRow, [string]>('SELECT * FROM issues WHERE conv_id = ? ORDER BY created_ts, id')
      .all(convId)
      .map(mapIssue);
    const out: ConversationSegment[] = [];
    for (const issue of issues) {
      const events = this.listEvents(issue.id);
      const starts = events.filter((e) => {
        if (e.kind !== 'conversation_segment_started') return false;
        try {
          return (JSON.parse(e.dataJson ?? '{}') as { convId?: unknown }).convId === convId;
        } catch {
          return false;
        }
      });
      if (starts.length === 0) {
        const injected = events.find((e) => e.kind === 'injected');
        if (!injected) continue;
        const terminal = events.find((e) => {
          if (e.id <= injected.id || e.kind !== 'transition') return false;
          const to = parseTransData(e.dataJson).to;
          return to === 'done' || to === 'blocked' || to === 'cancelled';
        });
        out.push({
          id: `legacy-${issue.id}`,
          issueId: issue.id,
          title: issue.title,
          status: issue.status,
          startTs: injected.ts,
          endTs: terminal?.ts ?? null,
        });
        continue;
      }
      for (let i = 0; i < starts.length; i++) {
        const start = starts[i]!;
        const nextStartId = starts[i + 1]?.id ?? Number.POSITIVE_INFINITY;
        const end = events.find((e) => {
          if (e.id <= start.id || e.id >= nextStartId || e.kind !== 'conversation_segment_ended') return false;
          try {
            return (JSON.parse(e.dataJson ?? '{}') as { convId?: unknown }).convId === convId;
          } catch {
            return false;
          }
        });
        let status = issue.status;
        if (end?.dataJson) {
          try {
            const recorded = (JSON.parse(end.dataJson) as { status?: unknown }).status;
            if (typeof recorded === 'string') status = recorded as IssueState;
          } catch {
            /* 坏事件只丢状态快照，边界仍可用 */
          }
        }
        out.push({
          id: `event-${start.id}`,
          issueId: issue.id,
          title: issue.title,
          status,
          startTs: start.ts,
          endTs: end?.ts ?? null,
        });
      }
    }
    return out.sort((a, b) => a.startTs - b.startTs || a.issueId - b.issueId);
  }

  /** 项目维度最近一次某类事件（issue_events 免迁移复用：跨 issue 冷却/读最新建议） */
  lastProjectEvent(projectId: number, kind: string): IssueEvent | null {
    const r = this.db
      .query<EventRow, [number, string]>(
        `SELECT e.* FROM issue_events e
         JOIN issues i ON i.id = e.issue_id
         WHERE i.project_id = ? AND e.kind = ?
         ORDER BY e.ts DESC, e.id DESC LIMIT 1`,
      )
      .get(projectId, kind);
    return r ? mapEvent(r) : null;
  }

  lastProjectEventTs(projectId: number, kind: string): number | null {
    return this.lastProjectEvent(projectId, kind)?.ts ?? null;
  }

  /** 项目维度某类事件全量（整理方案的 applied 标记回放用；量小不分页） */
  listProjectEvents(projectId: number, kind: string): IssueEvent[] {
    return this.db
      .query<EventRow, [number, string]>(
        `SELECT e.* FROM issue_events e
         JOIN issues i ON i.id = e.issue_id
         WHERE i.project_id = ? AND e.kind = ?
         ORDER BY e.id`,
      )
      .all(projectId, kind)
      .map(mapEvent);
  }

  countEvents(issueId: number, kind: string): number {
    const r = this.db
      .query<{ n: number }, [number, string]>(
        'SELECT COUNT(*) AS n FROM issue_events WHERE issue_id = ? AND kind = ?',
      )
      .get(issueId, kind);
    return r?.n ?? 0;
  }

  /** 最近一次某类事件的 id；从未发生过返回 0（可直接当作「不设下界」用） */
  lastEventId(issueId: number, kind: string): number {
    const r = this.db
      .query<{ id: number }, [number, string]>(
        'SELECT id FROM issue_events WHERE issue_id = ? AND kind = ? ORDER BY id DESC LIMIT 1',
      )
      .get(issueId, kind);
    return r?.id ?? 0;
  }

  /** 某类事件在 afterEventId 之后的条数（afterEventId=0 即全量，与 countEvents 等价） */
  countEventsSince(issueId: number, kind: string, afterEventId: number): number {
    const r = this.db
      .query<{ n: number }, [number, string, number]>(
        'SELECT COUNT(*) AS n FROM issue_events WHERE issue_id = ? AND kind = ? AND id > ?',
      )
      .get(issueId, kind, afterEventId);
    return r?.n ?? 0;
  }

  /**
   * 复活前清掉上一轮的残留运行态（#93）。**只清跑出来的东西**：计划、子任务及其进度、
   * 导入遗留的 note、完成时刻。
   *
   * 刻意不动的：`conv_id` 与模块绑定（模块会话本就该被同模块 issue 顺序复用，清了反而
   * 要重新建会话）、事件历史（审计与「上一轮干到哪」全靠它）、截图、置顶、目标分支。
   */
  clearRunState(id: number): void {
    this.db
      .query('UPDATE issues SET plan_json = NULL, subtasks_json = NULL, sub_index = 0, note = NULL, done_ts = NULL WHERE id = ?')
      .run(id);
  }

  /**
   * 创建时澄清的历轮问答（事件溯源，免迁移）：非 exec 来源的 clarify_questions 开新轮，
   * 其后的 clarified 答复并入最近一轮（多次答复换行连接）。exec（执行中澄清）问答不混入——
   * 它有自己的会话内上下文，也不该占创建时的提问轮数。
   */
  clarifyRounds(issueId: number): Array<{ questions: string[]; answer: string | null }> {
    const rounds: Array<{ questions: string[]; answer: string | null }> = [];
    for (const e of this.listEvents(issueId)) {
      let data: Record<string, unknown> = {};
      try {
        data = e.dataJson ? (JSON.parse(e.dataJson) as Record<string, unknown>) : {};
      } catch {
        continue;
      }
      if (e.kind === 'clarify_questions') {
        if (data.source === 'exec') continue;
        const questions = (Array.isArray(data.questions) ? data.questions : []).filter(
          (q): q is string => typeof q === 'string' && q.length > 0,
        );
        if (questions.length) rounds.push({ questions, answer: null });
      } else if (e.kind === 'clarified' && rounds.length) {
        const answer = typeof data.answer === 'string' ? data.answer.trim() : '';
        if (!answer) continue;
        const last = rounds[rounds.length - 1]!;
        last.answer = last.answer ? `${last.answer}\n${answer}` : answer;
      }
    }
    return rounds;
  }

  /**
   * 是否有「澄清问题待回答」：最近一次 clarify_questions 之后还没有 clarified/clarify_timeout。
   * 跨状态适用（事件溯源）：创建时问题开跑后仍持续显示到回答为止（spec 第 5 点），执行中澄清
   * 同理——被回答（clarified）或 20 分钟超时自动继续（clarify_timeout）后即收起。
   */
  clarifyPendingOf(issueId: number): boolean {
    const maxOf = (kind: string): number =>
      this.db
        .query<{ m: number | null }, [number, string]>(
          'SELECT MAX(id) AS m FROM issue_events WHERE issue_id = ? AND kind = ?',
        )
        .get(issueId, kind)?.m ?? 0;
    const q = maxOf('clarify_questions');
    const answered = Math.max(maxOf('clarified'), maxOf('clarify_timeout'));
    return q > 0 && answered < q;
  }

  /**
   * 执行中澄清「正在等待」的派生（事件溯源，免列/免迁移）：取最近一条 clarify_questions
   * 事件，仅当其 source=exec 且其后没有 clarified/clarify_timeout 时，视为「代理在等你澄清」，
   * 返回 {since=事件 ts, questions, stage}；否则 null。
   * 供 watcher 停催 + 20 分钟超时自动继续、以及 API 的 awaitingClarify 派生使用。
   * （创建时澄清 source≠exec，不在此列——那类由 clarifyPendingOf 覆盖，不触发停催/超时。）
   */
  execClarifyWait(issueId: number): { since: number; questions: string[]; stage: string } | null {
    const last = this.db
      .query<EventRow, [number]>(
        "SELECT * FROM issue_events WHERE issue_id = ? AND kind = 'clarify_questions' ORDER BY id DESC LIMIT 1",
      )
      .get(issueId);
    if (!last) return null;
    let data: { questions?: unknown; source?: unknown; stage?: unknown } = {};
    try {
      data = last.data_json ? (JSON.parse(last.data_json) as typeof data) : {};
    } catch {
      data = {};
    }
    if (data.source !== 'exec') return null;
    // 其后若已回答（clarified）或超时自动继续（clarify_timeout），则不再等待
    const terminated =
      this.db
        .query<{ n: number }, [number, number]>(
          "SELECT COUNT(*) AS n FROM issue_events WHERE issue_id = ? AND id > ? AND kind IN ('clarified', 'clarify_timeout')",
        )
        .get(issueId, last.id)?.n ?? 0;
    if (terminated > 0) return null;
    const questions = Array.isArray(data.questions)
      ? (data.questions as unknown[]).filter((q): q is string => typeof q === 'string')
      : [];
    const stage = typeof data.stage === 'string' ? data.stage : '';
    return { since: last.ts, questions, stage };
  }

  /** 最近一次「转入 stage」的 transition 事件 id（kickoff 判重锚点）；没有则 0 */
  lastEnterEventId(issueId: number, stage: IssueState): number {
    for (const e of this.recentEvents(issueId, 'transition')) {
      if (parseTransData(e.dataJson).to === stage) return e.id;
    }
    return 0;
  }

  /** 最近一次「转入 stage」的事件详情（event/from/note）——返工 prompt 取意见用 */
  lastEnterInfo(issueId: number, stage: IssueState): { event: string; from: string; note?: string } | null {
    for (const e of this.recentEvents(issueId, 'transition')) {
      const d = parseTransData(e.dataJson);
      if (d.to === stage) {
        return { event: d.event ?? '', from: d.from ?? '', ...(d.note ? { note: d.note } : {}) };
      }
    }
    return null;
  }

  /**
   * 自 sinceEventId 以来最近**连续** judged=done 的次数（issue #48：planning 判 done
   * 死循环出口的计数器；遇到非 done 判定即断，事件为凭、重启不丢）。
   */
  consecutiveJudgedDone(issueId: number, sinceEventId: number): number {
    let n = 0;
    for (const e of this.recentEvents(issueId, 'judged')) {
      if (e.id <= sinceEventId) break;
      try {
        if ((JSON.parse(e.dataJson ?? '{}') as { result?: string }).result !== 'done') break;
      } catch {
        break;
      }
      n++;
    }
    return n;
  }

  /** stage 进入后是否已注入过该阶段首条 prompt（kickoff 幂等判据，重启安全） */
  hasInjectedSince(issueId: number, stage: IssueState, sinceEventId: number): boolean {
    for (const e of this.recentEvents(issueId, 'injected')) {
      if (e.id <= sinceEventId) break; // 按 id 降序，早于锚点的不用再看
      if (parseTransData(e.dataJson).stage === stage) return true;
    }
    return false;
  }

  private recentEvents(issueId: number, kind: string, limit = 200): IssueEvent[] {
    return this.db
      .query<EventRow, [number, string, number]>(
        'SELECT * FROM issue_events WHERE issue_id = ? AND kind = ? ORDER BY id DESC LIMIT ?',
      )
      .all(issueId, kind, limit)
      .map(mapEvent);
  }

  // ---- gates ----

  createGate(issueId: number, kind: GateKind, payload: Record<string, unknown>): Gate {
    const row = this.db
      .query<GateRow, [number, string, string]>(
        `INSERT INTO gates (issue_id, kind, payload_json) VALUES (?, ?, ?) RETURNING *`,
      )
      .get(issueId, kind, JSON.stringify(payload));
    if (!row) throw new Error('insert gate failed');
    return mapGate(row);
  }

  getGate(id: number): Gate | undefined {
    const r = this.db.query<GateRow, [number]>('SELECT * FROM gates WHERE id = ?').get(id);
    return r ? mapGate(r) : undefined;
  }

  listGates(issueId: number): Gate[] {
    return this.db
      .query<GateRow, [number]>('SELECT * FROM gates WHERE issue_id = ? ORDER BY id')
      .all(issueId)
      .map(mapGate);
  }

  /** waiting→decided 的 CAS（一次性防重放，评审 5.4#3）；返回是否本次生效 */
  decideGate(id: number, status: 'approved' | 'rejected', userId: number, note?: string): boolean {
    const gate = this.getGate(id);
    if (!gate) return false;
    let payload: Record<string, unknown> = {};
    try {
      payload = gate.payloadJson ? (JSON.parse(gate.payloadJson) as Record<string, unknown>) : {};
    } catch {
      payload = {};
    }
    if (note) payload.decisionNote = note.slice(0, 2000);
    const r = this.db
      .query(
        `UPDATE gates SET status = ?, decided_by = ?, decided_ts = ?, payload_json = ?
         WHERE id = ? AND status = 'waiting'`,
      )
      .run(status, userId, Date.now(), JSON.stringify(payload), id);
    return r.changes > 0;
  }

  /** issue 关闭（blocked/cancelled/done）时把遗留 waiting 卡点关掉，防孤儿卡片被点 */
  expireWaitingGates(issueId: number): void {
    this.db
      .query(`UPDATE gates SET status = 'rejected', decided_ts = ? WHERE issue_id = ? AND status = 'waiting'`)
      .run(Date.now(), issueId);
  }
}

// ---------- 引擎 ----------

export interface EngineConfig {
  /** 安静多久后催哨兵（v1 AUTOPILOT_NUDGE_SEC=180 平移） */
  nudgeSec: number;
  /** 安静多久后 PM 保守判定（v1 AUTOPILOT_FALLBACK_SEC=360 平移） */
  fallbackSec: number;
  /**
   * 执行中澄清等待的自动继续时限（spec 第 2 点）：代理输出 NEED_CLARIFY 后进入「等待用户澄清」，
   * 引擎停催停判；超过此时长仍没等到答复 → 注入「按最佳判断继续」并记 clarify_timeout 复位续跑。
   */
  clarifyTimeoutMs: number;
  /**
   * 创建时澄清的提问轮数上限：pending 期每轮答复/改需求都会重新分析，但最多抛这么多轮
   * 新问题；到顶后仍更新反馈、不再出题（反复追问比按最佳判断做更打扰人）。
   */
  clarifyMaxQuestionRounds: number;
  /** 进程启动后至少等多久才 kickoff（v1 5s 下限平移） */
  kickoffMinBootMs: number;
  /**
   * kickoff 就绪超时（I4）：进入驱动阶段后，若始终检不到 CC 就绪判据
   * （jsonl 已可定位 或 capturePane 出现输入框特征 ❯/╭─），超过此时长 → block。
   */
  kickoffReadyTimeoutMs: number;
  /** limit 退避（v1 5min 平移） */
  limitBackoffMs: number;
  /**
   * 会话失效判定窗口（issue #48）：注入 prompt 后超过此时长绑定 jsonl 仍零增长、
   * 而 pane 有 CC 输入框特征 → 判绑定已死（撞限退出/人工重启换进程/时区错绑），
   * 触发 locator.reclaim 重新认领当前活跃会话。0 = 关闭检测。
   */
  sessionStaleMs: number;
  /** 菜单滞留多久通知订阅者（v1 黑洞 H16 的新增防线） */
  menuStuckMs: number;
  /** judgeDone 读 jsonl 末尾窗口（v1 16000B 平移） */
  judgeWindowBytes: number;
  /** judgeDone 喂 PM 的字符窗口（v1 4000 平移） */
  judgeTailChars: number;
  /** 合并基线分支 */
  baseBranch: string;
  /** watcher 节拍（v1 3s 平移） */
  tickMs: number;
  /** merge_review diff 存 gate payload 的上限 */
  diffMaxChars: number;
  /** 同模块智能合并开关：调度前把同模块 pending 交 LLM 判归并（默认开） */
  autoMerge: boolean;
  /**
   * 执行结果总结：进入 done/blocked 后、接力之前，向该 issue 的 CC 会话注入总结 prompt
   * 并轮询文件哨兵的总超时（0 = 关闭总结）。等待会占住当次 applyEvent 调用链（含 tick）——
   * 必须在接力前完成（下一条 issue 会接管同一 tmux 会话），默认 3 分钟是权衡上限。
   */
  resultSummaryTimeoutMs: number;
  /** 执行结果总结轮询间隔 */
  resultSummaryPollMs: number;
  /** 时钟注入（测试用） */
  now: () => number;
  /** sleep 注入（测试用；与 now 配套做确定性轮询） */
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  // 2026-07-27 提速：生产库统计 292 次 nudge ≈ 14.6h 纯空等。下调到 120/240——
  // 下限由「代理单次工具调用最长静默」定：本仓库全量 bun test 实测 49s、typecheck 30s，
  // 串成一条命令约 90s，故 nudgeSec 不能低于 120，否则会在门禁跑到一半时催办。
  nudgeSec: 120,
  fallbackSec: 240,
  clarifyTimeoutMs: 20 * 60 * 1000,
  clarifyMaxQuestionRounds: 2,
  kickoffMinBootMs: 5000,
  kickoffReadyTimeoutMs: 120_000,
  limitBackoffMs: RATE_LIMIT_BACKOFF_MS,
  sessionStaleMs: 60_000,
  menuStuckMs: 5 * 60 * 1000,
  judgeWindowBytes: 16000,
  judgeTailChars: 4000,
  baseBranch: 'main',
  tickMs: 3000,
  diffMaxChars: 200_000,
  autoMerge: true,
  // 生产 32 次成功总结实测：最快 16s、平均 24s、最慢 60s。90s 覆盖全部观测样本还留 50% 余量，
  // 而超时的那 5 次原本要白等 3 分钟才放行接力。
  resultSummaryTimeoutMs: 90 * 1000,
  resultSummaryPollMs: 4000,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** watch 循环检测到弹窗菜单时的钩子上下文（Wave3 审批管道，web/ws/approvals.ts 消费） */
export interface EngineMenuCtx {
  issue: EngineIssue;
  project: Project;
  session: string;
  sel: SelectionPayload;
  pane: string;
}

export interface EngineDeps {
  db: Database;
  driver: ExecutorDriver;
  convs: EngineConvOps;
  locator: EngineLocator;
  /** Neutral adapter; omitted preserves legacy Issue behavior exactly. */
  executionWorkspaces?: EngineExecutionWorkspaceOps;
  pmFor(project: Project): EnginePm;
  notify: EngineNotifier;
  mutex: KeyedMutex;
  /** 正式模块编排；缺省时保留旧测试/旧库的 module 文本行为。 */
  modulesFor?(project: Project): {
    resolve(input: {
      projectId: number;
      title: string;
      body?: string | null;
      agent: AgentKind;
      moduleId?: number;
      moduleName?: string;
      createdBy?: number | null;
    }): Promise<ProjectModule>;
    recordIssue(
      module: ProjectModule,
      issue: EngineIssue,
      projectIssues: EngineIssue[],
      signal?: AbortSignal,
    ): Promise<void>;
    recordResultSummary?(
      module: ProjectModule,
      issue: EngineIssue,
      summary: string,
    ): Promise<void>;
    /** 模块合并（归档来源前经 repoint 让引擎重指 issues）；缺省 = 旧装配不支持合并。 */
    merge?(input: {
      projectId: number;
      targetId: number;
      sourceIds: number[];
      repoint(target: ProjectModule, sources: ProjectModule[]): void | Promise<void>;
    }): Promise<{ target: ProjectModule; sources: ProjectModule[] }>;
    /** 模块改名（slug 不动，文档同步）；缺省 = 旧装配不支持。 */
    rename?(projectId: number, moduleId: number, displayName: string): Promise<ProjectModule>;
    /** 模块归档（issue 域守卫由引擎先做）；缺省 = 旧装配不支持。 */
    archiveModule?(projectId: number, moduleId: number): Promise<ProjectModule>;
    /** 直接建模块（智能整理 create 动作；slug 已语义化不经分类器）；缺省 = 不支持。 */
    createManual?(input: {
      projectId: number;
      slug: string;
      displayName: string;
      agent: AgentKind;
      createdBy?: number | null;
    }): Promise<ProjectModule>;
    /** 改 slug（文档目录迁移 + 模块行；issues.module 文本列由引擎补齐）；缺省 = 不支持。 */
    renameSlug?(
      projectId: number,
      moduleId: number,
      slug: string,
      displayName?: string,
    ): Promise<ProjectModule>;
    /** 刷新某模块 ISSUES.md 索引（issue 被挪走后来源除名）；缺省 = 不刷。 */
    syncIssueIndex?(module: ProjectModule, projectIssues: EngineIssue[]): Promise<void>;
  };
  config?: Partial<EngineConfig>;
  /**
   * 创建时澄清分析（clarify-runner 包一层，project 供外层按执行机选 Driver）：新建 issue
   * 后后台调用，产出反馈+澄清问题。未配置 → 跳过分析（测试/最小装配向后兼容）。
   */
  clarify?(project: Project, input: EngineClarifyInput): Promise<EngineClarifyResult>;
  /**
   * 模块智能整理分析（organize-runner 包一层，用户手动触发）：org-<pid> 独立会话扫全部
   * issue + 代码库出整理方案。未配置 → organizeModules 拒绝（测试/最小装配向后兼容）。
   */
  organize?(project: Project, input: EngineOrganizeInput): Promise<EngineOrganizeResult>;
  /**
   * Wave3 审批管道钩子：活跃驱动会话每 tick 检测到弹窗菜单时回调（同一菜单会重复回调，
   * 去重/分级/注入在外层做）。同步签名，异常由引擎捕获落事件。
   */
  onMenu?(ctx: EngineMenuCtx): void;
  /** 菜单从「有」变「无」时回调一次（审批管道据此重置去重签名——v1 agent.ts:621 语义） */
  onMenuGone?(session: string): void;
  /**
   * Wave3 进度管道钩子：watch tail 出新消息时回调（复用引擎 tail，外层严禁再 tail 同一
   * 文件）。同步签名，异常由引擎捕获落事件。
   */
  onConvMessages?(issue: EngineIssue, project: Project, msgs: ChatMessage[]): void;
}

export interface WatchState {
  offset: number;
  fedTs: number;
  activityTs: number;
  nudged: boolean;
  waitUntil: number;
  bootTs: number;
  doneChecked: number;
  kickInFlight: boolean;
  menuSince: number;
  menuNotified: boolean;
  /** I2：门禁跳过（对话被切走）已记事件+通知过；恢复为当前对话后重置 */
  displacedNotified: boolean;
  /** 绑定 jsonl 最近一次字节增长时刻（会话失效判定：growTs < fedTs 即注入后零增长） */
  growTs: number;
  /** 最近一次 reclaim 尝试时刻（失败冷却，防每 tick 轰炸重扫） */
  reclaimAt: number;
  /** 最近一次对 codex 升级弹窗自动选「升级」的时刻（冷却防重复把 '1' 打进 composer） */
  codexUpdateAt: number;
  /** 最近一次死会话重建尝试时刻（issue #88 会话自愈；冷却防 3s tick 打转刷错） */
  recoverAt: number;
  /** 最近一次「窗格里只剩 shell」的重启尝试时刻（issue #97；冷却防连环 kill） */
  agentDownAt: number;
  /**
   * 连续重启次数（issue #97）。**必须跨 resetWatch 传递**——重启内部就会 resetWatch，
   * 存在新 watch 里等于每次都从 0 开始，登录过期这类起不来的故障会无限重启。
   * 一旦观测到代理真的活着即清零。
   */
  agentRestarts: number;
  /**
   * 重启后待接续（issue #97）：等代理**真就绪**再补一次催办让它接着干，
   * 不在 kill+起新的那一瞬间盲注（那会儿窗格里还是 bash / 代理还没画出输入框）。
   */
  resumePending: boolean;
}

export type ApplyResult =
  | { ok: true; from: IssueState; to: IssueState }
  | { ok: false; error: string };

/** I5：在途 tick 超过该时长未归还即告警（不重置——强行重入会造成双驾驶员） */
export const TICK_STUCK_WARN_MS = 5 * 60 * 1000;

/** 会话自愈重建的尝试间隔（issue #88）：重建失败后冷却，期间不驱动死会话 */
export const SESSION_RECOVER_COOLDOWN_MS = 60_000;

/**
 * 「代理退回 shell」后的强制重启间隔（issue #97）。
 * 必须显著大于代理冷启动时间：刚 kill+新起的那一两秒里前台命令还可能是 bash，
 * 冷却太短会把自己刚起的进程再 kill 一遍，连环重启永远起不来。
 */
export const AGENT_RESTART_COOLDOWN_MS = 60_000;

/**
 * 连续自动重启的次数上限（issue #97）：还是起不来就交人工（block + 通知）。
 * 这类故障多半是登录过期、CLI 装坏、cwd 没了——再重启一百次也一样，继续重试只会
 * 让 issue 静默烂在那里。
 */
export const MAX_AGENT_RESTARTS = 3;

interface ProjectTickFlight {
  issueId: number;
  since: number;
  stuckWarned: boolean;
  promise: Promise<void>;
}

export class IssueEngine {
  readonly store: IssueStore;
  private readonly cfg: EngineConfig;
  /** Engine-local prepare capability; a structurally identical or foreign-engine batch is untrusted. */
  private readonly preparedDesignBatches = new WeakSet<object>();
  private readonly workflowScheduler: WorkflowScheduler;
  private readonly watch = new Map<string, WatchState>();
  /** 同 issue 状态迁移尾队列；首项同步启动，后续项严格等待前项完成。 */
  private readonly issueTransitionTails = new Map<number, Promise<void>>();
  /** 项目启动最小 reservation：只覆盖空闲检查/绑会话到 pending→planning commit。 */
  private readonly startingProjects = new Set<number>();
  /** reservation 等待信号；并发 start 等前一个 commit 后重读 busy 状态。 */
  private readonly startingProjectWaits = new Map<number, Promise<void>>();
  /** 每项目独立 tick flight：同项目单飞，慢项目不阻塞其他项目。 */
  private readonly tickFlights = new Map<number, ProjectTickFlight>();
  /** stop() 先关闭入口；start() 可在停机完成后重新开启。构造后默认允许手动 tick。 */
  private acceptingTicks = true;
  /** 停机在途期间拒绝 start；重复 stop 复用同一个等待链。 */
  private stopPromise: Promise<void> | null = null;
  /**
   * 调度单飞（每项目）：scheduleNext 里的合并会 cancel 掉被并入的 pending，其 onEnter
   * 又会触发接力 scheduleNext——用它挡掉嵌套重入，避免合并中途把 host 抢跑/递归判合并。
   */
  private readonly scheduling = new Set<number>();
  /** 创建时澄清的每项目串行链（单飞限流）：projectId → 链尾 promise */
  private readonly clarifyChain = new Map<number, Promise<void>>();
  /** start() 触发的一次性悬空澄清恢复（重启把内存态分析链杀掉后的补救）；waitClarify 先等它 */
  private clarifyRecovery: Promise<void> | null = null;
  /** 模块智能整理的在途分析（每项目单飞，手动触发）：projectId → 后台 promise */
  private readonly organizing = new Map<number, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: EngineDeps) {
    this.store = new IssueStore(deps.db);
    this.cfg = { ...DEFAULT_ENGINE_CONFIG, ...(deps.config ?? {}) };
    const nodes = new WorkflowNodeRunner({
      db: deps.db,
      driver: deps.driver,
      conversations: deps.convs,
      mutex: deps.mutex,
      now: () => this.now(),
    });
    const worktrees = new WorkflowWorktreeManager({
      db: deps.db,
      driver: deps.driver,
      conversations: deps.convs,
      mutex: deps.mutex,
      now: () => this.now(),
      logEvent: (issueId, kind, data) => this.store.logEvent(issueId, kind, data),
    });
    this.workflowScheduler = new WorkflowScheduler({
      db: deps.db,
      nodes,
      worktrees,
      now: () => this.now(),
      logEvent: (issueId, kind, data) =>
        this.store.logEvent(issueId, kind, data as Record<string, unknown> | undefined),
    });
  }

  private get reader(): JsonlReader {
    return this.deps.driver;
  }

  /** 配置的基线分支名（仅作展示 + 老 issue 无 impl_base 时的兜底 diff 范围；引擎不并回它） */
  get baseBranch(): string {
    return this.cfg.baseBranch;
  }

  private now(): number {
    return this.cfg.now();
  }

  private project(id: number): Project | undefined {
    return getProject(this.deps.db, id);
  }

  // ---- 生命周期 ----

  start(): void {
    if (this.timer || this.stopPromise) return;
    this.acceptingTicks = true;
    // 一次性恢复被重启打断的创建时澄清（分析链是内存态，重启即蒸发只留悬空事件）
    this.clarifyRecovery ??= this.recoverClarify().catch(() => {});
    this.timer = setInterval(() => void this.tick(), this.cfg.tickMs);
  }

  /** M1：停节拍、关闭新 tick 入口并等所有项目 flight 归还，之后调用方才能 close driver/db。 */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.acceptingTicks = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pending = Promise.allSettled([...this.tickFlights.values()].map((flight) => flight.promise)).then(
      () => {
        if (this.stopPromise === pending) this.stopPromise = null;
      },
    );
    this.stopPromise = pending;
    await pending;
  }

  // ---- 对外 API ----

  /**
   * 建 issue + （项目空闲时）自动开跑接力 + （仍在排队时）后台创建时澄清分析。
   * onCreatedInTransaction 供外部 issue 导入等需要“本地 issue + 去重记录”原子落库的入口使用；
   * 回调抛错会连同 issues 行和 created 事件一起回滚，提交后才继续模块文档与调度副作用。
   */
  async createIssue(
    projectId: number,
    input: IssueInput,
    autoStart = true,
    onCreatedInTransaction?: (issue: EngineIssue) => void,
  ): Promise<EngineIssue> {
    const proj = this.project(projectId);
    if (!proj) throw new Error(`项目 ${projectId} 不存在`);
    if (proj.kind === 'chat') throw new Error('对话模式项目不支持创建 issue');
    const workflows = new WorkflowTemplateStore(this.deps.db, () => this.now());
    let selectedWorkflow: WorkflowTemplateDetail | null = null;
    if (input.workflowTemplateId !== undefined) {
      const detail = workflows.get(projectId, input.workflowTemplateId);
      if (!detail) {
        throw new IssueWorkflowSelectionError('not_found', 'The selected workflow template does not exist in this project.');
      }
      if (detail.template.status !== 'active') {
        throw new IssueWorkflowSelectionError('inactive', 'The selected workflow template is archived.');
      }
      const supportedAgents = (['claude', 'codex'] as const).filter(
        (agent) => projectAgentSupport(this.deps.db, projectId, agent).ok,
      );
      const validation = validateWorkflowGraph(detail.version.graph, supportedAgents);
      if (!validation.ok) {
        const unavailable = validation.issues.some((issue) => issue.code === 'workflow.agent_unavailable');
        throw new IssueWorkflowSelectionError(
          unavailable ? 'agent_unavailable' : 'graph_invalid',
          unavailable ? 'The workflow requires an Agent that is unavailable on this executor.' : 'The selected workflow template has an invalid graph.',
          validation.issues,
        );
      }
      selectedWorkflow = detail;
    }
    const modules = this.deps.modulesFor?.(proj);
    const resolved = modules
      ? await modules.resolve({
          projectId,
          title: input.title,
          body: input.body,
          agent: input.agent === 'codex' ? 'codex' : 'claude',
          ...(input.moduleId !== undefined ? { moduleId: input.moduleId } : {}),
          ...((input.moduleName ?? input.module) ? { moduleName: input.moduleName ?? input.module } : {}),
          createdBy: input.createdBy,
        })
      : null;
    const create = (): EngineIssue => {
      const issue = this.store.create(projectId, {
        ...input,
        ...(resolved
          ? { module: resolved.slug, moduleId: resolved.id, agent: resolved.agent }
          : {}),
      });
      if (selectedWorkflow) {
        const context: IssueWorkflowSharedContext = {
          schemaVersion: 1,
          issue: {
            id: issue.id,
            title: issue.title,
            body: issue.body,
            category: issue.category,
            createdTs: issue.createdTs,
          },
          project: {
            id: proj.id,
            name: proj.name,
            goal: proj.goal,
            readmeSummary: proj.readmeSummary,
            understanding: proj.understanding,
            understandingAgent: proj.understandingAgent,
            understandingTs: proj.understandingTs,
          },
          module: resolved
            ? {
                id: resolved.id,
                slug: resolved.slug,
                displayName: resolved.displayName,
                agent: resolved.agent,
              }
            : null,
          documents: resolved
            ? {
                module: `.panda/modules/${resolved.slug}/MODULE.md`,
                issueProcess: moduleIssueRelPath(resolved.slug, issue.id, issue.title),
              }
            : { module: null, issueProcess: null },
        };
        workflows.attachIssue(issue.id, selectedWorkflow, context);
      }
      onCreatedInTransaction?.(issue);
      return issue;
    };
    const issue = selectedWorkflow || onCreatedInTransaction
      ? this.deps.db.transaction(create)()
      : create();
    if (resolved && modules) {
      await modules.recordIssue(resolved, issue, this.store.listByProject(projectId));
    }
    if (autoStart) await this.scheduleNext(projectId, moduleKeyOf(issue));
    this.scheduleClarify(issue.id); // 建即开跑（项目空闲）的不分析——规划阶段自会对齐
    return this.store.get(issue.id)!;
  }

  /**
   * Publication prepare phase: resolve no modules and write nothing. Explicit module ids are read
   * from the authoritative Issue-domain table; unclassified nodes remain deliberately unclassified.
   */
  async prepareDesignBatch(
    projectId: number,
    drafts: readonly DesignIssueDraft[],
  ): Promise<PreparedDesignBatch> {
    const project = this.requirePublicationProject(projectId);
    if (!Array.isArray(drafts) || drafts.length === 0 || drafts.length > MAX_PUBLICATION_BATCH) {
      throw new Error(`publication batch must contain 1-${MAX_PUBLICATION_BATCH} nodes`);
    }
    const seen = new Set<string>();
    const prepared: PreparedDesignIssue[] = [];
    for (const draft of drafts) {
      const nodeId = draft.nodeId?.trim();
      if (!nodeId || nodeId.length > 120 || seen.has(nodeId)) {
        throw new Error('publication node ids must be unique non-empty strings');
      }
      seen.add(nodeId);
      prepared.push(this.validatePublicationDraft(project, { ...draft, nodeId }));
    }
    const batch = Object.freeze({
      [PREPARED_DESIGN_BATCH_BRAND]: true as const,
      projectId,
      drafts: Object.freeze(prepared.map((draft) => Object.freeze({ ...draft }))),
    });
    this.preparedDesignBatches.add(batch);
    return batch;
  }

  /**
   * Publication commit phase. All issue rows/events, generic dependencies, and the caller-owned
   * linkage callback share this one synchronous SQLite transaction. No clarify, module docs,
   * conversation activation, or scheduler call is reachable from this method.
   */
  commitPreparedDesignBatch<Result>(
    prepared: PreparedDesignBatch,
    dependencies: readonly PreparedIssueDependency[],
    onCreatedInTransaction: (
      issuesByNodeId: ReadonlyMap<string, EngineIssue>,
    ) => SynchronousCallbackResult<Result>,
  ): readonly EngineIssue[] {
    if (!this.preparedDesignBatches.has(prepared as object)) {
      throw new Error('prepared publication batch belongs to a different IssueEngine');
    }
    if (typeof onCreatedInTransaction !== 'function') throw new Error('publication linkage callback is required');
    if (isDeclaredAsyncFunction(onCreatedInTransaction)) {
      throw new Error('publication linkage callback must be synchronous');
    }
    // Pure graph validation intentionally precedes the transaction and its first INSERT. The Issue
    // domain never trusts a designs caller to have supplied a DAG.
    const validatedDependencies = validatePreparedDependencies(prepared, dependencies);
    const commit = this.deps.db.transaction(() => {
      const project = this.requirePublicationProject(prepared.projectId);
      const revalidated = prepared.drafts.map((draft) => this.validatePublicationDraft(project, draft));
      const byNode = new Map<string, EngineIssue>();
      for (const draft of revalidated) byNode.set(draft.nodeId, this.store.createPublished(project.id, draft));

      for (const dependency of validatedDependencies) {
        const predecessor = byNode.get(dependency.fromNodeId)!;
        const dependent = byNode.get(dependency.toNodeId)!;
        this.store.addDependency(dependent.id, predecessor.id, 'blocks');
      }
      const callbackResult = onCreatedInTransaction(byNode);
      if (isThenable(callbackResult)) {
        throw new Error('publication linkage callback must be synchronous');
      }
      return Object.freeze(revalidated.map((draft) => byNode.get(draft.nodeId)!));
    });
    return commit();
  }

  /**
   * Retryable post-commit drain surface for the caller-owned publication outbox. Effects are
   * idempotent: module pages are rewritten through ModuleManager and scheduleNext is a guarded kick.
   * Committed issues are never compensated/deleted when an effect fails.
   */
  async completeDesignBatch(
    projectId: number,
    issueIds: readonly number[],
    outbox?: IssuePublicationPostCommitOutboxPort,
    signal?: AbortSignal,
  ): Promise<void> {
    const project = this.requirePublicationProject(projectId);
    const uniqueIds = [...new Set(issueIds)];
    if (uniqueIds.length !== issueIds.length || uniqueIds.length === 0 || uniqueIds.length > MAX_PUBLICATION_BATCH) {
      throw new Error('invalid publication issue ids');
    }
    const issues = uniqueIds.map((id) => {
      const issue = this.store.get(id);
      if (!issue || issue.projectId !== projectId || !issue.publicationLocked) {
        throw new Error('publication issue scope mismatch');
      }
      return issue;
    });
    const failures: string[] = [];
    const requireActive = (): void => {
      if (signal?.aborted) throw new Error('publication post-commit drain aborted');
    };
    const batchIssueIds = Object.freeze([...uniqueIds].sort((a, b) => a - b));
    const perform = async (
      operation: IssuePublicationPostCommitOperation,
      effect: () => void | Promise<void>,
    ): Promise<void> => {
      requireActive();
      if (outbox) {
        try {
          if (await outbox.isComplete(operation)) return;
        } catch (error) {
          failures.push(`${operation.kind} outbox read: ${String(error).slice(0, 240)}`);
          return;
        }
      }
      try {
        await effect();
        requireActive();
        await outbox?.markComplete(operation);
      } catch (error) {
        const detail = String(error).slice(0, 240);
        failures.push(`${operation.kind}${operation.issueId === null ? '' : ` issue ${operation.issueId}`}: ${detail}`);
        if (outbox) {
          try {
            await outbox.markRetry(operation, detail);
          } catch (outboxError) {
            failures.push(`${operation.kind} outbox retry: ${String(outboxError).slice(0, 240)}`);
          }
        }
      }
    };
    const durableOperations = outbox?.listOperations ? await outbox.listOperations() : null;
    const legacyModules = durableOperations === null ? this.deps.modulesFor?.(project) : undefined;
    const operations: readonly IssuePublicationPostCommitOperation[] = durableOperations ?? [
      ...(legacyModules
        ? issues.flatMap((issue): IssuePublicationPostCommitOperation[] => issue.moduleId === null ? [] : [{
        key: `issue-publication:${projectId}:module-doc:${issue.id}`,
        kind: 'module-doc',
        projectId,
        issueId: issue.id,
        issueIds: batchIssueIds,
        moduleId: issue.moduleId,
        agent: issue.agent,
          }])
        : []),
      {
        key: `issue-publication:${projectId}:scheduler:${batchIssueIds.join(',')}`,
        kind: 'scheduler',
        projectId,
        issueId: null,
        issueIds: batchIssueIds,
      },
    ];
    for (const operation of operations) {
      if (operation.projectId !== projectId || operation.issueIds.some((id) => !uniqueIds.includes(id))) {
        throw new Error('publication outbox operation scope mismatch');
      }
      if (operation.kind === 'module-doc') {
        if (operation.issueId === null || !uniqueIds.includes(operation.issueId)
          || !Number.isSafeInteger(operation.moduleId) || operation.moduleId! <= 0
          || (operation.agent !== 'claude' && operation.agent !== 'codex')) {
          throw new Error('invalid durable module-doc operation');
        }
        await perform(operation, async () => {
          // Durable operations are authoritative and must remain retryable even when the module
          // subsystem is temporarily unavailable. The legacy no-outbox path keeps its historical
          // best-effort behaviour by deriving module operations only when that subsystem exists.
          const modules = durableOperations === null ? legacyModules : this.deps.modulesFor?.(project);
          if (!modules) throw new Error('module system unavailable');
          const issue = this.store.get(operation.issueId!);
          if (!issue || issue.projectId !== projectId || !issue.publicationLocked) {
            throw new Error('publication Issue disappeared');
          }
          const module = getPublicationModule(this.deps.db, operation.moduleId!);
          if (!module || module.projectId !== projectId) throw new Error('module scope changed');
          if (module.status !== 'active' || module.syncStatus !== 'ready' || module.agent !== operation.agent) {
            throw new Error('module governance changed');
          }
          await modules.recordIssue(module, issue, this.store.listByProject(projectId), signal);
        });
      } else {
        await perform(operation, async () => {
          requireActive();
          await this.scheduleNext(projectId);
          requireActive();
        });
      }
    }
    if (failures.length > 0) throw new IssuePublicationPostCommitError(failures);
  }

  requestExecutionSync(issueId: number, input: IssueExecutionSyncRequest): IssueExecutionSync {
    return this.store.requestExecutionSync(issueId, input);
  }

  getDesignSyncSnapshot(issueId: number): IssueDesignSyncSnapshot | null {
    return this.store.designSyncSnapshot(issueId);
  }

  updateFromDesign<Result>(
    input: IssueDesignSyncUpdate,
    afterUpdate: (updated: IssueDesignSyncSnapshot) => SynchronousCallbackResult<Result>,
  ): Result {
    return this.store.updateFromDesignInTransaction(input, afterUpdate);
  }

  requestLatestExecutionSync(issueId: number, input: IssueExecutionSyncRequest): IssueExecutionSync {
    return this.store.requestLatestExecutionSync(issueId, input);
  }

  latestExecutionSync(issueId: number, sourceKind: string, sourceKey: string): IssueExecutionSync | null {
    return this.store.latestExecutionSync(issueId, sourceKind, sourceKey);
  }

  getExecutionSync(syncId: number): IssueExecutionSync | null {
    return this.store.getExecutionSync(syncId) ?? null;
  }

  hasExecutionSyncBoundary(issueId: number): boolean {
    return this.store.activeExecutionSyncBoundary(issueId) !== null;
  }

  holdExecutionSyncBoundary(
    issueId: number,
    boundaryKind: string,
    deferredAction: unknown,
  ): IssueExecutionSync | null {
    return this.store.holdExecutionSyncBoundary(issueId, boundaryKind, deferredAction);
  }

  decideExecutionSync(
    syncId: number,
    decision: IssueExecutionSyncDecision,
    actor: number,
  ): IssueExecutionSync {
    return this.store.decideExecutionSync(syncId, decision, actor);
  }

  /**
   * Explicit crash recovery for a claim whose owning process has been confirmed dead. Both the
   * stable action key and exact abandoned token are required, so stale recovery observations cannot
   * reset a newer owner. Running claims never expire or become automatically reclaimable.
   */
  resetAbandonedExecutionSyncResume(syncId: number, resumeKey: string, abandonedToken: string): boolean {
    return this.store.resetAbandonedExecutionSyncResume(syncId, resumeKey, abandonedToken);
  }

  /**
   * Atomically apply one synchronous database effect, persist its stable-key receipt, and complete
   * the claim. External I/O must be represented through context.enqueueExternalEffect(). A crash
   * cannot occur between committing the DB effect and receipt; duplicates return the stored result.
   */
  resumeExecutionSync<T>(
    syncId: number,
    resume: (
      deferredAction: unknown,
      sync: IssueExecutionSync,
      context: IssueExecutionSyncEffectContext,
    ) => SynchronousCallbackResult<T>,
  ): { resumed: boolean; result?: T } {
    if (isDeclaredAsyncFunction(resume)) {
      throw new Error('execution sync effect callback must be synchronous');
    }
    const prior = this.store.getExecutionSyncEffectReceipt(syncId);
    if (prior) return { resumed: false, result: prior.result as T };
    const claimed = this.store.claimExecutionSyncResume(syncId, this.now());
    if (!claimed) {
      const reconciled = this.store.getExecutionSyncEffectReceipt(syncId);
      return reconciled
        ? { resumed: false, result: reconciled.result as T }
        : { resumed: false };
    }
    const token = claimed.resumeToken!;
    let action: unknown;
    try {
      action = JSON.parse(claimed.deferredActionJson!);
    } catch {
      this.store.releaseExecutionSyncResume(syncId, token);
      throw new Error('malformed deferred execution action');
    }
    try {
      const committed = this.store.commitExecutionSyncEffect(
        syncId,
        token,
        (sync, context) => resume(action, sync, context),
      );
      return { resumed: committed.applied, result: committed.result };
    } catch (error) {
      this.store.releaseExecutionSyncResume(syncId, token);
      throw error;
    }
  }

  recoverExecutionSyncs<Result>(
    resume: (
      deferredAction: unknown,
      sync: IssueExecutionSync,
      context: IssueExecutionSyncEffectContext,
    ) => SynchronousCallbackResult<Result>,
    limit = 100,
  ): { examined: number; resumed: number } {
    if (isDeclaredAsyncFunction(resume)) {
      throw new Error('execution sync effect callback must be synchronous');
    }
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.store.listResumableExecutionSyncs(bounded);
    let resumed = 0;
    for (const row of rows) {
      const result = this.resumeExecutionSync(row.id, resume);
      if (result.resumed) resumed++;
    }
    return { examined: rows.length, resumed };
  }

  async drainExecutionSyncEffectOutbox(
    limit = 100,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ examined: number; delivered: number }> {
    if (options.signal?.aborted) return { examined: 0, delivered: 0 };
    // Startup and timers may claim only pending effects. A dispatching/uncertain row is an
    // explicit crash boundary and remains owner-resolved even when a partial step receipt exists.
    const rows = this.store.listExecutionSyncEffectOutbox(limit);
    let delivered = 0;
    let examined = 0;
    for (const row of rows) {
      if (options.signal?.aborted) break;
      const claimed = this.store.claimExecutionSyncEffectDelivery(row.resumeKey, row.intentKey, this.now());
      if (!claimed?.deliveryToken) continue;
      examined++;
      try {
        if (claimed.kind !== 'issue-sync-boundary') {
          throw new Error(`unsupported execution sync effect: ${claimed.kind}`);
        }
        const payload = claimed.payload as {
          issueId?: unknown;
          action?: {
            kind?: unknown; event?: unknown; options?: unknown; nextIndex?: unknown;
            from?: unknown; to?: unknown;
          };
        };
        if (!Number.isSafeInteger(payload.issueId) || typeof payload.action !== 'object' || payload.action === null) {
          throw new Error('malformed execution sync boundary effect');
        }
        const issueId = payload.issueId as number;
        if (payload.action.kind === 'issue-event') {
          const event = payload.action.event as IssueMachineEvent;
          const actionOptions = (payload.action.options ?? {}) as { note?: string; failCount?: number; actor?: number };
          const result = await this.applyEvent(issueId, event, actionOptions);
          if (options.signal?.aborted) break;
          if (!result.ok) throw new Error(result.error);
        } else if (payload.action.kind === 'inject_subtask') {
          const nextIndex = payload.action.nextIndex;
          const issue = this.store.get(issueId);
          const project = issue ? this.project(issue.projectId) : undefined;
          if (!issue || !project || issue.status !== 'implementing' || issue.implMode !== 'seq'
            || issue.subIndex !== nextIndex || !Number.isSafeInteger(nextIndex)) {
            throw new Error('stale deferred subtask injection');
          }
          if (!issue.convId) throw new Error('deferred subtask issue has no conversation');
          const subtasks = this.store.subtasksOf(issue).map((subtask) => subtask.text);
          if (!subtasks[nextIndex as number]) throw new Error('deferred subtask no longer exists');
          const session = this.deps.convs.tmuxName(issue.projectId, issue.convId);
          await this.inject(session, buildSubtaskPrompt({
            issue,
            subtasks,
            idx: nextIndex as number,
            branch: issue.branch ?? `issue/${issue.id}`,
            locale: this.promptLocale(issue, project),
            resumeKey: `${claimed.resumeKey}:${claimed.intentKey}`,
          }));
          if (options.signal?.aborted) break;
          this.store.logEvent(issueId, 'injected', {
            stage: 'implementing', kind: 'subtask', idx: nextIndex,
            resumeKey: claimed.resumeKey, intentKey: claimed.intentKey,
          });
        } else if (payload.action.kind === 'resume_entry') {
          const issue = this.store.get(issueId);
          if (!issue || issue.status !== payload.action.to) throw new Error('stale deferred entry action');
          await this.onEnter(issueId, payload.action.from as IssueState, payload.action.to as IssueState);
          if (options.signal?.aborted) break;
        } else if (payload.action.kind !== 'safe_state') {
          throw new Error('unknown deferred execution sync action');
        }
        if (!this.store.recordExecutionSyncEffectStep(
          claimed.resumeKey,
          claimed.intentKey,
          claimed.deliveryToken,
          'action-complete',
          { issueId, actionKind: payload.action.kind },
        )) throw new Error('execution sync delivery claim lost before action receipt');
        if (this.store.markExecutionSyncEffectDelivered(
          claimed.resumeKey,
          claimed.intentKey,
          claimed.deliveryToken,
        )) delivered++;
      } catch (error) {
        if (options.signal?.aborted) break;
        this.store.markExecutionSyncEffectUncertain(
          claimed.resumeKey,
          claimed.intentKey,
          claimed.deliveryToken,
          String(error),
        );
      }
    }
    return { examined, delivered };
  }

  listUncertainExecutionSyncEffects(limit = 100): IssueExecutionSyncEffectOutboxItem[] {
    return this.store.listUncertainExecutionSyncEffects(limit);
  }

  getUncertainExecutionSyncEffect(syncId: number): IssueExecutionSyncEffectOutboxItem | null {
    return this.store.getUncertainExecutionSyncEffect(syncId);
  }

  resolveUncertainExecutionSyncEffect(
    resumeKey: string,
    intentKey: string,
    resolution: 'confirm_delivered' | 'retry',
  ): boolean {
    return this.store.resolveUncertainExecutionSyncEffect(resumeKey, intentKey, resolution);
  }

  hasUnresolvedExecutionSyncEffect(issueId: number): boolean {
    return this.store.hasUnresolvedExecutionSyncEffect(issueId);
  }

  private requirePublicationProject(projectId: number): Project {
    const project = this.project(projectId);
    if (!project) throw new Error(`project ${projectId} does not exist`);
    if (project.kind !== 'issue') throw new Error('chat project cannot publish issues');
    if (project.status !== 'active') throw new Error('archived project cannot publish issues');
    return project;
  }

  private validatePublicationDraft(project: Project, input: DesignIssueDraft): PreparedDesignIssue {
    const nodeId = input.nodeId.trim();
    const title = input.title.trim();
    if (!nodeId || nodeId.length > 120) throw new Error('invalid publication node id');
    if (!title || title.length > 200) throw new Error('publication title must contain 1-200 characters');
    if (typeof input.body !== 'string' || input.body.length === 0 || input.body.length > MAX_PUBLICATION_BODY) {
      throw new Error(`publication body must contain 1-${MAX_PUBLICATION_BODY} characters`);
    }
    if (input.implMode !== 'direct' && input.implMode !== 'team') throw new Error('invalid publication mode');
    if (input.agent !== 'claude' && input.agent !== 'codex') throw new Error('invalid publication agent');
    const suppliedCategory = (input as DesignIssueDraft & { category?: unknown }).category;
    if (suppliedCategory !== undefined && suppliedCategory !== 'task') {
      throw new Error('published graph nodes must be ordinary task issues');
    }
    const support = projectAgentSupport(this.deps.db, project.id, input.agent);
    if (!support.ok) throw new Error(support.error);
    let moduleSlug = 'unclassified';
    if (input.moduleId !== null) {
      if (!Number.isSafeInteger(input.moduleId) || input.moduleId <= 0) throw new Error('invalid publication module id');
      const module = getPublicationModule(this.deps.db, input.moduleId);
      if (!module || module.projectId !== project.id) throw new Error('publication module is outside project scope');
      if (module.status !== 'active') throw new Error('publication module is archived, not active');
      if (module.syncStatus !== 'ready') throw new Error('publication module docs are not ready for sync');
      if (module.agent !== input.agent) throw new Error('publication module Agent does not match node agent');
      moduleSlug = module.slug;
    }
    return {
      ...input,
      nodeId,
      title,
      moduleSlug,
    };
  }

  workflowSnapshot(issueId: number): IssueWorkflowSnapshot | null {
    return new WorkflowTemplateStore(this.deps.db, () => this.now()).issueWorkflow(issueId);
  }

  workflowRuntime(issueId: number): IssueWorkflowRuntime | null {
    return new WorkflowTemplateStore(this.deps.db, () => this.now()).issueWorkflowRuntime(issueId);
  }

  /** 只有 pending 可以换正式模块；模块固定代理，因此换绑时代理随模块原子更新。 */
  async changePendingModule(
    issueId: number,
    selection: PendingModuleSelection,
  ): Promise<EngineIssue> {
    return this.updatePendingMeta(issueId, {}, selection);
  }

  /**
   * 内容元数据的最终写入口：在自动合并落地锁内重读状态；Git 意图再用 DB CAS 同条更新。
   * 路由在 readBody / 模块解析等 await 后必须走这里，不能拿旧 EngineIssue 直接 patchMeta。
   *
   * 名字里的 Pending 是历史遗留——可编辑范围以 EDITABLE_STATES 为准，
   * 判据一律走 isEditableStatus，别照着方法名想当然。
   */
  async updatePendingMeta(
    issueId: number,
    meta: IssueMetaPatch,
    moduleSelection?: PendingModuleSelection,
  ): Promise<EngineIssue> {
    const initial = this.store.get(issueId);
    if (!initial) throw new Error('issue 不存在');
    if (initial.publicationLocked) {
      throw new Error('设计发布的 Issue 只能通过 revision-aware sync 修改 contract 字段');
    }
    if (!isEditableStatus(initial.status)) {
      throw new Error(`只有待办、受阻或已取消的 issue 可以修改（当前 ${initial.status}）`);
    }
    const project = this.project(initial.projectId);
    if (!project) throw new Error('项目不存在');
    const modules = moduleSelection ? this.deps.modulesFor?.(project) : undefined;
    const resolved =
      moduleSelection && modules
        ? await modules.resolve({
            projectId: initial.projectId,
            title: initial.title,
            body: initial.body,
            agent: moduleSelection.requestedAgent ?? initial.agent,
            ...(moduleSelection.moduleId !== undefined ? { moduleId: moduleSelection.moduleId } : {}),
            ...(moduleSelection.moduleName ? { moduleName: moduleSelection.moduleName } : {}),
            createdBy: initial.createdBy,
          })
        : null;
    if (moduleSelection && !modules && !moduleSelection.moduleName?.trim()) {
      throw new Error('模块系统未启用');
    }

    const updated = await this.deps.mutex.runExclusive(issueMetaLockKey(initial.projectId), () => {
      const fresh = this.store.get(issueId);
      if (!fresh || !isEditableStatus(fresh.status)) {
        throw new Error(`只有待办、受阻或已取消的 issue 可以修改（当前 ${fresh?.status ?? 'missing'}）`);
      }
      if (fresh.publicationLocked) {
        throw new Error('设计发布的 Issue 只能通过 revision-aware sync 修改 contract 字段');
      }
      const requestedAgent = moduleSelection?.requestedAgent ?? meta.agent;
      if (requestedAgent && requestedAgent !== fresh.agent && fresh.convId) {
        throw new Error('已绑对话的 issue 不能换执行代理');
      }
      if (!moduleSelection && meta.agent && meta.agent !== fresh.agent && fresh.moduleId) {
        throw new Error('模块已固定执行代理；请修改模块而不是单独修改代理');
      }

      const combined: IssueMetaPatch = {
        ...meta,
        ...(resolved
          ? { module: resolved.slug, moduleId: resolved.id, agent: resolved.agent }
          : moduleSelection
            ? {
                module: moduleSelection.moduleName!,
                ...(moduleSelection.requestedAgent ? { agent: moduleSelection.requestedAgent } : {}),
              }
            : {}),
      };
      const { targetBranch, sourceRef, ...rest } = combined;
      const finalTarget = targetBranch !== undefined ? targetBranch : fresh.targetBranch;
      const requestedSource = sourceRef !== undefined ? sourceRef : fresh.sourceRef;
      if (targetBranch === undefined && finalTarget === null && requestedSource !== null) {
        throw new Error('设置 sourceRef 前必须先设置 targetBranch');
      }
      const finalSource = finalTarget === null
        ? null
        : requestedSource;
      if (
        (targetBranch !== undefined || sourceRef !== undefined)
        && !this.store.patchPendingGitMeta(issueId, {
          targetBranch: finalTarget,
          sourceRef: finalSource,
        })
      ) {
        const current = this.store.get(issueId);
        throw new Error(`只有待办、受阻或已取消的 issue 可以修改（当前 ${current?.status ?? 'missing'}）`);
      }
      this.store.patchMeta(issueId, rest);
      return this.store.get(issueId)!;
    });

    if (resolved && modules) {
      await modules.recordIssue(resolved, updated, this.store.listByProject(initial.projectId));
      this.store.logEvent(issueId, 'module_changed', {
        fromModuleId: initial.moduleId,
        toModuleId: resolved.id,
        module: resolved.slug,
      });
    }
    return updated;
  }

  /**
   * 修改尚未派发的子任务文本。锁内重读执行游标，防止保存请求排队时任务已推进：
   * - plan_review 尚未派发，所有未完成项可改；
   * - 顺序 implementing 只允许当前游标之后的项；
   * - blocked 允许修订当前受阻项及其后的未完成项，保存不解除受阻；
   * - 并行模式开工即全量派发，其余阶段也不开放修改。
   */
  async updateUnstartedSubtask(
    issueId: number,
    index: number,
    text: string,
    actor?: number,
  ): Promise<UpdateUnstartedSubtaskResult> {
    if (!text.trim()) return { ok: false, reason: 'text_required' };
    if (text.length > MAX_SUBTASK_TEXT_LENGTH) return { ok: false, reason: 'text_too_long' };
    const initial = this.store.get(issueId);
    if (!initial) return { ok: false, reason: 'not_found' };

    return this.deps.mutex.runExclusive(issueMetaLockKey(initial.projectId), () => {
      const fresh = this.store.get(issueId);
      if (!fresh) return { ok: false, reason: 'not_found' };
      const subtasks = this.store.subtasksOf(fresh);
      const subtask = subtasks[index];
      if (!Number.isInteger(index) || index < 0 || !subtask) {
        return { ok: false, reason: 'not_found' };
      }
      const editableBeforeDispatch =
        !subtask.done &&
        (fresh.status === 'plan_review' ||
          (fresh.status === 'blocked' && index >= fresh.subIndex) ||
          (fresh.implMode === 'seq' &&
            fresh.status === 'implementing' &&
            index > fresh.subIndex));
      if (!editableBeforeDispatch) return { ok: false, reason: 'already_dispatched' };

      const updated = { ...subtask, text };
      subtasks[index] = updated;
      this.store.replaceSubtasks(issueId, subtasks, fresh.status === 'plan_review');
      this.store.logEvent(issueId, 'subtask_edited', {
        idx: index,
        ...(actor !== undefined ? { actor } : {}),
      });
      return { ok: true, index, subtask: updated };
    });
  }

  /**
   * 合并模块：来源 issues 全部重指到目标（module 文本列 + module_id 一起改，调度与外键同步），
   * pending 且未绑会话的原子翻成目标模块代理；已绑会话的保持原代理与会话（在途上下文不脚下换）。
   * 来源有执行中 issue 时整体拒绝；来源归档、其会话留档不迁移，文档目录留档不动。
   */
  async mergeModules(
    projectId: number,
    sourceIds: number[],
    targetId: number,
  ): Promise<{ target: ProjectModule; movedIssueIds: number[] }> {
    const project = this.project(projectId);
    if (!project) throw new Error('项目不存在');
    const modules = this.deps.modulesFor?.(project);
    if (!modules?.merge) throw new Error('模块系统未启用');
    const moved: EngineIssue[] = [];
    const { target } = await modules.merge({
      projectId,
      targetId,
      sourceIds,
      repoint: (target, sources) => {
        const srcIds = new Set(sources.map((s) => s.id));
        const issues = this.store
          .listByProject(projectId)
          .filter((i) => i.moduleId !== null && srcIds.has(i.moduleId));
        const driving = issues.filter(
          (i) => !['pending', 'done', 'blocked', 'cancelled'].includes(i.status),
        );
        if (driving.length) {
          throw new Error(`来源模块有执行中 issue：${driving.map((i) => `#${i.id}`).join(' ')}`);
        }
        for (const i of issues) {
          const flipAgent = i.status === 'pending' && !i.convId && i.agent !== target.agent;
          this.store.patchMeta(i.id, {
            module: target.slug,
            moduleId: target.id,
            ...(flipAgent ? { agent: target.agent } : {}),
          });
          this.store.logEvent(i.id, 'module_changed', {
            fromModuleId: i.moduleId,
            toModuleId: target.id,
            module: target.slug,
            via: 'merge',
          });
          moved.push(i);
        }
      },
    });
    // 目标目录补建过程页并刷新目标 ISSUES 索引（来源目录留档不动，索引链接才不悬空）
    for (const i of moved) {
      const fresh = this.store.get(i.id);
      if (fresh) await modules.recordIssue(target, fresh, this.store.listByProject(projectId));
    }
    return { target, movedIssueIds: moved.map((i) => i.id) };
  }

  /** 模块改名（内容校验/文档同步在 ModuleManager；这里只是项目解析 + 端口透传） */
  async renameModule(projectId: number, moduleId: number, displayName: string): Promise<ProjectModule> {
    const project = this.project(projectId);
    if (!project) throw new Error('项目不存在');
    const modules = this.deps.modulesFor?.(project);
    if (!modules?.rename) throw new Error('模块系统未启用');
    return modules.rename(projectId, moduleId, displayName);
  }

  /**
   * 模块归档：还有未完结 issue（非 done/cancelled——pending/blocked 都可能再跑）时拒绝，
   * 请先合并或处理完；通过后由 ModuleManager 落库并同步文档。
   */
  async archiveModule(projectId: number, moduleId: number): Promise<ProjectModule> {
    const project = this.project(projectId);
    if (!project) throw new Error('项目不存在');
    const modules = this.deps.modulesFor?.(project);
    if (!modules?.archiveModule) throw new Error('模块系统未启用');
    const open = this.store
      .listByProject(projectId)
      .filter((i) => i.moduleId === moduleId && !['done', 'cancelled'].includes(i.status));
    if (open.length) {
      throw new Error(`模块还有未完结 issue：${open.map((i) => `#${i.id}`).join(' ')}，请先合并或处理`);
    }
    return modules.archiveModule(projectId, moduleId);
  }

  /** 项目模块画像（含归档行，active 标记）：slug 冲突检查必须全量口径（UNIQUE 约束含归档） */
  private moduleSnapshot(projectId: number): Array<{
    id: number;
    slug: string;
    displayName: string;
    agent: AgentKind;
    source: string;
    active: boolean;
    issueCount: number;
  }> {
    return this.deps.db
      .query<
        {
          id: number;
          slug: string;
          display_name: string;
          agent: string;
          source: string;
          status: string;
          issue_count: number;
        },
        [number]
      >(
        `SELECT pm.id, pm.slug, pm.display_name, pm.agent, pm.source, pm.status,
           (SELECT COUNT(*) FROM issues i WHERE i.module_id = pm.id) AS issue_count
         FROM project_modules pm
         WHERE pm.project_id = ?
         ORDER BY pm.id`,
      )
      .all(projectId)
      .map((r) => ({
        id: r.id,
        slug: r.slug,
        displayName: r.display_name,
        agent: (r.agent === 'codex' ? 'codex' : 'claude') as AgentKind,
        source: r.source,
        active: r.status === 'active',
        issueCount: r.issue_count,
      }));
  }

  /** 项目模块完整行（引擎读侧；写操作全走 modulesFor 端口） */
  private moduleRow(projectId: number, moduleId: number): ProjectModule | null {
    const r = this.deps.db
      .query<
        {
          id: number;
          project_id: number;
          slug: string;
          display_name: string;
          agent: string;
          source: string;
          status: string;
          conversation_id: string | null;
          sync_status: string;
          sync_error: string | null;
          created_by: number | null;
          created_ts: number;
          last_used_ts: number | null;
        },
        [number, number]
      >('SELECT * FROM project_modules WHERE id = ? AND project_id = ?')
      .get(moduleId, projectId);
    if (!r) return null;
    return {
      id: r.id,
      projectId: r.project_id,
      slug: r.slug,
      displayName: r.display_name,
      agent: r.agent === 'codex' ? 'codex' : 'claude',
      source: r.source === 'manual' ? 'manual' : r.source === 'legacy' ? 'legacy' : 'auto',
      status: r.status === 'archived' ? 'archived' : 'active',
      conversationId: r.conversation_id,
      syncStatus: r.sync_status === 'error' ? 'error' : 'ready',
      syncError: r.sync_error,
      createdBy: r.created_by,
      createdTs: r.created_ts,
      lastUsedTs: r.last_used_ts,
    };
  }

  /**
   * 模块智能整理（用户手动触发，可选执行代理）：后台单飞跑 deps.organize（org-<pid> 独立
   * 会话扫全部历史 issue + 代码库），产出方案经 parseOrganizePlan 按当时库内事实确定性清洗
   * 后落 module_organize_suggested 事件（免迁移；锚在项目最新 issue 上）。执行永远走用户
   * 逐项确认（applyOrganizeAction）。分析链是内存态：重启即蒸发，用户重新触发即可。
   */
  organizeModules(projectId: number, agent?: AgentKind, userId?: number): { ok: true } | { ok: false; error: string } {
    if (this.organizing.has(projectId)) return { ok: false, error: '整理分析已在进行中' };
    const project = this.project(projectId);
    if (!project) return { ok: false, error: '项目不存在' };
    const organize = this.deps.organize;
    if (!organize) return { ok: false, error: '整理分析未启用（装配不支持）' };
    if (!this.deps.modulesFor?.(project)) return { ok: false, error: '模块系统未启用' };
    const issues = this.store.listByProject(projectId);
    const anchor = issues[issues.length - 1];
    if (!anchor) return { ok: false, error: '项目还没有 issue，无需整理' };
    const active = this.moduleSnapshot(projectId).filter((m) => m.active);
    if (!active.length) return { ok: false, error: '项目还没有模块' };
    const useAgent: AgentKind = agent === 'codex' ? 'codex' : 'claude';
    this.store.logEvent(anchor.id, 'module_organize_started', {
      agent: useAgent,
      moduleCount: active.length,
      issueCount: issues.length,
    });
    const task = (async () => {
      try {
        const r = await organize(project, {
          projectId,
          cwd: project.cwd,
          agent: useAgent,
          projectName: project.name,
          goal: project.goal,
          locale: userPromptLocale(this.deps.db, userId, project.ownerUserId),
          modules: active.map(({ active: _a, ...m }) => m),
          issues: issues.map((i) => ({
            id: i.id,
            title: i.title,
            body: i.body,
            status: i.status,
            agent: i.agent,
            moduleId: i.moduleId,
          })),
        });
        if (!r.ok) {
          this.store.logEvent(anchor.id, 'module_organize_failed', {
            reason: r.reason,
            ...(r.error ? { error: r.error.slice(0, 200) } : {}),
          });
          return;
        }
        // 清洗按**归来时**的库内事实（分析期间模块/issue 可能已变），失效引用直接丢弃
        const snapshot = this.moduleSnapshot(projectId);
        const fresh = this.store.listByProject(projectId);
        const actions = parseOrganizePlan(r.planText, {
          modules: snapshot.map((m) => ({ id: m.id, slug: m.slug, agent: m.agent, active: m.active })),
          issues: fresh.map((i) => ({ id: i.id, status: i.status, moduleId: i.moduleId })),
        });
        // 快照名称进事件：UI/通知直读，不受后续改名/归档影响
        const nameOf = new Map(snapshot.map((m) => [m.id, m.displayName]));
        const slugOf = new Map(snapshot.map((m) => [m.id, m.slug]));
        const named = actions.map((a) => {
          if (a.kind === 'merge') {
            return {
              ...a,
              targetName: nameOf.get(a.targetId) ?? String(a.targetId),
              sourceNames: a.sourceIds.map((id) => nameOf.get(id) ?? String(id)),
            };
          }
          if (a.kind === 'rename') {
            return {
              ...a,
              moduleName: nameOf.get(a.moduleId) ?? String(a.moduleId),
              fromSlug: slugOf.get(a.moduleId) ?? '',
            };
          }
          if (a.kind === 'move' && 'moduleId' in a.to) {
            return { ...a, toName: nameOf.get(a.to.moduleId) ?? String(a.to.moduleId) };
          }
          return a;
        });
        this.store.logEvent(anchor.id, 'module_organize_suggested', {
          agent: useAgent,
          moduleCount: active.length,
          issueCount: issues.length,
          actions: named,
        });
        if (named.length) {
          await this.notifySafe({
            kind: 'status_change',
            projectId,
            issueId: anchor.id,
            summaryCode: 'module_organization',
            summaryParams: {
              total: named.length,
              merges: named.filter((a) => a.kind === 'merge').length,
              renames: named.filter((a) => a.kind === 'rename').length,
              creates: named.filter((a) => a.kind === 'create').length,
              moves: named.filter((a) => a.kind === 'move').length,
            },
          });
        }
      } catch (e) {
        this.store.logEvent(anchor.id, 'module_organize_failed', {
          reason: 'error',
          error: String(e).slice(0, 200),
        });
      } finally {
        this.organizing.delete(projectId);
      }
    })();
    this.organizing.set(projectId, task);
    return { ok: true };
  }

  /** 测试/停机用：等在途的整理分析归还 */
  async waitOrganize(): Promise<void> {
    await Promise.allSettled([...this.organizing.values()]);
  }

  /**
   * 整理状态（UI 轮询）：running（内存单飞标记）+ 最近一次方案（含逐项 applied 标记）
   * + 比方案更新的失败记录。事件数据即快照——模块被改名/归档后 label 仍可读。
   */
  organizeStatus(projectId: number): {
    running: boolean;
    suggestion: {
      ts: number;
      agent: AgentKind;
      moduleCount: number | null;
      actions: Array<Record<string, unknown> & { applied: boolean }>;
    } | null;
    failed: { ts: number; reason: string; error?: string } | null;
  } {
    const running = this.organizing.has(projectId);
    const ev = this.store.lastProjectEvent(projectId, 'module_organize_suggested');
    let suggestion: ReturnType<IssueEngine['organizeStatus']>['suggestion'] = null;
    if (ev?.dataJson) {
      try {
        const data = JSON.parse(ev.dataJson) as {
          agent?: unknown;
          moduleCount?: unknown;
          actions?: unknown;
        };
        const appliedIdx = new Set(
          this.store
            .listProjectEvents(projectId, 'module_organize_applied')
            .map((e) => {
              try {
                const d = JSON.parse(e.dataJson ?? '{}') as { suggestTs?: unknown; index?: unknown };
                return d.suggestTs === ev.ts ? Number(d.index) : NaN;
              } catch {
                return NaN;
              }
            })
            .filter((n) => Number.isInteger(n)),
        );
        suggestion = {
          ts: ev.ts,
          agent: data.agent === 'codex' ? 'codex' : 'claude',
          moduleCount: typeof data.moduleCount === 'number' ? data.moduleCount : null,
          actions: (Array.isArray(data.actions) ? data.actions : []).map((a, i) => ({
            ...(a as Record<string, unknown>),
            applied: appliedIdx.has(i),
          })),
        };
      } catch {
        suggestion = null;
      }
    }
    const failedEv = this.store.lastProjectEvent(projectId, 'module_organize_failed');
    let failed: ReturnType<IssueEngine['organizeStatus']>['failed'] = null;
    if (failedEv && (!ev || failedEv.ts > ev.ts)) {
      try {
        const d = JSON.parse(failedEv.dataJson ?? '{}') as { reason?: unknown; error?: unknown };
        failed = {
          ts: failedEv.ts,
          reason: typeof d.reason === 'string' ? d.reason : 'error',
          ...(typeof d.error === 'string' ? { error: d.error } : {}),
        };
      } catch {
        failed = { ts: failedEv.ts, reason: 'error' };
      }
    }
    return { running, suggestion, failed };
  }

  /**
   * 执行整理方案中的一项（用户逐项确认；index 对应 module_organize_suggested.actions 下标）。
   * 方案只是建议：这里按**当前**库内事实重新校验（merge 的驱动中拒绝、slug 冲突、模块已归档
   * 等都会在各执行路径抛错），已执行过的项防重放。
   */
  async applyOrganizeAction(
    projectId: number,
    index: number,
    userId?: number,
  ): Promise<{
    ok: true;
    result: { kind: OrganizeAction['kind']; params: Record<string, string | number> };
  } | { ok: false; error: string }> {
    const project = this.project(projectId);
    if (!project) return { ok: false, error: '项目不存在' };
    const modules = this.deps.modulesFor?.(project);
    if (!modules) return { ok: false, error: '模块系统未启用' };
    const ev = this.store.lastProjectEvent(projectId, 'module_organize_suggested');
    if (!ev?.dataJson) return { ok: false, error: '没有可执行的整理方案' };
    let actions: OrganizeAction[];
    try {
      const parsed = JSON.parse(ev.dataJson) as { actions?: unknown };
      actions = (Array.isArray(parsed.actions) ? parsed.actions : []) as OrganizeAction[];
    } catch {
      return { ok: false, error: '整理方案数据损坏' };
    }
    const action = actions[index];
    if (!action) return { ok: false, error: `方案里没有第 ${index} 项` };
    const already = this.store.listProjectEvents(projectId, 'module_organize_applied').some((e) => {
      try {
        const d = JSON.parse(e.dataJson ?? '{}') as { suggestTs?: unknown; index?: unknown };
        return d.suggestTs === ev.ts && Number(d.index) === index;
      } catch {
        return false;
      }
    });
    if (already) return { ok: false, error: '该项已执行过' };

    let result: { kind: OrganizeAction['kind']; params: Record<string, string | number> };
    try {
      if (action.kind === 'create') {
        if (!modules.createManual) throw new Error('装配不支持新建模块');
        const m = await modules.createManual({
          projectId,
          slug: action.slug,
          displayName: action.displayName,
          agent: action.agent,
          createdBy: userId ?? null,
        });
        result = {
          kind: 'create',
          params: { name: m.displayName, slug: m.slug, agent: m.agent },
        };
      } else if (action.kind === 'rename') {
        const updated = await this.renameModuleSlug(
          projectId,
          action.moduleId,
          action.slug,
          action.displayName,
        );
        result = {
          kind: 'rename',
          params: { name: updated.displayName, slug: updated.slug },
        };
      } else if (action.kind === 'merge') {
        const r = await this.mergeModules(projectId, action.sourceIds, action.targetId);
        result = {
          kind: 'merge',
          params: { target: r.target.displayName, count: r.movedIssueIds.length },
        };
      } else if (action.kind === 'move') {
        let targetId: number;
        if ('moduleId' in action.to) {
          targetId = action.to.moduleId;
        } else {
          const slug = action.to.slug;
          const found = this.moduleSnapshot(projectId).find((m) => m.active && m.slug === slug);
          if (!found) throw new Error(`目标模块「${slug}」不存在——请先执行对应的新建模块项`);
          targetId = found.id;
        }
        const r = await this.moveIssuesToModule(projectId, action.issueIds, targetId);
        result = {
          kind: 'move',
          params: { target: r.target.displayName, count: r.movedIssueIds.length },
        };
      } else {
        throw new Error('未知动作类型');
      }
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    }
    this.store.logEvent(ev.issueId, 'module_organize_applied', {
      suggestTs: ev.ts,
      index,
      kind: action.kind,
      ...(userId !== undefined ? { userId } : {}),
    });
    return { ok: true, result };
  }

  /**
   * 改模块 slug（智能整理 rename / 后续手动入口共用）：ModuleManager 收口文档目录迁移 +
   * 模块行；这里补第三处——issues.module 文本列（queue.pickNext 按它调度，漏改即调度错乱），
   * 并逐条刷新 issue 过程页 meta 与 ISSUES.md 索引。全状态 issue 都跟改（历史一致性）。
   */
  async renameModuleSlug(
    projectId: number,
    moduleId: number,
    slug: string,
    displayName?: string,
  ): Promise<ProjectModule> {
    const project = this.project(projectId);
    if (!project) throw new Error('项目不存在');
    const modules = this.deps.modulesFor?.(project);
    if (!modules?.renameSlug) throw new Error('模块系统未启用');
    const before = this.moduleRow(projectId, moduleId);
    const updated = await modules.renameSlug(projectId, moduleId, slug, displayName);
    const all = this.store.listByProject(projectId);
    const mine = all.filter((i) => i.moduleId === moduleId);
    for (const i of mine) this.store.patchMeta(i.id, { module: updated.slug });
    const fresh = this.store.listByProject(projectId);
    for (const i of fresh.filter((x) => x.moduleId === moduleId)) {
      await modules.recordIssue(updated, i, fresh);
    }
    if (mine[0]) {
      this.store.logEvent(mine[0].id, 'module_slug_renamed', {
        moduleId,
        from: before?.slug ?? null,
        to: updated.slug,
        issues: mine.length,
      });
    }
    return updated;
  }

  /**
   * 把若干 issue 挪进另一个模块（智能整理 move 动作）：只收非驱动态
   * （pending/done/blocked/cancelled——已完成的历史 issue 也允许挪，档案跟人走）；
   * 全部校验通过才落库（要么全挪要么不动）。翻代理守恒与 mergeModules 同一条铁律：
   * pending 且未绑会话才随目标模块翻，其余保持原代理（历史事实/在途上下文不动）。
   */
  async moveIssuesToModule(
    projectId: number,
    issueIds: number[],
    targetModuleId: number,
  ): Promise<{ target: ProjectModule; movedIssueIds: number[] }> {
    const project = this.project(projectId);
    if (!project) throw new Error('项目不存在');
    const modules = this.deps.modulesFor?.(project);
    if (!modules) throw new Error('模块系统未启用');
    const target = this.moduleRow(projectId, targetModuleId);
    if (!target || target.status !== 'active') throw new Error('目标模块不存在或已归档');
    if (target.syncStatus !== 'ready') throw new Error(`目标模块文档未就绪：${target.syncError ?? 'unknown'}`);
    const ids = [...new Set(issueIds)];
    const picked: EngineIssue[] = [];
    for (const id of ids) {
      const i = this.store.get(id);
      if (!i || i.projectId !== projectId) throw new Error(`issue #${id} 不存在或不属于本项目`);
      if (!['pending', 'done', 'blocked', 'cancelled'].includes(i.status)) {
        throw new Error(`issue #${id} 正在执行中（${i.status}），不能挪模块`);
      }
      if (i.moduleId === target.id) continue; // 已在目标模块：幂等跳过
      picked.push(i);
    }
    const sourceIds = new Set(
      picked.map((i) => i.moduleId).filter((v): v is number => v !== null && v !== target.id),
    );
    for (const i of picked) {
      const flipAgent = i.status === 'pending' && !i.convId && i.agent !== target.agent;
      this.store.patchMeta(i.id, {
        module: target.slug,
        moduleId: target.id,
        ...(flipAgent ? { agent: target.agent } : {}),
      });
      this.store.logEvent(i.id, 'module_changed', {
        fromModuleId: i.moduleId,
        toModuleId: target.id,
        module: target.slug,
        via: 'organize',
      });
    }
    // 目标目录补建过程页 + 刷目标索引；来源模块（仍 active）逐个除名
    const fresh = this.store.listByProject(projectId);
    for (const i of picked) {
      const f = fresh.find((x) => x.id === i.id);
      if (f) await modules.recordIssue(target, f, fresh);
    }
    for (const srcId of sourceIds) {
      const src = this.moduleRow(projectId, srcId);
      if (src && modules.syncIssueIndex) await modules.syncIssueIndex(src, fresh);
    }
    return { target, movedIssueIds: picked.map((i) => i.id) };
  }

  /**
   * 创建时澄清（不占队列、不改状态）：后台异步跑执行代理分析（deps.clarify），
   * 产出落 clarify_feedback 列 + clarify_questions 事件 + 推送通知。
   * 每项目串行单飞（链式排队）——防同项目多条新 issue 同时起多个分析会话压垮执行机；
   * 不同项目互不排队。仅 pending（还在排队）的才值得分析——已开跑的由规划阶段对齐。
   */
  scheduleClarify(issueId: number): void {
    if (!this.deps.clarify) return;
    const issue = this.store.get(issueId);
    if (!issue || issue.status !== 'pending') return;
    const tail = this.clarifyChain.get(issue.projectId) ?? Promise.resolve();
    // runClarifyTask 自兜异常；链级 catch 只防御「db/driver 已关」等停机竞态，绝不让链断裂
    this.clarifyChain.set(issue.projectId, tail.then(() => this.runClarifyTask(issueId)).catch(() => {}));
  }

  /** 等所有在途创建时澄清分析归还（测试确定性用；生产停机不等——分析可长达分钟级） */
  async waitClarify(): Promise<void> {
    if (this.clarifyRecovery) await this.clarifyRecovery; // 恢复扫描先归还，链上才看得到重跑任务
    await Promise.all([...this.clarifyChain.values()]);
  }

  /**
   * 重启恢复扫描（start() 一次性）：悬空分析按状态分流——仍 pending 的重新
   * scheduleClarify 全新重跑（runner 步骤 0 自清残留会话与 scratch，天然幂等）；
   * 已开跑/完结的补不回也无意义，只补记 clarify_discarded 收口事件，并清掉
   * 本该由 runner finally 清理的残留 clr-<id> 会话与 .panda/tmp/clarify/<id>。
   */
  private async recoverClarify(): Promise<void> {
    if (!this.deps.clarify) return;
    for (const issue of this.store.listDanglingClarify()) {
      if (issue.status === 'pending') {
        this.scheduleClarify(issue.id);
        continue;
      }
      this.store.logEvent(issue.id, 'clarify_discarded', { status: issue.status, via: 'recover' });
      const cwd = this.project(issue.projectId)?.cwd;
      if (!cwd) continue;
      await this.deps.driver.killSession(clarifySessionName(issue.id)).catch(() => {});
      await this.deps.driver.removeTree(clarifyPaths(cwd, issue.id).scratch).catch(() => {});
    }
  }

  private async runClarifyTask(issueId: number): Promise<void> {
    const clarify = this.deps.clarify;
    if (!clarify) return;
    const issue = this.store.get(issueId);
    if (!issue) return; // 已删除，无处记事件
    if (issue.status !== 'pending') {
      // 排到本任务时已开跑/已取消（前一个分析在跑期间被调度/合并折叠）→ 不再起会话
      this.store.logEvent(issueId, 'clarify_skipped', { status: issue.status });
      return;
    }
    const project = this.project(issue.projectId);
    if (!project) return;
    // 降噪：历轮问答随任务下发（已答过的不重复问）；提问轮数到顶后只许更新反馈
    const history = this.store.clarifyRounds(issueId);
    const allowQuestions = history.length < this.cfg.clarifyMaxQuestionRounds;
    this.store.logEvent(issueId, 'clarify_started', { agent: issue.agent });
    let r: EngineClarifyResult;
    try {
      r = await clarify(project, {
        issueId,
        cwd: project.cwd,
        agent: issue.agent,
        title: issue.title,
        body: issue.body,
        category: issue.category,
        goal: project.goal,
        projectName: project.name,
        history,
        allowQuestions,
        locale: this.promptLocale(issue, project),
      });
    } catch (e) {
      r = { ok: false, reason: 'error', error: String(e).slice(0, 200) };
    }
    if (!r.ok) {
      // 分析失败不影响排队执行（评审铁律：失败落事件可见）
      this.store.logEvent(issueId, 'error', {
        where: 'clarify',
        reason: r.reason,
        ...(r.error ? { error: r.error.slice(0, 200) } : {}),
      });
      return;
    }
    // 归来竞态：分析期间 issue 已开跑/取消/删除 → 丢弃只记事件（CC 已读过原文，再补于事无补）
    const fresh = this.store.get(issueId);
    if (!fresh) return;
    if (fresh.status !== 'pending') {
      this.store.logEvent(issueId, 'clarify_discarded', { status: fresh.status, questions: r.questions.length });
      return;
    }
    if (r.feedback) this.store.setClarifyFeedback(issueId, r.feedback);
    this.store.logEvent(issueId, 'clarify_done', {
      questions: r.questions.length,
      ...(r.feedback ? { feedback: r.feedback.slice(0, 300) } : {}),
    });
    if (r.questions.length > 0) {
      if (!allowQuestions) {
        // 轮数到顶：prompt 已禁止出题，LLM 不听话也在这里确定性压制（不落问题不打扰）
        this.store.logEvent(issueId, 'clarify_questions_suppressed', { count: r.questions.length });
        return;
      }
      // 原文留档（#110）：questions.md 原样存一份（截 4000 字），UI 展示不受 parseQuestions 的
      // 条数/长度口径裁剪；空则不落该字段，旧事件形状不变
      const text = (r.questionsText ?? '').trim().slice(0, MAX_CLARIFY_TEXT_CHARS);
      this.store.logEvent(issueId, 'clarify_questions', {
        questions: r.questions.slice(0, 10),
        ...(text ? { text } : {}),
      });
      await this.notifySafe({
        kind: 'status_change',
        projectId: fresh.projectId,
        issueId,
        summaryCode: 'analysis_clarification',
        summaryParams: {
          title: fresh.title.slice(0, 40),
          body: bodyExcerpt(fresh.body),
          questions: r.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'),
        },
      });
    }
  }

  /**
   * 队列接力：项目空闲时按「模块聚合」挑下一条 pending 开跑（同模块优先→模块间不交错→FIFO）。
   * 开跑前先对**将要运行的那个模块**的 pending 做一次 LLM 智能合并（同模块小任务并成一条，
   * 减少反复起会话/重复读代码）。合并会 cancel 掉被并入项，其接力经 scheduling 单飞挡掉重入。
   *
   * `preferModuleKey` 必须是 `moduleKeyOf(issue)` 的结果（module_id 优先），不能直接传
   * issues.module 文本——文本列可能与模块 slug 不同步，会让「同模块连着跑」静默失效。
   */
  async scheduleNext(projectId: number, preferModuleKey?: string): Promise<void> {
    if (this.scheduling.has(projectId)) return; // 合并 cancel 触发的嵌套接力：本轮外层会收尾
    this.scheduling.add(projectId);
    const mergedHosts: number[] = [];
    try {
      let preferred = preferModuleKey;
      for (;;) {
        let next = pickNext(this.store.listRunnableByProject(projectId), preferred);
        if (!next) return;
        const pickedModule = moduleKeyOf(next); // 模块身份用键（module_id 优先），不用可能过期的文本列
        // 目标模块的 pending 先智能合并，再在同模块内重挑（合并后 host 仍是最早的一条）
        mergedHosts.push(...(await this.maybeMergeModule(projectId, pickedModule)));
        next = pickNext(this.store.listRunnableByProject(projectId), pickedModule);
        if (!next) return;

        const beforeStatus = next.status;
        const r = await this.startIssue(next.id);
        if (!r.ok) {
          this.store.logEvent(next.id, 'error', { where: 'scheduleNext', error: r.error });
          return;
        }

        const projectIssues = this.store.listByProject(projectId);
        if (isBusy(projectIssues)) return; // 正常开跑成功：项目已有唯一 active，接力结束
        const fresh = projectIssues.find((issue) => issue.id === next.id);
        if (!fresh || fresh.status === beforeStatus) {
          this.store.logEvent(next.id, 'error', {
            where: 'scheduleNext',
            error: fresh ? `开跑后状态无进展（仍为 ${fresh.status}）` : '开跑后 issue 不存在',
          });
          return;
        }

        // startIssue 的 planning onEnter 可能同步激活失败并转 blocked；其嵌套 scheduleNext
        // 被 scheduling guard 吞掉。当前 flight 负责继续挑下一条，避免项目无 active 冻结。
        preferred = pickedModule;
      }
    } finally {
      this.scheduling.delete(projectId);
      // 合并过的 host 正文已变 → 仍在排队的重新分析；刚被 startIssue 挑中开跑的已非
      // pending，scheduleClarify 无声跳过（放在 startIssue 之后调度即为消除这层竞态）
      for (const hid of mergedHosts) this.scheduleClarify(hid);
    }
  }

  /**
   * 同模块智能合并：把 module 下、与「将跑的那条」相容（同 agent/类型/实施模式）的 pending
   * 交 LLM 判归并；每个合并组保留最早的一条为 host（并入其余的 title/body），其余 pending
   * 直接 cancel 并记「已合并入 #host」。全程确定性校验，LLM 只出建议。
   *
   * 相容约束：合并出的 host 只有一套 agent/category/implMode/目标分支/源 ref——跨这些维度
   * 合并会改变实施或 Git 语义，故只在完全相同的子组内合并。
   */
  private async maybeMergeModule(projectId: number, moduleKey: string): Promise<number[]> {
    const hosts: number[] = [];
    if (!this.cfg.autoMerge) return hosts;
    const project = this.project(projectId);
    if (!project) return hosts;
    const pm = this.deps.pmFor(project);
    if (typeof pm.mergeModuleTasks !== 'function') return hosts; // 老 stub / 未实现 → 跳过

    // 只并「从未起跑」的 pending（convId=null）：已绑对话/分支的（如 unblock 回来的）
    // 可能已有落地改动，折叠会丢工作，绝不动。
    const pending = this.store
      .listRunnableByProject(projectId)
      .filter((i) =>
        i.status === 'pending'
        && moduleKeyOf(i) === moduleKey
        && !i.convId
        && !i.publicationLocked
      );
    if (pending.length < 2) return hosts;
    // LLM 提示词要人看得懂的模块名：优先模块行显示名，退回 issue 的文本列
    const label = this.moduleLabel(projectId, pending[0]!);

    // Git 意图也进分桶：同目标但源不同、或同源但目标不同，都不能送进同一轮合并。
    const buckets = new Map<string, EngineIssue[]>();
    for (const i of pending) {
      const k = JSON.stringify([i.agent, i.category, i.implMode, i.targetBranch, i.sourceRef]);
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
    }
    for (const group of buckets.values()) {
      if (group.length < 2) continue;
      let merges: EngineMergeGroup[];
      try {
        merges = await pm.mergeModuleTasks(
          label,
          group.map((i) => ({ id: i.id, title: i.title, body: i.body })),
        );
      } catch (e) {
        this.store.logEvent(group[0]!.id, 'error', { where: 'mergeModuleTasks', error: String(e).slice(0, 200) });
        continue;
      }
      for (const m of merges) {
        const hid = await this.applyMerge(projectId, moduleKey, group, m);
        if (hid !== null) hosts.push(hid);
      }
    }
    return hosts;
  }

  /** 模块的人类可读名（只给提示词/日志用，绝不当身份键）：模块行显示名 → issue 文本列 */
  private moduleLabel(projectId: number, issue: EngineIssue): string {
    if (issue.moduleId !== null) {
      const row = this.moduleRow(projectId, issue.moduleId);
      if (row) return row.displayName;
    }
    return issue.module;
  }

  /** 落地一个合并组：校验成员仍 pending、选 host（最早）、折叠其余为 cancelled；返回 host id */
  private async applyMerge(
    projectId: number,
    moduleKey: string,
    group: EngineIssue[],
    merge: EngineMergeGroup,
  ): Promise<number | null> {
    return this.deps.mutex.runExclusive(
      issueMetaLockKey(projectId),
      () => this.applyMergeLocked(projectId, moduleKey, group, merge),
    );
  }

  /** 已持有项目 pending 元数据锁的合并落地；校验、折叠期间禁止 Git 意图 PATCH 插入。 */
  private async applyMergeLocked(
    projectId: number,
    moduleKey: string,
    group: EngineIssue[],
    merge: EngineMergeGroup,
  ): Promise<number | null> {
    const byId = new Map(group.map((i) => [i.id, i]));
    // 只认此刻仍 pending 的成员（LLM 可能引用已被上一组折叠掉的 id）
    const members = merge.members
      .map((id) => this.store.get(id))
      .filter((i): i is EngineIssue => {
        if (
          !i
          || i.status !== 'pending'
          || i.convId
          || i.publicationLocked
          || moduleKeyOf(i) !== moduleKey
          || this.store.dependencyBlockers(i.id).length > 0
        ) return false;
        const original = byId.get(i.id);
        return !!original
          && i.targetBranch === original.targetBranch
          && i.sourceRef === original.sourceRef;
      });
    if (members.length < 2) return null;
    // host = 最早的一条（保住 FIFO 位次；title/body 换成合并后内容）
    members.sort((a, b) => a.createdTs - b.createdTs || a.id - b.id);
    const host = members[0]!;
    const foldedIds = members.slice(1).map((i) => i.id);
    this.store.patchMeta(host.id, { title: merge.title, body: merge.body });
    this.store.setClarifyFeedback(host.id, null); // 正文已并入多条，旧反馈作废（调度收尾后重新分析）
    // 置顶不能被合并吞掉：若被并入项里有置顶（且比 host 更晚置顶），把置顶带到 host——
    // 否则「置顶了一条，却被同模块更早的一条合并掉」会让置顶意图无声丢失。
    const maxPin = Math.max(...members.map((i) => i.pinnedTs ?? 0));
    if (maxPin > (host.pinnedTs ?? 0)) this.store.setPinned(host.id, maxPin);
    this.store.logEvent(host.id, 'tasks_merged', { from: foldedIds, module: host.module, title: merge.title.slice(0, 120) });
    for (const m of members.slice(1)) {
      this.store.logEvent(m.id, 'merged_into', { host: host.id, module: host.module });
      await this.applyEvent(m.id, 'cancel', { note: `已合并入 #${host.id}` });
    }
    void projectId;
    return host.id;
  }

  /**
   * 开跑一条 pending issue：绑对话（debug 复用启发式，busy 集合含 pending 已绑）→
   * skip_clarifying 直进 planning。澄清已前置到创建时（scheduleClarify 后台分析），
   * 开跑不再判含糊；执行中真不清楚由 CC 输出 ISSUE_BLOCKED 转受阻来问。
   */
  private async resolveExecutionWorkspace(
    issue: EngineIssue,
    project: Project,
  ): Promise<EngineExecutionWorkspace> {
    const resolved = this.deps.executionWorkspaces
      ? await this.deps.executionWorkspaces.resolve(issue, project)
      : { cwd: project.cwd, kind: 'project' as const, branch: null, runId: null };
    if (!resolved
      || typeof resolved.cwd !== 'string'
      || !resolved.cwd.startsWith('/')
      || resolved.cwd.trim() !== resolved.cwd
      || (resolved.kind !== 'project' && resolved.kind !== 'design-worktree')
      || (resolved.kind === 'project' && resolved.cwd !== project.cwd)
      || (resolved.kind === 'design-worktree' && (!resolved.branch || !resolved.runId))) {
      throw new Error('execution workspace contract mismatch');
    }
    return resolved;
  }

  async startIssue(issueId: number): Promise<ApplyResult> {
    const issue = this.store.get(issueId);
    if (!issue) return { ok: false, error: '无此 issue' };
    if (issue.status !== 'pending') return { ok: false, error: `仅 pending 可开跑（当前 ${issue.status}）` };
    const project = this.project(issue.projectId);
    if (!project) return { ok: false, error: '项目不存在' };

    // 不持粗 project mutex：这里只串行化“从 pending 抢启动权到 planning commit”的最小窗口。
    // 已有 reservation 时等待其 commit/失败释放，再从头重读 issue/project/busy，避免脏判断。
    if (this.startingProjects.has(issue.projectId)) {
      const wait = this.startingProjectWaits.get(issue.projectId);
      if (wait) await wait;
      return this.startIssue(issueId);
    }
    this.startingProjects.add(issue.projectId);
    let resolveWait!: () => void;
    const wait = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    this.startingProjectWaits.set(issue.projectId, wait);
    let released = false;
    const releaseStarting = () => {
      if (released) return;
      released = true;
      if (this.startingProjectWaits.get(issue.projectId) === wait) {
        this.startingProjectWaits.delete(issue.projectId);
        this.startingProjects.delete(issue.projectId);
      }
      resolveWait();
    };

    try {
      let immediate: ApplyResult | null = null;
      let transitionPromise: Promise<ApplyResult> | null = null;

      // 锁序固定为 issue-meta → transition → git。pending 编辑/删除/自动合并都先拿
      // issue-meta，因此不会出现“start 已占 transition 等 meta、合并持 meta 等 transition”。
      // meta 只持到 planning/blocked CAS 落库：afterCommit 发信后立即释放，不覆盖通知/激活。
      await this.deps.mutex.runExclusive(issueMetaLockKey(issue.projectId), async () => {
        const fresh = this.store.get(issueId);
        if (!fresh) {
          immediate = { ok: false, error: '无此 issue' };
          return;
        }
        if (fresh.status !== 'pending') {
          immediate = { ok: false, error: `仅 pending 可开跑（当前 ${fresh.status}）` };
          return;
        }
        const blockers = this.store.dependencyBlockers(fresh.id);
        if (blockers.length > 0) {
          immediate = {
            ok: false,
            error: `依赖尚未完成：${blockers.map((blocker) => `#${blocker.issueId}(${blocker.status})`).join(', ')}`,
          };
          return;
        }
        const siblings = this.store.listByProject(fresh.projectId).filter((i) => i.id !== fresh.id);
        const pausedWorkflow = siblings.some(
          (candidate) => candidate.status === 'blocked' && this.workflowSnapshot(candidate.id)?.status === 'paused',
        );
        if (isBusy(siblings) || pausedWorkflow) {
          immediate = { ok: false, error: '项目忙（已有 issue 在跑），先排队' };
          return;
        }

        let workspace: EngineExecutionWorkspace;
        try {
          workspace = await this.resolveExecutionWorkspace(fresh, project);
        } catch (e) {
          const detail = String(e).slice(0, 200);
          this.store.logEvent(fresh.id, 'error', { where: 'execution-workspace', error: detail });
          immediate = { ok: false, error: `执行工作区不可用：${detail}` };
          return;
        }

        // 正式模块永久绑定唯一逻辑对话；tmux 只是可随时休眠/恢复的运行容器。
        if (!fresh.convId && !this.workflowSnapshot(fresh.id)) {
          let conv: Conversation | undefined;
          if (workspace.kind === 'design-worktree') {
            try {
              conv = await this.deps.executionWorkspaces!.conversationFor(fresh, workspace);
            } catch (e) {
              immediate = { ok: false, error: `设计执行会话不可用：${String(e).slice(0, 160)}` };
              return;
            }
            if (conv.projectId !== fresh.projectId
              || conv.agent !== fresh.agent
              || conv.workspaceCwd !== workspace.cwd) {
              immediate = { ok: false, error: '设计执行会话与工作区不匹配' };
              return;
            }
          } else if (fresh.moduleId) {
            const module = this.deps.db
              .query<{ conversation_id: string | null; agent: string }, [number, number]>(
                'SELECT conversation_id, agent FROM project_modules WHERE id = ? AND project_id = ?',
              )
              .get(fresh.moduleId, fresh.projectId);
            if (!module) {
              immediate = { ok: false, error: '绑定模块不存在' };
              return;
            }
            if (module.conversation_id) conv = this.deps.convs.get(module.conversation_id);
            if (!conv) {
              conv = this.deps.convs.create(
                fresh.projectId,
                `module:${fresh.module}`,
                module.agent === 'codex' ? 'codex' : 'claude',
              );
              this.deps.db
                .query('UPDATE project_modules SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL')
                .run(conv.id, fresh.moduleId);
              const bound = this.deps.db
                .query<{ conversation_id: string }, [number]>(
                  'SELECT conversation_id FROM project_modules WHERE id = ?',
                )
                .get(fresh.moduleId)?.conversation_id;
              if (bound !== conv.id) conv = bound ? this.deps.convs.get(bound) : undefined;
            }
          } else if (fresh.category === 'debug') {
            const busy = this.store.busyConvIds(fresh.projectId);
            conv = this.deps.convs
              .listByProject(fresh.projectId)
              .find((c) => !c.archived && !busy.has(c.id) && c.agent === fresh.agent);
          }
          if (!conv) {
            conv = this.deps.convs.create(
              fresh.projectId,
              fresh.title.slice(0, 40) || `issue-${fresh.id}`,
              fresh.agent,
            );
          }
          // 绑会话失败必须落回 {ok:false}：startIssue 常在 done/blocked 的 onEnter 里经
          // scheduleNext 被调用，抛错会一路穿出 applyEvent 让那次状态转换整体 reject——
          // 队列就此冻住。转成 error 结果，接力才能记事件后继续挑下一条。
          try {
            this.store.setConv(fresh.id, conv.id);
          } catch (e) {
            immediate = { ok: false, error: `绑定会话失败：${String(e).slice(0, 160)}` };
            return;
          }
        } else if (workspace.kind === 'design-worktree') {
          let conv: Conversation;
          try {
            conv = await this.deps.executionWorkspaces!.conversationFor(fresh, workspace);
          } catch (e) {
            immediate = { ok: false, error: `设计执行会话不可用：${String(e).slice(0, 160)}` };
            return;
          }
          if (conv.id !== fresh.convId
            || conv.projectId !== fresh.projectId
            || conv.agent !== fresh.agent
            || conv.workspaceCwd !== workspace.cwd) {
            immediate = { ok: false, error: '设计执行会话绑定不一致' };
            return;
          }
        }
        const bound = this.store.get(fresh.id);
        if (bound?.moduleId && bound.convId) {
          const lastStart = this.store.lastEventId(bound.id, 'conversation_segment_started');
          const lastEnd = this.store.lastEventId(bound.id, 'conversation_segment_ended');
          if (lastStart <= lastEnd) {
            this.store.logEvent(bound.id, 'conversation_segment_started', {
              convId: bound.convId,
              moduleId: bound.moduleId,
              agent: bound.agent,
              title: bound.title,
            });
          }
        }

        let signalMetaRelease!: () => void;
        const metaCanRelease = new Promise<void>((resolve) => {
          signalMetaRelease = resolve;
        });
        let metaReleaseSignalled = false;
        const signalOnce = () => {
          if (metaReleaseSignalled) return;
          metaReleaseSignalled = true;
          signalMetaRelease();
        };
        transitionPromise = this.runIssueTransition(issueId, () =>
          this.applyEventLocked(issueId, 'skip_clarifying', {}, () => {
            releaseStarting();
            signalOnce();
          }),
        );
        void transitionPromise.then(signalOnce, signalOnce);
        await metaCanRelease;
      });

      if (immediate) return immediate;
      if (!transitionPromise) return { ok: false, error: 'issue 启动失败' };
      return await transitionPromise;
    } finally {
      releaseStarting();
    }
  }

  /**
   * 澄清答复：
   * - pending（创建时问题在排队期间回答）：并入 body、不迁移状态、不注入（还没起会话），
   *   随后 scheduleClarify 重新分析（重生成反馈/新问题，可来回多轮）；
   * - clarifying（存量旧数据兼容）：并入 body + clarified → planning；
   * - 驱动态（planning/implementing/testing）：把答复**直达该 issue 的实时会话**（同一把 tmux
   *   锁，与引擎 kickoff/nudge 串行），记 clarified 事件（clarified 晚于 clarify_questions →
   *   execClarifyWait/clarifyPendingOf 自动清零 = 解除等待），复位 nudge/activity 让 watcher 续跑。
   *   覆盖两种来源：执行中澄清（NEED_CLARIFY / PM 兜底）、创建时问题开跑后才回答（spec 第 5 点）。
   */
  async clarify(issueId: number, answer: string): Promise<ApplyResult> {
    const issue = this.store.get(issueId);
    if (!issue) return { ok: false, error: '无此 issue' };
    const a = answer.trim().slice(0, 4000);
    if (!a) return { ok: false, error: '澄清答复为空' };

    // 所答问题 = 最近一批未答的创建时问题（有则问答成对写入正文，可读且可追溯）
    const rounds = this.store.clarifyRounds(issueId);
    const lastRound = rounds[rounds.length - 1];
    const openQuestions = lastRound && lastRound.answer === null ? lastRound.questions : [];

    if (issue.status === 'pending') {
      this.store.setBody(issueId, `${issue.body ?? ''}\n\n${formatClarifyAppend(openQuestions, a)}`.trim());
      this.store.logEvent(issueId, 'clarified', { answer: a.slice(0, 500), source: 'pending' });
      // 答复已并入正文 → 重新分析（重生成反馈、可能再抛新一轮问题，来回多轮直到理解一致）；
      // 沿用 scheduleClarify 自身守卫（仅 pending + 每项目链式单飞），仍在排队才值得重分析。
      this.scheduleClarify(issueId);
      return { ok: true, from: 'pending', to: 'pending' };
    }

    if (issue.status === 'clarifying') {
      this.store.setBody(issueId, `${issue.body ?? ''}\n\n${formatClarifyAppend(openQuestions, a)}`.trim());
      this.store.logEvent(issueId, 'clarified', { answer: a.slice(0, 500), source: 'clarifying' });
      return this.applyEvent(issueId, 'clarified');
    }

    if (DRIVING_STATES.includes(issue.status)) {
      if (!issue.convId) return { ok: false, error: '该 issue 未绑定会话，无法注入澄清答复' };
      const wasWaiting = this.store.execClarifyWait(issueId) !== null; // 记录来源（执行中澄清 vs 开跑后补答）
      const session = this.deps.convs.tmuxName(issue.projectId, issue.convId);
      // 统一门禁（issue #97）：代理已退回 shell 时，答复打进 bash 就彻底丢了（既没进正文
      // 也没进会话，用户还以为答过了）。判死则先把代理重起来，让用户重发——不在这里等就绪
      // 后再补发：这是同步请求路径，等代理启动会把接口挂住十几秒。
      const quiet = await this.convQuietMs(issue.convId);
      if ((await this.sessionLiveness(issue.agent, session, undefined, quiet)) === 'shell') {
        this.store.logEvent(issueId, 'agent_down', { session, agent: issue.agent, where: 'answerClarify' });
        await this.relaunchConv(issue).catch(() => {});
        return { ok: false, error: '代理不在（已自动重启），请稍等几秒后重发答复' };
      }
      await this.inject(session, `【澄清答复】${a}`);
      this.store.logEvent(issueId, 'clarified', {
        answer: a.slice(0, 500),
        source: wasWaiting ? 'exec' : 'post_start',
      });
      const w = this.watch.get(issue.convId);
      if (w) {
        w.nudged = false;
        w.fedTs = this.now();
        w.activityTs = this.now();
        w.doneChecked = 0;
      }
      return { ok: true, from: issue.status, to: issue.status };
    }

    return { ok: false, error: `当前状态（${issue.status}）不支持澄清答复` };
  }

  /** 卡点 approve/reject（路由回调入口）；requestId 防重放靠 gates 表 waiting→decided CAS */
  async decideGate(
    gateId: number,
    userId: number,
    action: 'approve' | 'reject',
    note?: string,
  ): Promise<ApplyResult> {
    const gate = this.store.getGate(gateId);
    if (!gate) return { ok: false, error: '无此卡点' };
    if (gate.status !== 'waiting') return { ok: false, error: '卡点已处理过' };
    if (action === 'reject' && !note?.trim()) return { ok: false, error: 'reject 必须带意见' };
    const issue = this.store.get(gate.issueId);
    const expect: IssueState = gate.kind === 'plan' ? 'plan_review' : 'merge_review';
    if (!issue || issue.status !== expect) return { ok: false, error: 'issue 状态已变化，卡点失效' };
    if (!this.store.decideGate(gateId, action === 'approve' ? 'approved' : 'rejected', userId, note)) {
      return { ok: false, error: '卡点已被并发处理' };
    }
    this.store.logEvent(issue.id, 'gate_decided', {
      gateId,
      kind: gate.kind,
      action,
      actor: userId,
      ...(note ? { note: note.slice(0, 500) } : {}),
    });
    const ev: IssueMachineEvent =
      gate.kind === 'plan'
        ? action === 'approve'
          ? 'plan_approved'
          : 'plan_rejected'
        : action === 'approve'
          ? 'review_approved'
          : 'review_rejected';
    return this.applyEvent(issue.id, ev, { note, actor: userId });
  }

  async cancelIssue(issueId: number, actor?: number): Promise<ApplyResult> {
    return this.applyEvent(issueId, 'cancel', { actor });
  }

  /**
   * 仅删除未在驱动的 issue。与 pending 编辑/自动合并/start 共用 issue-meta 锁：
   * start 在锁内完成分支准备与 planning CAS 后才释放，因此不会出现“行已删、checkout 留下”的现场。
   */
  async removeIssue(issueId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const initial = this.store.get(issueId);
    if (!initial) return { ok: false, error: '无此 issue' };
    return this.deps.mutex.runExclusive(issueMetaLockKey(initial.projectId), () => {
      const fresh = this.store.get(issueId);
      if (!fresh) return { ok: false as const, error: '无此 issue' };
      if (!['pending', 'done', 'blocked', 'cancelled'].includes(fresh.status)) {
        return {
          ok: false as const,
          error: `进行中（${fresh.status}）不能直接删，先取消`,
        };
      }
      if (!this.store.remove(issueId)) return { ok: false as const, error: '删除失败' };
      return { ok: true as const };
    });
  }

  async blockIssue(issueId: number, note: string, actor?: number): Promise<ApplyResult> {
    return this.applyEvent(issueId, 'block', { note, actor });
  }

  /** blocked → pending 重新入队；解除方法单独完整留痕，供下一轮规划可靠注入。 */
  async unblockIssue(issueId: number, guidance: string, actor?: number): Promise<ApplyResult> {
    const normalized = guidance.trim();
    if (!normalized) return { ok: false, error: '解除阻塞前必须填写补充意见或解除方法' };
    if (normalized.length > 4000) return { ok: false, error: '解除方法不能超过 4000 字' };
    return this.applyEvent(issueId, 'unblock', { note: normalized, actor }, () => {
      this.store.logEvent(issueId, 'unblock_guidance', {
        guidance: normalized,
        ...(actor !== undefined ? { actor } : {}),
      });
    });
  }

  /**
   * 复活一条已取消的 issue（#93）：cancelled → pending，随后由 applyEvent 的 pending 接力
   * 立刻重新排队开跑。典型用法是「取消 → 改需求 → 重新运行」，所以**编辑必须发生在调用
   * 本方法之前**——一旦落到 pending 就可能马上开跑，没有给人再改的窗口。
   *
   * 清理挂在 afterCommit（CAS 之后、调度之前，同步执行、仍在 transition 临界区内），
   * 不能放到 applyEvent 返回之后：那时接力可能已经把它开跑，清理会连新计划一起抹掉。
   */
  async reopenIssue(issueId: number, actor?: number): Promise<ApplyResult> {
    const issue = this.store.get(issueId);
    if (!issue) return { ok: false, error: '无此 issue' };
    // 友好错误；真正的守卫是状态机（非 cancelled 一律「非法转换」）
    if (issue.status !== 'cancelled') {
      return { ok: false, error: `仅已取消的 issue 可重新运行（当前 ${issue.status}）` };
    }
    return this.applyEvent(issueId, 'reopen', actor !== undefined ? { actor } : {}, () => {
      this.store.clearRunState(issueId);
      this.store.logEvent(issueId, 'reopened', actor !== undefined ? { actor } : undefined);
    });
  }

  /**
   * 恢复「review 状态已经发布、但 entry action 在建 gate 前被进程退出或 Git 异常打断」的半状态。
   * 只允许确实缺少当前 waiting gate 时重跑，沿用 issue transition queue 防并发重复创建。
   */
  async retryMissingGate(
    issueId: number,
    actor?: number,
  ): Promise<{ ok: true; gate: Gate } | { ok: false; error: string }> {
    return this.runIssueTransition(issueId, async () => {
      const issue = this.store.get(issueId);
      if (!issue) return { ok: false, error: '无此 issue' };
      const kind: GateKind | null =
        issue.status === 'plan_review' ? 'plan' : issue.status === 'merge_review' ? 'merge_review' : null;
      if (!kind) return { ok: false, error: `当前状态 ${issue.status} 不需要卡点恢复` };
      const waiting = this.store
        .listGates(issue.id)
        .find((gate) => gate.kind === kind && gate.status === 'waiting');
      if (waiting) return { ok: false, error: '卡点已经存在，无需重试' };

      this.store.logEvent(issue.id, 'gate_retry', {
        kind,
        ...(actor !== undefined ? { actor } : {}),
      });
      await this.onEnter(issue.id, issue.status, issue.status);

      const gate = this.store
        .listGates(issue.id)
        .find((candidate) => candidate.kind === kind && candidate.status === 'waiting');
      if (gate) return { ok: true, gate };
      const fresh = this.store.get(issue.id);
      return {
        ok: false,
        error:
          fresh?.status === 'blocked'
            ? '重新生成卡点失败，issue 已转为受阻'
            : '重新生成卡点后仍未产生待确认数据',
      };
    });
  }

  /**
   * 置顶/取消置顶一条 pending issue：置顶把它排到队首（重复置顶=再顶上去，刷新置顶时刻），
   * 仅影响排队顺序（queue.pickNext 置顶层）。改完触发一次接力——项目忙则无操作，
   * 空闲则按新顺序挑（此时置顶项即队首）。仅 pending 可置顶（已开跑/已结的置顶无意义）。
   */
  async setPinned(issueId: number, pinned: boolean, actor?: number): Promise<ApplyResult> {
    const issue = this.store.get(issueId);
    if (!issue) return { ok: false, error: '无此 issue' };
    if (issue.status !== 'pending') return { ok: false, error: `仅待办（pending）可置顶（当前 ${issue.status}）` };
    this.store.setPinned(issueId, pinned ? this.now() : null);
    this.store.logEvent(issueId, pinned ? 'pinned' : 'unpinned', actor !== undefined ? { actor } : undefined);
    await this.scheduleNext(issue.projectId, moduleKeyOf(issue));
    return { ok: true, from: issue.status, to: issue.status };
  }

  /**
   * 改 issue 的自动批准档位（issue #108）。未开跑/驱动中都能改——正在跑的 issue 改完
   * 下一次弹窗就按新档位走（管道每轮现取），这正是「跑着跑着觉得太啰嗦/太放飞」时的用法。
   * 只有已收尾的（done/cancelled）拒改：不会再有弹窗，改了纯属误导（#111）。
   * **blocked 仍可改**——受阻能重试，重试前调档正是它的用法，别顺手把它一起锁掉。
   */
  setAutoApprove(issueId: number, level: AutoApproveLevel, actor?: number): ApplyResult {
    const issue = this.store.get(issueId);
    if (!issue) return { ok: false, error: '无此 issue' };
    if (issue.status === 'done' || issue.status === 'cancelled') {
      return { ok: false, error: '已完成/已取消的 issue 不能改自动批准档位' };
    }
    this.store.setAutoApprove(issueId, level);
    this.store.logEvent(issueId, 'auto_approve_changed', {
      from: issue.autoApprove,
      to: level,
      ...(actor !== undefined ? { actor } : {}),
    });
    return { ok: true, from: issue.status, to: issue.status };
  }

  // ---- 状态迁移收口 ----

  /**
   * 唯一的状态迁移入口：machine.transition 纯函数判合法 → CAS 落库 →
   * transition 事件 → 阶段进入动作 → 通知。
   */
  async applyEvent(
    issueId: number,
    ev: IssueMachineEvent,
    opts: { note?: string; failCount?: number; actor?: number } = {},
    /** CAS 落库后、任何调度之前**同步**执行（仍在本 issue 的 transition 临界区内）。
     *  reopen 的清理挂在这里：先落 pending 再清，接力可能已经把它开跑，会抹掉新计划。 */
    afterCommit?: () => void,
  ): Promise<ApplyResult> {
    // 锁序：pending 入口必须 issue-meta → transition queue → git；会话入口必须
    // project → tmux。严禁 transition 反向获取 issue-meta。onEnter 内的递归迁移必须
    // 直接调用 applyEventLocked，重新排入同一 issue 尾队列会自等。
    const result = await this.runIssueTransition(issueId, () =>
      this.applyEventLocked(issueId, ev, opts, afterCommit),
    );
    // unblock → pending 的接力可能立刻重新 start 同一 issue，必须等 transition 锁释放后执行。
    if (result.ok && result.to === 'pending' && result.from !== 'pending') {
      const issue = this.store.get(issueId);
      if (issue?.status === 'pending') await this.scheduleNext(issue.projectId, moduleKeyOf(issue));
    }
    return result;
  }

  /**
   * 同 issue 严格串行，但第一项不经 `await resolvedPromise`：fn 在当前调用栈立即执行到自己的
   * 首个 await。这样 startIssue(A) 的 pending→planning CAS 会先落库，紧随其后的 startIssue(B)
   * 才做项目 busy 检查。占位 tail 在调用 fn 前登记，连同步重入也只能排到后面。
   */
  private runIssueTransition<T>(issueId: number, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.issueTransitionTails.get(issueId);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.issueTransitionTails.set(issueId, tail);

    let result: Promise<T>;
    if (previous) {
      result = previous.then(fn);
    } else {
      try {
        result = Promise.resolve(fn());
      } catch (e) {
        result = Promise.reject(e);
      }
    }
    void result.then(release, release);
    void tail.then(() => {
      if (this.issueTransitionTails.get(issueId) === tail) this.issueTransitionTails.delete(issueId);
    });
    return result;
  }

  /** 已占用本 issue transition queue 槽位的迁移实现；只供本类递归 entry action 使用。 */
  private async applyEventLocked(
    issueId: number,
    ev: IssueMachineEvent,
    opts: { note?: string; failCount?: number; actor?: number } = {},
    afterCommit?: () => void,
  ): Promise<ApplyResult> {
    let issue = this.store.get(issueId);
    if (!issue) return { ok: false, error: '无此 issue' };
    const from = issue.status;
    const to = transition(from, ev, opts.failCount !== undefined ? { failCount: opts.failCount } : undefined);
    if (to === null) return { ok: false, error: `非法转换：${from} -[${ev}]->` };
    const boundaryKind = this.executionSyncBoundaryKind(from, ev);
    if (boundaryKind) {
      const held = this.store.holdExecutionSyncBoundary(issueId, boundaryKind, {
        kind: 'issue-event',
        event: ev,
        options: {
          ...(opts.note !== undefined ? { note: opts.note } : {}),
          ...(opts.failCount !== undefined ? { failCount: opts.failCount } : {}),
          ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
        },
      });
      if (held) return { ok: true, from, to: from };
    }
    const commitTransition = (fresh: EngineIssue): boolean => {
      if (!this.store.casStatus(issueId, from, to)) return false;
      this.store.logEvent(issueId, 'transition', {
        event: ev,
        from,
        to,
        ...(opts.note ? { note: opts.note.slice(0, 500) } : {}),
        ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      });
      issue = fresh;
      afterCommit?.();
      return true;
    };
    let committed = false;

    // 配置了目标分支时，仓库准备和 planning CAS 必须在同一个 Git 临界区内完成，这样
    // watcher 永远看不到“状态已 planning、分支还没准备好”的半状态。pending→planning
    // 的调用方 startIssue 已按 issue-meta → transition → git 持锁；clarifying/plan_review
    // 的 Git 意图已不可编辑，无需反向再取 issue-meta。
    if (to === 'planning') {
      const project = this.project(issue.projectId);
      if (project) {
        let workspace: EngineExecutionWorkspace;
        try { workspace = await this.resolveExecutionWorkspace(issue, project); }
        catch (e) {
          this.store.logEvent(issueId, 'error', { where: 'execution-workspace', error: String(e).slice(0, 200) });
          return this.applyEventLocked(issueId, 'block', { note: '执行工作区不可用' }, afterCommit);
        }
        if (workspace.kind === 'project' && !issue.targetBranch) {
          // Preserve the legacy no-target path byte-for-byte: no Git observation or mutation.
        } else {
        const prepared = await this.deps.mutex.runExclusive(gitLockKey(project.id), async () => {
          const fresh = this.store.get(issueId);
          if (!fresh || fresh.status !== from) return { kind: 'stale' as const };
          const branch = await this.prepareIssueBranchLocked(project, fresh, workspace);
          if (!branch.ok) {
            if (branch.actualBranch && fresh.branch !== branch.actualBranch) {
              this.store.setBranch(issueId, branch.actualBranch);
            }
            return { kind: 'blocked' as const, err: branch.err };
          }
          if (!commitTransition(fresh)) return { kind: 'stale' as const };
          if (fresh.branch !== branch.branch) this.store.setBranch(issueId, branch.branch);
          this.store.logEvent(issueId, 'git_branch_prepared', {
            branch: branch.branch,
            mode: branch.mode,
            ...(fresh.sourceRef ? { sourceRef: fresh.sourceRef } : {}),
          });
          return { kind: 'ok' as const };
        });
        if (prepared.kind === 'blocked') {
          this.store.logEvent(issueId, 'error', { where: 'git-branch', error: prepared.err });
          return this.applyEventLocked(issueId, 'block', {
            note: `git 分支准备失败：${prepared.err}`,
          }, afterCommit);
        }
        if (prepared.kind === 'stale') {
          return { ok: false, error: `状态已被并发修改（不再是 ${from}），事件 ${ev} 作废` };
        }
        committed = true;
        }
      }
    }
    // implementing 状态发布前，在同一 Git 锁内确认实际分支并采样起点。CAS、issues.branch
    // 与首条 impl_base 都是同步 DB 写，watcher 不会看到缺少起点锚的 implementing 半状态。
    if (to === 'implementing') {
      const project = this.project(issue.projectId);
      if (project) {
        let workspace: EngineExecutionWorkspace;
        try { workspace = await this.resolveExecutionWorkspace(issue, project); }
        catch (e) {
          this.store.logEvent(issueId, 'error', { where: 'execution-workspace', error: String(e).slice(0, 200) });
          return this.applyEventLocked(issueId, 'block', { note: '执行工作区不可用' }, afterCommit);
        }
        const inspected = await this.deps.mutex.runExclusive(gitLockKey(project.id), async () => {
          const fresh = this.store.get(issueId);
          if (!fresh || fresh.status !== from) return { kind: 'stale' as const };
          const branch = await this.inspectIssueBranchLocked(project, fresh, workspace);
          if (!branch.ok) return { kind: 'blocked' as const, err: branch.err };
          if (!commitTransition(fresh)) return { kind: 'stale' as const };
          if (fresh.branch !== branch.branch) this.store.setBranch(issueId, branch.branch);
          if (this.store.countEvents(issueId, 'impl_base') === 0 && branch.head) {
            this.store.logEvent(issueId, 'impl_base', { sha: branch.head, branch: branch.branch });
          }
          return { kind: 'ok' as const };
        });
        if (inspected.kind === 'blocked') {
          this.store.logEvent(issueId, 'error', { where: 'git-branch', error: inspected.err });
          return this.applyEventLocked(issueId, 'block', {
            note: `git 分支校验失败：${inspected.err}`,
          }, afterCommit);
        }
        if (inspected.kind === 'stale') {
          return { ok: false, error: `状态已被并发修改（不再是 ${from}），事件 ${ev} 作废` };
        }
        committed = true;
      }
    }
    if (!committed && !commitTransition(issue)) {
      // 读-判-重读-CAS：期间状态已被并发修改（哨兵 vs 判定竞态），本事件作废
      return { ok: false, error: `状态已被并发修改（不再是 ${from}），事件 ${ev} 作废` };
    }
    // M3：通知先于 onEnter——onEnter 可能嵌套 applyEvent（merging 里的 merged/merge_conflict、
    // 收尾接力 scheduleNext），其内层通知若先发会造成时序倒挂（用户先看到 merging→done
    // 再看到 merge_review→merging）。先通知本次迁移，嵌套迁移的通知自然排在其后。
    await this.notifySafe({
      kind: 'status_change',
      projectId: issue.projectId,
      issueId,
      from,
      to,
      summaryCode: 'status_transition',
      summaryParams: { title: issue.title.slice(0, 60) },
    });
    if (to === 'done') {
      await this.notifySafe({ kind: 'issue_done', projectId: issue.projectId, issueId, summary: issue.title });
    } else if (to === 'blocked') {
      await this.notifySafe({
        kind: 'issue_blocked',
        projectId: issue.projectId,
        issueId,
        summaryCode: 'issue_blocked',
        summaryParams: { title: issue.title.slice(0, 60), detail: opts.note ?? '' },
      });
    }
    await this.onEnter(issueId, from, to, opts.note);
    await this.syncModuleIssue(issueId);
    return { ok: true, from, to };
  }

  private executionSyncBoundaryKind(from: IssueState, ev: IssueMachineEvent): string | null {
    if (from === 'pending' && ev === 'skip_clarifying') return 'skip_clarifying';
    if (from === 'clarifying' && ev === 'clarified') return 'clarified';
    if (from === 'planning' && ev === 'plan_ready') return 'plan_ready';
    if (from === 'plan_review' && (ev === 'plan_approved' || ev === 'plan_rejected')) return ev;
    if (from === 'implementing' && ev === 'impl_done') return 'impl_done';
    if (from === 'testing' && (ev === 'tests_passed' || ev === 'tests_failed')) return ev;
    if (from === 'merge_review' && (ev === 'review_approved' || ev === 'review_rejected')) return ev;
    return null;
  }

  private async syncModuleIssue(issueId: number): Promise<void> {
    const issue = this.store.get(issueId);
    if (!issue?.moduleId) return;
    const project = this.project(issue.projectId);
    const modules = project ? this.deps.modulesFor?.(project) : undefined;
    if (!modules) return;
    try {
      const module = await modules.resolve({
        projectId: issue.projectId,
        title: issue.title,
        body: issue.body,
        agent: issue.agent,
        moduleId: issue.moduleId,
        createdBy: issue.createdBy,
      });
      await modules.recordIssue(module, issue, this.store.listByProject(issue.projectId));
    } catch (e) {
      this.store.logEvent(issue.id, 'error', {
        where: 'module-docs',
        error: String(e).slice(0, 300),
      });
    }
  }

  /** 阶段进入动作（git 分支流 / 建 gate / 收尾接力）；全部确定性，不交给 LLM */
  private async onEnter(issueId: number, from: IssueState, to: IssueState, note?: string): Promise<void> {
    const issue = this.store.get(issueId);
    // 防御共享 mutex 之外的 DB 写入：只为仍停留在本次目标状态的 issue 执行 entry action。
    if (!issue || issue.status !== to) return;
    const project = this.project(issue.projectId);
    if (!project) return;
    let workspace: EngineExecutionWorkspace;
    try { workspace = await this.resolveExecutionWorkspace(issue, project); }
    catch (e) {
      this.store.logEvent(issue.id, 'error', {
        where: 'execution-workspace', error: String(e).slice(0, 200),
      });
      return;
    }

    switch (to) {
      case 'planning': {
        if (this.workflowSnapshot(issueId)) {
          await this.applyEventLocked(issueId, 'plan_ready', { note: '工作流快照已就绪' });
          break;
        }
        // 配置目标分支的新 issue 已在 planning CAS 发布前准备好 Git 现场；历史 issue
        // （targetBranch=null）完全沿用“开发者当前分支”行为。
        // 首次（pending/clarifying 进入）激活对话；plan_rejected 回炉时进程通常已在——
        // 但若项目此刻没有激活对话（迁移/重启丢失），同样要激活（I1）。
        if (from === 'pending' || from === 'clarifying') {
          try {
            await this.activateConv(issue);
          } catch (e) {
            await this.applyEventLocked(issueId, 'block', {
              note: `激活对话失败：${String(e).slice(0, 200)}`,
            });
            return;
          }
        } else if (!(await this.ensureActiveConv(issue))) {
          return;
        }
        break;
      }
      case 'plan_review': {
        if (this.workflowSnapshot(issueId)) {
          this.store.logEvent(issueId, 'auto_approved', { kind: 'workflow_plan' });
          await this.applyEventLocked(issueId, 'plan_approved', { note: '工作流模板已确认' });
          break;
        }
        // 默认（manual_review 关）：不建卡点，记 auto_approved 直接放行开工——
        // 卡点等人批会占死项目队列（实测过夜 12h+）。开了手动确认才走老流程。
        if (!project.manualReview) {
          if (this.store.holdExecutionSyncBoundary(issueId, 'plan_approved', {
            kind: 'resume_entry', from, to: 'plan_review',
          })) return;
          this.store.logEvent(issueId, 'auto_approved', {
            kind: 'plan',
            n: this.store.subtasksOf(issue).length,
          });
          await this.applyEventLocked(issueId, 'plan_approved', { note: '计划自动确认，直接开工' });
          break;
        }
        const gate = this.store.createGate(issueId, 'plan', {
          subtasks: this.store.subtasksOf(issue).map((s) => s.text),
          implMode: issue.implMode,
        });
        this.store.logEvent(issueId, 'gate_created', { gateId: gate.id, kind: 'plan' });
        await this.notifySafe({
          kind: 'gate_waiting',
          projectId: issue.projectId,
          issueId,
          gate,
          summaryCode: 'plan_review',
          summaryParams: { title: issue.title.slice(0, 60) },
        });
        break;
      }
      case 'implementing': {
        const workflow = this.workflowSnapshot(issueId);
        if (workflow) {
          const result = await this.workflowScheduler.begin(
            issueId,
            this.promptLocale(issue, project),
          );
          if (result?.state === 'completed') {
            await this.applyEventLocked(issueId, 'impl_done', { note: '工作流已完成' });
          } else if (result?.state === 'failed' || result?.state === 'paused') {
            await this.applyEventLocked(issueId, 'block', {
              note: `${result.state === 'paused' ? '工作流已暂停' : '工作流执行失败'}：${result.reason}`,
            });
          }
          break;
        }
        // targetBranch 非空的新 issue 已在 planning 前准备好分支；历史 issue 仍沿用开发者当前分支。
        // 实际分支校验、issues.branch 与首条 impl_base 已在 implementing CAS 发布前原子准备。
        // I1：plan_review approve 等路径进 implementing 时项目可能没有激活对话
        // （迁移场景：issue/conv 已入库但 project_active_conv 空）——此时激活，别静默冻结。
        if (!(await this.ensureActiveConv(issue))) return;
        break;
      }
      case 'testing':
        if (this.workflowSnapshot(issueId)) {
          await this.applyEventLocked(issueId, 'tests_passed', { note: '工作流节点已全部完成' });
          break;
        }
        if (!(await this.ensureActiveConv(issue))) return; // I1 同上
        break; // kickoff 注入测试 prompt
      case 'merge_review': {
        // 默认（manual_review 关）：不建卡点——自动 commit/push 收尾后直接放行到 done。
        // 先 commit 再 stampImplTip：自动提交要落进本 issue 的 impl_base..impl_tip 范围。
        if (!project.manualReview) {
          if (this.store.holdExecutionSyncBoundary(issueId, 'merge_review_auto', {
            kind: 'resume_entry', from, to: 'merge_review',
          })) return;
          const finished = await this.deps.mutex
            .runExclusive(gitLockKey(project.id), async () => {
              const branch = await this.inspectIssueBranchLocked(project, issue, workspace);
              if (!branch.ok) return branch;
              const autoFailure = await this.autoCommitPushLocked(project, issue, workspace);
              await this.stampImplTip(project, issue, workspace);
              return { ok: true as const, autoFailure };
            })
            .catch((e: unknown) => ({ ok: false as const, err: String(e).slice(0, 300) }));
          if (!finished.ok) {
            this.store.logEvent(issueId, 'error', { where: 'git-branch', error: finished.err });
            await this.applyEventLocked(issueId, 'block', {
              note: `自动收尾已停止：${finished.err}`,
            });
            return;
          }
          if (finished.autoFailure) {
            const { where, detail } = finished.autoFailure;
            await this.notifySafe({
              kind: 'status_change',
              projectId: issue.projectId,
              issueId: issue.id,
              summaryCode: 'auto_git_failure',
              summaryParams: {
                title: issue.title.slice(0, 60),
                action: where === 'auto_commit' ? 'commit' : 'push',
                detail: detail.slice(0, 160),
              },
            });
          }
          this.store.logEvent(issueId, 'auto_approved', { kind: 'merge_review' });
          await this.applyEventLocked(issueId, 'review_approved', {
            note: '测试通过，自动收尾（commit/push）',
          });
          break;
        }
        const review = await this.deps.mutex
          .runExclusive(gitLockKey(project.id), async () => {
            const branch = await this.inspectIssueBranchLocked(project, issue, workspace);
            if (!branch.ok) return branch;
            await this.stampImplTip(project, issue, workspace); // 定格本 issue 终点：范围收在 impl_base..impl_tip
            return { ok: true as const, payload: await this.buildMergeReviewPayload(project, issue, workspace) };
          })
          .catch((e: unknown) => ({ ok: false as const, err: String(e).slice(0, 300) }));
        if (!review.ok) {
          this.store.logEvent(issueId, 'error', { where: 'git-branch', error: review.err });
          await this.applyEventLocked(issueId, 'block', {
            note: `生成改动审查已停止：${review.err}`,
          });
          return;
        }
        const gate = this.store.createGate(issueId, 'merge_review', review.payload);
        this.store.logEvent(issueId, 'gate_created', { gateId: gate.id, kind: 'merge_review' });
        await this.notifySafe({
          kind: 'gate_waiting',
          projectId: issue.projectId,
          issueId,
          gate,
          summaryCode: 'merge_review',
          summaryParams: { title: issue.title.slice(0, 60) },
        });
        break;
      }
      case 'merging': {
        // 引擎不做本地合并：改动已经落在 issue 的实际工作分支上，合并/MR 由开发者在 GitLab 侧处理。
        // 保留 merging 这个过渡态只为不动状态机；此处直接放行到 done。
        this.store.logEvent(issueId, 'merge_skipped', { branch: issue.branch ?? '', reason: 'no-local-merge' });
        await this.applyEventLocked(issueId, 'merged');
        break;
      }
      case 'done':
      case 'blocked':
      case 'cancelled': {
        if (to === 'blocked') this.workflowScheduler.pause(issueId, note ?? 'issue.blocked');
        if (to === 'cancelled') this.workflowScheduler.cancel(issueId);
        if (issue.convId) this.watch.delete(issue.convId);
        this.store.expireWaitingGates(issueId);
        // 定格本 issue 终点 + 提交快照——仅作**兜底**：blocked/cancelled 若没走过 merge_review
        // 就在这里补记（此刻 HEAD 仍在工作分支）。已 review 过的（含 done）在 merge_review 时
        // 就定格好了，不重记。分支准备只发生在首次进入 planning 前，故收尾不动工作树。
        if (this.implTipSha(issueId) === null) {
          const stamped = await this.deps.mutex
            .runExclusive(gitLockKey(project.id), async () => {
              const branch = await this.inspectIssueBranchLocked(project, issue, workspace);
              if (!branch.ok) return branch;
              await this.stampImplTip(project, issue, workspace);
              return { ok: true as const };
            })
            .catch((e: unknown) => ({ ok: false as const, err: String(e).slice(0, 300) }));
          if (!stamped.ok) {
            this.store.logEvent(issueId, 'error', { where: 'git-tip', error: stamped.err });
          }
        }
        // 执行结果总结：必须在接力**之前**（下一条 issue 会接管同一 tmux 会话）；
        // cancelled 不总结；超时/失败降级记事件，不阻断收尾。
        if (to !== 'cancelled') await this.collectResultSummary(project, issue, to, workspace);
        if (
          issue.moduleId &&
          issue.convId &&
          this.store.lastEventId(issue.id, 'conversation_segment_started') >
            this.store.lastEventId(issue.id, 'conversation_segment_ended')
        ) {
          this.store.logEvent(issue.id, 'conversation_segment_ended', {
            convId: issue.convId,
            status: to,
          });
        }
        const reservesProject = to === 'blocked' && this.workflowSnapshot(issueId)?.status === 'paused';
        if (!reservesProject) {
          await this.scheduleNext(issue.projectId, moduleKeyOf(issue)); // done/普通 blocked 接力
        }
        if (
          issue.convId &&
          !isBusy(this.store.listByProject(issue.projectId)) &&
          this.deps.convs.sleepIssue
        ) {
          await this.deps.convs.sleepIssue(issue.convId);
          this.store.logEvent(issue.id, 'module_sleep', { convId: issue.convId });
        }
        break;
      }
      case 'pending': {
        // unblock 接力在 public applyEvent 释放 issue 锁后执行，避免 startIssue 同 key 自锁。
        break;
      }
      default:
        break;
    }
    void note;
  }

  // ---- git 分支流（确定性，Driver.git） ----

  /**
   * 在规划开始前把仓库准备到 issue.targetBranch：
   * - 已在目标上：不检查脏状态、不切换，保留历史行为；
   * - 目标本地分支存在：仅干净工作区可 checkout；
   * - 目标不存在：仅干净工作区可从完整本地/远程跟踪 sourceRef 创建。
   * 所有 Git 调用与手动 stage/commit/push 共用 git:<projectId> 锁。
   */
  private async prepareIssueBranchLocked(
    project: Project,
    issue: EngineIssue,
    workspace: EngineExecutionWorkspace,
  ): Promise<
    | { ok: true; branch: string; mode: 'current' | 'existing' | 'created' }
    | { ok: false; err: string; actualBranch?: string }
  > {
    // 调用方已持有 git:<projectId>；这里不得再次获取同 key（KeyedMutex 非重入）。
      const cwd = workspace.cwd;
      const target = workspace.kind === 'design-worktree'
        ? workspace.branch ?? ''
        : issue.targetBranch?.trim() ?? '';
      if (!target) return { ok: false, err: '目标分支为空' };

      if (workspace.kind === 'design-worktree') {
        const inspected = await this.inspectIssueBranchLocked(project, issue, workspace);
        return inspected.ok
          ? { ok: true, branch: inspected.branch, mode: 'current' }
          : inspected;
      }

      const repo = await this.deps.driver.git(cwd, ['rev-parse', '--is-inside-work-tree']);
      if (repo.code !== 0 || repo.out.trim() !== 'true') {
        return { ok: false, err: `不是有效 Git 工作区：${(repo.err || repo.out).trim().slice(0, 200)}` };
      }
      const targetFormat = await this.deps.driver.git(cwd, ['check-ref-format', `refs/heads/${target}`]);
      if (targetFormat.code !== 0) return { ok: false, err: `目标分支名无效：${target}` };

      const currentResult = await this.deps.driver.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const current = currentResult.code === 0 ? currentResult.out.trim() : '';
      if (current === target) {
        return { ok: true, branch: target, mode: 'current' };
      }

      const status = await this.deps.driver.git(cwd, [
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
      ]);
      if (status.code !== 0) {
        return { ok: false, err: `读取工作区状态失败：${(status.err || status.out).trim().slice(0, 200)}` };
      }
      if (status.out.trim()) {
        return {
          ok: false,
          err: `工作区有未保存改动，不能从 ${current || 'detached HEAD'} 切换到 ${target}`,
        };
      }

      const targetRef = `refs/heads/${target}`;
      const exists = await this.deps.driver.git(cwd, ['show-ref', '--verify', '--quiet', targetRef]);
      if (exists.code !== 0 && exists.code !== 1) {
        return { ok: false, err: `检查目标分支失败：${(exists.err || exists.out).trim().slice(0, 200)}` };
      }

      let checkout;
      let mode: 'existing' | 'created';
      if (exists.code === 0) {
        mode = 'existing';
        checkout = await this.deps.driver.git(cwd, ['checkout', '--no-overwrite-ignore', target]);
      } else {
        const source = issue.sourceRef?.trim() ?? '';
        if (!source) return { ok: false, err: `目标分支 ${target} 不存在，且未选择源分支` };
        if (!/^refs\/(?:heads|remotes)\/.+/.test(source)) {
          return { ok: false, err: `源分支引用无效：${source}` };
        }
        const sourceFormat = await this.deps.driver.git(cwd, ['check-ref-format', source]);
        if (sourceFormat.code !== 0) return { ok: false, err: `源分支引用无效：${source}` };
        const sourceCommit = await this.deps.driver.git(cwd, [
          'rev-parse',
          '--verify',
          '--quiet',
          `${source}^{commit}`,
        ]);
        if (sourceCommit.code !== 0 || !sourceCommit.out.trim()) {
          return { ok: false, err: `源分支不存在或不指向提交：${source}` };
        }
        mode = 'created';
        // source 只是创建基线，不是目标分支的 upstream；尤其从 origin/main 创建 feature/*
        // 时不能让后续普通 push 误推 main。ignored 冲突也必须失败，不能静默覆盖本地文件。
        checkout = await this.deps.driver.git(cwd, [
          'checkout',
          '--no-overwrite-ignore',
          '--no-track',
          '-b',
          target,
          source,
        ]);
      }
      if (checkout.code !== 0) {
        return {
          ok: false,
          err: `切换目标分支 ${target} 失败：${(checkout.err || checkout.out).trim().slice(0, 200)}`,
        };
      }
      const after = await this.deps.driver.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      let actual = after.code === 0 ? after.out.trim() : '';
      if (!actual) {
        const fallback = await this.deps.driver.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const fallbackBranch = fallback.code === 0 ? fallback.out.trim() : '';
        if (fallbackBranch && fallbackBranch !== 'HEAD') actual = fallbackBranch;
      }
      if (actual !== target) {
        return {
          ok: false,
          err: `切换后当前分支为 ${actual || 'detached HEAD'}，不是目标分支 ${target}`,
          ...(actual ? { actualBranch: actual } : {}),
        };
      }
      return { ok: true, branch: target, mode };
  }

  /**
   * 本 issue 的实际工作分支名：
   *  1) issue.branch 已定 → 沿用（首次进 implementing 记下后不再变）；
   *  2) 历史 issue 未配置目标时，读**开发者当前所在分支**——这就是改动真正落地的分支；
   *  3) detached / 读不到 → 退回项目 work_branch 或空串（仅作展示标签，不影响 commit 范围记录）。
   */
  private async currentBranch(
    project: Project,
    issue: EngineIssue,
    workspace: EngineExecutionWorkspace,
  ): Promise<string> {
    if (issue.branch) return issue.branch;
    const cur = await this.deps.driver.git(workspace.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const b = cur.code === 0 ? cur.out.trim() : '';
    if (b && b !== 'HEAD') return b;
    return (project.workBranch ?? '').trim();
  }

  /**
   * 已持有项目 Git 锁时读取真实分支与 HEAD。配置目标或曾记录实际分支的 issue 不允许
   * 漂移到别的分支；历史 issue 首次进入 implementing 时仍采用当下分支。
   * unborn/非 Git 的历史行为允许 head=null，后续首个自动提交仍可正常创建根提交。
   */
  private async inspectIssueBranchLocked(
    project: Project,
    issue: EngineIssue,
    workspace: EngineExecutionWorkspace,
  ): Promise<
    | { ok: true; branch: string; head: string | null }
    | { ok: false; err: string }
  > {
    const currentResult = await this.deps.driver.git(workspace.cwd, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
    const actual = currentResult.code === 0 ? currentResult.out.trim() : '';
    const expected = (workspace.kind === 'design-worktree'
      ? workspace.branch ?? ''
      : issue.branch ?? issue.targetBranch ?? '').trim();
    if (expected && actual !== expected) {
      return {
        ok: false,
        err: `当前分支为 ${actual || 'detached HEAD'}，issue 工作分支应为 ${expected}`,
      };
    }
    const branch = expected || actual || (project.workBranch ?? '').trim();
    const headResult = await this.deps.driver.git(workspace.cwd, ['rev-parse', '--verify', 'HEAD']);
    const head = headResult.code === 0 && headResult.out.trim() ? headResult.out.trim() : null;
    return { ok: true, branch, head };
  }

  /**
   * 本 issue 首次进入 implementing 时记录的分支起点 sha（固定/共享分支下：merge_review 与
   * per-issue git 视图都据此只取本 issue 的提交，而非分支上历史 issue 的全部改动）。public：
   * server 装配 issueGitRef 时读取（见 routes/index）。
   */
  implBaseSha(issueId: number): string | null {
    return this.eventSha(issueId, 'impl_base', 'first');
  }

  /**
   * 本 issue 工作「定格」时（merge_review / 终态）记录的终点 sha。取最后一条：
   * blocked→unblock 再实施会覆写。per-issue git 视图据此把范围收在 start..tip，避免把分支上
   * **后续** issue 的提交也算进本 issue。issue 仍在推进（implementing/testing）时无此锚点，视图退回分支 tip。
   */
  implTipSha(issueId: number): string | null {
    return this.eventSha(issueId, 'impl_tip', 'last');
  }

  /**
   * 本 issue 最近一次「工作定格」记录的**耐久提交快照**：涉及的 commit ids + 逐文件改动。
   * commit id 不可变，据此重算 diff 永远稳定，天然免疫「固定分支后续其它 issue 又提交」把范围
   * 算糊的问题。无快照（老 issue / 从未落地改动）→ null。取最后一条（unblock 再实施会覆写）。
   */
  implCommits(issueId: number): ImplCommitsSnapshot | null {
    let found: ImplCommitsSnapshot | null = null;
    for (const e of this.store.listEvents(issueId)) {
      if (e.kind !== 'impl_commits' || !e.dataJson) continue;
      try {
        const d = JSON.parse(e.dataJson) as ImplCommitsSnapshot;
        if (typeof d.base === 'string' && typeof d.tip === 'string') found = d;
      } catch {
        /* 坏事件跳过 */
      }
    }
    return found;
  }

  /** 取某 kind 事件 data.sha（first=最早一条，last=最新一条），无则 null。 */
  private eventSha(issueId: number, kind: string, pick: 'first' | 'last'): string | null {
    let found: string | null = null;
    for (const e of this.store.listEvents(issueId)) {
      if (e.kind !== kind || !e.dataJson) continue;
      try {
        const s = (JSON.parse(e.dataJson) as { sha?: unknown }).sha;
        if (typeof s === 'string' && s) {
          if (pick === 'first') return s;
          found = s; // last：继续覆盖到最后一条
        }
      } catch {
        /* 坏事件跳过 */
      }
    }
    return found;
  }

  /**
   * 定格本 issue 终点 sha（当前 HEAD）+ 落一份耐久的「本 issue 涉及的 commit ids 及其文件改动」
   * 快照（impl_commits 事件）。进入 merge_review 或终态时调用——那一刻分支 tip 恰是本 issue 的
   * 最后一条提交，往后其它 issue 的提交不再计入本 issue。**所有模式都记**（不再限共享分支）：
   * 有了显式 commit id，per-issue 视图/评审就永远按本 issue 自己的提交算，不必再和 main 对比。
   * 无起点（impl_base）则无从定范围，跳过。
   */
  private async stampImplTip(
    project: Project,
    issue: EngineIssue,
    workspace: EngineExecutionWorkspace,
  ): Promise<void> {
    const startSha = this.implBaseSha(issue.id);
    if (startSha === null) return; // 无起点则无从定范围
    const head = await this.deps.driver.git(workspace.cwd, ['rev-parse', 'HEAD']);
    const tip = head.code === 0 ? head.out.trim() : '';
    if (!tip) return;
    this.store.logEvent(issue.id, 'impl_tip', { sha: tip });
    // 耐久快照：本 issue 净提交（commit ids）+ 逐文件改动。同一 base..tip 已记过则不重复
    // （merge_review 与终态各会调一次 stampImplTip）。
    if (!this.hasCommitSnapshot(issue.id, startSha, tip)) {
      const snap = await this.collectImplCommits(workspace.cwd, startSha, tip);
      this.store.logEvent(issue.id, 'impl_commits', { base: startSha, tip, ...snap });
    }
  }

  /** 同一 base..tip 的 impl_commits 快照是否已记过（避免 merge_review + 终态重复落库）。 */
  private hasCommitSnapshot(issueId: number, base: string, tip: string): boolean {
    for (const e of this.store.listEvents(issueId)) {
      if (e.kind !== 'impl_commits' || !e.dataJson) continue;
      try {
        const d = JSON.parse(e.dataJson) as { base?: string; tip?: string };
        if (d.base === base && d.tip === tip) return true;
      } catch {
        /* 坏事件跳过 */
      }
    }
    return false;
  }

  /**
   * 采集 base..tip 的本 issue 净提交（commit ids）+ 逐文件改动（name-status ∪ numstat）。
   * base 是 tip 的祖先，故两点 range 即「本 issue 自己的提交/改动」，与分支上历史 issue 无涉。
   */
  private async collectImplCommits(
    cwd: string,
    base: string,
    tip: string,
  ): Promise<{ commits: ImplCommit[]; files: ImplFile[] }> {
    const range = `${base}..${tip}`;
    const [logR, nameR, numR] = await Promise.all([
      this.deps.driver.git(cwd, [
        'log', '--date-order', '-n', '500',
        `--pretty=format:%H${GIT_FIELD_SEP}%h${GIT_FIELD_SEP}%an${GIT_FIELD_SEP}%at${GIT_FIELD_SEP}%s`,
        range,
      ]),
      this.deps.driver.git(cwd, ['diff', '-M', '--name-status', range]),
      this.deps.driver.git(cwd, ['diff', '-M', '--numstat', range]),
    ]);
    return {
      commits: logR.code === 0 ? parseImplCommits(logR.out) : [],
      files: parseImplFiles(nameR.code === 0 ? nameR.out : '', numR.code === 0 ? numR.out : ''),
    };
  }

  /**
   * 自动收尾（manual_review 关，tests_passed 后）：git add -A → 有暂存改动才 commit
   * 「<标题> (#id)」→ push origin 当前分支（HEAD）。commit/push 失败只记事件+通知、
   * **不挡完成**——改动本体已在工作树/分支上，人工随时可补救；卡住流程才是更大的伤害。
   * 没有新 commit 也照样 push（CC 实施中自己 commit 过、只欠 push 是常态）。
   */
  private async autoCommitPushLocked(
    project: Project,
    issue: EngineIssue,
    workspace: EngineExecutionWorkspace,
  ): Promise<{ where: 'auto_commit' | 'auto_push'; detail: string } | null> {
    const cwd = workspace.cwd;
    const fail = (where: 'auto_commit' | 'auto_push', detail: string) => {
      this.store.logEvent(issue.id, 'error', { where, error: detail.slice(0, 300) });
      return { where, detail };
    };
    const add = await this.deps.driver.git(cwd, ['add', '-A']);
    if (add.code !== 0) {
      return fail('auto_commit', add.err || add.out);
    }
    // diff --cached --quiet：0 = 无暂存改动（跳过 commit），非 0 = 有改动要提
    const staged = await this.deps.driver.git(cwd, ['diff', '--cached', '--quiet']);
    if (staged.code !== 0) {
      const msg = `${issue.title.slice(0, 120)} (#${issue.id})`;
      const commit = await this.deps.driver.git(cwd, ['commit', '-m', msg]);
      if (commit.code !== 0) {
        return fail('auto_commit', commit.err || commit.out); // commit 失败就没有新提交可推
      }
      this.store.logEvent(issue.id, 'auto_commit', { message: msg });
    }
    let pushArgs = ['push', 'origin', 'HEAD'];
    if (workspace.kind === 'design-worktree') {
      const upstream = await this.deps.driver.git(cwd, [
        'rev-parse', '--symbolic-full-name', '@{upstream}',
      ]);
      if (upstream.code !== 0 || !upstream.out.trim().startsWith('refs/remotes/')) {
        pushArgs = ['push', '--set-upstream', 'origin', 'HEAD'];
      }
    }
    const push = await this.deps.driver.git(cwd, pushArgs);
    if (push.code !== 0) {
      return fail('auto_push', push.err || push.out);
    }
    this.store.logEvent(issue.id, 'auto_push', { branch: issue.branch ?? 'HEAD' });
    return null;
  }

  private async buildMergeReviewPayload(
    project: Project,
    issue: EngineIssue,
    workspace: EngineExecutionWorkspace,
  ): Promise<Record<string, unknown>> {
    const branch = issue.branch ?? (await this.currentBranch(project, issue, workspace));
    const base = this.cfg.baseBranch;
    // 一律按「本 issue 自己的提交范围」出 diff：impl_base(起点)..impl_tip(终点，缺省用分支 tip)——
    // 改动落在 issue 的实际工作分支上且引擎不做本地合并；仅当从未记到起点（老 issue / 异常）
    // 才兜底回 base...branch。
    const startSha = this.implBaseSha(issue.id);
    const endSha = this.implTipSha(issue.id) ?? branch;
    const range = startSha ? `${startSha}..${endSha}` : `${base}...${branch}`;
    const stat = await this.deps.driver.git(workspace.cwd, ['diff', '--stat', range]);
    const diff = await this.deps.driver.git(workspace.cwd, ['diff', range]);
    // 本 issue 涉及的 commit ids + 逐文件改动随卡点②一并给出（评审直接看到具体提交）。
    const snap = startSha ? await this.collectImplCommits(workspace.cwd, startSha, endSha) : null;
    return {
      branch,
      base,
      ...(startSha ? { range } : {}),
      ...(snap ? { commits: snap.commits, files: snap.files } : {}),
      stat: stat.out.slice(0, 20000),
      diff: diff.out.slice(0, this.cfg.diffMaxChars),
      diffTruncated: diff.out.length > this.cfg.diffMaxChars,
      ...(stat.code !== 0 || diff.code !== 0
        ? { gitError: (stat.err || diff.err).slice(0, 500) }
        : {}),
    };
  }

  // ---- 执行结果总结（done/blocked 收尾，接力之前） ----

  /**
   * 向该 issue 的 CC 会话注入「执行总结」prompt，限时轮询文件哨兵读回存 result_summary。
   * 跳过条件（记 summary_skipped 事件）：从未起跑（无 conv）/ 项目 tmux 会话已不在 /
   * 激活对话已被切走（注入会打扰别的对话）。超时/无产出/异常 → error 事件降级，不上抛。
   */
  private async collectResultSummary(
    project: Project,
    issue: EngineIssue,
    kind: 'done' | 'blocked',
    workspace: EngineExecutionWorkspace,
  ): Promise<void> {
    if (this.cfg.resultSummaryTimeoutMs <= 0) return; // 关闭
    if (!issue.convId) {
      this.store.logEvent(issue.id, 'summary_skipped', { reason: 'no-conv' });
      return;
    }
    const session = this.deps.convs.tmuxName(issue.projectId, issue.convId);
    const p = resultSummaryPaths(workspace.cwd, issue.id);
    try {
      // 统一门禁（issue #97）：会话没了不必说，**窗格里只剩 bash 也不能发**——
      // 总结 prompt 会被 shell 当命令跑掉，然后干等到超时。此处不重启：issue 已经收尾，
      // 为了一段总结去重起代理不值当，记事件跳过即可。
      const live = await this.sessionLiveness(issue.agent, session, undefined, await this.convQuietMs(issue.convId));
      if (live === 'no-session' || live === 'shell') {
        this.store.logEvent(issue.id, 'summary_skipped', {
          reason: live === 'shell' ? 'agent-down' : 'no-session',
        });
        return;
      }
      if (this.deps.convs.currentConv(issue.projectId) !== issue.convId) {
        this.store.logEvent(issue.id, 'summary_skipped', { reason: 'conv-displaced' });
        return;
      }
      await this.deps.driver.removeTree(p.scratch).catch(() => {}); // 清残留，防读到上轮旧产物
      await this.inject(session, buildResultSummaryPrompt(issue.id, kind, this.promptLocale(issue, project)));
      this.store.logEvent(issue.id, 'summary_requested', { kind });
      const deadline = this.now() + this.cfg.resultSummaryTimeoutMs;
      let found = false;
      while (this.now() < deadline) {
        // 清菜单：issue 已收尾、watch 已删，审批管道不再盯这个会话——写 scratch 文件的
        // 权限弹窗没人过就会卡死到超时（实测踩坑）。与 agent-summary/clarify-runner 同款。
        await this.clearSummaryMenusOnce(session);
        const st = await this.deps.driver.statPath(p.done).catch(() => null);
        if (st) {
          found = true;
          break;
        }
        await this.cfg.sleep(this.cfg.resultSummaryPollMs);
      }
      if (!found) {
        this.store.logEvent(issue.id, 'error', { where: 'resultSummary', reason: 'timeout' });
        return;
      }
      const text = ((await readDriverText(this.deps.driver, p.summary, 64 * 1024)) ?? '').trim();
      if (!text) {
        this.store.logEvent(issue.id, 'error', { where: 'resultSummary', reason: 'no-output' });
        return;
      }
      this.store.setResultSummary(issue.id, text);
      if (workspace.kind === 'design-worktree') {
        await this.deps.executionWorkspaces?.recordResult?.(issue, workspace, text).catch((e) => {
          this.store.logEvent(issue.id, 'error', {
            where: 'design-result', error: String(e).slice(0, 200),
          });
        });
      }
      const module = issue.moduleId === null ? null : this.moduleRow(issue.projectId, issue.moduleId);
      const modules = this.deps.modulesFor?.(project);
      if (workspace.kind === 'project' && module && modules?.recordResultSummary) {
        await modules.recordResultSummary(module, { ...issue, status: kind }, text).catch((e) => {
          this.store.logEvent(issue.id, 'error', {
            where: 'resultSummaryDoc',
            error: String(e).slice(0, 200),
          });
        });
      }
      this.store.logEvent(issue.id, 'summary_done', { kind, chars: text.length });
    } catch (e) {
      this.store.logEvent(issue.id, 'error', { where: 'resultSummary', error: String(e).slice(0, 200) });
    } finally {
      await this.deps.driver.removeTree(p.scratch).catch(() => {});
    }
  }

  /** 总结轮询期间的清菜单一轮（agent-summary 同款：不去重，重复点只是多个空 Enter，无害） */
  private async clearSummaryMenusOnce(session: string): Promise<void> {
    const pane = await this.deps.driver.capturePane(session).catch(() => '');
    if (isCodexUpdatePrompt(pane)) {
      await this.deps.driver.sendKeys(session, '2').catch(() => {});
      return;
    }
    const sel = detectSelection(pane);
    if (!sel) return;
    const target = pickAffirmative(sel.options);
    const delta = target - sel.cursorIndex;
    const key = delta < 0 ? 'Up' : 'Down';
    for (let i = 0; i < Math.abs(delta); i++) {
      await this.deps.driver.sendKey(session, key).catch(() => {});
    }
    await this.deps.driver.sendKey(session, 'Enter').catch(() => {});
  }

  // ---- 对话激活 / watcher ----

  /**
   * I1：进入驱动阶段时，若项目**没有任何**激活对话（迁移只登记了 conv、重启丢激活行），
   * 激活本 issue 的对话；已有激活对话（哪怕不是本 issue 的）则不夺占——浏览优先，
   * 门禁与让位观测在 tickIssue（I2）。失败 → block（返回 false，调用方停止本阶段动作）。
   */
  private async ensureActiveConv(issue: EngineIssue): Promise<boolean> {
    if (this.deps.convs.currentConv(issue.projectId) !== undefined) return true;
    try {
      await this.activateConv(issue);
      return true;
    } catch (e) {
      // ensureActiveConv 只从 onEnter 调用，此处已持有本 issue 的 transition 锁。
      await this.applyEventLocked(issue.id, 'block', {
        note: `激活对话失败：${String(e).slice(0, 200)}`,
      });
      return false;
    }
  }

  private async activateConv(issue: EngineIssue): Promise<void> {
    if (!issue.convId) throw new Error('issue 未绑对话');
    const convId = issue.convId;
    const session = this.deps.convs.tmuxName(issue.projectId, issue.convId);
    // I3 锁序纪律：project → tmux（全库唯一嵌套方向，见 mutex.ts）。
    // activate 的 kill+create+send 三连必须持 tmux 注入锁：否则 PM tools.send_command /
    // WS act 只持 tmux 锁的注入会交错进「新 bash 已起、claude 还没跑」的窗口，
    // 注入文本被当 shell 命令执行。严禁在持有 tmux 锁时反向再取 project 锁（死锁）。
    const got = await this.deps.mutex.runExclusive(projectLockKey(issue.projectId), () =>
      this.deps.mutex.runExclusive(tmuxLockKey(session), () => this.deps.convs.activate(convId)),
    );
    if (!got) throw new Error(`对话 ${convId} 不存在`);
    await this.resetWatch(convId);
  }

  private async resetWatch(convId: string): Promise<WatchState> {
    let offset = 0;
    const path = await this.deps.locator.locate(convId);
    if (path) {
      const st = await this.reader.statPath(path).catch(() => null);
      offset = st?.size ?? 0;
    }
    const now = this.now();
    const w: WatchState = {
      offset,
      fedTs: now,
      activityTs: now,
      nudged: false,
      waitUntil: 0,
      bootTs: now,
      doneChecked: 0,
      kickInFlight: false,
      menuSince: 0,
      menuNotified: false,
      displacedNotified: false,
      growTs: now,
      reclaimAt: 0,
      codexUpdateAt: 0,
      recoverAt: 0,
      agentDownAt: 0,
      agentRestarts: 0,
      resumePending: false,
    };
    this.watch.set(convId, w);
    return w;
  }

  /** tmux 会话判活；listSessions 失败返回 null（未知——保守不按死会话处理） */
  private async sessionAlive(name: string): Promise<boolean | null> {
    try {
      return (await this.deps.driver.listSessions()).some((s) => s.name === name);
    } catch {
      return null;
    }
  }

  /**
   * **引擎所有注入出口的统一门禁**（issue #97）：这个会话在不在、代理还在不在跑。
   * 判据只此一处，调用方不许再各写各的（末行像不像提示符、屏上有没有 ❯ 之类）。
   *
   * - 传了 pane（tick 已经抓过屏）：屏面是代理 UI 且末行不是 shell 提示符 → 直接判 live，
   *   **不查 listSessions**。健康路径必须零额外 tmux 调用——引擎每 3s 一 tick，
   *   SSH 执行机上每次调用都是真流量。
   * - 没传 pane（收尾总结、澄清答复这类偶发路径）：查 listSessions + 抓一次屏，慢一点无所谓。
   * - listSessions 失败一律 unknown（与 sessionAlive 同纪律：判活失败绝不当成死会话）。
   */
  private async sessionLiveness(
    agent: AgentKind,
    session: string,
    pane?: string,
    quietMs?: number,
  ): Promise<AgentLiveness | 'no-session'> {
    if (pane !== undefined && !shouldProbeLiveness(agent, pane)) return 'live';
    let entry: { name: string; command?: string } | undefined;
    try {
      entry = (await this.deps.driver.listSessions()).find((s) => s.name === session);
    } catch {
      return 'unknown';
    }
    if (!entry) return 'no-session';
    const screen = pane ?? (await this.deps.driver.capturePane(session).catch(() => undefined));
    return judgeAgentLiveness({
      agent,
      ...(entry.command !== undefined ? { paneCommand: entry.command } : {}),
      ...(screen !== undefined ? { pane: screen } : {}),
      ...(quietMs !== undefined ? { quietMs } : {}),
    });
  }

  /** 距该对话的 jsonl 最近一次写入过了多久（判死硬闸的第三方证据）；拿不到返回 undefined */
  private async convQuietMs(convId: string): Promise<number | undefined> {
    const p = await this.deps.locator.locate(convId).catch(() => null);
    if (!p) return undefined;
    const st = await this.deps.driver.statPath(p).catch(() => null);
    return st ? Math.max(0, this.now() - st.mtimeMs) : undefined;
  }

  /**
   * 判定「窗格里只剩 shell」后的处置：落 agent_down、强制重启、落 agent_restarted。
   * 冷却期内只是静默跳过（调用方已 return，本 tick 零注入），不重复 kill——
   * 代理冷启动那几秒前台命令可能还是 bash，没冷却就会自己 kill 自己刚起的进程。
   * 连续重启到上限仍是 shell（登录过期/CLI 装坏这类重启治不好的故障）→ block 交人工，
   * applyEvent 自带 issue_blocked 通知。
   */
  private async handleAgentDown(
    issue: EngineIssue,
    w: WatchState,
    session: string,
    now: number,
  ): Promise<void> {
    if (w.agentDownAt && now - w.agentDownAt < AGENT_RESTART_COOLDOWN_MS) return;
    w.agentDownAt = now;
    this.store.logEvent(issue.id, 'agent_down', {
      session,
      agent: issue.agent,
      restarts: w.agentRestarts,
    });
    if (w.agentRestarts >= MAX_AGENT_RESTARTS) {
      await this.applyEvent(issue.id, 'block', {
        note:
          `代理起不来：已自动重启 ${w.agentRestarts} 次，${session} 窗格里仍只剩 shell` +
          `（常见原因：登录过期、CLI 装坏、项目目录没了）`,
      });
      return;
    }
    w.agentRestarts++;
    const restarts = w.agentRestarts;
    try {
      await this.relaunchConv(issue);
      // 冷却与计数都要带进新 watch（relaunchConv 内部 resetWatch 会重置它们）：
      // 冷却防「重启后立刻又判死」的 3s 打转，计数丢了则永远到不了上限。
      const fresh = issue.convId ? this.watch.get(issue.convId) : undefined;
      if (fresh) {
        fresh.agentDownAt = now;
        fresh.agentRestarts = restarts;
        fresh.resumePending = true; // 等它真就绪再补催办（见 tickIssue 的接续块）
      }
      this.store.logEvent(issue.id, 'agent_restarted', { session, restarts });
    } catch (e) {
      this.store.logEvent(issue.id, 'error', {
        where: 'agentRestart',
        error: String(e).slice(0, 200),
      });
      if (e instanceof AgentExecutableNotFoundError) {
        await this.applyEvent(issue.id, 'block', { note: e.message });
      }
    }
  }

  /**
   * 强制重启本 issue 对话的代理进程（issue #97）：与 activateConv 同一套锁序
   * （project → tmux，见 mutex.ts），但走 relaunch——activate 在「会话还在」时会短路，
   * 正是本 issue 要治的那种壳。重启后 resetWatch（offset 从新文件末尾起）。
   */
  private async relaunchConv(issue: EngineIssue): Promise<void> {
    if (!issue.convId) throw new Error('issue 未绑对话');
    const convId = issue.convId;
    const session = this.deps.convs.tmuxName(issue.projectId, convId);
    const got = await this.deps.mutex.runExclusive(projectLockKey(issue.projectId), () =>
      this.deps.mutex.runExclusive(tmuxLockKey(session), () =>
        this.deps.convs.relaunch
          ? this.deps.convs.relaunch(convId)
          : this.deps.convs.activate(convId),
      ),
    );
    if (!got) throw new Error(`对话 ${convId} 不存在`);
    await this.resetWatch(convId);
  }

  /**
   * 该 issue 会话的弹窗是否已滞留超过 menuStuckMs（waiting_input 派生标记数据源之二：
   * 升级卡之外，长时间没人管的弹窗也该在界面亮「等你选择」）。非驱动/无观测态恒 false。
   */
  menuStuck(issue: EngineIssue): boolean {
    if (!issue.convId) return false;
    const w = this.watch.get(issue.convId);
    return !!w && w.menuSince > 0 && this.now() - w.menuSince > this.cfg.menuStuckMs;
  }

  /** 弹窗滞留中的驱动 issue id 集合（summary 聚合「待确认」角标的数据源之二） */
  menuStuckIssueIds(): Set<number> {
    const out = new Set<number>();
    for (const issue of this.store.listDriving()) {
      if (this.menuStuck(issue)) out.add(issue.id);
    }
    return out;
  }

  /** watcher 主循环：每项目单飞，不同项目并行；每 issue 的错误独立落事件。 */
  async tick(): Promise<void> {
    if (!this.acceptingTicks) return;

    for (const [projectId, flight] of this.tickFlights) {
      if (!flight.stuckWarned && this.now() - flight.since > TICK_STUCK_WARN_MS) {
        flight.stuckWarned = true;
        console.error(
          `[engine] 项目 ${projectId} issue #${flight.issueId} tick 在途已 ` +
            `${Math.round((this.now() - flight.since) / 1000)}s 未归还，` +
            `疑似执行机调用卡死（不重置，等待其归还）`,
        );
      }
    }

    const started: Promise<void>[] = [];
    for (const issue of this.store.listDriving()) {
      if (!this.acceptingTicks || this.tickFlights.has(issue.projectId)) continue;

      let promise!: Promise<void>;
      promise = Promise.resolve()
        .then(() => this.tickIssue(issue))
        .catch((e) => {
          this.store.logEvent(issue.id, 'error', { where: 'tick', error: String(e).slice(0, 300) });
        })
        .finally(() => {
          const current = this.tickFlights.get(issue.projectId);
          if (current?.promise === promise) this.tickFlights.delete(issue.projectId);
        });
      this.tickFlights.set(issue.projectId, {
        issueId: issue.id,
        since: this.now(),
        stuckWarned: false,
        promise,
      });
      started.push(promise);
    }
    await Promise.allSettled(started);
  }

  /**
   * 工作流 issue 不依赖单一 conv_id；每次只根据耐久快照和节点 run 推进一步。
   * planning/plan_review/testing 也纳入恢复，覆盖服务恰好停在嵌套 entry action 之间的窗口。
   */
  private async tickWorkflowIssue(issue: EngineIssue, project: Project): Promise<void> {
    switch (issue.status) {
      case 'planning':
        await this.applyEvent(issue.id, 'plan_ready', { note: '工作流快照已就绪' });
        return;
      case 'plan_review':
        await this.applyEvent(issue.id, 'plan_approved', { note: '工作流模板已确认' });
        return;
      case 'implementing': {
        const result = await this.workflowScheduler.tick(issue.id, this.promptLocale(issue, project));
        if (result?.state === 'completed') {
          await this.applyEvent(issue.id, 'impl_done', { note: '工作流已完成' });
        } else if (result?.state === 'failed' || result?.state === 'paused') {
          await this.applyEvent(issue.id, 'block', {
            note: `${result.state === 'paused' ? '工作流已暂停' : '工作流执行失败'}：${result.reason}`,
          });
        }
        return;
      }
      case 'testing': {
        const workflow = this.workflowSnapshot(issue.id);
        if (workflow?.status === 'completed') {
          await this.applyEvent(issue.id, 'tests_passed', { note: '工作流节点已全部完成' });
        } else if (workflow?.status === 'failed') {
          await this.applyEvent(issue.id, 'block', {
            note: `工作流执行失败：${workflow.pauseReason ?? 'workflow.failed'}`,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private async tickIssue(issue: EngineIssue): Promise<void> {
    // A durable design-sync boundary freezes every watcher-driven side effect, including session
    // recovery, kickoff and nudge. Restart therefore cannot drive past an undecided revision.
    if (this.store.activeExecutionSyncBoundary(issue.id)
      || this.store.hasUnresolvedExecutionSyncEffect(issue.id)) return;
    const project = this.project(issue.projectId);
    if (!project) return;
    if (this.workflowSnapshot(issue.id)) {
      await this.tickWorkflowIssue(issue, project);
      return;
    }
    if (!issue.convId) return;
    const convId = issue.convId;
    const current = this.deps.convs.currentConv(issue.projectId);
    if (current === undefined) {
      // I1：项目没有任何激活对话（v1→v2 迁移只登记了 conv、重启丢激活行等）——
      // 驱动中的 issue 自行激活自己的对话，否则永远静默冻结在 driving 态。
      try {
        await this.activateConv(issue);
      } catch (e) {
        this.store.logEvent(issue.id, 'error', {
          where: 'reactivate',
          error: String(e).slice(0, 200),
        });
        if (e instanceof AgentExecutableNotFoundError) {
          await this.applyEvent(issue.id, 'block', { note: e.message });
        }
        return;
      }
    } else if (current !== convId) {
      // 进程占用门禁：只驱动项目当前激活对话（浏览不夺占，评审 5.2#7）。
      // I2：跳过不许零观测——首次记事件 + 通知一次，切回后重置（见下方 displacedNotified 复位）。
      const wd = this.watch.get(convId) ?? (await this.resetWatch(convId));
      if (!wd.displacedNotified) {
        wd.displacedNotified = true;
        this.store.logEvent(issue.id, 'conv_displaced', { conv: convId, current });
        await this.notifySafe({
          kind: 'status_change',
          projectId: issue.projectId,
          issueId: issue.id,
          summaryCode: 'conversation_displaced',
          summaryParams: { title: issue.title.slice(0, 60) },
        });
      }
      return;
    }
    const w = this.watch.get(convId) ?? (await this.resetWatch(convId));
    w.displacedNotified = false; // 恢复为当前对话：让位标志复位，下次让位再通知
    const session = this.deps.convs.tmuxName(issue.projectId, issue.convId);
    const now = this.now();

    // 菜单检测 + 滞留可观测（评审 H16 黑洞防线）
    const pane = await this.deps.driver.capturePane(session).catch(() => '');

    // 会话自愈（issue #88）：systemd 重启/宿主重启会把 tmux 连坐杀掉，而 project_active_conv
    // 行还在——currentConv 一致但 tmux 会话已不存在时，旧逻辑每 tick 往死会话 send-keys 刷错、
    // 永不重建。pane 空（capturePane 抛错被吞）才查判活（健康路径零额外开销）；确认死会话 →
    // activateConv 重建（jsonl 已落地即 --resume 续上下文），恢复后由既有 kickoff
    // （hasInjectedSince 幂等）+ 催办接续驱动。失败按冷却重试，冷却期不驱动死会话防错误刷屏。
    if (pane === '' && (await this.sessionAlive(session)) === false) {
      if (now - w.recoverAt < SESSION_RECOVER_COOLDOWN_MS) return;
      w.recoverAt = now;
      try {
        await this.activateConv(issue); // 内部 resetWatch：offset 从新文件末尾起
        this.watch.get(convId)!.recoverAt = now; // 冷却带进新 watch：重建后立刻又死不打转
        this.store.logEvent(issue.id, 'session_recovered', { session });
      } catch (e) {
        this.store.logEvent(issue.id, 'error', { where: 'recover', error: String(e).slice(0, 200) });
        if (e instanceof AgentExecutableNotFoundError) {
          await this.applyEvent(issue.id, 'block', { note: e.message });
        }
      }
      return; // 本 tick 到此为止：让新会话启动，下轮再驱动
    }

    // codex 升级弹窗：自动选「1. Update now」升级后继续执行（issue #48-5 用户钦定自动升级；
    // 之前无人可点=新版本一出全员卡死）。升级可能重启会话换 rollout 文件——绑定失效由
    // 会话失效检测自动重新认领接手。冷却 30s：弹窗正常一轮就消失，重复打 '1' 会进 composer。
    if (isCodexUpdatePrompt(pane)) {
      if (now - w.codexUpdateAt > 30_000) {
        w.codexUpdateAt = now;
        this.store.logEvent(issue.id, 'codex_update', { action: 'update' });
        await this.inject(session, '1');
      }
      return; // 弹窗未消失前不 kickoff/不催（prompt 会被弹窗吃掉）
    }

    // 代理存活门禁（issue #97）：**tmux 会话活着 ≠ 代理在跑**。代理退出（崩溃、登录过期、
    // 被 Ctrl-C、codex 自更新）后窗格里只剩 bash，而 #88 的自愈只认「会话没了」这一档，
    // 于是 kickoff/催办/澄清续跑照旧 send-keys——整段 prompt 被 shell 当命令执行。
    // 判定为 shell：本 tick **不注入任何东西**，按冷却强制重启（relaunch 无短路，
    // 而 activate 会因「会话还在」直接 return）。
    // 判死硬闸：jsonl 最近还在长 = 代理活着（它可能只是在跑一条前台 Bash 工具，屏幕和
    // pane_current_command 双双像 shell——生产实测靠这两个信号会误杀，见 agent-liveness 常量注释）
    const liveness = await this.sessionLiveness(issue.agent, session, pane, now - w.growTs);
    if (liveness === 'shell') {
      await this.handleAgentDown(issue, w, session, now);
      return;
    }
    if (liveness === 'live') w.agentRestarts = 0; // 确认活着 = 上一轮故障已翻篇

    const sel = detectSelection(pane);
    if (sel) {
      // Wave3 审批管道钩子（每 tick 回调，外层按菜单签名去重；异常落事件不逃逸）
      try {
        this.deps.onMenu?.({ issue, project, session, sel, pane });
      } catch (e) {
        this.store.logEvent(issue.id, 'error', { where: 'onMenu', error: String(e).slice(0, 200) });
      }
      if (!w.menuSince) w.menuSince = now;
      else if (now - w.menuSince > this.cfg.menuStuckMs && !w.menuNotified) {
        w.menuNotified = true;
        this.store.logEvent(issue.id, 'menu_stuck', { context: sel.context.slice(0, 300) });
        await this.notifySafe({
          kind: 'issue_blocked',
          projectId: issue.projectId,
          issueId: issue.id,
          summaryCode: 'menu_stuck',
          summaryParams: {
            minutes: Math.round(this.cfg.menuStuckMs / 60000),
            context: sel.context.slice(0, 120),
          },
        });
      }
    } else {
      if (w.menuSince) {
        // 菜单刚消失（有→无 一次性转沿）：审批管道重置去重签名
        try {
          this.deps.onMenuGone?.(session);
        } catch (e) {
          this.store.logEvent(issue.id, 'error', { where: 'onMenuGone', error: String(e).slice(0, 200) });
        }
      }
      w.menuSince = 0;
      w.menuNotified = false;
    }

    // kickoff（幂等 + 单飞 + 启动下限 + 无弹窗 + I4 就绪真检测）。
    // 就绪判据：jsonl 已可定位（两家 CLI 启动即建会话文件）或 pane 出现输入框特征
    // （claude：❯ / ╭─ 边框；codex：› 提示符 / OpenAI Codex 横幅——0.144 实测）。
    const path = await this.deps.locator.locate(convId);
    const paneReady = paneHasAgentUi(issue.agent, pane); // 与存活判定共用同一套 UI 特征
    const ccReady = path !== null || paneReady;
    const fedBefore = w.fedTs;
    await this.maybeKickoff(issue, project, w, session, sel !== null, ccReady);

    // 重启接续（issue #97）：代理被重启后**等它真就绪**再补一次催办，让它接着干上一轮的活。
    // 就绪判据只认 paneReady（输入框真画出来了），**不能用 ccReady**——重启走的是
    // `--resume`，jsonl 早就在了，`path !== null` 证明不了新进程已经起来，照它注入就是
    // 往还在启动的终端里盲打。有弹窗时也先不接续（prompt 会被弹窗吃掉），留着 flag 下轮再说。
    // 若这一 tick 刚好被 kickoff 发了正式的阶段 prompt（fedTs 变了），接续就没必要了。
    if (w.resumePending && paneReady && !sel && w.fedTs === fedBefore) {
      w.resumePending = false;
      const resumed = this.store.get(issue.id);
      if (resumed && DRIVING_STATES.includes(resumed.status)) {
        const subs = this.store.subtasksOf(resumed);
        const seqPending =
          resumed.implMode === 'seq' &&
          subs.length > 0 &&
          resumed.subIndex < subs.length &&
          !this.isRework(resumed);
        await this.inject(
          session,
          buildNudge({
            issue: resumed,
            stage: resumed.status as 'planning' | 'implementing' | 'testing',
            seqPending,
            locale: this.promptLocale(resumed, project),
          }),
        );
        w.fedTs = this.now();
        w.nudged = false;
        this.store.logEvent(resumed.id, 'agent_resumed', { stage: resumed.status });
      }
    }

    // tail 新输出 → 协议解析推进
    if (path) {
      const t = await tailConversation(this.reader, path, w.offset, 0);
      if (t.offset > w.offset) {
        // growTs 观测文件健康度，任何增长都刷新；activityTs 只认代理侧进展。
        w.growTs = now;
        const agentProgress =
          t.msgs.length === 0 ||
          t.msgs.some(
            (m) =>
              m.role === 'assistant' ||
              m.role === 'thinking' ||
              m.role === 'tool_use' ||
              m.role === 'tool_result',
          );
        if (agentProgress) {
          w.activityTs = now;
          w.nudged = false;
          w.doneChecked = 0;
        }
      }
      w.offset = t.offset;
      if (t.msgs.length > 0) {
        // Wave3 进度管道钩子（引擎 tail 是唯一事件源，外层别再 tail；异常落事件不逃逸）
        try {
          this.deps.onConvMessages?.(issue, project, t.msgs);
        } catch (e) {
          this.store.logEvent(issue.id, 'error', {
            where: 'onConvMessages',
            error: String(e).slice(0, 200),
          });
        }
        await this.ingest(issue.id, t.msgs, w, session);
      }
    }

    // limit 退避期：不催不判（tail 已照常消费，退避期哨兵仍生效——与 v1 语义一致）
    if (w.waitUntil && now < w.waitUntil) return;
    if (w.waitUntil && now >= w.waitUntil) {
      w.waitUntil = 0;
      w.nudged = false; // 到期靠 nudge 催活（v1 隐式路径显式化）
    }

    // 会话失效检测 + 自动重新认领（issue #48）：注入后 sessionStaleMs 内绑定 jsonl
    // 零增长、pane 却有 CC 输入框特征 → 绑定的多半是死会话（生产实锤两型：#41 撞限
    // 退出后人工重启换进程、#47 时区错绑旧 rollout）。重新发现当前活跃会话重绑；
    // 重绑后从新文件末尾起 tail（换绑前旧输出不回读，防旧哨兵重放）并立刻催一次，
    // 让代理重发哨兵/子任务块。要求已 nudge 过（先催后认领：连 nudge 都没让文件动
    // 才有资格判死，排除长思考中来不及落盘的误伤）。
    if (
      this.cfg.sessionStaleMs > 0 &&
      path &&
      paneReady &&
      !sel &&
      w.nudged &&
      w.growTs < w.fedTs &&
      now - w.fedTs > this.cfg.sessionStaleMs &&
      now - w.reclaimAt > this.cfg.sessionStaleMs
    ) {
      w.reclaimAt = now;
      let np: string | null = null;
      try {
        np = (await this.deps.locator.reclaim?.(convId)) ?? null;
      } catch (e) {
        this.store.logEvent(issue.id, 'error', { where: 'reclaim', error: String(e).slice(0, 200) });
      }
      if (np && np !== path) {
        const st = await this.reader.statPath(np).catch(() => null);
        w.offset = st?.size ?? 0;
        w.growTs = this.now();
        this.store.logEvent(issue.id, 'session_reclaimed', { path: np });
        const fresh2 = this.store.get(issue.id);
        if (fresh2 && DRIVING_STATES.includes(fresh2.status)) {
          const subs2 = this.store.subtasksOf(fresh2);
          const seqPending2 =
            fresh2.implMode === 'seq' && subs2.length > 0 && fresh2.subIndex < subs2.length && !this.isRework(fresh2);
          await this.inject(
            session,
            buildNudge({
              issue: fresh2,
              stage: fresh2.status as 'planning' | 'implementing' | 'testing',
              seqPending: seqPending2,
              locale: this.promptLocale(fresh2, project),
            }),
          );
          w.fedTs = this.now();
          this.store.logEvent(fresh2.id, 'nudged', { stage: fresh2.status, reclaim: true });
        }
        return; // 本 tick 到此为止，静默判定下轮再说（fedTs 已刷新）
      }
      if (!np) {
        this.store.logEvent(issue.id, 'error', { where: 'reclaim', error: '未发现可认领的活跃会话' });
      }
    }

    // 静默三级：nudge（180s）→ PM 保守判（360s，每 360s 重判防一次误判卡死）
    const fresh = this.store.get(issue.id);
    if (!fresh || !DRIVING_STATES.includes(fresh.status)) return;

    // 执行中澄清等待（spec 1/2）：代理输出 NEED_CLARIFY 后停催停判，静静等用户回答；
    // 超过 clarifyTimeoutMs 仍没答 → 注入「按最佳判断继续」+ 记 clarify_timeout + 复位续跑。
    const wait = this.store.execClarifyWait(fresh.id);
    if (wait) {
      if (now - wait.since >= this.cfg.clarifyTimeoutMs) {
        await this.inject(session, buildClarifyContinue(this.promptLocale(fresh, project)));
        this.store.logEvent(fresh.id, 'clarify_timeout', { stage: fresh.status });
        w.fedTs = this.now();
        w.activityTs = this.now();
        w.nudged = false;
        w.doneChecked = 0;
      }
      return; // 未到点：既不 nudge 也不 judge
    }

    const idleMs = now - Math.max(w.fedTs, w.activityTs);
    const quiet = idleMs > this.cfg.nudgeSec * 1000 && !sel;
    if (quiet && !w.nudged) {
      const subs = this.store.subtasksOf(fresh);
      const seqPending = fresh.implMode === 'seq' && subs.length > 0 && fresh.subIndex < subs.length && !this.isRework(fresh);
      const msg = buildNudge({
        issue: fresh,
        stage: fresh.status as 'planning' | 'implementing' | 'testing',
        seqPending,
        locale: this.promptLocale(fresh, project),
      });
      await this.inject(session, msg);
      w.nudged = true;
      w.fedTs = this.now();
      this.store.logEvent(fresh.id, 'nudged', { stage: fresh.status });
    } else if (
      quiet &&
      idleMs > this.cfg.fallbackSec * 1000 &&
      now - w.doneChecked > this.cfg.fallbackSec * 1000
    ) {
      w.doneChecked = now;
      await this.judgeFallback(fresh, project, path, session, w);
    }
  }

  /** kickoff：进入阶段后的首条 prompt。幂等判据 = 该阶段进入事件之后是否已有 injected 事件 */
  private async maybeKickoff(
    issue: EngineIssue,
    project: Project,
    w: WatchState,
    session: string,
    hasMenu: boolean,
    ccReady: boolean,
  ): Promise<void> {
    if (w.kickInFlight) return; // 每对话单飞守卫
    if (hasMenu) return;
    if (this.now() - w.bootTs < this.cfg.kickoffMinBootMs) return;
    const stage = issue.status;
    const entryId = this.store.lastEnterEventId(issue.id, stage);
    if (this.store.hasInjectedSince(issue.id, stage, entryId)) return; // 重启/重连安全
    if (!ccReady) {
      // I4：CC 未就绪（jsonl 未落地 且 pane 无输入框特征）——prompt 打进 bash 会被当
      // shell 命令执行。等就绪；超时（默认 120s，从本进程开始盯（bootTs）计）→ block 交人工。
      if (this.now() - w.bootTs > this.cfg.kickoffReadyTimeoutMs) {
        await this.applyEvent(issue.id, 'block', {
          note: `CC 启动超时：${Math.round(this.cfg.kickoffReadyTimeoutMs / 1000)}s 未就绪（jsonl 未落地且无输入框特征）`,
        });
      }
      return;
    }
    w.kickInFlight = true;
    try {
      const fresh = this.store.get(issue.id);
      if (!fresh || fresh.status !== stage) return;
      let workspace: EngineExecutionWorkspace;
      try { workspace = await this.resolveExecutionWorkspace(fresh, project); }
      catch (e) {
        this.store.logEvent(fresh.id, 'error', {
          where: 'execution-workspace', error: String(e).slice(0, 200),
        });
        await this.applyEvent(fresh.id, 'block', { note: '执行工作区不可用' });
        return;
      }
      const built = this.buildKickoffPrompt(fresh, project, workspace);
      if (!built) return;
      await this.inject(session, built.text);
      this.store.logEvent(fresh.id, 'injected', { stage, ...built.meta });
      w.fedTs = this.now();
      w.nudged = false;
    } finally {
      w.kickInFlight = false;
    }
  }

  private isRework(issue: EngineIssue): boolean {
    const entry = this.store.lastEnterInfo(issue.id, 'implementing');
    return entry?.event === 'tests_failed' || entry?.event === 'review_rejected';
  }

  private absImages(workspace: EngineExecutionWorkspace, issue: EngineIssue): string[] {
    if (!issue.imagesJson) return [];
    try {
      const arr = JSON.parse(issue.imagesJson) as string[];
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((p) => typeof p === 'string' && p)
        .map((p) => (p.startsWith('/') ? p : `${workspace.cwd.replace(/\/+$/, '')}/${p}`));
    } catch {
      return [];
    }
  }

  private promptLocale(issue: EngineIssue, project: Project): SupportedLocale {
    return userPromptLocale(this.deps.db, issue.createdBy, project.ownerUserId);
  }

  private buildKickoffPrompt(
    issue: EngineIssue,
    project: Project,
    workspace: EngineExecutionWorkspace,
  ): { text: string; meta: Record<string, unknown> } | null {
    const branch = issue.branch ?? ''; // 进 implementing 时已记下目标分支或历史 issue 的当前分支
    const imgHint = imageReadHint(this.absImages(workspace, issue));
    const locale = this.promptLocale(issue, project);
    switch (issue.status) {
      case 'planning': {
        const entry = this.store.lastEnterInfo(issue.id, 'planning');
        const feedback = entry?.event === 'plan_rejected' ? (entry.note ?? '') : null;
        const pendingEntry = this.store.lastEnterInfo(issue.id, 'pending');
        const recoveryEvent = pendingEntry?.event === 'unblock'
          ? [...this.store.listEvents(issue.id)].reverse().find((event) => event.kind === 'unblock_guidance')
          : undefined;
        let recoveryGuidance = '';
        if (recoveryEvent?.dataJson) {
          try {
            const data = JSON.parse(recoveryEvent.dataJson) as { guidance?: unknown };
            if (typeof data.guidance === 'string') recoveryGuidance = data.guidance;
          } catch {
            // 损坏的历史审计事件不应阻断规划；退化为普通 planning。
          }
        }
        const recovery = recoveryGuidance
          ? {
              guidance: recoveryGuidance,
              subtasks: this.store.subtasksOf(issue).map((subtask) =>
                `${subtask.done ? '[已完成] ' : ''}${subtask.text}`,
              ),
            }
          : null;
        const segmentPending =
          this.store.lastEventId(issue.id, 'conversation_segment_started') >
          this.store.lastEventId(issue.id, 'injected');
        const moduleName =
          issue.moduleId && segmentPending
            ? this.deps.db
                .query<{ display_name: string }, [number]>(
                  'SELECT display_name FROM project_modules WHERE id = ?',
                )
                .get(issue.moduleId)?.display_name
            : null;
        return {
          text: buildPlanningPrompt({ issue, goal: project.goal, feedback, recovery, imgHint, moduleName, locale }),
          meta: { kind: 'planning', ...(feedback ? { rework: true } : {}), ...(recovery ? { recovery: true } : {}) },
        };
      }
      case 'implementing': {
        const entry = this.store.lastEnterInfo(issue.id, 'implementing');
        if (entry && (entry.event === 'tests_failed' || entry.event === 'review_rejected')) {
          return {
            text: buildReworkPrompt({
              issue,
              feedback: entry.note ?? '',
              branch,
              source: entry.event === 'tests_failed' ? 'tests_failed' : 'review_rejected',
              locale,
            }),
            meta: { kind: 'rework', source: entry.event },
          };
        }
        const subtasks = this.store.subtasksOf(issue).map((s) => s.text);
        if (issue.implMode === 'team') {
          return {
            text: buildTeamPrompt({ issue, subtasks, goal: project.goal, branch, imgHint, locale }),
            meta: { kind: 'team', n: subtasks.length },
          };
        }
        const idx = issue.subIndex;
        if (!subtasks[idx]) return null; // 无子任务可喂（异常态，等 nudge/人工）
        return {
          text: buildSubtaskPrompt({ issue, subtasks, idx, branch, locale }),
          meta: { kind: 'subtask', idx },
        };
      }
      case 'testing':
        return { text: buildTestingPrompt({ issue, branch, locale }), meta: { kind: 'testing' } };
      default:
        return null;
    }
  }

  /**
   * 消费一批新消息：哨兵只认 assistant 文本、整行匹配、核 id/stage；
   * limit 检测在协议解析**之后**（解耦，同批哨兵不丢）。
   * （public 以便测试直接投喂；生产只有 tick 调用）
   */
  async ingest(issueId: number, msgs: ChatMessage[], w: WatchState | null, session: string): Promise<void> {
    const texts = extractAssistantTexts(msgs);
    if (texts.length > 0) {
      await this.handleAssistantTexts(issueId, texts, session);
      // limit 识别（解析后判；只看 assistant 文本）
      const fresh = this.store.get(issueId);
      if (fresh && DRIVING_STATES.includes(fresh.status) && texts.some((t) => looksRateLimited(t))) {
        if (w && !w.waitUntil) {
          w.waitUntil = this.now() + this.cfg.limitBackoffMs;
          this.store.logEvent(issueId, 'limit', { backoffMs: this.cfg.limitBackoffMs });
          await this.notifySafe({
            kind: 'status_change',
            projectId: fresh.projectId,
            issueId,
            summaryCode: 'rate_limited',
            summaryParams: {
              title: fresh.title.slice(0, 60),
              minutes: Math.round(this.cfg.limitBackoffMs / 60000),
            },
          });
        }
      }
    }
  }

  private async handleAssistantTexts(issueId: number, texts: string[], session: string): Promise<void> {
    const issue = this.store.get(issueId); // 重读最新状态（哨兵与判定竞态的读端）
    if (!issue || !DRIVING_STATES.includes(issue.status)) return;
    if (this.store.activeExecutionSyncBoundary(issueId)
      || this.store.hasUnresolvedExecutionSyncEffect(issueId)) return;
    const id = issue.id;

    // ISSUE_BLOCKED 在任何驱动阶段都认
    for (const t of texts) {
      const b = findBlocked(t, id);
      if (b) {
        this.store.logEvent(id, 'sentinel', { kind: 'blocked', note: b.note });
        await this.applyEvent(id, 'block', { note: b.note || '(未说明)' });
        return;
      }
    }

    // NEED_CLARIFY 在任何驱动阶段都认：代理声明「必须先问清才能继续」→ 记问题(source:exec)+通知，
    // 不推进状态（停在原地等用户回答或超时自动继续，watcher 据 execClarifyWait 停催停判）。
    // 幂等：已在等待中（execClarifyWait 非空）不重复记/推——避免每 tick 重复。
    if (texts.some((t) => findNeedClarify(t, id))) {
      if (!this.store.execClarifyWait(id)) {
        const hits = texts.filter((t) => findNeedClarify(t, id));
        const qs = hits.flatMap((t) => parseClarifyQuestions(t));
        const questions = [...new Set(qs)].slice(0, MAX_CLARIFY_QUESTIONS); // 多条文本各自抽，去重保序
        // 原文留档（#110）：清单项之外的前提/现状散文也要给用户看全
        const text = extractClarifyText(hits.join('\n\n'));
        await this.enterExecClarify(issue, issue.status, questions, 'sentinel', text);
        const w = issue.convId ? this.watch.get(issue.convId) : undefined;
        if (w) w.nudged = false; // 清掉残留催促态，等待期不再触发 nudge
      }
      return; // 不推进：等用户回答或超时
    }

    switch (issue.status) {
      case 'planning': {
        for (const t of texts) {
          const subs = parseSubtasksBlock(t);
          if (subs) {
            const held = this.store.setSubtasksAtDesignBoundary(id, subs);
            this.store.logEvent(id, 'sentinel', { kind: 'subtasks', n: subs.length });
            if (held) return;
            await this.applyEvent(id, 'plan_ready');
            return;
          }
        }
        return;
      }
      case 'implementing': {
        let stageDone = texts.some((t) => findStageDone(t, id, 'implementing'));
        const subs = this.store.subtasksOf(issue);
        const seqDriving = issue.implMode === 'seq' && subs.length > 0 && !this.isRework(issue);
        if (seqDriving && !stageDone) {
          let n = texts.reduce((acc, t) => acc + countSubtaskDone(t, id), 0);
          let advanced = false;
          while (n > 0) {
            n--;
            const r = this.store.advanceSubtaskAtDesignBoundary(id);
            if (!r) break;
            advanced = true;
            this.store.logEvent(id, 'subtask_done', { idx: r.nextIdx - 1 });
            if (r.held) return;
            if (r.allDone) {
              stageDone = true;
              break;
            }
          }
          if (advanced && !stageDone) {
            // 喂下一个子任务
            const fresh = this.store.get(id);
            const project = fresh ? this.project(fresh.projectId) : undefined;
            if (fresh && project && fresh.status === 'implementing') {
              const list = this.store.subtasksOf(fresh).map((s) => s.text);
              const idx = fresh.subIndex;
              if (list[idx]) {
                const prompt = buildSubtaskPrompt({
                  issue: fresh,
                  subtasks: list,
                  idx,
                  branch: fresh.branch ?? `issue/${fresh.id}`,
                  locale: this.promptLocale(fresh, project),
                });
                await this.inject(session, prompt);
                this.store.logEvent(id, 'injected', { stage: 'implementing', kind: 'subtask', idx });
                const w = fresh.convId ? this.watch.get(fresh.convId) : undefined;
                if (w) {
                  w.fedTs = this.now();
                  w.nudged = false;
                }
              }
            }
          }
        }
        if (stageDone) {
          this.store.markAllSubtasksDone(id);
          this.store.logEvent(id, 'sentinel', { kind: 'stage_done', stage: 'implementing' });
          await this.applyEvent(id, 'impl_done');
        }
        return;
      }
      case 'testing': {
        if (texts.some((t) => findStageDone(t, id, 'testing'))) {
          this.store.logEvent(id, 'sentinel', { kind: 'stage_done', stage: 'testing' });
          await this.applyEvent(id, 'tests_passed');
          return;
        }
        let failed: { note: string } | null = null;
        for (const t of texts) {
          failed = findTestsFailed(t, id);
          if (failed) break;
        }
        if (failed) {
          // 含本次。只数**本轮**的失败：复活（#93）等于重新开始，上一轮攒下的失败次数不能
          // 继续压在头上——否则一条曾经失败 3 次被取消的 issue，复活后第一次失败就直接 blocked。
          const failCount =
            this.store.countEventsSince(id, 'tests_failed', this.store.lastEventId(id, 'reopened')) + 1;
          this.store.logEvent(id, 'tests_failed', { note: failed.note, failCount });
          await this.applyEvent(id, 'tests_failed', { failCount, note: failed.note || '测试未通过' });
        }
        return;
      }
      default:
        return;
    }
  }

  /** 三级判定第 3 级：PM 保守判（读-判-重读-CAS，applyEvent 的 CAS 即重读端） */
  private async judgeFallback(
    issue: EngineIssue,
    project: Project,
    path: string | null,
    session: string,
    w: WatchState,
  ): Promise<void> {
    if (!path) return;
    const msgs = await readRecentMessages(this.reader, path, this.cfg.judgeWindowBytes);
    const recent = msgs
      .filter((m) => m.role === 'assistant' || m.role === 'tool_result')
      .map((m) => m.text || m.result || '')
      .join('\n')
      .slice(-this.cfg.judgeTailChars);
    if (!recent.trim()) return;
    let j: EngineDoneJudgement;
    try {
      j = await this.deps.pmFor(project).judgeDone(issue, recent);
    } catch (e) {
      this.store.logEvent(issue.id, 'error', { where: 'judgeDone', error: String(e).slice(0, 200) });
      return;
    }
    this.store.logEvent(issue.id, 'judged', { stage: issue.status, result: j });
    if (j === 'done') {
      if (issue.status === 'implementing') {
        this.store.markAllSubtasksDone(issue.id);
        await this.applyEvent(issue.id, 'impl_done', { note: '空闲兜底：PM 判定已完成' });
      } else if (issue.status === 'testing') {
        await this.applyEvent(issue.id, 'tests_passed', { note: '空闲兜底：PM 判定已完成' });
      } else if (issue.status === 'planning') {
        // planning：判 done 但没解析到 SUBTASKS 块 = 无计划产物，不能直接推进；
        // 也不能保守不动（#41/#47 无限 judged=done 死循环实锤）。出口：先催代理
        // 按格式重新输出（前 2 次），连续第 3 次仍无块 → 转 blocked 交人工
        // （applyEvent 自带 issue_blocked 通知）。计数以事件为凭，重启不丢。
        const entryId = this.store.lastEnterEventId(issue.id, 'planning');
        const strikes = this.store.consecutiveJudgedDone(issue.id, entryId);
        if (strikes >= 3) {
          await this.applyEvent(issue.id, 'block', {
            note: `planning 连续 ${strikes} 次判完成但未收到 SUBTASKS 块（产物丢失或格式不符），转人工`,
          });
        } else {
          await this.inject(session, buildReplanRequest(this.promptLocale(issue, project)));
          this.store.logEvent(issue.id, 'replan_requested', { strikes });
          w.fedTs = this.now();
          w.nudged = false; // 重置催促状态：重输出指令后允许常规 nudge 再催
        }
      }
    } else if (j === 'clarify') {
      // 第二层保险：代理在向用户提问/等输入，却没规范输出 NEED_CLARIFY 哨兵（哨兵路径在
      // handleAssistantTexts 先行拦截）。标记等待（问题尽力从最近输出抽取，可空）+ 通知；
      // 不 nudge 不 block，交给 execClarifyWait 的停催/20 分钟超时接管。幂等：已在等待中不重复。
      if (!this.store.execClarifyWait(issue.id)) {
        await this.enterExecClarify(
          issue,
          issue.status,
          parseClarifyQuestions(recent),
          'judge',
          extractClarifyText(recent),
        );
        w.nudged = false;
      }
    } else if (j === 'blocked') {
      await this.applyEvent(issue.id, 'block', { note: '空闲兜底：PM 判定疑似卡住/在等输入' });
    }
  }

  /**
   * 进入「执行中等待用户澄清」：记 clarify_questions(source:exec, stage, via[, text]) + 推送通知。
   * 两条检测路径共用（哨兵 NEED_CLARIFY / PM 空闲兜底判 clarify），保证事件形状与文案一致。
   * 调用方保证幂等（先查 execClarifyWait 非空则不再进入），本方法不做去重。
   * text = 代理原话全文（#110，已剔哨兵行/截断；空则不落该字段，旧事件形状不变）。
   */
  private async enterExecClarify(
    issue: EngineIssue,
    stage: IssueState,
    questions: string[],
    via: 'sentinel' | 'judge',
    text?: string,
  ): Promise<void> {
    this.store.logEvent(issue.id, 'clarify_questions', {
      source: 'exec',
      stage,
      questions,
      via,
      ...(text ? { text } : {}),
    });
    await this.notifySafe({
      kind: 'status_change',
      projectId: issue.projectId,
      issueId: issue.id,
      summaryCode: 'clarification_needed',
      summaryParams: {
        title: issue.title.slice(0, 40),
        body: bodyExcerpt(issue.body),
        questions: questions.map((q, i) => `${i + 1}. ${q}`).join('\n'),
        minutes: Math.round(this.cfg.clarifyTimeoutMs / 60000),
      },
    });
  }

  // ---- 注入 / 通知 ----

  /** 唯一注入出口：per-session 互斥（评审 H9），PM/路由请复用同一把锁（tmuxLockKey） */
  private inject(session: string, text: string): Promise<void> {
    return this.deps.mutex.runExclusive(tmuxLockKey(session), () =>
      this.deps.driver.sendKeys(session, text),
    );
  }

  private async notifySafe(ev: EngineNotifyEvent): Promise<void> {
    try {
      await this.deps.notify.dispatch(ev);
    } catch (e) {
      // 通知失败不阻断状态机，但要可见（评审铁律：失败要么上抛要么落事件）
      this.store.logEvent(ev.issueId, 'notify_error', { kind: ev.kind, error: String(e).slice(0, 200) });
    }
  }
}
