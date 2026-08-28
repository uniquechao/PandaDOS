/**
 * executor/driver —— ExecutorDriver 接口（spec §3）。
 * v2 最重要的边界：控制面对执行机的一切操作（tmux / 受限文件 / git / 终端流）只走这里。
 * 实现：SshDriver（生产，ssh2 单持久连接多路复用）、LocalDriver（本机直跑，测试替身）。
 */
import type { AgentKind } from '../core/types';

// ---------- 载荷类型 ----------

export interface TmuxSession {
  name: string;
  /** 会话创建时间，epoch 秒（tmux #{session_created}） */
  createdTs: number;
  attached: boolean;
  /**
   * 活跃窗格的当前目录（#{pane_current_path}；导入现有 tmux 会话为项目时的 cwd 依据）。
   * 与 command 同为可选：老实现/解析失败时缺省，消费方须容缺。
   */
  cwd?: string;
  /** 活跃窗格的当前前台命令（#{pane_current_command}，如 claude/bash） */
  command?: string;
}

export interface FileRange {
  /** 读到的字节（长度 ≤ limit；offset 超过文件尾时为空） */
  data: Uint8Array;
  /** 读取时刻的文件总大小（字节）——jsonl tail 用它推进 offset */
  size: number;
}

export interface PathStat {
  size: number;
  /** mtime，epoch 毫秒 */
  mtimeMs: number;
  isDirectory: boolean;
  isFile: boolean;
  /** POSIX 权限位（八进制数值，如 0o600） */
  mode: number;
}

export interface DirEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
}

export interface GitResult {
  code: number;
  out: string;
  err: string;
}

/** Git blob 原始字节读取结果；非零退出不抛错，与 git() 契约一致。 */
export interface GitBlobResult {
  code: number;
  data: Uint8Array;
  err: string;
}

/** 终端流通道：tmux attach（或任意命令）经 PTY 代理到 xterm.js。 */
export interface PtyChannel {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** 注册输出回调（stdout+stderr 合流，PTY 语义） */
  onData(cb: (chunk: Uint8Array) => void): void;
  onExit(cb: (code: number | null) => void): void;
  close(): void;
}

export type TmuxScrollDirection = 'up' | 'down';

// ---------- 接口 ----------

export interface ExecutorDriver {
  /**
   * 受限探测固定 Agent 命令。实现只能接受 claude/codex 枚举，不提供任意 shell 入口。
   * 找到时返回绝对命令路径，未找到返回 null。
   */
  findExecutable(agent: AgentKind): Promise<string | null>;

  // ---- tmux ----

  /** 列出执行机上的 tmux 会话；tmux server 未启动时返回 []。 */
  listSessions(): Promise<TmuxSession[]>;

  /** 创建 detached 会话（new-session -d -s name -c cwd）。同名已存在则抛错。 */
  createSession(name: string, cwd: string): Promise<void>;

  /** 杀掉会话；会话不存在时抛错。 */
  killSession(name: string): Promise<void>;

  /**
   * 向会话注入一段文本并回车提交。
   * 净化+截断规则 = v1 injector.ts 语义：控制字符（含 \n）→空格、截断 2000（sanitizeInjectText）。
   */
  sendKeys(session: string, text: string): Promise<void>;

  /** 发送单个特殊键（Enter/Escape/Up/... 白名单，见 KEY_WHITELIST），白名单外抛错。 */
  sendKey(session: string, key: string): Promise<void>;

  /** 抓取当前窗格可见内容（capture-pane -p），供菜单/弹窗检测。 */
  capturePane(session: string): Promise<string>;

  /**
   * 设定会话窗口尺寸；null = 交还给附着客户端自动定尺（window-size latest）。
   * 终端页 attach 前交还、断开后收回到标称尺寸——见 tmuxResizeWindowArgs 的注释（issue #95）。
   */
  resizeWindow(session: string, size: { cols: number; rows: number } | null): Promise<void>;

