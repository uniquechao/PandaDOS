/**
 * web/ws/chat —— WS 聊天流（/ws/chat/:projectId，Wave3 任务 B）。
 *
 * 帧协议（与 UI 工程师的共同契约）：
 * - 服→客：{type:'baseline',msgs,selection?}（建连即发；活跃对话被切换/新 jsonl 落地时会重发）
 *          {type:'msg',m}（tail 增量气泡）
 *          {type:'selection',sel}（菜单出现/变化=帧带 {context,options,sig}；消失=sel:null）
 *          {type:'explanation',sig,optionsSig,text}（issue #112：菜单解读，仅「解释一下」点了才发）
 *          {type:'mode',live}（仅 ?conv= 钉住模式：建连先于 baseline 发一次，live 翻转再发；
 *                              issue 现场：live=钉住对话即当前激活对话可注入，false=只读历史；
 *                              chat 独立对话：live 恒 true，注入打到该对话自身会话 chat-<convId>）
 *          {type:'stale'}（select 注入前重抓核对 sig 不符/菜单已消失）
 *          {type:'ack',id}（issue #116：带 id 的文本帧**真注入成功**了；前端据此把乐观气泡标「已送达」）
 *          {type:'err',code,id?}（bad_frame / bad_key / out_of_range / inject_failed / expired / forbidden /
 *                             agent_not_ready=会话不在（自愈重建中）或 codex 退回 shell，带 msg 文案）
 * - 客→服：{type:'text',text,id?} {type:'key',key} {type:'select',index,sig} {type:'explain',sig?}
 *          （select 可选带 requestId=审批升级卡的一次性 id，走消费即焚管道）
 *
 * 回执契约（issue #116，改动前必读）：text 帧带 id 时，这条消息的**结局恰好回一帧带 id 的
 * ack 或 err**——注入成功 ack，注入失败/空帧/只读拒绝/会话不在/补发超时回带 id 的 err。
 * 唯一例外是「正在重启并自动补发」那帧 agent_not_ready **故意不带 id**：这条话还没死，
 * 前端应保持「发送中」，等补发成功的 ack 或超时的 err 定夺。不带 id 的 text 帧（老前端/
 * 内部注入如「重试」提示）一律不回 ack，行为与改动前一致。
 *
 * 注入全部经 KeyedMutex(tmuxLockKey)（与引擎/PM 同一把锁）；select 在锁内重抓
 * capturePane 核对 selectionSig（screen.ts），不符回 {type:'stale'}（评审 H9）。
 * 轮询 1.2s（v1 平移，可配）：tail 增量 + 菜单签名变化推送。
 */
import type { ServerWebSocket } from 'bun';
import { readOlder, tailConversation, type ChatMessage, type JsonlReader } from '../../core/jsonl';
import { detectSelection, selectionSig } from '../../core/screen';
import { judgeAgentLiveness, paneHasAgentUi, type AgentLiveness } from '../../core/agent-liveness';
import type { AgentKind } from '../../core/types';
import { absImages, extractUploadRels, imageReadHint, isUploadRel, stripImageHint } from '../../core/uploads';
import { projectLockKey, tmuxLockKey, type KeyedMutex } from '../../issues/mutex';
import type { MessageBumper } from '../../core/activity';
import type { MenuDriver } from './inject';
import { actOnMenu, injectKey, injectText, optionsSigOf, selectionFrameOf } from './inject';

/**
 * chat 面需要的 Driver 子集：注入原语（MenuDriver）+ 会话判活（issue #88 注入自愈门禁）。
 * command = tmux `#{pane_current_command}`，判「代理还在不在跑」的主证据（issue #97）。
 */
export interface ChatDriver extends MenuDriver {
  listSessions(): Promise<Array<{ name: string; command?: string }>>;
}

// ---------- 依赖/数据 ----------

export interface ChatConsumeResult {
  ok: boolean;
  reason?: 'expired' | 'no_menu' | 'stale' | 'out_of_range' | 'forbidden';
}

