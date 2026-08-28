/**
 * executor/ssh —— SshDriver：ExecutorDriver 的生产实现（spec §3 + 评审 5.1 逐条落地）。
 *
 * - ssh2 单持久连接（SshConn），exec / sftp / pty 多路复用共用一条 TCP；
 *   断线指数退避重连（上限 60s），在途调用报错、连接自愈；`status` 暴露连接状态。
 * - 注入净化/白名单/截断常量以 v1 src/injector.ts 为准（集成收敛后 driver.ts 的
 *   sanitizeInjectText 已统一到同一语义，本文件导出保留为别名）。
 * - 每次注入 = 单次 ssh exec 的一条 tmux send-keys（`-l --` 字面量 + 尾部 \r），
 *   文字与回车不拆两条，杜绝 v1「两次调用间可插入并发注入者」的交错窗口（评审 5.1#2）。
 * - readFileRange 走 SFTP 并循环读满（SFTP 协议允许短读，v1 忽略 bytesRead 是已判命门，
 *   评审 [H19]/短读告诫）；返回 {data, size}，size=读取时刻文件总字节数，供调用方推进 offset。
 * - 其余 tmux/git/mkdir 全走 exec，参数一律 shq 严格转义。
 * - openPty：exec channel + PTY 分配（term=xterm-256color），resize 走 channel.setWindow。
 */
import { dirname, isAbsolute, join, normalize } from 'node:path/posix';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentKind } from '../core/types';
import {
  SshConn,
  type ConnStatus,
  type ExecStreamLike,
  type SftpDirEntryLike,
  type SftpLike,
  type SftpStatsLike,
  type SshConnConfig,
} from './conn';
import type {
  DirEntry,
  ExecutorDriver,
  FileRange,
  GitBlobResult,
  GitResult,
  PathStat,
  PtyChannel,
  TmuxScrollDirection,
  TmuxSession,
} from './driver';
import {
  assertRemovablePath,
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_TMUX_TIMEOUT_MS,
  KEY_WHITELIST,
  INJECT_ENTER_DELAY_MS,
  MAX_INJECT_CHARS,
  sanitizeInjectText,
  tmuxNewSessionArgs,
  tmuxResizeWindowArgs,
  tmuxScrollPaneArgs,
} from './driver';
import { shq } from './shq';

export interface SshDriverConfig extends SshConnConfig {
  /** tmux/capture/mkdir 类短命令超时（I5；默认 DEFAULT_TMUX_TIMEOUT_MS=10s） */
  tmuxTimeoutMs?: number;
  /** git 类命令超时（I5；默认 DEFAULT_GIT_TIMEOUT_MS=60s） */
  gitTimeoutMs?: number;
}

// ---------- 注入常量/纯函数（v1 src/injector.ts 逐字平移；评审 3.1「别删减」） ----------

/**
 * sendKey 白名单——I6 收敛后单一来源在 driver.ts KEY_WHITELIST（v1 的 21 键
 * 含 C-z/C-a/C-e/C-r ∪ 骨架 BTab，共 22 键），此处保留导出名作别名，只增不减。
 */
export const SSH_ALLOWED_KEYS: ReadonlySet<string> = KEY_WHITELIST;

/** 单次注入截断常量 = v1 injector.ts:27 的 slice(0, 2000)（= driver.ts MAX_INJECT_CHARS，集成收敛后同源）。 */
export const SSH_MAX_INJECT_CHARS: number = MAX_INJECT_CHARS;

/**
 * 注入净化 = v1 injector.ts:27 逐字语义：`/[\x00-\x1f\x7f]/g → " "` 后截断 2000。
 * 换行→空格（而非保留）是承重设计：tmux 里 \n 等于回车，保留会把多行 prompt 逐行提前提交；
 * v1 uploads.ts:63 已依赖此语义（评审 5.1#2「净化语义原样保留」）。
 * 集成收敛：driver.ts 的 sanitizeInjectText 已统一到本语义，此处保留导出名作别名，
 * LocalDriver / SshDriver 净化行为完全一致。
 */
export const sanitizeSendText: (text: string) => string = sanitizeInjectText;