  /** 滚动 tmux 历史；up 进入 copy-mode，down 到底时退出。 */
  scrollPane(session: string, direction: TmuxScrollDirection, lines: number): Promise<void>;

  // ---- 文件（限定用途，非通用 shell）----

  /**
   * 按字节区间读文件——jsonl 增量 tail 的唯一入口。
   * @returns data: 读到的字节；size: 当前文件总大小（控制面据此推进 offset）
   */
  readFileRange(path: string, offset: number, limit: number): Promise<FileRange>;

  /**
   * Read one regular file beneath an explicitly trusted directory without following symlinks.
   * Implementations validate the root, every relative component, and the final opened handle.
   * The method is optional for compatibility with narrow test doubles; security-sensitive callers
   * must reject unsupported drivers and must never fall back to statPath/readFileRange.
   */
  readFileNoFollowWithin?(root: string, relativePath: string, limit: number): Promise<FileRange>;

  /** Create a bounded file below root without following links or overwriting differing content. */
  writeFileNoFollowWithin?(
    root: string,
    relativePath: string,
    data: Uint8Array | string,
    mode?: number,
  ): Promise<'created' | 'unchanged' | 'conflict'>;

  /** List one real directory beneath root without following any symlink component. */
  listDirectoryNoFollowWithin?(
    root: string,
    relativePath: string,
  ): Promise<DirEntry[] | null>;

  /** Compare-and-swap a regular file beneath root, replacing only the expected digest. */
  replaceFileNoFollowWithin?(
    root: string,
    relativePath: string,
    data: Uint8Array,
    expectedSha256: string | null,
  ): Promise<'written' | 'unchanged' | 'conflict'>;

  /** Remove a regular file beneath root only when its bytes still match the expected digest. */
  removeFileNoFollowWithin?(
    root: string,
    relativePath: string,
    expectedSha256: string,
  ): Promise<'removed' | 'missing' | 'conflict'>;

  /** stat；路径不存在返回 null（不抛错）。 */
  statPath(path: string): Promise<PathStat | null>;

  /** 列目录（不递归）。 */
  listDir(path: string): Promise<DirEntry[]>;

  /**
   * 写文件（截图落地、trustDir 等）。自动创建父目录。
   * @param mode 可选 POSIX 权限（如 0o600）
   */
  writeFile(path: string, data: Uint8Array | string, mode?: number): Promise<void>;

  /**
   * 创建符号链接 linkPath → target（技能目录 claude/codex 共用）。
   * 自动创建父目录；linkPath 已存在（含链接自身）时抛错——调用方先 readlink/statPath 探测。
   */
  symlink(target: string, linkPath: string): Promise<void>;

  /** 读符号链接目标；path 不是链接或不存在返回 null（不抛错）。 */
  readlink(path: string): Promise<string | null>;

  /**
   * 递归删除文件/目录（不存在视为成功）。危险原语：仅限技能安装/卸载这类
   * 「基路径由控制面拼出 + 末段名严格白名单」的调用；实现层拒绝空路径与根目录。
   */
  removeTree(path: string): Promise<void>;

  /** 递归创建目录（mkdir -p 语义，已存在视为成功）。建项目目录浏览「新建目录」/ git clone 前置父目录用。 */
  mkdirp(path: string): Promise<void>;

  /**
   * 移动/重命名文件或目录：dst 就是最终路径，不做「移入已存在目录」推断；
   * dst 已存在（空目录也算）必须失败。实现应优先 rename，跨文件系统再 copy+remove，
   * 不依赖 GNU-only `mv -T`。危险原语：仅限控制面已显式校验 src/dst 的调用
   * （工程目录迁移）；不自动创建 dst 父目录，调用方先 mkdirp。
   */
  movePath(src: string, dst: string): Promise<void>;

