/**
 * executor/local 单测：
 * - I5：runCommand 超时 reject 明确错误（sleep 卡死子进程不冻结调用方）；git 默认限时不误伤。
 * - I6：tmuxNewSessionArgs 单一来源带 -x 220 -y 50（LocalDriver/SshDriver 共用，防 M5 地雷回归）。
 * - openPty winsize（gated：本机 script/stty 可用）：初始尺寸写入 pty 内核 + 运行中 resize 生效
 *   （防「web 终端只占左上一角 80×24」回归——tmux 读 ioctl 尺寸，环境变量无效）。
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_TMUX_TIMEOUT_MS,
  tmuxNewSessionArgs,
  tmuxResizeWindowArgs,
  TMUX_WIN_COLS,
  TMUX_WIN_ROWS,
} from './driver';
import { LocalDriver, ptySpawnSpec, runCommand, sttyResizeArgs } from './local';

describe('I5 本地命令超时', () => {
  test('findExecutable 只从 PATH 探测固定 Agent 命令', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler2-agent-path-'));
    const previous = process.env.PATH;
    try {
      const claude = path.join(dir, 'claude');
      await fsp.writeFile(claude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.PATH = dir;
      const driver = new LocalDriver();
      expect(await driver.findExecutable('claude')).toBe(claude);
      expect(await driver.findExecutable('codex')).toBeNull();
      await expect(driver.findExecutable('bash' as never)).rejects.toThrow(/Agent/);
    } finally {
      process.env.PATH = previous;
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('runCommand：sleep 5 撞 200ms 超时 → reject 明确错误', async () => {
    const t0 = Date.now();
    await expect(runCommand('sleep', ['5'], undefined, 200)).rejects.toThrow(/超时/);
    expect(Date.now() - t0).toBeLessThan(3000); // 没等满 5s
  });

  test('runCommand：限时内正常返回 {code,out}；非零退出不 reject', async () => {
    const ok = await runCommand('echo', ['hi'], undefined, 5000);
    expect(ok.code).toBe(0);
    expect(ok.out.trim()).toBe('hi');
    const fail = await runCommand('false', [], undefined, 5000);
    expect(fail.code).not.toBe(0);
  });

  test('LocalDriver.git 带默认 60s 限时仍正常工作（真 git）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler2-local-'));
    try {
      const d = new LocalDriver();
      expect((await d.git(dir, ['init', '-q'])).code).toBe(0);
      expect((await d.git(dir, ['status', '--porcelain'])).code).toBe(0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('默认超时常量：tmux 类 10s / git 类 60s（可经构造参数覆盖）', () => {
    expect(DEFAULT_TMUX_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_GIT_TIMEOUT_MS).toBe(60_000);
    // 构造参数可覆盖（编译期契约；运行行为由 runCommand 超时测试覆盖）
    void new LocalDriver({ tmuxTimeoutMs: 1000, gitTimeoutMs: 2000 });
  });

  test('movePath：跨平台最终路径语义——整目录改址成功，dst 已存在时抛错', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler2-local-mv-'));
    try {
      const d = new LocalDriver();
      await fsp.mkdir(path.join(dir, 'src/sub'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'src/sub/a.txt'), 'hi');
      // 正常迁移：内容随目录整体走
      await d.movePath(path.join(dir, 'src'), path.join(dir, 'dst'));
      expect(await fsp.readFile(path.join(dir, 'dst/sub/a.txt'), 'utf8')).toBe('hi');
      await expect(fsp.stat(path.join(dir, 'src'))).rejects.toThrow();
      // dst 已存在 → 抛错不吞，不做系统 mv 的「移入目录」推断。
      await fsp.mkdir(path.join(dir, 'occupied'));
      await fsp.writeFile(path.join(dir, 'occupied/x.txt'), 'x');
      await expect(d.movePath(path.join(dir, 'dst'), path.join(dir, 'occupied'))).rejects.toThrow(
        /mv 失败/,
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('LocalDriver.listSessions', () => {
  test('使用可打印分隔符并右锚定解析，cwd 含冒号也不破坏会话名', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler2-tmux-path-'));
    const previous = process.env.PATH;
    try {
      const tmux = path.join(dir, 'tmux');
      await fsp.writeFile(
        tmux,
        [
          '#!/bin/sh',
          `test "$3" = '#{session_name}:#{session_created}:#{session_attached}:#{pane_current_command}:#{pane_current_path}' || exit 7`,
          `printf '%s\\n' 'cc-1-console:1785422639:0:zsh:/tmp/project:v1' 'cc-2:1785422823:1:codex:/tmp/p2'`,
        ].join('\n'),
        { mode: 0o755 },
      );
      process.env.PATH = dir;
      expect(await new LocalDriver().listSessions()).toEqual([
        {
          name: 'cc-1-console',
          createdTs: 1785422639,
          attached: false,
          command: 'zsh',
          cwd: '/tmp/project:v1',
        },
        {
          name: 'cc-2',
          createdTs: 1785422823,
          attached: true,
          command: 'codex',
          cwd: '/tmp/p2',
        },
      ]);
    } finally {
      process.env.PATH = previous;
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('本地 PTY 跨平台命令参数', () => {
  test('Linux 使用 util-linux script，macOS 使用 expect 从 pipe 创建 PTY', () => {
    expect(ptySpawnSpec('echo ok', 100, 40, 'linux')).toEqual({
      command: 'script',
      args: ['-qefc', 'echo ok', '/dev/null'],
      extraEnv: {},
    });
    const mac = ptySpawnSpec('echo ok', 100, 40, 'darwin');
    expect(mac.command).toBe('/usr/bin/expect');
    expect(mac.args[0]).toBe('-c');
    expect(mac.args[1]).toContain('spawn -noecho /bin/sh -c');
    expect(mac.extraEnv).toEqual({
      BUTLER_PTY_COMMAND: 'echo ok',
      BUTLER_PTY_COLS: '100',
      BUTLER_PTY_ROWS: '40',
    });
  });

  test('stty：Linux 用 -F，macOS 用 -f 指定 pty 设备', () => {
    expect(sttyResizeArgs('/dev/pts/3', 100, 40, 'linux')).toEqual([
      '-F',
      '/dev/pts/3',
      'cols',
      '100',
      'rows',
      '40',
    ]);
    expect(sttyResizeArgs('/dev/ttys003', 100, 40, 'darwin')).toEqual([
      '-f',
      '/dev/ttys003',
      'cols',
      '100',
      'rows',
      '40',
    ]);
  });
});

describe('I6 建会话尺寸单一来源', () => {
  test('tmuxNewSessionArgs 带 -x 220 -y 50 + 锁 manual + 显式 resize（Local/Ssh 两实现共用本函数）', () => {
    // issue #95：只给 -x/-y 不够——window-size 默认 latest 会让新会话生在「服务器上最近
    // 使用的客户端」尺寸上（有人开着终端页时实测生成 114×26），故必须锁 manual 再 resize。
    expect(tmuxNewSessionArgs('s1', '/tmp/工作 目录')).toEqual([
      'new-session', '-d', '-s', 's1', '-c', '/tmp/工作 目录', '-x', '220', '-y', '50',
      ';', 'set-window-option', '-t', 's1', 'window-size', 'manual',
      ';', 'resize-window', '-t', 's1', '-x', '220', '-y', '50',
    ]);
  });

  test('tmuxResizeWindowArgs：给尺寸=resize-window（顺带 manual）；null=交还客户端定尺', () => {
    expect(tmuxResizeWindowArgs('s1', { cols: TMUX_WIN_COLS, rows: TMUX_WIN_ROWS })).toEqual([
      'resize-window', '-t', 's1', '-x', '220', '-y', '50',
    ]);
    expect(tmuxResizeWindowArgs('s1', null)).toEqual([
      'set-window-option', '-t', 's1', 'window-size', 'latest',
    ]);
  });
});

// ---------- openPty 真实 winsize（gated：需本机 script/stty） ----------

const ptyBackendOk =
  process.platform === 'darwin' ? Bun.which('expect') !== null : Bun.which('script') !== null;
const sttyOk = Bun.which('stty') !== null;
if (!ptyBackendOk || !sttyOk) {
  console.log('[local.test] skip openPty winsize 测试：本机 PTY backend/stty 不可用');
}

/** 收集 pty 输出直到出现 pattern 或超时（pty 回显带 \r 等控制符，只做包含匹配） */
function collectUntil(
  pty: { onData(cb: (c: Uint8Array) => void): void },
  pattern: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const dec = new TextDecoder();
    const t = setTimeout(
      () => reject(new Error(`等待 "${pattern}" 超时，已收到: ${JSON.stringify(buf.slice(-200))}`)),
      timeoutMs,
    );
    pty.onData((c) => {
      buf += dec.decode(c, { stream: true });
      if (buf.includes(pattern)) {
        clearTimeout(t);
        resolve(buf);
      }
    });
  });
}

describe.if(ptyBackendOk && sttyOk)('openPty winsize（真 pty）', () => {
  test('初始 cols/rows 写入 pty 内核（stty size 读到的就是请求尺寸，不是 0×0/80×24）', async () => {
    const d = new LocalDriver();
    const pty = await d.openPty(`sh -c 'sleep 0.1; stty size'`, 91, 33);
    try {
      // stty size 输出 "rows cols"
      await collectUntil(pty, '33 91', 5000);
    } finally {
      pty.close();
    }
  }, 10_000);

  test('运行中 resize → 外部 stty -F 改 winsize 生效（第二次 stty size 读到新尺寸）', async () => {
    const d = new LocalDriver();
    const pty = await d.openPty(`sh -c 'sleep 0.1; stty size; sleep 2; stty size'`, 80, 24);
    try {
      const first = collectUntil(pty, '24 80', 5000);
      const second = collectUntil(pty, '40 100', 9000);
      await first;
      pty.resize(100, 40);
      await second;
    } finally {
      pty.close();
    }
  }, 15_000);
});
