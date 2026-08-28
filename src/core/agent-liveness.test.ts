import { describe, expect, test } from 'bun:test';
import {
  codexExitedToShell,
  isAgentCommand,
  isShellCommand,
  judgeAgentLiveness,
  paneHasAgentUi,
  shellPromptTail,
  shouldProbeLiveness,
} from './agent-liveness';

// ---- 语料：全部取自本机 tmux 实测（capture-pane -p），不是手编的 ----

/** claude 在跑：底部是 `❯` 输入行 + 状态栏（不以 #/$ 收尾） */
const CLAUDE_LIVE = `│   Opus 5 (1M context) with xhig… · Claude Max ·    │ /release-notes for more   │
│               /…/scratchpad/livetest               │                           │
╰──────────────────────────────────────────────────────────────────────────────────╯

                tmux detected · scroll with PgUp/PgDn
──────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents                            /rc`;

/** claude 退出后：UI 自己清干净了，只剩启动命令回显 + 提示符（实测形态） */
const CLAUDE_EXITED = `[root@VM-0-6-opencloudos livetest]# claude --session-id 11111111-2222-3333-4444-555555555555
[root@VM-0-6-opencloudos livetest]#
`;

/** codex 在跑：`›` 输入行 + 状态栏 */
const CODEX_LIVE = `╭─ OpenAI Codex (v0.145.0) ─╮
›
  gpt-5.6-sol medium · ~/user_space/users/u12/demo_project`;

/** codex 自更新后退回 shell：横幅还留在屏上，提示符不一定在末行 */
const CODEX_UPDATED_OUT = `╭─ OpenAI Codex (v0.144.6) ─╮
==> Updating Codex CLI from 0.144.6 to 0.145.0
🎉 Update ran successfully! Please restart Codex.
[root@VM demo_project]#`;

/** 注入被 bash 当命令跑掉的现场（本 issue 要根治的症状） */
const BASH_AFTER_INJECT = `-bash: 请继续执行子任务: command not found
[root@VM-0-6-opencloudos panda]#`;

/** 空闲 bash */
const BASH_IDLE = `[root@VM-0-6-opencloudos livetest]#
`;

/** macOS zsh + Starship：`❯` 前面有 cwd/git 状态；不能和 Claude 的独立 composer 光标混为一谈。 */
const MAC_STARSHIP_IDLE =
  '~/Documents/codes/tmux_kits on codex/v2-root-cleanup ⇡3 ✗5 ?4 ❯';

describe('shellPromptTail', () => {
  test('末条非空行以 # / $ / % 收尾 → true（尾随空白/空行要回溯）', () => {
    expect(shellPromptTail(BASH_IDLE)).toBe(true);
    expect(shellPromptTail('[root@VM p]# ')).toBe(true);
    expect(shellPromptTail('user@host:~/p$')).toBe(true);
    expect(shellPromptTail('user@host ~/p %')).toBe(true);
    expect(shellPromptTail('[root@VM p]#\n\n  \n')).toBe(true);
    expect(shellPromptTail(BASH_AFTER_INJECT)).toBe(true);
  });

  test('代理 TUI 底部（输入行/状态栏）不以 #/$/% 收尾 → false', () => {
    expect(shellPromptTail(CLAUDE_LIVE)).toBe(false);
    expect(shellPromptTail(CODEX_LIVE)).toBe(false);
  });

  test('macOS Starship 的 cwd/git + ❯ 是 shell；Claude 独立 ❯ composer 不是', () => {
    expect(shellPromptTail(MAC_STARSHIP_IDLE)).toBe(true);
    expect(shellPromptTail('❯ ')).toBe(false);
  });

  test('全空白 → false（无从判定，绝不据此重启）', () => {
    expect(shellPromptTail('')).toBe(false);
    expect(shellPromptTail('\n \n\t\n')).toBe(false);
  });
});

describe('codexExitedToShell（原 screen.ts 同名函数，归并后语义不变）', () => {
  test('「Please restart Codex」即便提示符不在末行也算退出', () => {
    expect(codexExitedToShell(CODEX_UPDATED_OUT)).toBe(true);
    expect(codexExitedToShell('🎉 Update ran successfully! Please restart Codex.\n还有别的输出')).toBe(true);
  });

  test('末行提示符 → true；codex TUI 在跑 / 全空 → false', () => {
    expect(codexExitedToShell('[root@VM demo_project]# ')).toBe(true);
    expect(codexExitedToShell(CODEX_LIVE)).toBe(false);
    expect(codexExitedToShell('')).toBe(false);
  });
});