  // ---- git（issue 分支流：checkout -b / diff / merge，确定性操作不交给 LLM）----

  /** 在 cwd 下执行 git 子命令，返回退出码与输出（不抛错，交调用方判断 code）。 */
  git(cwd: string, args: string[]): Promise<GitResult>;

  /**
   * 读取某个 revision 下的仓库文件原始字节。调用方须先用 `git cat-file -s`
   * 校验存在性与大小，避免无界缓冲；实现不得把 stdout 经 UTF-8 字符串转换。
   */
  readGitBlob(cwd: string, rev: string, path: string): Promise<GitBlobResult>;

  // ---- 终端流 ----

  /** 打开一个 PTY 跑 cmd（典型：`tmux attach -t xxx`），代理到网页 xterm。 */
  openPty(cmd: string, cols: number, rows: number): Promise<PtyChannel>;
}

// ---------- 共享常量/纯函数（Local/Ssh 两实现共用，v1 injector 规则平移点）----------

/**
 * sendKey 白名单——**单一来源**（I6 收敛）：v1 injector.ts 21 键（评审裁定「别删减」，
 * 含 C-z/C-a/C-e/C-r）∪ 骨架新增 BTab，共 22 键。ssh.ts 的 SSH_ALLOWED_KEYS 是本集合
 * 的 re-export 别名，Local/Ssh 两实现行为必然一致。
 */
export const KEY_WHITELIST: ReadonlySet<string> = new Set([
  'Enter', 'Escape', 'Tab', 'BTab', 'Space', 'BSpace',
  'Up', 'Down', 'Left', 'Right',
  'PageUp', 'PageDown', 'Home', 'End',
  'C-c', 'C-d', 'C-u', 'C-l', 'C-z', 'C-a', 'C-e', 'C-r',
]);

/**
 * 执行机命令默认超时（I5）：任何一条卡死的远端/子进程调用都会冻结引擎 tick
 * （watcher 串行遍历 issue），因此实现层必须有限时。tmux/capture 类是亚秒级短命令，
 * 10s 已极宽裕；git 类（diff/merge 大仓库）放宽到 60s。两档均可经 Driver 构造参数覆盖。
 */
export const DEFAULT_TMUX_TIMEOUT_MS = 10_000;
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/** 会话窗口的标称尺寸（I6）：够 CC 把长菜单整块画在一屏里 */
export const TMUX_WIN_COLS = 220;
export const TMUX_WIN_ROWS = 50;

/** 单个终端滚动控制帧允许推进的最大行数。 */
export const MAX_TMUX_SCROLL_LINES = 100;

/**
 * 建 detached 会话的统一 tmux 参数（I6）：显式 -x 220 -y 50 + 锁成 manual。
 * v1 [M5] 地雷：默认 80×24 会把 CC 长选项换行腰斩、打断菜单检测——两实现共用本函数，
 * 防止某一侧（生产正在用的 LocalDriver）再次悄悄回归。
 *
 * issue #95 实测：光给 -x/-y **不够**。tmux 默认 `window-size latest`＝窗口尺寸跟着
 * 「服务器上最近使用的那个客户端」走，而且跨会话生效——只要有人开着终端页（`tmux attach`
 * 的 PTY 就是个客户端），新建的会话就直接生在手机尺寸上（实测给了 -x 220 -y 50 仍生成
 * 114×26），detach 后也**不会**回到 220×50。窗口一矮，CC 会把菜单顶部连同 `❯` 光标行
 * 顶出可视区，capturePane 抓不到锚点 → detectSelection 返回 null → 网页/审批侧
 * 「整个菜单都看不见」（52×18 实测复现）。
 * 故建会话时把 window-size 锁成 manual 并显式 resize 一次；终端页开/关时再临时交还、
 * 收回（见 ExecutorDriver.resizeWindow 与 web/ws/term）。
 */
