/**
 * 宽屏检测 hook：跟随窗口变化（旋转/拖拽分屏）。
 * 默认断点 ≥960px —— issue 详情并排控制台与 git 左右分栏共用
 * （再窄右栏没法用，H5 窄屏回落单栏/抽屉、重组件不挂载）。
 */
import { useEffect, useState } from 'preact/hooks';

export const WIDE_MQ = '(min-width: 960px)';

export function useWide(query: string = WIDE_MQ): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (e: MediaQueryListEvent): void => setWide(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return wide;
}
