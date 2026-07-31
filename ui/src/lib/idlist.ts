/**
 * ui/lib/idlist —— 存在 localStorage 的「响应式数字 id 列表」底座。
 * 同页多组件（侧栏 + 首页）共享同一份数据：任一处写入即广播，订阅的组件全部重渲染；
 * 同时监听 storage 事件做跨标签页同步。收藏 / 最近访问都建在它之上（见 favorites.ts / recent.ts）。
 */
import { useEffect, useState } from 'preact/hooks';

export interface IdListStore {
  /** 读当前列表（顺序即存储顺序） */
  read(): number[];
  /** 覆盖写入并广播（含跨标签页） */
  write(ids: number[]): void;
  /** Preact hook：订阅列表，写入后自动重渲染 */
  useList(): number[];
}

/** 建一个绑定到某 localStorage 键的响应式数字 id 列表 store。 */
export function createIdListStore(key: string): IdListStore {
  const listeners = new Set<() => void>();

  const read = (): number[] => {
    try {
      const v = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && x > 0) : [];
    } catch {
      return [];
    }
  };

  const write = (ids: number[]): void => {
    try {
      localStorage.setItem(key, JSON.stringify(ids));
    } catch {
      /* 隐私模式 / 配额满：静默降级，不挡主流程 */
    }
    listeners.forEach((l) => l());
  };

  const useList = (): number[] => {
    const [ids, setIds] = useState<number[]>(read);
    useEffect(() => {
      const l = (): void => setIds(read());
      listeners.add(l);
      const onStorage = (e: StorageEvent): void => {
        if (e.key === key) setIds(read());
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(l);
        window.removeEventListener('storage', onStorage);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return ids;
  };

  return { read, write, useList };
}
