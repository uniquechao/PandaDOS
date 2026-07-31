/**
 * executor/conn —— SshConn：ssh2 单持久连接的生命周期管理（SshDriver 的底座）。
 *
 * 设计（spec §3 + 评审 5.1）：
 * - 单持久 Client，exec / sftp / pty 多路复用 channel 共用一条 TCP；
 * - 断线指数退避重连（base → ×2 → 上限 60s），连上即重置退避；
 * - 断线时在途调用报错（不静默吞——评审铁律），连接由退避定时器自愈；
 * - 主动 close() 后进入终态，不再重连；
 * - status 字段暴露连接状态，供健康度上报（spec §3 executors.status）。
 *
 * 可测性：clientFactory 注入点让单测用 mock 客户端驱动全部状态转换；
 * 真 ssh2.Client 在运行时满足下面的结构化最小类型（SshClientLike）。
 */
import { readFile } from 'node:fs/promises';
import { Client } from 'ssh2';

// ---------- 结构化最小类型（mock 按此实现；真 ssh2 运行时满足） ----------

/** exec / pty channel 的最小面：事件 + 写入 + 窗口调整 + 关闭。 */
export interface ExecStreamLike {
  on(ev: string, cb: (...args: any[]) => void): this;
  stderr: { on(ev: string, cb: (...args: any[]) => void): unknown };
  write(data: string | Uint8Array): unknown;
  setWindow(rows: number, cols: number, height: number, width: number): unknown;
  close(): unknown;
}

export interface SftpStatsLike {
  size: number;
  /** epoch 秒（SFTP 协议粒度） */
  mtime: number;
  mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface SftpDirEntryLike {
  filename: string;
  attrs: { mode: number };
}

/** SFTP channel 的最小面（readFileRange/statPath/listDir/writeFile 所需）。 */
export interface SftpLike {
  open(path: string, flags: string, cb: (err: Error | null | undefined, handle: unknown) => void): void;
  fstat(handle: unknown, cb: (err: Error | null | undefined, stats: SftpStatsLike) => void): void;
  read(
    handle: unknown,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | null | undefined, bytesRead: number) => void,
  ): void;
  close(handle: unknown, cb: (err: Error | null | undefined) => void): void;
  stat(path: string, cb: (err: Error | null | undefined, stats: SftpStatsLike) => void): void;
  readdir(path: string, cb: (err: Error | null | undefined, list: SftpDirEntryLike[]) => void): void;
  writeFile(
    path: string,
    data: Buffer,
    options: { mode?: number },
    cb: (err: Error | null | undefined) => void,
  ): void;
  chmod(path: string, mode: number, cb: (err: Error | null | undefined) => void): void;
}

export interface SshClientLike {
  connect(cfg: Record<string, unknown>): void;
  end(): void;
  exec(
    cmd: string,
    opts: Record<string, unknown>,
    cb: (err: Error | undefined, stream: ExecStreamLike) => void,
  ): void;
  sftp(cb: (err: Error | undefined, sftp: SftpLike) => void): void;
  on(ev: string, cb: (...args: any[]) => void): this;
}

// ---------- 配置与结果 ----------

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'closed';

export interface SshConnConfig {
  host: string;
  port: number;
  username: string;
  /** 私钥文件绝对路径（控制面本地 ~/.butler2/keys/<keyRef>，0600，不进 DB） */
  privateKeyPath: string;
  /** 首次重连退避基数（ms），指数递增至 maxBackoffMs；默认 1000 */
  baseBackoffMs?: number;
  /** 退避上限（ms）；默认 60_000（spec：上限 60s） */
  maxBackoffMs?: number;
  /** ssh 握手超时（ms）；默认 10_000 */
  readyTimeoutMs?: number;
  /** 测试注入点：默认 () => new ssh2.Client() */
  clientFactory?: () => SshClientLike;
}

export interface ExecOutcome {
  code: number;
  out: string;
  err: string;
}

const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;

// ---------- 连接本体 ----------

export class SshConn {
  private readonly cfg: SshConnConfig;

