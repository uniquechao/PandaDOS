/**
 * ui/lib/favorites —— 项目「收藏」（存浏览器本地，按设备）。
 * 收藏项在侧栏 / 首页置顶展示；toggle 在任意一处生效，另一处即时同步（见 idlist）。
 * 顺序：最新收藏在前。
 */
import { createIdListStore } from './idlist';

const store = createIdListStore('mando.favProjects');

export function getFavorites(): number[] {
  return store.read();
}

export function isFavorite(id: number): boolean {
  return store.read().includes(id);
}

/** 切换收藏，返回切换后的状态（true = 已收藏） */
export function toggleFavorite(id: number): boolean {
  const cur = store.read();
  const on = !cur.includes(id);
  store.write(on ? [id, ...cur.filter((x) => x !== id)] : cur.filter((x) => x !== id));
  return on;
}

/** 移除收藏（项目归档/删除后清理，可选） */
export function removeFavorite(id: number): void {
  const cur = store.read();
  if (cur.includes(id)) store.write(cur.filter((x) => x !== id));
}

export interface FavoritesApi {
  favs: Set<number>;
  isFav: (id: number) => boolean;
  toggle: (id: number) => boolean;
}

/** Preact hook：拿到响应式收藏集 + 操作。 */
export function useFavorites(): FavoritesApi {
  const ids = store.useList();
  const favs = new Set(ids);
  return { favs, isFav: (id: number) => favs.has(id), toggle: toggleFavorite };
}
