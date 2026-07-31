/**
 * notify/router —— 通知路由（spec §8）。
 *
 * 事件（状态变更/卡点/done/blocked）→ 查 subscriptions 表（scope=project|issue）→
 * 按用户去重收敛 → 按用户节流（可配，默认 30s 聚合窗）→ 逐用户 feishu_openid 发送；
 * 无绑定用户静默跳过。admin 的微信通道（Forge Hub）不经本路由（spec §8 决策 9）。
 *
 * 设计要点（对照 v1 评审）：
 * - 引擎只按 EngineNotifier 结构化依赖本模块的 dispatch（评审 M11：13 处 notify()
 *   调用反向依赖飞书的教训——通知路由必须是独立接口）；
 * - 节流做真的：per-user 聚合窗（v1 lastNotifyTs 写而不读的死字段教训，评审 M12
 *   「要么做要么别留字段」）；gate_waiting 是交互卡不可聚合，绕过窗口直发；
 * - 卡点一次性 requestId 落 DB（notify_gate_requests，060 迁移）而非内存：评审 H4
 *   重启后待决卡作废的教训；消费 = consumed_ts NULL→ts 的 CAS，天然防重放；
 * - 发送失败按用户隔离（一个用户失败不拦其他人），错误进日志不逃逸——引擎侧
 *   还有 notifySafe 兜底，双保险。
 *
 * 集成接线（server 启动处）：
 *   migrate(db); migrateIssueEngine(db); migrateNotify(db);
 *   const router = new NotifyRouter(db);
 *   const feishu = new FeishuChannel(cfg, { db, decideGate: (g,u,a,n) => engine.decideGate(g,u,a,n) });
 *   router.register(feishu); await feishu.start();
 *   engine deps.notify = router（EngineNotifier 结构兼容）；
 *   建项目处调用 router.ensureOwnerSubscription(projectId, ownerUserId)。
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { migrate, type MigrationStatus } from '../core/migrate';
import type { Gate, IssueState, Subscription, SubscriptionScope } from '../core/types';

// ---------- 模块自带迁移（060 编号空间，同 issues/030 模式） ----------

/** 通知模块的增量迁移目录（notify/migrations/060_*.sql） */
export const NOTIFY_MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

/**
 * 应用通知模块的增量迁移（notify_gate_requests 表）。
 * 集成接线：server 启动时在核心 migrate(db) 之后调用一次；幂等可重复执行。
 */
export function migrateNotify(db: Database): MigrationStatus {
  return migrate(db, NOTIFY_MIGRATIONS_DIR);
}

// ---------- 事件与通道抽象（骨架原样，引擎按此结构化依赖） ----------

/** 一条待分发的业务事件 */
export interface NotifyEvent {
  kind: 'status_change' | 'gate_waiting' | 'issue_done' | 'issue_blocked';
  projectId: number;
  issueId: number;
  /** status_change 专用 */
  from?: IssueState;
  to?: IssueState;
  /** gate_waiting 专用：卡点详情（飞书出确认卡） */
  gate?: Gate;
  /** 人可读摘要（PM/引擎产出） */
  summary?: string;
}

/** 送达目标：一个用户在某通道上的地址 */
export interface NotifyTarget {
  userId: number;
  /** 通道内地址（飞书=openid；微信=admin 固定通道） */
  address: string;
}

/** 通知通道抽象：feishu / wechat(admin) 各自实现 */
export interface NotifyChannel {
  readonly name: string;
  /** 普通文本 */
  sendText(target: NotifyTarget, text: string): Promise<void>;
  /** 卡点确认卡（带 approve/reject 按钮 + 一次性 requestId 防重放）；不支持卡片的通道降级为文本 */
  sendGateCard(target: NotifyTarget, event: NotifyEvent): Promise<void>;
}

/** 事件→单行通知文案（确定性渲染，不过 LLM——评审 M18：确定性事件直推） */
export function formatEventText(e: NotifyEvent): string {
  switch (e.kind) {
    case 'status_change':
      return `🔄 [issue #${e.issueId}] ${e.summary ?? `${e.from ?? '?'} → ${e.to ?? '?'}`}`;
    case 'issue_done':
      return `✅ [issue #${e.issueId}] 完成：${e.summary ?? ''}`.trimEnd();
    case 'issue_blocked':
      return `⛔ [issue #${e.issueId}] 受阻：${e.summary ?? '(未说明)'}`;
    case 'gate_waiting':
      return `🚦 [issue #${e.issueId}] ${e.summary ?? '卡点待确认'}`;
  }
}

