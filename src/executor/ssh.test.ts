/**
 * SshDriver 测试三层：
 * 1. 纯函数单测：shq 转义边界（空格/引号/中文/换行/$）、sanitizeSendText（v1 语义）、
 *    白名单、send-keys 命令构造（原子性/防注入）。
 * 2. mock ssh2 行为测试：exec 编解码、SFTP 短读循环、断线重连自愈、在途调用报错、close 终态。
 * 3. gated 集成测试：`ssh -o BatchMode=yes localhost true` 可用则对 localhost 跑真 tmux
 *    全接口回环（建会话→注入→capture→读写文件→git→pty→杀会话），不可用则 skip。
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { ExecStreamLike, SftpDirEntryLike, SftpLike, SftpStatsLike, SshClientLike } from './conn';
import { ENSURE_GIT_SCRIPT, KEY_WHITELIST } from './driver';
import { shq } from './shq';
import {
  buildSendKeyCmd,
  buildSendTextCmd,
  sanitizeSendText,
  SSH_ALLOWED_KEYS,
  SSH_MAX_INJECT_CHARS,
  SshDriver,
} from './ssh';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ==================== 1. 纯函数 ====================

describe('shq 转义', () => {
  const cases: Array<[string, string]> = [
    ['空格', 'a b  c'],
    ['单引号', "it's a 'quoted' arg"],
    ['双引号', 'say "hi"'],
    ['中文', '中文 路径/文件 名'],
    ['换行', 'line1\nline2\n'],
    ['美元与反引号', 'echo $HOME `id` $(whoami)'],
    ['反斜杠', 'a\\b\\\\c'],
    ['空串', ''],
    ['前导横线', '-rf /'],
    ['分号与管道', 'x; rm -rf / | cat && echo y'],
    ['tmux 键名同形', 'Enter'],
    ['大杂烩', `'"$\`\\ 中文\n\t; & | > < ( ) * ? ~ !`],
  ];
  for (const [label, input] of cases) {
    it(`经真实 shell 往返不变: ${label}`, () => {
      // 用本机 bash 验证：printf %s <shq(input)> 输出必须逐字节等于 input
      const out = execFileSync('bash', ['-c', `printf %s ${shq(input)}`], { encoding: 'utf8' });
      expect(out).toBe(input);
    });
  }

  it('单引号转义形态正确', () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`);
    expect(shq('plain')).toBe(`'plain'`);
  });
});

describe('sanitizeSendText（v1 injector.ts:27 语义）', () => {
  it('换行→空格（承重设计：防多行逐行提交）', () => {
    expect(sanitizeSendText('a\nb\r\nc')).toBe('a b  c');
  });
  it('tab 与其余 C0/DEL 控制符→空格', () => {
    expect(sanitizeSendText('a\tb\x00c\x1bd\x7fe')).toBe('a b c d e');
  });
  it('普通字符（中文/$/引号）原样保留', () => {
    expect(sanitizeSendText(`中文 $HOME 'q' "w"`)).toBe(`中文 $HOME 'q' "w"`);
  });
  it('截断常量 = v1 的 2000', () => {
    expect(SSH_MAX_INJECT_CHARS).toBe(2000);
    expect(sanitizeSendText('x'.repeat(2500))).toHaveLength(2000);
  });
});

describe('runCommand（#279 门禁执行入口）', () => {
  it('argv 逐段 shq 后拼成一条命令行，注入字符全成字面量', async () => {
    const { driver, clients } = mkDriver({
      onExec: tmuxStub([[/^cd /, { out: 'ok\n' }]]),
    });
    const r = await driver.runCommand('/ws/demo', ['bun', 'run', 'typecheck'], 5000);
    expect(r).toMatchObject({ code: 0, out: 'ok\n', timedOut: false });
    expect(clients[0]!.execCalls[0]!.cmd).toBe("cd '/ws/demo' && 'bun' 'run' 'typecheck'");

    // 想借参数串第二条命令：转义之后整段都是字面量，拼不出来
    await driver.runCommand('/ws/demo', ['bun', 'test; rm -rf /'], 5000);
    expect(clients[0]!.execCalls[1]!.cmd).toBe(`cd '/ws/demo' && 'bun' 'test; rm -rf /'`);
    await driver.close();
  });

  it('非零退出照常返回，不抛错', async () => {
    const { driver } = mkDriver({ onExec: tmuxStub([[/^cd /, { code: 1, err: '3 fail\n' }]]) });
    const r = await driver.runCommand('/ws/demo', ['bun', 'test'], 5000);
    expect(r.code).toBe(1);
    expect(r.err).toContain('3 fail');
    expect(r.timedOut).toBe(false);
    await driver.close();
  });

  it('超时不抛错，按 timedOut 返回（门禁跑挂是常态，抛错只会多一层 catch）', async () => {
    const { driver } = mkDriver({ onExec: () => { /* 永不响应 */ } });
    const r = await driver.runCommand('/ws/demo', ['bun', 'test'], 30);
    expect(r).toMatchObject({ timedOut: true, code: -1 });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    await driver.close();
  });

  it('空 argv 直接拒绝', async () => {
    const { driver } = mkDriver({ onExec: tmuxStub([]) });
    await expect(driver.runCommand('/ws/demo', [], 5000)).rejects.toThrow(/至少一个命令词/);
    await driver.close();
  });
});