/**
 * 构造 sendKeys 的远端命令：单次 exec 内「打字 → 停一拍 → 回车」三连（仍无并发交错窗口）。
 * - `-l --`：字面量注入（文本恰好等于 tmux 键名/以 - 开头时不被解释，评审注入侧假设①②）；
 * - 中间 sleep：codex TUI 有 paste-burst 检测，紧跟注入的回车会被并入粘贴当换行
 *   （消息滞留输入框不提交，0.144 实测；与 driver.ts INJECT_ENTER_DELAY_MS 同因）；
 * - Enter 单发（= C-m = 0x0d），不再拼进文本尾部。
 * 净化在调用方完成（cleanText 内已无控制字符）。
 */
export function buildSendKeysCmd(session: string, cleanText: string): string {
  const s = shq(session);
  return `tmux send-keys -t ${s} -l -- ${shq(cleanText)}; sleep ${INJECT_ENTER_DELAY_MS / 1000}; tmux send-keys -t ${s} Enter`;
}

/** 构造 sendKey 的远端命令（键名语义，不带 -l）。白名单校验在调用方。 */
export function buildSendKeyCmd(session: string, key: string): string {
  return `tmux send-keys -t ${shq(session)} ${shq(key)}`;
}

// ---------- SFTP 回调 → Promise 小工具 ----------

function sftpOpen(sftp: SftpLike, path: string, flags: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    sftp.open(path, flags, (err, handle) => (err ? reject(err) : resolve(handle)));
  });
}

function sftpFstat(sftp: SftpLike, handle: unknown): Promise<SftpStatsLike> {
  return new Promise((resolve, reject) => {
    sftp.fstat(handle, (err, st) => (err ? reject(err) : resolve(st)));
  });
}

/** 读一段；EOF（SSH_FX_EOF=1）按 0 字节处理而非报错——短读循环的终止条件。 */
function sftpRead(
  sftp: SftpLike,
  handle: unknown,
  buf: Buffer,
  off: number,
  len: number,
  position: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buf, off, len, position, (err, bytesRead) => {
      if (err) {
        const code = (err as { code?: unknown }).code;
        if (code === 1 || /\bEOF\b/i.test(err.message ?? '')) resolve(0);
        else reject(err);
        return;
      }
      resolve(bytesRead ?? 0);
    });
  });
}

function sftpWrite(
  sftp: SftpLike,
  handle: unknown,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<void> {
  if (typeof sftp.write !== 'function') throw new Error('executor secure write capability unavailable');
  return new Promise((resolve, reject) => {
    sftp.write!(handle, buffer, offset, length, position, (error) => error ? reject(error) : resolve());
  });
}

function sftpMkdir(sftp: SftpLike, path: string): Promise<void> {
  if (typeof sftp.mkdir !== 'function') throw new Error('executor secure write capability unavailable');
  return new Promise((resolve, reject) => {
    sftp.mkdir!(path, { mode: 0o755 }, (error) => error ? reject(error) : resolve());
  });
}

function sftpClose(sftp: SftpLike, handle: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (err) => (err ? reject(err) : resolve()));
  });
}

function sftpStat(sftp: SftpLike, path: string): Promise<SftpStatsLike> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, st) => (err ? reject(err) : resolve(st)));
  });
}

function sftpLstat(sftp: SftpLike, path: string): Promise<SftpStatsLike> {
  if (typeof sftp.lstat !== 'function') throw new Error('executor secure read capability unavailable');
  return new Promise((resolve, reject) => {
    sftp.lstat!(path, (err, st) => (err ? reject(err) : resolve(st)));
  });
}

function sftpReaddir(sftp: SftpLike, path: string): Promise<SftpDirEntryLike[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
  });
}

function sftpWriteFile(sftp: SftpLike, path: string, data: Buffer, options: { mode?: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, data, options, (err) => (err ? reject(err) : resolve()));
  });
}

function sftpChmod(sftp: SftpLike, path: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chmod(path, mode, (err) => (err ? reject(err) : resolve()));
  });
}

function sftpRename(sftp: SftpLike, oldPath: string, newPath: string): Promise<void> {
  if (typeof sftp.rename !== 'function') throw new Error('executor secure replace capability unavailable');
  return new Promise((resolve, reject) => sftp.rename!(oldPath, newPath, (error) => error ? reject(error) : resolve()));
}

