/**
 * ui/lib/docTitle —— 浏览器标签页标题。
 * 进到某个项目（任意项目页：看板/issue/对话/终端/文件/git/技能/项目配置…）时，
 * 标题变成「项目名-PandaDOS」；回到项目列表 / 我的设定 / admin / 未登录则回落成 PandaDOS
 * （与 index.html 里静态写死的 <title>PandaDOS</title> 一致；标题不走 i18n 词条，品牌后缀固定）。
 */
import { useEffect } from 'preact/hooks';
import { api } from './api';
import type { Project } from './types';

export const BRAND_TITLE = 'PandaDOS';

/** 纯函数：拼标题。名称为空/全空白 → 只留品牌名。 */
export function docTitle(projectName?: string | null): string {
  const name = (projectName ?? '').trim();
  return name ? `${name}-${BRAND_TITLE}` : BRAND_TITLE;
}

/**
 * 按当前项目 id 维护 document.title。
 * - pid=null 立即置回品牌名；
 * - 否则拉 /api/projects/:pid 取 name 再写（失败不覆盖，保留当前标题）；
 * - 切 pid / 卸载时用 alive 标志丢弃过期响应，避免旧项目名盖住新项目。
 */
export function useDocumentTitle(pid: number | null): void {
  useEffect(() => {
    if (pid === null) {
      document.title = docTitle(null);
      return;
    }
    let alive = true;
    api<Project>(`/api/projects/${pid}`)
      .then((p) => {
        if (alive) document.title = docTitle(p.name);
      })
      .catch(() => {});
    return () => {
      alive = false;
      document.title = docTitle(null);
    };
  }, [pid]);
}