  private client: SshClientLike | null = null;
  private sftpCache: SftpLike | null = null;
  private sftpOpening: Promise<SftpLike> | null = null;
  /** 拨号中 promise：并发调用合流，避免重复拨号 */
  private connecting: Promise<SshClientLike> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number;
  private _status: ConnStatus = 'disconnected';

  constructor(cfg: SshConnConfig) {
    this.cfg = cfg;
    this.backoffMs = cfg.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  }

  get status(): ConnStatus {
    return this._status;
  }

  /** close() 可与异步回调竞态；经方法读取绕开 TS 对 _status 的流敏感窄化。 */
  private isClosed(): boolean {
    return (this._status as ConnStatus) === 'closed';
  }

  /** 主动关闭：终态，取消重连定时器，不再自愈。 */
  close(): void {
    this._status = 'closed';
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const c = this.client;
    this.client = null;
    this.sftpCache = null;
    this.sftpOpening = null;
    this.connecting = null;
    try {
      c?.end();
    } catch {
      /* 关闭路径不上抛 */
    }
  }

  /** 确保连接可用（懒连接；已有拨号则合流；有退避定时器则立即拨号并取消定时器）。 */
  async ensure(): Promise<SshClientLike> {
    if (this._status === 'closed') throw new Error('SshConn 已关闭');
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const p = this.dial();
    this.connecting = p;
    try {
      return await p;
    } finally {
      if (this.connecting === p) this.connecting = null;
    }
  }

