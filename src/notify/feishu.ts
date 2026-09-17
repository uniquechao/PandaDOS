/**
 * notify/feishu —— 飞书通道实现（spec §8；v1 src/feishu.ts 平移 + 卡点确认卡）。
 *
 * 平移与改造对照（v1 评审 pm-notify 域）：
 * - WSClient 长连（im.message.receive_v1 入站 + card.action.trigger 卡片回调）、
 *   sendText/sendCard 的 SDK 直连模式原样平移（评审 §2A「v2 直接抄」）；
 *   断线重连仍完全委托 SDK。
 * - SDK 动态 import + 薄适配层 FeishuSdk：回调 payload 定薄类型（评审 low：v1 全 any），
 *   测试可整体 mock（铁律：feishu SDK 全 mock）。
 * - 卡片回调按 value.forge 分发复用一条 WS：'gate'（新增卡点卡）/'selection'（v1 选择卡）。
 * - 卡点点击链路：requestId 查表 → 操作者校验（必须是发卡对象本人的当前绑定 openid）→
 *   CAS 消费（一次性，防重放）→ 转发 issue-engine 的 decideGate（骨架签名依赖，
 *   集成时接线）。toast 如实反映结果——修掉 v1「恒 success」（评审 mid）。
 * - selection 回调的 optionIndex 改严格整数校验，拒绝畸形值——修掉 v1 `Number(...)||0`
 *   「畸形值=选第 1 项」（评审 mid）。
 * - verifyBinding：绑定保存前发测试消息验证可达（spec §8/§12 防通知外泄）。
 * - v1 的 TOFU owner 抢注、单 owner 校验整段废弃（评审 H11）：收件人来自订阅扇出，
 *   点击权来自 requestId 绑定的用户。
 */
import type { Database } from 'bun:sqlite';
import type { I18nApi } from '../../shared/i18n/formatter';
import { PRODUCT_NAME } from '../core/branding';
import { buildGateCard, gateSummary } from './cards';
import {
  GateRequestStore,
  eventSummary,
  feishuOpenidOf,
  userI18n,
  userByFeishuOpenid,
  type NotifyChannel,
  type NotifyEvent,
  type NotifyTarget,
} from './router';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

// ---------- 回调 payload 薄类型（v1 全 any 的评审整改） ----------

export interface FeishuInboundPayload {
  sender?: { sender_type?: string; sender_id?: { open_id?: string } };
  message?: { message_id?: string; chat_type?: string; message_type?: string; content?: string };
}

export interface FeishuCardPayload {
  operator?: { open_id?: string };
  action?: { value?: unknown };
}

export interface FeishuToast {
  toast: { type: 'success' | 'error' | 'info'; content: string };
}

// ---------- SDK 薄适配（动态 import；测试注入假实现整体 mock） ----------

export interface FeishuMessageCreateArgs {
  params: { receive_id_type: string };
  data: { receive_id: string; content: string; msg_type: string };
}

/** REST 发送端的最小面（@larksuiteoapi/node-sdk Client 结构子集） */
export interface FeishuSdkClient {
  im: { v1: { message: { create(args: FeishuMessageCreateArgs): Promise<unknown> } } };
}

export interface FeishuEventHandlers {
  onInbound(data: FeishuInboundPayload): Promise<void>;
  onCard(data: FeishuCardPayload): Promise<unknown>;
}

export type FeishuConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface FeishuChannelStatus {
  state: FeishuConnectionState;
  lastReceivedAt: number | null;
  lastSentAt: number | null;
  lastError: 'connection_failed' | 'send_failed' | null;
}

/** 连接层抽象：默认 larkSdk()（真 SDK），测试传假的 */
export interface FeishuSdk {
  connect(
    cfg: FeishuConfig,
    handlers: FeishuEventHandlers,
  ): Promise<{ client: FeishuSdkClient; stop(): void; status?(): FeishuConnectionState }>;
}

