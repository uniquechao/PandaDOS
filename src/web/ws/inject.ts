/**
 * web/ws/inject —— 网页/卡片侧的 tmux 注入原语（评审 H9 的 v2 整改落点）。
 *
 * 四条注入路径（引擎 kickoff/nudge、PM 自动审批、web /act、飞书卡片回调）必须共用
 * 同一把 KeyedMutex(tmuxLockKey)；本模块提供其中「人侧」三条路径的统一原语：
 * - injectText / injectKey：锁内单发（与引擎 inject 同一把锁串行）；
 * - actOnMenu：锁内「重抓 capturePane → 核对签名 → 相对导航 → Enter」原子完成
 *   （评审 H9：菜单已变时的盲导航会把 Enter 打进下一个弹窗——必须重抓核对）。
 *
 * 签名两档：
 * - sig（screen.ts selectionSig，含 cursorIndex）：网页 select 帧/act 路由用——
 *   客户端看到什么就核对什么；
 * - optionsSig（仅 options.join('|')）：审批升级卡用——发卡到点击存在分钟级时差，
 *   光标可能被动过，但菜单本体没变仍应可注入（审批卡不存 cursorIndex）。
 */
import { detectSelection, selectionSig, type SelectionPayload } from '../../core/screen';
import { textApprovalCandidate } from '../../agents/approval';
import { KeyedMutex, tmuxLockKey } from '../../issues/mutex';

// ---------- Driver 最小接口（ExecutorDriver 结构子集，测试可用轻量假实现） ----------

export interface MenuDriver {
  capturePane(session: string): Promise<string>;
  sendKey(session: string, key: string): Promise<void>;
  sendKeys(session: string, text: string): Promise<void>;
}

export interface InjectDeps {
  driver: MenuDriver;
  /** 必须与引擎/PM 同一实例（tmuxLockKey 同一把锁才有互斥意义） */
  mutex: KeyedMutex;
  /** 菜单抓空重试间隔（v1 act 4×50ms 平移；测试可调小） */
  retryDelayMs?: number;
}

/** 审批卡用的菜单签名：只看选项本体，不含 cursorIndex（发卡→点击期间光标可被动过） */
export function optionsSigOf(options: string[]): string {
  return options.join('|');
}

/** 纯文本确认签名：忽略空白重排与 Codex 动态 context 百分比。 */
export function textApprovalSigOf(pane: string): string {
  return (textApprovalCandidate(pane) ?? '')
    .replace(/\b\d+%\s+context left\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-3000);
}

/** WS/act 推给前端的菜单帧（sig = screen.ts selectionSig 全签名，客户端 select 时回带） */
export interface SelectionFrame {
  context: string;
  options: string[];
  /** 与 options 同序等长的次级说明（无说明为 ''）；纯展示，不进 sig */
  details: string[];
  /** 当前光标项——前端据此高亮（sig 里也含它，单独给一份省得前端解析签名） */
  cursorIndex: number;
  /** 多选表单：点一项只是勾选、不提交（前端据此改文案并给「→ 去提交」入口） */
  multiSelect: boolean;
  sig: string;
}

export function selectionFrameOf(sel: SelectionPayload): SelectionFrame {
  return {
    context: sel.context,
    options: sel.options,
    details: sel.details,
    cursorIndex: sel.cursorIndex,
    multiSelect: sel.multiSelect,
    sig: selectionSig(sel),
  };
}

// ---------- 注入原语 ----------

/** 文本注入（净化/截断在 Driver.sendKeys 内做，v1 语义）；锁内与引擎串行 */
export function injectText(deps: InjectDeps, session: string, text: string): Promise<void> {
  return deps.mutex.runExclusive(tmuxLockKey(session), () => deps.driver.sendKeys(session, text));
}

/** 单键注入（白名单校验在 Driver.sendKey 内做，白名单外抛错——调用方转错误帧/400） */
export function injectKey(deps: InjectDeps, session: string, key: string): Promise<void> {
  return deps.mutex.runExclusive(tmuxLockKey(session), () => deps.driver.sendKey(session, key));
}

export type MenuActResult =
  | { ok: true; option: string }
  | { ok: false; reason: 'no_menu' | 'stale' | 'out_of_range' };

export type TextApprovalActResult =
  | { ok: true; reply: string }
  | { ok: false; reason: 'no_prompt' | 'stale' };

/** 锁内重抓并核对纯文本确认仍是原提示，再通过 Driver 的稳定提交发送短回复。 */
export function actOnTextApproval(
  deps: InjectDeps,
  session: string,
  reply: string,
  expectedSig: string,
): Promise<TextApprovalActResult> {
  return deps.mutex.runExclusive(tmuxLockKey(session), async () => {
    const current = await deps.driver.capturePane(session).catch(() => '');
    const sig = textApprovalSigOf(current);
    if (!sig) return { ok: false, reason: 'no_prompt' } as const;
    if (sig !== expectedSig) return { ok: false, reason: 'stale' } as const;
    await deps.driver.sendKeys(session, reply);
    return { ok: true, reply } as const;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 带互斥锁的菜单选择原语（评审 H9 钦定形态）：
 * 锁内重抓 capturePane（CC 重绘瞬间可能抓空，4×retryDelay 重试——v1 act 平移）→
 * 核对签名（expect.sig 全签名 / expect.optionsSig 仅选项，二者给了都核）→
 * 从当前 cursorIndex 相对导航（Down/Up×N + Enter）。
 * 签名不符返回 stale（调用方回 {type:'stale'} / 409），绝不盲注入。
 */
export async function actOnMenu(
  deps: InjectDeps,
  session: string,
  targetIndex: number,
  expect: { sig?: string; optionsSig?: string } = {},
): Promise<MenuActResult> {
  const delay = deps.retryDelayMs ?? 50;
  return deps.mutex.runExclusive(tmuxLockKey(session), async () => {
    const capture = () => deps.driver.capturePane(session).catch(() => '');
    let sel = detectSelection(await capture());
    for (let i = 0; i < 4 && !sel; i++) {
      await sleep(delay);
      sel = detectSelection(await capture());
    }
    if (!sel) return { ok: false, reason: 'no_menu' } as const;
    if (expect.sig !== undefined && selectionSig(sel) !== expect.sig) {
      return { ok: false, reason: 'stale' } as const;
    }
    if (expect.optionsSig !== undefined && optionsSigOf(sel.options) !== expect.optionsSig) {
      return { ok: false, reason: 'stale' } as const;
    }
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= sel.options.length) {
      return { ok: false, reason: 'out_of_range' } as const;
    }
    const delta = targetIndex - sel.cursorIndex;
    const key = delta >= 0 ? 'Down' : 'Up';
    for (let i = 0; i < Math.abs(delta); i++) await deps.driver.sendKey(session, key);
    await deps.driver.sendKey(session, 'Enter');
    return { ok: true, option: sel.options[targetIndex]! } as const;
  });
}
