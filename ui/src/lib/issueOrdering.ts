import { BUSY_STATES, orderPending } from '../../../src/issues/queue';
import type { Issue } from './types';

export type BoardGroupKey = 'review' | 'doing' | 'todo' | 'blocked' | 'finished' | 'cancelled';

function byCreatedAsc(a: Issue, b: Issue): number {
  return a.createdTs - b.createdTs || a.id - b.id;
}

function byFinishedDesc(a: Issue, b: Issue): number {
  const ad = a.doneTs;
  const bd = b.doneTs;
  if (ad !== null && bd === null) return -1;
  if (ad === null && bd !== null) return 1;
  if (ad !== null && bd !== null) return bd - ad || b.id - a.id;
  return b.createdTs - a.createdTs || b.id - a.id;
}

export function sortBoardGroup(
  key: BoardGroupKey,
  items: readonly Issue[],
  allIssues: readonly Issue[],
): Issue[] {
  if (key === 'todo') {
    const activeModule = allIssues.find((i) => BUSY_STATES.includes(i.status))?.module;
    return orderPending(items, activeModule);
  }
  // 收尾三组（完成/受阻/已取消）同一套倒序：最近结束/创建的在前（#105 拆组后沿用）
  if (key === 'finished' || key === 'blocked' || key === 'cancelled') return [...items].sort(byFinishedDesc);
  return [...items].sort(byCreatedAsc);
}

/** 收尾组每页条数（#105：完成/受阻/已取消都分页，>1 页才出分页脚） */
export const CLOSED_PAGE_SIZE = 50;

/** 搜索过滤（完成组）：标题/模块不分大小写包含匹配，#编号可带可不带 #；空查询原样返回 */
export function filterIssueList(items: readonly Issue[], q: string): Issue[] {
  const s = q.trim().toLowerCase();
  if (!s) return [...items];
  const idQ = s.startsWith('#') ? s.slice(1) : s;
  return items.filter(
    (i) =>
      i.title.toLowerCase().includes(s) ||
      i.module.toLowerCase().includes(s) ||
      (idQ !== '' && String(i.id).includes(idQ)),
  );
}

/** 页码夹取 + 切片：page 越界（搜索后变少/数据删了）自动回到最后一页 */
export function pageSlice<T>(
  items: readonly T[],
  page: number,
  per = CLOSED_PAGE_SIZE,
): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / per));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { rows: items.slice(p * per, p * per + per), page: p, pages };
}
