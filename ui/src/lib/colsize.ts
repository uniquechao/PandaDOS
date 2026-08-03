/**
 * ui/lib/colsize —— Git 页宽屏三栏（提交记录 | 文件 | Diff）列宽状态 + 本地持久化。
 *
 * 宽度用「占容器百分比」三元组表示，恒和为 100；两条分隔线（boundary 0/1）可拖拽：
 *   boundary 0 在 提交/文件 之间、boundary 1 在 文件/Diff 之间。
 * 拖拽给分隔线一个「到容器左沿的累计百分比」，applyBoundary 夹取（每栏 ≥ COL_MIN、
 * 邻栏不被挤没）后重算三元组。改动即写 localStorage（按设备），同页多处 useColSizes 广播同步、
 * 跨标签页监听 storage —— 套路同 idlist/favorites。
 *
 * 纯逻辑（normalizeCols/applyBoundary/boundaries）与存储层（readColSizes/writeColSizes）
 * 均可脱离 DOM 单测；useColSizes 是它们之上的 Preact hook。
 */
import { useEffect, useState } from 'preact/hooks';

/** localStorage 键（按设备存，一个用户多设备各自记） */
export const COLSIZE_KEY = 'panda.gitCols';

/** 默认三栏比例：提交记录 32% / 文件 22% / Diff 46% */
export const COL_DEFAULTS: readonly [number, number, number] = [32, 22, 46];

/** 每栏最小百分比（防某栏被拖没；三栏 min 合计 36%，宽屏 ≥960px 有余量） */
export const COL_MIN = 12;

export type Cols = [number, number, number];

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * 归一化任意来源（localStorage 反序列化值）→ 合法三元组：
 * 非「3 个有限正数」的输入退回默认；否则按比例缩放到恒和 100（吸收存储时的舍入漂移）。
 */
export function normalizeCols(v: unknown): Cols {
  if (!Array.isArray(v) || v.length !== 3) return [...COL_DEFAULTS];
  const nums = v.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return [...COL_DEFAULTS];
  const sum = nums[0]! + nums[1]! + nums[2]!;
  if (!(sum > 0)) return [...COL_DEFAULTS];
  return [(nums[0]! / sum) * 100, (nums[1]! / sum) * 100, (nums[2]! / sum) * 100];
}

/** 两条分隔线到容器左沿的累计百分比：[w0, w0+w1]（供 Splitter 定位/拖拽计算） */
export function boundaries(widths: Cols): [number, number] {
  return [widths[0], widths[0] + widths[1]];
}

/**
 * 拖动第 boundary 条分隔线到 targetPct%（到容器左沿的累计百分比），夹取后返回新三元组。
 * - boundary 0：改 提交/文件，Diff 不动；t 夹到 [COL_MIN, w0+w1-COL_MIN]。
 * - boundary 1：改 文件/Diff，提交 不动；t 夹到 [w0+COL_MIN, 100-COL_MIN]。
 */
export function applyBoundary(widths: Cols, boundary: 0 | 1, targetPct: number): Cols {
  const [w0, w1, w2] = widths;
  if (boundary === 0) {
    const t = clamp(targetPct, COL_MIN, w0 + w1 - COL_MIN);
    return [t, w0 + w1 - t, w2];
  }
  const t = clamp(targetPct, w0 + COL_MIN, 100 - COL_MIN);
  return [w0, t - w0, 100 - t];
}

// ---------- 存储层（localStorage + 同页广播） ----------

const listeners = new Set<() => void>();

/** 读列宽（无/损坏 → 默认；localStorage 不可用时静默退回默认） */
export function readColSizes(): Cols {
  try {
    const raw = localStorage.getItem(COLSIZE_KEY);
    return raw ? normalizeCols(JSON.parse(raw)) : [...COL_DEFAULTS];
  } catch {
    return [...COL_DEFAULTS];
  }
}

/** 写列宽并广播（含跨标签页）；隐私模式/配额满静默降级 */
export function writeColSizes(cols: Cols): void {
  try {
    localStorage.setItem(COLSIZE_KEY, JSON.stringify(cols));
  } catch {
    /* 隐私模式 / 配额满：静默降级，不挡主流程 */
  }
  listeners.forEach((l) => l());
}

// ---------- Preact hook ----------

export interface ColSizes {
  /** 当前三栏百分比（恒和 100） */
  widths: Cols;
  /** 分隔线到容器左沿的累计百分比 [w0, w0+w1] */
  bounds: [number, number];
  /** 拖动第 boundary 条分隔线到 targetPct%（累计），夹取后落库 */
  setBoundary(boundary: 0 | 1, targetPct: number): void;
  /** 复位默认（双击分隔条） */
  reset(): void;
}

export function useColSizes(): ColSizes {
  const [widths, setWidths] = useState<Cols>(readColSizes);
  useEffect(() => {
    const l = (): void => setWidths(readColSizes());
    listeners.add(l);
    const onStorage = (e: StorageEvent): void => {
      if (e.key === COLSIZE_KEY) setWidths(readColSizes());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(l);
      window.removeEventListener('storage', onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setBoundary = (boundary: 0 | 1, targetPct: number): void => {
    const next = applyBoundary(widths, boundary, targetPct);
    setWidths(next);
    writeColSizes(next); // 广播给同页其它订阅者
  };
  const reset = (): void => {
    setWidths([...COL_DEFAULTS]);
    writeColSizes([...COL_DEFAULTS]);
  };

  return { widths, bounds: boundaries(widths), setBoundary, reset };
}
