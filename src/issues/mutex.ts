/**
 * issues/mutex —— per-key 互斥锁（评审 H9/5.1#4：每会话单一驾驶员）。
 *
 * v1 靠 execFileSync「同步=天然串行」隐式防竞态，v2 全异步后必须显式互斥：
 * 同一 tmux 会话同一时刻只允许一个驾驶员注入（引擎 kickoff/nudge、PM 自动审批、
 * web /api/act、飞书卡片回调……全部对同一 key 排队）。
 *
 * 本模块导出给 PM / 路由复用：tmux 注入、project 操作、issue 元数据与 git 写操作
 * 各用独立 key 空间。issue 生命周期的全局顺序为 issue-meta → transition queue → git；
 * 会话操作为 project → tmux，任何路径都不得反向嵌套。
 */

interface Entry {
  /** 队尾 promise：新调用者等它，再把自己的完成 promise 接上去 */
  tail: Promise<void>;
  /** 在排队/持锁的调用数，归零即回收 map 条目 */
  active: number;
}

export class KeyedMutex {
  private entries = new Map<string, Entry>();

  /** 该 key 当前是否有人持锁/排队 */
  isLocked(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * 串行执行：同 key 严格 FIFO，一次只跑一个 fn；不同 key 互不阻塞。
   * fn 抛错会向本调用者传播，但不会毒化队列（后续调用照常执行）。
   */
  async runExclusive<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { tail: Promise.resolve(), active: 0 };
      this.entries.set(key, entry);
    }
    entry.active++;
    const prev = entry.tail;
    let release!: () => void;
    entry.tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
      entry.active--;
      if (entry.active === 0 && this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
    }
  }
}

/**
 * 锁序纪律（防死锁）：
 * - pending issue：issue-meta → engine transition queue → git；
 * - 会话：project → tmux（engine.activateConv 的 kill+create+send 三连）。
 * 严禁 transition 反向获取 issue-meta、git 反向获取 transition/issue-meta，或 tmux
 * 反向获取 project。单独取任一把锁不受限制。
 */

/** tmux 会话注入锁的统一 key 约定（引擎/PM/路由都用它，别自造 key） */
export function tmuxLockKey(session: string): string {
  return `tmux:${session}`;
}

/** project 级操作锁（activate 抢占等，评审 H18：per-project 互斥）；嵌套时先于 tmux 锁获取 */
export function projectLockKey(projectId: number): string {
  return `project:${projectId}`;
}

/** project 级 Git 写操作锁：手动 stage/commit/push 与后续引擎 Git 写入复用，避免 index/ref 竞态 */
export function gitLockKey(projectId: number): string {
  return `git:${projectId}`;
}
