/**
 * executor/pane-cache —— capturePane 的 TTL 合并缓存包装器（M6，默认 300ms）。
 *
 * 为什么放 Driver 池层（server.ts driverForExecutor 包装）而不是引擎层：
 * Wave3 之后同一 pane 有多方消费者——引擎 watch tick（3s）、每个 WS chat 客户端的
 * 轮询（1.2s × N 客户端）、审批管道 actOnMenu、/act 路由的锁内核对——它们都从池里
 * 拿同一个 Driver 实例，缓存点唯一才能真正合并请求；放引擎层只能收敛引擎自己的调用。
 *
 * 正确性边界：
 * - 并发合并：TTL 内共享同一 in-flight promise（多个消费者只触发一次真实抓屏）；
 * - 写操作即失效：sendKeys/sendKey/createSession/killSession 之后立刻失效该会话缓存——
 *   actOnMenu「锁内重抓核对签名再注入」依赖注入后的抓屏是新鲜的，绝不能吃到注入前旧屏；
 * - 抓屏失败不缓存：失败结果立即逐出，下一次调用真抓（保住 actOnMenu 的抓空重试语义）；
 * - 注入前的核对最多吃到 ttl（300ms）旧屏——与 tmux 轮询快照本身的时滞同量级，可接受；
 *   代价是 actOnMenu 的 4×50ms 抓空重试在 TTL 窗口内会命中同一缓存（等效重试变慢一档），
 *   其兜底是调用方的 no_menu 自愈路径（下一 tick / 客户端重试）。
 */
import type {
  DirEntry,
  ExecutorDriver,
  FileRange,
  GitResult,
  PathStat,
  PtyChannel,
  TmuxSession,
} from './driver';
import type { AgentKind } from '../core/types';

export const PANE_CACHE_TTL_MS = 300;

interface CacheEntry {
  ts: number;
  p: Promise<string>;
}

export class PaneCacheDriver implements ExecutorDriver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly inner: ExecutorDriver,
    private readonly ttlMs: number = PANE_CACHE_TTL_MS,
    private readonly nowFn: () => number = Date.now,
  ) {}

  /** 透传底层连接状态（SshDriver 有 status；LocalDriver 无 → undefined=本机恒在线） */
  get status(): unknown {
    return (this.inner as { status?: unknown }).status;
  }

  /** 透传底层关闭（server 停机链会对池里每个 driver 调 close） */
  async close(): Promise<void> {
    await (this.inner as { close?: () => Promise<void> | void }).close?.();
  }

  // ---- 缓存本体 ----

  capturePane(session: string): Promise<string> {
    const now = this.nowFn();
    const hit = this.cache.get(session);
    if (hit && now - hit.ts < this.ttlMs) return hit.p;
    const p = this.inner.capturePane(session);
    this.cache.set(session, { ts: now, p });
    p.catch(() => {
      // 失败结果不缓存：立即逐出，别让一次瞬时错误糊住 TTL 窗口内的所有消费者
      if (this.cache.get(session)?.p === p) this.cache.delete(session);
    });
    return p;
  }

  private invalidate(session: string): void {
    this.cache.delete(session);
  }

  // ---- 写操作：完成后失效该会话缓存（无论成败——失败也可能已改变屏幕） ----

  async sendKeys(session: string, text: string): Promise<void> {
    try {
      await this.inner.sendKeys(session, text);
    } finally {
      this.invalidate(session);
    }
  }

  async sendKey(session: string, key: string): Promise<void> {
    try {
      await this.inner.sendKey(session, key);
    } finally {
      this.invalidate(session);
    }
  }

  async createSession(name: string, cwd: string): Promise<void> {
    try {
      await this.inner.createSession(name, cwd);
    } finally {
      this.invalidate(name);
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await this.inner.killSession(name);
    } finally {
      this.invalidate(name);
    }
  }

  /** 改窗口尺寸 = 整屏重绘，缓存里的旧屏立刻作废（issue #95） */
  async resizeWindow(session: string, size: { cols: number; rows: number } | null): Promise<void> {
    try {
      await this.inner.resizeWindow(session, size);
    } finally {
      this.invalidate(session);
    }
  }

  // ---- 其余纯透传 ----

  findExecutable(agent: AgentKind): Promise<string | null> {
    return this.inner.findExecutable(agent);
  }

  listSessions(): Promise<TmuxSession[]> {
    return this.inner.listSessions();
  }

  readFileRange(path: string, offset: number, limit: number): Promise<FileRange> {
    return this.inner.readFileRange(path, offset, limit);
  }

  statPath(path: string): Promise<PathStat | null> {
    return this.inner.statPath(path);
  }

  listDir(path: string): Promise<DirEntry[]> {
    return this.inner.listDir(path);
  }

  writeFile(path: string, data: Uint8Array | string, mode?: number): Promise<void> {
    return mode !== undefined
      ? this.inner.writeFile(path, data, mode)
      : this.inner.writeFile(path, data);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    return this.inner.symlink(target, linkPath);
  }

  readlink(path: string): Promise<string | null> {
    return this.inner.readlink(path);
  }

  removeTree(path: string): Promise<void> {
    return this.inner.removeTree(path);
  }

  mkdirp(path: string): Promise<void> {
    return this.inner.mkdirp(path);
  }

  movePath(src: string, dst: string): Promise<void> {
    return this.inner.movePath(src, dst);
  }

  git(cwd: string, args: string[]): Promise<GitResult> {
    return this.inner.git(cwd, args);
  }

  openPty(cmd: string, cols: number, rows: number): Promise<PtyChannel> {
    return this.inner.openPty(cmd, cols, rows);
  }
}

/** 便捷工厂（server.ts 装配用；ttl/now 注入供测试） */
export function withPaneCache(
  driver: ExecutorDriver,
  ttlMs?: number,
  now?: () => number,
): PaneCacheDriver {
  return new PaneCacheDriver(driver, ttlMs, now);
}
