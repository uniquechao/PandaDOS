/**
 * executor/local —— LocalDriver：在控制面本机直接执行 tmux/fs/git。
 * 双重身份：单测/集成测试的替身 + 验证 ExecutorDriver 接口设计是否落得下来。
 * 一切子进程走 node:child_process；文件走 node:fs/promises。
 */
import { execFile, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentKind } from '../core/types';
import {
  type DirEntry,
  type ExecutorDriver,
  type FileRange,
  type GitResult,
  type PathStat,
  type PtyChannel,
  type TmuxSession,
  assertRemovablePath,
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_TMUX_TIMEOUT_MS,
  INJECT_ENTER_DELAY_MS,
  KEY_WHITELIST,
  sanitizeInjectText,
  tmuxNewSessionArgs,
  tmuxResizeWindowArgs,
} from './driver';

interface ExecResult {
  code: number;
  out: string;
  err: string;
}

/**
 * 跑一条本地命令（I5：带超时）。正常/非零退出都 resolve {code,out,err}；
 * 超时（execFile timeout 触发 kill）→ reject 明确错误——卡死的子进程不许冻结调用方。
 * （export 供单测直接验证超时语义。）
 */
export function runCommand(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        ...(timeoutMs && timeoutMs > 0 ? { timeout: timeoutMs, killSignal: 'SIGKILL' as const } : {}),
      },
      (error, stdout, stderr) => {
        if (error && (error as { killed?: boolean }).killed) {
          reject(
            new Error(`本地命令超时（>${timeoutMs}ms）被终止: ${cmd} ${args.join(' ').slice(0, 120)}`),
          );
          return;
        }
        let code = 0;
        if (error) {
          const c = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          code = typeof c === 'number' ? c : 1;
        }
        resolve({ code, out: stdout ?? '', err: stderr ?? '' });
      },
    );
  });
}

export interface LocalDriverOpts {
  /** tmux/capture 类短命令超时（I5；默认 DEFAULT_TMUX_TIMEOUT_MS=10s） */
  tmuxTimeoutMs?: number;
  /** git 类命令超时（I5；默认 DEFAULT_GIT_TIMEOUT_MS=60s） */
  gitTimeoutMs?: number;
}

export interface PtySpawnSpec {
  command: string;
  args: string[];
  extraEnv: NodeJS.ProcessEnv;
}

/**
 * launchd 启动的 macOS 服务通常没有 locale；tmux 会把这种客户端视为非 UTF-8，
 * attach 输出中的中文等宽字符因而被替换成 `_`。只在完全没有有效 locale 时兜底，
 * 不覆盖部署环境显式提供的 LC_ALL / LC_CTYPE / LANG。
 */
export function ptySpawnEnv(
  extraEnv: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const hasLocale = [baseEnv.LC_ALL, baseEnv.LC_CTYPE, baseEnv.LANG, extraEnv.LC_ALL, extraEnv.LC_CTYPE, extraEnv.LANG]
    .some((value) => typeof value === 'string' && value.trim().length > 0);
  return {
    ...baseEnv,
    ...(platform === 'darwin' && !hasLocale ? { LANG: 'en_US.UTF-8' } : {}),
    TERM: 'xterm-256color',
    ...extraEnv,
  };
}

const EXPECT_PTY_PROGRAM = [
  'set stty_init "rows $env(MANDO_PTY_ROWS) columns $env(MANDO_PTY_COLS)"',
  'spawn -noecho /bin/sh -c $env(MANDO_PTY_COMMAND)',
  'interact',
].join('; ');

/**
 * macOS 的 BSD script 要求自身 stdin 已是 TTY，无法桥接服务端 pipe；改用系统自带
 * expect 创建 PTY。Linux 的 util-linux script 支持 pipe，保留原实现。
 */
export function ptySpawnSpec(
  inner: string,
  cols: number,
  rows: number,
  platform: NodeJS.Platform = process.platform,
): PtySpawnSpec {
  return platform === 'darwin'
    ? {
        command: '/usr/bin/expect',
        args: ['-c', EXPECT_PTY_PROGRAM],
        extraEnv: {
          MANDO_PTY_COMMAND: inner,
          MANDO_PTY_COLS: String(cols),
          MANDO_PTY_ROWS: String(rows),
        },
      }
    : {
        command: 'script',
        args: ['-qefc', inner, '/dev/null'],
        extraEnv: {},
      };
}

/** GNU stty 用 -F 指定设备，BSD/macOS 用 -f。 */
export function sttyResizeArgs(
  device: string,
  cols: number,
  rows: number,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [platform === 'linux' ? '-F' : '-f', device, 'cols', String(cols), 'rows', String(rows)];
}

export class LocalDriver implements ExecutorDriver {
  private readonly tmuxTimeoutMs: number;
  private readonly gitTimeoutMs: number;

  constructor(opts: LocalDriverOpts = {}) {
    this.tmuxTimeoutMs = opts.tmuxTimeoutMs ?? DEFAULT_TMUX_TIMEOUT_MS;
    this.gitTimeoutMs = opts.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  }