describe('SSH_ALLOWED_KEYS 白名单', () => {
  it('包含 v1 全部 21 键（评审裁定，别删减）', () => {
    const v1 = [
      'Enter', 'Escape', 'Tab', 'Space', 'BSpace',
      'Up', 'Down', 'Left', 'Right',
      'Home', 'End', 'PageUp', 'PageDown',
      'C-c', 'C-d', 'C-z', 'C-u', 'C-a', 'C-e', 'C-l', 'C-r',
    ];
    expect(v1).toHaveLength(21);
    for (const k of v1) expect(SSH_ALLOWED_KEYS.has(k)).toBe(true);
  });
  it('是骨架 KEY_WHITELIST 的超集（契约兼容，只增不减）', () => {
    for (const k of KEY_WHITELIST) expect(SSH_ALLOWED_KEYS.has(k)).toBe(true);
  });
  it('白名单外拒绝', () => {
    for (const k of ['C-b', 'M-x', 'F12', 'rm -rf /', '']) {
      expect(SSH_ALLOWED_KEYS.has(k)).toBe(false);
    }
  });
});

describe('send-keys 命令构造', () => {
  it('文本命令只做字面量注入，Enter 由稳定提交时序单独发送', () => {
    const cmd = buildSendTextCmd('cc-a b', 'hello 世界');
    expect(cmd).toBe(`tmux send-keys -t 'cc-a b' -l -- 'hello 世界'`);
    expect(cmd.match(/send-keys/g)).toHaveLength(1);
    expect(cmd).not.toContain('Enter');
  });
  it('恶意文本留在引号内，不成为 shell 语法', () => {
    const evil = `'; rm -rf / #`;
    const cmd = buildSendTextCmd('s', evil);
    const out = execFileSync('bash', ['-c', `printf '%s\\n' ${cmd.slice('tmux '.length)}`], {
      encoding: 'utf8',
    });
    const words = out.split('\n');
    expect(words.slice(0, 5)).toEqual(['send-keys', '-t', 's', '-l', '--']);
    expect(words[5]).toBe(evil);
  });
  it('sendKey 命令构造（键名语义，无 -l）', () => {
    expect(buildSendKeyCmd('s1', 'C-c')).toBe(`tmux send-keys -t 's1' 'C-c'`);
  });
});

// ==================== 2. mock ssh2 行为测试 ====================

type AnyCb = (...args: any[]) => void;

class Emitter {
  private m = new Map<string, AnyCb[]>();
  on(ev: string, cb: AnyCb): this {
    const arr = this.m.get(ev) ?? [];
    arr.push(cb);
    this.m.set(ev, arr);
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const cb of this.m.get(ev) ?? []) cb(...args);
  }
}

class MockStream extends Emitter implements ExecStreamLike {
  stderr = new Emitter();
  written: Array<string | Uint8Array> = [];
  windows: number[][] = [];
  closedByUser = false;
  write(d: string | Uint8Array): void {
    this.written.push(d);
  }
  setWindow(rows: number, cols: number, h: number, w: number): void {
    this.windows.push([rows, cols, h, w]);
  }
  close(): void {
    this.closedByUser = true;
  }
}

/** 让 mock stream 像真 exec channel 一样回吐结果并关闭。 */
function respond(stream: MockStream, r: { code?: number; out?: string | Uint8Array; err?: string }): void {
  queueMicrotask(() => {
    if (r.out) stream.emit('data', typeof r.out === 'string' ? Buffer.from(r.out, 'utf8') : Buffer.from(r.out));
    if (r.err) stream.stderr.emit('data', Buffer.from(r.err, 'utf8'));
    stream.emit('exit', r.code ?? 0);
    stream.emit('close', r.code ?? 0);
  });
}

interface MockBehavior {
  /** 'ready' 正常连上；'error' 拨号失败；默认 'ready' */
  connect?: 'ready' | 'error';
  /** exec 到达时驱动 stream（默认什么都不做=挂起） */
  onExec?: (cmd: string, opts: Record<string, unknown>, stream: MockStream) => void;
  sftp?: SftpLike;
}