function sftpUnlink(sftp: SftpLike, path: string): Promise<void> {
  if (typeof sftp.unlink !== 'function') throw new Error('executor secure remove capability unavailable');
  return new Promise((resolve, reject) => sftp.unlink!(path, (error) => error ? reject(error) : resolve()));
}

/** SFTP「路径不存在」判定：SSH_FX_NO_SUCH_FILE=2（ssh2 err.code），兜底看 message。 */
function isNoSuchFile(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return code === 2 || /no such file/i.test(e.message ?? '');
}

// POSIX 文件类型位（SFTP attrs.mode 按 lstat 语义）
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function typeFromMode(mode: number): DirEntry['type'] {
  const t = mode & S_IFMT;
  if (t === S_IFLNK) return 'symlink';
  if (t === S_IFDIR) return 'dir';
  if (t === S_IFREG) return 'file';
  return 'other';
}

// ---------- SshDriver 本体 ----------

export class SshDriver implements ExecutorDriver {
  private readonly conn: SshConn;
  private readonly tmuxTimeoutMs: number;
  private readonly gitTimeoutMs: number;

  constructor(config: SshDriverConfig) {
    this.conn = new SshConn(config);
    this.tmuxTimeoutMs = config.tmuxTimeoutMs ?? DEFAULT_TMUX_TIMEOUT_MS;
    this.gitTimeoutMs = config.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  }

  /** 连接状态（disconnected/connecting/connected/closed），供执行机健康度上报。 */
  get status(): ConnStatus {
    return this.conn.status;
  }

  /** 主动关闭连接并停止重连（进程退出/执行机下线时调用）。 */
  async close(): Promise<void> {
    this.conn.close();
  }

  /**
   * 执行机当前时间（epoch ms）。评审 5.1#5 时钟纪律：任何「现在 - mtime」判定的
   * 两个操作数必须同机——控制面拿它与 statPath().mtimeMs 做差，不用本机 Date.now()。
   * （接口外附加能力，不在 ExecutorDriver 契约内。）
   */
  async executorNowMs(): Promise<number> {
    const r = await this.exec('date', ['+%s%3N']);
    if (r.code !== 0) throw new Error(`date 失败: ${r.err || r.out}`);
    const n = Number(r.out.trim());
    if (!Number.isFinite(n)) throw new Error(`date 输出异常: ${JSON.stringify(r.out)}`);
    return n;
  }

  /**
   * 在远端执行 cmd + 严格转义的 args（一条 exec channel）。tmux/git/mkdir 都走这里。
   * I5：一律带超时（默认 tmux 档 10s；git 显式传 gitTimeoutMs），卡死命令 reject 不冻结引擎。
   */
  private exec(cmd: string, args: string[], timeoutMs = this.tmuxTimeoutMs): Promise<GitResult> {
    return this.conn.exec([cmd, ...args.map(shq)].join(' '), timeoutMs);
  }

  async findExecutable(agent: AgentKind): Promise<string | null> {
    if (agent !== 'claude' && agent !== 'codex') throw new Error('不支持的 Agent 命令');
    const r = await this.exec('command', ['-v', '--', agent]);
    if (r.code !== 0) return null;
    const found = r.out.trim().split('\n')[0] ?? '';
    return found.startsWith('/') ? found : null;
  }

  // ---- tmux ----

