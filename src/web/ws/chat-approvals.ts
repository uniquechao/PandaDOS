/**
 * web/ws/chat-approvals —— 对话侧的后台自动批准巡检（issue #108）。
 *
 * 为什么不复用 ApprovalPipeline：那条管道挂在**引擎 watch 循环**的 onMenu 钩子上，只覆盖
 * 正在驱动 issue 的会话；独立聊天对话（kind='chat'，会话 chat-<convId>）压根不在引擎视野里，
 * 菜单一直只经 WS 推给网页等人点。而档位是「主人不在也别卡住」的诉求，只在网页开着时批
 * 等于没批——所以这里独立起一条服务端巡检。
 *
 * 与 issue 侧的差异（有意为之）：
 * - **只 approve，不 escalate**：判成需要人工时什么都不做，菜单原样留在屏上，由 WS
 *   selection 帧推给网页人工点（对话本来就是人在看的场景，再发一张飞书升级卡是重复打扰）；
 * - **不落 issue_events**：对话没有 issue 载体（issue_events.issue_id 是 NOT NULL 外键），
 *   观测走 onDecision 回调，接线方要审计自己接。
 *
 * 其余纪律与 issue 侧一致：注入经同一把 KeyedMutex(tmuxLockKey)、actOnMenu 锁内重抓核对
 * optionsSig 绝不盲注入、同一菜单签名只分级一次、每会话单飞防重入。
 */
import type { Database } from 'bun:sqlite';
import { decideApproval, type ApprovalOutcome } from '../../agents/approval';
import type { LlmClient } from '../../agents/llm';
import { chatTmux } from '../../core/conversations';
import { detectSelection } from '../../core/screen';
import type { AutoApproveLevel, Project } from '../../core/types';
import { getProject } from '../../issues/engine';
import type { KeyedMutex } from '../../issues/mutex';
import { actOnMenu, optionsSigOf, type MenuDriver } from './inject';

/** 需要巡检的对话（auto_approve 已开、项目在用、对话未归档） */
export interface ChatApprovalTarget {
  convId: string;
  projectId: number;
  label: string | null;
  /** 'cautious' 的对话根本不进扫描（那一档 = 全部等人点，无需巡检） */
  level: Exclude<AutoApproveLevel, 'cautious'>;
}

export interface ChatApprovalDecision {
  convId: string;
  session: string;
  level: Exclude<AutoApproveLevel, 'cautious'>;
  outcome: ApprovalOutcome;
  /** approve 时的注入结果：注入成功的选项文本，或失败原因；escalate 时不带 */
  result?: string;
}

export interface ChatApprovalDeps {
  db: Database;
  llm: LlmClient;
  /** 必须与引擎/PM/WS 同一实例（tmuxLockKey 同一把锁才有互斥意义） */
  mutex: KeyedMutex;
  driverFor(project: Project): MenuDriver;
  /** 巡检周期，缺省 3s（对话菜单是人机交互节奏，比引擎 tick 松一点够用） */
  tickMs?: number;
  /** actOnMenu 抓空重试间隔（测试调小） */
  retryDelayMs?: number;
  /** 决策观测口（对话侧不落 issue_events，审计/测试从这里取） */
  onDecision?(d: ChatApprovalDecision): void;
}

interface ConvRow {
  conv_id: string;
  project_id: number;
  label: string | null;
  auto_approve: string;
}

interface SessionState {
  /** 已处理（已注入或已判需人工）的菜单签名——同一菜单不重复分级 */
  handledSig: string;
  inFlight: boolean;
}