/** ApprovalPipeline 结构子集（升级卡的网页消费口） */
export interface ChatApprovals {
  consume(
    requestId: string,
    optionIndex: number,
    opts?: { expectSession?: string },
  ): Promise<ChatConsumeResult>;
}

export interface ChatWsDeps {
  /** jsonl 读取（与引擎同源：主执行机 Driver） */
  reader: JsonlReader;
  locator: { locate(convId: string): Promise<string | null> };
  convs: {
    currentConv(projectId: number): string | undefined;
    /** 死会话（tmux 都没了）的自愈重建（issue #88，见 ConversationManager.activate） */
    activate?(convId: string): Promise<unknown>;
    /**
     * 强制重启代理（issue #97）：会话还在、里面只剩 bash 时用——activate 会因「会话还在」
     * 短路，修不好这种壳。缺省则退化到 activate（旧装配兼容）。
     */
    relaunch?(convId: string): Promise<unknown>;
  };
  mutex: KeyedMutex;
  approvals?: ChatApprovals;
  /**
   * 菜单解读（issue #112「解释一下」）：**点了才调**，一次一条，返回 null = 生成失败。
   * 不接 = 该能力未装配（前端点了会收到 explain_failed）。装配见 server.ts（explainMenuForHuman）。
   */
  explain?(input: {
    projectId: number;
    context: string;
    options: string[];
    multiSelect: boolean;
  }): Promise<string | null>;
  /** 轮询周期，缺省 1200ms（v1 平移；测试调小） */
  chatPollMs?: number;
  retryDelayMs?: number;
  /** 重启后等代理就绪的上限，缺省 30s（超时就把这条消息还给用户，让他重发） */
  resendWaitMs?: number;
  /** 就绪轮询间隔，缺省 1s */
  resendPollMs?: number;
  /**
   * 用户消息计数（013）：文本帧**注入成功后**记一笔，供 admin 用户表的「消息数」统计。
   * 按键/选项不是消息不计；重启自动补发在真正注入那一刻才计，故一条消息恒计一次。
   * 缺省不接 = 不统计（最小装配/测试）。
   */
  messages?: MessageBumper;
}

export interface ChatWsData {
  kind: 'chat';
  projectId: number;
  /** 连接所属用户（upgrade 前已鉴权，见 ws/index.ts）——消息计数归属用 */
  userId: number;
  /** 项目专用 cc 会话（注入/抓屏目标） */
  session: string;
  /** 项目 cwd（执行机侧）——把对话里附的截图 rel 拼成绝对路径喂 Read 提示用 */
  cwd: string;
  /** 该项目 executor 的 Driver（tmux 操作面 + 判活） */
  driver: ChatDriver;
  /** 钉住对话的 agent（codex/claude）——就绪门禁提示文案用；未知时按通用「AI」措辞 */
  agent?: 'claude' | 'codex';
  /** 钉住的对话 id（?conv=；null=跟随项目当前激活对话，v2 首发行为） */
  pinnedConv: string | null;
  /**
   * 对话模式（009）：钉住的对话是一条 chat 独立对话——注入/抓屏目标 = 它自己的 tmux 会话
   * （session 已是 chat-<convId>），恒可注入（无「pinned==active」单活跃门控，live 恒 true）。
   * false = issue 现场（cc-<pid> 单活跃会话，live 按 pinned==active 门控）。
   */
  chatMode: boolean;
  /** 可注入判定：issue 现场 = 钉住对话==当前激活对话；chat 独立对话恒 true */
  live: boolean;
  convId: string | null;
  jsonl: string | null;
  offset: number;
  nextSeq: number;
  /**
   * 向上翻页游标：当前已加载的最旧一条 baseline 消息的源行字节 offset（= 稳定标识 off）。
   * 收到 history 请求就从这里往前 readOlder 一页、回帧并把它前移到更早处；0 = 已到文件头/无更早。
   * 每次 (重)baseline 都重置为新 baseline 的最旧一条（前端已加载的更早历史由前端合并保留，见子任务3）。
   */
  historyHead: number;
  lastSelSig: string;
  /**
   * 本连接的菜单解读缓存（issue #112）：键是 optionsSig（只认菜单本体，光标动了不算换菜单），
   * 同一菜单再点「解释一下」直接回缓存，不重复烧 LLM 额度；菜单一变即作废。
   */
  explainSig?: string;
  explainText?: string;
  /** 解读在途：连点只跑一次（回来那次统一发帧） */
  explainInFlight?: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /**
   * 「重启代理 → 等就绪 → 自动补发」在途（issue #97）。单条在途：等待期间再发的消息
   * 直接告诉用户稍候，不排队——排队会让人以为发出去了，实际堆在服务端等一个可能起不来的代理。
   */
  resendInFlight?: boolean;
  /** 连接已关（chatClose 置位）：在途的补发等待据此提前收手 */
  closed?: boolean;
}