describe('paneHasAgentUi', () => {
  test('claude 认 ❯ / ╭─；codex 认 › / OpenAI Codex', () => {
    expect(paneHasAgentUi('claude', CLAUDE_LIVE)).toBe(true);
    expect(paneHasAgentUi('claude', CLAUDE_EXITED)).toBe(false);
    expect(paneHasAgentUi('codex', CODEX_LIVE)).toBe(true);
    expect(paneHasAgentUi('codex', BASH_IDLE)).toBe(false);
  });
});

describe('isShellCommand / isAgentCommand', () => {
  test('登录 shell 的前导 - 、大小写、全路径都要规范化掉', () => {
    expect(isShellCommand('bash')).toBe(true);
    expect(isShellCommand('-bash')).toBe(true);
    expect(isShellCommand('/bin/ZSH')).toBe(true);
    expect(isShellCommand('fish')).toBe(true);
  });

  test('非 shell 一律 false（unknown 由调用方处理，不当 shell 杀）', () => {
    expect(isShellCommand('claude')).toBe(false);
    expect(isShellCommand('vim')).toBe(false);
    expect(isShellCommand('su')).toBe(false); // 刻意不收：说不清就别动
    expect(isShellCommand('')).toBe(false);
    expect(isShellCommand(null)).toBe(false);
    expect(isShellCommand(undefined)).toBe(false);
  });

  test('代理命令表只用于正向确认', () => {
    expect(isAgentCommand('claude')).toBe(true);
    expect(isAgentCommand('codex')).toBe(true);
    expect(isAgentCommand('node')).toBe(true);
    expect(isAgentCommand('bash')).toBe(false);
    expect(isAgentCommand('vim')).toBe(false);
  });
});

describe('judgeAgentLiveness：有 pane_current_command（主判）', () => {
  test('前台是 bash + 屏面是提示符 → shell', () => {
    expect(judgeAgentLiveness({ agent: 'claude', paneCommand: 'bash', pane: CLAUDE_EXITED })).toBe('shell');
    expect(judgeAgentLiveness({ agent: 'claude', paneCommand: 'bash', pane: BASH_AFTER_INJECT })).toBe('shell');
    expect(judgeAgentLiveness({ agent: 'codex', paneCommand: 'bash', pane: CODEX_UPDATED_OUT })).toBe('shell');
    expect(judgeAgentLiveness({ agent: 'claude', paneCommand: 'zsh', pane: MAC_STARSHIP_IDLE })).toBe('shell');
  });

  test('前台是 bash 但屏没给（抓屏失败）→ 仍判 shell（主判够硬）', () => {
    expect(judgeAgentLiveness({ agent: 'claude', paneCommand: 'bash' })).toBe('shell');
  });

  test('前台是代理 → live（屏面是啥都不推翻主判）', () => {
    expect(judgeAgentLiveness({ agent: 'claude', paneCommand: 'claude', pane: CLAUDE_LIVE })).toBe('live');
    expect(judgeAgentLiveness({ agent: 'codex', paneCommand: 'codex', pane: CODEX_LIVE })).toBe('live');
    // 代理正在跑 Bash 工具时前台仍是 claude（子进程不在窗格前台进程组），屏上出现提示符也不误判
    expect(judgeAgentLiveness({ agent: 'claude', paneCommand: 'claude', pane: BASH_IDLE })).toBe('live');
  });

  test('信号打架（前台 bash，屏面却是完整代理 UI 且不以提示符收尾）→ unknown，不动', () => {
    expect(judgeAgentLiveness({ agent: 'claude', paneCommand: 'bash', pane: CLAUDE_LIVE })).toBe('unknown');
    expect(judgeAgentLiveness({ agent: 'codex', paneCommand: 'bash', pane: CODEX_LIVE })).toBe('unknown');
  });

  test('前台是别的命令（vim/git/未知）→ unknown', () => {
    expect(judgeAgentLiveness({ agent: 'claude', paneCommand: 'vim', pane: CLAUDE_EXITED })).toBe('unknown');
    expect(judgeAgentLiveness({ agent: 'claude', paneCommand: 'git', pane: BASH_IDLE })).toBe('unknown');
  });
});

