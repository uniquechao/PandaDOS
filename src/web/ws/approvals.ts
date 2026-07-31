/**
 * web/ws/approvals —— 菜单审批管道（V2 审批接线约定）。
 *
 * 事件源：引擎 watch 循环的 EngineDeps.onMenu 钩子（活跃驱动会话 detectSelection 命中时
 * 每 tick 回调）。本管道负责：
 *   1. 按菜单签名（optionsSig，不含 cursorIndex）去重 + 每会话单飞；
 *   2. `pm.decideApproval(menu, {taskText})` 三层瀑布分级（approval.ts）；
 *   3. approve → 经 KeyedMutex(tmuxLockKey) 的 actOnMenu 注入选择（锁内重抓核对签名）；
 *   4. escalate → explainSelection 人话文案 + ApprovalRegistry.register +
 *      向订阅者发选择卡（cards.ts buildSelectionCard，飞书 sendCard 直发；
 *      无通道/无绑定退化为 NotifyRouter 文本事件）；
 *   5. 卡片回调/网页操作 consume(requestId)（消费即焚）→ 重抓菜单核对 menuSig 再注入，
 *      不符不注入（评审 H9/5.3#5）。
 *
 * 审计：全部动作经 deps.log 落 issue_events（menu_auto / menu_escalated / menu_card_selected），
 * 接线到 engine.store.logEvent。
 */
import type { Database } from 'bun:sqlite';
import {
  ApprovalRegistry,
  explainSelection,
  type ApprovalOutcome,
} from '../../agents/approval';
import { menuFromSelection, type MenuSnapshot } from '../../agents/pm';
import type { LlmClient } from '../../agents/llm';
import { ProjectMemberStore } from '../../core/members';
import type { SelectionPayload } from '../../core/screen';
import type { AutoApproveLevel, Project } from '../../core/types';
import { getProject, type EngineIssue, type EngineMenuCtx } from '../../issues/engine';
import type { KeyedMutex } from '../../issues/mutex';
import { buildSelectionCard } from '../../notify/cards';
import { feishuOpenidOf, userByFeishuOpenid } from '../../notify/router';
import { actOnMenu, optionsSigOf, type MenuActResult, type MenuDriver } from './inject';

// ---------- 依赖最小面（结构化依赖，PM/通知全可 mock） ----------

/** PmAgent 结构子集（agents/pm.ts；decideApproval 裸 system 分级 + systemPrompt 供解读用） */
export interface ApprovalPm {
  decideApproval(
    menu: MenuSnapshot,
    task: { taskText?: string | null },
    /** 该 issue 的自动批准档位（issue #108）；不传 = medium（历史行为） */
    level?: AutoApproveLevel,
  ): Promise<ApprovalOutcome>;
  systemPrompt(): string;
}

/** NotifyRouter.dispatch 结构子集（文本兜底出口） */
export interface ApprovalNotifier {
  dispatch(e: {
    kind: 'status_change';
    projectId: number;
    issueId: number;
    summary: string;
  }): Promise<void>;
}

/** SubscriptionStore 结构子集（升级卡收件人收敛） */
export interface ApprovalSubs {
  subscriberIds(projectId: number, issueId: number): number[];
}

/** FeishuChannel 结构子集（升级卡直发；未配置传 null → 文本兜底） */
export interface ApprovalCardChannel {
  sendCard(toOpenId: string, card: unknown): Promise<void>;
}

export interface ApprovalPipelineDeps {
  db: Database;
  llm: LlmClient;
  mutex: KeyedMutex;
  pmFor(project: Project): ApprovalPm;
  driverFor(project: Project): MenuDriver;
  subs: ApprovalSubs;
  notify: ApprovalNotifier;
  feishu: ApprovalCardChannel | null;
  /** 审计出口（接 engine.store.logEvent；缺省丢弃） */
  log?(issueId: number, kind: string, data?: Record<string, unknown>): void;
  registry?: ApprovalRegistry;
  /** actOnMenu 抓空重试间隔（测试调小） */
  retryDelayMs?: number;
}

export type ConsumeResult =
  | { ok: true; session: string; option: string }
  | { ok: false; reason: 'expired' | 'no_menu' | 'stale' | 'out_of_range' | 'forbidden' };

interface SessionState {
  /** 已处理（已注入或已升级发卡）的菜单签名——同一菜单不重复分级/刷卡 */
  handledSig: string;
  inFlight: boolean;
}

interface PendingMeta {
  projectId: number;
  issueId: number;
  createdTs: number;
}