// ---------- users 表的飞书绑定查询（core/users.ts 不许动，模块内薄查询） ----------

/** 用户当前绑定的 feishu openid；无绑定返回 null */
export function feishuOpenidOf(db: Database, userId: number): string | null {
  const r = db
    .query<{ feishu_openid: string | null }, [number]>(
      'SELECT feishu_openid FROM users WHERE id = ?',
    )
    .get(userId);
  return r?.feishu_openid ?? null;
}

/** 按 openid 反查用户（入站消息/卡片点击者归属）；未绑定返回 null */
export function userByFeishuOpenid(
  db: Database,
  openid: string,
): { id: number; role: string } | null {
  if (!openid) return null;
  const r = db
    .query<{ id: number; role: string }, [string]>(
      'SELECT id, role FROM users WHERE feishu_openid = ?',
    )
    .get(openid);
  return r ?? null;
}

// ---------- SubscriptionStore ----------

interface SubRow {
  id: number;
  user_id: number;
  scope: string;
  target_id: number;
  created_ts: number;
}

function mapSub(r: SubRow): Subscription {
  return {
    id: r.id,
    userId: r.user_id,
    scope: r.scope as SubscriptionScope,
    targetId: r.target_id,
    createdTs: r.created_ts,
  };
}

export class SubscriptionStore {
  constructor(private readonly db: Database) {}

  /** 幂等订阅：已存在返回现有行（UNIQUE(user_id,scope,target_id) 兜底） */
  add(userId: number, scope: SubscriptionScope, targetId: number): Subscription {
    this.db
      .query(
        `INSERT INTO subscriptions (user_id, scope, target_id, created_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, scope, target_id) DO NOTHING`,
      )
      .run(userId, scope, targetId, Date.now());
    const r = this.db
      .query<SubRow, [number, string, number]>(
        'SELECT * FROM subscriptions WHERE user_id = ? AND scope = ? AND target_id = ?',
      )
      .get(userId, scope, targetId);
    if (!r) throw new Error('insert subscription failed');
    return mapSub(r);
  }

  /** 退订；不存在返回 false */
  remove(userId: number, scope: SubscriptionScope, targetId: number): boolean {
    const r = this.db
      .query<{ id: number }, [number, string, number]>(
        'DELETE FROM subscriptions WHERE user_id = ? AND scope = ? AND target_id = ? RETURNING id',
      )
      .get(userId, scope, targetId);
    return r !== null;
  }

  listByUser(userId: number): Subscription[] {
    return this.db
      .query<SubRow, [number]>('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id')
      .all(userId)
      .map(mapSub);
  }

  /** 事件的订阅者收敛：project 订阅 ∪ issue 订阅，按 user 去重 */
  subscriberIds(projectId: number, issueId: number): number[] {
    return this.db
      .query<{ user_id: number }, [number, number]>(
        `SELECT DISTINCT user_id FROM subscriptions
         WHERE (scope = 'project' AND target_id = ?) OR (scope = 'issue' AND target_id = ?)
         ORDER BY user_id`,
      )
      .all(projectId, issueId)
      .map((r) => r.user_id);
  }

  /**
   * 项目创建者自动订阅自己项目的约定（spec §8）：
   * 集成时在建项目处调用；幂等（重复调用无副作用）。
   */
  ensureOwnerSubscription(projectId: number, userId: number): Subscription {
    return this.add(userId, 'project', projectId);
  }
}

// ---------- GateRequestStore：卡点卡一次性 requestId（060 表） ----------