class MockClient extends Emitter implements SshClientLike {
  execCalls: Array<{ cmd: string; opts: Record<string, unknown> }> = [];
  streams: MockStream[] = [];
  connectCalls = 0;
  ended = false;
  constructor(private behavior: MockBehavior) {
    super();
  }
  connect(_cfg: Record<string, unknown>): void {
    this.connectCalls++;
    queueMicrotask(() => {
      if ((this.behavior.connect ?? 'ready') === 'ready') this.emit('ready');
      else {
        this.emit('error', new Error('mock 拨号失败'));
        this.emit('close');
      }
    });
  }
  end(): void {
    this.ended = true;
    queueMicrotask(() => this.emit('close'));
  }
  exec(cmd: string, opts: Record<string, unknown>, cb: (err: Error | undefined, stream: ExecStreamLike) => void): void {
    this.execCalls.push({ cmd, opts });
    const stream = new MockStream();
    this.streams.push(stream);
    queueMicrotask(() => {
      cb(undefined, stream);
      this.behavior.onExec?.(cmd, opts, stream);
    });
  }
  sftp(cb: (err: Error | undefined, sftp: SftpLike) => void): void {
    queueMicrotask(() => cb(undefined, this.behavior.sftp as SftpLike));
  }
  /** 模拟连接意外断开：所有在途 stream 无退出码关闭 + client close */
  dropConnection(): void {
    for (const s of this.streams) s.emit('close');
    this.emit('close');
  }
}

function mkStats(size: number, mode = 0o100644, mtime = 1_700_000_000): SftpStatsLike {
  return {
    size,
    mtime,
    mode,
    isDirectory: () => (mode & 0o170000) === 0o040000,
    isFile: () => (mode & 0o170000) === 0o100000,
  };
}

/** 内存 SFTP：可设 maxChunk 强制短读。 */
class MockSftp implements SftpLike {
  files = new Map<string, Buffer>();
  modes = new Map<string, number>();
  chmodCalls: Array<[string, number]> = [];
  maxChunk = Number.POSITIVE_INFINITY;
  readCalls = 0;

  open(path: string, _flags: string, cb: (err: Error | null | undefined, handle: unknown) => void): void {
    if (_flags === 'wx' && !this.files.has(path) && !this.modes.has(path)) {
      this.files.set(path, Buffer.alloc(0));
      this.modes.set(path, 0o100644);
      cb(null, { path });
      return;
    }
    if (!this.files.has(path)) {
      cb(Object.assign(new Error(`No such file ${path}`), { code: 2 }), null);
      return;
    }
    cb(null, { path });
  }
  fstat(handle: unknown, cb: (err: Error | null | undefined, stats: SftpStatsLike) => void): void {
    const { path } = handle as { path: string };
    cb(null, mkStats(this.files.get(path)!.length, this.modes.get(path) ?? 0o100644));
  }
  read(
    handle: unknown,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | null | undefined, bytesRead: number) => void,
  ): void {
    this.readCalls++;
    const { path } = handle as { path: string };
    const data = this.files.get(path)!;
    const n = Math.min(length, this.maxChunk, Math.max(0, data.length - position));
    if (n <= 0) {
      // 模拟 ssh2 对 EOF 的两种表现之一：带 code=1 的错误
      cb(Object.assign(new Error('EOF'), { code: 1 }), 0);
      return;
    }
    data.copy(buffer, offset, position, position + n);
    cb(null, n);
  }
  write(
    handle: unknown,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | null | undefined) => void,
  ): void {
    const { path } = handle as { path: string };
    const prior = this.files.get(path) ?? Buffer.alloc(0);
    const next = Buffer.alloc(Math.max(prior.length, position + length));
    prior.copy(next);
    buffer.copy(next, position, offset, offset + length);
    this.files.set(path, next);
    cb(null);
  }
  close(_handle: unknown, cb: (err: Error | null | undefined) => void): void {
    cb(null);
  }
  stat(path: string, cb: (err: Error | null | undefined, stats: SftpStatsLike) => void): void {
    if (!this.files.has(path) && !this.modes.has(path)) {
      cb(Object.assign(new Error(`No such file ${path}`), { code: 2 }), mkStats(0));
      return;
    }
    cb(null, mkStats(this.files.get(path)?.length ?? 0, this.modes.get(path) ?? 0o100644));
  }
  lstat(path: string, cb: (err: Error | null | undefined, stats: SftpStatsLike) => void): void {
    this.stat(path, cb);
  }
  mkdir(path: string, attrs: { mode?: number }, cb: (err: Error | null | undefined) => void): void {
    if (this.files.has(path) || this.modes.has(path)) {
      cb(new Error('exists'));
      return;
    }
    this.modes.set(path, 0o040000 | (attrs.mode ?? 0o755));
    cb(null);
  }
  readdir(_path: string, cb: (err: Error | null | undefined, list: SftpDirEntryLike[]) => void): void {
    cb(null, [
      { filename: 'f.txt', attrs: { mode: 0o100644 } },
      { filename: 'sub', attrs: { mode: 0o040755 } },
      { filename: 'ln', attrs: { mode: 0o120777 } },
      { filename: 'sock', attrs: { mode: 0o140666 } },
    ]);
  }
  writeFile(path: string, data: Buffer, options: { mode?: number }, cb: (err: Error | null | undefined) => void): void {
    this.files.set(path, Buffer.from(data));
    if (options.mode !== undefined) this.modes.set(path, 0o100000 | options.mode);
    cb(null);
  }
  chmod(path: string, mode: number, cb: (err: Error | null | undefined) => void): void {
    this.chmodCalls.push([path, mode]);
    this.modes.set(path, 0o100000 | mode);
    cb(null);
  }
}