const META_TTL_MS = 60 * 60 * 1000;

export class ApprovalPipeline {
  readonly registry: ApprovalRegistry;
  private readonly state = new Map<string, SessionState>();
  /** requestId → 项目/issue 元数据（registry 只存 session/menuSig，这里补审计/鉴权所需） */
  private readonly meta = new Map<string, PendingMeta>();

  constructor(private readonly deps: ApprovalPipelineDeps) {
    this.registry = deps.registry ?? new ApprovalRegistry();
  }

  /** 引擎 EngineDeps.onMenu 接线点（同步入口，内部异步自护，异常不逃逸） */
  onMenu(ctx: EngineMenuCtx): void {
    void this.process(ctx).catch((e) => {
      this.log(ctx.issue.id, 'error', { where: 'approval-pipeline', error: String(e).slice(0, 300) });
    });
  }

  /** 引擎 EngineDeps.onMenuGone 接线点：菜单消失即重置去重签名（v1 agent.ts:621 语义），
   *  同一菜单再次出现视为新实例重新分级。同时清掉该会话的待人工登记——菜单已不在，
   *  旧升级卡作废（consume 的 menuSig 核对本就会拒它），waiting_input 标记随之精准归零。 */
  menuGone(session: string): void {
    const st = this.state.get(session);
    if (st) st.handledSig = '';
    for (const rid of this.registry.dropBySession(session)) this.meta.delete(rid);
  }

  /** 仍在等人工处理（已升级、未消费未过期）的 issue id 集合——waiting_input 派生标记数据源 */
  waitingIssueIds(): Set<number> {
    const out = new Set<number>();
    for (const [rid, m] of this.meta) {
      if (this.registry.has(rid)) out.add(m.issueId);
    }
    return out;
  }

  /** 观测用：某会话是否已处理过当前签名 */
  handledSigOf(session: string): string {
    return this.state.get(session)?.handledSig ?? '';
  }

  /** onMenu 的异步本体（拆出便于测试 await；生产只经 onMenu 进来） */
  async process(ctx: EngineMenuCtx): Promise<void> {
    const { issue, project, session, sel, pane } = ctx;
    const sig = optionsSigOf(sel.options);
    let st = this.state.get(session);
    if (!st) {
      st = { handledSig: '', inFlight: false };
      this.state.set(session, st);
    }
    if (st.inFlight || st.handledSig === sig) return;
    st.inFlight = true;
    try {
      const pm = this.deps.pmFor(project);
      const menu = menuFromSelection(sel, pane);
      // 档位取自 issue 自身（038；对话那份互不影响）——每轮现取，用户中途改档下一轮即生效
      const level: AutoApproveLevel = issue.autoApprove;
      const outcome = await pm.decideApproval(menu, { taskText: issueText(issue) }, level);

      if (outcome.action === 'approve') {
        const r = await this.inject(project, session, outcome.optionIndex, sig);
        this.log(issue.id, 'menu_auto', {
          level,
          rule: outcome.rule,
          reason: outcome.reason,
          option: outcome.optionIndex,
          result: r.ok ? 'injected' : r.reason,
          context: sel.context.slice(0, 200),
        });
        // 注入成功（或选项已越界=菜单已变）都记为已处理；stale/no_menu 说明菜单在变，
        // 留待下一 tick 以新签名重新走一遍。
        if (r.ok) st.handledSig = sig;
        return;
      }

      // escalate：解读文案 + 登记 + 发卡
      const summary = await explainSelection(this.deps.llm, {
        label: project.name,
        context: sel.context,
        options: sel.options,
        systemPrefix: pm.systemPrompt(),
      });
      this.registry.register(outcome, session, sig);
      this.sweepMeta();
      this.meta.set(outcome.requestId, {
        projectId: project.id,
        issueId: issue.id,
        createdTs: Date.now(),
      });
      const card = buildSelectionCard(outcome.requestId, project.name, summary, sel.options);
      let sent = 0;
      for (const uid of this.deps.subs.subscriberIds(project.id, issue.id)) {
        const openid = feishuOpenidOf(this.deps.db, uid);
        if (!openid || !this.deps.feishu) continue;
        try {
          await this.deps.feishu.sendCard(openid, card);
          sent++;
        } catch (e) {
          this.log(issue.id, 'error', { where: 'approval-card', error: String(e).slice(0, 200) });
        }
      }
      if (sent === 0) {
        // 无飞书通道/无绑定：退化为 NotifyRouter 文本事件（网页端有 WS selection 帧兜底）
        await this.deps.notify
          .dispatch({
            kind: 'status_change',
            projectId: project.id,
            issueId: issue.id,
            summary: `🔢 CC 需要人工选择：${sel.context.slice(0, 120)}（请到网页处理）`,
          })
          .catch(() => {});
      }
      this.log(issue.id, 'menu_escalated', {
        requestId: outcome.requestId,
        level,
        rule: outcome.rule,
        reason: outcome.reason,
        cards: sent,
        context: sel.context.slice(0, 200),
      });
      st.handledSig = sig;
    } finally {
      st.inFlight = false;
    }
  }