export class ChatApprovalWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 在途 tick（停机时 await 归还，避免关 db/driver 后还有巡检在跑） */
  private running: Promise<void> | null = null;
  private readonly state = new Map<string, SessionState>();

  constructor(private readonly deps: ChatApprovalDeps) {}

  start(): void {
    if (this.timer) return;
    const period = Math.max(50, this.deps.tickMs ?? 3000);
    this.timer = setInterval(() => {
      if (this.running) return; // 上一轮没跑完就跳过这一拍（抓屏慢于 tick 时不叠加）
      this.running = this.tick()
        .catch(() => {
          /* 单轮失败不断流，下一拍重试 */
        })
        .finally(() => {
          this.running = null;
        });
    }, period);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** 开了档位的独立聊天对话（归档对话、已归档项目、谨慎档都不进扫描） */
  listTargets(): ChatApprovalTarget[] {
    return this.deps.db
      .query<ConvRow, []>(
        `SELECT c.id AS conv_id, c.project_id, c.label, c.auto_approve
           FROM conversations c
           JOIN projects p ON p.id = c.project_id AND p.status = 'active'
          WHERE c.kind = 'chat' AND c.archived = 0 AND c.auto_approve IN ('medium', 'auto')
          ORDER BY c.id`,
      )
      .all()
      .map((r) => ({
        convId: r.conv_id,
        projectId: r.project_id,
        label: r.label,
        level: r.auto_approve === 'auto' ? ('auto' as const) : ('medium' as const),
      }));
  }

  /** 一轮巡检（测试直接 await；生产由 start() 的定时器驱动）。串行扫，别一次打爆 tmux。 */
  async tick(): Promise<void> {
    const targets = this.listTargets();
    const alive = new Set(targets.map((t) => chatTmux(t.convId)));
    for (const s of [...this.state.keys()]) {
      if (!alive.has(s)) this.state.delete(s); // 档位调回谨慎/对话归档 → 忘掉去重状态
    }
    for (const t of targets) {
      await this.processConv(t).catch(() => {
        /* 单条对话失败不影响其它对话 */
      });
    }
  }

  /** 观测用：某会话已处理过的菜单签名 */
  handledSigOf(session: string): string {
    return this.state.get(session)?.handledSig ?? '';
  }

  private async processConv(t: ChatApprovalTarget): Promise<void> {
    const session = chatTmux(t.convId);
    let st = this.state.get(session);
    if (!st) {
      st = { handledSig: '', inFlight: false };
      this.state.set(session, st);
    }
    if (st.inFlight) return;
    const project = getProject(this.deps.db, t.projectId);
    if (!project) return;
    const driver = this.deps.driverFor(project);
    // 会话不在（用户还没开过这条对话/服务重启后没重建）→ 抓不到屏，本轮跳过。
    // 巡检**不负责起会话**：起会话是用户发消息/WS 自愈的事，这里凭空拉起来只会白占进程。
    const pane = await driver.capturePane(session).catch(() => '');
    if (!pane) return;
    const sel = detectSelection(pane);
    if (!sel) {
      st.handledSig = ''; // 菜单消失即重置：同一菜单再出现视为新实例，重新分级
      return;
    }
    const sig = optionsSigOf(sel.options);
    if (st.handledSig === sig) return;
    st.inFlight = true;
    try {
      const outcome = await decideApproval(
        this.deps.llm,
        // context 空时退回整屏：危险判据大多落在命令原文上，喂窄了会漏判
        { context: sel.context || pane, options: sel.options, multiSelect: sel.multiSelect },
        { goal: project.goal, taskText: t.label },
        t.level,
      );
      if (outcome.action !== 'approve') {
        // 需人工：什么都不做（菜单留给网页点）。仍记签名——同一菜单不必每轮重新分级，
        // 人点完菜单消失，签名随之重置。
        st.handledSig = sig;
        this.deps.onDecision?.({ convId: t.convId, session, level: t.level, outcome });
        return;
      }
      const r = await actOnMenu(
        {
          driver,
          mutex: this.deps.mutex,
          ...(this.deps.retryDelayMs !== undefined ? { retryDelayMs: this.deps.retryDelayMs } : {}),
        },
        session,
        outcome.optionIndex,
        { optionsSig: sig },
      );
      // 注入成功才记已处理；stale/no_menu 说明菜单在变，留待下一轮以新签名重走
      if (r.ok) st.handledSig = sig;
      this.deps.onDecision?.({
        convId: t.convId,
        session,
        level: t.level,
        outcome,
        result: r.ok ? r.option : r.reason,
      });
    } finally {
      st.inFlight = false;
    }
  }
}