/** 造一个接 mock 客户端的 driver。factory 每次拨号被调用一次（重连会造新 client）。 */
function mkDriver(behaviors: MockBehavior[] | MockBehavior) {
  const list = Array.isArray(behaviors) ? behaviors : [behaviors];
  const clients: MockClient[] = [];
  const driver = new SshDriver({
    host: 'mock',
    port: 22,
    username: 'u',
    privateKeyPath: '/dev/null', // dial 会读它；/dev/null 可读即可
    injectSleep: async () => {},
    baseBackoffMs: 5,
    maxBackoffMs: 20,
    clientFactory: () => {
      const b = list[Math.min(clients.length, list.length - 1)]!;
      const c = new MockClient(b);
      clients.push(c);
      return c;
    },
  });
  return { driver, clients };
}

/** 标准 tmux/命令桩：按命令前缀回结果。 */
function tmuxStub(table: Array<[RegExp, { code?: number; out?: string; err?: string }]>) {
  return (cmd: string, _opts: Record<string, unknown>, stream: MockStream) => {
    for (const [re, r] of table) {
      if (re.test(cmd)) {
        respond(stream, r);
        return;
      }
    }
    respond(stream, { code: 127, err: `mock: 未知命令 ${cmd}` });
  };
}

describe('SshDriver（mock ssh2）', () => {
  it('findExecutable 只执行固定 command -v -- claude/codex', async () => {
    const { driver, clients } = mkDriver({
      onExec: tmuxStub([
        [/^command '-v' '--' 'claude'$/, { out: '/usr/local/bin/claude\n' }],
        [/^command '-v' '--' 'codex'$/, { code: 1 }],
      ]),
    });
    expect(await driver.findExecutable('claude')).toBe('/usr/local/bin/claude');
    expect(await driver.findExecutable('codex')).toBeNull();
    expect(clients[0]!.execCalls.map((x) => x.cmd)).toEqual([
      "command '-v' '--' 'claude'",
      "command '-v' '--' 'codex'",
      '"${SHELL:-/bin/sh}" -lic \'command -v -- codex\' 2>/dev/null',
    ]);
    await expect(driver.findExecutable('bash' as never)).rejects.toThrow(/Agent/);
    await driver.close();
  });

  it('findExecutable 在 SSH 非登录 PATH 缺失时回退执行机用户登录 shell', async () => {
    const { driver, clients } = mkDriver({
      onExec: tmuxStub([
        [/^command '-v' '--' 'codex'$/, { code: 1 }],
        [/^"\$\{SHELL:-\/bin\/sh\}" -lic 'command -v -- codex' 2>\/dev\/null$/, {
          out: 'login banner\n/home/u/.local/bin/codex\n',
        }],
      ]),
    });
    expect(await driver.findExecutable('codex')).toBe('/home/u/.local/bin/codex');
    expect(clients[0]!.execCalls.map((x) => x.cmd)).toEqual([
      "command '-v' '--' 'codex'",
      '"${SHELL:-/bin/sh}" -lic \'command -v -- codex\' 2>/dev/null',
    ]);
    await driver.close();
  });

  it('findExecutable 忽略登录 shell 横幅、别名和相对命令结果', async () => {
    const { driver } = mkDriver({
      onExec: tmuxStub([
        [/^command '-v' '--' 'claude'$/, { code: 1 }],
        [/^"\$\{SHELL:-\/bin\/sh\}" -lic/, { out: 'welcome\nclaude\nalias claude=wrapper\n' }],
      ]),
    });
    expect(await driver.findExecutable('claude')).toBeNull();
    await driver.close();
  });

  it('listSessions 解析 tmux 输出（:分隔，path 末位贪婪可含冒号）；server 未启动(code!=0)返回 []', async () => {
    const { driver } = mkDriver({
      onExec: tmuxStub([
        [
          /list-sessions/,
          { out: 'alpha:1700000000:1:claude:/root/ws:v1\nbeta:1700000001:0::\n坏行不炸\n' },
        ],
      ]),
    });
    expect(await driver.listSessions()).toEqual([
      { name: 'alpha', createdTs: 1700000000, attached: true, command: 'claude', cwd: '/root/ws:v1' },
      { name: 'beta', createdTs: 1700000001, attached: false },
    ]);
    await driver.close();

    const { driver: d2 } = mkDriver({
      onExec: tmuxStub([[/list-sessions/, { code: 1, err: 'no server running' }]]),
    });
    expect(await d2.listSessions()).toEqual([]);
    await d2.close();
  });

  it('sendKeys：净化 + 稳定抓屏 + 响应后不重复 Enter', async () => {
    let pane = '› 空输入框';
    let enters = 0;
    const { driver, clients } = mkDriver({
      onExec: (cmd, _opts, stream) => {
        if (cmd.includes("'capture-pane'")) respond(stream, { out: pane });
        else if (cmd.includes(' -l -- ')) { pane = '› line1 line2 tail'; respond(stream, {}); }
        else if (cmd.endsWith("'Enter'")) { enters++; pane = '• Working'; respond(stream, {}); }
        else respond(stream, { code: 127, err: `unexpected ${cmd}` });
      },
    });
    await driver.sendKeys('cc-main', 'line1\nline2\ttail');
    expect(clients).toHaveLength(1);
    expect(clients[0]!.execCalls.some((call) => call.cmd ===
      buildSendTextCmd('cc-main', sanitizeSendText('line1\nline2\ttail')))).toBe(true);
    expect(enters).toBe(1);
    await driver.close();
  });

  it('sendKey：白名单外直接抛错且不产生任何 exec；白名单键正常发送', async () => {
    const { driver, clients } = mkDriver({ onExec: (_c, _o, s) => respond(s, { code: 0 }) });
    await expect(driver.sendKey('s', 'C-b')).rejects.toThrow('白名单');
    expect(clients).toHaveLength(0); // 白名单校验在连接之前
    await driver.sendKey('s', 'C-z'); // v1 独有键，骨架名单没有
    expect(clients[0]!.execCalls[0]!.cmd).toBe(buildSendKeyCmd('s', 'C-z'));
    await driver.close();
  });

  it('scrollPane：Local/SSH 共用原子 copy-mode 命令，连续上下滚动各只占一次 exec', async () => {
    const { driver, clients } = mkDriver({ onExec: (_c, _o, s) => respond(s, { code: 0 }) });
    await driver.scrollPane('cc-main', 'up', 3);
    await driver.scrollPane('cc-main', 'down', 4);
    expect(clients[0]!.execCalls.map((call) => call.cmd)).toEqual([
      `tmux 'if-shell' '-t' 'cc-main' '-F' '#{pane_in_mode}'` +
        ` 'send-keys -X -N 3 scroll-up' 'copy-mode -e; send-keys -X -N 3 scroll-up'`,
      `tmux 'if-shell' '-t' 'cc-main' '-F' '#{pane_in_mode}'` +
        ` 'send-keys -X -N 4 scroll-down' ''`,
    ]);
    await driver.close();
  });

  it('createSession 带显式尺寸 -x 220 -y 50；失败抛错；capturePane 回原文', async () => {
    const { driver, clients } = mkDriver({
      onExec: tmuxStub([
        [/new-session/, { code: 0 }],
        [/capture-pane/, { out: 'PANE\nCONTENT' }],
        [/kill-session/, { code: 1, err: `can't find session` }],
      ]),
    });
    await driver.createSession('t1', '/tmp/回归 目录');
    const cmd = clients[0]!.execCalls[0]!.cmd;
    // issue #95：建会话顺带锁 window-size manual + 显式 resize（默认 latest 会让新会话
    // 生在「最近使用的客户端」尺寸上）。分号是 tmux 的命令分隔符，shq 引号不影响 argv 语义。
    expect(cmd).toBe(
      `tmux 'new-session' '-d' '-s' 't1' '-c' '/tmp/回归 目录' '-x' '220' '-y' '50'` +
        ` ';' 'set-window-option' '-t' 't1' 'window-size' 'manual'` +
        ` ';' 'set-window-option' '-t' 't1' 'alternate-screen' 'off'` +
        ` ';' 'resize-window' '-t' 't1' '-x' '220' '-y' '50'`,
    );
    expect(await driver.capturePane('t1')).toBe('PANE\nCONTENT');
    await expect(driver.killSession('nope')).rejects.toThrow('kill-session');
    await driver.close();
  });

  it('git：非零退出不抛错，返回 {code,out,err}；命令带 -C 与严格转义', async () => {
    const { driver, clients } = mkDriver({
      onExec: tmuxStub([[/^git /, { code: 128, err: 'fatal: not a git repository' }]]),
    });
    const r = await driver.git(`/tmp/a'b`, ['status', '--porcelain']);
    expect(r.code).toBe(128);
    expect(r.err).toContain('not a git repository');
    expect(clients[0]!.execCalls[0]!.cmd).toBe(`git '-C' '/tmp/a'\\''b' 'status' '--porcelain'`);
    await driver.close();
  });

  it('ensureGitAvailable：执行固定脚本，并把安装权限失败转换为明确错误', async () => {
    const { driver, clients } = mkDriver({
      onExec: tmuxStub([[/^\/bin\/sh /, { code: 126, err: 'PANDA_GIT_NO_PRIVILEGE' }]]),
    });
    await expect(driver.ensureGitAvailable()).rejects.toThrow('没有免密 sudo');
    expect(clients[0]!.execCalls[0]!.cmd).toBe(`/bin/sh '-c' ${shq(ENSURE_GIT_SCRIPT)}`);
    await driver.close();
  });

  it('readGitBlob：stdout 按原始字节返回，rev/path 仍严格转义', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const { driver, clients } = mkDriver({
      onExec: (_cmd, _opts, stream) => respond(stream, { out: bytes }),
    });
    const r = await driver.readGitBlob(`/tmp/a'b`, 'abc123', `图 片/a'b.png`);
    expect(r.code).toBe(0);
    expect(r.data).toEqual(bytes);
    expect(clients[0]!.execCalls[0]!.cmd).toBe(
      `git '-C' '/tmp/a'\\''b' 'cat-file' 'blob' 'abc123:图 片/a'\\''b.png'`,
    );
    await driver.close();
  });

  it('readFileRange：SFTP 短读（每次最多 3 字节）循环读满，size=文件总字节数', async () => {
    const sftp = new MockSftp();
    const content = Buffer.from('0123456789中文尾巴', 'utf8');
    sftp.files.set('/log/x.jsonl', content);
    sftp.maxChunk = 3; // 强制短读
    const { driver } = mkDriver({ sftp });

    const r = await driver.readFileRange('/log/x.jsonl', 4, 100);
    expect(Buffer.from(r.data).toString('utf8')).toBe(content.subarray(4).toString('utf8'));
    expect(r.size).toBe(content.length);
    expect(sftp.readCalls).toBeGreaterThan(1); // 确实分了多次读

    // offset 超过文件尾：空数据但 size 正常（tail 轮转检测依赖）
    const r2 = await driver.readFileRange('/log/x.jsonl', content.length + 10, 8);
    expect(r2.data.length).toBe(0);
    expect(r2.size).toBe(content.length);
    await driver.close();
  });

  it('readFileNoFollowWithin checks each SFTP component and rejects symlinks', async () => {
    const sftp = new MockSftp();
    sftp.modes.set('/project/personas', 0o040755);
    sftp.modes.set('/project/personas/reviewer', 0o040755);
    sftp.files.set('/project/personas/reviewer/PERSONA.md', Buffer.from('persona'));
    const { driver } = mkDriver({ sftp });
    const read = await driver.readFileNoFollowWithin('/project/personas', 'reviewer/PERSONA.md', 4);
    expect(Buffer.from(read.data).toString()).toBe('pers');
    expect(read.size).toBe(7);
    sftp.modes.set('/project/personas/reviewer', 0o120777);
    await expect(driver.readFileNoFollowWithin('/project/personas', 'reviewer/PERSONA.md', 20))
      .rejects.toThrow(/rejects links/);
    await driver.close();
  });

  it('writeFileNoFollowWithin creates safely, is idempotent, conflicts, and rejects remote links', async () => {
    const sftp = new MockSftp();
    sftp.modes.set('/project', 0o040755);
    const { driver } = mkDriver({ sftp });
    expect(await driver.writeFileNoFollowWithin(
      '/project', '.panda/personas/reviewer/PERSONA.md', 'canonical',
    )).toBe('created');
    expect(await driver.writeFileNoFollowWithin(
      '/project', '.panda/personas/reviewer/PERSONA.md', 'canonical',
    )).toBe('unchanged');
    expect(await driver.writeFileNoFollowWithin(
      '/project', '.panda/personas/reviewer/PERSONA.md', 'different',
    )).toBe('conflict');
    sftp.modes.set('/project/.panda/personas/link', 0o120777);
    await expect(driver.writeFileNoFollowWithin(
      '/project', '.panda/personas/link/PERSONA.md', 'x',
    )).rejects.toThrow(/rejects links/);
    await driver.close();
  });

  it('statPath：存在回 PathStat（mtime 秒→毫秒、mode 掩码），不存在回 null', async () => {
    const sftp = new MockSftp();
    sftp.files.set('/e/f', Buffer.from('abc'));
    sftp.modes.set('/e/f', 0o100600);
    const { driver } = mkDriver({ sftp });
    const st = await driver.statPath('/e/f');
    expect(st).toEqual({
      size: 3,
      mtimeMs: 1_700_000_000_000,
      isDirectory: false,
      isFile: true,
      mode: 0o600,
    });
    expect(await driver.statPath('/e/missing')).toBeNull();
    await driver.close();
  });

  it('listDir：SFTP attrs.mode → 类型映射', async () => {
    const { driver } = mkDriver({ sftp: new MockSftp() });
    expect(await driver.listDir('/any')).toEqual([
      { name: 'f.txt', type: 'file' },
      { name: 'sub', type: 'dir' },
      { name: 'ln', type: 'symlink' },
      { name: 'sock', type: 'other' },
    ]);
    await driver.close();
  });

  it('writeFile：先 mkdir -p 父目录（exec）再 SFTP 写；mode 时补 chmod', async () => {
    const sftp = new MockSftp();
    const { driver, clients } = mkDriver({
      sftp,
      onExec: tmuxStub([[/^mkdir /, { code: 0 }]]),
    });
    await driver.writeFile('/data/深/层/f.png', new Uint8Array([1, 2, 3]), 0o600);
    expect(clients[0]!.execCalls[0]!.cmd).toBe(`mkdir '-p' '/data/深/层'`);
    expect([...sftp.files.get('/data/深/层/f.png')!]).toEqual([1, 2, 3]);
    expect(sftp.chmodCalls).toEqual([['/data/深/层/f.png', 0o600]]);
    await driver.close();
  });

  it('openPty：pty 选项携带 term/cols/rows；resize 走 setWindow；close 前收数据、关时回调 exit', async () => {
    const { driver, clients } = mkDriver({ onExec: () => {} });
    const pty = await driver.openPty('tmux attach -t x', 100, 30);
    const c = clients[0]!;
    expect(c.execCalls[0]!.cmd).toBe('tmux attach -t x');
    expect(c.execCalls[0]!.opts.pty).toEqual({
      term: 'xterm-256color', cols: 100, rows: 30, height: 0, width: 0,
    });

    const got: string[] = [];
    let exitFired = false;
    let exitCode: number | null = -999;
    pty.onData((ch) => got.push(Buffer.from(ch).toString('utf8')));
    pty.onExit((code) => {
      exitFired = true;
      exitCode = code;
    });

    const stream = c.streams[0]!;
    stream.emit('data', Buffer.from('hello'));
    pty.write('ls\r');
    pty.resize(80, 24);
    expect(stream.written).toEqual(['ls\r']);
    expect(stream.windows).toEqual([[24, 80, 0, 0]]);

    stream.emit('exit', 0);
    stream.emit('close');
    expect(got.join('')).toBe('hello');
    expect(exitFired).toBe(true);
    expect(exitCode).toBe(0);
    pty.close();
    expect(stream.closedByUser).toBe(true);
    await driver.close();
  });

  it('断线：在途调用报错、退避后自动重连自愈、退避连上即重置', async () => {
    const behavior: MockBehavior = { onExec: tmuxStub([[/capture-pane/, { out: 'ok' }]]) };
    const { driver, clients } = mkDriver(behavior);

    expect(driver.status).toBe('disconnected');
    expect(await driver.capturePane('s')).toBe('ok');
    expect(driver.status).toBe('connected');

    // 挂一个不回结果的在途调用，然后拔线
    behavior.onExec = () => {};
    const inflight = driver.capturePane('s');
    await sleep(5);
    clients[0]!.dropConnection();
    await expect(inflight).rejects.toThrow('无退出码');
    expect(driver.status).toBe('disconnected');

    // 不发起任何调用，等退避定时器自愈（base 5ms）
    behavior.onExec = tmuxStub([[/capture-pane/, { out: 'healed' }]]);
    await sleep(40);
    expect(driver.status).toBe('connected');
    expect(clients.length).toBe(2); // 自动造了第二条连接
    expect(await driver.capturePane('s')).toBe('healed');
    await driver.close();
  });

  it('拨号失败：调用方拿到错误；退避重连（5→10→20 封顶）最终成功', async () => {
    const { driver, clients } = mkDriver([
      { connect: 'error' },
      { connect: 'error' },
      { connect: 'ready', onExec: tmuxStub([[/capture-pane/, { out: 'up' }]]) },
    ]);
    await expect(driver.capturePane('s')).rejects.toThrow('mock 拨号失败');
    expect(driver.status).toBe('disconnected');
    await sleep(60); // 覆盖 5ms + 10ms 两轮退避
    expect(clients.length).toBeGreaterThanOrEqual(3);
    expect(driver.status).toBe('connected');
    expect(await driver.capturePane('s')).toBe('up');
    await driver.close();
    expect(driver.status).toBe('closed');
  });

  it('close 是终态：调用报错、不再重连', async () => {
    const { driver, clients } = mkDriver({ onExec: tmuxStub([[/capture-pane/, { out: 'ok' }]]) });
    await driver.capturePane('s');
    await driver.close();
    expect(driver.status).toBe('closed');
    await expect(driver.capturePane('s')).rejects.toThrow('已关闭');
    const n = clients.length;
    await sleep(40);
    expect(clients.length).toBe(n); // 没有自愈拨号
  });
});

