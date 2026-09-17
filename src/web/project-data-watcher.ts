/**
 * web/project-data-watcher —— `.panda` 协作目录的事件驱动同步（取代「5 秒把所有文件重读一遍」）。
 *
 * 为什么原来只能轮询：`.panda` 是**文件权威**的，真相在文件里，SQLite 只是索引。写它的是 tmux
 * 里的 agent（`panda-issue` 技能直接改 `MODULE.md` / issue 过程页）和 `git pull`，控制面收不到
 * 任何通知，只能定时重新求值。代价是持续的读放大——生产上曾经是常驻约 11 MB/s 的读 + SHA-256。
 *
 * 这里用 inotify（`fs.watch` 的 recursive 模式）把「谁改了」变成事件：
 * - **只管本机执行机**。`ExecutorDriver` 抽象下远程执行机没有 inotify，那些项目原样走轮询；
 *   `healthy()` 就是给调度侧回答「这个项目还需不需要密集轮询」的。
 * - **只认可共享路径**。`.panda/tmp` 下的执行产物写得非常频繁，按 `isShareablePandaPath` 过滤掉，
 *   否则事件比轮询还吵。
 * - **合并抖动**。一次 `git pull` 或一次 MODULE.md 重写会炸出几十个事件，debounce 成一次同步。
 * - **失败即降级**。目录还不存在、inotify 名额耗尽、平台不支持 recursive——一律记为不健康，
 *   那个项目继续吃轮询。观测能力缺失只能让它变慢，不能让它变瞎。
 *
 * 回声不用特意抑制：控制面自己写 `.panda` 也会触发事件，但那一轮同步只会读到与索引一致的内容，
 * 记成 unchanged 就结束，不会再产生写入。配合 `PandaProjectSync` 的 size/mtime 免读短路，
 * 这一轮的代价只是一次 stat。
 */
import { watch } from 'node:fs';
import { isShareablePandaPath } from '../core/project-sync';
import { PANDA_PROJECT_DATA } from '../core/project-data';

export interface WatchTarget {
  projectId: number;
  /** 项目 cwd（执行机侧绝对路径）；非本机执行机的项目不要传进来 */
  cwd: string;
}

export interface ProjectDataWatcherDeps {
  /** 当前该被监听的项目（只含本机执行机的 active 项目）；每次 refresh 重新取 */
  targets(): WatchTarget[];
  /** 合并抖动之后触发一次同步；抛错由实现方自己吞掉 */
  onChange(projectId: number): void;
  /** 抖动合并窗口，缺省 300ms */
  debounceMs?: number;
  /**
   * 装配失败留痕（默认静默）——不健康本身不是故障，只是降级回轮询。
   * 同一个项目**同一个原因只报一次**：refresh 跟着定时器每拍都会重试，不去重会把日志刷穿。
   */
  onError?: (projectId: number, error: unknown) => void;
  /** 测试可注入确定性事件源；生产缺省仍使用原生递归 fs.watch。 */
  watchDirectory?: WatchDirectory;
}

interface WatchHandle {
  close(): void;
}

type WatchDirectory = (
  root: string,
  onEvent: (filename: string | null) => void,
  onError: (error: unknown) => void,
) => WatchHandle;

interface Armed {
  cwd: string;
  watcher: WatchHandle;
  timer: ReturnType<typeof setTimeout> | null;
}

export class ProjectDataWatcher {
  private readonly armed = new Map<number, Armed>();
  /** projectId → 上次已上报的失败原因，用来给每拍重试的告警去重 */
  private readonly reported = new Map<number, string>();
  private closed = false;

  constructor(private readonly deps: ProjectDataWatcherDeps) {}

  /**
   * 按当前目标列表补齐/撤掉监听。装配失败不抛——调用方（定时器）下一轮还会再试，
   * 项目 cwd 是后建的、或者 inotify 名额临时耗尽，都能自己恢复。
   */
  refresh(): void {
    if (this.closed) return;
    const targets = this.deps.targets();
    const wanted = new Map(targets.map((t) => [t.projectId, t.cwd]));
    for (const [projectId, armed] of this.armed) {
      if (wanted.get(projectId) !== armed.cwd) this.disarm(projectId); // 撤掉 / cwd 改了就重装
    }
    for (const { projectId, cwd } of targets) {
      if (this.armed.has(projectId)) continue;
      this.arm(projectId, cwd);
    }
  }

  /** 这个项目是否已被事件覆盖；false = 调度侧仍要按原来的密集轮询兜底 */
  healthy(projectId: number): boolean {
    return this.armed.has(projectId);
  }

  /** 当前被事件覆盖的项目数（装配日志/诊断用） */
  get size(): number {
    return this.armed.size;
  }

  close(): void {
    this.closed = true;
    for (const projectId of [...this.armed.keys()]) this.disarm(projectId);
  }

  // ---- 内部 ----

  private arm(projectId: number, cwd: string): void {
    const root = `${cwd.replace(/\/+$/, '')}/${PANDA_PROJECT_DATA.root}`;
    try {
      const watchDirectory = this.deps.watchDirectory ?? nativeWatchDirectory;
      const watcher = watchDirectory(root, (filename) => {
        if (filename === null) return;
        this.onEvent(projectId, filename);
      }, (error) => {
        this.report(projectId, error);
        this.disarm(projectId);
      });
      this.armed.set(projectId, { cwd, watcher, timer: null });
      this.reported.delete(projectId); // 装上了：下次再失败要重新报
    } catch (error) {
      // 平台不支持 / inotify 名额耗尽 / 权限不足 → 报出来，那是要人管的；
      // 但「项目还没有 .panda 目录」是全新项目的**正常状态**，不是故障，报了也没人能处理。
      if (!isMissingDir(error)) this.report(projectId, error);
    }
  }

  /** 按原因去重的失败上报：同一个项目连续同因失败只惊动调用方一次 */
  private report(projectId: number, error: unknown): void {
    const reason = String(error).slice(0, 200);
    if (this.reported.get(projectId) === reason) return;
    this.reported.set(projectId, reason);
    this.deps.onError?.(projectId, error);
  }

  private disarm(projectId: number): void {
    const armed = this.armed.get(projectId);
    if (!armed) return;
    this.armed.delete(projectId);
    if (armed.timer) clearTimeout(armed.timer);
    try {
      armed.watcher.close();
    } catch {
      /* 已经关了 */
    }
  }

  private onEvent(projectId: number, filename: string): void {
    const armed = this.armed.get(projectId);
    if (!armed) return;
    // filename 是相对 .panda 的路径；补回前缀再按共享白名单过滤（.panda/tmp 写得最勤，必须挡住）
    const rel = `${PANDA_PROJECT_DATA.root}/${filename.split('\\').join('/')}`;
    if (!isShareablePandaPath(rel)) return;
    if (armed.timer) clearTimeout(armed.timer);
    armed.timer = setTimeout(() => {
      armed.timer = null;
      try {
        this.deps.onChange(projectId);
      } catch (error) {
        this.deps.onError?.(projectId, error);
      }
    }, this.deps.debounceMs ?? 300);
    armed.timer.unref?.();
  }
}

/** 「目录不存在」：项目从没用过协作文件时的常态，静默降级回轮询即可，不值得一条告警 */
function isMissingDir(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT';
}

const nativeWatchDirectory: WatchDirectory = (root, onEvent, onError) => {
  const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
    onEvent(filename === null || filename === undefined ? null : String(filename));
  });
  // 目录被删/权限变化时撤掉，交给下一轮 refresh 重装。
  watcher.on('error', onError);
  return watcher;
};