export function tmuxNewSessionArgs(name: string, cwd: string): string[] {
  return [
    'new-session', '-d', '-s', name, '-c', cwd, '-x', String(TMUX_WIN_COLS), '-y', String(TMUX_WIN_ROWS),
    ';', 'set-window-option', '-t', name, 'window-size', 'manual',
    ';', 'resize-window', '-t', name, '-x', String(TMUX_WIN_COLS), '-y', String(TMUX_WIN_ROWS),
  ];
}

/**
 * 调整（或交还）tmux 窗口尺寸的统一参数：
 * - size 给定 → `resize-window -x/-y`（tmux 会顺带把 window-size 置为 manual，detach 也不缩）；
 * - size=null → `set-window-option window-size latest`，把定尺权交还给附着的客户端
 *   （终端页 attach 期间要跟随浏览器尺寸，否则手机上只能看见窗口左上角一小块）。
 */
export function tmuxResizeWindowArgs(session: string, size: { cols: number; rows: number } | null): string[] {
  return size
    ? ['resize-window', '-t', session, '-x', String(size.cols), '-y', String(size.rows)]
    : ['set-window-option', '-t', session, 'window-size', 'latest'];
}

/**
 * 一次原子 tmux 历史滚动。if-shell 会把目标上下文传给分支命令，因此命令串内
 * 无需再次拼接 session；上滚进入 `copy-mode -e`，下滚在未进 mode 时为 no-op。
 */
export function tmuxScrollPaneArgs(
  session: string,
  direction: TmuxScrollDirection,
  lines: number,
): string[] {
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > MAX_TMUX_SCROLL_LINES) {
    throw new Error(`invalid tmux scroll lines: ${lines}`);
  }
  const action = `send-keys -X -N ${lines} scroll-${direction}`;
  return [
    'if-shell', '-t', session, '-F', '#{pane_in_mode}',
    action,
    direction === 'up' ? `copy-mode -e; ${action}` : '',
  ];
}

/** 单次注入最大字符数（v1 injector.ts:27 的 slice(0, 2000)，超出直接截断） */
export const MAX_INJECT_CHARS = 2000;

/**
 * removeTree 的实现层兜底（Local/Ssh 共用）：必须是绝对路径且深度 ≥ 3 段
 * （如 /home/u/.claude/skills/x 有 5 段）——即使上层校验失手，也删不到
 * /、/root、/home/u 这类浅路径。返回归一化后的路径。
 */
export function assertRemovablePath(path: string): string {
  const p = path.replace(/\/+$/, '');
  if (!p.startsWith('/')) throw new Error(`removeTree 需要绝对路径: ${path}`);
  if (p.includes('/../') || p.endsWith('/..')) throw new Error(`removeTree 拒绝相对段: ${path}`);
  const segs = p.split('/').filter((s) => s.length > 0);
  if (segs.length < 3) throw new Error(`removeTree 拒绝浅路径(<3段): ${path}`);
  return p;
}

/**
 * 注入文本与回车之间的间隔毫秒。codex TUI（0.144 实测）有 paste-burst 检测：
 * 紧跟大段注入的 Enter 被并入粘贴当作换行，消息滞留输入框永不提交。停一拍让
 * 突发窗口关闭后再回车；CC 无此问题但延迟无害，两 Driver 统一行为。
 */
export const INJECT_ENTER_DELAY_MS = 300;

/**
 * 注入净化 = v1 injector.ts:27 逐字语义：`/[\x00-\x1f\x7f]/g → " "` 后截断 2000。
 * 换行→空格（而非保留）是承重设计：tmux 里 \n 等于回车，保留会把多行文本逐行提前提交；
 * core/uploads.ts imageReadHint 的多行提示已依赖此语义。
 * LocalDriver 与 SshDriver（ssh.ts sanitizeSendText 为本函数别名）行为一致（集成收敛）。
 */
export function sanitizeInjectText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, MAX_INJECT_CHARS);
}
