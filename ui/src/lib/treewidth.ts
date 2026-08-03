/**
 * ui/lib/treewidth —— 文件页宽屏左侧「文件树」栏宽度状态 + 本地持久化。
 *
 * 单边界（文件树栏与右侧编辑/预览之间那条），用「像素宽」表示，夹取到 [TREEW_MIN, TREEW_MAX]。
 * 「不能太宽、和 issuelist 宽度一样就行」：MAX 沿用 issuelist 上限（400px），只能往窄拖、不超过它。
 * 未拖过（无存储）→ width=null，Files 页不落 inline 宽，沿用默认响应式 CSS 宽度。
 * 改动即写 localStorage（按设备）；同页多处 useTreeWidth 广播同步、跨标签页监听 storage。
 *
 * 与 lib/listwidth 同一套路（那是工作台/对话列表栏，共用 panda.wbListW），但**独立 key**，
 * 拖文件树不牵动任务列表宽度；纯逻辑（clampTreeWidth/normalizeTreeWidth）与存储层
 * （readTreeWidth/writeTreeWidth/clearTreeWidth）均可脱离 DOM 单测，useTreeWidth 是其上的 Preact hook。
 */
import { useEffect, useState } from 'preact/hooks';

/** localStorage 键（按设备存，一个用户多设备各自记；与 issuelist 的 panda.wbListW 分开） */
export const TREEWIDTH_KEY = 'panda.filesTreeW';

/** 文件树栏最小像素宽（同 issuelist 下限，防拖没） */
export const TREEW_MIN = 260;
/** 文件树栏最大像素宽（同 issuelist 上限，「不超过 issuelist 宽度」） */
export const TREEW_MAX = 400;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** 夹取像素宽到 [TREEW_MIN, TREEW_MAX] */
export function clampTreeWidth(px: number): number {
  return clamp(px, TREEW_MIN, TREEW_MAX);
}

/**
 * 归一化任意来源（localStorage 反序列化值）→ 合法像素宽或 null：
 * 有限正数 → 夹取后返回；否则（非数值 / 非有限 / ≤0）→ null（回落默认响应式宽度）。
 */
export function normalizeTreeWidth(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? clampTreeWidth(n) : null;
}

// ---------- 存储层（localStorage + 同页广播） ----------

const listeners = new Set<() => void>();

/** 读文件树栏宽（无/损坏/越界非法 → null，交由调用方回落默认；localStorage 不可用时静默 null） */
export function readTreeWidth(): number | null {
  try {
    const raw = localStorage.getItem(TREEWIDTH_KEY);
    return raw ? normalizeTreeWidth(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** 写文件树栏宽（夹取后落库）并广播（含跨标签页）；隐私模式/配额满静默降级 */
export function writeTreeWidth(px: number): void {
  const w = clampTreeWidth(px);
  try {
    localStorage.setItem(TREEWIDTH_KEY, JSON.stringify(w));
  } catch {
    /* 隐私模式 / 配额满：静默降级，不挡主流程 */
  }
  listeners.forEach((l) => l());
}

/** 清除（双击复位）→ 回落默认响应式宽度，并广播 */
export function clearTreeWidth(): void {
  try {
    localStorage.removeItem(TREEWIDTH_KEY);
  } catch {
    /* 静默降级 */
  }
  listeners.forEach((l) => l());
}

// ---------- Preact hook ----------

export interface TreeWidth {
  /** 当前文件树栏像素宽；null = 未设，沿用默认响应式 CSS 宽度 */
  width: number | null;
  /** 拖动：给一个目标像素宽，夹取后落库（同页广播） */
  setWidth(px: number): void;
  /** 复位默认（双击分隔条）→ width 回 null */
  reset(): void;
}

export function useTreeWidth(): TreeWidth {
  const [width, setWidthState] = useState<number | null>(readTreeWidth);
  useEffect(() => {
    const l = (): void => setWidthState(readTreeWidth());
    listeners.add(l);
    const onStorage = (e: StorageEvent): void => {
      if (e.key === TREEWIDTH_KEY) setWidthState(readTreeWidth());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(l);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setWidth = (px: number): void => {
    const next = clampTreeWidth(px);
    setWidthState(next);
    writeTreeWidth(next); // 广播给同页其它订阅者
  };
  const reset = (): void => {
    setWidthState(null);
    clearTreeWidth();
  };

  return { width, setWidth, reset };
}
