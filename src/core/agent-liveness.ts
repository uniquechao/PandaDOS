/**
 * core/agent-liveness —— 「tmux 会话活着 ≠ 代理活着」的判定（issue #97）。
 *
 * 背景：claude/codex 退出（自更新、崩溃、登录过期、被 Ctrl-C）后 tmux 会话仍在，窗格里只剩
 * 一个 bash 提示符。此时任何注入都会被 shell 当命令执行——轻则 `command not found` 刷屏、
 * 用户看到「发了没反应」，重则一整段 prompt 里的元字符落到 shell 上。#88 的自愈只处理
 * 「tmux 会话没了」，正好漏掉这一档：会话在、pane 非空，判活为真，于是照旧盲发。
 *
 * 判定分两级（顺序即可信度）：
 * 1. **主判 = tmux `#{pane_current_command}`**（listSessions 已返回 `command`）。这是前台进程组
 *    的真名，比抓屏猜可靠得多。实测：claude 跑着 → `claude`；codex → `codex`；退回 shell → `bash`。
 *    代理执行工具调用（Bash 工具）时**不会**翻成 `bash`（子进程不在窗格前台进程组里，本机实测确认），
 *    所以不会因为代理正在跑命令而误判成 shell。
 * 2. **佐证 = 屏面**：末条非空行像不像 shell 提示符、有没有代理 UI 特征。command 缺失
 *    （老实现/解析失败/listSessions 抛错）时只能靠它。
 *
 * **三态而非布尔**：`live` / `shell` / `unknown`，判不准一律 `unknown`，调用方对 unknown
 * 必须「什么都不做」。误判成 shell 的代价是 kill 掉正在干活的代理（不可逆，丢上下文），
 * 比漏判（多等一轮）贵得多，所以两个信号打架时宁可不动。
 */
import type { AgentKind } from './types';

/** 代理存活三态；`unknown` = 证据不足，调用方必须保守不动作 */
export type AgentLiveness = 'live' | 'shell' | 'unknown';

/**
 * 前台命令是 shell = 代理已退出。只收真·交互 shell：
 * `su`/`login`/编辑器/`git` 之类一律落到 unknown（不确定就不动），漏判无害、误判要命。
 * tmux 对登录 shell 会报 `-bash`，故规范化时去前导 `-`。
 */
const SHELL_COMMANDS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
]);

/**
 * 前台命令是代理本体（或它的宿主运行时）= 活着。
 * 这张表**只用于正向确认**（比如把重启失败计数清零），少一项只会变成 unknown（不动作），
 * 不会造成误杀，所以宁可写窄。
 */
const AGENT_COMMANDS: ReadonlySet<string> = new Set(['claude', 'codex', 'node', 'bun', 'deno', 'npx']);

/**
 * 末条非空行像 shell 提示符（`#` root / `$` 普通用户 / `%` zsh 收尾，可带尾随空格）。
 * 两家代理的窗格底部都是状态栏或 `❯`/`›` 输入行，不以这些字符收尾，故不会误判。
 * 全空白 → false（无从判定，按「没退回 shell」处理，绝不据此重启）。
 */
export function shellPromptTail(pane: string): boolean {
  const lines = pane.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim()) return /[#$%]\s*$/.test(lines[i]!);
  }
  return false;
}

/**
 * codex 已退回 shell（原 core/screen 同名函数，issue #97 归并到此处，screen.ts 继续再导出）。
 * 比通用判据多认一条 codex 自更新后的「Please restart Codex」——那行之后屏面可能还留着
 * 更新日志、提示符不在末行，光靠 shellPromptTail 会漏。
 */
export function codexExitedToShell(pane: string): boolean {
  if (/Please restart Codex/i.test(pane)) return true;
  return shellPromptTail(pane);
}

/**
 * 屏面是否有该代理的 UI 特征（claude：`❯` 输入行 / `╭─` 边框；codex：`›` 输入行 / 启动横幅）。
 * 与引擎 kickoff 的 `paneReady` 同一套判据，保持一致。
 * 注意这是**弱信号**：某些 shell 的 PS1 也用 `❯`/`›`，且代理退出后上一帧 UI 可能仍留在窗格里，
 * 所以它只配做佐证，不能单独定生死。
 */
export function paneHasAgentUi(agent: AgentKind, pane: string): boolean {
  return agent === 'codex'
    ? pane.includes('›') || pane.includes('OpenAI Codex')
    : pane.includes('❯') || pane.includes('╭─');
}

/** tmux 报的前台命令规范化：去登录 shell 的前导 `-`、去路径、转小写 */
function normalizeCommand(cmd: string | null | undefined): string {
  if (!cmd) return '';
  const base = cmd.trim().replace(/^-/, '').split('/').pop() ?? '';
  return base.toLowerCase();
}

