/**
 * core/screen —— CC 终端屏幕解析：选择菜单检测。
 * v1 observer.ts:139-168 detectSelection 平移；评审 5.1#3 钦定
 * 「正则与装饰字符集逐字节照抄（⎿●○⏺ 一个不能少）」。
 * 差异仅一处：v1 内联 execFileSync capture-pane，v2 由调用方经 Driver.capturePane
 * 抓屏后把文本传进来（控制面不直接摸 tmux）。
 * issue #94/#95：选项块扫描由「选项行必须相邻」改为「编号严格连续、可跨说明行/分隔线/空行」
 * ——CC 的 AskUserQuestion 每个 label 下面跟 2~3 行说明，旧扫描一撞说明行就停，网页只显示
 * 第 1 项、其余项 out_of_range 点不到（见本文件 detectSelection 内注释与 screen.test.ts 语料）。
 * issue #48：光标集扩到 [❯›]——codex TUI 菜单用 › 光标（0.144 实测），原来只认 ❯
 * 导致 codex 弹窗一律检不到（滞留告警/审批管道对 codex 全失效）。codex composer
 * 输入行也是 › 开头，但后面不是「编号. 」不会误判。
 */

/** CC 终端任意「选择菜单」（权限 yes/no、信任目录、计划确认、多选…均统一为此，v1 SelectionPayload） */
export interface SelectionPayload {
  /** 选项上方的说明（工具/命令/问题） */
  context: string;
  /** 选项文本列表 */
  options: string[];
  /**
   * 每项的次级说明（与 options 同序、等长；没有说明的项为 ''）。
   * 来源=选项行与下一选项行之间那几行说明文字（AskUserQuestion 的 description，终端折行后可能多行）。
   * **只供展示**：不并进 options、不进 selectionSig——签名口径一变，在途的卡片/网页 select 会全判 stale。
   */
  details: string[];
  /** 当前 ❯ 所在选项（0-based），用于算方向键步数 */
  cursorIndex: number;
  /**
   * 多选表单（选项带 `[ ]`/`[✔]`/`☐` 复选框，AskUserQuestion multiSelect:true）。
   * 这类菜单的按键语义与单选完全不同（0.1.220 实测）：`空格`/`Enter` 都只是**勾选/取消**，
   * 菜单不关闭；要按 `→` 进「Review your answers」页再选 `1. Submit answers` 才真提交。
   * 所以网页卡片必须明说「点一下只是勾选」，否则用户以为答完了、实际什么都没提交。
   */
  multiSelect: boolean;
}

/**
 * 从 capture-pane 文本检测「选择菜单」（带 ❯/› 光标的编号选项；❯=claude、›=codex）。
 * 返回当前菜单（context/options/cursorIndex）或 null。
 */
/** 选项行：可带 ❯/› 光标，形如 `❯ 1. 文本` / `  2. 文本`（选项行不能有前导边框，评审 M5） */
const OPT_LINE_RE = /^\s*([❯›])?\s*(\d+)\.\s+(.+?)\s*$/;

/**
 * 菜单页脚提示（claude/codex 都在选项块末尾打这行）——扫到即收尾，
 * 挡住「页脚下面正文里的编号列表被粘进菜单」。
 */
const MENU_FOOTER_RE =
  /(enter to (select|confirm)|esc to cancel|↑\/↓|press enter to continue|to (navigate|toggle))/i;

/**
 * 相邻两个选项之间允许夹多少行非选项内容（说明文字/分隔线/空行）。
 * 20 行是照 AskUserQuestion 实测形态留的余量（每项 2~3 行中文说明，窄屏折行后翻倍）；
 * 粘错的风险由「编号必须严格连续」兜住，所以这里可以给得宽。
 */
const MAX_GAP_LINES = 20;

interface OptLine {
  cursor: boolean;
  num: number;
  text: string;
}

function parseOptionLine(line: string): OptLine | null {
  const m = line.match(OPT_LINE_RE);
  if (!m) return null;
  return { cursor: Boolean(m[1]), num: Number.parseInt(m[2]!, 10), text: m[3]! };
}

/** 装饰字符（边框/分隔线/项目符号）——context 与 details 共用同一套清洗 */
const DECOR_RE = /[│┃┆┊╎╏┌┐└┘├┤┬┴┼─━┄┅╌╍╭╮╰╯╴╶▌▏⎿●○⏺]/g;

/** 单条说明字符数上限（帧要过 WS，别把整屏说明搬过去；超出截断加省略号） */
const DETAIL_MAX_CHARS = 300;

/**
 * 把说明行拼回一段：终端是按宽度硬折行的，中文之间不能补空格（会多出怪空格），
 * 英文单词之间要补（折行时那个空格被吃掉了）。故只在「两侧都是 ASCII 可见字符」时补空格。
 */
function joinWrapped(parts: string[]): string {
  const s = parts.reduce((acc, p) => {
    if (!acc) return p;
    const needSpace = /[\x21-\x7e]$/.test(acc) && /^[\x21-\x7e]/.test(p);
    return acc + (needSpace ? ' ' : '') + p;
  }, '');
  return s.length > DETAIL_MAX_CHARS ? `${s.slice(0, DETAIL_MAX_CHARS)}…` : s;
}

