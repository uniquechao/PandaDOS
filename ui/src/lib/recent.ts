/**
 * ui/lib/recent —— 项目「最近访问」（存浏览器本地，按设备）。
 * 进入某项目路由时记一次（见 router.useRoute → pushRecent）；最新在前、去重、截断到 CAP。
 * 侧栏 / 首页据此展示「最近访问」分组。
 */
import { createIdListStore } from './idlist';

const CAP = 8;
const store = createIdListStore('mando.recentProjects');

export function getRecent(): number[] {
  return store.read();
}

/** 记录一次访问：移到最前、去重、截断。已在最前则免写（避免项目内切 tab 反复写盘/重渲染）。 */
export function pushRecent(id: number): void {
  if (!Number.isInteger(id) || id <= 0) return;
  const cur = store.read();
  if (cur[0] === id) return;
  store.write([id, ...cur.filter((x) => x !== id)].slice(0, CAP));
}

/** 从最近访问移除（项目归档/删除后清理，可选） */
export function removeRecent(id: number): void {
  const cur = store.read();
  if (cur.includes(id)) store.write(cur.filter((x) => x !== id));
}

/** Preact hook：响应式最近访问列表（最新在前）。 */
export function useRecent(): number[] {
  return store.useList();
}