/** 真 SDK 适配器（v1 feishu.ts:22-42 WSClient 接线平移；重连委托 SDK） */
export function larkSdk(): FeishuSdk {
  return {
    async connect(cfg, handlers) {
      // SDK 类型质量差，适配层内收敛为最小 any 面
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Lark = (await import('@larksuiteoapi/node-sdk')) as any;
      // SDK errors may include Axios request headers/body; never log their raw payloads.
      const quiet = () => {};
      const logger = { error: quiet, warn: quiet, info: quiet, debug: quiet, trace: quiet };
      const base = { appId: cfg.appId, appSecret: cfg.appSecret, domain: Lark.Domain.Feishu, logger };
      const client = new Lark.Client(base) as FeishuSdkClient;
      let failed = false;
      let started = false;
      let stopped = false;
      const wsClient = new Lark.WSClient({ ...base, loggerLevel: Lark.LoggerLevel.error,
        onError: () => { failed = true; } });
      const start = wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({ logger }).register({
          'im.message.receive_v1': (data: FeishuInboundPayload) => stopped ? undefined : handlers.onInbound(data),
          'card.action.trigger': (data: FeishuCardPayload) => stopped ? undefined : handlers.onCard(data),
        }),
      });
      // start() arms the SDK loop; its resolution does not mean the WS is connected.
      void Promise.resolve(start).then(() => { started = true; }, () => { failed = true; });
      return {
        client,
        status(): FeishuConnectionState {
          if (failed || stopped) return 'failed';
          const state = wsClient.getConnectionStatus().state;
          if (state === 'idle') return started ? 'failed' : 'connecting';
          return state;
        },
        stop() {
          stopped = true;
          try { wsClient.close({ force: true }); } catch { /* best-effort */ }
        },
      };
    },
  };
}

// ---------- 通道实现 ----------

/** 卡片一键拒绝的默认意见（引擎 decideGate 要求 reject 必附 note；详细意见走网页） */
export const CARD_REJECT_NOTE = 'Rejected from the Feishu card; add detailed feedback in the web app.';

/** 绑定验证的测试消息文案 */
export const BIND_TEST_TEXT =
  `✅ ${PRODUCT_NAME} connection test: this message confirms that notifications can reach you.`;

/**
 * 卡点决定转发（issue-engine decideGate 骨架签名的结构化镜像；
 * 集成接线：decideGate: (g,u,a,n) => engine.decideGate(g,u,a,n)）
 */
export type GateDecideFn = (
  gateId: number,
  userId: number,
  action: 'approve' | 'reject',
  note?: string,
) => Promise<{ ok: boolean; error?: string }>;

export interface FeishuChannelDeps {
  /** users.feishu_openid 校验 + notify_gate_requests（063 迁移需已应用） */
  db: Database;
  /** 卡点按钮回调转发引擎；未接线时点击回 error toast */
  decideGate?: GateDecideFn;
  /** 入站文本消息（路由到 PM 由集成层经 NotifyRouter.routeInbound 接） */
  onInbound?: (openid: string, text: string) => void | Promise<void>;
  /** v1 选择卡回调兼容（弹窗菜单代点，集成时接 actOnMenu 原语） */
  onSelection?: (requestId: string, optionIndex: number, openid: string) => void;
  /** SDK 注入（缺省真 SDK；测试传 mock） */
  sdk?: FeishuSdk;
}

export const FEISHU_MESSAGE_DEDUP_TTL_MS = 10 * 60_000;
export const FEISHU_MESSAGE_DEDUP_MAX = 2_000;

export class FeishuChannel implements NotifyChannel {
  readonly name = 'feishu';
  readonly requests: GateRequestStore;
  private client: FeishuSdkClient | null = null;
  private stopFn: (() => void) | null = null;
  private statusFn: (() => FeishuConnectionState) | null = null;
  private generation = 0;
  private active = false;
  private state: FeishuConnectionState = 'connecting';
  private lastReceivedAt: number | null = null;
  private lastSentAt: number | null = null;
  private lastError: FeishuChannelStatus['lastError'] = null;
  private readonly received = new Map<string, number>();

  constructor(
    private readonly config: FeishuConfig,
    private readonly deps: FeishuChannelDeps,
  ) {
    this.requests = new GateRequestStore(deps.db);
  }

  status(): FeishuChannelStatus {
    const state = this.statusFn?.() ?? this.state;
    if (state === 'failed' && this.active) this.lastError = 'connection_failed';
    else if (state === 'connected' && this.lastError === 'connection_failed') this.lastError = null;
    return { state, lastReceivedAt: this.lastReceivedAt, lastSentAt: this.lastSentAt, lastError: this.lastError };
  }