// ==================== 3. gated 集成测试（localhost 真 ssh + 真 tmux） ====================

const probe = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', 'localhost', 'true']);
const keyPath = [join(homedir(), '.ssh', 'id_ed25519'), join(homedir(), '.ssh', 'id_rsa')].find((p) =>
  existsSync(p),
);
const sshOk = probe.status === 0 && !!keyPath;
const itSsh = sshOk ? it : it.skip;
if (!sshOk) {
  console.log('[ssh.test] skip 集成测试：ssh localhost 不可用（BatchMode 探测失败或无本机私钥）');
}

describe('SshDriver 集成（localhost 回环）', () => {
  itSsh(
    '全接口回环：文件读写/短读循环/目录/建会话/注入/capture/git/pty/杀会话',
    async () => {
      const rand = Math.random().toString(36).slice(2, 8);
      const tmp = `/tmp/panda-sshdrv-${rand}`;
      const session = `bt2-sshdrv-${rand}`;
      const driver = new SshDriver({
        host: 'localhost',
        port: 22,
        username: userInfo().username,
        privateKeyPath: keyPath!,
      });
      try {
        // ---- writeFile + statPath + readFileRange ----
        const text = `第一行 'quote' $HOME\n第二行\n`;
        await driver.writeFile(`${tmp}/深 层/a.txt`, text, 0o600);
        const st = await driver.statPath(`${tmp}/深 层/a.txt`);
        expect(st).not.toBeNull();
        expect(st!.isFile).toBe(true);
        expect(st!.mode).toBe(0o600);
        expect(st!.size).toBe(Buffer.byteLength(text));
        expect(Math.abs(st!.mtimeMs - (await driver.executorNowMs()))).toBeLessThan(60_000);
        expect(await driver.statPath(`${tmp}/不存在`)).toBeNull();

        const full = await driver.readFileRange(`${tmp}/深 层/a.txt`, 0, 65536);
        expect(Buffer.from(full.data).toString('utf8')).toBe(text);
        expect(full.size).toBe(Buffer.byteLength(text));
        const part = await driver.readFileRange(`${tmp}/深 层/a.txt`, 3, 6);
        expect(Buffer.from(part.data)).toEqual(Buffer.from(text, 'utf8').subarray(3, 9));

        // 大文件（400KB > sftp 单包上限）验证短读循环真的读满
        const big = Buffer.alloc(400_000);
        for (let i = 0; i < big.length; i++) big[i] = i % 251;
        await driver.writeFile(`${tmp}/big.bin`, big);
        const rBig = await driver.readFileRange(`${tmp}/big.bin`, 1000, big.length);
        expect(rBig.data.length).toBe(big.length - 1000);
        expect(Buffer.from(rBig.data).equals(big.subarray(1000))).toBe(true);
        expect(rBig.size).toBe(big.length);

        const entries = await driver.listDir(tmp);
        expect(entries.find((e) => e.name === 'big.bin')?.type).toBe('file');
        expect(entries.find((e) => e.name === '深 层')?.type).toBe('dir');

        // ---- git（确定性操作走 Driver）----
        expect((await driver.git(tmp, ['init', '-q'])).code).toBe(0);
        expect((await driver.git(tmp, ['status', '--porcelain'])).code).toBe(0);
        const blobBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
        await driver.writeFile(`${tmp}/blob.png`, blobBytes);
        await driver.git(tmp, ['add', 'blob.png']);
        await driver.git(tmp, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'blob']);
        const blob = await driver.readGitBlob(tmp, 'HEAD', 'blob.png');
        expect(Buffer.from(blob.data)).toEqual(blobBytes);
        const bad = await driver.git('/tmp/绝不存在的目录xx', ['status']);
        expect(bad.code).not.toBe(0); // 非零不抛错

        // ---- tmux 会话 + 注入 + capture ----
        await driver.createSession(session, tmp);
        const listed = await driver.listSessions();
        expect(listed.map((s) => s.name)).toContain(session);
        await sleep(500); // 等 shell 起来

        // 注入带引号/中文/$ 的命令：输出 Q1Q2 与输入行可区分，验证 shq→-l 全链路保真
        await driver.sendKeys(session, `echo 'Q1'"Q2"_中文_$((40+2))`);
        let cap = '';
        for (let i = 0; i < 20; i++) {
          await sleep(300);
          cap = await driver.capturePane(session);
          if (cap.includes('Q1Q2_中文_42')) break;
        }
        expect(cap).toContain('Q1Q2_中文_42');

        await driver.sendKey(session, 'C-l'); // 白名单键真发一次
        await expect(driver.sendKey(session, 'C-b')).rejects.toThrow('白名单');

        // ---- openPty（真 PTY + resize 不炸）----
        const pty = await driver.openPty(`sh -c 'echo PTY_OK_${rand}; sleep 0.3'`, 90, 28);
        const chunks: string[] = [];
        const exited = new Promise<number | null>((resolve) => pty.onExit(resolve));
        pty.onData((c) => chunks.push(Buffer.from(c).toString('utf8')));
        pty.resize(120, 40);
        const exitCode = await exited;
        expect(chunks.join('')).toContain(`PTY_OK_${rand}`);
        expect(exitCode).toBe(0);

        // ---- 杀会话 ----
        await driver.killSession(session);
        expect((await driver.listSessions()).map((s) => s.name)).not.toContain(session);
        await expect(driver.killSession(session)).rejects.toThrow('kill-session');

        expect(driver.status).toBe('connected');
      } finally {
        spawnSync('tmux', ['kill-session', '-t', session]); // 兜底清理（失败无所谓）
        await fsp.rm(tmp, { recursive: true, force: true }); // localhost=本机，直接清
        await driver.close();
      }
    },
    30_000,
  );
});