  /**
   * 分隔符用 `:` 而非 \t：tmux 客户端 stdout 非 tty（ssh exec 即如此）时会把输出里的
   * 控制字符净化成 `_`，\t 分隔到手即碎（实测）；而 `:`/`.` 在会话名里会被 tmux 自身
   * 替换成 `_`（session_check_name），因此 `:` 是无碰撞分隔符。解析右锚定防御。
   */
  async listSessions(): Promise<TmuxSession[]> {
    // 会话名/command 不含 `:`（名内会被 tmux 替换成 _，command 是裸词）；
    // 唯一可含 `:` 的 pane 路径放末位贪婪吃下，解析仍无歧义。
    const r = await this.exec('tmux', [
      'list-sessions',
      '-F',
      '#{session_name}:#{session_created}:#{session_attached}:#{pane_current_command}:#{pane_current_path}',
    ]);
    // tmux server 未启动 → 非零退出，视为无会话（与 LocalDriver 语义一致）
    if (r.code !== 0) return [];
    const out: TmuxSession[] = [];
    for (const l of r.out.split('\n')) {
      if (l.trim().length === 0) continue;
      const m = /^([^:]*):(\d+):(\d+):([^:]*):(.*)$/.exec(l);
      if (!m) continue; // 读不懂的行跳过，不让一行坏数据炸掉整个列表
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

  /**
   * 建 detached 会话。显式大终端尺寸 -x 220 -y 50：v1 默认 80×24 会把 CC 长选项
   * 换行腰斩、打断菜单检测（评审 [M5]，5.1#3「建会话显式大终端尺寸」）。
   * 参数与 LocalDriver 同源（driver.ts tmuxNewSessionArgs，I6 收敛）。
   */
  async createSession(name: string, cwd: string): Promise<void> {
    const r = await this.exec('tmux', tmuxNewSessionArgs(name, cwd));
    if (r.code !== 0) throw new Error(`tmux new-session 失败: ${r.err || r.out}`);
  }

  async killSession(name: string): Promise<void> {
    const r = await this.exec('tmux', ['kill-session', '-t', name]);
    if (r.code !== 0) throw new Error(`tmux kill-session 失败: ${r.err || r.out}`);
  }

  /** 注入文本并提交：净化（v1 语义）→ 单次 exec 的一条 send-keys（原子，见 buildSendKeysCmd）。 */
  async sendKeys(session: string, text: string): Promise<void> {
    const clean = sanitizeSendText(text);
    const r = await this.conn.exec(buildSendKeysCmd(session, clean), this.tmuxTimeoutMs);
    if (r.code !== 0) throw new Error(`tmux send-keys 失败: ${r.err || r.out}`);
  }

  async sendKey(session: string, key: string): Promise<void> {
    if (!SSH_ALLOWED_KEYS.has(key)) throw new Error(`键不在白名单: ${key}`);
    const r = await this.conn.exec(buildSendKeyCmd(session, key), this.tmuxTimeoutMs);
    if (r.code !== 0) throw new Error(`tmux send-keys 失败: ${r.err || r.out}`);
  }

  async capturePane(session: string): Promise<string> {
    const r = await this.exec('tmux', ['capture-pane', '-p', '-t', session]);
    if (r.code !== 0) throw new Error(`tmux capture-pane 失败: ${r.err || r.out}`);
    return r.out;
  }

  /** 窗口定尺/交还（issue #95）：与 LocalDriver 同源参数；失败不抛（见 local 同名方法注释） */
  async resizeWindow(session: string, size: { cols: number; rows: number } | null): Promise<void> {
    await this.exec('tmux', tmuxResizeWindowArgs(session, size));
  }

  async scrollPane(session: string, direction: TmuxScrollDirection, lines: number): Promise<void> {
    const r = await this.exec('tmux', tmuxScrollPaneArgs(session, direction, lines));
    if (r.code !== 0) throw new Error(`tmux scroll-pane 失败: ${r.err || r.out}`);
  }

  // ---- 文件（sftp channel）----

  /**
   * 按字节区间读文件（jsonl 增量 tail 唯一入口）。
   * SFTP read 协议上允许短读——循环读满 want 或读到 EOF，按实际读到的字节返回；
   * size 用同一 handle 的 fstat（与读取同一时刻），调用方据此推进 offset。
   */
  async readFileRange(path: string, offset: number, limit: number): Promise<FileRange> {
    const sftp = await this.conn.sftp();
    const handle = await sftpOpen(sftp, path, 'r');
    try {
      const st = await sftpFstat(sftp, handle);
      const size = st.size;
      const want = Math.max(0, Math.min(limit, size - offset));
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const n = await sftpRead(sftp, handle, buf, got, want - got, offset + got);
        if (n <= 0) break; // EOF（如文件在 fstat 后被并发截断）——返回实际读到的
        got += n;
      }
      return { data: new Uint8Array(buf.buffer, buf.byteOffset, got), size };
    } finally {
      await sftpClose(sftp, handle).catch(() => {
        /* 关闭句柄失败不掩盖主结果 */
      });
    }
  }

  /**
   * SFTP has no portable O_NOFOLLOW/openat2 equivalent. We lstat the trusted root and every path
   * component, then fstat the opened file. This rejects persistent links but leaves an honest
   * residual race between the final lstat and open (and between intermediate component checks).
   */
  async readFileNoFollowWithin(root: string, relativePath: string, limit: number): Promise<FileRange> {
    if (!isAbsolute(root) || !Number.isSafeInteger(limit) || limit < 0) {
      throw new Error('invalid secure read arguments');
    }
    const parts = relativePath.split('/');
    if (parts.length === 0 || parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
      throw new Error('unsafe relative path');
    }
    const rootPath = normalize(root);
    const sftp = await this.conn.sftp();
    const rootStat = await sftpLstat(sftp, rootPath);
    if (typeFromMode(rootStat.mode) !== 'dir') throw new Error('secure read root is not a real directory');
    let current = rootPath;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      const st = await sftpLstat(sftp, current);
      const expected = index === parts.length - 1 ? 'file' : 'dir';
      if (typeFromMode(st.mode) !== expected) throw new Error('secure read rejects links and non-regular paths');
    }
    const handle = await sftpOpen(sftp, current, 'r');
    try {
      const st = await sftpFstat(sftp, handle);
      if (typeFromMode(st.mode) !== 'file') throw new Error('secure read target is not a regular file');
      const want = Math.min(limit, st.size);
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const n = await sftpRead(sftp, handle, buf, got, want - got, got);
        if (n <= 0) break;
        got += n;
      }
      return { data: new Uint8Array(buf.buffer, buf.byteOffset, got), size: st.size };
    } finally {
      await sftpClose(sftp, handle).catch(() => {});
    }
  }

  /** SFTP counterpart to LocalDriver's exclusive publish primitive; residual lstat/open TOCTOU remains. */
  async writeFileNoFollowWithin(
    root: string,
    relativePath: string,
    data: Uint8Array | string,
    mode = 0o644,
  ): Promise<'created' | 'unchanged' | 'conflict'> {
    if (!isAbsolute(root)) throw new Error('invalid secure write root');
    const parts = relativePath.split('/');
    if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error('unsafe relative path');
    }
    const rootPath = normalize(root);
    const sftp = await this.conn.sftp();
    const rootStat = await sftpLstat(sftp, rootPath);
    if (typeFromMode(rootStat.mode) !== 'dir') throw new Error('secure write root is not a real directory');
    let current = rootPath;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      let st: SftpStatsLike;
      try {
        st = await sftpLstat(sftp, current);
      } catch (error) {
        if (!isNoSuchFile(error)) throw error;
        await sftpMkdir(sftp, current);
        st = await sftpLstat(sftp, current);
      }
      if (typeFromMode(st.mode) !== 'dir') throw new Error('secure write rejects links and non-directories');
    }
    const target = join(current, parts.at(-1)!);
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
    try {
      const existingStat = await sftpLstat(sftp, target);
      if (typeFromMode(existingStat.mode) !== 'file') throw new Error('secure write rejects links and non-regular files');
      if (existingStat.size !== bytes.length) return 'conflict';
      const handle = await sftpOpen(sftp, target, 'r');
      try {
        const existing = Buffer.alloc(existingStat.size);
        let got = 0;
        while (got < existing.length) {
          const count = await sftpRead(sftp, handle, existing, got, existing.length - got, got);
          if (count <= 0) break;
          got += count;
        }
        return got === bytes.length && existing.equals(bytes) ? 'unchanged' : 'conflict';
      } finally {
        await sftpClose(sftp, handle).catch(() => {});
      }
    } catch (error) {
      if (!isNoSuchFile(error)) throw error;
    }
    const handle = await sftpOpen(sftp, target, 'wx');
    try {
      await sftpWrite(sftp, handle, bytes, 0, bytes.length, 0);
      if (mode !== 0o644) await sftpChmod(sftp, target, mode);
      return 'created';
    } finally {
      await sftpClose(sftp, handle).catch(() => {});
    }
  }

  async listDirectoryNoFollowWithin(root: string, relativePath: string): Promise<DirEntry[] | null> {
    if (!isAbsolute(root)) throw new Error('invalid secure list root');
    const parts = relativePath === '' ? [] : relativePath.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('unsafe relative path');
    const sftp = await this.conn.sftp();
    let current = normalize(root);
    try {
      const rootStat = await sftpLstat(sftp, current);
      if (typeFromMode(rootStat.mode) !== 'dir') throw new Error('secure list root is not a real directory');
      for (const part of parts) {
        current = join(current, part);
        if (typeFromMode((await sftpLstat(sftp, current)).mode) !== 'dir') {
          throw new Error('secure list rejects links and non-directories');
        }
      }
      return (await sftpReaddir(sftp, current)).map((entry) => ({
        name: entry.filename,
        type: typeFromMode(entry.attrs.mode),
      }));
    } catch (error) {
      if (isNoSuchFile(error)) return null;
      throw error;
    }
  }

  async replaceFileNoFollowWithin(
    root: string,
    relativePath: string,
    data: Uint8Array,
    expectedSha256: string | null,
  ): Promise<'written' | 'unchanged' | 'conflict'> {
    if (expectedSha256 === null) {
      const result = await this.writeFileNoFollowWithin(root, relativePath, data);
      return result === 'created' ? 'written' : result;
    }
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('invalid expected digest');
    const first = await this.readFileNoFollowWithin(root, relativePath, 100 * 1024 * 1024).catch((error) => {
      if (isNoSuchFile(error)) return null;
      throw error;
    });
    if (!first || first.data.byteLength !== first.size) return 'conflict';
    if (createHash('sha256').update(first.data).digest('hex') !== expectedSha256) return 'conflict';
    if (Buffer.from(data).equals(Buffer.from(first.data))) return 'unchanged';
    const parts = relativePath.split('/');
    const tempRelative = [...parts.slice(0, -1), `.${parts.at(-1)!}.panda-${randomUUID()}.tmp`].join('/');
    const created = await this.writeFileNoFollowWithin(root, tempRelative, data);
    if (created === 'conflict') return 'conflict';
    const target = join(normalize(root), relativePath);
    const temp = join(normalize(root), tempRelative);
    try {
      const latest = await this.readFileNoFollowWithin(root, relativePath, 100 * 1024 * 1024).catch(() => null);
      if (!latest || latest.data.byteLength !== latest.size
        || createHash('sha256').update(latest.data).digest('hex') !== expectedSha256) return 'conflict';
      await sftpRename(await this.conn.sftp(), temp, target);
      return 'written';
    } finally { await sftpUnlink(await this.conn.sftp(), temp).catch(() => {}); }
  }

  async removeFileNoFollowWithin(
    root: string,
    relativePath: string,
    expectedSha256: string,
  ): Promise<'removed' | 'missing' | 'conflict'> {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('invalid expected digest');
    const current = await this.readFileNoFollowWithin(root, relativePath, 100 * 1024 * 1024).catch((error) => {
      if (isNoSuchFile(error)) return null;
      throw error;
    });
    if (!current) return 'missing';
    if (current.data.byteLength !== current.size
      || createHash('sha256').update(current.data).digest('hex') !== expectedSha256) return 'conflict';
    try {
      await sftpUnlink(await this.conn.sftp(), join(normalize(root), relativePath));
      return 'removed';
    } catch (error) {
      if (isNoSuchFile(error)) return 'missing';
      throw error;
    }
  }

  async statPath(path: string): Promise<PathStat | null> {
    const sftp = await this.conn.sftp();
    try {
      const st = await sftpStat(sftp, path);
      return {
        size: st.size,
        mtimeMs: st.mtime * 1000, // SFTP mtime 是 epoch 秒
        isDirectory: st.isDirectory(),
        isFile: st.isFile(),
        mode: st.mode & 0o7777,
      };
    } catch (e) {
      if (isNoSuchFile(e)) return null;
      throw e;
    }
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const sftp = await this.conn.sftp();
    const list = await sftpReaddir(sftp, path);
    return list.map((e) => ({ name: e.filename, type: typeFromMode(e.attrs.mode) }));
  }

  /** 写文件：mkdir -p 父目录（exec）+ SFTP 写入；mode 对已存在文件用 chmod 补齐（同 LocalDriver）。 */
  async writeFile(path: string, data: Uint8Array | string, mode?: number): Promise<void> {
    const mk = await this.exec('mkdir', ['-p', dirname(path)]);
    if (mk.code !== 0) throw new Error(`mkdir -p 失败: ${mk.err || mk.out}`);
    const sftp = await this.conn.sftp();
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    await sftpWriteFile(sftp, path, buf, mode !== undefined ? { mode } : {});
    if (mode !== undefined) await sftpChmod(sftp, path, mode);
  }

  /** 符号链接：ln -sT（-T 防 linkPath 是已存在目录时"链到目录里"的歧义，已存在直接报错）。 */
  async symlink(target: string, linkPath: string): Promise<void> {
    const mk = await this.exec('mkdir', ['-p', dirname(linkPath)]);
    if (mk.code !== 0) throw new Error(`mkdir -p 失败: ${mk.err || mk.out}`);
    const r = await this.exec('ln', ['-sT', '--', target, linkPath]);
    if (r.code !== 0) throw new Error(`ln -sT 失败: ${r.err || r.out}`);
  }

  async readlink(path: string): Promise<string | null> {
    const r = await this.exec('readlink', ['--', path]);
    if (r.code !== 0) return null; // 非链接/不存在
    const t = r.out.replace(/\n+$/, '');
    return t.length > 0 ? t : null;
  }

  async removeTree(path: string): Promise<void> {
    const p = assertRemovablePath(path);
    const r = await this.exec('rm', ['-rf', '--', p], this.gitTimeoutMs);
    if (r.code !== 0) throw new Error(`rm -rf 失败: ${r.err || r.out}`);
  }

  async mkdirp(path: string): Promise<void> {
    const r = await this.exec('mkdir', ['-p', '--', path]);
    if (r.code !== 0) throw new Error(`mkdir -p 失败: ${r.err || r.out}`);
  }

  /** mv -T：dst 就是最终路径，dst 为非空目录时报错（契约见 driver.ts） */
  async movePath(src: string, dst: string): Promise<void> {
    const r = await this.exec('mv', ['-T', '--', src, dst], this.gitTimeoutMs);
    if (r.code !== 0) throw new Error(`mv 失败: ${r.err || r.out}`);
  }

  // ---- git ----

  /** git -C cwd <args>；非零退出不抛错（契约：交调用方判断 code），传输层错误/超时才抛。 */
  async git(cwd: string, args: string[]): Promise<GitResult> {
    return this.exec('git', ['-C', cwd, ...args], this.gitTimeoutMs);
  }

  async readGitBlob(cwd: string, rev: string, path: string): Promise<GitBlobResult> {
    const args = ['-C', cwd, 'cat-file', 'blob', `${rev}:${path}`].map(shq).join(' ');
    const r = await this.conn.execBytes(`git ${args}`, this.gitTimeoutMs);
    return { code: r.code, data: r.out, err: r.err };
  }

  // ---- 终端流（exec channel + PTY 分配，resize 走 setWindow）----

  async openPty(cmd: string, cols: number, rows: number): Promise<PtyChannel> {
    const stream = await this.conn.openPtyChannel(cmd, cols, rows);
    const dataCbs: Array<(chunk: Uint8Array) => void> = [];
    const exitCbs: Array<(code: number | null) => void> = [];
    let exitCode: number | null = null;
    let exited = false;

    const emit = (chunk: Buffer) => {
      const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length);
      for (const cb of dataCbs) cb(u8);
    };
    stream.on('data', (chunk: Buffer) => emit(chunk));
    // PTY 下 stderr 通常并入 stdout，但仍接上以防万一
    stream.stderr.on('data', (chunk: Buffer) => emit(chunk));
    stream.on('exit', (code: number | null) => {
      if (typeof code === 'number') exitCode = code;
    });
    stream.on('close', () => {
      if (exited) return;
      exited = true;
      for (const cb of exitCbs) cb(exitCode);
    });

    return {
      write(data: string | Uint8Array): void {
        stream.write(data);
      },
      resize(cols2: number, rows2: number): void {
        stream.setWindow(rows2, cols2, 0, 0);
      },
      onData(cb): void {
        dataCbs.push(cb);
      },
      onExit(cb): void {
        exitCbs.push(cb);
      },
      close(): void {
        stream.close();
      },
    };
  }
}