  /**
   * 在远端执行一条命令行（exec channel）。
   * 正常/非零退出都 resolve {code,out,err}；被信号杀 → code=-1 并在 err 附注；
   * 通道无退出码即关闭（连接中断）→ reject（在途调用报错，连接自愈）。
   *
   * @param timeoutMs I5：命令级超时。超时 → 关闭 channel + reject 明确错误——远端一条
   *   卡死的命令不许无限期占住调用方（引擎 tick 是串行的，会被整个冻结）。
   *   注意 channel close 只是断开本端读写，远端进程可能仍在跑（尽力语义）。
   *   连接建立/握手阶段的卡死由 readyTimeout + keepalive 兜底，不在本超时范围内。
   */
  async exec(command: string, timeoutMs?: number): Promise<ExecOutcome> {
    const client = await this.ensure();
    return await new Promise<ExecOutcome>((resolve, reject) => {
      client.exec(command, {}, (err, stream) => {
        if (err || !stream) {
          reject(err ?? new Error('ssh exec 打开通道失败'));
          return;
        }
        let out = '';
        let errOut = '';
        let exitCode: number | null = null;
        let exitSignal: string | null = null;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        if (timeoutMs && timeoutMs > 0) {
          timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              stream.close();
            } catch {
              /* 关闭失败不掩盖超时错误 */
            }
            reject(new Error(`ssh exec 超时（>${timeoutMs}ms）: ${command.slice(0, 120)}`));
          }, timeoutMs);
        }
        const clearTimer = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        };
        stream.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          errOut += chunk.toString('utf8');
        });
        stream.on('exit', (code: number | null, signal?: string | null) => {
          if (typeof code === 'number') exitCode = code;
          if (typeof signal === 'string') exitSignal = signal;
        });
        stream.on('error', (e: Error) => {
          if (settled) return;
          settled = true;
          clearTimer();
          reject(e);
        });
        stream.on('close', (code?: number | null, signal?: string | null) => {
          if (settled) return;
          settled = true;
          clearTimer();
          const c = typeof code === 'number' ? code : exitCode;
          const sig = typeof signal === 'string' ? signal : exitSignal;
          if (c !== null && c !== undefined) {
            resolve({ code: c, out, err: errOut });
          } else if (sig) {
            resolve({ code: -1, out, err: `${errOut}\n[被信号终止: ${sig}]`.trim() });
          } else {
            reject(new Error(`ssh exec 通道无退出码即关闭（连接可能中断）: ${command.slice(0, 120)}`));
          }
        });
      });
    });
  }

  /** 取（并缓存）sftp channel；断线后缓存随连接一起失效，下次自动重开。 */
  async sftp(): Promise<SftpLike> {
    const client = await this.ensure();
    if (this.sftpCache) return this.sftpCache;
    if (this.sftpOpening) return this.sftpOpening;
    const p = new Promise<SftpLike>((resolve, reject) => {
      client.sftp((err, s) => {
        if (err || !s) {
          reject(err ?? new Error('sftp 打开失败'));
          return;
        }
        this.sftpCache = s;
        resolve(s);
      });
    });
    this.sftpOpening = p;
    try {
      return await p;
    } finally {
      if (this.sftpOpening === p) this.sftpOpening = null;
    }
  }

  /** 打开带 PTY 的 exec channel 跑 cmd（网页终端：tmux attach 代理到 xterm）。 */
  async openPtyChannel(cmd: string, cols: number, rows: number): Promise<ExecStreamLike> {
    const client = await this.ensure();
    return await new Promise<ExecStreamLike>((resolve, reject) => {
      client.exec(
        cmd,
        { pty: { term: 'xterm-256color', cols, rows, height: 0, width: 0 } },
        (err, stream) => {
          if (err || !stream) reject(err ?? new Error('ssh pty 打开通道失败'));
          else resolve(stream);
        },
      );
    });
  }

  // ---------- 内部：拨号与自愈 ----------

  private async dial(): Promise<SshClientLike> {
    this._status = 'connecting';
    let privateKey: Buffer;
    try {
      privateKey = await readFile(this.cfg.privateKeyPath);
    } catch (e) {
      if (!this.isClosed()) {
        this._status = 'disconnected';
        this.scheduleReconnect();
      }
      throw e;
    }
    return await new Promise<SshClientLike>((resolve, reject) => {
      const factory = this.cfg.clientFactory ?? (() => new Client() as unknown as SshClientLike);
      const client = factory();
      let settled = false;

      client.on('ready', () => {
        if (settled) return;
        settled = true;
        if (this.isClosed()) {
          // close() 赢了竞态：丢弃这条连接
          try {
            client.end();
          } catch {
            /* ignore */
          }
          reject(new Error('SshConn 已关闭'));
          return;
        }
        this.client = client;
        this._status = 'connected';
        this.backoffMs = this.cfg.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS; // 连上即重置退避
        resolve(client);
      });

      client.on('error', (err: Error) => {
        // ready 之后的 error 紧跟 close 事件，由 close 分支统一处理
        if (settled) return;
        settled = true;
        if (!this.isClosed()) {
          this._status = 'disconnected';
          this.scheduleReconnect();
        }
        reject(err);
      });

      client.on('close', () => {
        if (!settled) {
          // 连接建立前就被关（如握手超时后 ssh2 只发 close）
          settled = true;
          if (!this.isClosed()) {
            this._status = 'disconnected';
            this.scheduleReconnect();
          }
          reject(new Error('ssh 连接在建立前关闭'));
          return;
        }
        if (this.client === client) {
          // 已建立的连接意外断开：清空缓存，进入自愈
          this.client = null;
          this.sftpCache = null;
          this.sftpOpening = null;
          if (!this.isClosed()) {
            this._status = 'disconnected';
            this.scheduleReconnect();
          }
        }
      });

      try {
        client.connect({
          host: this.cfg.host,
          port: this.cfg.port,
          username: this.cfg.username,
          privateKey,
          readyTimeout: this.cfg.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
        });
      } catch (e) {
        if (!settled) {
          settled = true;
          if (!this.isClosed()) {
            this._status = 'disconnected';
            this.scheduleReconnect();
          }
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
  }

  /** 排一次退避重连；每排一次退避 ×2（封顶 maxBackoffMs）。定时器触发时再核对状态。 */
  private scheduleReconnect(): void {
    if (this._status === 'closed' || this.retryTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.cfg.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this._status === 'closed' || this.client || this.connecting) return;
      const p = this.dial();
      this.connecting = p;
      p.catch(() => {
        /* 失败已在 dial 内部排好下一次退避 */
      }).finally(() => {
        if (this.connecting === p) this.connecting = null;
      });
    }, delay);
  }
}