/** baseline 从 jsonl 尾部最多读多少字节（够装下最近 60 条气泡） */
export const BASELINE_BYTES = 256 * 1024;
/** baseline 最多带多少条气泡（任务钦定 60） */
export const BASELINE_MSGS = 60;

function send(ws: ServerWebSocket<ChatWsData>, frame: unknown): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* 连接已断 */
  }
}

/** 目标 tmux 会话判活 + 前台命令；listSessions 失败返回 null（未知——放行走原注入路径） */
async function sessionInfo(
  driver: ChatDriver,
  name: string,
): Promise<{ alive: boolean; command?: string } | null> {
  try {
    const s = (await driver.listSessions()).find((x) => x.name === name);
    if (!s) return { alive: false };
    return { alive: true, ...(s.command ? { command: s.command } : {}) };
  } catch {
    return null;
  }
}

/** 该连接可能对着哪种代理：钉住对话已知就用它，未知时两家都算（判死要两家都同意） */
function agentKinds(d: ChatWsData): AgentKind[] {
  return d.agent ? [d.agent] : ['claude', 'codex'];
}

/**
 * 这条会话里代理还在不在跑（issue #97）。agent 未知时**两家都判一遍、全票才算死**——
 * 误判成死的代价是 kill 掉正在干活的进程，宁可漏判。
 */
function livenessOf(
  d: ChatWsData,
  pane: string | undefined,
  command: string | undefined,
  quietMs: number | undefined,
): AgentLiveness {
  const votes = agentKinds(d).map((agent) =>
    judgeAgentLiveness({
      agent,
      ...(command !== undefined ? { paneCommand: command } : {}),
      ...(pane !== undefined ? { pane } : {}),
      ...(quietMs !== undefined ? { quietMs } : {}),
    }),
  );
  if (votes.every((v) => v === 'shell')) return 'shell';
  return votes.some((v) => v === 'live') ? 'live' : 'unknown';
}

/** 屏面上代理的输入框真画出来了 = 可以注入了（agent 未知时任一家的特征都算数） */
function paneReadyFor(d: ChatWsData, pane: string): boolean {
  return agentKinds(d).some((agent) => paneHasAgentUi(agent, pane));
}

const DEFAULT_RESEND_WAIT_MS = 30_000;
const DEFAULT_RESEND_POLL_MS = 1_000;

/** 前端提示文案里的主语：知道是 codex 就直说，否则统称 AI */
function whoOf(d: ChatWsData): string {
  return d.agent === 'codex' ? 'codex' : 'AI';
}

/** 强制重启这条对话的代理（chat 独立会话只需 tmux 锁；issue 现场遵引擎锁序 project → tmux） */
async function relaunchAgent(ws: ServerWebSocket<ChatWsData>, deps: ChatWsDeps): Promise<void> {
  const d = ws.data;
  const convId = d.convId;
  if (!convId) return;
  const run = deps.convs.relaunch
    ? () => deps.convs.relaunch!(convId)
    : deps.convs.activate
      ? () => deps.convs.activate!(convId)
      : null;
  if (!run) return;
  await (d.chatMode
    ? deps.mutex.runExclusive(tmuxLockKey(d.session), run)
    : deps.mutex.runExclusive(projectLockKey(d.projectId), () =>
        deps.mutex.runExclusive(tmuxLockKey(d.session), run),
      ));
}

