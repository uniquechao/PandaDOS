/**
 * executor/local 单测：
 * - I5：runCommand 超时 reject 明确错误（sleep 卡死子进程不冻结调用方）；git 默认限时不误伤。
 * - I6：tmuxNewSessionArgs 单一来源带 -x 220 -y 50（LocalDriver/SshDriver 共用，防 M5 地雷回归）。
 * - openPty winsize（gated：本机 script/stty 可用）：初始尺寸写入 pty 内核 + 运行中 resize 生效
 *   （防「web 终端只占左上一角 80×24」回归——tmux 读 ioctl 尺寸，环境变量无效）。
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_TMUX_TIMEOUT_MS,
  tmuxNewSessionArgs,
  tmuxResizeWindowArgs,
  tmuxScrollPaneArgs,
  TMUX_WIN_COLS,
  TMUX_WIN_ROWS,
} from './driver';
import { LocalDriver, ptySpawnEnv, ptySpawnSpec, runCommand, sttyResizeArgs } from './local';

describe('I5 本地命令超时', () => {
  test('findExecutable 只从 PATH 探测固定 Agent 命令', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-agent-path-'));
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
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-local-'));
    try {
      const d = new LocalDriver();
      expect((await d.git(dir, ['init', '-q'])).code).toBe(0);
      expect((await d.git(dir, ['status', '--porcelain'])).code).toBe(0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('LocalDriver.readGitBlob 保留 NUL 与非法 UTF-8 原始字节', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-local-blob-'));
    try {
      const d = new LocalDriver();
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);
      await d.git(dir, ['init', '-q']);
      await fsp.writeFile(path.join(dir, 'x.png'), bytes);
      await d.git(dir, ['add', 'x.png']);
      await d.git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'image']);
      const r = await d.readGitBlob(dir, 'HEAD', 'x.png');
      expect(r.code).toBe(0);
      expect(Buffer.from(r.data)).toEqual(bytes);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('readFileNoFollowWithin bounds reads and rejects root, bundle, and file symlinks', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-local-secure-read-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-local-secure-outside-'));
    try {
      const root = path.join(dir, 'personas');
      await fsp.mkdir(path.join(root, 'safe'), { recursive: true });
      await fsp.writeFile(path.join(root, 'safe/PERSONA.md'), 'abcdef');
      const driver = new LocalDriver();
      const read = await driver.readFileNoFollowWithin(root, 'safe/PERSONA.md', 3);
      expect(Buffer.from(read.data).toString()).toBe('abc');
      expect(read.size).toBe(6);
      await fsp.symlink(outside, path.join(root, 'linked-bundle'));
      await expect(driver.readFileNoFollowWithin(root, 'linked-bundle/PERSONA.md', 10)).rejects.toThrow(/symlink/);
      await fsp.writeFile(path.join(outside, 'PERSONA.md'), 'outside');
      await fsp.symlink(path.join(outside, 'PERSONA.md'), path.join(root, 'safe/LINK.md'));
      await expect(driver.readFileNoFollowWithin(root, 'safe/LINK.md', 10)).rejects.toThrow(/symlink/);
      await fsp.symlink(root, path.join(dir, 'persona-root-link'));
      await expect(driver.readFileNoFollowWithin(path.join(dir, 'persona-root-link'), 'safe/PERSONA.md', 10))
        .rejects.toThrow(/root/);
      await expect(driver.readFileNoFollowWithin(root, '../outside/PERSONA.md', 10)).rejects.toThrow(/unsafe/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  test('writeFileNoFollowWithin is exclusive, idempotent, conflict-safe, and rejects links', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-local-secure-write-'));
    try {
      const driver = new LocalDriver();
      expect(await driver.writeFileNoFollowWithin(
        dir, '.panda/personas/reviewer/PERSONA.md', 'canonical',
      )).toBe('created');
      expect(await driver.writeFileNoFollowWithin(
        dir, '.panda/personas/reviewer/PERSONA.md', 'canonical',
      )).toBe('unchanged');
      expect(await driver.writeFileNoFollowWithin(
        dir, '.panda/personas/reviewer/PERSONA.md', 'different',
      )).toBe('conflict');
      await fsp.symlink(path.join(dir, '.panda/personas/reviewer'), path.join(dir, '.panda/personas/link'));
      await expect(driver.writeFileNoFollowWithin(dir, '.panda/personas/link/PERSONA.md', 'x'))
        .rejects.toThrow(/rejects links/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('design projection primitives list, compare-and-swap, remove, and reject linked parents', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-local-design-files-'));
    try {
      const driver = new LocalDriver();
      await fsp.mkdir(path.join(dir, '.panda/designs/design-1'), { recursive: true });
      await fsp.writeFile(path.join(dir, '.panda/designs/design-1/DESIGN.md'), 'v1');
      expect(await driver.listDirectoryNoFollowWithin(dir, '.panda/designs/design-1')).toEqual([
        { name: 'DESIGN.md', type: 'file' },
      ]);
      const v1 = createHash('sha256').update('v1').digest('hex');
      expect(await driver.replaceFileNoFollowWithin(
        dir, '.panda/designs/design-1/DESIGN.md', new TextEncoder().encode('v2'), v1,
      )).toBe('written');
      expect(await driver.replaceFileNoFollowWithin(
        dir, '.panda/designs/design-1/DESIGN.md', new TextEncoder().encode('v3'), v1,
      )).toBe('conflict');
      const v2 = createHash('sha256').update('v2').digest('hex');
      expect(await driver.removeFileNoFollowWithin(dir, '.panda/designs/design-1/DESIGN.md', v2))
        .toBe('removed');
      await fsp.symlink(path.join(dir, '.panda/designs/design-1'), path.join(dir, '.panda/designs/link'));
      await expect(driver.listDirectoryNoFollowWithin(dir, '.panda/designs/link')).rejects.toThrow(/links/);
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
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-local-mv-'));
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
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-tmux-path-'));
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
  test('macOS launchd 无 locale 时补 UTF-8，已有 locale 配置不被覆盖', () => {
    expect(ptySpawnEnv({ PANDA_PTY_COMMAND: 'echo ok' }, { PATH: '/bin' }, 'darwin')).toEqual({
      PATH: '/bin',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      PANDA_PTY_COMMAND: 'echo ok',
    });

    expect(
      ptySpawnEnv(
        { PANDA_PTY_COMMAND: 'echo ok' },
        { LANG: 'zh_CN.UTF-8', LC_CTYPE: 'UTF-8', TERM: 'screen-256color' },
        'darwin',
      ),
    ).toEqual({
      LANG: 'zh_CN.UTF-8',
      LC_CTYPE: 'UTF-8',
      TERM: 'xterm-256color',
      PANDA_PTY_COMMAND: 'echo ok',
    });

    expect(ptySpawnEnv({}, { LC_ALL: 'C', PATH: '/usr/bin' }, 'darwin')).toEqual({
      LC_ALL: 'C',
      PATH: '/usr/bin',
      TERM: 'xterm-256color',
    });
  });

  test('非 macOS 不自行注入 locale', () => {
    expect(ptySpawnEnv({}, { PATH: '/bin' }, 'linux')).toEqual({
      PATH: '/bin',
      TERM: 'xterm-256color',
    });
  });

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
      PANDA_PTY_COMMAND: 'echo ok',
      PANDA_PTY_COLS: '100',
      PANDA_PTY_ROWS: '40',
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

describe('issue #37 tmux 历史滚动参数', () => {
  test('上滚原子进入 copy-mode，下滚仅在 copy-mode 内执行并可在底部退出', () => {
    expect(tmuxScrollPaneArgs('cc-1-console', 'up', 3)).toEqual([
      'if-shell', '-t', 'cc-1-console', '-F', '#{pane_in_mode}',
      'send-keys -X -N 3 scroll-up',
      'copy-mode -e; send-keys -X -N 3 scroll-up',
    ]);
    expect(tmuxScrollPaneArgs('cc-1-console', 'down', 4)).toEqual([
      'if-shell', '-t', 'cc-1-console', '-F', '#{pane_in_mode}',
      'send-keys -X -N 4 scroll-down',
      '',
    ]);
  });

  test('拒绝无效滚动行数，避免绕过 WebSocket 边界直接放大 tmux 命令', () => {
    for (const lines of [0, -1, 101, 1.5, Number.NaN]) {
      expect(() => tmuxScrollPaneArgs('s1', 'up', lines)).toThrow(/scroll lines/);
    }
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