/** 生成 requestId（v1 agent.ts:117 生成式平移 + 加强随机位） */
export function genRequestId(): string {
  return `g${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
}

export interface GateRequest {
  requestId: string;
  gateId: number;
  userId: number;
  createdTs: number;
  consumedTs: number | null;
}

interface GateReqRow {
  request_id: string;
  gate_id: number;
  user_id: number;
  created_ts: number;
  consumed_ts: number | null;
}

export class GateRequestStore {
  constructor(private readonly db: Database) {}

  /** 发卡时登记：requestId 绑定 (gate, 发卡对象用户)，进按钮 value */
  create(gateId: number, userId: number): string {
    const id = genRequestId();
    this.db
      .query(
        'INSERT INTO notify_gate_requests (request_id, gate_id, user_id, created_ts) VALUES (?, ?, ?, ?)',
      )
      .run(id, gateId, userId, Date.now());
    return id;
  }

  get(requestId: string): GateRequest | undefined {
    const r = this.db
      .query<GateReqRow, [string]>('SELECT * FROM notify_gate_requests WHERE request_id = ?')
      .get(requestId);
    if (!r) return undefined;
    return {
      requestId: r.request_id,
      gateId: r.gate_id,
      userId: r.user_id,
      createdTs: r.created_ts,
      consumedTs: r.consumed_ts,
    };
  }

  /**
   * 消费即失效（一次性语义）：consumed_ts NULL→now 的 CAS。
   * 成功返回绑定的 (gateId, userId)；已消费/不存在返回 null——重放天然被拒。
   */
  consume(requestId: string): { gateId: number; userId: number } | null {
    const r = this.db
      .query<{ gate_id: number; user_id: number }, [number, string]>(
        `UPDATE notify_gate_requests SET consumed_ts = ?
         WHERE request_id = ? AND consumed_ts IS NULL
         RETURNING gate_id, user_id`,
      )
      .get(Date.now(), requestId);
    return r ? { gateId: r.gate_id, userId: r.user_id } : null;
  }
}

// ---------- NotifyRouter ----------

export interface NotifyRouterOptions {
  /** per-user 聚合窗毫秒；<=0 关闭节流直发。默认 30s（spec §8） */
  throttleMs?: number;
  /** 时钟注入（测试用） */
  now?: () => number;
}

export const DEFAULT_THROTTLE_MS = 30_000;

interface UserBuf {
  lastSentTs: number;
  pending: string[];
  timer: ReturnType<typeof setTimeout> | null;
  channel: NotifyChannel;
  target: NotifyTarget;
}

export class NotifyRouter {
  private readonly channels = new Map<string, NotifyChannel>();
  private readonly bufs = new Map<string, UserBuf>();
  readonly subscriptions: SubscriptionStore;
  private readonly throttleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    opts: NotifyRouterOptions = {},
  ) {
    this.subscriptions = new SubscriptionStore(db);
    this.throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  register(channel: NotifyChannel): void {
    this.channels.set(channel.name, channel);
  }

  /** 项目创建者自动订阅（便捷转发，集成建项目处调用） */
  ensureOwnerSubscription(projectId: number, userId: number): Subscription {
    return this.subscriptions.ensureOwnerSubscription(projectId, userId);
  }

  /** 用户在某通道的地址；目前只有 feishu 走订阅扇出（微信=admin 专属，不经本路由） */
  private addressOf(channelName: string, userId: number): string | null {
    if (channelName === 'feishu') return feishuOpenidOf(this.db, userId);
    return null;
  }

  /**
   * 分发：订阅者收敛（project ∪ issue 去重）→ 逐用户解析通道地址（无绑定静默跳过）→
   * gate_waiting 直发确认卡（交互卡不可聚合），其余文本进 per-user 节流窗。
   * 单用户发送失败只记日志，不影响其他订阅者、不向引擎抛错。
   */
  async dispatch(event: NotifyEvent): Promise<void> {
    const userIds = this.subscriptions.subscriberIds(event.projectId, event.issueId);
    if (userIds.length === 0) return;
    for (const channel of this.channels.values()) {
      for (const userId of userIds) {
        const address = this.addressOf(channel.name, userId);
        if (!address) continue; // 无绑定：静默跳过（spec §8）
        const target: NotifyTarget = { userId, address };
        try {
          if (event.kind === 'gate_waiting' && event.gate) {
            this.touchWindow(channel, target); // 卡也占节流窗：随后的文本进聚合
            await channel.sendGateCard(target, event);
          } else {
            await this.enqueueText(channel, target, formatEventText(event));
          }
        } catch (e) {
          console.error(`[notify] 发送失败 channel=${channel.name} user=${userId}:`, e);
        }
      }
    }
  }

  /**
   * 入站消息路由：`#<项目id|项目名> ...` 定位到对应项目 PM（spec §6 全局路由的飞书侧）。
   * 安全：发送者必须是已绑定用户；普通用户只能定位自己的项目，admin 任意。
   * 无法定位/无权限返回 null（调用方决定回复话术）。
   */
  async routeInbound(channelName: string, senderAddress: string, text: string): Promise<number | null> {
    if (channelName !== 'feishu') return null;
    const user = userByFeishuOpenid(this.db, senderAddress);
    if (!user) return null;
    const m = text.trim().match(/^#(\S+)/);
    if (!m) return null;
    const token = m[1]!;
    const row = /^\d+$/.test(token)
      ? this.db
          .query<{ id: number; owner_user_id: number }, [number]>(
            'SELECT id, owner_user_id FROM projects WHERE id = ?',
          )
          .get(Number(token))
      : this.db
          .query<{ id: number; owner_user_id: number }, [string]>(
            'SELECT id, owner_user_id FROM projects WHERE name = ?',
          )
          .get(token);
    if (!row) return null;
    if (user.role !== 'admin' && row.owner_user_id !== user.id) return null;
    return row.id;
  }

  // ---- per-user 节流（聚合窗） ----

  private bufKey(channel: NotifyChannel, target: NotifyTarget): string {
    return `${channel.name}:${target.userId}`;
  }

  private bufOf(channel: NotifyChannel, target: NotifyTarget): UserBuf {
    const key = this.bufKey(channel, target);
    let b = this.bufs.get(key);
    if (!b) {
      b = { lastSentTs: 0, pending: [], timer: null, channel, target };
      this.bufs.set(key, b);
    }
    b.target = target; // openid 可能换绑，发送用最新地址
    return b;
  }

  /** 记一次「已发送」占用节流窗（gate 卡直发后调用） */
  private touchWindow(channel: NotifyChannel, target: NotifyTarget): void {
    this.bufOf(channel, target).lastSentTs = this.now();
  }

  private async enqueueText(channel: NotifyChannel, target: NotifyTarget, text: string): Promise<void> {
    if (this.throttleMs <= 0) {
      await channel.sendText(target, text);
      return;
    }
    const b = this.bufOf(channel, target);
    const now = this.now();
    // 窗口外且无积压：立即发（首条不等 30s）
    if (!b.timer && b.pending.length === 0 && now - b.lastSentTs >= this.throttleMs) {
      b.lastSentTs = now;
      await channel.sendText(target, text);
      return;
    }
    // 窗口内：进聚合缓冲，窗口到期一次性发
    b.pending.push(text);
    if (!b.timer) {
      const delay = Math.max(0, b.lastSentTs + this.throttleMs - now);
      const key = this.bufKey(channel, target);
      b.timer = setTimeout(() => void this.flushBuf(key), delay);
    }
  }

  private async flushBuf(key: string): Promise<void> {
    const b = this.bufs.get(key);
    if (!b) return;
    if (b.timer) {
      clearTimeout(b.timer);
      b.timer = null;
    }
    const texts = b.pending.splice(0);
    if (texts.length === 0) return;
    b.lastSentTs = this.now();
    try {
      await b.channel.sendText(b.target, texts.join('\n'));
    } catch (e) {
      // 聚合批失败只丢这一批并记日志（v1 评审 H14 是 LLM 分析路径的静默蒸发；
      // 这里事件本体已在 issue_events 落库，通知层丢失可从时间线追溯）
      console.error(`[notify] 聚合发送失败 ${key}:`, e);
    }
  }

  /** 立即冲掉全部聚合缓冲（进程退出前/测试用） */
  async flushAll(): Promise<void> {
    for (const key of [...this.bufs.keys()]) await this.flushBuf(key);
  }

  /** 清定时器（停机）；未发送的聚合缓冲丢弃（先 flushAll 再 stop 可不丢） */
  stop(): void {
    for (const b of this.bufs.values()) {
      if (b.timer) clearTimeout(b.timer);
      b.timer = null;
    }
  }
}