/**
 * 代理退回 shell 时的处置（issue #97）：**强制重启 → 等它真就绪 → 自动补发这条消息**。
 * 用户答应过的「不用手动重发」就落在这里。
 *
 * - 先回一帧 agent_not_ready 让界面立刻有反馈（前端把它显示成「正在重启并自动补发」）；
 * - 等就绪只认屏面画出输入框（`paneReadyFor`）——刚 kill+起新那会儿窗格里还是 bash，
 *   照发就等于把用户的话打进 shell；
 * - 超时不硬发：把话还给用户（再回一帧，让他自己决定重发），绝不静默丢。
 */
async function restartAndResend(
  ws: ServerWebSocket<ChatWsData>,
  deps: ChatWsDeps,
  text: string,
  inj: { driver: ChatDriver; mutex: KeyedMutex; retryDelayMs?: number },
  /** 这条消息的乐观气泡 id（issue #116）：结局落定时才带回去，「正在补发」那帧不带 */
  msgId?: string,
): Promise<void> {
  const d = ws.data;
  const who = whoOf(d);
  const idPart = msgId ? { id: msgId } : {};
  if (d.resendInFlight) {
    // 这条没排队 = 就是发不出去：带 id 让前端标失败，别让气泡永远转圈
    send(ws, { type: 'err', code: 'agent_not_ready', msg: `${who} 正在重启，上一条还在补发中，请稍候`, ...idPart });
    return;
  }
  d.resendInFlight = true;
  // 唯一不带 id 的 err：这条话还活着（重启后会自动补发），前端保持「发送中」等结局
  send(ws, { type: 'err', code: 'agent_not_ready', msg: `${who} 不在（可能已退出/登录过期），正在重启并自动补发…` });
  try {
    await relaunchAgent(ws, deps);
    const deadline = Date.now() + (deps.resendWaitMs ?? DEFAULT_RESEND_WAIT_MS);
    const pollMs = deps.resendPollMs ?? DEFAULT_RESEND_POLL_MS;
    let ready = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (d.closed) return; // 页面关了：这条不补发（用户已经看不到结果，注入只会打扰下一个人）
      const pane = await d.driver.capturePane(d.session).catch(() => '');
      if (paneReadyFor(d, pane)) {
        ready = true;
        break;
      }
    }
    if (!ready) {
      send(ws, {
        type: 'err',
        code: 'agent_not_ready',
        msg: `${who} 重启后仍未就绪，这条没发出去，请稍后重发`,
        ...idPart,
      });
      return;
    }
    await injectText(inj, d.session, text);
    deps.messages?.bump(d.userId); // 补发成功才计；发帧时那条并未注入过，故不会重复
    if (msgId) send(ws, { type: 'ack', id: msgId }); // 真注入这一刻才算「已送达」
  } catch {
    send(ws, { type: 'err', code: 'inject_failed', ...idPart });
  } finally {
    d.resendInFlight = false;
  }
}

/**
 * 发帧前富化：user 消息若含对话附图（extractUploadRels 命中上传目录里的截图 rel），挂 images 供前端
 * 缩略图/灯箱预览，并用 stripImageHint 把 AI 向的「请先用 Read…」提示从正文里剥掉（对话附图不落库，
 * 全靠回读消息文本还原，见 core/uploads.ts）。非 user / 无附图消息原样透传，不复制、不改动。
 */
function enrichUserImages(m: ChatMessage): ChatMessage {
  if (m.role !== 'user') return m;
  const images = extractUploadRels(m.text ?? '');
  if (images.length === 0) return m;
  return { ...m, images, text: stripImageHint(m.text ?? '') };
}

// ---------- baseline / tick ----------