/** 说明行清洗：去边框/分隔线装饰 + 压空白；整行只有装饰或空白 → '' （调用方丢弃） */
function cleanDetailLine(line: string): string {
  return line.replace(DECOR_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** 复选框式选项：`[ ] 视觉模块` / `[✔] 视觉模块` / `☐ 视觉模块`（实测 CC 用 `[ ]`/`[✔]`） */
const CHECKBOX_OPT_RE = /^(?:[[［]\s*[xX✔✓]?\s*[\]］]|[☐☑☒])\s*/;

/**
 * 多选表单判定：**只认选项本体上的复选框**。
 * 不能拿 context 里的 ☐ 当判据——单选 AskUserQuestion 的表头也是 `☐ 盒子朝向`，
 * 用它判会把普通单选菜单全误标成多选（agents/approval-policy 那条宽判据是给
 * 「宁可升级人工」用的，展示层不能照抄）。
 */
export function isMultiSelectOptions(options: string[]): boolean {
  return options.some((o) => CHECKBOX_OPT_RE.test(o));
}

export function detectSelection(pane: string): SelectionPayload | null {
  const lines = pane.split('\n');

  // 锚点：❯/› 落在某个编号选项上 = 当前有选择菜单
  const cursorLine = lines.findIndex((l) => /[❯›]\s*\d+\.\s/.test(l));
  if (cursorLine < 0) return null;
  // 光标行本身解析不出「编号. 文本」（如带前导边框）→ 与旧实现一致，按无菜单处理
  const anchor = parseOptionLine(lines[cursorLine]!);
  if (!anchor) return null;

  // issue #94/#95：选项行**不一定相邻**——CC 的 AskUserQuestion 每个 label 下面跟 2~3 行
  // 说明，`4. Type something.` 与 `5. Chat about this` 之间还夹一条分隔线。旧实现按
  // 「相邻」扩边界，一撞说明行就停 → 网页只显示 1 个选项、其余项点不到（out_of_range），
  // 光标移到末项时还会退化成 ["Chat about this"] 让签名张冠李戴。
  // 现在改成从光标行出发、按**编号严格连续**（±1）跨越说明行/分隔线/空行继续收集；
  // 遇到编号断档、页脚提示、或间隔超预算即收尾——普通正文里的编号列表接不上号，粘不进来。
  // 夹在两个选项行之间的非选项行 = 上一项的说明（AskUserQuestion 的 description）。
  const before: Array<{ text: string; detail: string }> = [];
  let s = cursorLine; // 选项块首行（context 从它上方取）
  let expectUp = anchor.num - 1;
  let gapUp = 0;
  let bufUp: string[] = []; // 逆序累积：碰到上一个选项行时倒过来即是它的说明
  for (let i = cursorLine - 1; i >= 0 && expectUp >= 1; i--) {
    const line = lines[i]!;
    const m = parseOptionLine(line);
    if (m) {
      if (m.num !== expectUp) break; // 编号断档 = 另一个列表
      before.push({ text: m.text, detail: joinWrapped([...bufUp].reverse()) });
      bufUp = [];
      s = i;
      expectUp--;
      gapUp = 0;
      continue;
    }
    if (MENU_FOOTER_RE.test(line)) break;
    if (++gapUp > MAX_GAP_LINES) break;
    const c = cleanDetailLine(line);
    if (c) bufUp.push(c);
  }

  const after: Array<{ text: string; detail: string }> = [];
  let expectDown = anchor.num + 1;
  let gapDown = 0;
  let bufDown: string[] = []; // 顺序累积：归属「当前最后一项」（起始是光标项）
  let anchorDetail = '';
  const flushDown = (): void => {
    const detail = joinWrapped(bufDown);
    bufDown = [];
    if (!detail) return;
    if (after.length) after[after.length - 1]!.detail = detail;
    else anchorDetail = detail;
  };
  for (let i = cursorLine + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (MENU_FOOTER_RE.test(line)) break;
    const m = parseOptionLine(line);
    if (m) {
      if (m.num !== expectDown) break;
      flushDown();
      after.push({ text: m.text, detail: '' });
      expectDown++;
      gapDown = 0;
      continue;
    }
    if (++gapDown > MAX_GAP_LINES) break;
    const c = cleanDetailLine(line);
    if (c) bufDown.push(c);
  }
  flushDown(); // 末项的说明（后面就是页脚/屏尾）

  const cursorIndex = before.length; // 光标项前面收了几项，它就是第几项
  const block = [...before.reverse(), { text: anchor.text, detail: anchorDetail }, ...after];
  const options = block.map((o) => o.text);
  const details = block.map((o) => o.detail);
  if (options.length < 1) return null;

  // 菜单上方的说明：往上多取行，去掉边框/装饰字符，保留有意义的最后几行(含工具/命令 + 在问什么)
  const ctx = lines
    .slice(Math.max(0, s - 14), s)
    .map((l) => cleanDetailLine(l))
    .filter((l) => l && !/^[?·•\-—]+$/.test(l));
  const context = ctx.slice(-6).join('\n');
  return { context, options, details, cursorIndex, multiSelect: isMultiSelectOptions(options) };
}

/** 菜单签名（options + cursorIndex），去重/注入前核对用（v1 agent.ts:622 签名式平移） */
export function selectionSig(sel: SelectionPayload): string {
  return sel.options.join('|') + '@' + sel.cursorIndex;
}

/** codex 启动的「有可用更新」交互弹窗（› 光标、"Press enter to continue" 默认跑安装）识别 */
export function isCodexUpdatePrompt(pane: string): boolean {
  return /Update available/i.test(pane) && /Press enter to continue/i.test(pane);
}

/**
 * codex 已退回 shell 的判据——实现已于 issue #97 迁到 core/agent-liveness（那里还有通用的
 * 三态判定 judgeAgentLiveness）。此处保留再导出：既有调用方（conversations/chat）与用例
 * 的 import 路径不变。
 */
export { codexExitedToShell } from './agent-liveness';
