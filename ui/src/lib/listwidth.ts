/**
 * ui/lib/listwidth —— 工作台宽屏左栏（issue 列表 / 对话列表）宽度状态 + 本地持久化。
 *
 * 单边界（列表栏与右侧工作台之间那条），用「像素宽」表示，夹取到 [LISTW_MIN, LISTW_MAX]。
 * 「最大保持现在的宽度」：MAX = 现有 CSS max-width（400px），只能往窄拖、不超过现宽。
 * 未拖过（无存储）→ width=null，Board 不落 inline 宽，沿用现有响应式 CSS（30% / max 400）。
 * 改动即写 localStorage（按设备）；同页多处 useListWidth 广播同步、跨标签页监听 storage
 * —— 套路同 lib/colsize（那是 Git 页三栏百分比制，这里是工作台两栏像素制）。
 *
 * 纯逻辑（clampListWidth/normalizeListWidth）与存储层（readListWidth/writeListWidth/
 * clearListWidth）均可脱离 DOM 单测；useListWidth 是其上的 Preact hook。
 */
import { useEffect, useState } from 'preact/hooks';

/** localStorage 键（按设备存，一个用户多设备各自记） */
export const LISTWIDTH_KEY = 'mando.wbListW';

/** 左栏最小像素宽（沿用现有 .wb-list-col min-width，防拖没） */
export const LISTW_MIN = 260;
/** 左栏最大像素宽（沿用现有 .wb-list-col max-width，即「现在的宽度」上限） */
export const LISTW_MAX = 400;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** 夹取像素宽到 [LISTW_MIN, LISTW_MAX] */
export function clampListWidth(px: number): number {
  return clamp(px, LISTW_MIN, LISTW_MAX);
}

/**
 * 归一化任意来源（localStorage 反序列化值）→ 合法像素宽或 null：
 * 有限正数 → 夹取后返回；否则（非数值 / 非有限 / ≤0）→ null（回落默认响应式宽度）。
 */
export function normalizeListWidth(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? clampListWidth(n) : null;
}

// ---------- 存储层（localStorage + 同页广播） ----------

const listeners = new Set<() => void>();

/** 读左栏宽（无/损坏/越界非法 → null，交由调用方回落默认；localStorage 不可用时静默 null） */
export function readListWidth(): number | null {
  try {
    const raw = localStorage.getItem(LISTWIDTH_KEY);
    return raw ? normalizeListWidth(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** 写左栏宽（夹取后落库）并广播（含跨标签页）；隐私模式/配额满静默降级 */
export function writeListWidth(px: number): void {
  const w = clampListWidth(px);
  try {
    localStorage.setItem(LISTWIDTH_KEY, JSON.stringify(w));
  } catch {
    /* 隐私模式 / 配额满：静默降级，不挡主流程 */
  }
  listeners.forEach((l) => l());
}

/** 清除（双击复位）→ 回落默认响应式宽度，并广播 */
export function clearListWidth(): void {
  try {
    localStorage.removeItem(LISTWIDTH_KEY);
  } catch {
    /* 静默降级 */
  }
  listeners.forEach((l) => l());
}

// ---------- Preact hook ----------

export interface ListWidth {
  /** 当前左栏像素宽；null = 未设，沿用默认响应式 CSS 宽度 */
  width: number | null;
  /** 拖动：给一个目标像素宽，夹取后落库（同页广播） */
  setWidth(px: number): void;
  /** 复位默认（双击分隔条）→ width 回 null */
  reset(): void;
}

export function useListWidth(): ListWidth {
  const [width, setWidthState] = useState<number | null>(readListWidth);
  useEffect(() => {
    const l = (): void => setWidthState(readListWidth());
    listeners.add(l);
    const onStorage = (e: StorageEvent): void => {
      if (e.key === LISTWIDTH_KEY) setWidthState(readListWidth());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(l);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setWidth = (px: number): void => {
    const next = clampListWidth(px);
    setWidthState(next);
    writeListWidth(next); // 广播给同页其它订阅者
  };
  const reset = (): void => {
    setWidthState(null);
    clearListWidth();
  };

  return { width, setWidth, reset };
}