  /**
   * 消费一张升级卡/网页审批（消费即焚）：registry.consume → 重抓菜单核对 menuSig
   * （options 本体，不含 cursorIndex）→ 相对导航注入。重放/过期/菜单已变均拒绝。
   */
  async consume(
    requestId: string,
    optionIndex: number,
    opts: { expectSession?: string } = {},
  ): Promise<ConsumeResult> {
    const p = this.registry.consume(requestId);
    const m = this.meta.get(requestId);
    this.meta.delete(requestId);
    if (!p) return { ok: false, reason: 'expired' };
    if (opts.expectSession !== undefined && p.session !== opts.expectSession) {
      return { ok: false, reason: 'stale' };
    }
    const project = m ? getProject(this.deps.db, m.projectId) : projectOfSession(this.deps.db, p.session);
    if (!project) return { ok: false, reason: 'expired' };
    const driver = this.deps.driverFor(project);
    const r = await actOnMenu(
      { driver, mutex: this.deps.mutex, ...(this.deps.retryDelayMs !== undefined ? { retryDelayMs: this.deps.retryDelayMs } : {}) },
      p.session,
      optionIndex,
      { optionsSig: p.menuSig },
    );
    if (m) {
      this.log(m.issueId, 'menu_card_selected', {
        requestId,
        option: optionIndex,
        result: r.ok ? 'injected' : r.reason,
      });
    }
    if (r.ok) return { ok: true, session: p.session, option: r.option };
    return { ok: false, reason: r.reason };
  }

  /**
   * 飞书选择卡回调入口（FeishuChannelDeps.onSelection 接线）：
   * 点击者必须是已绑定用户，且为 admin / 项目属主 / 项目成员 / 该事件订阅者之一。
   */
  async consumeFromCard(requestId: string, optionIndex: number, openid: string): Promise<ConsumeResult> {
    const user = userByFeishuOpenid(this.deps.db, openid);
    const m = this.meta.get(requestId);
    if (!user) return { ok: false, reason: 'forbidden' };
    if (m && user.role !== 'admin') {
      const project = getProject(this.deps.db, m.projectId);
      const allowed =
        (project && project.ownerUserId === user.id) ||
        new ProjectMemberStore(this.deps.db).isMember(m.projectId, user.id) ||
        this.deps.subs.subscriberIds(m.projectId, m.issueId).includes(user.id);
      if (!allowed) return { ok: false, reason: 'forbidden' };
    }
    return this.consume(requestId, optionIndex);
  }

  private inject(
    project: Project,
    session: string,
    index: number,
    optionsSig: string,
  ): Promise<MenuActResult> {
    const driver = this.deps.driverFor(project);
    return actOnMenu(
      { driver, mutex: this.deps.mutex, ...(this.deps.retryDelayMs !== undefined ? { retryDelayMs: this.deps.retryDelayMs } : {}) },
      session,
      index,
      { optionsSig },
    );
  }

  private log(issueId: number, kind: string, data?: Record<string, unknown>): void {
    try {
      this.deps.log?.(issueId, kind, data);
    } catch {
      /* 审计失败不阻断注入主链 */
    }
  }

  private sweepMeta(): void {
    const now = Date.now();
    for (const [k, v] of this.meta) {
      if (now - v.createdTs > META_TTL_MS) this.meta.delete(k);
    }
  }
}

// ---------- 内部小工具 ----------

function issueText(issue: EngineIssue): string {
  return `${issue.title}${issue.body ? `：${issue.body}` : ''}`.slice(0, 2000);
}

/** meta 丢失（重启/TTL）时的兜底：从会话名 cc-<pid> 反推项目 */
function projectOfSession(db: Database, session: string): Project | undefined {
  const m = session.match(/^cc-(\d+)$/);
  if (!m) return undefined;
  return getProject(db, Number(m[1]));
}

/** 便捷 re-export（server 装配用） */
export { ApprovalRegistry } from '../../agents/approval';
export type { SelectionPayload };