  /** 全部 tmux 子命令入口（统一限时） */
  private tmux(args: string[]): Promise<ExecResult> {
    return runCommand('tmux', args, undefined, this.tmuxTimeoutMs);
  }

  async findExecutable(agent: AgentKind): Promise<string | null> {
    if (agent !== 'claude' && agent !== 'codex') throw new Error('不支持的 Agent 命令');
    return Bun.which(agent, { PATH: process.env.PATH ?? '' });
  }

  // ---- tmux ----

  async listSessions(): Promise<TmuxSession[]> {
    // tmux 会在部分非交互输出环境中把格式串里的控制字符（如 tab）净化成 `_`；
    // 用可打印的 `:` 分隔，且把唯一可能含 `:` 的 cwd 放末位贪婪解析。
    const r = await this.tmux([
      'list-sessions',
      '-F',
      '#{session_name}:#{session_created}:#{session_attached}:#{pane_current_command}:#{pane_current_path}',
    ]);
    // tmux server 未启动 → exit 1，视为无会话
    if (r.code !== 0) return [];
    const out: TmuxSession[] = [];
    for (const l of r.out.split('\n')) {
      if (l.trim().length === 0) continue;
      const m = /^([^:]*):(\d+):(\d+):([^:]*):(.*)$/.exec(l);
      if (!m) continue;
      out.push({
        name: m[1]!,
        createdTs: Number.parseInt(m[2]!, 10) || 0,
        attached: Number.parseInt(m[3]!, 10) > 0,
        ...(m[4] ? { command: m[4] } : {}),
        ...(m[5] ? { cwd: m[5] } : {}),
      });
    }
    return out;
  }