describe('judgeAgentLiveness：无 pane_current_command（退化成只看屏）', () => {
  test('提示符收尾 + 无代理 UI → shell', () => {
    expect(judgeAgentLiveness({ agent: 'claude', pane: CLAUDE_EXITED })).toBe('shell');
    expect(judgeAgentLiveness({ agent: 'claude', pane: BASH_AFTER_INJECT })).toBe('shell');
  });

  test('codex 的「Please restart Codex」是硬证据（横幅还在也算）', () => {
    expect(judgeAgentLiveness({ agent: 'codex', pane: CODEX_UPDATED_OUT })).toBe('shell');
    // 同一屏对 claude 无此判据，且屏上有 ╭─ → 不敢判 shell
    expect(judgeAgentLiveness({ agent: 'claude', pane: CODEX_UPDATED_OUT })).toBe('unknown');
  });

  test('只有代理 UI 特征 → live', () => {
    expect(judgeAgentLiveness({ agent: 'claude', pane: CLAUDE_LIVE })).toBe('live');
    expect(judgeAgentLiveness({ agent: 'codex', pane: CODEX_LIVE })).toBe('live');
  });

  test('空屏 / 抓屏失败 / 说不清 → unknown', () => {
    expect(judgeAgentLiveness({ agent: 'claude' })).toBe('unknown');
    expect(judgeAgentLiveness({ agent: 'claude', pane: '' })).toBe('unknown');
    expect(judgeAgentLiveness({ agent: 'claude', pane: '   \n\n' })).toBe('unknown');
    expect(judgeAgentLiveness({ agent: 'claude', pane: '正在编译…' })).toBe('unknown');
    // 提示符收尾但屏上还留着代理 UI（上一帧没清干净）→ 证据打架，不动
    expect(judgeAgentLiveness({ agent: 'claude', pane: `${CLAUDE_LIVE}\n[root@VM p]#` })).toBe('unknown');
  });
});

describe('judgeAgentLiveness：判死硬闸 quietMs（2026-07-27 生产误杀事故）', () => {
  test('会话文件最近还在长 → 一律 live，屏幕和前台命令都不算数', () => {
    // 事故现场：代理在跑前台 Bash 工具，命令输出把 UI 刷没了、前台命令是 bash，但它活得好好的
    const paneDuringTool = '  PASS  src/foo.test.ts\n[root@VM repo]#';
    expect(
      judgeAgentLiveness({ agent: 'claude', paneCommand: 'bash', pane: paneDuringTool, quietMs: 24_000 }),
    ).toBe('live');
    expect(judgeAgentLiveness({ agent: 'claude', paneCommand: 'bash', quietMs: 0 })).toBe('live');
  });

  test('沉默够久才回到原判据（真死了照样判死）', () => {
    expect(
      judgeAgentLiveness({ agent: 'claude', paneCommand: 'bash', pane: CLAUDE_EXITED, quietMs: 61_000 }),
    ).toBe('shell');
    // 不传 quietMs（拿不到会话文件）→ 退回原判据，不因此变宽松
    expect(judgeAgentLiveness({ agent: 'claude', paneCommand: 'bash', pane: CLAUDE_EXITED })).toBe('shell');
  });
});

describe('shouldProbeLiveness（健康路径零额外 tmux 调用）', () => {
  test('屏面是代理 UI 且不以提示符收尾 → 不探', () => {
    expect(shouldProbeLiveness('claude', CLAUDE_LIVE)).toBe(false);
    expect(shouldProbeLiveness('codex', CODEX_LIVE)).toBe(false);
  });

  test('提示符收尾、无 UI 特征、空屏 → 都要探一次', () => {
    expect(shouldProbeLiveness('claude', CLAUDE_EXITED)).toBe(true);
    expect(shouldProbeLiveness('claude', BASH_IDLE)).toBe(true);
    expect(shouldProbeLiveness('codex', CODEX_UPDATED_OUT)).toBe(true);
    expect(shouldProbeLiveness('claude', '')).toBe(true);
    expect(shouldProbeLiveness('claude', MAC_STARSHIP_IDLE)).toBe(true);
    // 代理 UI 在、但末行是提示符（可能刚退出）→ 也要探
    expect(shouldProbeLiveness('claude', `${CLAUDE_LIVE}\n[root@VM p]#`)).toBe(true);
  });
});