  /** Start the SDK without claiming its background WebSocket has connected. */
  async start(): Promise<void> {
    this.stopFn?.();
    this.stopFn = null;
    this.client = null;
    this.statusFn = null;
    this.active = true;
    this.state = 'connecting';
    this.lastError = null;
    const generation = ++this.generation;
    const current = () => this.active && generation === this.generation;
    try {
      const connection = await (this.deps.sdk ?? larkSdk()).connect(this.config, {
        onInbound: async (data) => {
          if (!current()) return;
          try { await this.handleInbound(data); }
          catch { console.error('[feishu] inbound_failed'); }
        },
        onCard: async (data) => {
          if (!current()) return undefined;
          try { return await this.handleCard(data); }
          catch { console.error('[feishu] card_failed'); return undefined; }
        },
      });
      if (!current()) { connection.stop(); return; }
      this.client = connection.client;
      this.stopFn = () => connection.stop();
      this.statusFn = connection.status ? () => connection.status!() : null;
      this.state = connection.status?.() ?? 'connected';
    } catch {
      if (!current()) return;
      this.state = 'failed';
      this.lastError = 'connection_failed';
      throw new Error('connection_failed');
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    this.generation++;
    this.stopFn?.();
    this.stopFn = null;
    this.statusFn = null;
    this.client = null;
    this.state = 'failed';
  }

  // Only non-empty private human text reaches PM. Unsupported messages are ignored.
  private async handleInbound(data: FeishuInboundPayload): Promise<void> {
    const message = data?.message;
    const sender = data?.sender;
    const openId = sender?.sender_id?.open_id;
    if (typeof openId !== 'string' || !openId.trim() || !message ||
        (sender?.sender_type !== undefined && sender.sender_type !== 'user') ||
        (message.chat_type !== undefined && message.chat_type !== 'p2p') ||
        message.message_type !== 'text' || typeof message.content !== 'string') return;
    let text: unknown;
    try { text = (JSON.parse(message.content) as { text?: unknown } | null)?.text; }
    catch { return; }
    if (typeof text !== 'string' || !text.trim()) return;
    const now = Date.now();
    const id = message.message_id;
    if (typeof id === 'string' && id) {
      for (const [key, ts] of this.received) {
        if (now - ts < FEISHU_MESSAGE_DEDUP_TTL_MS) break;
        this.received.delete(key);
      }
      if (this.received.has(id)) return;
      while (this.received.size >= FEISHU_MESSAGE_DEDUP_MAX) {
        this.received.delete(this.received.keys().next().value!);
      }
      // Reserve before awaiting downstream work so concurrent duplicate events cannot execute twice.
      this.received.set(id, now);
    }
    this.lastReceivedAt = now;
    await this.deps.onInbound?.(openId, text.trim());
  }

  // ---- 卡片回调：按 forge 分发（gate 新增 / selection v1 兼容） ----

  private async handleCard(data: FeishuCardPayload): Promise<FeishuToast | undefined> {
    const openId = data.operator?.open_id ?? '';
    const value =
      typeof data.action?.value === 'object' && data.action.value !== null
        ? (data.action.value as Record<string, unknown>)
        : {};
    if (value.forge === 'gate') return this.handleGateClick(openId, value);
    if (value.forge === 'selection') return this.handleSelectionClick(openId, value);
    return undefined;
  }

  /**
   * 卡点按钮：查 requestId → 操作者校验 → CAS 消费（一次性）→ 转发 decideGate。
   * 顺序要点：先校验操作者再消费——别人误点不烧掉本人的 requestId。
   */
  private async handleGateClick(
    openId: string,
    value: Record<string, unknown>,
  ): Promise<FeishuToast> {
    const requestId = typeof value.requestId === 'string' ? value.requestId : '';
    const action =
      value.action === 'approve' ? ('approve' as const) : value.action === 'reject' ? ('reject' as const) : null;
    const operator = userByFeishuOpenid(this.deps.db, openId);
    const operatorI18n = operator ? userI18n(this.deps.db, operator.id) : userI18n(this.deps.db, 0);
    if (!requestId || !action) return toastErr(operatorI18n.t('notify.invalidCard'));

    const req = this.requests.get(requestId);
    if (!req) return toastErr(operatorI18n.t('notify.cardExpired'));
    const i18n = userI18n(this.deps.db, req.userId);
    if (req.consumedTs !== null) return toastErr(i18n.t('notify.cardHandled'));

    // 操作者必须是发卡对象本人（openid 与该用户当前绑定一致；换绑后旧卡对新 openid 有效）
    const bound = feishuOpenidOf(this.deps.db, req.userId);
    if (!openId || !bound || openId !== bound) return toastErr(operatorI18n.t('notify.cardNotYours'));

    // 一次性语义：CAS 消费，并发/重放到这里被拒
    const consumed = this.requests.consume(requestId);
    if (!consumed) return toastErr(i18n.t('notify.cardHandled'));

    if (!this.deps.decideGate) return toastErr(i18n.t('notify.gateUnavailable'));
    const note = action === 'reject' ? i18n.t('notify.rejectNote') : undefined;
    const r = await this.deps.decideGate(consumed.gateId, consumed.userId, action, note);
    if (!r.ok) return toastErr(r.error ?? i18n.t('notify.failed')); // gates 表 CAS 是第二道防线（如网页已先处理）
    return {
      toast: {
        type: 'success',
        content: action === 'approve' ? i18n.t('notify.approved') : i18n.t('notify.rejected'),
      },
    };
  }

  /** v1 选择卡回调兼容；optionIndex 严格整数校验（拒绝畸形值，不再 ||0 误选第 1 项） */
  private handleSelectionClick(openId: string, value: Record<string, unknown>): FeishuToast {
    const user = userByFeishuOpenid(this.deps.db, openId);
    const i18n = userI18n(this.deps.db, user?.id ?? 0);
    const requestId = typeof value.requestId === 'string' ? value.requestId : '';
    const idx = value.optionIndex;
    if (!requestId || typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
      return toastErr(i18n.t('notify.invalidSelection'));
    }
    this.deps.onSelection?.(requestId, idx, openId);
    return { toast: { type: 'success', content: i18n.t('notify.selectedOption', { index: idx + 1 }) } };
  }

  // ---- 发送（v1 sendText/sendCard 平移；未连接改为显式抛错，不再静默降级日志） ----

  private mustClient(): FeishuSdkClient {
    if (!this.client) throw new Error('feishu 通道未连接（先 start()）');
    return this.client;
  }

  private async send(args: FeishuMessageCreateArgs): Promise<void> {
    const client = this.mustClient();
    const generation = this.generation;
    try {
      const response = await client.im.v1.message.create(args);
      // Legacy injected adapters return {}; the real SDK always supplies a numeric code.
      if (!response || typeof response !== 'object' || Array.isArray(response) ||
          ('code' in response && response.code !== 0)) throw new Error('send_failed');
      if (!this.active || generation !== this.generation) throw new Error('send_failed');
      this.lastSentAt = Date.now();
      this.lastError = null;
    } catch {
      if (generation === this.generation) this.lastError = 'send_failed';
      throw new Error('send_failed');
    }
  }

  async sendText(target: NotifyTarget, text: string): Promise<void> {
    await this.send({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: target.address, content: JSON.stringify({ text }), msg_type: 'text' },
    });
  }