async function sendBaseline(ws: ServerWebSocket<ChatWsData>, deps: ChatWsDeps): Promise<void> {
  const d = ws.data;
  const cur = deps.convs.currentConv(d.projectId) ?? null;
  if (d.chatMode) {
    // 独立聊天对话：钉住自身、注入自身会话（session=chat-<convId>），恒可注入
    d.convId = d.pinnedConv;
    d.live = true;
  } else {
    d.convId = d.pinnedConv ?? cur;
    d.live = d.pinnedConv === null || d.pinnedConv === cur;
  }
  // 钉住模式（issue 现场或独立聊天）的 mode 帧先于 baseline（前端据此初始化输入区）；非钉住不发
  if (d.pinnedConv !== null) send(ws, { type: 'mode', live: d.live });
  d.jsonl = d.convId ? await deps.locator.locate(d.convId) : null;
  d.offset = 0;
  d.nextSeq = 0;
  let msgs: ChatMessage[] = [];
  if (d.jsonl) {
    const st = await deps.reader.statPath(d.jsonl).catch(() => null);
    if (st) {
      // 从尾部窗口起 tail：脏头（可能落在行中间）由 parseLine 容忍，offset 精确推进到行边界
      const start = Math.max(0, st.size - BASELINE_BYTES);
      const t = await tailConversation(deps.reader, d.jsonl, start, 0);
      msgs = t.msgs.slice(-BASELINE_MSGS);
      d.offset = t.offset;
      d.nextSeq = t.nextSeq;
    }
  }
  // 翻页游标 = 本次 baseline 最旧一条的源行字节（其之前的都能 readOlder 拉到，含窗口内没进 60 的那些）
  d.historyHead = msgs.length ? (msgs[0]!.off ?? 0) : 0;
  // 只读（钉住非激活对话）不看屏：pane 上的菜单属于激活对话，发出去就是张冠李戴
  let sel: ReturnType<typeof detectSelection> = null;
  if (d.live) {
    const pane = await d.driver.capturePane(d.session).catch(() => '');
    sel = detectSelection(pane);
  }
  d.lastSelSig = sel ? selectionSig(sel) : '';
  send(ws, { type: 'baseline', msgs: msgs.map(enrichUserImages), selection: sel ? selectionFrameOf(sel) : null });
}

async function chatTick(ws: ServerWebSocket<ChatWsData>, deps: ChatWsDeps): Promise<void> {
  const d = ws.data;
  const cur = deps.convs.currentConv(d.projectId) ?? null;
  if (d.chatMode) {
    // 独立聊天对话：不跟随切换、不翻转 live（恒 true，注入始终打到自身会话）
  } else if (d.pinnedConv !== null) {
    // 钉住模式：对话不跟随切换，只翻转 live（并在转非 live 时清菜单——它属于新激活对话）
    const live = d.pinnedConv === cur;
    if (live !== d.live) {
      d.live = live;
      send(ws, { type: 'mode', live });
      if (!live && d.lastSelSig !== '') {
        d.lastSelSig = '';
        send(ws, { type: 'selection', sel: null });
      }
    }
  } else if (cur !== d.convId) {
    // 活跃对话被切换 → 重发 baseline（前端按 baseline 重置视图）
    await sendBaseline(ws, deps);
    return;
  }
  // 新对话的 jsonl 此前未落地：出现后重发 baseline（从尾部窗口起读）
  if (d.convId && !d.jsonl) {
    const p = await deps.locator.locate(d.convId);
    if (p) {
      await sendBaseline(ws, deps);
      return;
    }
  }
  if (d.jsonl) {
    const t = await tailConversation(deps.reader, d.jsonl, d.offset, d.nextSeq);
    d.offset = t.offset;
    d.nextSeq = t.nextSeq;
    for (const m of t.msgs) send(ws, { type: 'msg', m: enrichUserImages(m) });
  }
  if (!d.live) return; // 只读：不看屏、不发 selection
  const pane = await d.driver.capturePane(d.session).catch(() => '');
  const sel = detectSelection(pane);
  const sig = sel ? selectionSig(sel) : '';
  if (sig !== d.lastSelSig) {
    d.lastSelSig = sig;
    send(ws, { type: 'selection', sel: sel ? selectionFrameOf(sel) : null });
  }
}

