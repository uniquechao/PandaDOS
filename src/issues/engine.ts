import { effectiveSkillPolicy, skillSessionSettings, saveSkillPolicy, type SkillPolicy } from '../core/skill-policy';
import { agentHomesFromClaudeDir, listGlobalSkills, listProjectSkills } from '../core/skills';
import { validationIdentity, validationCheckKey } from './validation-identity';
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
import { ensureSyncUids } from '../core/project-data';
import { ensureProjectDataOutboxTriggers } from '../core/project-data-outbox';
import { MAX_ISSUE_BODY_CHARS } from './limits';
import { AgentExecutableNotFoundError } from '../core/conversations';
import { projectAgentSupport } from '../core/executors';
import { buildFallbackIdentity, ensureGitIdentity } from '../core/git-identity';
import { migrate, type MigrationStatus } from '../core/migrate';
import { parseAutoApproveLevel, parseReasoningEffort, REASONING_EFFORTS } from '../core/types';
import { emptyUsage, type UsageTotals } from '../core/usage';
import {
  composeMergedBody,
  hasNoMergeDeclaration,
  looksTruncated,
  type MergeSnapshotEntry,
} from './merge-guards';
import {
  deriveValidationScope,
  resolveValidationCommands,
  runValidation,
  candidateTestFiles,
  VALIDATION_TIMEOUT_MS,
} from './validation';
import {
  parseCompletionReportJson,
  serializeCompletionReport,
  type CompletionReport,
} from './completion-report';
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
  ReasoningEffort,
  ValidationCommand,
  ValidationScope,
} from '../core/types';
import type { ExecutorDriver, GitResult } from '../executor/driver';
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
import { isResumableState, transition, type IssueMachineEvent } from './machine';
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
  parseCompletionReportBlock,
  parseSubtasksBlock,
  RATE_LIMIT_BACKOFF_MS,
} from './sentinel';
import {
  buildClarifyContinue,
  buildNudge,
  buildPlanningPrompt,
  buildDirectPrompt,
  buildRecoveryResumePrompt,
  buildReplanRequest,
  buildReworkPrompt,
  buildSubtaskPrompt,
  buildTeamPrompt,
  buildTestingPrompt,
  imageReadHint,
} from './prompts';
import { attentionKindOf, type AttentionKind } from './attention';
import { clarifyPaths, clarifySessionName } from './clarify-runner';
import {
  buildBlockedSummary,
  buildDoneSummary,
  MAX_SUMMARY_CHARS,
} from './result-summary';
import { parseOrganizePlan, type OrganizeAction } from './organize-runner';
import { BUSY_STATES, isBusy, moduleKeyOf, pickNext } from './queue';
import { gitLockKey, KeyedMutex, projectLockKey, tmuxLockKey } from './mutex';
import { outputLanguageInstruction, promptLanguage, userPromptLocale } from '../agents/prompts/language';
import { moduleIssueRelPath } from './module-docs';
import { parseModuleSkills } from './modules';
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

/** 澄清失败事件里 pane 尾部的留档上限（#280；诊断够用即可，别把事件表撑爆） */
export const MAX_CLARIFY_PANE_TAIL_CHARS = 1200;

/** issue 引擎的增量迁移目录（issues/migrations/030_*.sql） */
export const ISSUE_ENGINE_MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

/**
 * 应用 issue 引擎的增量迁移（issues.module/impl_mode 列 + project_active_conv 表）。
 * 集成接线：server 启动时在核心 `migrate(db)` 之后调用一次；幂等可重复执行
 * （编号 030 记录在同一张 schema_migrations，与核心 001 不冲突）。
 */
export function migrateIssueEngine(db: Database): MigrationStatus {
  const status = migrate(db, ISSUE_ENGINE_MIGRATIONS_DIR);
  ensureSyncUids(db, [
    { table: 'project_modules', timestampColumn: 'created_ts' },
    { table: 'issues', timestampColumn: 'created_ts' },
    { table: 'project_workflow_templates', timestampColumn: 'created_ts' },
  ]);
  ensureProjectDataOutboxTriggers(db, [
    { table: 'project_modules', kind: 'module', archivedWhen: "NEW.status = 'archived'" },
    { table: 'issues', kind: 'issue', archivedWhen: "NEW.status = 'cancelled'" },
    { table: 'project_workflow_templates', kind: 'workflow', archivedWhen: "NEW.status = 'archived'" },
  ]);
  return status;
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
  executionMode?: 'direct' | 'planned';
  /** 驱动本 issue 的 CLI 代理；绑对话后不可改（对话 agent 生命周期内不变） */
  agent: AgentKind;
  /** 置顶时刻（ms）；null = 未置顶。仅影响 pending 排队顺序（queue.pickNext 置顶层） */
  pinnedTs: number | null;
  /** 创建时执行代理的反馈（理解/思路/风险，033 迁移）；null = 尚未分析或失败 */
  clarifyFeedback: string | null;
  /** 收尾（done/blocked）时执行代理的结果总结（033 迁移）；null = 尚未总结或失败 */
  resultSummary: string | null;
  /** 044：可机读的 v1 完成报告；旧记录及无效数据均回退为 null。 */
  completionReport: CompletionReport | null;
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
  /** 这段挂在哪条会话上（#277 轮换后模块会有多条 conv，前端据此区分「不在当前会话里」） */
  convId: string;
  issueId: number;
  title: string;
  status: IssueState;
  startTs: number;
  endTs: number | null;
}

/** 驱动中的阶段：cc 进程在干活、watcher 要 tail 的状态 */
export const DRIVING_STATES: readonly IssueState[] = ['planning', 'implementing', 'testing'];

/**
 * 受阻恢复的阶段降级：`merge_review` / `merging` 这两个阶段**没有代理参与**——
 * 完成报告在 testing 阶段由哨兵写死后收尾不再重取（collectResultSummary 明确不清它），
 * 总结也是确定性拼装。因此从这两个阶段受阻时，解除意见既送不到代理
 * （buildKickoffPrompt 的恢复注入只覆盖驱动阶段），报告也不会变，
 * 解除后必然在同一个完成度门禁上再次受阻 —— 反复解除只会空转烧钱。
 *
 * 降级到 `testing`：这是能让代理重新验证并重发 REPORT_BEGIN 报告的最近阶段，
 * 解除意见也能随恢复提示送达。其余阶段保持原样。
 */
export function demoteAgentlessResume(state: IssueState): IssueState {
  return state === 'merging' || state === 'merge_review' ? 'testing' : state;
}

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
export const EDITABLE_STATES: readonly IssueState[] = ['pending', 'blocked', 'paused', 'cancelled'];

export function isEditableStatus(status: IssueState): boolean {
  return EDITABLE_STATES.includes(status);
}

/** EDITABLE_STATES 的 SQL 字面量（给 CAS 的 IN 用，跟着常量走不会漂） */
const EDITABLE_STATES_SQL = EDITABLE_STATES.map((s) => `'${s}'`).join(', ');

// ---------- 骨架接口的结构化镜像（不 import agents/notify 实现，评审 5.4#1 依赖方向） ----------

/** PM 完成判定的取值（#275 / B-09：不含 'blocked'，那个分支从来走不到，已删） */
export type EngineDoneJudgement = 'done' | 'not_done' | 'clarify';

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
  judgeAgentFailure?(agent: AgentKind, pane: string): Promise<'resume_conflict' | 'ordinary_exit' | 'unknown'>;
  /**
   * 可选：同模块任务智能合并（LLM）。引擎调度前对同模块 pending 候选调用，拿到合并建议后
   * 确定性折叠（校验/取消/改 body 全在引擎侧）。未实现（老 stub/离线）→ 引擎跳过合并。
   */
  mergeModuleTasks?(module: string, candidates: EngineMergeCandidate[]): Promise<EngineMergeGroup[]>;
  /**
   * 可选：收尾摘要的**降级**出口（#275 / I-05）。引擎优先用结构化数据确定性拼装，
   * 只有一个字都拼不出来（既没报告、没子任务、没提交、没失败事件）时才调这里。
   * 未实现（老 stub/离线）→ 引擎退到一句确定性兜底文案，不影响收尾。
   */
  summarizeOutcome?(input: {
    title: string;
    kind: 'done' | 'blocked';
    facts: string;
    locale?: SupportedLocale;
  }): Promise<string | null>;
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
  /**
   * 分析超时（ms，#280 / B-06）：由引擎按 `clarifyRunTimeoutMs` 下发，装配层必须真的传给
   * runner——不传就会退回 runner 自己的 8 分钟默认值，生产上正是这么白跑了 49 次。
   */
  timeoutMs?: number;
  locale?: SupportedLocale;
}

/** 创建时澄清分析结果（issues/clarify-runner RunClarifyResult 结构一致） */
/**
 * 一条 issue 的成本视图数据（#282 / I-08）：token 用量 + 非 token 类指标。
 *
 * token 侧来自 `issue_usage`（采集器按 segment 边界归因，见 core/usage-collector）；
 * 非 token 侧全部**按事件溯源派生**，不加列——这些数早就都在 `issue_events` 里了，
 * 再存一份只会多一个会对不上的真相。
 */
export interface IssueCostStats {
  issueId: number;
  usage: UsageTotals;
  /** 测试返工次数（tests_failed） */
  testRetries: number;
  /** 催办次数（nudged） */
  nudges: number;
  /** PM 兜底判定次数（judged） */
  judged: number;
  /** 创建时澄清分析跑过几次（clarify_started） */
  clarifies: number;
  /** 门禁执行总耗时（#279 的 validation_passed/failed 的 durationMs 求和，ms） */
  validationMs: number;
  /** 门禁跑过几轮 */
  validationRuns: number;
}

/** 澄清分析的现场证据（#280 / B-06；结构同 core/agent-artifact-runner 的 diagnostics） */
export interface EngineClarifyDiagnostics {
  paneTail: string;
  files: Array<{ name: string; size: number }>;
  hadArtifacts: number;
  elapsedMs: number;
}

export type EngineClarifyResult =
  | {
      ok: true;
      feedback: string;
      questions: string[];
      questionsText?: string;
      /** done 标记没出现但产物已落盘，按抢救结果用（#280） */
      salvaged?: true;
      diagnostics?: EngineClarifyDiagnostics;
    }
  | { ok: false; reason: string; error?: string; diagnostics?: EngineClarifyDiagnostics };

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
  kind: 'status_change' | 'gate_waiting' | 'issue_done' | 'issue_blocked' | 'choice_waiting';
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
    | 'auto_retry_exhausted'
    | 'stop_loss_paused'
    | 'regression_failed'
    | 'clarify_success_low'
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
  sync_uid?: string | null;
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
  execution_mode?: string;
  agent: string;
  /** 032 迁移；SELECT * 在旧库上可能拿不到该列，映射时兜底 null */
  pinned_ts?: number | null;
  /** 033 迁移；同上，旧库兜底 null */
  clarify_feedback?: string | null;
  result_summary?: string | null;
  /** 044 迁移；旧库或旧记录均允许为空。 */
  completion_report_json?: string | null;
  /** 036 迁移；同上，旧库兜底 null */
  target_branch?: string | null;
  source_ref?: string | null;
  /** 038 迁移；同上，旧库兜底 'medium'（= 既有审批管道行为） */
  auto_approve?: string | null;
  /** 039 迁移；发布节点禁止自动合并。 */
  publication_locked?: number | null;
  /** 047 迁移；旧库/未算过均为 null */
  validation_scope_json?: string | null;
  /** 048 迁移；旧库/未覆盖均为 null（= 继承模块） */
  reasoning_effort?: string | null;
  /** 045 迁移；协作过程页路径，旧库/未同步为 null */
  doc_path?: string | null;
}

/**
 * 门禁范围列的解析（047 / #279）：**坏数据一律当未配置**。
 * 读不出来就退回全量门禁（调用方语义），比整块抛错安全——门禁宁可多跑，不能不跑。
 */
export function parseValidationScope(json: string | null): ValidationScope | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const kind = o.kind === 'targeted' ? 'targeted' : o.kind === 'full' ? 'full' : o.kind === 'docs' ? 'docs' : null;
    if (!kind) return null;
    const files = Array.isArray(o.files)
      ? o.files.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map((f) => f.trim())
      : [];
    return {
      kind,
      files: kind === 'full' ? [] : files,
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 300) : '',
    };
  } catch {
    return null;
  }
}

/** 项目门禁命令列的解析（047）：坏数据当未配置（null），不当成「不跑门禁」（空数组） */
export function parseValidationCommands(json: string | null): ValidationCommand[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return null;
    const out: ValidationCommand[] = [];
    for (const raw of v) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const o = raw as Record<string, unknown>;
      const argv = Array.isArray(o.argv)
        ? o.argv.filter((a): a is string => typeof a === 'string' && a.length > 0)
        : [];
      if (argv.length === 0) continue; // 空命令没有意义，直接丢
      out.push({ label: typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, 60) : argv[0]!, argv });
    }
    return out;
  } catch {
    return null;
  }
}