/** 前台命令是交互 shell（= 代理不在跑） */
export function isShellCommand(cmd: string | null | undefined): boolean {
  return SHELL_COMMANDS.has(normalizeCommand(cmd));
}

/** 前台命令是代理本体/其运行时（= 代理在跑） */
export function isAgentCommand(cmd: string | null | undefined): boolean {
  return AGENT_COMMANDS.has(normalizeCommand(cmd));
}

/**
 * 值不值得为这一屏再花一次 listSessions（拿 pane_current_command）。
 *
 * 健康路径必须零额外开销（引擎每 3s 一 tick，SSH 执行机上每次 tmux 调用都是真流量）：
 * 屏面明明是代理 UI、且末行不是提示符 → 直接放行，不探。其余情况才探一次。
 */
export function shouldProbeLiveness(agent: AgentKind, pane: string): boolean {
  return shellPromptTail(pane) || !paneHasAgentUi(agent, pane);
}

/**
 * 「多久没输出就可以考虑判死」（issue #97 生产误杀事故后加的硬闸）。
 *
 * 代理跑前台 Bash 工具时，窗格里可能既是 `bash` 又满屏命令输出——两个信号一起指向 shell，
 * 但代理**活得好好的**。2026-07-27 生产实测：#99 的代理 10:29:28 发起 tool_use:Bash，
 * 10:29:52 被判死 kill，24 秒的沉默就够触发误杀。
 * 会话文件（jsonl）是独立于屏幕的第三方证据：**死掉的代理永远不会再写**，而活着的代理
 * 顶多沉默一小会儿。所以只要它最近还写过，无论屏幕像什么都不许判死。
 * 代价只是「真死了要多等一分钟」——比误杀一个正在干活的代理便宜得多。
 */
export const AGENT_QUIET_BEFORE_DEAD_MS = 60_000;

export interface LivenessInput {
  agent: AgentKind;
  /** tmux `#{pane_current_command}`；拿不到就别传（缺省 = 退化成只看屏） */
  paneCommand?: string | null;
  /** capturePane 文本；拿不到就别传（抓屏失败请传 undefined 而不是空串——空串是「屏真的空」） */
  pane?: string;
  /**
   * 距会话文件（jsonl）最近一次增长过了多久。传了就是硬闸：不到
   * `AGENT_QUIET_BEFORE_DEAD_MS` 一律判 live，屏幕像什么都不算数。拿不到就别传。
   */
  quietMs?: number;
}

/**
 * 综合判定代理是否还在跑。**判不准就 unknown**，调用方对 unknown 不许有任何动作。
 *
 * - 有 command：shell → shell（除非屏面明摆着还是代理 UI 且末行不是提示符 = 信号打架 → unknown）；
 *   代理命令 → live；其它（vim/git/未知）→ unknown。
 * - 无 command：codex 的「Please restart Codex」是硬证据；否则要「末行是提示符 且 没有代理 UI」
 *   才敢判 shell；只有 UI 特征 → live；全空/说不清 → unknown。
 */
export function judgeAgentLiveness(input: LivenessInput): AgentLiveness {
  const { agent, pane } = input;
  // 硬闸优先于一切屏幕/前台命令证据：刚写过东西的代理不可能是死的（见常量注释里的生产事故）
  if (input.quietMs !== undefined && input.quietMs < AGENT_QUIET_BEFORE_DEAD_MS) return 'live';
  const cmd = normalizeCommand(input.paneCommand);

  if (cmd) {
    if (SHELL_COMMANDS.has(cmd)) {
      // 信号打架（前台是 shell，屏面却是完整代理 UI 且没有提示符收尾）：宁可不动
      if (pane !== undefined && paneHasAgentUi(agent, pane) && !shellPromptTail(pane)) return 'unknown';
      return 'shell';
    }
    if (AGENT_COMMANDS.has(cmd)) return 'live';
    return 'unknown'; // vim / git / 未知前台命令：说不清，不动
  }

  if (pane === undefined || !pane.trim()) return 'unknown'; // 抓屏失败或全空：无从判定
  if (agent === 'codex' && /Please restart Codex/i.test(pane)) return 'shell';
  const ui = paneHasAgentUi(agent, pane);
  const prompt = shellPromptTail(pane);
  // 没有 command 兜底时两个都是弱信号，同时成立（上一帧 UI 没清干净 + 提示符）只能算说不清。
  // 这里不能顺手判 live：live 会让调用方把「重启失败计数」清零，等于用一条弱证据抹掉真故障。
  if (ui && prompt) return 'unknown';
  if (prompt) return 'shell';
  if (ui) return 'live';
  return 'unknown';
}