// ---------- 菜单解读（issue #112） ----------

/** 从全签名（screen.selectionSig = options.join('|')+'@'+cursorIndex）里取菜单本体那半截 */
function optionsPartOf(sig: string): string {
  const i = sig.lastIndexOf('@');
  return i < 0 ? sig : sig.slice(0, i);
}

/**
 * 「解释一下」：抓屏重取当前菜单 → 缓存命中直接回 → 否则调 deps.explain 生成。
 *
 * 过期判定只比**菜单本体**（optionsSig），不比光标：光标挪一格问题还是同一个，
 * 按全签名判就会把一次正常点击判成过期，界面上表现为莫名其妙的「菜单已过期」。
 */
async function handleExplain(
  ws: ServerWebSocket<ChatWsData>,
  f: Record<string, unknown>,
  deps: ChatWsDeps,
): Promise<void> {
  const d = ws.data;
  const pane = await d.driver.capturePane(d.session).catch(() => '');
  const sel = detectSelection(pane);
  if (!sel) {
    send(ws, { type: 'stale' }); // 菜单已经没了：没什么可解释的，前端清掉解读等新菜单
    return;
  }
  const key = optionsSigOf(sel.options);
  if (typeof f.sig === 'string' && optionsPartOf(f.sig) !== key) {
    send(ws, { type: 'stale' }); // 客户端要解释的是上一个菜单
    return;
  }
  const sig = selectionSig(sel);
  if (d.explainSig !== key) {
    // 菜单换了：旧解读立刻作废，别让上一个问题的解读挂在新菜单上
    d.explainSig = '';
    d.explainText = '';
  }
  if (d.explainText) {
    send(ws, { type: 'explanation', sig, optionsSig: key, text: d.explainText });
    return;
  }
  if (d.explainInFlight) return; // 连点：在途那次回来会发帧，这里静默丢弃
  if (!deps.explain) {
    send(ws, { type: 'err', code: 'explain_failed' });
    return;
  }
  d.explainInFlight = true;
  try {
    const text = await deps.explain({
      projectId: d.projectId,
      context: sel.context,
      options: sel.options,
      multiSelect: sel.multiSelect,
    });
    if (!text) {
      send(ws, { type: 'err', code: 'explain_failed' }); // 生成失败不缓存，下次点还能重试
      return;
    }
    d.explainSig = key;
    d.explainText = text;
    send(ws, { type: 'explanation', sig, optionsSig: key, text });
  } catch {
    send(ws, { type: 'err', code: 'explain_failed' });
  } finally {
    d.explainInFlight = false;
  }
}

// ---------- open / message / close ----------

export async function chatOpen(ws: ServerWebSocket<ChatWsData>, deps: ChatWsDeps): Promise<void> {
  await sendBaseline(ws, deps);
  const period = Math.max(20, deps.chatPollMs ?? 1200);
  ws.data.timer = setInterval(() => {
    void chatTick(ws, deps).catch(() => {
      /* 单轮失败不断流，下一轮重试 */
    });
  }, period);
}

export function chatMessage(
  ws: ServerWebSocket<ChatWsData>,
  msg: string | Uint8Array,
  deps: ChatWsDeps,
): void {
  if (typeof msg !== 'string') {
    send(ws, { type: 'err', code: 'bad_frame' });
    return;
  }
  let j: unknown;
  try {
    j = JSON.parse(msg);
  } catch {
    send(ws, { type: 'err', code: 'bad_frame' });
    return;
  }
  void handleFrame(ws, j as Record<string, unknown>, deps).catch(() => {
    send(ws, { type: 'err', code: 'inject_failed' });
  });
}