function mapIssue(r: IssueRow): EngineIssue {
  return {
    id: r.id,
    ...(r.sync_uid ? { syncUid: r.sync_uid } : {}),
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
    executionMode: r.execution_mode === 'direct' ? 'direct' : 'planned',
    agent: r.agent === 'codex' ? 'codex' : 'claude',
    pinnedTs: r.pinned_ts ?? null,
    clarifyFeedback: r.clarify_feedback ?? null,
    resultSummary: r.result_summary ?? null,
    completionReport: parseCompletionReportJson(r.completion_report_json),
    targetBranch: r.target_branch ?? null,
    sourceRef: r.source_ref ?? null,
    // 认不出的值（旧库无此列/脏数据）落回 'medium'——issue 侧的现状行为，不因脏数据变严或变松
    autoApprove: parseAutoApproveLevel(r.auto_approve) ?? 'medium',
    publicationLocked: (r.publication_locked ?? 0) === 1,
    validationScope: parseValidationScope(r.validation_scope_json ?? null),
    reasoningEffort: parseReasoningEffort(r.reasoning_effort ?? null),
    docPath: r.doc_path ?? null,
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
  sync_uid?: string | null;
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
  /** 047 迁移；旧库/未配置均为 null（= 按 package.json 探测，不等于「不跑门禁」） */
  validation_commands_json?: string | null;
}

export function mapProject(r: ProjectRow): Project {
  return {
    id: r.id,
    ...(r.sync_uid ? { syncUid: r.sync_uid } : {}),
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
    validationCommands: parseValidationCommands(r.validation_commands_json ?? null),
    kind: 'issue',
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

/**
 * 「远端有我没有的提交」这一类 push 失败的判据（#272 / B-02）：fetch + rebase 后重试一次通常就过。
 * 认得宽一点是刻意的——多试一次 fetch/rebase 的代价，远小于「done 了但代码没进远端」。
 */
const PUSH_REJECTED_RE = /\[rejected\]|fetch first|non-fast-forward|updates were rejected/i;

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
  executionMode?: 'direct' | 'planned';
  skillPolicy?: SkillPolicy;
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

/**
 * 这次改动是谁发起的（#283 / B-11）。
 *
 * 别再靠内容比对猜：协作文件同步回写与用户编辑改出来的 diff 长得一模一样，猜错的代价是
 * **白跑一次创建时澄清**（#270 实测同一条 issue 连跑两次，两次都是 questions=0）。
 * 缺省 'user'：老调用方行为不变，新的同步类写入必须显式传 'sync'。
 */
export type IssueEditSource = 'user' | 'sync';

export interface IssueMetaPatch {
  /** 改动来源（#283 / B-11）；不落库，只影响「要不要重新澄清」这类副作用 */
  source?: IssueEditSource;
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
  resumeState?: string;
  /** #274：这次 blocked 是止损闸自己打的，计数时必须排除，否则闸会自我放大 */
  stopLoss?: boolean;
} {
  if (!dataJson) return {};
  try {
    return JSON.parse(dataJson) as Record<string, never>;
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
        input.body ? input.body.slice(0, MAX_ISSUE_BODY_CHARS) : null,
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
    this.db.run('UPDATE issues SET execution_mode = ? WHERE id = ?', [input.executionMode ?? 'planned', row.id]);
    this.logEvent(row.id, 'created', { title: row.title });
    return this.get(row.id)!;
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
    return this.get(row.id)!;
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
        || input.next.body.length === 0 || input.next.body.length > MAX_ISSUE_BODY_CHARS) {
        throw new Error('invalid design sync Issue content');
      }
      const project = this.db.query<{ id: number; status: string }, [number]>(
        'SELECT id, status FROM projects WHERE id = ?',
      ).get(fresh.projectId);
      if (!project || project.status !== 'active') {
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
   * 例外：**模块会话可被同模块 issue 顺序复用**（project_modules.conversation_id 持久持有），
   * 所以占用者只要已不在驱动中（典型是 blocked，或缺少恢复上下文而暂入 pending 的），就放行——否则一条
   * blocked 会永久攥着模块会话，让该模块再也起不来。真正的「同时只有一条在跑」由项目级
   * isBusy 保证，不靠这里。非模块会话（debug/项目对话）仍按老规矩独占。
   *
   * #277 / I-01 之后这条豁免退居**兜底**：正常情况下 startIssue 会给每条 issue 轮换一条新
   * conv（见 moduleConvInUse），根本走不到共用；只有「旧会话还挂着未结束的 segment」时才
   * 不轮换，那时仍要靠这里放行。所以豁免不能收紧——一收紧，那条崩在半路的 blocked 就把
   * 整个模块锁死了。
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
    this.db.query('UPDATE issues SET body = ? WHERE id = ?').run(body.slice(0, MAX_ISSUE_BODY_CHARS), id);
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

  /**
   * 本轮门禁范围（047 / #279）：进 testing 时算出来落库，供 UI 展示与复跑。
   * null = 清空（回到「还没算过」）；文件清单截到 200 条，防一次巨改把整列撑爆。
   */
  setValidationScope(id: number, scope: ValidationScope | null): void {
    const value = scope
      ? JSON.stringify({
          kind: scope.kind,
          files: scope.kind === 'full' ? [] : scope.files.slice(0, 200),
          reason: scope.reason.slice(0, 300),
        })
      : null;
    this.db.query('UPDATE issues SET validation_scope_json = ? WHERE id = ?').run(value, id);
  }

  /** 读回本轮门禁范围（坏数据当没配过，调用方据此退回全量） */
  validationScope(id: number): ValidationScope | null {
    const r = this.db
      .query<{ validation_scope_json: string | null }, [number]>(
        'SELECT validation_scope_json FROM issues WHERE id = ?',
      )
      .get(id);
    return parseValidationScope(r?.validation_scope_json ?? null);
  }

  /**
   * 项目门禁命令（047）：null = 清回「未配置」（由控制面按 package.json 探测），
   * 空数组 = 显式「不跑门禁」。两者语义不同，不许在这里合并。
   */
  setValidationCommands(projectId: number, commands: ValidationCommand[] | null): void {
    const value = commands
      ? JSON.stringify(
          commands
            .filter((c) => c.argv.length > 0)
            .slice(0, 10)
            .map((c) => ({ label: c.label.slice(0, 60), argv: c.argv.slice(0, 20) })),
        )
      : null;
    this.db.query('UPDATE projects SET validation_commands_json = ? WHERE id = ?').run(value, projectId);
  }

  /**
   * 本条 issue 的推理档覆盖（048 / #281）：null = 清空，回到继承模块。
   * 非法值直接拒绝——存进去只会在启动命令里变成一个谁也不认识的参数。
   */
  setIssueReasoningEffort(id: number, effort: ReasoningEffort | null): void {
    if (effort !== null && !REASONING_EFFORTS.includes(effort)) {
      throw new Error(`非法推理档位: ${String(effort)}`);
    }
    this.db.query('UPDATE issues SET reasoning_effort = ? WHERE id = ?').run(effort, id);
  }

  /** 结构化完成报告（044）；写入前按 v1 契约规范化，null = 清空。 */
  setCompletionReport(id: number, report: CompletionReport | null): void {
    this.db
      .query('UPDATE issues SET completion_report_json = ? WHERE id = ?')
      .run(report ? serializeCompletionReport(report) : null, id);
  }

  patchMeta(id: number, meta: IssueMetaPatch): void {
    if (meta.title !== undefined) this.db.query('UPDATE issues SET title = ? WHERE id = ?').run(meta.title.slice(0, 200), id);
    if (meta.body !== undefined) this.db.query('UPDATE issues SET body = ? WHERE id = ?').run(meta.body ? meta.body.slice(0, MAX_ISSUE_BODY_CHARS) : null, id);
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
          convId,
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
          convId,
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

  /**
   * 一个模块的**全部** segment，跨会话汇总（#277 / I-01）。
   *
   * 轮换之后一个模块的历史散在多条 conv 上，只按当前 conv 读会让人以为「换了对话记录就没了」。
   * 收口在 store 这一层：把该模块沾过的每条 conv 都读一遍，按开始时间拼成一条时间线，
   * 每段自带 convId，前端据此区分「这段在当前会话里」还是「在更早的会话里」。
   */
  listModuleSegments(moduleId: number): ConversationSegment[] {
    const convIds = this.db
      .query<{ conv_id: string }, [number]>(
        `SELECT DISTINCT conv_id FROM issues WHERE module_id = ? AND conv_id IS NOT NULL`,
      )
      .all(moduleId)
      .map((r) => r.conv_id);
    // 模块指针刚轮换、还没有 issue 绑上来的那条也要算进去，否则新会话在时间线上是空的
    const current = this.db
      .query<{ conversation_id: string | null }, [number]>(
        'SELECT conversation_id FROM project_modules WHERE id = ?',
      )
      .get(moduleId)?.conversation_id;
    if (current && !convIds.includes(current)) convIds.push(current);
    return convIds
      .flatMap((convId) => this.listConversationSegments(convId))
      .sort((a, b) => a.startTs - b.startTs || a.issueId - b.issueId);
  }

  /**
   * 最近一次门禁结果（#279）：给详情页只读展示用。
   * 从事件里派生，不加列——门禁可以跑很多轮，列只能存最后一次，事件本来就全都有。
   */
  lastValidation(issueId: number): {
    outcome: 'passed' | 'failed' | 'skipped' | 'error';
    scope: 'targeted' | 'full' | 'docs' | null;
    label: string | null;
    code: number | null;
    timedOut: boolean;
    durationMs: number | null;
    ts: number;
  } | null {
    const kinds = new Set(['validation_passed', 'validation_failed', 'validation_skipped', 'validation_error']);
    let latest: IssueEvent | null = null;
    for (const e of this.listEvents(issueId)) {
      if (kinds.has(e.kind) && (!latest || e.id > latest.id)) latest = e;
    }
    if (!latest) return null;
    let d: Record<string, unknown> = {};
    try {
      d = latest.dataJson ? (JSON.parse(latest.dataJson) as Record<string, unknown>) : {};
    } catch {
      d = {}; // 坏事件只丢细节，不丢「跑过一轮」这件事
    }
    const scope = d.scope === 'targeted' ? 'targeted' : d.scope === 'full' ? 'full' : d.scope === 'docs' ? 'docs' : null;
    return {
      outcome: latest.kind === 'validation_passed'
        ? 'passed'
        : latest.kind === 'validation_failed' ? 'failed' : latest.kind === 'validation_error' ? 'error' : 'skipped',
      scope,
      label: typeof d.label === 'string' ? d.label : null,
      code: typeof d.code === 'number' ? d.code : null,
      timedOut: d.timedOut === true,
      durationMs: typeof d.durationMs === 'number' ? d.durationMs : null,
      ts: latest.ts,
    };
  }

  /**
   * 这条 issue 参与过的合并是否被人拆回过（#289 / B-14）。
   *
   * 拆回是一次明确的人工否决：「这几条不该并」。所以拆回过的 issue 不再进自动合并候选，
   * 否则下一轮调度立刻又并回去，拆了个寂寞。
   */
  wasUnmerged(issueId: number): boolean {
    return this.listEvents(issueId)
      .some((e) => e.kind === 'tasks_unmerged' || e.kind === 'unmerged_from');
  }

  /**
   * 最近一次**还没被拆回过**的合并（#289 / B-14）：拆回的依据。
   *
   * 事件溯源：取最后一条带快照的 `tasks_merged`，若其后出现 `tasks_unmerged` 则说明已经拆过，
   * 不给拆第二次（否则会把手工改过的正文又覆盖回旧快照）。老数据没有 snapshot 字段 → 拆不了，
   * 如实返回 null（发起人已明确：历史误合并不做人工补救）。
   */
  lastUnmergeableMerge(issueId: number): {
    eventId: number;
    snapshot: MergeSnapshotEntry[];
  } | null {
    let merged: { eventId: number; snapshot: MergeSnapshotEntry[] } | null = null;
    for (const e of this.listEvents(issueId)) {
      if (e.kind === 'tasks_unmerged') {
        merged = null;
        continue;
      }
      if (e.kind !== 'tasks_merged') continue;
      let snapshot: MergeSnapshotEntry[] = [];
      try {
        const data = JSON.parse(e.dataJson ?? '{}') as { snapshot?: unknown };
        snapshot = Array.isArray(data.snapshot)
          ? data.snapshot.flatMap((raw) => {
            if (!raw || typeof raw !== 'object') return [];
            const entry = raw as Record<string, unknown>;
            if (typeof entry.id !== 'number' || typeof entry.title !== 'string') return [];
            return [{
              id: entry.id,
              title: entry.title,
              body: typeof entry.body === 'string' ? entry.body : null,
              clarifyFeedback: typeof entry.clarifyFeedback === 'string' ? entry.clarifyFeedback : null,
            }];
          })
          : [];
      } catch {
        snapshot = [];
      }
      merged = snapshot.length >= 2 ? { eventId: e.id, snapshot } : null;
    }
    return merged;
  }

  /**
   * 这条 issue 有没有**尚未消费**的解除意图（#283 / B-10）。
   *
   * 事件溯源，不加列：以最后一条 `unblock_requested` 为准（重复提交天然幂等，
   * 以最后一次的 guidance 为准），若其后出现 `unblock_request_cancelled` 或真正的
   * `unblock` transition，则意图已作废。issue 已经不是 blocked 也一律作废——
   * 它可能被取消、被手动开跑，这时候再自动恢复就是「用户没让我做的事」。
   */
  pendingUnblockRequest(issueId: number): PendingUnblockRequest | null {
    const issue = this.get(issueId);
    if (!issue || (issue.status !== 'blocked' && issue.status !== 'paused')) return null;
    let request: { data: Record<string, unknown>; ts: number } | null = null;
    for (const e of this.listEvents(issueId)) {
      if (e.kind === 'unblock_requested') {
        let data: Record<string, unknown> = {};
        try {
          data = e.dataJson ? (JSON.parse(e.dataJson) as Record<string, unknown>) : {};
        } catch {
          data = {};
        }
        request = { data, ts: e.ts };
        continue;
      }
      if (e.kind === 'unblock_request_cancelled') request = null;
      // 真正恢复过一次之后，之前的意图当然不再有效（又被 block 回来则以新意图为准）
      if (e.kind === 'unblock_guidance') request = null;
    }
    if (!request) return null;
    const guidance = typeof request.data.guidance === 'string' ? request.data.guidance : '';
    if (!guidance.trim()) return null;
    const resumeState = typeof request.data.resumeState === 'string'
      ? (request.data.resumeState as IssueState)
      : null;
    return {
      issueId,
      guidance,
      resumeState,
      actor: typeof request.data.actor === 'number' ? request.data.actor : null,
      ts: request.ts,
    };
  }

  /**
   * 本项目所有待消费的解除意图，**按与 pickNext 同样的口径排序**：置顶优先（后置顶在前），
   * 其余按 id（= 创建顺序）FIFO。恢复一条受阻的比开一条新的更值得优先——那条已经花过钱了。
   */
  listPendingUnblockRequests(projectId: number): PendingUnblockRequest[] {
    const blocked = this.listByProject(projectId).filter((i) => i.status === 'blocked' || i.status === 'paused');
    const out: Array<PendingUnblockRequest & { pinnedTs: number | null }> = [];
    for (const issue of blocked) {
      const request = this.pendingUnblockRequest(issue.id);
      if (request) out.push({ ...request, pinnedTs: issue.pinnedTs });
    }
    return out
      .sort((a, b) => {
        if (a.pinnedTs !== b.pinnedTs) {
          if (a.pinnedTs === null) return 1;
          if (b.pinnedTs === null) return -1;
          return b.pinnedTs - a.pinnedTs; // 后置顶的在前，与 queue.orderPending 同口径
        }
        return a.issueId - b.issueId;
      })
      .map(({ pinnedTs: _pinned, ...rest }) => rest);
  }

  /**
   * 一条 issue 的成本视图数据（#282 / I-08）：`issue_usage` 的 token 用量 + 事件溯源的非 token 指标。
   *
   * 口径统一在这一处：UI 与离线核对都读它，别在调用方各自数一遍事件——那样迟早会出现
   * 「详情页说重试 3 次、成本页说 2 次」这种谁也说不清的分歧。
   */
  issueCostStats(issueId: number): IssueCostStats {
    const usageRow = this.db
      .query<{
        requests: number; input_tokens: number; cached_input_tokens: number; output_tokens: number;
        reasoning_tokens: number; compactions: number; tool_calls: number; skill_reads: number;
      }, [number]>('SELECT * FROM issue_usage WHERE issue_id = ?')
      .get(issueId);
    const usage: UsageTotals = usageRow
      ? {
        requests: usageRow.requests,
        inputTokens: usageRow.input_tokens,
        cachedInputTokens: usageRow.cached_input_tokens,
        outputTokens: usageRow.output_tokens,
        reasoningTokens: usageRow.reasoning_tokens,
        compactions: usageRow.compactions,
        toolCalls: usageRow.tool_calls,
        skillReads: usageRow.skill_reads,
      }
      : emptyUsage(); // 还没扫到 = 全零，不是「没有这条 issue」

    // 门禁耗时：durationMs 落在 validation_passed / validation_failed 的事件数据里
    let validationMs = 0;
    let validationRuns = 0;
    for (const e of this.db
      .query<{ data_json: string | null }, [number]>(
        `SELECT data_json FROM issue_events
          WHERE issue_id = ? AND kind IN ('validation_passed', 'validation_failed')`,
      )
      .all(issueId)) {
      validationRuns++;
      try {
        const d = JSON.parse(e.data_json ?? '{}') as { durationMs?: unknown };
        if (typeof d.durationMs === 'number' && Number.isFinite(d.durationMs) && d.durationMs > 0) {
          validationMs += Math.trunc(d.durationMs);
        }
      } catch {
        /* 坏事件只丢这一轮的耗时，不影响轮次计数 */
      }
    }

    return {
      issueId,
      usage,
      testRetries: this.countEvents(issueId, 'tests_failed'),
      nudges: this.countEvents(issueId, 'nudged'),
      judged: this.countEvents(issueId, 'judged'),
      clarifies: this.countEvents(issueId, 'clarify_started'),
      validationMs,
      validationRuns,
    };
  }

  /**
   * 项目维度「最近 N 次创建时澄清」的成功率（#280 / B-06）。
   *
   * 口径：一次分析的**终局**只有两种——`clarify_done`（成功，含抢救来的）与
   * `error{where:'clarify'}`（失败）。`clarify_skipped` / `clarify_discarded` 是「还没跑就作废」，
   * 既不算成功也不算失败，必须排除，否则告警会被一堆取消掉的 issue 稀释成永远不触发。
   * 事件溯源，不加表：窗口按事件 id 倒序取 N 条。
   */
  clarifySuccessRate(projectId: number, window: number): { ok: number; total: number; rate: number } {
    const rows = this.db
      .query<{ kind: string; data_json: string | null }, [number, number]>(
        `SELECT e.kind, e.data_json FROM issue_events e
           JOIN issues i ON i.id = e.issue_id
          WHERE i.project_id = ?
            AND (e.kind = 'clarify_done' OR (e.kind = 'error' AND e.data_json LIKE '%"where":"clarify"%'))
          ORDER BY e.id DESC LIMIT ?`,
      )
      .all(projectId, Math.max(1, window));
    const total = rows.length;
    const ok = rows.filter((r) => r.kind === 'clarify_done').length;
    return { ok, total, rate: total === 0 ? 1 : ok / total };
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
  /**
   * 这条会话「还有人用着吗」（#277 / I-01）——模块会话轮换的唯一判据：只有没人用了，
   * 才允许把模块指针挪到一条新 conv（每条 issue 一段独立 transcript）。
   *
   * 两条判据缺一不可：
   * - **还有未结束的 segment**：典型是 blocked/崩溃后没来得及落 `conversation_segment_ended`
   *   的那条，它的半截上下文仍挂在这条会话上，此刻换 conv 等于把人家的活儿扔了；
   * - **还有在驱动中的占用者**：上线前的历史数据根本没有 segment 事件，只看事件会把一条
   *   正跑着的会话判成「没人用」，轮换后两条 issue 同名 tmux 互相踩。
   */
  moduleConvInUse(convId: string): boolean {
    const busy = BUSY_STATES.map((s) => `'${s}'`).join(', ');
    return !!this.db
      .query<{ n: number }, [string]>(
        `SELECT 1 AS n FROM issues i
          WHERE i.conv_id = ?
            AND ((SELECT COALESCE(MAX(e.id), 0) FROM issue_events e
                   WHERE e.issue_id = i.id AND e.kind = 'conversation_segment_started')
                > (SELECT COALESCE(MAX(e.id), 0) FROM issue_events e
                   WHERE e.issue_id = i.id AND e.kind = 'conversation_segment_ended')
                 OR i.status IN (${busy}))
          LIMIT 1`,
      )
      .get(convId);
  }

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
      .query('UPDATE issues SET plan_json = NULL, subtasks_json = NULL, sub_index = 0, note = NULL, done_ts = NULL, result_summary = NULL, completion_report_json = NULL WHERE id = ?')
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
  lastEnterInfo(
    issueId: number,
    stage: IssueState,
  ): { event: string; from: string; note?: string; resumeState?: string; stopLoss?: boolean } | null {
    for (const e of this.recentEvents(issueId, 'transition')) {
      const d = parseTransData(e.dataJson);
      if (d.to === stage) {
        return {
          event: d.event ?? '',
          from: d.from ?? '',
          ...(d.note ? { note: d.note } : {}),
          ...(d.resumeState ? { resumeState: d.resumeState } : {}),
          ...(d.stopLoss ? { stopLoss: true } : {}), // #274：这次 blocked 是止损闸打的
        };
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

  /**
   * 自 sinceEventId 以来末尾**连续同结论**的 judged 次数（#273 / B-04 的退避依据）。
   * `consecutiveJudgedDone` 的推广：那个写死只认 `done`，这个认「最后一次是什么结论就
   * 数到什么结论断掉为止」，于是 not_done 反复轮询也能被退避住。
   *
   * 返回 `{ result, streak }`；没有可数的 judged（或事件损坏）时 result 为 null、streak 0。
   * 结论一变 streak 归 1，退避间隔随之落回基准——判定结论变了说明现场在动，不该继续拉长。
   */
  consecutiveJudged(
    issueId: number,
    sinceEventId: number,
  ): { result: string | null; streak: number } {
    let result: string | null = null;
    let streak = 0;
    for (const e of this.recentEvents(issueId, 'judged')) {
      if (e.id <= sinceEventId) break;
      let current: string | null = null;
      try {
        const parsed = (JSON.parse(e.dataJson ?? '{}') as { result?: unknown }).result;
        if (typeof parsed === 'string' && parsed) current = parsed;
      } catch {
        break; // 事件损坏：宁可少数一次（退避变短），也不要把不同结论串成一条
      }
      if (current === null) break;
      if (result === null) result = current;
      else if (current !== result) break;
      streak++;
    }
    return { result, streak };
  }

  /**
   * 止损闸的三项计数（#274 / I-06），一次遍历 transition 事件全部算出来：
   *
   * - `blockCount`：进入 blocked 的次数，**排除止损自己打的那些**（transition 数据带
   *   `stopLoss: true`）。不排除的话闸会自我放大——暂停一次计数就 +1，人工恢复后立刻又够阈值。
   * - `stageReentry`：**重新**进入 `stage` 的次数 = 进入次数 - 1。减这个 1 不是凑数：
   *   `plan_approved → implementing` 这种首次进入不是「重入」，把它算进去会让阈值 3 在
   *   第 2 次 tests_failed 就触发，把正常的测试回退循环（MAX_TEST_FAILURES=3）整个吃掉。
   * - `runtimeMs`：**只累计停留在 BUSY 状态的时长**。停在 blocked/pending 等人的那段不算——
   *   那是用户的响应时间，不该由 issue 来背。
   *
   * 一律事件溯源、按 sinceEventId 截断（锚点之后重新计），重启不丢；
   * 事件损坏就跳过那一条，宁可少算（晚一点触发）也不要把闸算早。
   */
  stopLossStats(
    issueId: number,
    sinceEventId: number,
    stage: IssueState,
    now: number,
  ): { blockCount: number; stageReentry: number; runtimeMs: number } {
    const all = this.recentEvents(issueId, 'transition', 500).reverse(); // 按时间正序走
    const after = all.filter((e) => e.id > sinceEventId);
    let blockCount = 0;
    let stageEntries = 0;
    for (const e of after) {
      const d = parseTransData(e.dataJson);
      if (!d.to) continue;
      if (d.to === 'blocked' && d.stopLoss !== true) blockCount++;
      if (d.to === stage) stageEntries++;
    }

    // 时长的计时窗口比事件窗口多一段头：锚点（人工确认继续）当时 issue 已经被 unblock
    // 回到了某个 BUSY 阶段，而那条 transition 的 id 小于锚点、不在 `after` 里。少了这一段，
    // 恢复之后只要没有新的状态迁移，运行时长就永远算 0——运行时长闸会在第一次恢复后直接哑掉。
    const segments: Array<{ ts: number; to: string }> = [];
    if (sinceEventId > 0) {
      const anchorTs = this.db
        .query<{ ts: number }, [number]>('SELECT ts FROM issue_events WHERE id = ?')
        .get(sinceEventId)?.ts;
      const prior = all.filter((e) => e.id <= sinceEventId);
      const lastBefore = prior.length > 0 ? parseTransData(prior[prior.length - 1]!.dataJson) : null;
      if (anchorTs !== undefined && lastBefore?.to) segments.push({ ts: anchorTs, to: lastBefore.to });
    }
    for (const e of after) {
      const d = parseTransData(e.dataJson);
      if (d.to) segments.push({ ts: e.ts, to: d.to });
    }
    let runtimeMs = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (!BUSY_STATES.includes(seg.to as IssueState)) continue;
      // 这段区间的状态就是 seg.to，直到下一段（没有下一段就算到此刻）
      const until = segments[i + 1]?.ts ?? now;
      if (until > seg.ts) runtimeMs += until - seg.ts;
    }
    return { blockCount, stageReentry: Math.max(0, stageEntries - 1), runtimeMs };
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
  directExecution: boolean;
  /** 安静多久后催哨兵（v1 AUTOPILOT_NUDGE_SEC=180 平移） */
  nudgeSec: number;
  /** 安静多久后 PM 保守判定（v1 AUTOPILOT_FALLBACK_SEC=360 平移） */
  fallbackSec: number;
  /**
   * 单 issue 催办次数上限（#273 / B-03）。到顶不再催，落 nudge_exhausted + 通知转人工，
   * **不 block**——催不动多半是代理在长跑或真卡住，把 issue 打死只会丢掉现场。
   * 与 `judgeMaxCount` **各算各的**，但任一到顶就彻底停催停判、静等人工。
   * 计数锚点见 `attentionAnchor`：人一插手就重新给预算。
   * ≤0 = 关闭催办（测试用），不等同于「已耗尽」。
   */
  nudgeMaxCount: number;
  /** 催办退避的间隔封顶（#273）：`nudgeSec * 2^已催次数` 再高也不超过它 */
  nudgeMaxIntervalSec: number;
  /**
   * 单 issue PM 兜底判定次数上限（#273 / B-04）；到顶落 judge_exhausted + 通知转人工。
   * 与 `nudgeMaxCount` **各算各的**，但任一到顶就彻底停催停判、静等人工。
   * ≤0 = 关闭判定（测试用），不等同于「已耗尽」。
   */
  judgeMaxCount: number;
  /** 判定退避的间隔封顶（#273）：`fallbackSec * 2^同结论连击` 再高也不超过它 */
  judgeMaxIntervalSec: number;
  /**
   * reclaim 连续失败多少次后判定「会话确已丢失」（#273 / B-05），转 agent_down 恢复路径
   * （重启 + 既有次数上限），而不是每分钟空转重扫。
   */
  reclaimMaxFailures: number;
  /** reclaim 退避冷却的封顶（#273）：`sessionStaleMs * 2^连续失败数` 再高也不超过它 */
  reclaimMaxCooldownMs: number;
  /**
   * 止损闸（#274 / I-06）：累计进入 blocked 多少次就暂停。**只数非止损来源的那些**——
   * 止损自己打的 blocked 带 `stopLoss` 标记，把它计进去闸就会自我放大（暂停一次 → 计数 +1
   * → 人工恢复后立刻又够阈值）。
   */
  stopLossBlockCount: number;
  /** 止损闸：BUSY 状态累计运行多久就暂停。不计停在 blocked/pending 等人的那段时间。 */
  stopLossRuntimeMs: number;
  /** 止损闸：同一阶段重入多少次就暂停（规划↔实现↔测试来回打转的形态） */
  stopLossStageReentry: number;
  /**
   * 执行中澄清等待的自动继续时限（spec 第 2 点）：代理输出 NEED_CLARIFY 后进入「等待用户澄清」，
   * 引擎停催停判；超过此时长仍没等到答复 → 注入「按最佳判断继续」并记 clarify_timeout 复位续跑。
   */
  /**
   * 「等**用户**回答澄清问题」的超时：到点注入「按最佳判断继续」，与分析本身无关。
   * **别拿它当分析超时用**——#280 之前生产上真正触发的是 runner 的 8 分钟默认值，
   * 而这个 20 分钟的常量根本没接到 runner 上，导致根因排查一路跑偏。
   */
  clarifyTimeoutMs: number;
  /**
   * 「创建时澄清**分析**本身」的超时（#280 / B-06）：clr-<id> 独立会话从注入提示词起算，
   * 到点仍没写出 done 就收尾（产物已落盘的会被抢救）。与上面那条是两个不同的闸。
   */
  clarifyRunTimeoutMs: number;
  /**
   * 创建时澄清成功率告警（#280 / B-06）：最近 `clarifyAlertWindow` 次分析里成功率低于
   * `clarifyAlertRate` 就发一次通知；不足窗口条数不告警（样本太少的比率没有意义）。
   * 阈值可配置，别硬编码——发起人拍板的默认值是「最近 10 次 < 50%」。
   * `clarifyAlertCooldownMs <= 0` 或窗口 <= 0 = 关掉告警。
   */
  clarifyAlertWindow: number;
  clarifyAlertRate: number;
  clarifyAlertCooldownMs: number;
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
   * 收尾摘要的开关（>0 启用，0 关闭；#275 / I-05 之后**不再是超时**）。
   *
   * 历史包袱：这个字段原本是「注入总结 prompt 后轮询文件哨兵的总超时」。I-05 把整轮满窗
   * 注入换成了确定性拼装，已经没有任何东西需要计时，但 45 处既有用例靠 `0` 来关掉
   * 「收尾摘要 + 完成度门禁」，改名的收益远小于churn，故保留字段名、只改语义。
   * 关掉它 = 不拼摘要、也不做「原始目标是否全部达成」的门禁（merging→done 直接放行）。
   */
  resultSummaryTimeoutMs: number;
  /**
   * 门禁执行的单条命令超时（ms）；**0 = 整个门禁执行关闭**（引擎不跑，直接放行到收尾）。
   * 关掉它就回到 #279 之前的口径：门禁由代理在会话里自己跑，引擎只认哨兵。
   */
  validationTimeoutMs: number;
  /** 时钟注入（测试用） */
  now: () => number;
  /** sleep 注入（测试用；与 now 配套做确定性轮询） */
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  directExecution: true,
  // 2026-07-27 提速：生产库统计 292 次 nudge ≈ 14.6h 纯空等，下调到 120/240。
  // #279 之后这个下限的**理由变了**：门禁已经搬到会话外（ValidationRunner 经 Driver 直跑），
  // 代理不再需要为了跑 typecheck / bun test 静默一两分钟，所以「不能低于 90s 门禁串跑时长」
  // 这条旧约束已经作废。现在的下限只由「代理自己一次工具调用/一次长思考的正常静默」定，
  // 120 仍然够用；真要再压低，先量一遍代理侧的静默分布，别再拿门禁耗时当依据。
  nudgeSec: 120,
  fallbackSec: 240,
  // #273：本周 274 次催办、单条最多 71 次（272 分钟，约 $21）。每次 nudge 都是一次带
  // 100k+ 上下文的完整模型请求，所以退避比封顶更省——5 次的实际跨度是
  // 2+4+8+16+32 ≈ 62 分钟，覆盖绝大多数真·长跑，超出就该人来看一眼了。
  nudgeMaxCount: 5,
  nudgeMaxIntervalSec: 30 * 60,
  // 单条 issue 曾在 384 分钟里判了 97 次、结论全是 not_done。与催办同为 5 次
  // （发起人拍板：两条各算 5 次，任一到顶就彻底停催停判、静等人工）。
  judgeMaxCount: 5,
  judgeMaxIntervalSec: 60 * 60,
  reclaimMaxFailures: 3,
  reclaimMaxCooldownMs: 10 * 60 * 1000,
  // #274：本周归因到 Issue 的支出里 49%（约 $106）花在最终 cancelled 的任务上。
  // 三个阈值都取需求正文给的默认值，可由 EngineConfig 覆盖，不硬编码。
  stopLossBlockCount: 3,
  stopLossRuntimeMs: 4 * 60 * 60 * 1000,
  stopLossStageReentry: 3,
  clarifyTimeoutMs: 20 * 60 * 1000,
  // #280：生产实测 codex 路径大量跑不满 8 分钟默认值就被判超时；发起人拍板调到 15 分钟，
  // 并且必须真的传下去——不传的话 runner 依旧用它自己的 8 分钟默认值。
  clarifyRunTimeoutMs: 15 * 60 * 1000,
  // #280：本周 53 次分析只成了 4 次（8%）却无人知晓——这类「一直在烧钱但一直没产出」的
  // 故障必须自己喊出来。冷却 6 小时：跌破之后每次失败都发一遍只会让人把通知静音。
  clarifyAlertWindow: 10,
  clarifyAlertRate: 0.5,
  clarifyAlertCooldownMs: 6 * 60 * 60 * 1000,
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
  // #279：门禁在会话外跑，单条命令的超时——全量 bun test 实测 ~70s，15 分钟是给慢机器的余量
  validationTimeoutMs: VALIDATION_TIMEOUT_MS,
  // #275 起这个值只表示「开」（见 EngineConfig 上的说明），具体数字不再有语义
  resultSummaryTimeoutMs: 90 * 1000,
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

/** 结构化菜单之外的纯文本执行确认，由审批管道在全自动档保守判定。 */
export interface EngineTextPromptCtx {
  issue: EngineIssue;
  project: Project;
  session: string;
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
  /** 自动 Git 收尾前刷新该项目已提交的 `.panda` 投影；失败必须阻止 git add/commit。 */
  flushProjectData?(projectId: number): Promise<void>;
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
    /**
     * 模块知识增量（#277 / I-01）：segment 结束时由引擎确定性写入 MODULE.md 的知识区，
     * 替代「继承上一条 issue 的 transcript」。缺省（老装配）→ 引擎跳过，不影响收尾。
     */
    recordModuleKnowledge?(
      module: ProjectModule,
      entry: { issueId: number; status: string; title: string; note?: string },
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
  /** 无结构化菜单时的纯文本确认观察口；外层负责候选识别、分级、去重与锁内复核。 */
  onTextPrompt?(ctx: EngineTextPromptCtx): void;
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
  /**
   * 连续 reclaim 失败次数（#273 / B-05）：既用来指数退避冷却，也用来判「会话确已丢失」
   * 转 agent_down。与 `agentRestarts` 同理，**必须跨 resetWatch 传递**——转 agent_down 会
   * 重启并 resetWatch，计数丢了就永远到不了上限，只会一分钟一次地空转重扫。
   * 认领成功即清零。
   */
  reclaimFailures: number;
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

/**
 * 「这次没开成」的原因分类（#283 / B-10）。
 *
 * 分两档是因为它们该被完全不同地对待：**正常排队**（项目忙、被别的 flight 抢先、issue 刚被取消）
 * 是调度器每天都要走的路径，落 error 只会把事件表塞满噪音，还让人以为系统坏了——生产库里
 * `error{where:'scheduleNext',error:'项目忙（已有 issue 在跑），先排队'}` 就是这么来的；
 * 真故障（工作区不可用、绑会话失败、开跑后状态无进展）才值得报 error。
 */
export type SchedulingDeferralReason = 'project-busy' | 'not-pending' | 'issue-gone';

export type ApplyResult =
  | { ok: true; from: IssueState; to: IssueState }
  | { ok: false; error: string; deferral?: SchedulingDeferralReason };

/** 调度来源（#283）：事件里带上它，才说得清这次接力是谁触发的 */
export type ScheduleSource = 'relay' | 'created' | 'unblock' | 'manual' | 'publication';

/**
 * 受阻解除的结果（#283）：项目忙时不再拒绝，而是把「解除意图」排队，
 * 等当前任务结束、接力跑到它时自动恢复。`queued` 就是这一档。
 */
export type UnblockResult = ApplyResult | { ok: true; queued: true; requestedTs: number };

/** 一条待消费的解除意图 */
export interface PendingUnblockRequest {
  issueId: number;
  guidance: string;
  resumeState: IssueState | null;
  actor: number | null;
  ts: number;
}

export interface ScheduleNextOptions {
  /** 必须是 moduleKeyOf(issue) 的结果（module_id 优先），别传 issues.module 文本 */
  preferModuleKey?: string;
  source?: ScheduleSource;
}

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
  /** 正在实际执行 entry action 的 issue；收尾接力不得重新挑中自身，否则会等待自己的 tail。 */
  private readonly activeIssueTransitions = new Set<number>();
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
        executionMode: proj.manualReview || selectedWorkflow ? 'planned'
          : input.executionMode ?? (this.cfg.directExecution ? 'direct' : 'planned'),
        ...(resolved
          ? { module: resolved.slug, moduleId: resolved.id, agent: resolved.agent }
          : {}),
      });
      if (input.skillPolicy) saveSkillPolicy(this.deps.db,{projectId,issueId:issue.id},input.skillPolicy);
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
    if (autoStart) await this.scheduleNext(projectId, { preferModuleKey: moduleKeyOf(issue), source: 'created' });
    if (issue.executionMode !== 'direct') this.scheduleClarify(issue.id); // 建即开跑（项目空闲）的不分析——规划阶段自会对齐
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
          await this.scheduleNext(projectId, { source: 'publication' });
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
          const actionOptions = (payload.action.options ?? {}) as {
            note?: string; failCount?: number; actor?: number;
            resumeState?: IssueState; stopLoss?: boolean;
          };
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
    if (project.status !== 'active') throw new Error('archived project cannot publish issues');
    return project;
  }

  private validatePublicationDraft(project: Project, input: DesignIssueDraft): PreparedDesignIssue {
    const nodeId = input.nodeId.trim();
    const title = input.title.trim();
    if (!nodeId || nodeId.length > 120) throw new Error('invalid publication node id');
    if (!title || title.length > 200) throw new Error('publication title must contain 1-200 characters');
    if (typeof input.body !== 'string' || input.body.length === 0 || input.body.length > MAX_ISSUE_BODY_CHARS) {
      throw new Error(`publication body must contain 1-${MAX_ISSUE_BODY_CHARS} characters`);
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
    const modules = this.deps.modulesFor?.(project);
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
      // source 只是「谁改的」这条元信息，不进 SQL 更新集
      const { targetBranch, sourceRef, source: _source, ...rest } = combined;
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

    const documentModule = resolved ?? (
      modules && updated.moduleId
        ? await modules.resolve({
            projectId: updated.projectId,
            title: updated.title,
            body: updated.body,
            agent: updated.agent,
            moduleId: updated.moduleId,
            createdBy: updated.createdBy,
          })
        : null
    );
    if (documentModule && modules) {
      await modules.recordIssue(documentModule, updated, this.store.listByProject(initial.projectId));
    }
    if (resolved && modules) {
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
          ((fresh.status === 'blocked' || fresh.status === 'paused') && index >= fresh.subIndex) ||
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
        timeoutMs: this.cfg.clarifyRunTimeoutMs,
        locale: this.promptLocale(issue, project),
      });
    } catch (e) {
      r = { ok: false, reason: 'error', error: String(e).slice(0, 200) };
    }
    if (!r.ok) {
      // 分析失败不影响排队执行（评审铁律：失败落事件可见）。
      // #280：光记 reason=timeout 等于没记——现场证据（代理卡在哪一屏、产物写没写出来、
      // 跑了多久）必须一起落库，否则下次还是只能靠猜。
      const d = r.diagnostics;
      this.store.logEvent(issueId, 'error', {
        where: 'clarify',
        reason: r.reason,
        ...(r.error ? { error: r.error.slice(0, 200) } : {}),
        ...(d
          ? {
              elapsedMs: d.elapsedMs,
              hadArtifacts: d.hadArtifacts,
              files: d.files.slice(0, 20),
              paneTail: d.paneTail.slice(-MAX_CLARIFY_PANE_TAIL_CHARS),
            }
          : {}),
      });
      await this.alertClarifySuccessRate(project, issueId);
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
      // #280：抢救来的结果照常用，但要标出来——「done 没写出来」本身是个待查的信号，
      // 混进普通成功里就再也看不见了。
      ...(r.salvaged
        ? {
            salvaged: true,
            ...(r.diagnostics
              ? { elapsedMs: r.diagnostics.elapsedMs, paneTail: r.diagnostics.paneTail.slice(-MAX_CLARIFY_PANE_TAIL_CHARS) }
              : {}),
          }
        : {}),
    });
    await this.alertClarifySuccessRate(project, issueId);
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
   * 创建时澄清成功率告警（#280 / B-06）。
   *
   * 为什么值得单独喊一嗓子：这类故障**一直在烧钱但一直没产出**——每次失败的分析都照付了
   * 一次「独立会话通读代码库」的钱，而单看一条 `error{where:'clarify'}` 没人会在意，
   * 于是本周 53 次里失败 49 次都没人发现。成功率是唯一能把它暴露出来的指标。
   *
   * 三条纪律：不足窗口条数不告警（样本太少的比率没有意义）；带冷却（跌破之后每次失败都发
   * 一遍只会让人把通知静音）；告警本身失败绝不影响澄清流程。
   */
  private async alertClarifySuccessRate(project: Project, issueId: number): Promise<void> {
    const window = this.cfg.clarifyAlertWindow;
    if (window <= 0 || this.cfg.clarifyAlertCooldownMs <= 0) return; // 关掉了
    const stat = this.store.clarifySuccessRate(project.id, window);
    if (stat.total < window) return; // 样本不足
    if (stat.rate >= this.cfg.clarifyAlertRate) return;

    const lastTs = this.store.lastProjectEventTs(project.id, 'clarify_success_low');
    if (lastTs !== null && Date.now() - lastTs < this.cfg.clarifyAlertCooldownMs) return;

    this.store.logEvent(issueId, 'clarify_success_low', {
      projectId: project.id,
      ok: stat.ok,
      total: stat.total,
      rate: Number(stat.rate.toFixed(2)),
    });
    await this.notifySafe({
      kind: 'status_change',
      projectId: project.id,
      issueId,
      summaryCode: 'clarify_success_low',
      summaryParams: { project: project.name.slice(0, 40), ok: stat.ok, total: stat.total },
    });
  }

  /**
   * 队列接力：项目空闲时按「模块聚合」挑下一条 pending 开跑（同模块优先→模块间不交错→FIFO）。
   * 开跑前先对**将要运行的那个模块**的 pending 做一次 LLM 智能合并（同模块小任务并成一条，
   * 减少反复起会话/重复读代码）。合并会 cancel 掉被并入项，其接力经 scheduling 单飞挡掉重入。
   *
   * `preferModuleKey` 必须是 `moduleKeyOf(issue)` 的结果（module_id 优先），不能直接传
   * issues.module 文本——文本列可能与模块 slug 不同步，会让「同模块连着跑」静默失效。
   */
  async scheduleNext(projectId: number, opts: ScheduleNextOptions | string = {}): Promise<void> {
    // 旧签名（第二个参数直接传 preferModuleKey）仍然可用：调用点多，一次性全改风险大于收益
    const options: ScheduleNextOptions = typeof opts === 'string' ? { preferModuleKey: opts } : opts;
    const source: ScheduleSource = options.source ?? 'relay';
    if (this.scheduling.has(projectId)) return; // 合并 cancel 触发的嵌套接力：本轮外层会收尾
    this.scheduling.add(projectId);
    const mergedHosts: number[] = [];
    try {
      let preferred = options.preferModuleKey;
      for (;;) {
        // #283：先看有没有「等项目空闲就恢复」的受阻 issue——恢复一条已经花过钱的，
        // 比开一条全新的更值得优先。**但手动置顶的 pending 又压过它**（发起人拍板）：
        // 置顶是用户当场表达的「先跑这个」，比系统的成本优化更该被尊重。
        // 消费成功后项目就忙了，本轮到此为止。
        if (await this.consumeUnblockRequest(projectId, source, preferred)) return;

        let next = pickNext(this.schedulableIssues(projectId), preferred);
        if (!next) return;
        const pickedModule = moduleKeyOf(next); // 模块身份用键（module_id 优先），不用可能过期的文本列
        // 目标模块的 pending 先智能合并，再在同模块内重挑（合并后 host 仍是最早的一条）
        mergedHosts.push(...(await this.maybeMergeModule(projectId, pickedModule)));
        next = pickNext(this.schedulableIssues(projectId), pickedModule);
        if (!next) return;

        const beforeStatus = next.status;
        const r = await this.startIssue(next.id);
        if (!r.ok) {
          // 正常排队 vs 真故障：前者是调度器每天都走的路径，落 error 只会制造噪音并掩盖真问题
          if (r.deferral) {
            this.store.logEvent(next.id, 'scheduling_deferred', {
              source,
              reason: r.deferral,
              issueId: next.id,
            });
          } else {
            this.store.logEvent(next.id, 'error', { where: 'scheduleNext', source, error: r.error });
          }
          return;
        }

        const projectIssues = this.store.listByProject(projectId);
        if (isBusy(projectIssues)) return; // 正常开跑成功：项目已有唯一 active，接力结束
        const fresh = projectIssues.find((issue) => issue.id === next.id);
        if (!fresh || fresh.status === beforeStatus) {
          // 这一档是真故障：开跑调用返回成功，issue 却没动——多半是 entry action 半路失败
          this.store.logEvent(next.id, 'error', {
            where: 'scheduleNext',
            source,
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
   * 消费一条待恢复意图（#283）：项目空闲时把「用户点过继续运行」的那条真正恢复起来。
   *
   * 走的是与手动解除**完全相同**的 `applyUnblock` 路径，所以 `unblock_guidance` 留痕、
   * resumeState 注入、止损锚点这些一个都不会少。返回 true 表示本轮已经把项目占上了。
   */
  private async consumeUnblockRequest(
    projectId: number,
    source: ScheduleSource,
    preferModuleKey?: string,
  ): Promise<boolean> {
    if (isBusy(this.store.listByProject(projectId))) return false;
    const [request] = this.store.listPendingUnblockRequests(projectId);
    if (!request) return false;
    if (this.activeIssueTransitions.has(request.issueId)) return false; // 正在迁移，等下一轮

    // 手动置顶的 pending 优先（发起人拍板）：置顶是用户当场说的「先跑这个」。
    // 受阻那条自己也被置顶时按置顶时刻比——后置顶的在前，与 queue.orderPending 同口径。
    const topPending = pickNext(this.schedulableIssues(projectId), preferModuleKey);
    if (topPending?.pinnedTs != null) {
      const requestPinnedTs = this.store.get(request.issueId)?.pinnedTs ?? null;
      if (requestPinnedTs === null || requestPinnedTs < topPending.pinnedTs) return false;
    }

    const r = await this.applyUnblock(
      request.issueId,
      request.guidance,
      request.actor ?? undefined,
    );
    if (!r.ok) {
      // 恢复失败不该把意图吃掉：留着下一轮再试，但要留痕说明这轮为什么没成
      this.store.logEvent(request.issueId, 'scheduling_deferred', {
        source,
        reason: 'unblock-failed',
        issueId: request.issueId,
        error: r.error.slice(0, 200),
      });
      return false;
    }
    this.store.logEvent(request.issueId, 'unblock_request_consumed', { source, requestedTs: request.ts });
    return true;
  }

  private schedulableIssues(projectId: number): EngineIssue[] {
    return this.store
      .listRunnableByProject(projectId)
      .filter((issue) => !this.activeIssueTransitions.has(issue.id));
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
    const runnable = this.store
      .listRunnableByProject(projectId)
      .filter((i) =>
        i.status === 'pending'
        && !this.activeIssueTransitions.has(i.id)
        && moduleKeyOf(i) === moduleKey
        && !i.convId
        && !i.publicationLocked
      );

    // #289 / B-14：范围声明与「正文疑似被截断」在**引擎侧**判掉，绝不依赖 LLM 看到——
    // 候选正文是 midTruncate 保头保尾截过的，声明写在中段就会被省略掉（#277 就是这么被合并的）。
    // 这里读的是**原始正文**，不经任何截断。
    const pending: EngineIssue[] = [];
    for (const issue of runnable) {
      const reason = hasNoMergeDeclaration(issue.body)
        ? 'no-merge-declared'
        : looksTruncated({ title: issue.title, body: issue.body, docPath: issue.docPath ?? null })
          ? 'body-truncated'
          // 拆回过的不再自动合并：人已经明确表示过「这几条不该并」，下一轮再并回去等于拆了个寂寞
          : this.store.wasUnmerged(issue.id)
            ? 'previously-unmerged'
            : null;
      if (reason) {
        this.store.logEvent(issue.id, 'merge_skipped', { issueId: issue.id, reason });
        continue;
      }
      pending.push(issue);
    }
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

  /**
   * 一键拆回（#289 / B-14）：把一次智能合并**原样退回去**。
   *
   * 只在**宿主仍未起跑（pending）**时可用（发起人拍板）：一旦开跑，宿主会话里已经按合并后的
   * 正文干过活了，这时候把正文换回去只会让代理和人各看各的版本。
   *
   * 依据是 `tasks_merged` 事件里的快照（合并时存的全文），所以：宿主恢复自己的 title/body/
   * 澄清反馈，被并项 reopen 回 pending 并各自恢复原文。已经拆过的那次合并不会被拆第二次。
   */
  async unmergeIssues(hostId: number, actor?: number): Promise<
    { ok: true; restored: number[] } | { ok: false; error: string }
  > {
    const host = this.store.get(hostId);
    if (!host) return { ok: false, error: '无此 issue' };
    if (host.status !== 'pending') {
      return { ok: false, error: `只有未开跑（待办）的宿主可以拆回（当前 ${host.status}）` };
    }
    const merge = this.store.lastUnmergeableMerge(hostId);
    if (!merge) return { ok: false, error: '这条 issue 没有可拆回的合并记录' };

    const byId = new Map(merge.snapshot.map((entry) => [entry.id, entry]));
    const hostSnapshot = byId.get(hostId);
    if (!hostSnapshot) return { ok: false, error: '合并快照缺少宿主原文，无法拆回' };

    const restored: number[] = [];
    // 宿主先复原：拆回失败时宁可停在「宿主已还原、被并项还没回来」，也不要反过来
    this.store.patchMeta(hostId, { title: hostSnapshot.title, body: hostSnapshot.body });
    this.store.setClarifyFeedback(hostId, hostSnapshot.clarifyFeedback ?? null);

    for (const entry of merge.snapshot) {
      if (entry.id === hostId) continue;
      const folded = this.store.get(entry.id);
      if (!folded) continue; // 被删了，跳过——拆回是尽力而为，不能因为一条没了就整体失败
      if (folded.status === 'cancelled') {
        const r = await this.applyEvent(entry.id, 'reopen', {
          ...(actor !== undefined ? { actor } : {}),
        }, () => {
          this.store.clearRunState(entry.id);
          this.store.patchMeta(entry.id, { title: entry.title, body: entry.body });
          this.store.setClarifyFeedback(entry.id, entry.clarifyFeedback ?? null);
          this.store.logEvent(entry.id, 'unmerged_from', { host: hostId });
        });
        if (!r.ok) continue;
      } else {
        // 已经被人手工 reopen 过：只补回原文，不动状态
        this.store.patchMeta(entry.id, { title: entry.title, body: entry.body });
        this.store.setClarifyFeedback(entry.id, entry.clarifyFeedback ?? null);
        this.store.logEvent(entry.id, 'unmerged_from', { host: hostId });
      }
      restored.push(entry.id);
    }

    this.store.logEvent(hostId, 'tasks_unmerged', {
      host: hostId,
      restored,
      mergedEventId: merge.eventId,
      ...(actor !== undefined ? { actor } : {}),
    });
    return { ok: true, restored };
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

    // #289 / B-14：**绝不用摘要覆盖原文**。旧实现是 patchMeta(host, {title, body: merge.body})，
    // 宿主正文从 1400~1700 字被压成 500~760 字的 LLM 摘要，代码定位（`engine.ts:6533` 这类行号）、
    // 量化依据与验收段全丢，且无法回溯、无法拆回。现在：摘要在前，各分支原文按 #id 分节追加；
    // 完整快照（含宿主自己的原文与澄清反馈）存进 tasks_merged 事件，供拆回使用。
    const snapshot = members.map((m) => ({
      id: m.id,
      title: m.title,
      body: m.body,
      clarifyFeedback: m.clarifyFeedback,
    }));
    this.store.patchMeta(host.id, {
      title: merge.title,
      body: composeMergedBody(merge.body, snapshot),
    });
    // 旧反馈作废（正文已并入多条，调度收尾后重新分析）——但它先进了上面的快照，拆回时能还原
    this.store.setClarifyFeedback(host.id, null);
    // 置顶不能被合并吞掉：若被并入项里有置顶（且比 host 更晚置顶），把置顶带到 host——
    // 否则「置顶了一条，却被同模块更早的一条合并掉」会让置顶意图无声丢失。
    const maxPin = Math.max(...members.map((i) => i.pinnedTs ?? 0));
    if (maxPin > (host.pinnedTs ?? 0)) this.store.setPinned(host.id, maxPin);
    this.store.logEvent(host.id, 'tasks_merged', {
      from: foldedIds,
      module: host.module,
      title: merge.title.slice(0, 120),
      // 快照存全文（不截断）：它是拆回的唯一依据，截了就等于拆不回来
      snapshot,
    });
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
    // 这两条与锁内的同款判定要一起标 deferral（#283）：调度器多半是在这里被挡下的——
    // 挑中之后、真正开跑之前，issue 被取消/被别的 flight 抢先都走这里。
    if (!issue) return { ok: false, error: '无此 issue', deferral: 'issue-gone' };
    if (issue.status !== 'pending') {
      return { ok: false, error: `仅 pending 可开跑（当前 ${issue.status}）`, deferral: 'not-pending' };
    }
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
          immediate = { ok: false, error: '无此 issue', deferral: 'issue-gone' };
          return;
        }
        if (fresh.status !== 'pending') {
          // 被别的 flight 抢先/用户手动开跑：正常竞态，不是故障
          immediate = { ok: false, error: `仅 pending 可开跑（当前 ${fresh.status}）`, deferral: 'not-pending' };
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
          (candidate) => (candidate.status === 'blocked' || candidate.status === 'paused') && this.workflowSnapshot(candidate.id)?.status === 'paused',
        );
        if (isBusy(siblings) || pausedWorkflow) {
          immediate = { ok: false, error: '项目忙（已有 issue 在跑），先排队', deferral: 'project-busy' };
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

        // #277 / I-02：技能按模块挂载。必须赶在代理进程起来之前——它一启动就会把
        // `.claude/skills` 下的 SKILL.md 全部扫一遍，那时候再摘已经晚了。
        // Session-specific settings replace mutations of shared project skill symlinks.

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
            const held = module.conversation_id
              ? this.deps.convs.get(module.conversation_id)
              : undefined;
            // #277 / I-01 决策 1A：**每条 issue 一条独立 transcript**。模块仍是长期身份
            // （固定 slug、固定代理、固定 tmux 名），但不再让所有 issue 挤在同一条对话里——
            // 上一条的整段 transcript 会被下一条无差别继承进窗口，越跑越贵，还把不相干的
            // 上下文喂给新任务。跨 issue 的连续性改由模块知识（MODULE.md 知识区）承担。
            //
            // 轮换只在「这条会话上没有未结束的 segment」时发生：还有人半截活儿挂在上面就
            // 接着用（典型是 blocked 后没落 segment_ended 的），否则等于把人家的上下文扔了。
            // 旧 conv 不归档、不删，保留可查；tmux 名仍由 slug 派生，所以这里是**同一个运行
            // 容器重起**（activate 走 kill+new 换 --session-id），不是新开一个进程。
            conv = held && this.store.moduleConvInUse(held.id) ? held : undefined;
            if (!conv) {
              conv = this.deps.convs.create(
                fresh.projectId,
                `module:${fresh.module}`,
                module.agent === 'codex' ? 'codex' : 'claude',
              );
              this.deps.db
                .query(
                  `UPDATE project_modules SET conversation_id = ?
                    WHERE id = ? AND (conversation_id IS NULL OR conversation_id = ?)`,
                )
                .run(conv.id, fresh.moduleId, module.conversation_id);
              const bound = this.deps.db
                .query<{ conversation_id: string }, [number]>(
                  'SELECT conversation_id FROM project_modules WHERE id = ?',
                )
                .get(fresh.moduleId)?.conversation_id;
              if (bound !== conv.id) conv = bound ? this.deps.convs.get(bound) : undefined;
              else if (module.conversation_id) {
                this.store.logEvent(fresh.id, 'module_conv_rotated', {
                  moduleId: fresh.moduleId,
                  from: module.conversation_id,
                  to: conv.id,
                });
              }
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
        if (bound?.convId) await this.prepareSkillSession(bound, workspace.cwd);
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
          this.applyEventLocked(issueId, this.store.get(issueId)?.executionMode === 'direct'
            && !project.manualReview && !this.workflowSnapshot(issueId)
            && !this.store.get(issueId)?.publicationLocked ? 'start_direct' : 'skip_clarifying', {}, () => {
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

  /**
   * blocked → 受阻来源阶段；解除方法单独完整留痕，供恢复后的阶段可靠注入。
   *
   * **项目忙时不再拒绝**（#283）：旧行为是回一句「请在当前任务结束后继续运行」，
   * 于是用户点了「继续运行」什么也没发生，还得盯着前一条跑完再回来点一次——
   * 这正是本条要消灭的人工守候。现在把解除意图排队（`unblock_requested`），
   * 由接力在项目空闲时自动消费；意图可撤销、重复提交以最后一次为准。
   */
  async unblockIssue(issueId: number, guidance: string, actor?: number): Promise<UnblockResult> {
    const normalized = guidance.trim();
    if (!normalized) return { ok: false, error: '解除阻塞前必须填写补充意见或解除方法' };
    if (normalized.length > 4000) return { ok: false, error: '解除方法不能超过 4000 字' };
    const fresh = this.store.get(issueId);
    if (!fresh) return { ok: false, error: '无此 issue' };
    if (fresh.status !== 'blocked' && fresh.status !== 'paused') {
      return { ok: false, error: `仅受阻或暂停可继续运行（当前 ${fresh.status}）` };
    }
    const siblings = this.store.listByProject(fresh.projectId).filter((candidate) => candidate.id !== issueId);
    if (isBusy(siblings)) {
      const ts = this.now();
      // 重复请求幂等：只落一条新意图，读取侧永远取最后一条（以最后一次的 guidance 为准）
      this.store.logEvent(issueId, 'unblock_requested', {
        guidance: normalized,
        resumeState: this.resumeStateOf(issueId) ?? 'pending',
        ...(actor !== undefined ? { actor } : {}),
      });
      return { ok: true, queued: true, requestedTs: ts };
    }
    return this.applyUnblock(issueId, normalized, actor);
  }

  /** 撤销一条尚未消费的解除意图（#283）；没有意图时返回失败，避免静默无操作 */
  cancelUnblockRequest(issueId: number, actor?: number): { ok: true } | { ok: false; error: string } {
    const request = this.store.pendingUnblockRequest(issueId);
    if (!request) return { ok: false, error: '没有待恢复的请求' };
    this.store.logEvent(issueId, 'unblock_request_cancelled', {
      ...(actor !== undefined ? { actor } : {}),
    });
    return { ok: true };
  }

  /** 受阻前的可恢复阶段（读不出来就回 pending，与既有口径一致） */
  private resumeStateOf(issueId: number): IssueState | undefined {
    const blocked = this.store.lastEnterInfo(issueId, this.store.get(issueId)?.status === 'paused' ? 'paused' : 'blocked');
    const raw = isResumableState(blocked?.resumeState)
      ? blocked.resumeState
      : isResumableState(blocked?.from)
        ? blocked.from
        : undefined;
    return raw === undefined ? undefined : demoteAgentlessResume(raw);
  }

  /** 真正执行恢复：手动解除与接力消费意图共用这一条路径，保证留痕与注入完全一致 */
  private async applyUnblock(issueId: number, guidance: string, actor?: number): Promise<ApplyResult> {
    const blocked = this.store.lastEnterInfo(issueId, this.store.get(issueId)?.status === 'paused' ? 'paused' : 'blocked');
    const resumeState = this.resumeStateOf(issueId);
    return this.applyEvent(issueId, 'unblock', {
      note: guidance,
      actor,
      ...(resumeState ? { resumeState } : {}),
    }, () => {
      this.store.logEvent(issueId, 'unblock_guidance', {
        guidance,
        resumeState: resumeState ?? 'pending',
        ...(actor !== undefined ? { actor } : {}),
      });
      // #274：这次受阻是止损闸打的 → 落新锚点。少了它，用户点「继续运行」之后
      // 三项计数还是原样超标，下一个 tick 立刻又被暂停，人根本推不动。
      // 只对止损来源落：普通受阻的恢复不该把烧钱账目一笔勾销。
      if (blocked?.stopLoss) {
        this.store.logEvent(issueId, 'stop_loss_resumed', {
          resumeState: resumeState ?? 'pending',
          ...(actor !== undefined ? { actor } : {}),
        });
      }
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
  async reopenIssue(issueId: number, actor?: number, guidance = ''): Promise<ApplyResult> {
    const issue = this.store.get(issueId);
    if (!issue) return { ok: false, error: '无此 issue' };
    // 友好错误；真正的守卫是状态机（非 cancelled 一律「非法转换」）
    if (issue.status !== 'cancelled' && issue.status !== 'done') {
      return { ok: false, error: `仅已取消或已完成的 issue 可重新运行（当前 ${issue.status}）` };
    }
    const normalized = guidance.trim();
    if (issue.status === 'done' && !normalized) {
      return { ok: false, error: '退回已完成 issue 前必须填写未达目标或继续处理说明' };
    }
    if (normalized.length > 4000) return { ok: false, error: '继续处理说明不能超过 4000 字' };
    return this.applyEvent(issueId, 'reopen', {
      ...(actor !== undefined ? { actor } : {}),
      ...(normalized ? { note: normalized } : {}),
    }, () => {
      this.store.clearRunState(issueId);
      this.store.logEvent(issueId, 'reopened', {
        from: issue.status,
        ...(normalized ? { guidance: normalized } : {}),
        ...(actor !== undefined ? { actor } : {}),
      });
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
    await this.scheduleNext(issue.projectId, { preferModuleKey: moduleKeyOf(issue), source: 'manual' });
    return { ok: true, from: issue.status, to: issue.status };
  }

  /**
   * 改 issue 的自动批准档位（issue #108）。未开跑/驱动中都能改——正在跑的 issue 改完
   * 下一次弹窗就按新档位走（管道每轮现取），这正是「跑着跑着觉得太啰嗦/太放飞」时的用法。
   * 只有已收尾的（done/cancelled）拒改：不会再有弹窗，改了纯属误导（#111）。
   * **blocked 仍可改**——受阻能恢复，继续前调档正是它的用法，别顺手把它一起锁掉。
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
    opts: {
      note?: string;
      failCount?: number;
      actor?: number;
      resumeState?: IssueState;
      /** #274：本次 blocked 是止损闸打的。写进 transition 事件供计数排除与 #275 派生 */
      stopLoss?: boolean;
    } = {},
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
    // 仅缺少有效恢复上下文的 unblock 会回 pending，并在 transition 锁释放后走既有启动入口。
    if (result.ok && result.to === 'pending' && result.from !== 'pending') {
      const issue = this.store.get(issueId);
      if (issue?.status === 'pending') {
        await this.scheduleNext(issue.projectId, { preferModuleKey: moduleKeyOf(issue), source: 'unblock' });
      }
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

    const execute = async (): Promise<T> => {
      this.activeIssueTransitions.add(issueId);
      try {
        return await fn();
      } finally {
        this.activeIssueTransitions.delete(issueId);
      }
    };
    let result: Promise<T>;
    if (previous) {
      result = previous.then(execute);
    } else {
      try {
        result = execute();
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
    opts: {
      note?: string;
      failCount?: number;
      actor?: number;
      resumeState?: IssueState;
      /** #274：本次 blocked 是止损闸打的。写进 transition 事件供计数排除与 #275 派生 */
      stopLoss?: boolean;
    } = {},
    afterCommit?: () => void,
  ): Promise<ApplyResult> {
    let issue = this.store.get(issueId);
    if (!issue) return { ok: false, error: '无此 issue' };
    const from = issue.status;
    const to = transition(from, ev, {
      ...(opts.failCount !== undefined ? { failCount: opts.failCount } : {}),
      ...(opts.resumeState !== undefined ? { resumeState: opts.resumeState } : {}),
    });
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
          ...(opts.resumeState !== undefined ? { resumeState: opts.resumeState } : {}),
          ...(opts.stopLoss !== undefined ? { stopLoss: opts.stopLoss } : {}),
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
        ...(opts.stopLoss ? { stopLoss: true } : {}),
        ...((to === 'blocked' || to === 'paused') ? {
          resumeState: from,
          resumeContext: {
            subIndex: fresh.subIndex,
            convId: fresh.convId,
            branch: fresh.branch,
            targetBranch: fresh.targetBranch,
            sourceRef: fresh.sourceRef,
            workflowStatus: this.workflowSnapshot(issueId)?.status ?? null,
          },
        } : {}),
        ...(ev === 'unblock' && opts.resumeState !== undefined ? { resumeState: opts.resumeState } : {}),
      });
      if (ev === 'request_plan' || (ev === 'skip_clarifying' && fresh.executionMode === 'direct')) {
        this.deps.db.run("UPDATE issues SET execution_mode = 'planned' WHERE id = ?", [issueId]);
      }
      if (ev === 'start_direct' || ev === 'request_plan' || ev === 'skip_clarifying') {
        this.store.logEvent(issueId, 'execution_route', {
          mode: ev === 'start_direct' ? 'direct' : 'planned', reason: opts.note ?? ev,
        });
      }
      if (to === 'implementing') {
        this.deps.db.run('UPDATE issues SET completion_report_json = NULL WHERE id = ?', [issueId]);
      }
      if (ev === 'unblock' && to === 'testing' && fresh.completionReport
        && (fresh.completionReport.outcome !== 'complete'
          || fresh.completionReport.unmetGoals.length > 0 || fresh.completionReport.remainingWork.length > 0)) {
        // 旧报告记录的是解除之前的障碍，不能拿它重新判定本轮恢复失败。
        // 已验证完整的报告仍可用于执行器/门禁异常后的继续收尾。
        this.store.setCompletionReport(issueId, null);
      }
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
          return this.applyEventLocked(issueId, 'pause', { note: '执行工作区不可用' }, afterCommit);
        }
        // git 身份预检（#272 / B-01）：必须在 git_branch_prepared 之前，且**两条路径都要过**——
        // 只读/只补 config，不碰工作树与 HEAD，故不破坏下面 legacy 路径「不动 Git 状态」的语义。
        await this.precheckGitIdentity(project, issueId, workspace.cwd);
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
          return this.applyEventLocked(issueId, 'pause', { note: '执行工作区不可用' }, afterCommit);
        }
        if (ev === 'start_direct') await this.precheckGitIdentity(project, issueId, workspace.cwd);
        const inspected = await this.deps.mutex.runExclusive(gitLockKey(project.id), async () => {
          const fresh = this.store.get(issueId);
          if (!fresh || fresh.status !== from) return { kind: 'stale' as const };
          if (ev === 'start_direct') {
            if (fresh.targetBranch || workspace.kind === 'design-worktree') {
              const prepared = await this.prepareIssueBranchLocked(project, fresh, workspace);
              if (!prepared.ok) return { kind: 'blocked' as const, err: prepared.err };
              this.store.logEvent(issueId, 'git_branch_prepared', prepared);
            }
          }
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
      summaryParams: { title: issue.title.slice(0, 60), ...(to === 'paused' ? {detail:opts.note ?? ''} : {}) },
    });
    if (to === 'done') {
      await this.notifySafe({ kind: 'issue_done', projectId: issue.projectId, issueId, summary: issue.title });
    } else if (to === 'blocked' && !opts.stopLoss) {
      // 止损打的这次由 tripStopLoss 发专用通知（说清「不是失败」），这里不再发通用受阻通知，
      // 否则一次事件会给用户推两条、还互相打架
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
    // 止损闸（#274）：迁移落定后评估一次，这样「第 3 次解除阻塞」这类条件当场就能拦住，
    // 不用等下一轮 tick。必须走 applyEventLocked——本方法已在该 issue 的 transition 队列里，
    // 走 public applyEvent 会排进同一条尾队列自等。
    const settled = this.store.get(issueId);
    if (settled) {
      await this.tripStopLoss(settled, (id, blockEvent, blockOpts) =>
        this.applyEventLocked(id, blockEvent, blockOpts));
    }
    return { ok: true, from, to };
  }

  private executionSyncBoundaryKind(from: IssueState, ev: IssueMachineEvent): string | null {
    if (from === 'pending' && (ev === 'skip_clarifying' || ev === 'start_direct')) return ev;
    if (from === 'implementing' && ev === 'request_plan') return ev;
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
      this.store.logEvent(issue.id, 'error', { where: 'execution-workspace', error: String(e).slice(0, 200) });
      if (to === 'paused') {
        this.workflowScheduler.pause(issueId,note ?? 'execution.error');
        if (issue.convId) this.watch.delete(issue.convId);
        this.store.expireWaitingGates(issueId);
        await this.scheduleNext(issue.projectId, { source: 'relay' });
      }
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
            await this.applyEventLocked(issueId, 'pause', {
              note: `激活对话失败：${String(e).slice(0, 200)}`,
            });
            return;
          }
        } else if (!(await this.ensureActiveConv(issue, from === 'blocked' || from === 'paused'))) {
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
            await this.applyEventLocked(issueId, 'pause', {
              note: `${result.state === 'paused' ? '工作流已暂停' : '工作流执行失败'}：${result.reason}`,
            });
          }
          break;
        }
        // targetBranch 非空的新 issue 已在 planning 前准备好分支；历史 issue 仍沿用开发者当前分支。
        // 实际分支校验、issues.branch 与首条 impl_base 已在 implementing CAS 发布前原子准备。
        // I1：plan_review approve 等路径进 implementing 时项目可能没有激活对话
        // （迁移场景：issue/conv 已入库但 project_active_conv 空）——此时激活，别静默冻结。
        if (!(await this.ensureActiveConv(issue, from === 'blocked' || from === 'paused'))) return;
        break;
      }
      case 'testing': {
        if (this.workflowSnapshot(issueId)) {
          await this.applyEventLocked(issueId, 'tests_passed', { note: '工作流节点已全部完成' });
          break;
        }
        if (!(await this.ensureActiveConv(issue, from === 'blocked' || from === 'paused'))) return;
        // #279：进 testing 就把门禁范围算出来落库——UI 立刻能显示「这轮打算跑什么」，
        // 真正执行要等代理输出 STAGE_DONE:testing（决策 2A：代理仍出完成报告块）。
        // 失败不阻断：留 error 事件，跑门禁时会重算一次。
        if (this.cfg.validationTimeoutMs > 0) {
          try {
            this.store.setValidationScope(issueId, await this.computeValidationScope(issue, workspace));
          } catch (e) {
            this.store.logEvent(issueId, 'error', { where: 'validation-scope', error: String(e).slice(0, 200) });
          }
        }
        if ((from === 'paused' || from === 'blocked') && issue.executionMode === 'direct' && !issue.completionReport && issue.convId) {
          await this.inject(this.deps.convs.tmuxName(issue.projectId,issue.convId),this.buildIssueNudge({issue,stage:'testing',locale:this.promptLocale(issue,project)}));
          this.store.logEvent(issue.id,'injected',{stage:'testing',kind:'report_recovery'});
        }
        break; // kickoff 注入测试 prompt
      }
      case 'merge_review': {
        // 默认（manual_review 关）：不建卡点——自动 commit/push 收尾后直接放行到 done。
        // 先 commit 再 stampImplTip：自动提交要落进本 issue 的 impl_base..impl_tip 范围。
        if (!project.manualReview) {
          if (this.store.holdExecutionSyncBoundary(issueId, 'merge_review_auto', {
            kind: 'resume_entry', from, to: 'merge_review',
          })) return;
          try {
            await this.deps.flushProjectData?.(project.id);
          } catch (e) {
            const detail = String(e).slice(0, 300);
            this.store.logEvent(issueId, 'error', { where: 'projectDataFlush', error: detail });
            await this.applyEventLocked(issueId, 'block', {
              note: `自动收尾已停止：协作过程页刷新失败：${detail}`,
            });
            return;
          }
          const finished = await this.deps.mutex
            .runExclusive(gitLockKey(project.id), async () => {
              const branch = await this.inspectIssueBranchLocked(project, issue, workspace);
              if (!branch.ok) return branch;
              const autoFailure = await this.autoCommitPushLocked(project, issue, workspace);
              await this.stampImplTip(project, issue, workspace);
              const status = await this.deps.driver.git(workspace.cwd, ['status', '--porcelain']);
              const snapshot = this.implCommits(issue.id);
              const emptyImplRange = !snapshot
                || (snapshot.commits.length === 0 && snapshot.files.length === 0);
              return {
                ok: true as const,
                autoFailure,
                dirtyEmptyImplRange: status.code === 0 && status.out.trim().length > 0 && emptyImplRange,
              };
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
            if (where === 'auto_commit') {
              await this.applyEventLocked(issueId, 'block', {
                note: `自动提交失败，工作区改动已保留：${detail.slice(0, 300)}`,
              });
              return;
            }
          }
          if (finished.dirtyEmptyImplRange) {
            await this.applyEventLocked(issueId, 'block', {
              note: '自动收尾已停止：本 issue 的实现范围为空，但工作区仍有未提交改动',
            });
            return;
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
        const completion = await this.collectResultSummary(project, issue, 'done', workspace);
        if (completion.kind === 'disabled' || completion.kind === 'complete') {
          await this.applyEventLocked(issueId, 'merged');
        } else {
          await this.applyEventLocked(issueId, 'block', { note: completion.reason });
        }
        break;
      }
      case 'done':
      case 'blocked':
      case 'paused':
      case 'cancelled': {
        if (to === 'blocked' || to === 'paused') this.workflowScheduler.pause(issueId, note ?? 'issue.blocked');
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
        if (
          to === 'blocked' &&
          this.store.countEventsSince(
            issueId,
            'summary_requested',
            this.store.lastEventId(issueId, 'reopened'),
          ) === 0
        ) {
          await this.collectResultSummary(project, issue, to, workspace);
        }
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
          // 模块知识增量（#277 / I-01）：跨 issue 的连续性从此由这一小段结构化知识承担，
          // 不再靠把上一条的 transcript 整段拖进窗口。**由引擎确定性生成**——全部取自
          // 库里已有的事实（标题 / 收尾状态 / 摘要首段 / 改动文件数），代理不参与，
          // 所以不会因为代理偷懒或跑飞就丢失。cancelled 不写：那是「这版不做了」，
          // 沉淀进模块知识只会误导下一条 issue。
          if (to !== 'cancelled') await this.recordModuleKnowledge(project, issue, to);
        }
        const reservesProject = (to === 'blocked' || to === 'paused') && this.workflowSnapshot(issueId)?.status === 'paused';
        if (!reservesProject) {
          // done/普通 blocked 接力
          await this.scheduleNext(issue.projectId, { preferModuleKey: moduleKeyOf(issue), source: 'relay' });
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
        // 缺少恢复上下文的 unblock 接力在 public applyEvent 释放 issue 锁后执行，避免同 key 自锁。
        break;
      }
      default:
        break;
    }
    void note;
  }

  // ---- git 分支流（确定性，Driver.git） ----

  /**
   * git 提交身份预检（#272 / B-01）：在 `git_branch_prepared` 之前跑一次，缺身份就补齐。
   *
   * 为什么必须放在这里而不是等自动提交时再说：执行机上曾经根本没有 `~/.gitconfig`，
   * 导入进来的项目也没人写过 local 身份，于是每个新项目的第一次自动提交必然
   * `Author identity unknown`，而 commit 失败会把 issue 直接打成 blocked——一整周
   * 45% 的 auto_commit 失败就是这么来的。开跑前先把身份坐实，故障根本不会发生。
   *
   * 两条纪律：
   * - **覆盖「无目标分支」这条 legacy 路径**：那条路径刻意不做任何 Git 观察与变更，
   *   但它恰恰是最常走的一条，漏掉它等于没修。身份预检只读/只补 config，不碰
   *   工作树、index、HEAD，放进来不破坏那条路径「不动工作树」的语义。
   * - **失败绝不 block**：身份补不上还有自动提交时的自愈重试兜底；在这里把 issue
   *   打成 blocked，只会把本 issue 要消灭的那个人工介入换个地方再制造一遍。
   */
  private async precheckGitIdentity(
    project: Project,
    issueId: number,
    cwd: string,
  ): Promise<void> {
    const fallback = buildFallbackIdentity({
      runUser: project.runUser,
      ownerUsername: this.ownerUsername(project),
    });
    const ensured = await this.deps.mutex
      .runExclusive(gitLockKey(project.id), () => ensureGitIdentity(this.deps.driver, cwd, fallback))
      .catch((e: unknown) => ({ ok: false as const, error: String(e).slice(0, 300) }));
    if (!ensured.ok) {
      this.store.logEvent(issueId, 'error', {
        where: 'git-identity',
        error: (ensured.error ?? 'Git 身份预检失败').slice(0, 300),
      });
      return;
    }
    this.store.logEvent(issueId, 'git_identity', {
      applied: ensured.changed, // false = 本来就有身份，一个字没动
      scope: ensured.scope,
      name: ensured.name,
      email: ensured.email,
    });
  }

  /**
   * 写一条模块知识（#277 / I-01）。内容只取库里已有的确定性事实，不调模型、不问代理：
   * issue 标题 + 收尾状态 + 收尾摘要首段 + 本 issue 改动的文件数。
   *
   * **写失败绝不阻断收尾**：这是给下一条 issue 看的便条，丢一条的代价远小于卡住队列。
   */
  private async recordModuleKnowledge(
    project: Project,
    issue: EngineIssue,
    status: IssueState,
  ): Promise<void> {
    const modules = this.deps.modulesFor?.(project);
    if (!modules?.recordModuleKnowledge || issue.moduleId === null) return;
    try {
      const module = this.moduleRow(issue.projectId, issue.moduleId);
      if (!module) return;
      const fresh = this.store.get(issue.id) ?? issue;
      const firstLine = (fresh.resultSummary ?? '')
        .split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
      const files = this.implCommits(issue.id)?.files.length ?? 0;
      const note = [firstLine, files > 0 ? `改动 ${files} 个文件` : '']
        .filter(Boolean).join('；');
      await modules.recordModuleKnowledge(module, {
        issueId: issue.id,
        status,
        title: fresh.title,
        ...(note ? { note } : {}),
      });
    } catch (e) {
      this.store.logEvent(issue.id, 'error', {
        where: 'module-knowledge',
        error: String(e).slice(0, 200),
      });
    }
  }

  /** Snapshot session visibility without mutating shared skill directories. */
  private async prepareSkillSession(issue: EngineIssue, cwd: string): Promise<void> {
    if (!issue.convId) return;
    try {
      const project = this.project(issue.projectId)!;
      const ex = this.deps.db.query<{claude_dir:string},[number]>('SELECT claude_dir FROM executors WHERE id=?').get(project.executorId);
      const homes = ex ? agentHomesFromClaudeDir(ex.claude_dir) : null;
      const skills = [...await listProjectSkills(this.deps.driver,cwd),
        ...(homes ? await listGlobalSkills(this.deps.driver,homes) : [])];
      const policy = effectiveSkillPolicy(this.deps.db,{projectId:issue.projectId,moduleId:issue.moduleId ?? undefined,issueId:issue.id});
      // Preserve explicit module allow-lists during migration to three-state policy.
      if (issue.moduleId) {
        const row=this.deps.db.query<{skills_json:string|null},[number]>('SELECT skills_json FROM project_modules WHERE id=?').get(issue.moduleId);
        const legacy=parseModuleSkills(row?.skills_json ?? null);
        if (legacy) for(const skill of skills) if (!(skill.name in policy)) policy[skill.name]=legacy.includes(skill.name)?'auto':'manual';
      }
      const snapshot=skillSessionSettings(issue.agent,skills,policy);
      if (!skills.length) { this.store.logEvent(issue.id,'skill_visibility',snapshot); return; }
      this.deps.db.run(`INSERT INTO skill_session_policies(conv_id,issue_id,snapshot_json) VALUES(?,?,?)
        ON CONFLICT(conv_id) DO UPDATE SET issue_id=excluded.issue_id,snapshot_json=excluded.snapshot_json`,
        [issue.convId,issue.id,JSON.stringify(snapshot)]);
      this.store.logEvent(issue.id,'skill_visibility',{...snapshot,config:undefined});
    } catch(e) {
      this.store.logEvent(issue.id,'skill_visibility',{limitations:['Skill policy could not be applied'],error:String(e).slice(0,200)});
    }
  }

  /** 项目属主用户名（兜底身份的第二顺位）；users 表读不到就当没有，不影响预检 */
  private ownerUsername(project: Project): string | null {
    try {
      return this.deps.db
        .query<{ username: string }, [number]>('SELECT username FROM users WHERE id = ?')
        .get(project.ownerUserId)?.username ?? null;
    } catch {
      return null;
    }
  }

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
   * commit 失败后的身份自愈（#272 / B-01）：绝大多数自动提交失败其实只是
   * `Author identity unknown`。补上身份返回 true（值得原样重试一次）；本来就有身份
   * （说明失败另有原因）或补不上，返回 false 让调用方照常降级。
   *
   * 调用方已持有 `git:<projectId>`，这里**不得**再取同 key（KeyedMutex 非重入）。
   */
  private async healGitIdentityLocked(
    project: Project,
    issueId: number,
    cwd: string,
  ): Promise<boolean> {
    const fallback = buildFallbackIdentity({
      runUser: project.runUser,
      ownerUsername: this.ownerUsername(project),
    });
    const ensured = await ensureGitIdentity(this.deps.driver, cwd, fallback);
    if (!ensured.ok) {
      this.store.logEvent(issueId, 'error', {
        where: 'git-identity',
        error: (ensured.error ?? 'Git 身份自愈失败').slice(0, 300),
      });
      return false;
    }
    if (!ensured.changed) return false; // 身份本来就在，重试同一条 commit 只会再失败一次
    this.store.logEvent(issueId, 'git_identity', {
      applied: true,
      recovered: true, // 与开跑前的预检区分：这条是提交失败后现补的
      scope: ensured.scope,
      name: ensured.name,
      email: ensured.email,
    });
    return true;
  }

  /**
   * push 被远端拒（远端有我没有的提交）→ `fetch origin <branch>` + `rebase FETCH_HEAD`
   * 后重试一次（#272 / B-02）。返回重试后的 push 结果；没条件重试则返回 null（保留原始失败）。
   *
   * 两个必须守住的点：
   * - **rebase 冲突一定要 `--abort`**：否则仓库停在 rebase 中途，下一条 issue 一开跑
   *   就撞上「工作区有未保存改动」，一个推送失败会连坐整条队列。
   * - **detached HEAD 不重试**：没有对应的远端分支可 fetch/rebase，硬试只会把现场搅乱。
   */
  private async rebaseAndRetryPushLocked(
    issueId: number,
    cwd: string,
    pushArgs: string[],
  ): Promise<GitResult | null> {
    const head = await this.deps.driver.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = head.code === 0 ? head.out.trim() : '';
    if (!branch) return null;
    const fetched = await this.gitTransport(cwd, ['fetch', 'origin', branch]);
    if (fetched.code !== 0) return fetched;
    const rebased = await this.deps.driver.git(cwd, ['rebase', 'FETCH_HEAD']);
    if (rebased.code !== 0) {
      await this.deps.driver.git(cwd, ['rebase', '--abort']); // 收干净，别把仓库留在半途
      this.store.logEvent(issueId, 'auto_push_retry', {
        reason: 'rejected',
        branch,
        result: 'rebase_failed',
        error: (rebased.err || rebased.out).slice(0, 300),
      });
      return null;
    }
    this.store.logEvent(issueId, 'auto_push_retry', { reason: 'rejected', branch, result: 'rebased' });
    return this.gitTransport(cwd, pushArgs);
  }

  // 网络命令超时与普通非零退出码走同一条“未推送”路径。
  // 不包住 commit/rebase 等本地写操作：这些失败可能影响开发现场，仍须单独处理。
  private async gitTransport(cwd: string, args: string[]): Promise<GitResult> {
    try {
      return await this.deps.driver.git(cwd, args);
    } catch (error) {
      return { code: 1, out: '', err: String(error) };
    }
  }

  /**
   * 自动收尾（manual_review 关，tests_passed 后）：git add -A → 有暂存改动才 commit
   * 「<标题> (#id)」→ push origin 当前分支（HEAD）。commit 失败会保留现场并阻止完成；
   * push 失败只记事件+通知，不阻止本地已经提交完成的 issue 收尾。
   * 没有新 commit 也照样 push（CC 实施中自己 commit 过、只欠 push 是常态）。
   *
   * #272 加固的三处：
   * - commit 失败先补身份重试一次（见 healGitIdentityLocked），仍失败才降级；
   * - **push 前预检 origin**：没有远端的项目（本地私有仓库）记 `push_skipped` 就收工，
   *   那不是故障，不该每次收尾都刷一条 error 和一次通知；
   * - 被拒（fetch first / non-fast-forward）fetch+rebase 重试一次；最终仍失败要留下
   *   `auto_push_failed` 这个**持久可见标记**——push 失败不挡完成，但绝不能静默 done。
   */
  private async autoCommitPushLocked(
    project: Project,
    issue: EngineIssue,
    workspace: EngineExecutionWorkspace,
  ): Promise<{ where: 'auto_commit' | 'auto_push'; detail: string } | null> {
    const cwd = workspace.cwd;
    const branchLabel = issue.branch ?? 'HEAD';
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
      let commit = await this.deps.driver.git(cwd, ['commit', '-m', msg]);
      if (commit.code !== 0) {
        // 自愈一次：身份补上了就原样重试，别为 Author identity unknown 叫醒用户
        if (!(await this.healGitIdentityLocked(project, issue.id, cwd))) {
          return fail('auto_commit', commit.err || commit.out); // commit 失败就没有新提交可推
        }
        commit = await this.deps.driver.git(cwd, ['commit', '-m', msg]);
        if (commit.code !== 0) return fail('auto_commit', commit.err || commit.out);
      }
      this.store.logEvent(issue.id, 'auto_commit', { message: msg });
    }
    const remote = await this.deps.driver.git(cwd, ['remote', 'get-url', 'origin']);
    if (remote.code !== 0) {
      this.store.logEvent(issue.id, 'push_skipped', { reason: 'no-remote', branch: branchLabel });
      return null; // 没有远端可推 ≠ 推失败
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
    let push = await this.gitTransport(cwd, pushArgs);
    if (push.code !== 0 && PUSH_REJECTED_RE.test(push.err || push.out)) {
      const retried = await this.rebaseAndRetryPushLocked(issue.id, cwd, pushArgs);
      if (retried) push = retried;
    }
    if (push.code !== 0) {
      const detail = push.err || push.out;
      // 持久可见标记：本地已提交，issue 照常完成，但详情页要一直挂着「未推送」
      this.store.logEvent(issue.id, 'auto_push_failed', {
        branch: branchLabel,
        detail: detail.slice(0, 300),
      });
      return fail('auto_push', detail);
    }
    this.store.logEvent(issue.id, 'auto_push', { branch: branchLabel });
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
   * 收尾摘要（#275 / I-05）：**从引擎手里已有的结构化数据确定性拼装**，不再注入、不再等文件。
   *
   * 旧实现是收尾时另起一轮满窗注入让代理写 summary.md + report.json + done 哨兵，那一轮正好
   * 落在全程上下文最高点（#270 实测 218k），四次工具调用只换 300 字——单条 issue 里最贵的
   * 一笔非生产性支出。现在报告由代理随最后一次 STAGE_DONE 内联带出（见 captureCompletionReport），
   * 摘要由 result-summary.ts 纯函数拼。
   *
   * 降级顺序：确定性拼装 → PM（可选的 summarizeOutcome）→ 一句确定性兜底文案。
   * 实际上前者几乎总能拼出东西（blocked 必有 note，done 必有子任务或提交），后两级是安全网。
   *
   * 返回值语义不变（调用方据此决定 merging→done 还是 block）：完成度门禁仍看结构化报告，
   * 没有报告 = 无法证明「原始目标全部达成」→ incomplete。
   */
  private async collectResultSummary(
    project: Project,
    issue: EngineIssue,
    kind: 'done' | 'blocked',
    workspace: EngineExecutionWorkspace,
  ): Promise<
    { kind: 'disabled' } | { kind: 'complete' } | { kind: 'incomplete'; reason: string }
  > {
    if (this.cfg.resultSummaryTimeoutMs <= 0) return { kind: 'disabled' }; // 显式关闭兼容测试引擎
    // 每次收尾都是一次全新的采集：先清旧摘要，免得失败后 UI 还挂着上一轮的结论。
    // **不清 completionReport**——它是本轮 testing 阶段刚由哨兵写进来的，清了等于白拿。
    this.store.setResultSummary(issue.id, null);

    const fresh = this.store.get(issue.id) ?? issue;
    const snapshot = this.implCommits(issue.id);
    const events = this.store.listEvents(issue.id);
    const locale = this.promptLocale(fresh, project);
    const subtasks = this.store.subtasksOf(fresh);
    const commits = snapshot?.commits ?? [];

    let text = kind === 'done'
      ? buildDoneSummary({
        report: fresh.completionReport,
        subtasks,
        commits,
        files: snapshot?.files ?? [],
        events,
        locale,
      })
      : buildBlockedSummary({
        blockNote: this.store.lastEnterInfo(issue.id, 'blocked')?.note ?? null,
        subtasks,
        commits,
        events,
        locale,
      });
    let via: 'assembled' | 'pm' | 'fallback' = 'assembled';

    if (!text) {
      text = kind === 'done' ? '已完成（没有可展示的结构化信息）' : '已受阻转人工（没有可展示的结构化信息）';
      via = 'fallback';
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
    this.store.logEvent(issue.id, 'summary_done', { kind, via, chars: text.length });

    // 完成度门禁（口径不变）：没有结构化报告就无法证明「原始目标全部达成」，
    // 只是拿不到报告的原因从「注入超时」换成了「代理没按协议内联输出」。
    const report = fresh.completionReport;
    if (!report) return { kind: 'incomplete', reason: '完成报告缺失或格式无效' };
    if (report.outcome !== 'complete' || report.unmetGoals.length > 0 || report.remainingWork.length > 0) {
      const detail = report.remainingWork[0] ?? report.unmetGoals[0] ?? report.completion;
      return { kind: 'incomplete', reason: `原始目标未全部达成：${detail}`.slice(0, 500) };
    }
    return { kind: 'complete' };
  }

  // ---- 对话激活 / watcher ----

  /**
   * I1：进入驱动阶段时，若项目**没有任何**激活对话（迁移只登记了 conv、重启丢激活行），
   * 激活本 issue 的对话；普通阶段切换不夺占已有对话。显式/排队恢复已取得执行权，
   * 必须切回本 issue，否则会被 tick 的 conv_displaced 门禁永久跳过。
   * 门禁与让位观测在 tickIssue（I2）。失败 → paused（返回 false，调用方停止本阶段动作）。
   */
  private async ensureActiveConv(issue: EngineIssue, resuming = false): Promise<boolean> {
    const current = this.deps.convs.currentConv(issue.projectId);
    if (current !== undefined && (!resuming || current === issue.convId)) return true;
    try {
      await this.activateConv(issue);
      return true;
    } catch (e) {
      // ensureActiveConv 只从 onEnter 调用，此处已持有本 issue 的 transition 锁。
      await this.applyEventLocked(issue.id, 'pause', {
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
      reclaimFailures: 0,
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
      await this.applyEvent(issue.id, 'pause', {
        note:
          `代理起不来：已自动重启 ${w.agentRestarts} 次，${session} 窗格里仍只剩 shell` +
          `（常见原因：登录过期、CLI 装坏、项目目录没了）`,
      });
      return;
    }
    w.agentRestarts++;
    const restarts = w.agentRestarts;
    const reclaimFailures = w.reclaimFailures;
    try {
      await this.relaunchConv(issue);
      // 冷却与计数都要带进新 watch（relaunchConv 内部 resetWatch 会重置它们）：
      // 冷却防「重启后立刻又判死」的 3s 打转，计数丢了则永远到不了上限。
      // reclaimFailures 同理（#273）：reclaim 连续失败会走到这里，重启后清零就等于
      // 又能从头空转三轮再来一次重启。
      const fresh = issue.convId ? this.watch.get(issue.convId) : undefined;
      if (fresh) {
        fresh.agentDownAt = now;
        fresh.agentRestarts = restarts;
        fresh.reclaimFailures = reclaimFailures;
        fresh.resumePending = true; // 等它真就绪再补催办（见 tickIssue 的接续块）
      }
      this.store.logEvent(issue.id, 'agent_restarted', { session, restarts });
    } catch (e) {
      this.store.logEvent(issue.id, 'error', {
        where: 'agentRestart',
        error: String(e).slice(0, 200),
      });
      if (e instanceof AgentExecutableNotFoundError) {
        await this.applyEvent(issue.id, 'pause', { note: e.message });
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
   * 自动重试计数的锚点事件 id（#273）：nudge / judge 的次数上限都从这里往后数。
   *
   * 取「最近一次**人工介入**」——复活重跑（`reopened`）、解除阻塞并给指引
   * （`unblock_guidance`）、回答澄清（`clarified`）。人一插手就重新给一份预算，
   * 因为现场刚被改变，之前那几次白催的记录不该继续压着新一轮。
   *
   * **刻意不按阶段重置**：验收要的是「单 issue nudge ≤ 5 次」，按 stage 重置会变成
   * planning/implementing/testing 各 5 次共 15 次，对不上；而真正的病灶（#41 的 71 次）
   * 本来就集中在同一个阶段里。从未介入过返回 0 = 从 issue 创建起算全量。
   */
  private attentionAnchor(issueId: number): number {
    return Math.max(
      this.store.lastEventId(issueId, 'reopened'),
      this.store.lastEventId(issueId, 'unblock_guidance'),
      this.store.lastEventId(issueId, 'clarified'),
    );
  }

  /**
   * 止损计数的锚点（#274）：最近一次**止损恢复**（`stop_loss_resumed`）之后重新计。
   *
   * 与 #273 的 `attentionAnchor` 分开是刻意的：那个锚点还认答澄清/解除阻塞，
   * 因为催办/判定的预算该随任何一次人工介入回满；而止损闸盯的是「这条 issue 到底
   * 烧了多少」，只有用户明确看过账单说「继续」才应该重新计。
   */
  private stopLossAnchor(issueId: number): number {
    return this.store.lastEventId(issueId, 'stop_loss_resumed');
  }

  /**
   * 止损闸判定（#274 / I-06）：三个条件满足任一即返回命中原因与当时的三项计数；
   * 都没命中返回 null。纯读，不产生任何副作用——触发动作由调用方负责。
   *
   * 幂等由调用方按事件保证：同一锚点周期内已经有 `stop_loss_triggered` 就不该再触发。
   */
  private evaluateStopLoss(issue: EngineIssue): {
    reason: 'blocked' | 'runtime' | 'stage_reentry';
    blockCount: number;
    stageReentry: number;
    runtimeMs: number;
  } | null {
    const anchor = this.stopLossAnchor(issue.id);
    // 时间基准必须与事件对齐：`logEvent` 写的是真实 `Date.now()`，而 `this.now()` 是可注入时钟。
    // 两者相减在生产上等价，但在注入了假时钟的测试里会把「刚落库的事件」算成几百秒前。
    const stats = this.store.stopLossStats(issue.id, anchor, issue.status, Date.now());
    // 顺序即优先级：先报「反复受阻」这种最有信息量的，跑太久放最后（它对什么都成立）
    if (stats.blockCount >= this.cfg.stopLossBlockCount) return { reason: 'blocked', ...stats };
    if (stats.stageReentry >= this.cfg.stopLossStageReentry) {
      return { reason: 'stage_reentry', ...stats };
    }
    if (stats.runtimeMs > this.cfg.stopLossRuntimeMs) return { reason: 'runtime', ...stats };
    return null;
  }

  /**
   * 止损闸的触发动作（#274 / I-06）：命中即落 `stop_loss_triggered` + 打 `blocked`，
   * 并给这次 blocked 带上 `stopLoss` 标记。返回是否真的触发了。
   *
   * 为什么复用 blocked 而不是新造一个状态：blocked 已经具备本闸需要的全部行为——停自动调度、
   * 保留 `resumeState` 恢复上下文、被 pickNext 天然跳过、收尾时 `scheduleNext` 接力不卡队列，
   * 而独立状态要动 issues 表的 CHECK 约束（SQLite 只能整表重建，风险远大于收益）。
   * 「受阻」与「已暂停」在界面上的区分交给 #275 的 attentionKind 统一收口，本条只保证
   * 事件结构化、可被读取派生。
   *
   * **`stopLoss` 标记不是装饰**：`stopLossStats` 数 blockCount 时要跳过它，否则闸会自我放大
   * ——暂停一次计数就 +1，人工恢复后立刻又够阈值。
   *
   * 幂等以事件为凭：同一锚点周期内已经触发过就不再触发（每 3s 一个 tick，不幂等就是刷屏）。
   */
  private async tripStopLoss(
    issue: EngineIssue,
    apply: (id: number, ev: IssueMachineEvent, opts: {
      note?: string; stopLoss?: boolean;
    }) => Promise<ApplyResult>,
  ): Promise<boolean> {
    if (!BUSY_STATES.includes(issue.status)) return false;
    const anchor = this.stopLossAnchor(issue.id);
    if (this.store.countEventsSince(issue.id, 'stop_loss_triggered', anchor) > 0) return false;
    const hit = this.evaluateStopLoss(issue);
    if (!hit) return false;
    this.store.logEvent(issue.id, 'stop_loss_triggered', {
      reason: hit.reason,
      blockCount: hit.blockCount,
      stageReentry: hit.stageReentry,
      runtimeMs: hit.runtimeMs,
      stage: issue.status,
    });
    const hours = Math.round((hit.runtimeMs / 3_600_000) * 10) / 10;
    const why = hit.reason === 'blocked'
      ? `已累计受阻 ${hit.blockCount} 次`
      : hit.reason === 'stage_reentry'
        ? `已在「${issue.status}」阶段反复重入 ${hit.stageReentry} 次`
        : `已累计运行 ${hours} 小时`;
    await apply(issue.id, 'pause', {
      note: `止损暂停：${why}，先停下来等你确认。这不是执行失败——现场与恢复上下文都在，` +
        `确认后从原阶段继续即可。`,
      stopLoss: true,
    });
    await this.notifySafe({
      kind: 'issue_blocked',
      projectId: issue.projectId,
      issueId: issue.id,
      summaryCode: 'stop_loss_paused',
      summaryParams: {
        title: issue.title.slice(0, 60),
        reason: hit.reason,
        blocks: hit.blockCount,
        reentries: hit.stageReentry,
        hours,
      },
    });
    return true;
  }

  /**
   * 「这条 issue 在等什么」的统一派生（#275 / I-07）。判定规则全在 issues/attention.ts，
   * 这里只负责把引擎才拿得到的三样东西喂进去：状态、事件流、以及**外部**的弹窗等待标记
   * （waitingInput 是审批管道的内存态，引擎自己看不到，由路由层传入）。
   */
  attentionKindOf(issue: EngineIssue, waitingInput = false): AttentionKind {
    return attentionKindOf({
      status: issue.status,
      events: this.store.listEvents(issue.id),
      clarifyPending: this.store.clarifyPendingOf(issue.id),
      waitingInput,
      unblockQueued: this.store.pendingUnblockRequest(issue.id) !== null,
    });
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
          await this.applyEvent(issue.id, 'pause', {
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
          await this.applyEvent(issue.id, 'pause', {
            note: `工作流执行失败：${workflow.pauseReason ?? 'workflow.failed'}`,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * 从 assistant 文本里捞结构化完成报告（#275 / I-05）：多条文本取**第一份能解析通过的**。
   * 报告是锦上添花——解析不通过只落一条观测事件，绝不影响收尾流程本身。
   */
  private captureCompletionReport(issueId: number, texts: string[]): void {
    let sawBlock = false;
    for (const t of texts) {
      if (!/^\s*REPORT_BEGIN\s*$/m.test(t)) continue;
      sawBlock = true;
      const report = parseCompletionReportBlock(t);
      if (!report) continue;
      this.store.setCompletionReport(issueId, report);
      this.store.logEvent(issueId, 'completion_report', { via: 'sentinel', outcome: report.outcome });
      return;
    }
    // 有块但解析不出来：代理格式写错了，值得留痕（否则「报告怎么没了」无从查起）
    if (sawBlock) {
      this.store.logEvent(issueId, 'completion_report', { via: 'sentinel', invalid: true });
    }
  }

  private async tickIssue(issue: EngineIssue): Promise<void> {
    // A durable design-sync boundary freezes every watcher-driven side effect, including session
    // recovery, kickoff and nudge. Restart therefore cannot drive past an undecided revision.
    if (this.store.activeExecutionSyncBoundary(issue.id)
      || this.store.hasUnresolvedExecutionSyncEffect(issue.id)) return;
    const project = this.project(issue.projectId);
    if (!project) return;
    // 止损闸（#274）：放在最前面。「累计运行 > 4 小时」这类条件不依赖任何状态迁移，
    // 只有 tick 会发现它；命中就收手，本 tick 一个字都不再注入。
    if (await this.tripStopLoss(issue, (id, blockEvent, blockOpts) =>
      this.applyEvent(id, blockEvent, blockOpts))) return;
    if (this.workflowSnapshot(issue.id)) {
      await this.tickWorkflowIssue(issue, project);
      return;
    }
    if (issue.executionMode === 'direct' && issue.status === 'testing' && issue.completionReport) {
      await this.completeTesting(issue.id, 'sentinel');
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
          await this.applyEvent(issue.id, 'pause', { note: e.message });
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
          await this.applyEvent(issue.id, 'pause', { note: e.message });
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
      const pm = this.deps.pmFor(project);
      const failure = issue.agent === 'codex' && pm.judgeAgentFailure
        ? await pm.judgeAgentFailure(issue.agent, pane).catch(() => 'unknown' as const)
        : 'ordinary_exit';
      if (failure === 'resume_conflict') {
        this.store.logEvent(issue.id, 'agent_resume_conflict', { session });
        await this.applyEvent(issue.id, 'block', { note: 'Codex 恢复失败：该会话仍被另一个 active writer/active turn 占用。请先结束占用该会话的 Codex 进程，或新建会话后再解除受阻。' });
        return;
      }
      if (failure === 'unknown') return;
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
          // #275 / B-07：状态并没有进 blocked，这里发受阻通知是误导——用户会去找一个
          // 并不存在的故障，而实际上只要去窗格里点一下选项就完了
          kind: 'choice_waiting',
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
      try {
        this.deps.onTextPrompt?.({ issue, project, session, pane });
      } catch (e) {
        this.store.logEvent(issue.id, 'error', { where: 'onTextPrompt', error: String(e).slice(0, 200) });
      }
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
          this.buildIssueNudge({
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
      now - w.reclaimAt > this.reclaimCooldownMs(w.reclaimFailures)
    ) {
      w.reclaimAt = now;
      let np: string | null = null;
      try {
        np = (await this.deps.locator.reclaim?.(convId)) ?? null;
      } catch (e) {
        this.store.logEvent(issue.id, 'error', { where: 'reclaim', error: String(e).slice(0, 200) });
      }
      if (np && np !== path) {
        w.reclaimFailures = 0; // 认领到新会话即视作恢复，退避从头开始
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
            this.buildIssueNudge({
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
      // 认不到（或认回同一条）都算一次没进展（#273 / B-05）：本周 130 次
      // 「未发现可认领的活跃会话」全出自这里——sessionStaleMs 既当判定阈值又当重试冷却，
      // 失败后每分钟原地重扫一遍，扫到天荒地老也不会升级。
      w.reclaimFailures++;
      if (!np) {
        this.store.logEvent(issue.id, 'error', { where: 'reclaim', error: '未发现可认领的活跃会话' });
      }
      if (w.reclaimFailures >= this.cfg.reclaimMaxFailures) {
        // 连着几轮都找不到活跃会话 = 会话确已丢失，交给 #97 的恢复路径（重启 + 既有
        // 重启次数上限 + 到顶 block），别再空转重扫。先清零再调：handleAgentDown 会把
        // reclaimFailures 带进重启后的新 watch，重启后理应重新给一份预算。
        w.reclaimFailures = 0;
        await this.handleAgentDown(issue, w, session, now);
        return; // 会话刚被重起，本 tick 一个字都不再往旧 watch 上注入
      }
    }

    // 静默三级：nudge（180s）→ PM 保守判（360s，每 360s 重判防一次误判卡死）
    const fresh = this.store.get(issue.id);
    if (!fresh || !DRIVING_STATES.includes(fresh.status)) return;

    // 执行中澄清等待（spec 1/2）：代理输出 NEED_CLARIFY 后停催停判，静静等用户回答；
    // 关键澄清超过等待阈值只提醒，不推定回答或恢复执行。
    const wait = this.store.execClarifyWait(fresh.id);
    if (wait) {
      if (now - wait.since >= this.cfg.clarifyTimeoutMs &&
        this.store.lastEventId(fresh.id, 'clarify_wait_reminder') < this.store.lastEventId(fresh.id, 'clarify_questions')) {
        this.store.logEvent(fresh.id, 'clarify_wait_reminder', { stage: fresh.status, reason: 'essential-answer-required' });
      }
      return; // 未到点：既不 nudge 也不 judge
    }

    const idleMs = now - Math.max(w.fedTs, w.activityTs);
    // quiet 是「静默且没有弹窗挡着」这个基础判据，judge 仍按它 + fallbackSec 走；
    // 催办另有一条按次数退避、会越抬越高的阈值（见下）。
    const quiet = idleMs > this.cfg.nudgeSec * 1000 && !sel;

    // 催办退避与封顶（#273 / B-03）。#41 曾在 272 分钟里被催 71 次，每次都是一发带
    // 100k+ 上下文的完整模型请求。次数取「人工介入锚点之后的 nudged 事件数」——事件为凭、
    // 重启不丢，也不会被 reclaim/relaunch 的 resetWatch 抹掉；`w.nudged` 那个布尔只挡得住
    // 同一空闲窗口内每 3s 重复注入，挡不住「代理动一下 → 又静默 → 再催」的无限循环
    // （tail 里一有 assistant/tool 消息就把它清零，正是 71 次的成因）。
    // 自动手段的总闸（#273）：催办与判定**各算各的 5 次**，任一到顶就**彻底停催停判、静等人工**。
    // 之所以是「一个到顶两个都停」而不是各停各的：到这一步已经证明自动手段推不动了，
    // 判定本身也是一次带上下文的模型请求，继续判只是换个名目接着烧钱。
    // 封顶判定**不受 `!w.nudged` 约束**：催完最后一次后代理彻底哑了的话 `w.nudged` 会一直
    // 停在 true，挂在它下面就永远提醒不出来。exhaustAutoRetry 自身幂等。
    // 上限 ≤0 表示**关闭该机制**（测试用），不是「一上来就耗尽」——否则关掉催办会连带停掉判定。
    if (quiet) {
      const anchor = this.attentionAnchor(fresh.id);
      const sentSoFar = this.store.countEventsSince(fresh.id, 'nudged', anchor);
      const judgedSoFar = this.store.countEventsSince(fresh.id, 'judged', anchor);
      const nudgeUsedUp = this.cfg.nudgeMaxCount > 0 && sentSoFar >= this.cfg.nudgeMaxCount;
      const judgeUsedUp = this.cfg.judgeMaxCount > 0 && judgedSoFar >= this.cfg.judgeMaxCount;
      if (nudgeUsedUp) await this.exhaustAutoRetry(fresh, 'nudge', sentSoFar, anchor);
      if (judgeUsedUp) {
        const last = this.store.consecutiveJudged(fresh.id, anchor);
        await this.exhaustAutoRetry(fresh, 'judge', judgedSoFar, anchor, {
          ...(last.result ? { result: last.result } : {}),
        });
      }
      // 到顶转人工：只落事件 + 通知，**不 block**——推不动多半是代理在长跑或真卡住，
      // 打死 issue 会丢掉现场；哨兵与存活门禁仍在跑，它自己完事照样能收尾。
      if (nudgeUsedUp || judgeUsedUp) return;
    }

    let nudgedThisTick = false;
    if (quiet && this.cfg.nudgeMaxCount > 0) {
      const anchor = this.attentionAnchor(fresh.id);
      const sent = this.store.countEventsSince(fresh.id, 'nudged', anchor);
      if (!w.nudged && idleMs > this.backoffMs(this.cfg.nudgeSec, sent, this.cfg.nudgeMaxIntervalSec)) {
        const subs = this.store.subtasksOf(fresh);
        const seqPending = fresh.implMode === 'seq' && subs.length > 0 && fresh.subIndex < subs.length && !this.isRework(fresh);
        const msg = this.buildIssueNudge({
          issue: fresh,
          stage: fresh.status as 'planning' | 'implementing' | 'testing',
          seqPending,
          locale: this.promptLocale(fresh, project),
        });
        await this.inject(session, msg);
        w.nudged = true;
        w.fedTs = this.now();
        nudgedThisTick = true;
        this.store.logEvent(fresh.id, 'nudged', { stage: fresh.status, count: sent + 1 });
      }
    }
    // 判定从原来的 `else if (quiet && !w.nudged)` 里拆出来：催办正在退避时兜底判定照常跑
    // （封顶那一档已在上面的总闸里连带停掉）。仍保持「同一 tick 不既催又判」——
    // nudgedThisTick 就是原 else 分支的等价守卫。
    if (!nudgedThisTick && quiet && this.cfg.judgeMaxCount > 0 && idleMs > this.cfg.fallbackSec * 1000) {
      // 判定退避（#273 / B-04）。#266 一条 issue 在 384 分钟里判了 97 次、结论全是 not_done——
      // fallbackSec 是等距硬轮询，判定结论完全不参与下次调度。
      // 现在改成「同结论连击越多、下次越晚」，结论一变立刻回落基准（现场在动，不该继续拉长）。
      const anchor = this.attentionAnchor(fresh.id);
      {
        // streak-1 而不是 streak：结论一变 streak 归 1，此时要的是**基准**间隔而不是 2 倍。
        // 于是首判与紧随其后的第一次复判都还是 fallbackSec，从第三次起才开始翻倍。
        const { streak } = this.store.consecutiveJudged(fresh.id, anchor);
        const due = this.backoffMs(this.cfg.fallbackSec, streak - 1, this.cfg.judgeMaxIntervalSec);
        if (now - w.doneChecked > due) {
          w.doneChecked = now;
          await this.judgeFallback(fresh, project, path, session, w);
        }
      }
    }
  }

  /**
   * 指数退避间隔（#273 三条共用）：`baseSec * 2^steps`，封顶 maxSec，返回毫秒。
   * steps=0 即基准值——**第一次的时机与改造前完全一致**，健康 issue 零回归。
   */
  private backoffMs(baseSec: number, steps: number, maxSec: number): number {
    const grown = baseSec * 2 ** Math.max(0, steps);
    return Math.min(grown, maxSec) * 1000;
  }

  /**
   * reclaim 重试冷却（#273 / B-05）：`sessionStaleMs * 2^连续失败数`，封顶
   * reclaimMaxCooldownMs。failures=0 即原来的 sessionStaleMs——**第一次重试的节奏不变**。
   * 与 backoffMs 分开写是因为这条的基准本来就是毫秒（sessionStaleMs），换算反而更绕。
   */
  private reclaimCooldownMs(failures: number): number {
    const grown = this.cfg.sessionStaleMs * 2 ** Math.max(0, failures);
    return Math.min(grown, this.cfg.reclaimMaxCooldownMs);
  }

  /**
   * 自动重试到顶 → 转人工待处理（#273 / B-03、B-04）。
   *
   * 预算耗尽进入 paused，保存现场并释放普通队列占用；不等同于目标失败或外部受阻。
   *
   * 幂等以事件为凭：同一锚点周期内只提醒一次，否则每 3s 一个 tick 就会刷屏。
   */
  private async exhaustAutoRetry(
    issue: EngineIssue,
    reason: 'nudge' | 'judge',
    count: number,
    anchor: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const kind = reason === 'nudge' ? 'nudge_exhausted' : 'judge_exhausted';
    if (this.store.countEventsSince(issue.id, kind, anchor) > 0) return;
    this.store.logEvent(issue.id, kind, { count, stage: issue.status, ...extra });
    await this.notifySafe({
      kind: 'status_change',
      projectId: issue.projectId,
      issueId: issue.id,
      summaryCode: 'auto_retry_exhausted',
      summaryParams: { title: issue.title.slice(0, 60), reason, count },
    });
    await this.applyEvent(issue.id,'pause',{note:`自动${reason === 'nudge' ? '催办' : '判定'}已达 ${count} 次上限，保留现场，检查执行状态后继续`});
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
        await this.applyEvent(issue.id, 'pause', {
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
        await this.applyEvent(fresh.id, 'pause', { note: '执行工作区不可用' });
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

  private buildIssueNudge(opts: Parameters<typeof buildNudge>[0]): string {
    const issue = this.store.get(opts.issue.id);
    if (issue?.executionMode === 'direct' && (issue.status === 'implementing' || issue.status === 'testing')) {
      const marker = `ISSUE_READY:${issue.id}:${this.store.lastEnterEventId(issue.id, 'implementing')}`;
      return buildNudge({ ...opts, stage: 'testing' }).replaceAll(`STAGE_DONE:${issue.id}:testing`, marker);
    }
    return buildNudge(opts);
  }

  private buildKickoffPrompt(
    issue: EngineIssue,
    project: Project,
    workspace: EngineExecutionWorkspace,
  ): { text: string; meta: Record<string, unknown> } | null {
    const branch = issue.branch ?? ''; // 进 implementing 时已记下目标分支或历史 issue 的当前分支
    const imgHint = imageReadHint(this.absImages(workspace, issue));
    const locale = this.promptLocale(issue, project);
    const stageEntry = this.store.lastEnterInfo(issue.id, issue.status);
    if (issue.executionMode === 'direct' && issue.status === 'implementing') {
      return {
        text: buildDirectPrompt({ issue, branch, locale, imgHint,
          attempt: this.store.lastEnterEventId(issue.id, 'implementing'),
          feedback: stageEntry?.note, docPath: issue.docPath }),
        meta: { kind: 'direct', attempt: this.store.lastEnterEventId(issue.id, 'implementing') },
      };
    }
    if (issue.executionMode === 'direct' && issue.status === 'testing') return null;
    if (
      stageEntry?.event === 'unblock' &&
      (issue.status === 'planning' || issue.status === 'implementing' || issue.status === 'testing')
    ) {
      const recoveryEvent = [...this.store.listEvents(issue.id)].reverse()
        .find((event) => event.kind === 'unblock_guidance');
      let guidance = stageEntry.note ?? '';
      if (recoveryEvent?.dataJson) {
        try {
          const data = JSON.parse(recoveryEvent.dataJson) as { guidance?: unknown };
          if (typeof data.guidance === 'string' && data.guidance.trim()) guidance = data.guidance;
        } catch {
          // transition.note 仍提供保守兜底，损坏的审计扩展字段不阻断恢复。
        }
      }
      const subtasks = this.store.subtasksOf(issue);
      return {
        text: buildRecoveryResumePrompt({
          issue,
          stage: issue.status,
          guidance,
          branch,
          currentSubtask: subtasks[issue.subIndex]?.text,
          subtaskIndex: issue.subIndex,
          subtaskTotal: subtasks.length,
          team: issue.implMode === 'team',
          locale,
        }),
        meta: { kind: 'recovery_resume', stage: issue.status, subIndex: issue.subIndex },
      };
    }
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
          text: buildPlanningPrompt({ issue, goal: project.goal, feedback, recovery, imgHint, moduleName, locale, manualReview: project.manualReview }),
          meta: { kind: 'planning', ...(feedback ? { rework: true } : {}), ...(recovery ? { recovery: true } : {}) },
        };
      }
      case 'implementing': {
        const entry = this.store.lastEnterInfo(issue.id, 'implementing');
        if (entry && (entry.event === 'tests_failed' || entry.event === 'work_remaining' || entry.event === 'review_rejected')) {
          return {
            text: buildReworkPrompt({
              issue,
              feedback: entry.note ?? '',
              branch,
              source: entry.event !== 'review_rejected' ? 'tests_failed' : 'review_rejected',
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
    for (const msg of msgs) {
      if (msg.role === 'tool_use' && msg.tool === 'Skill') this.store.logEvent(issueId,'skill_invoked',{tool:msg.tool,input:msg.input?.slice(0,300),callId:msg.toolCallId});
      else if (msg.role === 'tool_use' && /SKILL\.md/.test(msg.input ?? '')) this.store.logEvent(issueId,'skill_read',{tool:msg.tool,input:msg.input?.slice(0,300),callId:msg.toolCallId});
    }
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

    // 两个协议标记在任何驱动阶段都认，**NEED_CLARIFY 优先**（#275 / B-08）。
    //
    // 原来是 ISSUE_BLOCKED 的循环在前、命中即 return，于是同一条回复里两个都出现时
    // 一律被判 blocked——代理问的问题连记都没记，用户只看到「受阻」，还得人工解阻再问一遍
    // （本周 41 次 blocked 里有相当一部分就是这么来的）。混发时按澄清处理才是对的：
    // 澄清是可逆的（答了就继续、20 分钟不答自动继续），而 blocked 要人工解锁且会中断接力，
    // 判错的代价不对称。prompts 那边也把边界讲清了（sentinelBoundary），两头配套。
    const blocked = texts.map((t) => findBlocked(t, id)).find((b) => !!b) ?? null;
    const clarifyHits = texts.filter((t) => findNeedClarify(t, id));

    if (clarifyHits.length > 0) {
      // 幂等：已在等待中（execClarifyWait 非空）不重复记/推——避免每 tick 重复。
      if (!this.store.execClarifyWait(id)) {
        const qs = clarifyHits.flatMap((t) => parseClarifyQuestions(t));
        const questions = [...new Set(qs)].slice(0, MAX_CLARIFY_QUESTIONS); // 多条文本各自抽，去重保序
        if (blocked) {
          // 观测埋点：用来看 prompt 的边界描述到底改好没有，混发次数应当随之下降
          this.store.logEvent(id, 'sentinel_conflict', {
            blockedNote: (blocked.note || '').slice(0, 300),
            questions,
          });
        }
        // 原文留档（#110）：清单项之外的前提/现状散文也要给用户看全
        const text = extractClarifyText(clarifyHits.join('\n\n'));
        await this.enterExecClarify(issue, issue.status, questions, 'sentinel', text);
        const w = issue.convId ? this.watch.get(issue.convId) : undefined;
        if (w) w.nudged = false; // 清掉残留催促态，等待期不再触发 nudge
      }
      return; // 不推进：等用户回答或超时
    }

    if (blocked) {
      this.store.logEvent(id, 'sentinel', { kind: 'blocked', note: blocked.note });
      await this.applyEvent(id, 'block', { note: blocked.note || '(未说明)' });
      return;
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
        if (issue.executionMode === 'direct') {
          const attempt = this.store.lastEnterEventId(id, 'implementing');
          const ready = `ISSUE_READY:${id}:${attempt}`;
          const reportTexts = texts.filter(t => t.split('\n').some(line => line.trim() === ready));
          if (reportTexts.length) {
            this.captureCompletionReport(id, reportTexts);
            this.store.logEvent(id, 'direct_ready', { attempt });
            await this.applyEvent(id, 'impl_done');
            if (this.store.get(id)?.status === 'testing') await this.completeTesting(id, 'sentinel');
          } else {
            const plan = texts.flatMap(t => t.split('\n')).find(line => line.startsWith(`NEED_PLAN:${id}:${attempt} `));
            if (plan) await this.applyEvent(id, 'request_plan', { note: plan.slice(plan.indexOf(' ') + 1, 500) });
          }
          return;
        }
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
        if (texts.some((t) => issue.executionMode === 'direct'
          ? t.split('\n').some(line => line.trim() === `ISSUE_READY:${id}:${this.store.lastEnterEventId(id, 'implementing')}`)
          : findStageDone(t, id, 'testing'))) {
          // 收尾报告随同一条回复内联带出（#275 / I-05）：解析成功就存，失败/缺失一律忽略，
          // 退回确定性拼装。**必须在 tests_passed 之前存**——那一步会一路推到 merge_review，
          // 收尾的摘要拼装就要读这份报告了。
          this.captureCompletionReport(id, issue.executionMode === 'direct' ? texts.filter(t =>
            t.split('\n').some(line => line.trim() === `ISSUE_READY:${id}:${this.store.lastEnterEventId(id, 'implementing')}`)) : texts);
          this.store.logEvent(id, 'sentinel', { kind: 'stage_done', stage: 'testing' });
          // #279：代理只做自检与完成报告，门禁由引擎在会话外跑（通过才放行）
          await this.completeTesting(id, 'sentinel');
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

  // ---- 门禁执行（#279 / I-03）：在会话外跑，代理这几分钟是空闲的、不烧 token ----

  /**
   * 本轮门禁的执行范围：进 testing 时算一次并落库（UI 要看、复跑要用）。
   *
   * 改动清单取自 `impl_base..工作区`（含未提交改动）+ 未跟踪文件；候选测试文件要**真的存在**
   * 才进定向清单（存在性用 driver 校验，推导本身是纯函数）。任何一步取不到就退回全量——
   * 门禁宁可多跑，也不能给一个「定向全绿、全量爆炸」的假绿灯。
   */
  private async computeValidationScope(
    issue: EngineIssue,
    workspace: EngineExecutionWorkspace,
  ): Promise<ValidationScope> {
    const cwd = workspace.cwd;
    const base = this.implBaseSha(issue.id);
    const changed = new Set<string>();
    try {
      if (base) {
        const diff = await this.deps.driver.git(cwd, ['diff', '--name-only', base]);
        if (diff.code === 0) for (const line of diff.out.split('\n')) if (line.trim()) changed.add(line.trim());
      }
      const status = await this.deps.driver.git(cwd, ['status', '--porcelain']);
      if (status.code === 0) {
        for (const line of status.out.split('\n')) {
          const p = line.slice(3).trim();
          if (p) changed.add(p.includes(' -> ') ? p.split(' -> ')[1]!.trim() : p);
        }
      }
    } catch (e) {
      this.store.logEvent(issue.id, 'error', { where: 'validation-scope', error: String(e).slice(0, 200) });
      return { kind: 'full', files: [], reason: '读改动清单失败' };
    }
    const files = [...changed];
    const existing = new Set<string>();
    for (const f of files) {
      for (const candidate of candidateTestFiles(f)) {
        if (existing.has(candidate)) continue;
        const stat = await this.deps.driver.statPath(join(cwd, candidate)).catch(() => null);
        if (stat?.isFile) existing.add(candidate);
      }
    }
    if (existing.size === 0 && files.length) {
      const tracked = await this.deps.driver.git(cwd, ['ls-files', '-z']);
      if (tracked.code === 0) for (const name of tracked.out.split('\0')) {
        if (/\.test\.[cm]?[jt]sx?$/.test(name) && (await this.deps.driver.statPath(join(cwd, name)))?.isFile) existing.add(name);
      }
    }
    return deriveValidationScope(files, existing);
  }

  /** 读项目 package.json（探测默认门禁命令用）；读不到返回 null，由调用方降级 */
  private async readPackageJson(cwd: string): Promise<string | null> {
    try {
      const path = join(cwd, 'package.json');
      const stat = await this.deps.driver.statPath(path);
      if (!stat?.isFile || stat.size === 0) return null;
      const r = await this.deps.driver.readFileRange(path, 0, Math.min(stat.size, 256 * 1024));
      return new TextDecoder().decode(r.data);
    } catch {
      return null;
    }
  }

  /**
   * 跑一轮门禁。返回 'passed' | 'failed' | 'skipped'；**skipped 一律按放行处理**——
   * 没配命令、也探测不到（不是 bun 项目、临时仓库），不能因此把 issue 卡在 testing。
   */
  private async runValidationGate(
    issue: EngineIssue,
    project: Project,
  ): Promise<{ outcome: 'passed' | 'failed' | 'skipped' | 'error'; note: string }> {
    if (this.cfg.validationTimeoutMs <= 0) return { outcome: 'skipped', note: '门禁执行已关闭' };
    let workspace: EngineExecutionWorkspace;
    try {
      workspace = await this.resolveExecutionWorkspace(issue, project);
    } catch (e) {
      this.store.logEvent(issue.id, 'error', { where: 'validation-workspace', error: String(e).slice(0, 200) });
      this.store.logEvent(issue.id,'validation_error',{reason:'workspace-unavailable'});
      return { outcome: 'error', note: '执行工作区不可用，恢复后重试验证' };
    }
    const scope = await this.computeValidationScope(issue, workspace);
    this.store.setValidationScope(issue.id, scope);

    const commands = resolveValidationCommands(
      project.validationCommands,
      await this.readPackageJson(workspace.cwd),
    );
    if (commands.length === 0) {
      this.store.logEvent(issue.id, 'validation_skipped', { reason: 'no-commands' });
      return { outcome: 'skipped', note: '没有可执行的门禁命令' };
    }
    this.store.logEvent(issue.id, 'validation_started', {
      scope: scope.kind,
      files: scope.files.length,
      commands: commands.map((c) => c.label),
    });
    const cacheable = project.validationCommands === null && commands.every(c => c.argv[0] === 'bun');
    const identity = cacheable ? await validationIdentity(this.deps.driver, workspace.cwd) : null;
    const passed = new Set(this.store.listEvents(issue.id).filter(e => e.kind === 'validation_check_passed')
      .flatMap(e => { try { return [JSON.parse(e.dataJson ?? '{}').key as string]; } catch { return []; } }));
    const executor = {
      runCommand: async (cwd: string, argv: string[], timeoutMs: number) => {
        const key = identity ? validationCheckKey(identity, argv) : null;
        if (key && passed.has(key)) {
          this.store.logEvent(issue.id, 'validation_reused', { key, argv });
          return { code: 0, out: '', err: '', durationMs: 0, timedOut: false };
        }
        const result = await this.deps.driver.runCommand(cwd, argv, timeoutMs);
        if (key && result.code === 0 && !result.timedOut) {
          // Commands that change inputs must never certify the old identity.
          if (await validationIdentity(this.deps.driver, cwd) === identity) {
            this.store.logEvent(issue.id, 'validation_check_passed', { key, argv, durationMs: result.durationMs });
          } else this.store.logEvent(issue.id, 'validation_invalidated', { reason: 'inputs-changed-during-check' });
        }
        return result;
      },
    };
    let run;
    try {
      run = await runValidation(executor, workspace.cwd, commands, project.validationCommands !== null ? { kind: 'full', files: [], reason: '项目明确配置' } : scope, {
        timeoutMs: this.cfg.validationTimeoutMs,
      });
    } catch (e) {
      // 执行入口本身炸了（连接断、命令不存在）不是「门禁未通过」：放行交给后续人工，
      // 把它算成失败会让一条本来好好的 issue 因为执行机抖动被打回返工。
      this.store.logEvent(issue.id, 'error', { where: 'validation', error: String(e).slice(0, 300) });
      this.store.logEvent(issue.id,'validation_error',{reason:'executor-error'});
      return { outcome: 'error', note: '门禁执行失败（执行机异常），恢复后重试验证' };
    }
    if (run.skipped) {
      this.store.logEvent(issue.id, 'validation_skipped', { reason: 'no-commands' });
      return { outcome: 'skipped', note: '没有可执行的门禁命令' };
    }
    if (run.ok) {
      this.store.logEvent(issue.id, 'validation_passed', {
        scope: scope.kind,
        durationMs: run.durationMs,
        steps: run.steps.map((x) => ({ label: x.label, durationMs: x.durationMs })),
      });
      return { outcome: 'passed', note: '' };
    }
    const failed = run.failed!;
    this.store.logEvent(issue.id, 'validation_failed', {
      scope: scope.kind,
      label: failed.label,
      code: failed.code,
      timedOut: failed.timedOut,
      durationMs: run.durationMs,
      tail: run.tail.slice(0, 2000),
    });
    return {
      outcome: 'failed',
      note: `门禁「${failed.label}」未通过（退出码 ${failed.code}）：\n${run.tail}`.slice(0, 1600),
    };
  }

  /**
   * testing 收尾的**唯一出口**（#279）：代理说完事了（哨兵或 PM 兜底判定）之后，
   * 由引擎在会话外跑门禁，通过才 `tests_passed`，不通过按 `tests_failed` 回灌输出尾部返工。
   * 两个调用点（哨兵、空闲兜底）都走这里，别再各自 applyEvent('tests_passed')。
   */
  private async completeTesting(issueId: number, source: 'sentinel' | 'judge'): Promise<void> {
    const issue = this.store.get(issueId);
    const project = issue ? this.project(issue.projectId) : undefined;
    if (!issue || !project) return;
    // A missing report is a protocol repair, not a user-action blocker. Ask once before
    // running gates, so the repair does not repeat validation or lose the testing context.
    if (this.cfg.resultSummaryTimeoutMs > 0 && !issue.completionReport && issue.convId
      && this.store.countEventsSince(issueId, 'completion_report_retry', this.store.lastEnterEventId(issueId, 'implementing')) === 0) {
      const session = this.deps.convs.tmuxName(issue.projectId, issue.convId);
      await this.inject(session, this.buildIssueNudge({ issue, stage: 'testing', locale: this.promptLocale(issue, project) }));
      this.store.logEvent(issueId, 'completion_report_retry', { source });
      const watch = this.watch.get(issue.convId);
      if (watch) { watch.nudged = true; watch.fedTs = this.now(); }
      return;
    }
    if (this.cfg.resultSummaryTimeoutMs > 0 && !issue.completionReport) {
      await this.applyEvent(issueId, 'pause', { note: '完成报告补报仍无效；保留现场，修复报告协议后继续验证' });
      return;
    }
    if (issue.completionReport && (issue.completionReport.outcome !== 'complete'
      || issue.completionReport.unmetGoals.length || issue.completionReport.remainingWork.length)) {
      const report = issue.completionReport;
      await this.applyEvent(issueId, report.outcome === 'blocked' ? 'block' : 'work_remaining', {
        note: [...report.unmetGoals, ...report.remainingWork, report.completion].join('；').slice(0, 1400),
      });
      return;
    }
    const gate = await this.runValidationGate(issue, project);
    if (gate.outcome === 'error') {
      await this.applyEvent(issueId, 'pause', { note: gate.note });
      return;
    }
    if (gate.outcome !== 'failed') {
      await this.applyEvent(issueId, 'tests_passed', ...(source === 'judge'
        ? [{ note: '空闲兜底：PM 判定已完成' }] as const
        : [] as const));
      return;
    }
    // 只数**本轮**的失败（复活后重新开始，口径同哨兵路径）
    const failCount =
      this.store.countEventsSince(issueId, 'tests_failed', this.store.lastEventId(issueId, 'reopened')) + 1;
    this.store.logEvent(issueId, 'tests_failed', { note: gate.note, failCount, source: 'validation' });
    await this.applyEvent(issueId, 'tests_failed', { failCount, note: gate.note });
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
      if (issue.status === 'implementing' && issue.executionMode === 'direct') {
        await this.inject(session, this.buildIssueNudge({ issue, stage: 'implementing', locale: this.promptLocale(issue, project) }));
        w.fedTs = this.now();
      } else if (issue.status === 'implementing') {
        this.store.markAllSubtasksDone(issue.id);
        await this.applyEvent(issue.id, 'impl_done', { note: '空闲兜底：PM 判定已完成' });
      } else if (issue.status === 'testing') {
        await this.completeTesting(issue.id, 'judge'); // #279：兜底判定同样要过门禁
      } else if (issue.status === 'planning') {
        // planning：判 done 但没解析到 SUBTASKS 块 = 无计划产物，不能直接推进；
        // 也不能保守不动（#41/#47 无限 judged=done 死循环实锤）。出口：先催代理
        // 按格式重新输出（前 2 次），连续第 3 次仍无块 → 协议异常暂停
        // （applyEvent 自带 issue_blocked 通知）。计数以事件为凭，重启不丢。
        const entryId = this.store.lastEnterEventId(issue.id, 'planning');
        const strikes = this.store.consecutiveJudgedDone(issue.id, entryId);
        if (strikes >= 3) {
          await this.applyEvent(issue.id, 'pause', {
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