  /** 建会话：尺寸参数与 SshDriver 同源（tmuxNewSessionArgs，I6 防 80×24 腰斩 CC 菜单回归） */
  async createSession(name: string, cwd: string): Promise<void> {
    const r = await this.tmux(tmuxNewSessionArgs(name, cwd));
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.err || r.out}`);
  }

  async killSession(name: string): Promise<void> {
    const r = await this.tmux(['kill-session', '-t', name]);
    if (r.code !== 0) throw new Error(`tmux kill-session failed: ${r.err || r.out}`);
  }

  async sendKeys(session: string, text: string): Promise<void> {
    const clean = sanitizeInjectText(text);
    const r1 = await this.tmux(['send-keys', '-t', session, '-l', '--', clean]);
    if (r1.code !== 0) throw new Error(`tmux send-keys failed: ${r1.err || r1.out}`);
    // 文本与 Enter 之间必须停一拍：codex TUI 有 paste-burst 检测，紧跟注入的 Enter
    // 会被并入粘贴当换行（消息滞留输入框不提交，0.144 实测）；CC 不受影响。
    await Bun.sleep(INJECT_ENTER_DELAY_MS);
    const r2 = await this.tmux(['send-keys', '-t', session, 'Enter']);
    if (r2.code !== 0) throw new Error(`tmux send-keys Enter failed: ${r2.err || r2.out}`);
  }

  async sendKey(session: string, key: string): Promise<void> {
    if (!KEY_WHITELIST.has(key)) throw new Error(`key not in whitelist: ${key}`);
    const r = await this.tmux(['send-keys', '-t', session, key]);
    if (r.code !== 0) throw new Error(`tmux send-keys failed: ${r.err || r.out}`);
  }

  async capturePane(session: string): Promise<string> {
    const r = await this.tmux(['capture-pane', '-p', '-t', session]);
    if (r.code !== 0) throw new Error(`tmux capture-pane failed: ${r.err || r.out}`);
    return r.out;
  }

  /** 窗口定尺/交还（issue #95）：失败不抛——尺寸是观感与解析质量问题，不该拖垮终端页开关 */
  async resizeWindow(session: string, size: { cols: number; rows: number } | null): Promise<void> {
    await this.tmux(tmuxResizeWindowArgs(session, size));
  }

  // ---- 文件 ----

  async readFileRange(path: string, offset: number, limit: number): Promise<FileRange> {
    const fh = await fsp.open(path, 'r');
    try {
      const st = await fh.stat();
      const size = st.size;
      const len = Math.max(0, Math.min(limit, size - offset));
      const buf = Buffer.alloc(len);
      if (len > 0) await fh.read(buf, 0, len, offset);
      return { data: new Uint8Array(buf.buffer, buf.byteOffset, len), size };
    } finally {
      await fh.close();
    }
  }

  async statPath(path: string): Promise<PathStat | null> {
    try {
      const st = await fsp.stat(path);
      return {
        size: st.size,
        mtimeMs: st.mtimeMs,
        isDirectory: st.isDirectory(),
        isFile: st.isFile(),
        mode: st.mode & 0o7777,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const entries = await fsp.readdir(path, { withFileTypes: true });
    return entries.map((d) => ({
      name: d.name,
      type: d.isFile() ? 'file' : d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'other',
    }));
  }

  async writeFile(path: string, data: Uint8Array | string, mode?: number): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(path, data, mode !== undefined ? { mode } : {});
    if (mode !== undefined) await fsp.chmod(path, mode); // 文件已存在时 writeFile 的 mode 不生效
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await fsp.mkdir(dirname(linkPath), { recursive: true });
    await fsp.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string | null> {
    try {
      return await fsp.readlink(path);
    } catch {
      return null; // 不是链接（EINVAL）或不存在（ENOENT）
    }
  }

  async removeTree(path: string): Promise<void> {
    await fsp.rm(assertRemovablePath(path), { recursive: true, force: true });
  }

  async mkdirp(path: string): Promise<void> {
    await fsp.mkdir(path, { recursive: true });
  }

  /**
   * 目标路径就是最终路径，不做「移入目录」推断。
   * 不调用 GNU-only `mv -T`：macOS/BSD mv 没有 -T。优先 rename 保持原子性，
   * 跨文件系统（EXDEV）才 copy+remove；目标已存在一律拒绝。
   */
  async movePath(src: string, dst: string): Promise<void> {
    try {
      await fsp.lstat(dst);
      throw new Error('目标已存在');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`mv 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      await fsp.rename(src, dst);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw new Error(`mv 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        await fsp.cp(src, dst, {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
        });
        await fsp.rm(src, { recursive: true, force: true });
      } catch (copyError) {
        throw new Error(`mv 失败: ${copyError instanceof Error ? copyError.message : String(copyError)}`);
      }
    }
  }

  // ---- git ----

  async git(cwd: string, args: string[]): Promise<GitResult> {
    return runCommand('git', args, cwd, this.gitTimeoutMs);
  }

  // ---- 终端流 ----

  /**
   * 本地 PTY：Linux 借 util-linux script、macOS 借系统 expect 分配真实 pty 跑 cmd。
   * 尺寸必须写进 pty 的内核 winsize（TIOCSWINSZ）：tmux 等全屏程序用 ioctl 读尺寸，
   * COLUMNS/LINES 环境变量对它们无效（script 起的 pty 默认 0×0 → tmux 按 80×24 渲染，
   * web 终端只占左上一角）。做法：pty 内先 `stty cols/rows` 设初始尺寸并把 slave
   * 设备名落到临时文件；运行中 resize 从外部 `stty -F/-f <pts>` 改 winsize，
   * 内核自动向前台进程组发 SIGWINCH（tmux 收到即重绘）。
   */
  async openPty(cmd: string, cols: number, rows: number): Promise<PtyChannel> {
    const c = Number.isFinite(cols) ? Math.max(1, Math.trunc(cols)) : 80;
    const r = Number.isFinite(rows) ? Math.max(1, Math.trunc(rows)) : 24;
    const dir = await fsp.mkdtemp(join(tmpdir(), 'mando-pty-'));
    const ttyFile = join(dir, 'tty');
    const inner = `stty cols ${c} rows ${r} 2>/dev/null; tty > ${ttyFile} 2>/dev/null; exec ${cmd}`;
    const spec = ptySpawnSpec(inner, c, r);
    const child = spawn(spec.command, spec.args, {
      env: ptySpawnEnv(spec.extraEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const dataCbs: Array<(chunk: Uint8Array) => void> = [];
    const exitCbs: Array<(code: number | null) => void> = [];
    const emit = (chunk: Buffer) => {
      const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length);
      for (const cb of dataCbs) cb(u8);
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    const cleanup = (): void => {
      void fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    };
    child.on('exit', (code) => {
      cleanup();
      for (const cb of exitCbs) cb(code);
    });

    // slave 设备名可能晚于首个 resize 帧就绪：短轮询（≤1s），拿到后缓存
    let pts: string | null = null;
    const readPts = async (): Promise<string | null> => {
      if (pts) return pts;
      for (let i = 0; i < 20; i++) {
        const s = (await fsp.readFile(ttyFile, 'utf8').catch(() => '')).trim();
        if (s.startsWith('/dev/')) return (pts = s);
        await new Promise((res) => setTimeout(res, 50));
      }
      return null;
    };
    // resize 串行化：并发 stty 乱序会让「最后生效的尺寸」不可预期
    let resizeChain: Promise<unknown> = Promise.resolve();
    const sttyTimeoutMs = this.tmuxTimeoutMs;

    return {
      write(data: string | Uint8Array): void {
        child.stdin.write(data);
      },
      resize(cols2: number, rows2: number): void {
        const c2 = Number.isFinite(cols2) ? Math.max(1, Math.trunc(cols2)) : c;
        const r2 = Number.isFinite(rows2) ? Math.max(1, Math.trunc(rows2)) : r;
        resizeChain = resizeChain
          .then(readPts)
          .then((p) =>
            p
              ? runCommand('stty', sttyResizeArgs(p, c2, r2), undefined, sttyTimeoutMs)
              : null,
          )
          .catch(() => {});
      },
      onData(cb): void {
        dataCbs.push(cb);
      },
      onExit(cb): void {
        exitCbs.push(cb);
      },
      close(): void {
        child.kill('SIGHUP');
        cleanup();
      },
    };
  }
}