async function handleFrame(
  ws: ServerWebSocket<ChatWsData>,
  f: Record<string, unknown>,
  deps: ChatWsDeps,
): Promise<void> {
  const d = ws.data;
  // 这条文本消息的乐观气泡 id（issue #116）：只有 text 帧带；其结局（ack/err）必须原样带回，
  // 否则前端那条「发送中」永远转圈。非 text 帧无 id，行为与改动前一致。
  const msgId = f.type === 'text' && typeof f.id === 'string' && f.id ? f.id : undefined;
  const idPart = msgId ? { id: msgId } : {};
  // history 是纯读历史（向上翻页），与 live/只读无关，先于注入门控处理——只读回看也能翻页
  if (f.type === 'history') {
    if (!d.jsonl || d.historyHead <= 0) {
      send(ws, { type: 'history', msgs: [], hasMore: false });
      return;
    }
    const r = await readOlder(deps.reader, d.jsonl, d.historyHead);
    d.historyHead = r.offset; // 前移游标到更早处（0 = 到顶）
    send(ws, { type: 'history', msgs: r.msgs.map(enrichUserImages), hasMore: r.hasMore });
    return;
  }
  // 解读只读屏、不注入，走自己的分支（不必过注入自愈门禁：会话死了 capturePane 自然抓不到菜单）。
  // 但仍受 live 门控——只读模式下 pane 上的菜单属于别的对话，解释它就是张冠李戴。
  if (f.type === 'explain') {
    if (!d.live) {
      send(ws, { type: 'err', code: 'forbidden' });
      return;
    }
    await handleExplain(ws, f, deps);
    return;
  }
  if (!d.live && (f.type === 'text' || f.type === 'key' || f.type === 'select')) {
    // 只读模式（钉住非激活对话）：注入一律拒——屏幕/进程属于别的对话
    send(ws, { type: 'err', code: 'forbidden', ...idPart });
    return;
  }
  // 注入自愈门禁（issue #88）：目标 tmux 会话已不存在（systemd 重启连坐/宿主重启）时，
  // 盲注入只会抛「can't find pane」→ 笼统 inject_failed 且永不自愈。注入前判活：死会话 →
  // 触发 activate 重建（issue 现场=激活对话 kill 旧起新 --resume；chat=自身会话复活）并回
  // agent_not_ready 明确文案让用户稍候重发。锁序遵引擎 I3：project → tmux。
  // listSessions 失败按未知放行走原注入路径（宁可 inject_failed 也不误报死会话）。
  let agentDown = false;
  if (f.type === 'text' || f.type === 'key' || f.type === 'select') {
    const info = await sessionInfo(d.driver, d.session);
    if (info && !info.alive) {
      if (d.convId && deps.convs.activate) {
        const cid = d.convId;
        void deps.mutex
          .runExclusive(projectLockKey(d.projectId), () =>
            deps.mutex.runExclusive(tmuxLockKey(d.session), () => deps.convs.activate!(cid)),
          )
          .catch(() => {});
      }
      send(ws, {
        type: 'err',
        code: 'agent_not_ready',
        msg: `${whoOf(d)} 会话不在（可能服务重启过），正在自动重建…请稍候重发`,
        ...idPart, // 这条要用户自己重发（不自动补发）→ 带 id 标失败
      });
      return;
    }
    // 就绪门禁（issue #97，全代理、全模式）：会话还在，但里面只剩 bash——直接 sendKeys
    // 会把用户的话当 shell 命令跑掉（command not found，表现为「发了没反应」）。
    // 旧实现只在 chat 模式、只对 codex 看屏，claude 与 issue 现场会话全裸奔。
    if (info) {
      const pane = await d.driver.capturePane(d.session).catch(() => undefined);
      // 判死硬闸：会话文件最近还在长 = 代理活着（它可能只是在跑一条前台命令，屏幕和前台
      // 命令双双像 shell——生产实测靠这两个信号会误杀正在干活的代理）
      const st = d.jsonl ? await deps.reader.statPath(d.jsonl).catch(() => null) : null;
      const quietMs = st?.mtimeMs !== undefined ? Math.max(0, Date.now() - st.mtimeMs) : undefined;
      agentDown = livenessOf(d, pane, info.command, quietMs) === 'shell';
    }
    if (agentDown && f.type !== 'text') {
      // 按键/选项是对着**旧屏幕**说的，重启后那个菜单早没了，补发只会乱点：只重启不补发。
      void relaunchAgent(ws, deps).catch(() => {});
      send(ws, { type: 'err', code: 'agent_not_ready', msg: `${whoOf(d)} 不在，正在重启…请稍候重试` });
      return;
    }
  }
  const inj = {
    driver: d.driver,
    mutex: deps.mutex,
    ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
  };

  if (f.type === 'text') {
    const rawText = typeof f.text === 'string' ? f.text : '';
    // 附图：仅上传目录内的 rel 保留（isUploadRel 挡伪造路径引用任意文件）+ 最多 6 张，与建 issue 同款；
    // 拼成执行机侧绝对路径，经 imageReadHint 生成「请先用 Read 逐张看图」提示（对话里的图不写 images_json）。
    const rels = Array.isArray(f.images)
      ? (f.images as unknown[])
          .filter((p): p is string => typeof p === 'string' && p.length > 0 && isUploadRel(p))
          .slice(0, 6)
      : [];
    const hint = rels.length ? imageReadHint(absImages(d.cwd, rels)) : '';
    // 只发图（文本空但有图）也放行；纯空帧（无文本无图）→ bad_frame，不注入
    if (!rawText.trim() && !hint) {
      send(ws, { type: 'err', code: 'bad_frame', ...idPart });
      return;
    }
    // 提示在前、用户文本在后（hint 去前导空行，与文本用换行分隔；注入时 sendKeys 把换行压成空格）
    const cleanHint = hint.replace(/^\n+/, '');
    const combined = cleanHint ? cleanHint + (rawText.trim() ? '\n' + rawText : '') : rawText;
    // 代理退回 shell（issue #97）：不盲注——重启 + 等就绪 + 自动补发这条（后台跑，不挂住本帧）
    if (agentDown) {
      void restartAndResend(ws, deps, combined, inj, msgId);
      return;
    }
    try {
      await injectText(inj, d.session, combined);
    } catch {
      // 就地兜住（而非交给 chatMessage 的外层 catch）：外层不认识 msgId，回的 err 不带 id
      send(ws, { type: 'err', code: 'inject_failed', ...idPart });
      return;
    }
    deps.messages?.bump(d.userId); // 注入成功才计（抛错走上面的 catch → inject_failed，不计）
    if (msgId) send(ws, { type: 'ack', id: msgId });
    return;
  }
  if (f.type === 'key' && typeof f.key === 'string') {
    try {
      await injectKey(inj, d.session, f.key);
    } catch {
      send(ws, { type: 'err', code: 'bad_key' }); // 白名单外（v1 语义：拒绝任意键注入）
    }
    return;
  }
  if (f.type === 'select' && Number.isInteger(f.index)) {
    const index = f.index as number;
    // 升级卡的网页消费口：requestId 消费即焚 + 管道内核对 menuSig
    if (typeof f.requestId === 'string' && deps.approvals) {
      const r = await deps.approvals.consume(f.requestId, index, { expectSession: d.session });
      if (!r.ok) {
        if (r.reason === 'stale' || r.reason === 'no_menu') send(ws, { type: 'stale' });
        else send(ws, { type: 'err', code: r.reason ?? 'expired' });
      }
      return;
    }
    const r = await actOnMenu(
      inj,
      d.session,
      index,
      typeof f.sig === 'string' ? { sig: f.sig } : {},
    );
    if (!r.ok) {
      if (r.reason === 'stale' || r.reason === 'no_menu') send(ws, { type: 'stale' });
      else send(ws, { type: 'err', code: 'out_of_range' });
    }
    return;
  }
  send(ws, { type: 'err', code: 'bad_frame' });
}

export function chatClose(ws: ServerWebSocket<ChatWsData>): void {
  const d = ws.data;
  if (d.timer) clearInterval(d.timer);
  d.timer = null;
  d.closed = true; // 在途的「等就绪再补发」据此立刻收手，不对着已关的连接空转 30s
}