  /** 发交互卡片（进度/回复/选择/卡点卡通用） */
  async sendCard(toOpenId: string, card: unknown): Promise<void> {
    await this.send({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: toOpenId, content: JSON.stringify(card), msg_type: 'interactive' },
    });
  }

  /**
   * 卡点确认卡：计划/diff 摘要 + approve/reject 按钮（一次性 requestId 防重放）。
   * requestId 发卡时落 DB（重启后卡仍可点，评审 H4 整改）；缺 gate 详情降级为文本。
   */
  async sendGateCard(
    target: NotifyTarget,
    event: NotifyEvent,
    i18n: I18nApi = userI18n(this.deps.db, target.userId),
  ): Promise<void> {
    const gate = event.gate;
    const localizedSummary = eventSummary(event, i18n);
    if (!gate) {
      await this.sendText(target, `🚦 [issue #${event.issueId}] ${localizedSummary}`);
      return;
    }
    const requestId = this.requests.create(gate.id, target.userId);
    const heading = localizedSummary ? `**${localizedSummary}**\n\n` : '';
    const card = buildGateCard({
      requestId,
      kind: gate.kind,
      issueId: event.issueId,
      summary: heading + gateSummary(gate.kind, gate.payloadJson, i18n),
    }, i18n);
    await this.sendCard(target.address, card);
  }

  /**
   * openid 绑定验证：发一条测试消息，可达才允许落库（防填错导致通知外泄，spec §8/§12）。
   * @returns 是否送达（false = 调用方不保存）
   */
  async verifyBinding(openid: string, userId = 0): Promise<boolean> {
    try {
      const i18n = userI18n(this.deps.db, userId);
      await this.sendText({ userId, address: openid }, i18n.t('notify.bindTest'));
      return true;
    } catch {
      return false;
    }
  }
}

function toastErr(content: string): FeishuToast {
  return { toast: { type: 'error', content } };
}
